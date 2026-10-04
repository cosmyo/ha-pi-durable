import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { HAClient, Actions, haExtension } from "../src/ha.js";
import { Runtime } from "../src/runtime.js";
import { Proposals } from "../src/documents.js";
import { appServer } from "../src/server.js";
import { FULL_ACKNOWLEDGEMENT } from "../src/home-actions.js";
import { offline } from "./fixtures.js";

test("Home permission HTTP endpoints authenticate owners, reject stale/forged/oversized/CSRF/Origin settings, hydrate permission-only SSE and deny manual Read-only writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-permissions-http-"));
  const { models, model, faux } = offline();
  const cfg = {
    mode: "local" as const,
    host: "127.0.0.1",
    port: 8099,
    origin: "http://127.0.0.1:8099",
    password: "synthetic-local-password-0001",
    authorizedUsers: [],
    dataDir: dir,
    provider: "offline" as const,
    model: "test",
    policy: {
      enabled: true,
      services: ["light.turn_on"],
      entities: [
        "light.example",
        ...Array.from(
          { length: 876 },
          (_, i) => `sensor.private_id_canary_${i}`,
        ),
      ],
    },
    haToken: "synthetic-ha-token",
    apiKey: "synthetic-provider-key",
  };
  let posts = 0;
  const ha = new HAClient(cfg.haToken, cfg.policy, (async (url, init) => {
    if (init?.method === "POST") {
      posts++;
      return Response.json([]);
    }
    return String(url).endsWith("services")
      ? Response.json([{ domain: "light", services: { turn_on: {} } }])
      : Response.json({
          entity_id: "light.example",
          state: "off",
          attributes: {},
        });
  }) as typeof fetch);
  ha.actions.authorizeOwners(["local-admin"]);
  const runtime = await Runtime.open(
    dir,
    models,
    model,
    [haExtension(ha)],
    [],
    undefined,
    ha.actions,
  );
  assert(
    !haExtension(ha).tools!.some((t) => /permission|set_mode/.test(t.name)),
  );
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
  const stop = new AbortController();
  try {
    const boot = await get("/api/bootstrap");
    const bootstrap = await boot.json();
    assert.equal(bootstrap.entityScopeCount, 877);
    assert.doesNotMatch(
      JSON.stringify(bootstrap),
      /private_id_canary|synthetic-ha-token|synthetic-provider-key/,
    );
    const csrf = bootstrap.csrf;
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const post = (
      path: string,
      body: unknown,
      extra: Record<string, string> = {},
    ) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          authorization,
          cookie,
          origin: base,
          "x-hearth-csrf": csrf,
          "content-type": "application/json",
          ...extra,
        },
        body: JSON.stringify(body),
      });
    const permissions = await (await get("/api/home-permissions")).json();
    assert.equal(permissions.effectiveMode, "ask");
    const full = {
      mode: "full",
      revision: permissions.revision,
      policy: permissions.policy,
      acknowledgement: FULL_ACKNOWLEDGEMENT,
    };
    assert.equal((await fetch(`${base}/api/home-permissions`)).status, 401);
    assert.equal(
      (await post("/api/home-permissions", full, { authorization: "" })).status,
      401,
    );
    assert.equal(
      (
        await post("/api/home-permissions", full, {
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (await post("/api/home-permissions", full, { "x-hearth-csrf": "forged" }))
        .status,
      403,
    );
    assert.equal(
      (await post("/api/home-permissions", { ...full, owner: "other" })).status,
      400,
    );
    assert.equal(
      (
        await post("/api/home-permissions", {
          ...full,
          acknowledgement: undefined,
        })
      ).status,
      400,
    );
    assert.equal(
      (await post("/api/home-permissions", { ...full, policy: "f".repeat(64) }))
        .status,
      409,
    );
    assert.equal(
      (await post("/api/home-permissions", { ...full, revision: -1 })).status,
      400,
    );
    assert.equal(
      (await post("/api/home-permissions", { ...full, mode: "root" })).status,
      400,
    );
    assert.equal(
      (
        await post("/api/home-permissions", {
          ...full,
          acknowledgement: "x".repeat(9000),
        })
      ).status,
      413,
    );
    const creation = await post("/api/sessions", {
      title: "Home",
      requestId: "create-permissions-http",
    });
    const id = (await creation.json()).id;
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("ha_propose_service", {
          service: "light.turn_on",
          entityId: "light.example",
          data: {},
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Await review"),
    ]);
    assert.equal(
      (
        await post(`/api/sessions/${id}/inputs`, {
          requestId: "input-permissions-http",
          content: "Propose",
        })
      ).status,
      202,
    );
    await runtime.harness.waitForIdle(ctx);
    const proposal = Object.values(
      (await runtime.harness.snapshot(Proposals, id as ConversationId, ctx))!
        .items,
    )[0]!;
    assert.equal(posts, 0);
    const events = await fetch(`${base}/api/sessions/${id}/events`, {
      headers: { authorization },
      signal: stop.signal,
    });
    const reader = events.body!.getReader();
    let streamed = Buffer.from((await reader.read()).value!).toString();
    assert.match(streamed, /"effectiveMode":"ask"/);
    const selected = await post("/api/home-permissions", full);
    assert.equal(selected.status, 200);
    const granted = await selected.json();
    assert.equal(granted.effectiveMode, "full");
    assert.equal(posts, 0, "Entering Full must not execute old proposals");
    const timeout = setTimeout(() => stop.abort(), 4000);
    try {
      while (!streamed.includes('"effectiveMode":"full"'))
        streamed += Buffer.from((await reader.read()).value!).toString();
    } finally {
      clearTimeout(timeout);
      stop.abort();
      await reader.cancel().catch(() => {});
    }
    assert.equal((await post("/api/home-permissions", full)).status, 409);
    const readonly = await post("/api/home-permissions", {
      mode: "read-only",
      revision: granted.revision,
      policy: granted.policy,
    });
    assert.equal(readonly.status, 200);
    // A deliberately synthetic legacy pending receipt must still fail through HTTP.
    await runtime.harness.commit(async (tx) => {
      const p = (await tx.doc(Proposals, id as ConversationId)).items[
        proposal.id
      ]!;
      p.status = "pending";
      delete p.authorization;
    }, ctx);
    const denied = await post(`/api/sessions/${id}/actions`, {
      id: proposal.id,
      hash: proposal.hash,
      decision: "approve",
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, "home_read_only");
    assert.equal(posts, 0);
    const other = await runtime.create(
      "other-owner",
      "Private",
      "create-http-private",
    );
    assert.equal((await get(`/api/sessions/${other}/snapshot`)).status, 404);
    assert.equal((await get(`/api/sessions/${other}/events`)).status, 404);
    const html = await (await get("/")).text();
    assert.match(html, /Home permissions/);
    assert.match(html, /Emergency Read-only/);
    assert.match(html, /Code permissions\s+are unchanged/);
  } finally {
    stop.abort();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
