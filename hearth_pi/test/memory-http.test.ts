// Memory and Suggestions HTTP API: authentication, Origin/CSRF, owner
// isolation, hash-bound decisions and the Today merge, over the real server
// and durable harness with the offline faux provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";
import { Actions, haExtension } from "../src/ha.js";
import { appServer } from "../src/server.js";
import { offline } from "./fixtures.js";
import { call, fakeHA, laundrySpec } from "./app-fixtures.js";

test("Memory and Suggestions HTTP routes enforce auth, Origin/CSRF, owner scope and hash-bound accept/edit/reject", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-memory-http-"));
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
  let n = 0;
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
        await post("/api/sessions", { title: "Home", requestId: "mem-http-1" })
      ).json()
    ).id;
    const run = (owner: string, session: number, tool: string, args: unknown) =>
      call(
        runtime,
        provider.faux,
        owner,
        session,
        tool,
        args,
        `mem-http-${++n}`,
      );
    await run("local-admin", id, "app_create", { spec: laundrySpec() });
    await run("local-admin", id, "suggest_memory", {
      text: "Study fan is called <b>Breezy</b>",
      reason: "You named it.",
    });
    await run("local-admin", id, "suggest_app_change", {
      appId: "app_1",
      baseVersion: 1,
      patch: [{ op: "replace", path: "/title", value: "Laundry room" }],
      summary: "Rename to Laundry room",
    });
    // Another owner's suggestion and memory live in the same store.
    const otherSession = await runtime.create("other", "Other", "mem-http-o1");
    await run("other", otherSession, "suggest_memory", {
      text: "Private other-owner fact",
      reason: "",
    });

    // Authentication on every new route.
    assert.equal((await fetch(`${base}/api/memory`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/api/suggestions/accept`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    // Today merges suggestions and counts them as unread.
    const today = await (await get("/api/today")).json();
    assert.equal(today.suggestions.items.length, 2);
    assert.equal(today.unread, 2);
    assert.doesNotMatch(JSON.stringify(today), /Private other-owner fact/);
    assert.doesNotMatch(JSON.stringify(today), /fingerprint/);
    const memoryS = today.suggestions.items.find(
      (s: { kind: string }) => s.kind === "memory",
    );
    const appS = today.suggestions.items.find(
      (s: { kind: string }) => s.kind === "app_change",
    );
    assert.equal(memoryS.memory.text, "Study fan is called <b>Breezy</b>");

    // Origin and CSRF are required for every decision.
    const accept = { id: memoryS.id, hash: memoryS.hash };
    assert.equal(
      (
        await post("/api/suggestions/accept", accept, {
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post("/api/suggestions/accept", accept, {
          "x-hearth-csrf": "forged",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          "/api/memory/add",
          { text: "x" },
          { "x-hearth-csrf": "forged" },
        )
      ).status,
      403,
    );
    const wrongHash = await post("/api/suggestions/accept", {
      ...accept,
      hash: "a".repeat(64),
    });
    assert.equal(wrongHash.status, 409);
    assert.equal((await wrongHash.json()).error, "suggestion_changed");
    assert.equal(
      (await post("/api/suggestions/accept", { ...accept, extra: true }))
        .status,
      400,
    );
    assert.equal(
      (
        await post("/api/suggestions/accept", {
          id: "s_99",
          hash: memoryS.hash,
        })
      ).status,
      404,
    );
    // Edit then accept: the edited text is what is remembered.
    const edited = await post("/api/suggestions/accept", {
      ...accept,
      text: "The study fan is called Breezy",
    });
    assert.equal(edited.status, 200);
    const editedBody = await edited.json();
    assert.equal(editedBody.decision.ok, true);
    assert.equal(editedBody.suggestions.items.length, 1);
    const memory = await (await get("/api/memory")).json();
    assert.deepEqual(
      memory.items.map((i: { text: string }) => i.text),
      ["The study fan is called Breezy"],
    );
    assert.equal(memory.items[0].source.kind, "suggestion");
    assert.equal(memory.items[0].sourceTitle, "Home");

    // Reject the app change: nothing applied, gone from Today.
    const rejected = await post("/api/suggestions/reject", {
      id: appS.id,
      hash: appS.hash,
    });
    assert.equal(rejected.status, 200);
    assert.equal((await rejected.json()).suggestions.items.length, 0);
    assert.equal((await (await get("/api/apps")).json()).items[0].version, 1);
    const again = await run("local-admin", id, "suggest_app_change", {
      appId: "app_1",
      baseVersion: 1,
      patch: [{ op: "replace", path: "/title", value: "Laundry room" }],
      summary: "Rename again",
    });
    assert.equal(again.error, "recently_rejected");

    // Owner memory CRUD, plain text only.
    const added = await post("/api/memory/add", {
      text: "Bedtime is\n\taround 23:00 <script>alert(1)</script>",
    });
    assert.equal(added.status, 200);
    const addedBody = await added.json();
    const bedtime = addedBody.items.find((i: { text: string }) =>
      i.text.startsWith("Bedtime"),
    );
    assert.equal(
      bedtime.text,
      "Bedtime is around 23:00 <script>alert(1)</script>",
    );
    assert.equal(bedtime.source.kind, "owner");
    assert.equal(
      (await post("/api/memory/add", { text: "y".repeat(201) })).status,
      400,
    );
    assert.equal(
      (await post("/api/memory/add", { text: "synthetic-supervisor-token" }))
        .status,
      200,
    );
    assert.doesNotMatch(
      JSON.stringify(await (await get("/api/memory")).json()),
      /synthetic-supervisor-token/,
    );
    const editedMemory = await post("/api/memory/edit", {
      id: bedtime.id,
      text: "Bedtime is around 22:30",
    });
    assert.equal(editedMemory.status, 200);
    assert.equal(
      (await post("/api/memory/edit", { id: "m_999", text: "x" })).status,
      404,
    );
    const forgotten = await post("/api/memory/forget", { id: bedtime.id });
    assert.equal(forgotten.status, 200);
    assert.doesNotMatch(JSON.stringify(await forgotten.json()), /Bedtime/);
    assert.equal(
      (await post("/api/memory/forget", { id: bedtime.id })).status,
      404,
    );
    assert.equal(f.posts.length, 0, "no Home Assistant writes");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
