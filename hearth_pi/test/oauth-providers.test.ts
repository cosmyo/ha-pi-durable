import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Credential } from "@earendil-works/pi-ai";
import { Runtime } from "../src/runtime.js";
import { PrivateCredentials, Subscription } from "../src/subscription.js";
import { safeModels } from "../src/models.js";
import { HAClient, Actions } from "../src/ha.js";
import { appServer } from "../src/server.js";
import { redactor } from "../src/safety.js";
import type { Config } from "../src/config.js";

const codexAccess = "synthetic-codex-access-canary";
const codexRefresh = "synthetic-codex-refresh-canary";
const anthropicAccess = ["sk", "ant", "oat", "synthetic-multi-access"].join(
  "-",
);
const anthropicRefresh = "synthetic-multi-anthropic-refresh";
const canary = /synthetic-(codex|multi)-/;
const oauth = (access: string, refresh: string): Credential => ({
  type: "oauth",
  access,
  refresh,
  expires: Date.now() + 86400000,
});
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200 && !(await predicate()); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert(await predicate(), "Synthetic state was not reached");
}

test("signed-in OAuth provider models are selectable per session, durable across reopen, refused when signed out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-oauth-models-"));
  const primary = fauxProvider({
    provider: "primary",
    models: [{ id: "first", name: "First" }],
  });
  const claude = fauxProvider({
    provider: "anthropic",
    models: [{ id: "claude-synthetic", name: "Claude synthetic" }],
  });
  const models = createModels();
  models.setProvider(primary.provider);
  models.setProvider(claude.provider);
  const model = { provider: "primary", modelId: "first" };
  let signedIn = false;
  const providers = () => [{ provider: "anthropic", signedIn }];
  let runtime = await Runtime.open(dir, models, model);
  runtime.oauthProviders = providers;
  try {
    const id = await runtime.create("owner", "Switch", "oauth-model-create");
    assert.deepEqual(runtime.modelChoices(), [
      { id: "first", name: "First", provider: "primary" },
    ]);
    await assert.rejects(
      runtime.selectModel(
        "owner",
        id,
        "claude-synthetic",
        "off",
        0,
        "anthropic",
      ),
      /subscription_login_required/,
    );
    await assert.rejects(
      runtime.selectModel("owner", id, "first", "off", 0, "openai-codex"),
      /provider_unavailable/,
    );
    signedIn = true;
    assert.deepEqual(
      runtime.modelChoices().map((m) => [m.provider, m.id]),
      [
        ["primary", "first"],
        ["anthropic", "claude-synthetic"],
      ],
    );
    // The pair is the key: an id of another provider is not selectable.
    await assert.rejects(
      runtime.selectModel("owner", id, "first", "off", 0, "anthropic"),
      /unsupported_model/,
    );
    const selected = await runtime.selectModel(
      "owner",
      id,
      "claude-synthetic",
      "off",
      0,
      "anthropic",
    );
    assert.deepEqual(selected.model, {
      provider: "anthropic",
      modelId: "claude-synthetic",
    });
    const used: string[] = [];
    claude.setResponses([
      (_c, _o, _s, m) => {
        used.push(`${m.provider}/${m.id}`);
        return fauxAssistantMessage("From Claude");
      },
    ]);
    await runtime.submit("owner", id, "oauth-turn-one", "Hello");
    await runtime.harness.waitForIdle(ctx);
    assert.deepEqual(used, ["anthropic/claude-synthetic"]);
    await runtime.close();
    runtime = await Runtime.open(dir, models, model);
    runtime.oauthProviders = providers;
    assert.deepEqual(
      (await runtime.snapshot("owner", id)).modelSelection.model,
      { provider: "anthropic", modelId: "claude-synthetic" },
    );
    assert.equal(await runtime.sessionProvider("owner", id), "anthropic");
    // New sessions keep the configured default provider/model.
    const fresh = await runtime.create("owner", "Fresh", "oauth-model-fresh");
    assert.deepEqual(
      (await runtime.snapshot("owner", fresh)).modelSelection.model,
      model,
    );
    // Switching back to the configured provider needs no OAuth provider.
    signedIn = false;
    await runtime.selectModel("owner", id, "first", "off", 1);
    assert.deepEqual(
      (await runtime.snapshot("owner", id)).modelSelection.model,
      model,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("disabled Anthropic opens no Anthropic store; existing ChatGPT credential is unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-oauth-disabled-"));
  try {
    await new PrivateCredentials(join(dir, "chatgpt-oauth.json")).modify(
      "openai-codex",
      async () => oauth(codexAccess, codexRefresh),
    );
    await new PrivateCredentials(
      join(dir, "anthropic-oauth.json"),
      [],
      "anthropic",
    ).modify("anthropic", async () => oauth(anthropicAccess, anthropicRefresh));
    const { subscriptions, runtime, secrets } =
      await Subscription.openProviders(
        dir,
        ["synthetic-seed"],
        ["openai-codex"],
      );
    assert.deepEqual(
      subscriptions.map((s) => s.provider),
      ["openai-codex"],
    );
    assert.equal(subscriptions[0]!.status("owner").configured, true);
    assert.equal(runtime.hasConfiguredAuth("anthropic"), false);
    assert(secrets.includes(codexAccess) && secrets.includes("synthetic-seed"));
    assert(!secrets.includes(anthropicAccess));
    await assert.rejects(
      runtime.logout("anthropic"),
      /unsupported_credentials|anthropic/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP routes OAuth per provider over one Pi runtime; ids stay bound, models follow sign-in, no tokens leave", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-oauth-http-"));
  const previousFetch = globalThis.fetch;
  let exchanges = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url) !== "https://platform.claude.com/v1/oauth/token")
      return previousFetch(url, init);
    exchanges++;
    return Response.json({
      access_token: exchanges === 1 ? anthropicAccess : `${anthropicAccess}-r`,
      refresh_token: anthropicRefresh,
      expires_in: 3600,
    });
  }) as typeof fetch;
  await new PrivateCredentials(join(dir, "chatgpt-oauth.json")).modify(
    "openai-codex",
    async () => oauth(codexAccess, codexRefresh),
  );
  const {
    subscriptions,
    runtime: native,
    secrets,
  } = await Subscription.openProviders(
    dir,
    ["synthetic-ha-token-seed"],
    ["openai-codex", "anthropic"],
  );
  const runtime = await Runtime.open(
    dir,
    safeModels(native, secrets),
    { provider: "openai-codex", modelId: "gpt-5.5" },
    [],
    secrets,
  );
  runtime.oauthProviders = () =>
    subscriptions.map((s) => ({
      provider: s.provider,
      signedIn: s.configured(),
    }));
  const cfg: Config = {
    mode: "local",
    host: "127.0.0.1",
    port: 8099,
    origin: "http://127.0.0.1:8099",
    password: "synthetic-local-password-0001",
    authorizedUsers: [],
    dataDir: dir,
    provider: "openai-codex",
    anthropicAuthEnabled: true,
    model: "gpt-5.5",
    policy: { enabled: false, services: [], entities: [] },
    apiKey: "",
    haToken: "synthetic-ha-token-seed",
  };
  const app = appServer(
    cfg,
    runtime,
    new Actions(runtime, new HAClient(cfg.haToken, cfg.policy)),
    { subscriptions, secrets },
  );
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  cfg.origin = base;
  const authorization = `Basic ${Buffer.from(`hearth:${cfg.password}`).toString("base64")}`;
  const bodies: string[] = [];
  const read = async (response: Response) => {
    const raw = await response.text();
    bodies.push(raw);
    return { status: response.status, body: JSON.parse(raw) };
  };
  const get = async (path: string) =>
    read(await fetch(`${base}/api/${path}`, { headers: { authorization } }));
  try {
    const boot = await fetch(`${base}/api/bootstrap`, {
      headers: { authorization },
    });
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const status = (await read(boot)).body;
    assert.deepEqual(status.authProviders, ["openai-codex", "anthropic"]);
    assert.equal(status.inferenceReady, true);
    const post = async (path: string, payload: unknown) =>
      read(
        await fetch(`${base}/api/${path}`, {
          method: "POST",
          headers: {
            authorization,
            cookie,
            origin: base,
            "x-hearth-csrf": status.csrf,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        }),
      );
    const listed = (await get("auth/providers")).body.items;
    assert.deepEqual(
      listed.map((s: { provider: string; configured: boolean }) => [
        s.provider,
        s.configured,
      ]),
      [
        ["openai-codex", true],
        ["anthropic", false],
      ],
    );
    assert.deepEqual(listed[0], (await get("auth/status")).body);
    const codexOnly = (await get("models")).body.items;
    assert(codexOnly.length > 0);
    assert(
      codexOnly.every(
        (m: { provider: string }) => m.provider === "openai-codex",
      ),
    );

    const id = await runtime.create("local-admin", "Multi", "oauth-http-one");
    const select = (provider: string | undefined, revision: number) =>
      post(`sessions/${id}/model`, {
        ...(provider ? { provider } : {}),
        modelId: provider === "anthropic" ? "claude-haiku-4-5" : "gpt-5.5",
        thinkingLevel: "off",
        revision,
      });
    const refused = await select("anthropic", 0);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "subscription_login_required");
    assert.equal((await select("bogus", 0)).body.error, "provider_unavailable");
    assert.equal(
      (await post("auth/login", { provider: "bogus" })).body.error,
      "provider_unavailable",
    );

    // Real Pi Anthropic login, routed by provider; Codex status is untouched.
    const started = await post("auth/login", { provider: "anthropic" });
    assert.equal(started.status, 202);
    assert.equal(started.body.provider, "anthropic");
    const anthropic = subscriptions.find((s) => s.provider === "anthropic")!;
    await until(() => !!anthropic.status("local-admin").login?.prompt);
    const loginId = anthropic.status("local-admin").login!.id;
    assert.equal((await get("auth/status")).body.login, undefined);
    // An Anthropic login id is unknown to the (default) Codex subscription.
    assert.equal(
      (await post("auth/answer", { id: loginId, value: "copy_code" })).status,
      409,
    );
    assert.equal((await post("auth/cancel", { id: loginId })).status, 404);
    assert.equal(
      (
        await post("auth/answer", {
          provider: "anthropic",
          id: loginId,
          value: "copy_code",
        })
      ).status,
      200,
    );
    await until(
      () =>
        anthropic.status("local-admin").login?.prompt?.type === "manual_code",
    );
    const state = new URL(
      anthropic.status("local-admin").login!.url,
    ).searchParams.get("state")!;
    assert.equal(
      (
        await post("auth/answer", {
          provider: "anthropic",
          id: loginId,
          value: `synthetic-code#${state}`,
        })
      ).status,
      200,
    );
    await until(() => anthropic.configured());
    assert.equal(exchanges, 1);
    assert.deepEqual(
      (await get("auth/providers")).body.items.map(
        (s: { configured: boolean }) => s.configured,
      ),
      [true, true],
    );
    const both = (await get("models")).body.items;
    assert(
      both.some(
        (m: { provider: string; id: string }) =>
          m.provider === "anthropic" && m.id === "claude-haiku-4-5",
      ),
    );
    assert(
      both.some((m: { provider: string }) => m.provider === "openai-codex"),
    );
    const switched = await select("anthropic", 0);
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.deepEqual(switched.body.model, {
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
    });
    assert.deepEqual(
      (await get(`sessions/${id}/snapshot`)).body.modelSelection.model,
      { provider: "anthropic", modelId: "claude-haiku-4-5" },
    );

    // Refresh through Pi's per-provider lock lands in the shared redaction list.
    await new PrivateCredentials(
      join(dir, "anthropic-oauth.json"),
      [],
      "anthropic",
    ).modify("anthropic", async (current) => ({
      ...current!,
      expires: Date.now() + 1000,
    }));
    const checked = await post("auth/verify", { provider: "anthropic" });
    assert.equal(checked.body.lastCheck.ok, true);
    assert.equal(exchanges, 2);
    for (const secret of [
      "synthetic-ha-token-seed",
      codexAccess,
      codexRefresh,
      anthropicAccess,
      `${anthropicAccess}-r`,
      anthropicRefresh,
    ])
      assert(secrets.includes(secret), "secret missing from redaction list");
    assert.doesNotMatch(
      redactor(secrets)(`${codexAccess} ${anthropicAccess}-r ${codexRefresh}`),
      canary,
    );

    // Signing out one provider leaves the other; its models leave the list
    // and a session committed to it cannot submit until signed in again.
    const out = await post("auth/logout", { provider: "anthropic" });
    assert.equal(out.body.configured, false);
    assert.equal((await get("auth/status")).body.configured, true);
    assert(
      (await get("models")).body.items.every(
        (m: { provider: string }) => m.provider === "openai-codex",
      ),
    );
    const blocked = await post(`sessions/${id}/inputs`, {
      requestId: "oauth-http-blocked",
      content: "Hello",
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, "subscription_login_required");
    assert.deepEqual(
      (await get(`sessions/${id}/snapshot`)).body.modelSelection.model,
      { provider: "anthropic", modelId: "claude-haiku-4-5" },
    );

    // Turning the flag off hides Anthropic everywhere.
    cfg.anthropicAuthEnabled = false;
    assert.deepEqual((await get("bootstrap")).body.authProviders, [
      "openai-codex",
    ]);
    assert.deepEqual(
      (await get("auth/providers")).body.items.map(
        (s: { provider: string }) => s.provider,
      ),
      ["openai-codex"],
    );
    const disabled = await post("auth/login", { provider: "anthropic" });
    assert.equal(disabled.status, 403);
    assert.equal(disabled.body.error, "provider_unavailable");
    assert.equal(
      (
        await post(`sessions/${id}/inputs`, {
          requestId: "oauth-http-disabled",
          content: "/login anthropic",
        })
      ).status,
      403,
    );
    for (const raw of bodies) assert.doesNotMatch(raw, canary);
  } finally {
    await app.close();
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});
