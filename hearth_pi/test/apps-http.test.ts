import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";
import { Actions, haExtension } from "../src/ha.js";
import { appServer } from "../src/server.js";
import { FULL_ACKNOWLEDGEMENT } from "../src/home-actions.js";
import { offline } from "./fixtures.js";
import { call, fakeHA, laundrySpec } from "./app-fixtures.js";

test("Apps HTTP API enforces auth, Origin/CSRF, owner isolation, bounded bodies and routes presses through Home permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-apps-http-"));
  const provider = offline();
  const f = fakeHA();
  f.ha.actions.authorizeOwners(["local-admin"]);
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
    policy: f.policy,
    haToken: "synthetic-supervisor-token",
    apiKey: "synthetic-provider-key",
  };
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(f.ha)],
    [],
    undefined,
    f.ha.actions,
  );
  const app = appServer(cfg, runtime, new Actions(runtime, f.ha));
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
  try {
    const boot = await get("/api/bootstrap");
    const csrf = (await boot.json()).csrf;
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const post = (
      path: string,
      value: unknown,
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
        body: JSON.stringify(value),
      });
    const id = (
      await (
        await post("/api/sessions", { title: "Home", requestId: "apps-http-1" })
      ).json()
    ).id;
    await call(
      runtime,
      provider.faux,
      "local-admin",
      id,
      "app_create",
      { spec: laundrySpec() },
      "apps-http-input",
    );
    // Another owner's app exists in the same store but is invisible here.
    const otherSession = await runtime.create(
      "other",
      "Other",
      "apps-http-other",
    );
    await call(
      runtime,
      provider.faux,
      "other",
      otherSession,
      "app_create",
      { spec: laundrySpec({ title: "Private" }) },
      "apps-http-other-input",
    );
    // Authentication on every route.
    assert.equal((await fetch(`${base}/api/apps`)).status, 401);
    assert.equal((await fetch(`${base}/api/apps/app_1`)).status, 401);
    assert.equal((await fetch(`${base}/apps.js`)).status, 401);
    const listed = await get("/api/apps");
    assert.match(
      listed.headers.get("content-security-policy")!,
      /script-src 'self'; style-src 'self'/,
    );
    assert.deepEqual(
      (await listed.json()).items.map((a: { title: string }) => a.title),
      ["Laundry"],
    );
    const script = await get("/apps.js");
    assert.equal(script.headers.get("content-type"), "text/javascript");
    assert.match(
      script.headers.get("content-security-policy")!,
      /default-src 'none'; script-src 'self'/,
    );
    assert.doesNotMatch(
      await script.text(),
      /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|document\.write/,
    );
    // Resolved values, as-of, and no secrets.
    const resolved = await get("/api/apps/app_1");
    assert.equal(resolved.status, 200);
    const body = await resolved.json();
    assert.equal(body.values["sensor.washer_power"].state, "512.5");
    assert(body.observedAt > 0);
    assert.doesNotMatch(
      JSON.stringify(body),
      /synthetic-supervisor-token|synthetic-provider-key|must-not-export/,
    );
    // Owner isolation: the other owner's app is a 404 for every operation.
    assert.equal((await get("/api/apps/app_2")).status, 404);
    for (const [path, value] of [
      ["/api/apps/app_2/state", { stateKey: "fold", op: "reset" }],
      ["/api/apps/app_2/pin", { pinned: true }],
      ["/api/apps/app_2/revert", { version: 1, baseVersion: 1 }],
      ["/api/apps/app_2/delete", { confirm: true }],
      [
        "/api/apps/app_2/actions",
        { elementId: "hall", sessionId: id, version: 1 },
      ],
    ] as const)
      assert.equal((await post(path, value)).status, 404, path);
    // CSRF and Origin are enforced like every other mutation.
    const tick = { stateKey: "fold", op: "check", item: "Towels" };
    assert.equal(
      (
        await post("/api/apps/app_1/state", tick, {
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (await post("/api/apps/app_1/state", tick, { "x-hearth-csrf": "forged" }))
        .status,
      403,
    );
    assert.equal(
      (await post("/api/apps/app_1/state", { ...tick, extra: 1 })).status,
      400,
    );
    assert.equal(
      (
        await post("/api/apps/app_1/state", {
          stateKey: "note",
          op: "set",
          text: "x".repeat(9000),
        })
      ).status,
      413,
    );
    assert.equal((await post("/api/apps/app_99/state", tick)).status, 404);
    assert.equal((await post("/api/apps/../sessions/state", tick)).status, 404);
    const ticked = await post("/api/apps/app_1/state", tick);
    assert.equal(ticked.status, 200);
    assert.deepEqual((await ticked.json()).state.fold.checked, ["Towels"]);
    assert.equal(
      (await post("/api/apps/app_1/pin", { pinned: true })).status,
      200,
    );
    assert.equal((await (await get("/api/apps")).json()).items[0].pinned, true);
    // Read-only (actions disabled for this owner): press refused, no POST to HA.
    const settings = await f.ha.actions.settings("local-admin");
    await f.ha.actions.setMode(
      "local-admin",
      "read-only",
      settings.revision,
      settings.policy,
      undefined,
    );
    const ro = await post("/api/apps/app_1/actions", {
      elementId: "hall",
      sessionId: id,
      version: 1,
    });
    assert.equal(ro.status, 403);
    assert.equal((await ro.json()).error, "home_read_only");
    // Ask: exact pending proposal that the existing approval endpoint decides.
    let p = await f.ha.actions.settings("local-admin");
    await f.ha.actions.setMode(
      "local-admin",
      "ask",
      p.revision,
      p.policy,
      undefined,
    );
    const asked = await (
      await post("/api/apps/app_1/actions", {
        elementId: "hall",
        sessionId: id,
        version: 1,
      })
    ).json();
    assert.equal(asked.proposal.status, "pending");
    assert.deepEqual(f.posts, []);
    const snapshot = await (await get(`/api/sessions/${id}/snapshot`)).json();
    assert.equal(snapshot.proposals[asked.proposal.id].origin.appId, "app_1");
    const approved = await post(`/api/sessions/${id}/actions`, {
      id: asked.proposal.id,
      hash: asked.proposal.hash,
      decision: "approve",
    });
    assert.equal(approved.status, 200);
    assert.deepEqual(f.posts, ["services/light/turn_on"]);
    // Full: runs once and returns the read-back.
    p = await f.ha.actions.settings("local-admin");
    await f.ha.actions.setMode(
      "local-admin",
      "full",
      p.revision,
      p.policy,
      FULL_ACKNOWLEDGEMENT,
    );
    const full = await (
      await post("/api/apps/app_1/actions", {
        elementId: "hall",
        sessionId: id,
        version: 1,
      })
    ).json();
    assert.equal(full.proposal.status, "accepted");
    assert.equal(full.readBack.state, "off");
    assert.equal(f.posts.length, 2);
    // Revert then delete.
    const reverted = await post("/api/apps/app_1/revert", {
      version: 1,
      baseVersion: 1,
    });
    assert.equal(reverted.status, 404);
    assert.equal(
      (await post("/api/apps/app_1/delete", { confirm: true })).status,
      200,
    );
    assert.equal((await get("/api/apps/app_1")).status, 404);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
