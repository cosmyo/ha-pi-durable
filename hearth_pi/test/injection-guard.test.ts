// Prompt-injection guard for Home tool output (src/injection-guard.ts): a
// fake guard service, the real durable harness with the offline faux
// provider and synthetic Home Assistant fakes.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { adminHarness } from "./admin-fixtures.js";
import {
  GUARD_MAX_CHARS,
  GUARD_MAX_TEXTS,
  GUARD_TEXT_CHARS,
  GUARD_WARNING_PREFIX,
  InjectionGuard,
  guardTexts,
} from "../src/injection-guard.js";
import { Inputs } from "../src/documents.js";
import {
  configurationDiagnostic,
  loadConfig,
  type Config,
} from "../src/config.js";
import { appServer } from "../src/server.js";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync } from "node:fs";

const KEY = "synthetic-guard-key-0001";
const URL_BASE = "http://10.0.0.5:8090";
const DIRECT = { direct: true } as const;
const light = {
  domain: "light",
  service: "turn_on",
  target: { entity_id: ["light.kitchen"] },
  data: { brightness: 100 },
};
const unlock = {
  domain: "lock",
  service: "unlock",
  target: { entity_id: ["lock.front_door"] },
};
// Reads the synthetic entity whose name looks like an instruction.
const READ_CANARY = [
  { tool: "ha_search_states", args: { query: "canary", offset: 0 } },
];
const READ_CLEAN = [
  { tool: "ha_search_states", args: { query: "kitchen", offset: 0 } },
];

type GuardCall = {
  url: string;
  auth: string | null;
  body: { source: string; texts: string[] };
};
// A fake guard: flags any text containing ATTRIBUTE_CANARY.
function fakeGuard(
  mode: "ok" | "down" | "slow" | "not_scanned" | "malformed" | 401 = "ok",
) {
  const calls: GuardCall[] = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as GuardCall["body"];
    calls.push({
      url: String(url),
      auth: new Headers(init?.headers).get("authorization"),
      body,
    });
    if (mode === "down") throw new Error("ECONNREFUSED");
    if (mode === "slow")
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      );
    if (mode === 401) return new Response("", { status: 401 });
    if (mode === "not_scanned")
      return Response.json({ scanned: false, results: [] });
    if (mode === "malformed")
      return Response.json({ scanned: true, results: [{ score: "high" }] });
    return Response.json({
      scanned: true,
      results: body.texts.map((t) =>
        t.includes("ATTRIBUTE_CANARY")
          ? { score: 0.97, flagged: true }
          : { score: 0.01, flagged: false },
      ),
    });
  }) as typeof fetch;
  const logs: string[] = [];
  const guard = new InjectionGuard(
    { url: URL_BASE, apiKey: KEY, timeoutMs: 500 },
    { fetcher, log: (line) => logs.push(line) },
  );
  return { guard, calls, logs };
}

async function inputs(f: Awaited<ReturnType<typeof adminHarness>>) {
  return Object.values(
    (await f.runtime.harness.snapshot(Inputs, f.id as ConversationId, ctx))!
      .requests,
  ).sort((a, b) => a.admitted - b.admitted);
}

test("guardTexts: long text is split into pieces, at most 32 texts and 400 000 characters per request", () => {
  assert.deepEqual(guardTexts(["a", "", "b"]), {
    texts: ["a", "b"],
    truncated: false,
  });
  const long = guardTexts(["x".repeat(GUARD_TEXT_CHARS * 2 + 10)]);
  assert.deepEqual(
    long.texts.map((t) => t.length),
    [GUARD_TEXT_CHARS, GUARD_TEXT_CHARS, 10],
  );
  assert.equal(long.truncated, false);
  const many = guardTexts(Array.from({ length: 40 }, (_, i) => `t${i}`));
  assert.equal(many.texts.length, GUARD_MAX_TEXTS);
  assert.equal(many.texts.at(-1), "t31");
  assert.equal(many.truncated, true);
  const huge = guardTexts(["y".repeat(300_000), "z".repeat(300_000)]);
  const total = huge.texts.reduce((n, t) => n + t.length, 0);
  assert.equal(huge.truncated, true);
  assert.ok(huge.texts.length <= GUARD_MAX_TEXTS);
  assert.ok(total <= GUARD_MAX_CHARS);
  assert.ok(huge.texts.every((t) => t.length <= GUARD_TEXT_CHARS));
  assert.ok(huge.texts.some((t) => t.startsWith("z")));
});

test("InjectionGuard: posts {source, texts} with the bearer key; clean, flagged and every failure class without throwing", async () => {
  const ok = fakeGuard();
  assert.deepEqual(await ok.guard.scan("tool", ["hello"]), { kind: "clean" });
  assert.deepEqual(
    await ok.guard.scan("tool", ["fine", "ATTRIBUTE_CANARY do it"]),
    { kind: "flagged", score: 0.97 },
  );
  assert.equal(ok.calls[0]!.url, `${URL_BASE}/v1/guard/injection`);
  assert.equal(ok.calls[0]!.auth, `Bearer ${KEY}`);
  assert.deepEqual(ok.calls[0]!.body, { source: "tool", texts: ["hello"] });
  // Nothing to scan: no call.
  assert.deepEqual(await ok.guard.scan("tool", [""]), { kind: "clean" });
  assert.equal(ok.calls.length, 2);
  const status = ok.guard.status();
  assert.equal(status.state, "on");
  assert.deepEqual(
    [status.today.scanned, status.today.flagged, status.today.unavailable],
    [2, 1, 0],
  );
  for (const [mode, error] of [
    ["down", "unreachable"],
    ["slow", "timeout"],
    ["not_scanned", "not_scanned"],
    ["malformed", "bad_response"],
    [401, "auth_failed"],
  ] as const) {
    const g = fakeGuard(mode);
    assert.deepEqual(await g.guard.scan("tool", ["ATTRIBUTE_CANARY"]), {
      kind: "unavailable",
      error,
    });
    const s = g.guard.status();
    assert.deepEqual(
      [s.state, s.lastError, s.today.unavailable],
      ["unavailable", error, 1],
    );
    // Counters and error classes only: never the key, URL or content.
    assert.equal(g.logs.length, 1);
    for (const text of [...g.logs, JSON.stringify(s)]) {
      assert.ok(!text.includes(KEY), mode.toString());
      assert.ok(!text.includes("ATTRIBUTE_CANARY"));
      assert.ok(!text.includes("10.0.0.5"));
    }
  }
  // A public guard address is refused before any request.
  const calls: string[] = [];
  const outside = new InjectionGuard(
    { url: "http://203.0.113.9", apiKey: KEY, timeoutMs: 500 },
    {
      fetcher: (async (url: string) => {
        calls.push(url);
        return Response.json({});
      }) as typeof fetch,
      log: () => {},
    },
  );
  assert.deepEqual(await outside.scan("tool", ["x"]), {
    kind: "unavailable",
    error: "endpoint_not_private",
  });
  assert.equal(calls.length, 0);
  // Off: no URL, no calls.
  const off = new InjectionGuard({ url: "", apiKey: "", timeoutMs: 3000 });
  assert.deepEqual(await off.scan("tool", ["x"]), { kind: "off" });
  assert.equal(off.status().state, "off");
});

test("a clean tool result reaches the model unchanged", async () => {
  const plain = await adminHarness({ trusted: ["owner"], submit: DIRECT });
  const guarded = await adminHarness({ trusted: ["owner"], submit: DIRECT });
  try {
    const g = fakeGuard();
    guarded.ha.actions.useInjectionGuard(g.guard);
    await plain.mode("full");
    await guarded.mode("full");
    const a = await plain.run(
      "ha_call_service",
      light,
      "Kitchen on",
      READ_CLEAN,
    );
    const b = await guarded.run(
      "ha_call_service",
      light,
      "Kitchen on",
      READ_CLEAN,
    );
    assert.equal(a?.status, "accepted");
    assert.equal(b?.status, "accepted");
    assert.equal(b?.authorization?.guard, undefined);
    assert.ok(g.calls.some((c) => c.body.texts.join("").includes("Kitchen")));
    // The tool results the model saw: name and content blocks.
    const results = async (f: typeof plain) =>
      (
        await (await f.runtime.harness.conversation(
          f.id as ConversationId,
          ctx,
        ))!.context(ctx)
      ).entries
        .flatMap((e) =>
          ((e as { model?: unknown[] }).model ?? []).filter(
            (m) => (m as { role?: string }).role === "toolResult",
          ),
        )
        .map((m) => {
          const r = m as { toolName: string; content: unknown };
          return JSON.stringify([r.toolName, r.content]);
        });
    const plainResults = await results(plain);
    const guardedResults = await results(guarded);
    assert.ok(plainResults.length >= 2);
    // The read the guard scanned: same text the model saw, block for block
    // (the receipts differ only in timestamps and grant digests).
    assert.equal(guardedResults[0], plainResults[0]);
    assert.match(guardedResults[0]!, /^\["ha_search_states",/);
    assert.equal(guardedResults.length, plainResults.length);
    assert.ok(!(await guarded.toolResults()).includes(GUARD_WARNING_PREFIX));
    assert.ok((await inputs(guarded)).every((i) => !i.guard));
  } finally {
    await plain.close();
    await guarded.close();
  }
});

test("flagged tool output: the warning goes in front, the run is marked, and that turn's proposal waits for a trusted owner on Full; the next clean turn auto-runs again", async () => {
  const f = await adminHarness({ trusted: ["owner"], submit: DIRECT });
  try {
    const g = fakeGuard();
    f.ha.actions.useInjectionGuard(g.guard);
    await f.mode("full");
    const r = await f.run(
      "ha_call_service",
      light,
      "Turn on the kitchen light",
      READ_CANARY,
    );
    assert.deepEqual(
      [r?.status, r?.authorization?.mode, r?.authorization?.source],
      ["pending", "ask", "human"],
    );
    assert.equal(r?.authorization?.guard, "flagged");
    assert.equal(f.writes.length, 0, "nothing ran without a person");
    const seen = await f.toolResults();
    assert.ok(seen.includes(GUARD_WARNING_PREFIX), "warning prepended");
    assert.ok(seen.includes("ATTRIBUTE_CANARY"), "content kept");
    assert.ok(
      seen.indexOf(GUARD_WARNING_PREFIX) < seen.indexOf("ATTRIBUTE_CANARY"),
    );
    // The marker on the run's input: tool and score, never content.
    const [first] = await inputs(f);
    assert.equal(first!.guard?.result, "flagged");
    assert.equal(first!.guard?.tool, "ha_search_states");
    assert.equal(first!.guard?.score, 0.97);
    assert.ok(!JSON.stringify(first!.guard).includes("CANARY"));
    // A person can still approve the exact card.
    await f.ha.actions.decide("owner", f.id, r!.id, r!.hash, "approve");
    assert.equal(f.writes.length, 1);
    // Turn 2: a new message with clean tools starts clean; the trusted
    // owner's own turn runs at every level again (high: unlock).
    const next = await f.run(
      "ha_call_service",
      unlock,
      "Unlock the door",
      READ_CLEAN,
    );
    assert.deepEqual(
      [next?.status, next?.risk?.level, next?.authorization?.source],
      ["accepted", "high", "trusted"],
    );
    assert.equal(next?.authorization?.guard, undefined);
    assert.equal((await inputs(f)).at(-1)!.guard, undefined);
    // The key never reaches the transcript, the snapshot or the status.
    const snapshot = JSON.stringify(await f.runtime.snapshot("owner", f.id));
    for (const text of [
      seen,
      await f.toolResults(),
      snapshot,
      JSON.stringify(g.guard.status()),
      ...g.logs,
    ])
      assert.ok(!text.includes(KEY));
  } finally {
    await f.close();
  }
});

test("flagged tool output: an untrusted owner's low-risk Full auto-run also waits for approval", async () => {
  const f = await adminHarness({ submit: DIRECT });
  try {
    f.ha.actions.useInjectionGuard(fakeGuard().guard);
    await f.mode("full");
    const flagged = await f.run(
      "ha_call_service",
      light,
      "Light on",
      READ_CANARY,
    );
    assert.deepEqual(
      [
        flagged?.status,
        flagged?.authorization?.source,
        flagged?.authorization?.guard,
      ],
      ["pending", "human", "flagged"],
    );
    await f.ha.actions.decide(
      "owner",
      f.id,
      flagged!.id,
      flagged!.hash,
      "reject",
    );
    const clean = await f.run("ha_call_service", light, "Light on", READ_CLEAN);
    assert.deepEqual(
      [clean?.status, clean?.authorization?.source],
      ["accepted", "automatic"],
    );
    assert.equal(f.writes.length, 1);
  } finally {
    await f.close();
  }
});

test("guard unavailable: tool output passes unchanged and chat is not blocked; status says unavailable", async (t: TestContext) => {
  const f = await adminHarness({ trusted: ["owner"], submit: DIRECT });
  t.after(() => f.close());
  const g = fakeGuard("down");
  f.ha.actions.useInjectionGuard(g.guard);
  await f.mode("full");
  const r = await f.run("ha_call_service", light, "Light on", READ_CANARY);
  // Good faith: unscanned output is not marked; the turn runs as usual.
  assert.deepEqual(
    [r?.status, r?.authorization?.source, r?.authorization?.guard],
    ["accepted", "trusted", undefined],
  );
  const seen = await f.toolResults();
  assert.ok(seen.includes("ATTRIBUTE_CANARY"));
  assert.ok(!seen.includes(GUARD_WARNING_PREFIX));
  assert.ok((await inputs(f)).every((i) => !i.guard));
  const status = g.guard.status();
  assert.equal(status.state, "unavailable");
  assert.equal(status.lastError, "unreachable");
  assert.ok(status.today.unavailable >= 1);
  // One log line per error class change: counters only.
  assert.equal(g.logs.length, 1);
  assert.match(
    g.logs[0]!,
    /^Hearth injection guard: unavailable \(unreachable\)/,
  );
  assert.ok(!g.logs[0]!.includes("CANARY") && !g.logs[0]!.includes(KEY));
});

test("injection_guard options: off by default; URL, key and timeout validated with value-free fault codes", async (t: TestContext) => {
  const keys = [
    "HEARTH_MODE",
    "HEARTH_PROVIDER",
    "HEARTH_LOCAL_PASSWORD",
    "HEARTH_ORIGIN",
    "HEARTH_INJECTION_GUARD_URL",
    "HEARTH_INJECTION_GUARD_API_KEY",
    "HEARTH_INJECTION_GUARD_TIMEOUT_MS",
  ];
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, {
    HEARTH_MODE: "local",
    HEARTH_PROVIDER: "offline",
    HEARTH_LOCAL_PASSWORD: "synthetic-local-password-0001",
    HEARTH_ORIGIN: "http://127.0.0.1:8099",
  });
  assert.deepEqual((await loadConfig()).injectionGuard, {
    url: "",
    apiKey: "",
    timeoutMs: 3000,
  });
  for (const [key, value, code] of [
    [
      "HEARTH_INJECTION_GUARD_URL",
      "ftp://10.0.0.5",
      "invalid_injection_guard_url",
    ],
    [
      "HEARTH_INJECTION_GUARD_URL",
      "http://user:pw@10.0.0.5",
      "invalid_injection_guard_url",
    ],
    [
      "HEARTH_INJECTION_GUARD_URL",
      "http://10.0.0.5/?q=1",
      "invalid_injection_guard_url",
    ],
    ["HEARTH_INJECTION_GUARD_URL", "not a url", "invalid_injection_guard_url"],
    [
      "HEARTH_INJECTION_GUARD_API_KEY",
      "has space",
      "invalid_injection_guard_api_key",
    ],
    [
      "HEARTH_INJECTION_GUARD_TIMEOUT_MS",
      "100",
      "invalid_injection_guard_timeout",
    ],
    [
      "HEARTH_INJECTION_GUARD_TIMEOUT_MS",
      "60000",
      "invalid_injection_guard_timeout",
    ],
    [
      "HEARTH_INJECTION_GUARD_TIMEOUT_MS",
      "1.5",
      "invalid_injection_guard_timeout",
    ],
  ] as const) {
    process.env[key] = value;
    const error = await loadConfig().then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.equal(
      configurationDiagnostic(error),
      `invalid configuration: ${code}`,
      `${key}=${value}`,
    );
    assert.ok(!String(configurationDiagnostic(error)).includes(value));
    delete process.env[key];
  }
  Object.assign(process.env, {
    HEARTH_INJECTION_GUARD_URL: URL_BASE,
    HEARTH_INJECTION_GUARD_API_KEY: KEY,
    HEARTH_INJECTION_GUARD_TIMEOUT_MS: "2500",
  });
  assert.deepEqual((await loadConfig()).injectionGuard, {
    url: URL_BASE,
    apiKey: KEY,
    timeoutMs: 2500,
  });
});

test("HTTP: /api/injection-guard needs authentication and returns state and counters, never the URL or the key", async (t: TestContext) => {
  const f = await adminHarness();
  t.after(() => f.close());
  const g = fakeGuard("down");
  f.ha.actions.useInjectionGuard(g.guard);
  await g.guard.scan("tool", ["anything"]);
  const config: Config = {
    mode: "local",
    host: "127.0.0.1",
    port: 8099,
    origin: "http://127.0.0.1:8099",
    password: "synthetic-local-password-0001",
    authorizedUsers: ["local-admin"],
    dataDir: f.dir,
    provider: "offline",
    model: "test",
    policy: { enabled: true, entities: [], services: [] },
    haToken: "",
    apiKey: "",
  };
  const app = appServer(
    config,
    f.runtime,
    {
      engine: f.ha.actions,
      decide: () => Promise.resolve(),
      close: () => Promise.resolve(),
    } as never,
    { secrets: [KEY] },
  );
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () => new Promise<void>((resolve) => app.server.close(() => resolve())),
  );
  t.after(() => app.server.closeAllConnections());
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  config.origin = base;
  assert.equal((await fetch(`${base}/api/injection-guard`)).status, 401);
  const response = await fetch(`${base}/api/injection-guard`, {
    headers: {
      authorization: `Basic ${Buffer.from(`hearth:${config.password}`).toString("base64")}`,
    },
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(KEY) && !text.includes("10.0.0.5"));
  const status = JSON.parse(text);
  assert.deepEqual(
    [status.enabled, status.state, status.lastError, status.today.unavailable],
    [true, "unavailable", "unreachable", 1],
  );
});

test("UI: a receipt from a flagged turn says why it asked", async () => {
  const { parseHTML } = await import("linkedom");
  const { document, window } = parseHTML(
    '<html><body><div id="cards"></div></body></html>',
  );
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
  };
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: window,
    configurable: true,
  });
  try {
    const { renderProposals, guardStatusText } = await import(
      new URL("../public/render.js", import.meta.url).href
    );
    const container = document.getElementById("cards")!;
    renderProposals(
      container,
      {
        "1": {
          id: "1",
          created: 1,
          status: "pending",
          hash: "a".repeat(64),
          policy: "p",
          expires: Date.now() + 60000,
          decidedBy: "",
          decidedAt: 0,
          resolution: "",
          action: { service: "light.turn_on", entityId: "light.example_lamp" },
          risk: { level: "low", rule: "example_rule", reasons: [] },
          authorization: {
            mode: "ask",
            revision: 3,
            policy: "p",
            grant: "g",
            source: "human",
            owner: "owner",
            inputIds: [1],
            guard: "flagged",
          },
        },
      },
      () => {},
    );
    assert.match(
      container.textContent ?? "",
      /Ask: outside content looked like instructions/,
    );
    assert.equal(guardStatusText({ enabled: false }), "Injection guard: off");
    assert.equal(
      guardStatusText({
        enabled: true,
        state: "on",
        lastError: null,
        today: { scanned: 3, flagged: 1, unavailable: 0 },
      }),
      "Injection guard: on · today 3 scanned, 1 flagged",
    );
  } finally {
    Object.defineProperty(globalThis, "document", {
      value: previous.document,
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: previous.window,
      configurable: true,
    });
  }
});

test("injection guard: no Home tool streams through api.output (the guard reads explicit content)", () => {
  const dir = new URL("../src/", import.meta.url);
  for (const name of readdirSync(dir))
    if (name.endsWith(".ts"))
      assert.ok(
        !readFileSync(new URL(name, dir), "utf8").includes("api.output("),
        name,
      );
});
