import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction, Credential } from "@earendil-works/pi-ai";
import { PrivateCredentials, Subscription } from "../src/subscription.js";
import { configuredModels } from "../src/models.js";
import type { Config } from "../src/config.js";
const credential: Credential = {
  type: "oauth",
  access: "synthetic-private-access-canary",
  refresh: "synthetic-private-refresh-canary",
  expires: Date.now() + 86400000,
  accountId: "synthetic",
};

test("protected OAuth storage serializes refresh, survives restart, exposes only metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-oauth-"));
  try {
    const store = new PrivateCredentials(join(dir, "chatgpt-oauth.json"), [
      "synthetic-ha-token",
    ]);
    await store.modify("openai-codex", async () => credential);
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    assert.deepEqual(await store.list(), [
      { providerId: "openai-codex", type: "oauth" },
    ]);
    let mutations = 0;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        store.modify("openai-codex", async (current) => {
          assert(current?.type === "oauth");
          const previous = Number(current.sequence ?? 0);
          await new Promise((resolve) => setTimeout(resolve, 2));
          mutations++;
          return { ...current, sequence: previous + 1 };
        }),
      ),
    );
    const saved = await store.read("openai-codex");
    assert(saved?.type === "oauth");
    assert.equal(saved.sequence, 4);
    assert.equal(mutations, 4);
    assert(store.secrets.includes(credential.access));
    const { runtime: native } = await Subscription.open(dir, []);
    assert.equal(native.hasConfiguredAuth("openai-codex"), true);
    const subscription = new Subscription(native);
    assert.doesNotMatch(
      JSON.stringify(subscription.status("owner")),
      /synthetic-private/,
    );
    const configured = await configuredModels(
      { provider: "openai-codex", model: "gpt-5.5" } as Config,
      native,
      store.secrets,
    );
    assert.equal(configured.provider, "openai-codex");
    assert(configured.models.getModel("openai-codex", "gpt-5.5"));
    await subscription.logout("owner");
    assert.equal((await store.list()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("real Pi Codex device flow uses official endpoints and persists tokens outside response metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-device-oauth-")),
    previous = globalThis.fetch;
  const access = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.synthetic-signature`;
  let requests = 0;
  globalThis.fetch = (async (url, init) => {
    requests++;
    assert.equal(init?.method, "POST");
    switch (String(url)) {
      case "https://auth.openai.com/api/accounts/deviceauth/usercode":
        return Response.json({
          device_auth_id: "synthetic-device",
          user_code: "SYNTH-CODE",
          interval: 0,
        });
      case "https://auth.openai.com/api/accounts/deviceauth/token":
        return Response.json({
          authorization_code: "synthetic-authorization",
          code_verifier: "synthetic-verifier",
        });
      case "https://auth.openai.com/oauth/token":
        return Response.json({
          access_token: access,
          refresh_token: "synthetic-refresh-canary",
          expires_in: 3600,
        });
      default:
        throw new Error("Unexpected authentication origin");
    }
  }) as typeof fetch;
  const { subscription, secrets } = await Subscription.open(dir, []);
  try {
    await subscription.start("owner", "device_code");
    for (
      let i = 0;
      i < 100 &&
      !["connected", "failed"].includes(
        subscription.status("owner").login?.state ?? "",
      );
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(subscription.status("owner").configured, true);
    assert.equal(requests, 3);
    assert(secrets.includes(access));
    assert.doesNotMatch(
      JSON.stringify(subscription.status("owner")),
      /synthetic-refresh|synthetic-signature/,
    );
    assert.equal(
      (await stat(join(dir, "chatgpt-oauth.json"))).mode & 0o777,
      0o600,
    );
  } finally {
    await subscription.close();
    globalThis.fetch = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("OAuth flow is owner-bound, cancellable and does not return credential/error payloads", async () => {
  let connected = false,
    resolveLogin!: () => void;
  const service = new Subscription({
    hasConfiguredAuth: () => connected,
    logout: async () => {
      connected = false;
    },
    login: async (_provider, _type, interaction: AuthInteraction) => {
      assert.equal(
        await interaction.prompt({
          type: "select",
          message: "Method",
          options: [{ id: "device_code", label: "Headless" }],
        }),
        "device_code",
      );
      interaction.notify({
        type: "device_code",
        userCode: "SYNTH-CODE",
        verificationUri: "https://auth.openai.com/codex/device",
      });
      await new Promise<void>((resolve, reject) => {
        resolveLogin = resolve;
        interaction.signal?.addEventListener(
          "abort",
          () => reject(new Error(credential.access)),
          { once: true },
        );
      });
      connected = true;
      return credential;
    },
  });
  await service.start("owner", "device_code");
  await new Promise((resolve) => setImmediate(resolve));
  const own = service.status("owner");
  assert.equal(own.login?.userCode, "SYNTH-CODE");
  assert(!service.status("different-owner").login);
  await assert.rejects(
    service.cancel("different-owner", own.login!.id),
    /login_not_found/,
  );
  await assert.rejects(
    service.start("owner", "device_code"),
    /login_in_progress/,
  );
  await service.cancel("owner", own.login!.id);
  assert.equal(service.status("owner").login?.state, "cancelled");
  assert.doesNotMatch(
    JSON.stringify(service.status("owner")),
    /synthetic-private/,
  );
  await service.start("owner", "device_code");
  await new Promise((resolve) => setImmediate(resolve));
  resolveLogin();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.status("owner").configured, true);
  assert.equal(service.status("owner").login?.userCode, "");
  await service.close();
});

test("headless browser fallback rejects code without redirect state and wrong owner", async () => {
  let received = "";
  const service = new Subscription({
    hasConfiguredAuth: () => false,
    logout: async () => {},
    login: async (_p, _t, interaction) => {
      await interaction.prompt({
        type: "select",
        message: "Method",
        options: [{ id: "browser", label: "Browser" }],
      });
      received = await interaction.prompt({
        type: "manual_code",
        message: "URL",
      });
      return credential;
    },
  });
  await service.start("owner", "browser");
  await new Promise((resolve) => setImmediate(resolve));
  const id = service.status("owner").login!.id;
  assert.throws(() =>
    service.answer(
      "other",
      id,
      "http://localhost:1455/auth/callback?code=x&state=y",
    ),
  );
  assert.throws(
    () =>
      service.answer("owner", id, "http://localhost:1455/auth/callback?code=x"),
    /redirect_url_required/,
  );
  service.answer(
    "owner",
    id,
    "http://localhost:1455/auth/callback?code=synthetic&state=synthetic-state",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(received, /state=synthetic-state/);
  await service.close();
});
