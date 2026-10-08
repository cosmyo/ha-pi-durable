import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/config.js";
import {
  configuredModels,
  providerFailure,
  safeModels,
  type CredentialRefreshers,
} from "../src/models.js";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessageEvent, Model, Api } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { offline } from "./fixtures.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PrivateCredentials, Subscription } from "../src/subscription.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * A minimal scripted `Models.streamSimple`, one event array per call, so
 * tests can reproduce a real provider's exact event order for a 401: the
 * error is that request's first and only event, with no preceding `start`.
 */
function scriptedModels(scripts: readonly AssistantMessageEvent[][]) {
  let calls = 0;
  const models = {
    streamSimple: () => {
      const events = scripts[calls] ?? scripts[scripts.length - 1]!;
      calls++;
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  } as unknown as Models;
  return { models, calls: () => calls };
}
const scriptedModel = { provider: "openai-codex", id: "test" } as Model<Api>;
const unauthorized = (errorMessage: string): AssistantMessageEvent => ({
  type: "error",
  reason: "error",
  error: fauxAssistantMessage("", { stopReason: "error", errorMessage }),
});
function fakeRefresher(result: boolean | Promise<boolean>) {
  let calls = 0;
  return {
    calls: () => calls,
    forceRefresh: async () => {
      calls++;
      return result;
    },
  };
}

const apiKey = "sk-synthetic-fixture-key-not-a-credential";
test("real pinned OpenAI API-key Responses adapter: fake HTTP, official origin, no store, secret-free output/errors", async () => {
  const previous = process.env.OPENAI_API_KEY;
  const config = {
    provider: "openai",
    model: "gpt-4.1-mini",
    apiKey,
    haToken: "synthetic-supervisor-token",
    password: "synthetic-browser-password",
  } as Config;
  const dir = await mkdtemp(join(tmpdir(), "hearth-models-"));
  try {
    const native = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
      credentials: new PrivateCredentials(join(dir, "auth.json")),
    });
    const { models, provider, modelId } = await configuredModels(
      config,
      native,
      [apiKey, config.haToken, config.password],
    );
    const model = models.getModel(provider, modelId)!;
    assert(model);
    const item = {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: `Synthetic reply ${apiKey}`,
          annotations: [],
        },
      ],
    };
    const events = [
      {
        type: "response.created",
        response: { id: "resp_fixture", status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: `Synthetic reply ${apiKey}`,
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_fixture",
          status: "completed",
          output: [item],
          usage: {
            input_tokens: 4,
            output_tokens: 3,
            total_tokens: 7,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ];
    let calls = 0;
    const transport = (async (url, init) => {
      calls++;
      assert.equal(String(url), "https://api.openai.com/v1/responses");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${apiKey}`,
      );
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.store, false);
      assert.equal(payload.max_output_tokens, 2048);
      assert(!JSON.stringify(payload).includes(apiKey));
      return new Response(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;
    const reply = await models
      .streamSimple(
        model,
        {
          messages: [
            { role: "user", content: "Synthetic question", timestamp: 0 },
          ],
        },
        { fetch: transport, maxRetries: 0 },
      )
      .result();
    assert.equal(reply.stopReason, "stop");
    assert.match(JSON.stringify(reply), /Synthetic reply/);
    assert.doesNotMatch(JSON.stringify(reply), /sk-synthetic/);
    assert.equal(calls, 1);
    const errorReply = await models
      .streamSimple(
        model,
        {
          messages: [
            { role: "user", content: "Synthetic question", timestamp: 0 },
          ],
        },
        {
          fetch: (async () =>
            Response.json(
              { error: { message: apiKey } },
              { status: 401 },
            )) as typeof fetch,
          maxRetries: 0,
        },
      )
      .result();
    assert.equal(errorReply.stopReason, "error");
    assert.doesNotMatch(JSON.stringify(errorReply), /sk-synthetic/);
    await assert.rejects(
      configuredModels(
        {
          ...config,
          apiKey: "subscription-token-not-supported",
        },
        native,
        [],
      ),
      /api_key_auth_required/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
test("bounded models refuse nine model turns, excessive tool calls and oversized partials", async () => {
  const { faux, models, model } = offline();
  const guarded = safeModels(models, ["synthetic-secret"]);
  const selected = models.getModel(model.provider, model.modelId)!;
  const messages = [
    { role: "user" as const, content: "Question", timestamp: 0 },
    ...Array.from({ length: 8 }, () => fauxAssistantMessage("tool round")),
  ];
  assert.equal(
    (await guarded.streamSimple(selected, { messages }).result()).stopReason,
    "error",
  );
  assert.equal(faux.state.callCount, 0);
  faux.setResponses([
    fauxAssistantMessage(
      Array.from({ length: 17 }, () =>
        fauxToolCall("ha_state_detail", { entityId: "light.example" }),
      ),
      { stopReason: "toolUse" },
    ),
  ]);
  assert.equal(
    (
      await guarded
        .streamSimple(selected, { messages: messages.slice(0, 1) })
        .result()
    ).stopReason,
    "error",
  );
  faux.setResponses([fauxAssistantMessage("a".repeat(140000))]);
  assert.equal(
    (
      await guarded
        .streamSimple(selected, { messages: messages.slice(0, 1) })
        .result()
    ).stopReason,
    "error",
  );
});

test("provider failures become fixed owner-actionable reasons, never raw provider text", async () => {
  const canary = "synthetic-canary-token-value";
  const cases: [string, RegExp][] = [
    [
      "Your authentication token has expired. Please try refreshing it.",
      /sign in again/,
    ],
    [`401 Unauthorized: bearer ${canary}`, /sign in again/],
    ["429 Too Many Requests", /usage limit/],
    ["You've hit your usage limit", /usage limit/],
    ["403 Forbidden", /plan and the selected model/],
    ["The model `x` does not exist", /Choose another model/],
    [`socket hang up ${canary}`, /check server configuration/],
    ["", /check server configuration/],
  ];
  for (const [raw, expected] of cases) {
    const reason = providerFailure(raw);
    assert.match(reason, expected);
    assert(!reason.includes(canary));
  }
  assert.match(providerFailure(undefined), /check server configuration/);
  // Through the real guarded stream: committed errors carry only the fixed reason.
  const { faux, models, model } = offline();
  const guarded = safeModels(models, []);
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: `Your authentication token has expired. ${canary}`,
    }),
  ]);
  const reply = await guarded
    .streamSimple(models.getModel(model.provider, model.modelId)!, {
      messages: [{ role: "user", content: "Question", timestamp: 0 }],
    })
    .result();
  assert.equal(reply.stopReason, "error");
  assert.match(reply.errorMessage ?? "", /sign in again/);
  assert.doesNotMatch(JSON.stringify(reply), new RegExp(canary));
});

test("a 401 refreshes once and retries the provider request once, before any event of the turn reaches the caller", async () => {
  const canary = "synthetic-401-canary-token";
  const { models, calls } = scriptedModels([
    [unauthorized(`401 Unauthorized: bearer ${canary}`)],
    [
      { type: "start", partial: fauxAssistantMessage("") },
      {
        type: "done",
        reason: "stop",
        message: fauxAssistantMessage("Retried reply"),
      },
    ],
  ]);
  const refresher = fakeRefresher(true);
  const refreshers: CredentialRefreshers = new Map([
    ["openai-codex", refresher],
  ]);
  const guarded = safeModels(models, [canary], refreshers);
  const reply = await guarded
    .streamSimple(scriptedModel, {
      messages: [{ role: "user", content: "Question", timestamp: 0 }],
    })
    .result();
  assert.equal(reply.stopReason, "stop");
  assert.match(JSON.stringify(reply), /Retried reply/);
  assert.equal(calls(), 2, "original request plus exactly one retry");
  assert.equal(refresher.calls(), 1);
  assert.doesNotMatch(JSON.stringify(reply), new RegExp(canary));
});

test("a 401 whose refresh fails (revoked) falls back to the existing sign-in-again failure, with no retry", async () => {
  const { models, calls } = scriptedModels([
    [unauthorized("401 Unauthorized")],
  ]);
  const refresher = fakeRefresher(false);
  const refreshers: CredentialRefreshers = new Map([
    ["openai-codex", refresher],
  ]);
  const guarded = safeModels(models, [], refreshers);
  const reply = await guarded
    .streamSimple(scriptedModel, {
      messages: [{ role: "user", content: "Question", timestamp: 0 }],
    })
    .result();
  assert.equal(reply.stopReason, "error");
  assert.match(reply.errorMessage ?? "", /sign in again/);
  assert.equal(
    calls(),
    1,
    "refresh failed, so the provider request is not retried",
  );
  assert.equal(refresher.calls(), 1);
});

test("a 401 that persists after a successful refresh fails once, never loops", async () => {
  const { models, calls } = scriptedModels([
    [unauthorized("401 Unauthorized")],
    [unauthorized("401 Unauthorized")],
  ]);
  const refresher = fakeRefresher(true);
  const refreshers: CredentialRefreshers = new Map([
    ["openai-codex", refresher],
  ]);
  const guarded = safeModels(models, [], refreshers);
  const reply = await guarded
    .streamSimple(scriptedModel, {
      messages: [{ role: "user", content: "Question", timestamp: 0 }],
    })
    .result();
  assert.equal(reply.stopReason, "error");
  assert.match(reply.errorMessage ?? "", /sign in again/);
  assert.equal(calls(), 2, "retried exactly once, not repeatedly");
  assert.equal(
    refresher.calls(),
    1,
    "single refresh attempt even though the retry also failed",
  );
});

test("a 401 with no wired credential refresher (e.g. an API-key provider) is classified as today, with no retry", async () => {
  const { models, calls } = scriptedModels([
    [unauthorized("401 Unauthorized")],
  ]);
  const guarded = safeModels(models, []);
  const reply = await guarded
    .streamSimple(scriptedModel, {
      messages: [{ role: "user", content: "Question", timestamp: 0 }],
    })
    .result();
  assert.equal(reply.stopReason, "error");
  assert.match(reply.errorMessage ?? "", /sign in again/);
  assert.equal(calls(), 1);
});

test("proactive refresh: a near-expiry ChatGPT/Codex token is rotated before the model request, not after a 401", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-proactive-refresh-"));
  const previous = globalThis.fetch;
  const token = (n: string) =>
    `eyJhbGciOiJub25lIn0.${Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "synthetic-account",
        },
      }),
    ).toString("base64url")}.${n}`;
  const oldAccess = token("synthetic-old-access-canary");
  const newAccess = token("synthetic-rotated-access-canary");
  let refreshes = 0,
    modelCalls = 0,
    seenAuthorization = "";
  const item = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      { type: "output_text", text: "Synthetic Codex reply", annotations: [] },
    ],
  };
  const sseEvents = [
    {
      type: "response.created",
      response: { id: "resp_fixture", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "Synthetic Codex reply",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_fixture",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 4,
          output_tokens: 3,
          total_tokens: 7,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];
  globalThis.fetch = (async (url, init) => {
    const target = String(url);
    if (target === "https://auth.openai.com/oauth/token") {
      refreshes++;
      assert.match(String(init?.body), /grant_type=refresh_token/);
      return Response.json({
        access_token: newAccess,
        refresh_token: "synthetic-rotated-refresh",
        expires_in: 3600,
      });
    }
    if (target.endsWith("/codex/responses")) {
      modelCalls++;
      seenAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(
        sseEvents
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    throw new Error(`Unexpected synthetic fetch target: ${target}`);
  }) as typeof fetch;
  try {
    const store = new PrivateCredentials(join(dir, "chatgpt-oauth.json"));
    await store.modify("openai-codex", async () => ({
      type: "oauth",
      access: oldAccess,
      refresh: "synthetic-old-refresh",
      // Under the five-minute proactive-refresh window.
      expires: Date.now() + 60000,
      accountId: "synthetic-account",
    }));
    const {
      subscriptions,
      runtime: native,
      secrets,
    } = await Subscription.openProviders(dir, [], ["openai-codex"]);
    const { models, provider, modelId } = await configuredModels(
      { provider: "openai-codex", model: "gpt-5.5" } as Config,
      native,
      secrets,
      subscriptions,
    );
    const model = models.getModel(provider, modelId)!;
    const reply = await models
      .streamSimple(model, {
        messages: [{ role: "user", content: "Hi", timestamp: 0 }],
      })
      .result();
    assert.equal(reply.stopReason, "stop");
    assert.match(JSON.stringify(reply), /Synthetic Codex reply/);
    assert.equal(
      refreshes,
      1,
      "token refreshed exactly once before the model call",
    );
    assert.equal(modelCalls, 1, "no 401 occurred, so no retry was needed");
    assert.equal(seenAuthorization, `Bearer ${newAccess}`);
    assert.doesNotMatch(JSON.stringify(reply), new RegExp(oldAccess));
  } finally {
    globalThis.fetch = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("attached image data does not count against the text context budget", async () => {
  const { contextBytes, imageBytes, CONTEXT_LIMITS } = await import(
    "../src/models.js"
  );
  const photo = "A".repeat(600000);
  const transcript = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Set up my home view from this plan" },
          { type: "image", data: photo, mimeType: "image/jpeg" },
        ],
        timestamp: 0,
      },
    ],
  };
  assert.ok(contextBytes(transcript) < 1000);
  assert.equal(imageBytes(transcript), photo.length);
  assert.ok(imageBytes(transcript) < CONTEXT_LIMITS.imageBytes);
  const { faux, models, model } = offline();
  const guarded = safeModels(models, ["synthetic-secret"]);
  const selected = models.getModel(model.provider, model.modelId)!;
  faux.setResponses([fauxAssistantMessage("I can see the plan.")]);
  const result = await guarded
    .streamSimple(selected, transcript as never)
    .result();
  assert.notEqual(result.stopReason, "error");
  // Images beyond the per-request backstop still stop the request.
  const huge = {
    messages: [
      {
        role: "user",
        content: Array.from({ length: 5 }, () => ({
          type: "image",
          data: "B".repeat(4 * 1024 * 1024),
          mimeType: "image/jpeg",
        })),
        timestamp: 0,
      },
    ],
  };
  const stopped = await guarded.streamSimple(selected, huge as never).result();
  assert.equal(stopped.stopReason, "error");
  assert.match(String(stopped.errorMessage), /too many or too large images/);
});
