import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  EndpointJudge,
  JUDGE_SYSTEM_PROMPT,
  JudgeSessions,
  RiskJudgeService,
  parseVerdict,
  resolveJudge,
  type JudgeAdapter,
  type JudgeInput,
} from "../src/judge.js";
import type { Action } from "../src/documents.js";

const action: Action = {
  kind: "service",
  domain: "climate",
  service: "set_temperature",
  target: { entity_id: ["climate.hall"] },
  data: { temperature: 20 },
};
const request = (owner = "owner", conversation = 1) => ({
  owner,
  conversation,
  request: "Set the hall to 20 degrees",
  action,
  level: "medium" as const,
});

test("judge model resolution: auto picks luna, then haiku, else off; explicit runtime/local/endpoint models; unknown → off with a warning", () => {
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
    endpoint: { url: "http://192.168.1.50:8080", apiKey: "" },
  });
  assert.equal(
    resolveJudge("auto", env(["openai-codex", "anthropic"])).model,
    "openai-codex/gpt-5.6-luna",
  );
  assert.equal(
    resolveJudge("auto", env(["anthropic"])).model,
    "anthropic/claude-haiku-4-5",
  );
  const none = resolveJudge("auto", env([]));
  assert.equal(none.model, "off");
  assert.equal(none.adapter, undefined);
  assert.equal(resolveJudge("off", env(["openai-codex"])).model, "off");
  // The private-network local endpoint provider used by src/local.ts.
  assert.equal(resolveJudge("local/qwen3-4b", env([])).model, "local/qwen3-4b");
  // Not signed in → off.
  const signedOut = resolveJudge("anthropic/claude-haiku-4-5", env([]));
  assert.equal(signedOut.model, "off");
  assert.match(signedOut.warning!, /unknown or not signed in/);
  const unknown = resolveJudge(
    "openai-codex/no-such-model",
    env(["openai-codex"]),
  );
  assert.equal(unknown.model, "off");
  assert.match(unknown.warning!, /judge is off/);
  const endpoint = resolveJudge("endpoint/qwen3-1.7b", env([]));
  assert.equal(endpoint.model, "endpoint/qwen3-1.7b");
  assert(endpoint.adapter instanceof EndpointJudge);
  const noUrl = resolveJudge("endpoint/qwen3-1.7b", {
    ...env([]),
    endpoint: { url: "", apiKey: "" },
  });
  assert.equal(noUrl.model, "off");
});

test("strict verdict parsing and the judge can only escalate, never lower", async () => {
  assert.deepEqual(
    parseVerdict('```json\n{"aligned":true,"reason":"ok"}\n```'),
    {
      aligned: true,
      reason: "ok",
    },
  );
  for (const raw of [
    "sure, looks fine",
    '{"aligned":"yes","reason":"x"}',
    '{"aligned":true,"reason":"x","approve":true}',
    '{"aligned":true,"reason":"x","escalate_to":"extreme"}',
    "[]",
  ])
    assert.throws(() => parseVerdict(raw), /judge_unparseable/);
  const fixed = (verdict: string): JudgeAdapter => ({
    id: "test/judge",
    classifyIntent: async () => parseVerdict(verdict),
  });
  const run = (verdict: string) =>
    new RiskJudgeService("test/judge", () => ({
      adapter: fixed(verdict),
      model: "test/judge",
    })).evaluate(request());
  assert.equal((await run('{"aligned":true,"reason":"ok"}')).verdict, "agreed");
  const lowered = await run(
    '{"aligned":true,"escalate_to":"low","reason":"fine"}',
  );
  assert.equal(lowered.verdict, "agreed");
  assert.equal(lowered.escalateTo, undefined);
  const up = await run('{"aligned":true,"escalate_to":"high","reason":"heat"}');
  assert.equal(up.verdict, "escalated");
  assert.equal(up.escalateTo, "high");
  const mis = await run(
    '{"aligned":false,"reason":"owner asked for the kitchen"}',
  );
  assert.equal(mis.verdict, "misaligned");
  assert.equal(mis.reason, "owner asked for the kitchen");
  assert.equal((await run("garbage")).verdict, "unavailable");
});

test("judge timeout, provider failure and judge off all fail closed to no agreement", async () => {
  const hang: JudgeAdapter = {
    id: "test/hang",
    classifyIntent: () => new Promise(() => {}),
  };
  const started = Date.now();
  const timedOut = await new RiskJudgeService(
    "test/hang",
    () => ({ adapter: hang, model: hang.id }),
    50,
  ).evaluate(request());
  assert.equal(timedOut.verdict, "unavailable");
  assert.match(timedOut.reason, /timed out/);
  assert(Date.now() - started < 2000);
  const failing: JudgeAdapter = {
    id: "test/fail",
    classifyIntent: async () => {
      throw new Error("provider exploded with sk-secret");
    },
  };
  const failed = await new RiskJudgeService("test/fail", () => ({
    adapter: failing,
    model: failing.id,
  })).evaluate(request());
  assert.equal(failed.verdict, "unavailable");
  assert.doesNotMatch(failed.reason, /sk-secret|exploded/);
  const off = await new RiskJudgeService("auto", () => ({
    model: "off",
    warning: "No judge model available",
  })).evaluate(request());
  assert.equal(off.verdict, "off");
});

test("judge sessions: reuse within TTL, fresh after TTL or cap, isolated by owner/conversation/model", async () => {
  let now = 1_000_000;
  const sessions = new JudgeSessions(300000, 3, 24000, () => now);
  const seen: JudgeInput[] = [];
  const adapter: JudgeAdapter = {
    id: "test/judge",
    classifyIntent: async (input) => {
      seen.push(input);
      return { aligned: true, reason: "ok" };
    },
  };
  const service = new RiskJudgeService(
    "test/judge",
    () => ({ adapter, model: adapter.id }),
    1000,
    (v) => v,
    sessions,
  );
  await service.evaluate(request());
  now += 60000;
  await service.evaluate(request());
  assert.equal(seen[1]!.sessionId, seen[0]!.sessionId, "reused within TTL");
  assert.equal(seen[1]!.history.length, 1, "history grows");
  assert.equal(sessions.peek("owner", 1, "test/judge")!.history.length, 2);
  now += 300001;
  await service.evaluate(request());
  assert.notEqual(seen[2]!.sessionId, seen[1]!.sessionId, "fresh after TTL");
  assert.equal(seen[2]!.history.length, 0);
  // Cap rollover after three exchanges.
  await service.evaluate(request());
  await service.evaluate(request());
  await service.evaluate(request());
  assert.equal(seen[4]!.sessionId, seen[2]!.sessionId);
  assert.equal(seen[4]!.history.length, 2);
  assert.notEqual(seen[5]!.sessionId, seen[2]!.sessionId);
  assert.equal(seen[5]!.history.length, 0);
  const capped = seen.slice(2).map((s) => s.sessionId);
  assert.equal(new Set(capped).size, 2, "rolled over at the cap");
  // Isolation.
  await service.evaluate(request("other", 1));
  await service.evaluate(request("owner", 2));
  const isolated = seen.slice(-2);
  for (const input of isolated) {
    assert.equal(input.history.length, 0);
    assert(!capped.includes(input.sessionId));
  }
  const otherModel: JudgeAdapter = { ...adapter, id: "test/other" };
  await new RiskJudgeService(
    "test/other",
    () => ({ adapter: otherModel, model: otherModel.id }),
    1000,
    (v) => v,
    sessions,
  ).evaluate(request());
  assert.equal(seen.at(-1)!.history.length, 0, "isolated by judge model");
  // History holds only the owner request, action JSON and the verdict.
  for (const exchange of sessions.peek("owner", 1, "test/judge")!.history) {
    assert.deepEqual(Object.keys(JSON.parse(exchange.user)).sort(), [
      "deterministic_level",
      "owner_request",
      "proposed_action",
    ]);
    assert.deepEqual(Object.keys(JSON.parse(exchange.assistant)).sort(), [
      "aligned",
      "reason",
    ]);
  }
});

test("Pi runtime judge: tool-less, byte-stable system prefix, prior exchanges, sessionId and short cache retention", async () => {
  const faux = fauxProvider({
    provider: "judge-faux",
    models: [{ id: "judge" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const contexts: unknown[] = [];
  const options: unknown[] = [];
  faux.setResponses(
    Array.from({ length: 2 }, () => (context: unknown, opts: unknown) => {
      contexts.push(context);
      options.push(opts);
      return fauxAssistantMessage('{"aligned":true,"reason":"matches"}');
    }),
  );
  const service = new RiskJudgeService("judge-faux/judge", () =>
    resolveJudge("judge-faux/judge", { models, signedIn: () => false }),
  );
  assert.equal((await service.evaluate(request())).verdict, "agreed");
  assert.equal((await service.evaluate(request())).verdict, "agreed");
  const [first, second] = contexts.map((c) => JSON.stringify(c));
  assert(first!.includes(JSON.stringify(JUDGE_SYSTEM_PROMPT).slice(1, 60)));
  assert.doesNotMatch(first!, /"tools":\[\{/);
  assert(second!.includes("matches"), "prior verdict replayed");
  const [o1, o2] = options as {
    sessionId: string;
    cacheRetention: string;
    maxTokens: number;
  }[];
  assert.equal(o1!.sessionId, o2!.sessionId);
  assert.equal(o1!.cacheRetention, "short");
  assert(o1!.maxTokens <= 400);
});

test("endpoint judge: private URL only, JSON schema with fallback, cache_prompt, timeout fails closed, key never leaks", async () => {
  const KEY = "synthetic-judge-key-0001";
  const bodies: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  let schemaSupported = false;
  const fetcher = (async (url: string, init: RequestInit) => {
    assert.equal(url, "http://192.168.1.50:8080/v1/chat/completions");
    assert.equal(init.redirect, "error");
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    headers.push(init.headers as Record<string, string>);
    if (body.response_format && !schemaSupported)
      return new Response("unsupported response_format", { status: 400 });
    return Response.json({
      choices: [
        {
          message: {
            content: '{"aligned":true,"escalate_to":"high","reason":"heat"}',
          },
        },
      ],
    });
  }) as unknown as typeof fetch;
  const resolve = async (host: string) =>
    host === "judge.lan" ? ["192.168.1.50"] : ["93.184.216.34"];
  const adapter = new EndpointJudge(
    "http://192.168.1.50:8080",
    KEY,
    "qwen3-1.7b",
    fetcher,
    resolve,
  );
  const service = new RiskJudgeService(
    "endpoint/qwen3-1.7b",
    () => ({ adapter, model: adapter.id }),
    1000,
    (v) => v.split(KEY).join("[REDACTED]"),
  );
  const record = await service.evaluate(request());
  assert.equal(record.verdict, "escalated");
  assert.equal(record.model, "endpoint/qwen3-1.7b");
  assert.doesNotMatch(JSON.stringify(record), new RegExp(KEY));
  assert.equal(bodies.length, 2, "schema attempt then plain JSON fallback");
  assert.equal(
    (bodies[0]!.response_format as { type: string }).type,
    "json_schema",
  );
  assert.equal(bodies[1]!.response_format, undefined);
  for (const body of bodies) {
    assert.equal(body.cache_prompt, true);
    assert.equal(body.max_tokens, 60);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.tools, undefined);
    const messages = body.messages as { role: string; content: string }[];
    assert.equal(messages[0]!.content, JUDGE_SYSTEM_PROMPT);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(KEY));
  }
  assert.equal(headers[0]!.Authorization, `Bearer ${KEY}`);
  // Second call reuses the session: history + no schema retry.
  await service.evaluate(request());
  assert.equal(bodies.length, 3);
  assert.equal((bodies[2]!.messages as unknown[]).length, 4);
  // URL policy: public, supervisor and metadata addresses are refused per call.
  for (const url of [
    "http://93.184.216.34:8080",
    "http://supervisor:8080",
    "http://169.254.169.254",
    "http://172.30.32.2:8080",
    "http://public.example:8080",
  ]) {
    const bad = new EndpointJudge(url, KEY, "m", fetcher, resolve);
    const r = await new RiskJudgeService("endpoint/m", () => ({
      adapter: bad,
      model: bad.id,
    })).evaluate(request());
    assert.equal(r.verdict, "unavailable", url);
  }
  assert.equal(bodies.length, 3, "refused before any request");
  const slow = new EndpointJudge(
    "http://judge.lan:8080",
    KEY,
    "m",
    ((_u: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal!.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      )) as unknown as typeof fetch,
    resolve,
  );
  const slowRecord = await new RiskJudgeService(
    "endpoint/m",
    () => ({ adapter: slow, model: slow.id }),
    50,
  ).evaluate(request());
  assert.equal(slowRecord.verdict, "unavailable");
  assert.match(slowRecord.reason, /timed out/);
});

test("judge history replays at most the last 4 exchanges of this judge session", async () => {
  const seen: JudgeInput[] = [];
  const adapter: JudgeAdapter = {
    id: "test/judge",
    classifyIntent: async (input) => {
      seen.push(input);
      return { aligned: true, reason: "ok" };
    },
  };
  const service = new RiskJudgeService(
    "test/judge",
    () => ({ adapter, model: adapter.id }),
    1000,
    (v) => v,
    new JudgeSessions(300000, 12),
  );
  for (let i = 0; i < 8; i++)
    await service.evaluate({ ...request(), request: `request ${i}` });
  assert.equal(seen.at(-1)!.history.length, 4);
  assert.match(seen.at(-1)!.history[0]!.user, /request 3/);
  assert.equal(new Set(seen.map((s) => s.sessionId)).size, 1);
});

test("the judge sees only the text of a message with attached images", async () => {
  const { requestText } = await import("../src/home-actions.js");
  const content = [
    { type: "text", text: "Turn on the study lamp" },
    { type: "image", data: "IMAGE-DATA-CANARY", mimeType: "image/jpeg" },
  ];
  assert.equal(requestText(content), "Turn on the study lamp");
  assert.equal(requestText("plain words"), "plain words");
  assert.equal(
    requestText([{ type: "image", data: "x", mimeType: "image/png" }]),
    "",
  );
  assert.equal(requestText(undefined), "");
  assert.doesNotMatch(JSON.stringify(requestText(content)), /CANARY/);
});

test("endpoint judge drops chat_template_kwargs once for a server that rejects it", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    if (body.response_format || body.chat_template_kwargs)
      return new Response("unsupported", { status: 400 });
    return Response.json({
      choices: [
        { message: { content: '{"aligned":false,"reason":"other target"}' } },
      ],
    });
  }) as unknown as typeof fetch;
  const adapter = new EndpointJudge(
    "http://192.168.1.50:8080",
    "",
    "m",
    fetcher,
    async () => ["192.168.1.50"],
  );
  const service = new RiskJudgeService(
    "endpoint/m",
    () => ({ adapter, model: adapter.id }),
    1000,
    (v) => v,
  );
  const first = await service.evaluate(request());
  assert.equal(first.verdict, "misaligned");
  assert.equal(bodies.length, 3, "schema+kwargs, kwargs only, then plain");
  assert.equal(bodies[2]!.chat_template_kwargs, undefined);
  bodies.length = 0;
  await service.evaluate(request());
  assert.equal(bodies.length, 1, "remembers what the server supports");
});
