import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/config.js";
import { configuredModels, safeModels } from "../src/models.js";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { offline } from "./fixtures.js";

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
  try {
    const { models, provider, modelId } = configuredModels(config);
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
    assert.throws(
      () =>
        configuredModels({
          ...config,
          apiKey: "subscription-token-not-supported",
        }),
      /api_key_auth_required/,
    );
  } finally {
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
      Array.from({ length: 9 }, () =>
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
