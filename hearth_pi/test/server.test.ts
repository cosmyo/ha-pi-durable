import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Config } from "../src/config.js";
import { Boundary } from "../src/auth.js";
import { Runtime } from "../src/runtime.js";
import { HAClient, Actions } from "../src/ha.js";
import { appServer } from "../src/server.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { offline } from "./fixtures.js";

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
  const cfg = { ...config, dataDir: dir };
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
    const csrf = (await boot.json()).csrf;
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
