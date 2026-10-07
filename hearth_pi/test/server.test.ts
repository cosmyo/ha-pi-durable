import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Config } from "../src/config.js";
import { Boundary } from "../src/auth.js";
import { Runtime } from "../src/runtime.js";
import { HAClient, Actions, haExtension } from "../src/ha.js";
import { HomeCanvas } from "../src/canvas.js";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { appServer } from "../src/server.js";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { offline } from "./fixtures.js";

test("authenticated Home input builds the real durable canvas; snapshots and document-only SSE hydrate it without implicit HA polling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-canvas-http-"));
  const { faux, models, model } = offline();
  const cfg = {
    ...config,
    dataDir: dir,
    policy: { enabled: false, services: [], entities: ["light.example"] },
  };
  let reads = 0;
  const ha = new HAClient(cfg.haToken, cfg.policy, (async (_url, init) => {
    assert.equal(init?.method, "GET");
    reads++;
    return Response.json({
      entity_id: "light.example",
      state: "off",
      attributes: { friendly_name: "Synthetic lamp" },
    });
  }) as typeof fetch);
  const runtime = await Runtime.open(dir, models, model, [haExtension(ha)]);
  const app = appServer(cfg, runtime, new Actions(runtime, ha));
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  cfg.origin = base;
  const authorization = `Basic ${Buffer.from(`hearth:${cfg.password}`).toString("base64")}`;
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { authorization } });
  const streamAbort = new AbortController();
  try {
    const boot = await get("/api/bootstrap"),
      csrf = (await boot.json()).csrf;
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const post = (path: string, value: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          authorization,
          cookie,
          origin: base,
          "x-hearth-csrf": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(value),
      });
    const creation = await post("/api/sessions", {
      title: "Home canvas",
      requestId: "canvas-http-create",
    });
    assert.equal(creation.status, 201);
    const id = (await creation.json()).id;
    const events = await fetch(`${base}/api/sessions/${id}/events`, {
      signal: streamAbort.signal,
      headers: { authorization },
    });
    const reader = events.body!.getReader();
    assert.match(
      Buffer.from((await reader.read()).value!).toString(),
      /"homeCanvas":null/,
    );
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("ha_build_view", {
          title: "Observed home",
          sections: [{ title: "Example", entities: ["light.example"] }],
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        "This is a saved observation, not continuous telemetry.",
      ),
    ]);
    assert.equal(
      (
        await post(`/api/sessions/${id}/inputs`, {
          requestId: "canvas-http-input",
          content: "Build my view",
        })
      ).status,
      202,
    );
    await runtime.harness.waitForIdle(ctx);
    const snapshot = await (await get(`/api/sessions/${id}/snapshot`)).json();
    assert.equal(snapshot.homeCanvas.title, "Observed home");
    assert.equal(snapshot.homeCanvas.sections[0].readings[0].state, "off");
    assert.equal(reads, 1);
    // Drain streamed snapshots until the built canvas; no reliance on chunk boundaries.
    let streamed = "";
    const timeout = setTimeout(() => streamAbort.abort(), 4000);
    try {
      while (!streamed.includes('"title":"Observed home"'))
        streamed += Buffer.from((await reader.read()).value!).toString();
      // A plain document edit, no generation/model/message change: watchDoc must publish it.
      const saved = await runtime.harness.snapshot(HomeCanvas, id, ctx);
      assert(saved?.current);
      await runtime.harness.commit(async (tx) => {
        (await tx.doc(HomeCanvas, id)).current!.title = "Document-only update";
      }, ctx);
      while (!streamed.includes('"title":"Document-only update"'))
        streamed += Buffer.from((await reader.read()).value!).toString();
    } finally {
      clearTimeout(timeout);
      streamAbort.abort();
      await reader.cancel().catch(() => {});
    }
    assert.equal(reads, 1);
    assert.equal(
      (await (await get(`/api/sessions/${id}/snapshot`)).json()).homeCanvas
        .title,
      "Document-only update",
    );
    cfg.policy.entities = [];
    assert.equal(
      (await (await get(`/api/sessions/${id}/snapshot`)).json()).homeCanvas,
      null,
    );
    const other = await runtime.create(
      "other-owner",
      "Private canvas",
      "canvas-http-other",
    );
    assert.equal((await get(`/api/sessions/${other}/snapshot`)).status, 404);
    assert.equal(
      (await fetch(`${base}/api/sessions/${id}/snapshot`)).status,
      401,
    );
    assert.match(
      await (await get("/")).text(),
      /Saved Home canvas|home-canvas/,
    );
    assert.match(await (await get("/render.js")).text(), /renderCanvas/);
  } finally {
    streamAbort.abort();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const config: Config = {
  mode: "local",
  host: "127.0.0.1",
  port: 8099,
  origin: "http://127.0.0.1:8099",
  password: "synthetic-local-password-0001",
  authorizedUsers: ["synthetic-admin"],
  dataDir: "",
  provider: "offline",
  model: "test",
  policy: { enabled: false, entities: [], services: [] },
  haToken: "synthetic-supervisor-token",
  apiKey: "synthetic-provider-key",
};
function request(
  peer: string,
  headers: Record<string, string>,
  raw?: string[],
): IncomingMessage {
  return {
    socket: { remoteAddress: peer },
    headers,
    rawHeaders: raw ?? Object.entries(headers).flat(),
  } as unknown as IncomingMessage;
}
test("Ingress boundary rejects forged, forwarded, missing, duplicate and unauthorized identity", () => {
  const boundary = new Boundary({ ...config, mode: "ingress" });
  assert.equal(
    boundary.principal(
      request("::ffff:172.30.32.2", { "x-remote-user-id": "synthetic-admin" }),
    ),
    "synthetic-admin",
  );
  for (const req of [
    request("127.0.0.1", {
      "x-remote-user-id": "synthetic-admin",
      "x-forwarded-for": "172.30.32.2",
    }),
    request("172.30.32.2", {}),
    request("172.30.32.2", { "x-remote-user-id": "other" }),
    request("172.30.32.2", { "x-remote-user-id": "synthetic-admin" }, [
      "X-Remote-User-Id",
      "synthetic-admin",
      "x-remote-user-id",
      "synthetic-admin",
    ]),
  ])
    assert.throws(() => boundary.principal(req));
  const local = new Boundary(config);
  assert.throws(
    () =>
      local.principal(
        request("127.0.0.1", { "x-remote-user-id": "synthetic-admin" }),
      ),
    /authentication_required/,
  );
  assert.throws(
    () =>
      new Boundary({ ...config, password: "" }).principal(
        request("127.0.0.1", { authorization: "Basic aGVhcnRoOg==" }),
      ),
    /authentication_required/,
  );
});
test("HTTP API: Basic auth, browser-bound CSRF/Origin, strict validation, protected SSE hydration and redaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-http-"));
  const { faux, models, model } = offline();
  const runtime = await Runtime.open(dir, models, model);
  const cfg = {
    ...config,
    dataDir: dir,
    policy: {
      ...config.policy,
      entities: ["sensor.private_id_canary", "light.private_id_canary"],
    },
  };
  const app = appServer(
    cfg,
    runtime,
    new Actions(runtime, new HAClient(cfg.haToken, cfg.policy)),
  );
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  cfg.origin = base;
  const authorization = `Basic ${Buffer.from(`hearth:${cfg.password}`).toString("base64")}`;
  const fetchAPI = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization, ...init.headers },
    });
  try {
    assert.equal(
      (
        await fetch(`${base}/api/sessions`, {
          headers: { "x-remote-user-id": "synthetic-admin" },
        })
      ).status,
      401,
    );
    assert.equal((await fetch(`${base}/api/sessions/3/events`)).status, 401);
    const boot = await fetchAPI("/api/bootstrap");
    const bootstrap = await boot.json();
    assert.equal(bootstrap.entityScopeCount, 2);
    assert.doesNotMatch(JSON.stringify(bootstrap), /private_id_canary/);
    const csrf = bootstrap.csrf;
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    assert.match(cookie, /^hearth_browser=/);
    assert.match(boot.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
    const headers = {
      authorization,
      cookie,
      origin: base,
      "x-hearth-csrf": csrf,
      "content-type": "application/json",
    };
    const createBody = JSON.stringify({
      title: "<script>synthetic-provider-key</script>",
      requestId: "create-http-1",
    });
    const post = (
      path: string,
      payload: string,
      extra: Record<string, string> = {},
    ) =>
      fetchAPI(path, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: payload,
      });
    assert.equal(
      (await post("/api/sessions", createBody, { "x-hearth-csrf": "" })).status,
      403,
    );
    assert.equal(
      (
        await post("/api/sessions", createBody, {
          cookie: "hearth_browser=" + "a".repeat(64),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post("/api/sessions", createBody, {
          origin: "https://attacker.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (await post("/api/sessions", createBody, { origin: "" })).status,
      403,
    );
    assert.equal((await post("/api/sessions", "{bad")).status, 400);
    assert.equal(
      (
        await post(
          "/api/sessions",
          JSON.stringify({
            title: "OK",
            requestId: "create-http-2",
            shell: "forbidden",
          }),
        )
      ).status,
      400,
    );
    assert.equal((await post("/api/sessions", "a".repeat(9000))).status, 413);
    const created = await post("/api/sessions", createBody);
    assert.equal(created.status, 201);
    const id = (await created.json()).id;
    assert.equal(
      (
        await post(
          `/api/sessions/${id}/inputs`,
          JSON.stringify({
            requestId: "request-http-1",
            content: "a".repeat(4001),
          }),
        )
      ).status,
      400,
    );
    faux.setResponses([
      fauxAssistantMessage(
        "<img src=x onerror=alert(1)> synthetic-provider-key",
      ),
    ]);
    assert.equal(
      (
        await post(
          `/api/sessions/${id}/inputs`,
          JSON.stringify({ requestId: "request-http-1", content: "Hello" }),
        )
      ).status,
      202,
    );
    await runtime.harness.waitForIdle({
      abortSignal: undefined,
      value: () => undefined,
      toString: () => "test",
    });
    const snapshot = await (
      await fetchAPI(`/api/sessions/${id}/snapshot`)
    ).text();
    assert.match(snapshot, /REDACTED/);
    assert.doesNotMatch(
      snapshot,
      /synthetic-provider-key|synthetic-supervisor-token|synthetic-local-password/,
    );
    for (let n = 0; n < 2; n++) {
      const abort = new AbortController();
      const response = await fetchAPI(`/api/sessions/${id}/events`, {
        signal: abort.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const frame = await reader.read();
      assert.match(Buffer.from(frame.value!).toString(), /event: snapshot/);
      assert.match(Buffer.from(frame.value!).toString(), /REDACTED/);
      abort.abort();
      await reader.cancel().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await fetchAPI("/api/sessions/999/snapshot")).status, 404);
    assert.equal((await fetchAPI("/.env")).status, 404);
    assert.equal((await fetchAPI("/api/sessions?identity=other")).status, 400);
    assert.equal((await fetchAPI("/")).status, 200);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
