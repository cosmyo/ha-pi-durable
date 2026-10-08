import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  BRIEFING_SUMMARY_SYSTEM_PROMPT,
  BriefingSummaryService,
  PiRuntimeBriefingSummarizer,
  briefingSummaryUserMessage,
  resolveBriefingSummaryModel,
  sanitizeSummary,
} from "../src/briefing-summary.js";
import type {
  BriefingSummarizer,
  BriefingSummaryRequest,
} from "../src/proactive.js";

const values: BriefingSummaryRequest["values"] = [
  {
    entityId: "sensor.example_temp",
    label: "Study",
    state: "21",
    unit: "\u00b0C",
    available: true,
    reason: "",
    observedAt: 1000,
  },
  {
    entityId: "light.example_lamp",
    label: "Lamp",
    state: "",
    unit: "",
    available: false,
    reason: "unavailable",
    observedAt: 2000,
  },
];
const req = (
  signal = new AbortController().signal,
): BriefingSummaryRequest => ({
  title: "Morning briefing",
  values,
  signal,
});

test("resolveBriefingSummaryModel: auto picks luna, then haiku, else off; explicit model; signed-out/unknown model -> off", () => {
  const registered = new Set([
    "openai-codex/gpt-5.6-luna",
    "anthropic/claude-haiku-4-5",
    "local/qwen3-4b",
  ]);
  const models = {
    getModel: (p: string, id: string) =>
      registered.has(`${p}/${id}`) ? ({ id, provider: p } as never) : undefined,
    completeSimple: async () => {
      throw new Error("not called");
    },
  };
  const env = (signed: string[]) => ({
    models,
    signedIn: (p: string) => signed.includes(p),
  });
  assert.equal(
    resolveBriefingSummaryModel("auto", env(["openai-codex", "anthropic"]))
      .model,
    "openai-codex/gpt-5.6-luna",
  );
  assert.equal(
    resolveBriefingSummaryModel("auto", env(["anthropic"])).model,
    "anthropic/claude-haiku-4-5",
  );
  const none = resolveBriefingSummaryModel("auto", env([]));
  assert.equal(none.model, "off");
  assert.equal(none.summarizer, undefined);
  assert.equal(
    resolveBriefingSummaryModel("off", env(["openai-codex"])).model,
    "off",
  );
  assert.equal(
    resolveBriefingSummaryModel("local/qwen3-4b", env([])).model,
    "local/qwen3-4b",
  );
  // Not signed in to the overriding subscription provider -> off.
  assert.equal(
    resolveBriefingSummaryModel("anthropic/claude-haiku-4-5", env([])).model,
    "off",
  );
  assert.equal(
    resolveBriefingSummaryModel(
      "openai-codex/no-such-model",
      env(["openai-codex"]),
    ).model,
    "off",
  );
});

test("briefingSummaryUserMessage: only title and the exact given values, as plain JSON data", () => {
  const message = briefingSummaryUserMessage(req());
  const parsed = JSON.parse(message);
  assert.deepEqual(Object.keys(parsed).sort(), ["title", "values"]);
  assert.equal(parsed.title, "Morning briefing");
  assert.deepEqual(parsed.values, [
    {
      label: "Study",
      entity_id: "sensor.example_temp",
      state: "21",
      unit: "\u00b0C",
      available: true,
      reason: "",
      read_at: 1000,
    },
    {
      label: "Lamp",
      entity_id: "light.example_lamp",
      state: "",
      unit: "",
      available: false,
      reason: "unavailable",
      read_at: 2000,
    },
  ]);
  // An unavailable value's state is never sent, even if the caller had one.
  const withGhostState = briefingSummaryUserMessage({
    title: "x",
    values: [{ ...values[1]!, state: "should not be sent" }],
  });
  assert.equal(JSON.parse(withGhostState).values[0].state, "");
  // At most 12 values, each field bounded.
  const many = briefingSummaryUserMessage({
    title: "x".repeat(500),
    values: Array.from({ length: 20 }, (_, i) => ({
      ...values[0]!,
      entityId: `e${i}`,
    })),
  });
  const parsedMany = JSON.parse(many);
  assert.equal(parsedMany.values.length, 12);
  assert(parsedMany.title.length <= 200);
});

test("sanitizeSummary: plain text only, one paragraph, hard length cap", () => {
  assert.equal(sanitizeSummary("Hello\nworld"), "Hello world");
  assert.equal(
    sanitizeSummary('```json\n{"x":1}\n``` plain text'),
    "plain text",
  );
  assert.equal(sanitizeSummary("<img src=x onerror=alert(1)>text"), "text");
  assert.equal(sanitizeSummary("a".repeat(1000)).length, 400);
  assert.equal(sanitizeSummary("  spaced   out  "), "spaced out");
});

test("Pi runtime briefing summarizer: tool-less, byte-stable system prompt, sanitizes and caps output", async () => {
  const faux = fauxProvider({
    provider: "summary-faux",
    models: [{ id: "model" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const contexts: unknown[] = [];
  const options: unknown[] = [];
  faux.setResponses([
    (context: unknown, opts: unknown) => {
      contexts.push(context);
      options.push(opts);
      return fauxAssistantMessage(
        `The study is 21\u00b0C and the lamp's reading is unavailable. ${"x".repeat(500)}`,
      );
    },
  ]);
  const summarizer = new PiRuntimeBriefingSummarizer(
    models,
    "summary-faux",
    "model",
  );
  const result = await summarizer.summarize(req());
  assert.equal(result.model, "summary-faux/model");
  assert(result.text.length <= 400);
  assert.match(
    result.text,
    /^The study is 21.C and the lamp's reading is unavailable\./,
  );
  assert(typeof result.latencyMs === "number" && result.latencyMs >= 0);
  const [context] = contexts.map((c) => JSON.stringify(c));
  assert(
    context!.includes(
      JSON.stringify(BRIEFING_SUMMARY_SYSTEM_PROMPT).slice(1, 60),
    ),
  );
  assert.doesNotMatch(context!, /"tools":\[\{/);
  const [o] = options as {
    cacheRetention: string;
    maxTokens: number;
    transport: string;
  }[];
  assert.equal(o!.cacheRetention, "short");
  assert.equal(o!.transport, "sse");
  assert(o!.maxTokens <= 600);
});

test("Pi runtime briefing summarizer: a missing model, an aborted/error reply and a thrown transport error all fail to an empty-text result", async () => {
  const faux = fauxProvider({
    provider: "summary-faux2",
    models: [{ id: "model" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const missing = new PiRuntimeBriefingSummarizer(
    models,
    "summary-faux2",
    "no-such-model",
  );
  const r1 = await missing.summarize(req());
  assert.equal(r1.text, "");
  assert.equal(r1.model, "summary-faux2/no-such-model");
  assert.equal(r1.latencyMs, 0);

  faux.setResponses([
    () =>
      fauxAssistantMessage("never seen", {
        stopReason: "error",
        errorMessage: "boom",
      }),
  ]);
  const errored = new PiRuntimeBriefingSummarizer(
    models,
    "summary-faux2",
    "model",
  );
  const r3 = await errored.summarize(req());
  assert.equal(r3.text, "");

  faux.setResponses([
    () => {
      throw new Error("transport exploded with sk-secret-leak");
    },
  ]);
  const thrown = new PiRuntimeBriefingSummarizer(
    models,
    "summary-faux2",
    "model",
  );
  const r4 = await thrown.summarize(req());
  assert.equal(r4.text, "");
  assert.doesNotMatch(JSON.stringify(r4), /sk-secret-leak/);
});

test("BriefingSummaryService: a hung adapter (ignoring the abort signal) still fails closed on its own fixed timeout", async () => {
  const hung: BriefingSummarizer = { summarize: () => new Promise(() => {}) };
  const service = new BriefingSummaryService(
    "test/hang",
    () => ({ summarizer: hung, model: "test/hang" }),
    30,
  );
  const started = Date.now();
  const result = await service.summarize(req());
  assert.equal(result.text, "");
  assert.equal(result.model, "test/hang");
  assert(Date.now() - started < 2000, "fails closed quickly on timeout");

  // A cooperative adapter is handed the service's combined abort signal (its
  // own request.signal plus the deadline), not the caller's bare signal.
  let seenSignal: AbortSignal | undefined;
  const cooperative: BriefingSummarizer = {
    summarize: async (request) => {
      seenSignal = request.signal;
      return { text: "ok", model: "test/model", latencyMs: 5 };
    },
  };
  const ok = new BriefingSummaryService("test/model", () => ({
    summarizer: cooperative,
    model: "test/model",
  }));
  const okResult = await ok.summarize(req());
  assert.equal(okResult.text, "ok");
  assert.notEqual(seenSignal, undefined);
});

test("BriefingSummaryService: off/unresolved/failing summarizers never throw and always carry a model id", async () => {
  const off = new BriefingSummaryService("off", () => ({ model: "off" }));
  assert.deepEqual(await off.summarize(req()), {
    text: "",
    model: "off",
    latencyMs: 0,
  });
  assert.deepEqual(off.describe(), { setting: "off", model: "off" });
  const throwing: BriefingSummarizer = {
    summarize: async () => {
      throw new Error("boom");
    },
  };
  const broken = new BriefingSummaryService("auto", () => ({
    summarizer: throwing,
    model: "test/model",
  }));
  const result = await broken.summarize(req());
  assert.equal(result.text, "");
  assert.equal(result.model, "test/model");
});
