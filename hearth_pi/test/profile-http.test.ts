// Owner profile HTTP API: authentication, Origin/CSRF, revision-checked
// writes and owner isolation, over the real server and durable harness with
// the offline faux provider. Mirrors memory-http.test.ts's shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";
import { Actions, haExtension } from "../src/ha.js";
import { appServer } from "../src/server.js";
import { ProfileStore } from "../src/profile.js";
import { offline } from "./fixtures.js";
import { fakeHA } from "./app-fixtures.js";

test("Owner profile HTTP routes enforce auth, Origin/CSRF, strict validation, revision checks and owner isolation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-profile-http-"));
  const provider = offline();
  const f = fakeHA();
  f.ha.actions.authorizeOwners(["local-admin"]);
  const cfg = {
    mode: "local" as const,
    host: "127.0.0.1",
    port: 8099,
    origin: "http://127.0.0.1:8099",
    password: "synthetic-local-password-0002",
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
    const { items: models } = await (await get("/api/models")).json();
    const [model] = models;
    assert(model, "offline provider exposes at least one model");

    // Authentication required, both methods.
    assert.equal((await fetch(`${base}/api/profile`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/api/profile`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );

    // Unset owner: an empty profile, never 404.
    const empty = await (await get("/api/profile")).json();
    assert.equal(empty.displayName, undefined);
    assert.equal(empty.revision, 0);
    assert.deepEqual(empty.thinkingLevels, [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    // Origin and CSRF are required for the write, like every other mutation.
    assert.equal(
      (
        await post(
          "/api/profile",
          { displayName: "Alex", revision: 0 },
          { origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          "/api/profile",
          { displayName: "Alex", revision: 0 },
          { "x-hearth-csrf": "forged" },
        )
      ).status,
      403,
    );

    // Strict validation: unknown field, oversized name, bad tone/language,
    // an unsupported model and a thinking level without a model.
    assert.equal(
      (await post("/api/profile", { extra: true, revision: 0 })).status,
      400,
    );
    assert.equal(
      (
        await post("/api/profile", {
          displayName: "y".repeat(41),
          revision: 0,
        })
      ).status,
      400,
    );
    assert.equal(
      (await post("/api/profile", { tone: "sarcastic", revision: 0 })).status,
      400,
    );
    assert.equal(
      (await post("/api/profile", { language: "<script>", revision: 0 }))
        .status,
      400,
    );
    assert.equal(
      (
        await post("/api/profile", {
          defaultModel: { provider: model.provider, modelId: "does-not-exist" },
          revision: 0,
        })
      ).status,
      400,
    );
    assert.equal(
      (await post("/api/profile", { defaultThinking: "off", revision: 0 }))
        .status,
      400,
    );

    // Save, then read it back.
    const saved = await (
      await post("/api/profile", {
        displayName: "Alex Rivera",
        tone: "concise",
        language: "en",
        defaultModel: { provider: model.provider, modelId: model.id },
        defaultThinking: "off",
        revision: 0,
      })
    ).json();
    assert.equal(saved.displayName, "Alex Rivera");
    assert.equal(saved.tone, "concise");
    assert.equal(saved.language, "en");
    assert.deepEqual(saved.defaultModel, {
      provider: model.provider,
      modelId: model.id,
    });
    assert.equal(saved.defaultThinking, "off");
    assert.equal(saved.revision, 1);
    const reread = await (await get("/api/profile")).json();
    assert.deepEqual(reread, saved);

    // Stale revision: refused, nothing changes.
    const stale = await post("/api/profile", {
      displayName: "Someone else",
      revision: 0,
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "profile_stale");
    assert.equal(
      (await (await get("/api/profile")).json()).displayName,
      "Alex Rivera",
    );

    // Clear fields with an explicit empty value, not by omitting them.
    const cleared = await (
      await post("/api/profile", {
        displayName: "",
        tone: "",
        language: "",
        defaultModel: null,
        defaultThinking: null,
        revision: 1,
      })
    ).json();
    assert.equal(cleared.displayName, undefined);
    assert.equal(cleared.defaultModel, undefined);
    assert.equal(cleared.revision, 2);

    // Owner isolation: another owner's profile (set directly, since this
    // server's local mode authenticates only one HTTP owner) never leaks
    // into local-admin's GET, matching memory-http.test.ts's pattern.
    const store = new ProfileStore(runtime);
    await store.put("other-owner", {
      displayName: "Private other-owner name",
      revision: 0,
    });
    const afterOther = await (await get("/api/profile")).json();
    assert.doesNotMatch(JSON.stringify(afterOther), /Private other-owner name/);
    assert.equal(
      (await store.get("other-owner")).displayName,
      "Private other-owner name",
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
