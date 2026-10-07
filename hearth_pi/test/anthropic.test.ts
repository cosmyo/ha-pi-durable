import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateCredentials, Subscription } from "../src/subscription.js";
import { configuredModels } from "../src/models.js";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { Runtime } from "../src/runtime.js";
import { HAClient, Actions } from "../src/ha.js";
import { appServer } from "../src/server.js";
import { offline } from "./fixtures.js";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

const previousFlag = process.env.HEARTH_ANTHROPIC_AUTH_ENABLED;
before(() => {
  process.env.HEARTH_ANTHROPIC_AUTH_ENABLED = "true";
});
after(() => {
  if (previousFlag === undefined)
    delete process.env.HEARTH_ANTHROPIC_AUTH_ENABLED;
  else process.env.HEARTH_ANTHROPIC_AUTH_ENABLED = previousFlag;
});
const access = ["sk", "ant", "oat", "synthetic-access"].join("-");
const refresh = "synthetic-anthropic-refresh";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert(predicate(), "Synthetic login did not reach expected state");
}

test("native Anthropic headless Pi login, state binding, separated private storage, refresh and logout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-anthropic-"));
  const previous = globalThis.fetch;
  let exchanges = 0;
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://platform.claude.com/v1/oauth/token");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    assert(init?.signal);
    if (body.grant_type === "authorization_code") {
      assert.equal(
        body.redirect_uri,
        "https://platform.claude.com/oauth/code/callback",
      );
      assert.equal(body.code, "synthetic-code");
      assert.equal(body.state, body.code_verifier);
    } else {
      assert.equal(body.grant_type, "refresh_token");
      assert.equal(body.refresh_token, refresh);
    }
    exchanges++;
    return Response.json({
      access_token: exchanges === 1 ? access : `${access}-rotated`,
      refresh_token: refresh,
      expires_in: 3600,
    });
  }) as typeof fetch;
  const codex = new PrivateCredentials(join(dir, "chatgpt-oauth.json"));
  await codex.modify("openai-codex", async () => ({
    type: "oauth",
    access: "synthetic-codex-access",
    refresh: "synthetic-codex-refresh",
    expires: Date.now() + 86400000,
  }));
  const { subscription, runtime, secrets } = await Subscription.open(
    dir,
    [],
    "anthropic",
  );
  try {
    assert.equal(runtime.hasConfiguredAuth("openai-codex"), false);
    assert.equal(subscription.status("owner").configured, false);
    assert.throws(
      () => subscription.start("owner", "device_code"),
      /invalid_login_method/,
    );
    await subscription.start("owner");
    await until(() => !!subscription.status("owner").login?.prompt);
    const id = subscription.status("owner").login!.id;
    const methods = subscription.status("owner").login!.prompt;
    assert(methods?.type === "select");
    assert.deepEqual(
      methods.options.map((o) => o.id),
      ["browser", "copy_code"],
    );
    assert(!subscription.status("other").login);
    subscription.answer("owner", id, "copy_code");
    await until(
      () => subscription.status("owner").login?.prompt?.type === "manual_code",
    );
    const pending = subscription.status("owner").login!;
    const url = new URL(pending.url);
    assert.equal(url.origin, "https://claude.ai");
    const state = url.searchParams.get("state")!;
    assert.throws(
      () => subscription.answer("other", id, `synthetic-code#${state}`),
      /login_not_pending/,
    );
    for (const wrong of [
      "synthetic-code",
      "synthetic-code#wrong-state",
      `https://attacker.example/callback?code=synthetic-code&state=${state}`,
    ])
      assert.throws(() => subscription.answer("owner", id, wrong));
    assert.equal(exchanges, 0);
    subscription.answer("owner", id, `synthetic-code#${state}`);
    await until(
      () => subscription.status("owner").login?.state === "connected",
    );
    assert.equal(exchanges, 1);
    assert(secrets.includes(access));
    assert.equal(
      (await stat(join(dir, "anthropic-oauth.json"))).mode & 0o777,
      0o600,
    );
    const status = subscription.status("owner");
    assert(status.tokenExpires);
    assert.equal(status.login?.url, "");
    assert.doesNotMatch(
      JSON.stringify(status),
      /synthetic-access|synthetic-anthropic-refresh|code_verifier/,
    );
    const store = new PrivateCredentials(
      join(dir, "anthropic-oauth.json"),
      [],
      "anthropic",
    );
    assert.equal(await store.read("openai-codex"), undefined);
    await assert.rejects(store.modify("openai-codex", async () => undefined));
    await store.modify("anthropic", async (current) => ({
      ...current!,
      expires: Date.now() + 1000,
    }));
    assert.equal((await subscription.verify("owner")).lastCheck?.ok, true);
    assert.equal(exchanges, 2);
    assert(secrets.includes(`${access}-rotated`));
    const reopened = await Subscription.open(dir, [], "anthropic");
    assert.equal(reopened.subscription.status("owner").configured, true);
    assert(reopened.secrets.includes(`${access}-rotated`));
    const configured = await configuredModels(
      {
        provider: "anthropic",
        anthropicAuthEnabled: true,
        model: "claude-sonnet-5",
      } as Config,
      reopened.runtime,
      reopened.secrets,
    );
    assert(configured.models.getModel("anthropic", "claude-sonnet-5"));
    await reopened.subscription.logout("owner");
    assert.equal((await codex.read("openai-codex"))?.type, "oauth");
    assert.equal(
      await reopened.subscription.verify("owner").catch(() => undefined),
      undefined,
    );
    await reopened.subscription.close();
  } finally {
    await subscription.close();
    globalThis.fetch = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Anthropic waiting flow is cancellable and rejects a nonofficial authorization origin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-anthropic-cancel-"));
  const { subscription } = await Subscription.open(dir, [], "anthropic");
  try {
    await subscription.start("owner", "copy_code");
    await until(() => !!subscription.status("owner").login?.url);
    const id = subscription.status("owner").login!.id;
    await assert.rejects(subscription.cancel("other", id));
    await subscription.cancel("owner", id);
    assert.equal(subscription.status("owner").login?.state, "cancelled");
    assert.equal(subscription.status("owner").configured, false);
    assert.throws(() => subscription.answer("owner", id, "stale#state"));
  } finally {
    await subscription.close();
    await rm(dir, { recursive: true, force: true });
  }
  const rejected = new Subscription(
    {
      login: async (_id, _type, interaction) => {
        interaction.notify({
          type: "auth_url",
          url: "https://claude.ai.attacker.example/oauth/authorize?state=synthetic",
        });
        throw new Error("synthetic-error-token");
      },
      logout: async () => {},
      hasConfiguredAuth: () => false,
      getAuth: async () => undefined,
    },
    undefined,
    "anthropic",
  );
  await rejected.start("owner");
  await tick();
  assert.equal(rejected.status("owner").login?.state, "failed");
  assert.doesNotMatch(
    JSON.stringify(rejected.status("owner")),
    /attacker|synthetic-error/,
  );
  await rejected.close();
});

test("real pinned Anthropic transport uses the installed-package OAuth compatibility, preserves hooks and redacts errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-anthropic-transport-"));
  const previous = process.env.PI_ANTHROPIC_AUTH_DEBUG;
  const previousVersion = process.env.PI_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION;
  delete process.env.PI_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION;
  process.env.PI_ANTHROPIC_AUTH_DEBUG = "all";
  const log = console.error;
  const logged: unknown[] = [];
  console.error = (...args) => {
    logged.push(args);
  };
  const store = new PrivateCredentials(
    join(dir, "anthropic-oauth.json"),
    [],
    "anthropic",
  );
  await store.modify("anthropic", async () => ({
    type: "oauth",
    access,
    refresh,
    expires: Date.now() + 86400000,
  }));
  const { runtime, secrets, subscription } = await Subscription.open(
    dir,
    [],
    "anthropic",
  );
  try {
    await assert.rejects(
      configuredModels(
        { provider: "anthropic", model: "claude-sonnet-5" } as Config,
        runtime,
        secrets,
      ),
      /anthropic_auth_disabled/,
    );
    const { models } = await configuredModels(
      {
        provider: "anthropic",
        anthropicAuthEnabled: true,
        model: "claude-sonnet-5",
      } as Config,
      runtime,
      secrets,
    );
    let calls = 0,
      payloadHook = 0,
      responseHook = 0;
    const stream = runtime.streamSimple(
      models.getModel("anthropic", "claude-sonnet-5")!,
      {
        messages: [
          {
            role: "user",
            content: "Synthetic compatibility check",
            timestamp: Date.now(),
          },
        ],
      },
      {
        onPayload: (payload) => {
          payloadHook++;
          return { ...(payload as object), metadata: { synthetic: true } };
        },
        onResponse: () => {
          responseHook++;
        },
        fetch: (async (_input, init) => {
          calls++;
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("authorization"), `Bearer ${access}`);
          const payload = JSON.parse(String(init?.body));
          assert.equal(payload.metadata.synthetic, true);
          assert.match(
            JSON.stringify(payload.system),
            /x-anthropic-billing-header/,
          );
          assert.equal(
            payload.messages[0].content[0].text,
            "Synthetic compatibility check",
          );
          return Response.json(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: `synthetic-provider-failure ${access} ${refresh}`,
              },
            },
            { status: 400 },
          );
        }) as typeof fetch,
      },
    );
    const result = await stream.result();
    assert.equal(calls, 1, result.errorMessage);
    assert.equal(payloadHook, 1);
    // Pi calls onResponse only after a successful streaming response.
    assert.equal(responseHook, 0);
    assert.equal(result.stopReason, "error");
    const redacted = await models
      .streamSimple(
        models.getModel("anthropic", "claude-sonnet-5")!,
        {
          messages: [
            {
              role: "user",
              content: "Synthetic redaction",
              timestamp: Date.now(),
            },
          ],
        },
        {
          fetch: (async () =>
            Response.json(
              {
                type: "error",
                error: {
                  type: "invalid_request_error",
                  message: `${access} ${refresh}`,
                },
              },
              { status: 400 },
            )) as typeof fetch,
        },
      )
      .result();
    assert.doesNotMatch(
      JSON.stringify(redacted),
      /synthetic-access|synthetic-anthropic-refresh/,
    );
    const frames = [
      {
        type: "message_start",
        message: {
          id: "synthetic",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-5",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Synthetic success" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ];
    const signal = new AbortController().signal;
    const success = await models
      .streamSimple(
        models.getModel("anthropic", "claude-sonnet-5")!,
        {
          messages: [
            {
              role: "user",
              content: "Synthetic stream",
              timestamp: Date.now(),
            },
          ],
        },
        {
          signal,
          onPayload: () => {
            payloadHook++;
          },
          onResponse: ({ status }) => {
            responseHook++;
            assert.equal(status, 200);
          },
          fetch: (async (_input, init) => {
            assert(init?.signal instanceof AbortSignal);
            assert.equal(init.signal.aborted, false);
            return new Response(
              frames
                .map(
                  (frame) =>
                    `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
                )
                .join(""),
              { headers: { "content-type": "text/event-stream" } },
            );
          }) as typeof fetch,
        },
      )
      .result();
    assert.equal(success.stopReason, "stop", success.errorMessage);
    assert.equal(payloadHook, 2);
    assert.equal(responseHook, 1);
    assert.match(JSON.stringify(success.content), /Synthetic success/);
    let retries = 0;
    await models
      .streamSimple(
        models.getModel("anthropic", "claude-sonnet-5")!,
        {
          messages: [
            {
              role: "user",
              content: "Synthetic version rejection",
              timestamp: Date.now(),
            },
          ],
        },
        {
          fetch: (async (_input, init) => {
            retries++;
            if (retries === 2)
              assert.match(String(init?.body), /cc_version=999\.1\.1/);
            return Response.json(
              {
                type: "error",
                error: {
                  type: "invalid_request_error",
                  message: "Claude Code version 999.1.1 or newer is required.",
                  details: { error_code: "claude_code_version_too_old" },
                },
              },
              { status: 400 },
            );
          }) as typeof fetch,
        },
      )
      .result();
    assert.equal(
      retries,
      2,
      "compatibility version-floor recovery retries at most once",
    );
    assert.equal(logged.length, 0);
    // API-key requests through exactly the same wrapper are not shaped.
    await runtime.setRuntimeApiKey("anthropic", "sk-synthetic-api-key");
    const plain = runtime.streamSimple(
      runtime.getModel("anthropic", "claude-sonnet-5")!,
      {
        messages: [
          { role: "user", content: "Synthetic API key", timestamp: Date.now() },
        ],
      },
      {
        fetch: (async (_input, init) => {
          assert.doesNotMatch(String(init?.body), /x-anthropic-billing-header/);
          return Response.json(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "synthetic-failure",
              },
            },
            { status: 400 },
          );
        }) as typeof fetch,
      },
    );
    await plain.result();
  } finally {
    await subscription.close();
    console.error = log;
    if (previous === undefined) delete process.env.PI_ANTHROPIC_AUTH_DEBUG;
    else process.env.PI_ANTHROPIC_AUTH_DEBUG = previous;
    if (previousVersion === undefined)
      delete process.env.PI_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION;
    else process.env.PI_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION = previousVersion;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Anthropic auth HTTP and /login bypass durable admission but retain owner/CSRF/readiness guards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-anthropic-http-"));
  const { models, model } = offline();
  const cfg: Config = {
    mode: "local",
    host: "127.0.0.1",
    port: 8099,
    origin: "http://127.0.0.1:8099",
    password: "synthetic-local-password-0001",
    authorizedUsers: [],
    dataDir: dir,
    provider: "anthropic",
    anthropicAuthEnabled: true,
    model: "claude-sonnet-5",
    policy: { enabled: false, services: [], entities: [] },
    apiKey: "",
    haToken: "",
  };
  const runtime = await Runtime.open(dir, models, model, []);
  const { subscription, secrets } = await Subscription.open(
    dir,
    [],
    "anthropic",
  );
  const ha = new HAClient("", cfg.policy);
  const app = appServer(cfg, runtime, new Actions(runtime, ha), {
    subscriptions: [subscription],
    secrets,
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  cfg.origin = base;
  const authorization = `Basic ${Buffer.from(`hearth:${cfg.password}`).toString("base64")}`;
  try {
    const boot = await fetch(`${base}/api/bootstrap`, {
      headers: { authorization },
    });
    const status = await boot.json();
    assert.equal(status.inferenceReady, false);
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const headers = {
      authorization,
      cookie,
      origin: base,
      "x-hearth-csrf": status.csrf,
      "content-type": "application/json",
    };
    const post = (path: string, payload: unknown) =>
      fetch(`${base}/api/${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    const id = await runtime.create(
      "local-admin",
      "Auth check",
      "synthetic-auth-session",
    );
    const before = JSON.stringify(await runtime.snapshot("local-admin", id));
    assert.equal(
      (
        await post(`sessions/${id}/inputs`, {
          requestId: "synthetic-input",
          content: "Hello",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers: { ...headers, "x-hearth-csrf": "wrong" },
          body: "{}",
        })
      ).status,
      403,
    );
    // Only the Anthropic subscription is wired here: Codex is unavailable.
    const unavailable = await post("auth/login", { provider: "openai-codex" });
    assert.equal(unavailable.status, 403);
    assert.equal((await unavailable.json()).error, "provider_unavailable");
    assert.equal(
      (
        await post(`sessions/${id}/inputs`, {
          requestId: "synthetic-login",
          content: "/login anthropic",
        })
      ).status,
      202,
    );
    await until(
      () => subscription.status("local-admin").login?.prompt?.type === "select",
    );
    await runtime.harness.waitForIdle(ctx);
    assert.equal(
      JSON.stringify(await runtime.snapshot("local-admin", id)),
      before,
    );
    const other = await runtime.create(
      "other-owner",
      "Private",
      "synthetic-other-session",
    );
    assert.equal(
      (
        await post(`sessions/${other}/inputs`, {
          requestId: "synthetic-forged",
          content: "/login anthropic",
        })
      ).status,
      404,
    );
    assert.equal(
      (await post("auth/answer", { id: "wrong-login-id", value: "copy_code" }))
        .status,
      409,
    );
    assert.equal(
      (
        await post(`sessions/${id}/inputs`, {
          requestId: "synthetic-malformed",
          content: "/login anthropic secret",
        })
      ).status,
      400,
    );
    await subscription.cancel(
      "local-admin",
      subscription.status("local-admin").login!.id,
    );
    cfg.anthropicAuthEnabled = false;
    assert.equal((await post("auth/login", {})).status, 403);
    assert.equal(
      (
        await post(`sessions/${id}/inputs`, {
          requestId: "synthetic-disabled",
          content: "/login anthropic",
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(`${base}/api/bootstrap`, { headers: { authorization } }))
        .status,
      200,
    );
    assert.equal(
      JSON.stringify(await runtime.snapshot("local-admin", id)),
      before,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Anthropic is an explicit config option with safe defaults and no automatic scope expansion", async (t) => {
  const values = {
    HEARTH_MODE: "local",
    HEARTH_PROVIDER: "anthropic",
    HEARTH_MODEL: "",
    HEARTH_LOCAL_PASSWORD: "synthetic-local-password-0001",
    HEARTH_ORIGIN: "http://127.0.0.1:8099",
    HEARTH_ALLOWED_ENTITIES: "",
    HEARTH_ALLOWED_SERVICES: "",
    HEARTH_ACTIONS: "false",
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, values);
  const cfg = await loadConfig();
  assert.equal(cfg.provider, "anthropic");
  assert.equal(cfg.model, "claude-sonnet-5");
  assert.equal(cfg.thinkingLevel, "off");
  assert.deepEqual(cfg.policy.entities, []);
  assert.equal(cfg.policy.enabled, false);
});
