import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.js";
import { HAClient, haExtension } from "../src/ha.js";
import {
  HA_WEBSOCKET_LIMITS,
  HA_WEBSOCKET_TYPES,
  HA_WEBSOCKET_URL,
  haWebSocketSession,
  sendAllowed,
  type SocketFactory,
  type SocketLike,
} from "../src/ha-websocket.js";
import {
  automationReferences,
  scrubText,
  scrubValue,
} from "../src/automations.js";
import { redactor } from "../src/safety.js";
import { offline } from "./fixtures.js";

// Synthetic home: two automations in scope, one referenced sensor outside it.
const TOKEN = "synthetic-supervisor-token";
const POLICY = {
  enabled: false,
  services: [],
  entities: [
    "automation.hall_light",
    "automation.package_motion",
    "automation.no_id",
    "binary_sensor.hall_motion",
    "light.hall",
  ],
};
const HALL_ID = "1700000000001";
const RUN_FAILED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const RUN_OK = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
const hallConfig = {
  id: HALL_ID,
  alias: "Hall light at night",
  mode: "single",
  triggers: [
    { trigger: "state", entity_id: "binary_sensor.hall_motion", to: "on" },
    { trigger: "state", entity_id: "binary_sensor.private_door", to: "on" },
  ],
  conditions: [
    { condition: "sun", after: "sunset" },
    {
      condition: "state",
      entity_id: "binary_sensor.private_door",
      state: "off",
    },
  ],
  actions: [
    { action: "light.turn_on", target: { entity_id: "light.hall" } },
    {
      action: "rest_command.ping",
      data: {
        url: "https://user:url-password-canary@hook.example/ping?token=query-token-canary",
        password: "plain-password-canary",
        api_key: "!secret ping_api_key",
        headers: { note: "Bearer bearer-token-canary-0123456789" },
        message: `leaked ${TOKEN}`,
      },
    },
  ],
};
const packageConfig = {
  id: "pkg_motion",
  alias: "Package motion",
  triggers: [{ trigger: "state", entity_id: "binary_sensor.hall_motion" }],
  actions: [{ action: "light.turn_off", target: { entity_id: "light.hall" } }],
};
const states: Record<string, Record<string, unknown>> = {
  "automation.hall_light": {
    state: "on",
    attributes: {
      id: HALL_ID,
      friendly_name: "Hall light at night",
      last_triggered: "2026-10-01T21:10:00+00:00",
      mode: "single",
    },
  },
  "automation.package_motion": {
    state: "on",
    attributes: { id: "pkg_motion", friendly_name: "Package motion" },
  },
  "automation.no_id": {
    state: "off",
    attributes: { friendly_name: "No id" },
  },
};
const traceFailed = {
  run_id: RUN_FAILED,
  state: "stopped",
  script_execution: "failed_conditions",
  timestamp: {
    start: "2026-10-01T23:10:00+00:00",
    finish: "2026-10-01T23:10:00.2+00:00",
  },
  trigger: "state of binary_sensor.private_door",
  last_step: "condition/1",
  config: hallConfig,
  trace: {
    "trigger/1": [
      {
        path: "trigger/1",
        timestamp: "2026-10-01T23:10:00+00:00",
        changed_variables: {
          this: { state: "private-this-canary" },
          trigger: {
            platform: "state",
            entity_id: "binary_sensor.private_door",
            from_state: { state: "private-from-canary" },
            to_state: { state: "private-to-canary" },
            description: "state of binary_sensor.private_door",
          },
        },
      },
    ],
    "condition/0": [
      {
        path: "condition/0",
        timestamp: "2026-10-01T23:10:00.1+00:00",
        result: { result: true },
      },
    ],
    "condition/1": [
      {
        path: "condition/1",
        timestamp: "2026-10-01T23:10:00.15+00:00",
        result: { result: false },
      },
    ],
    "condition/1/entity_id/0": [
      {
        path: "condition/1/entity_id/0",
        timestamp: "2026-10-01T23:10:00.16+00:00",
        result: {
          result: false,
          state: "private-state-canary",
          wanted_state: "off",
        },
      },
    ],
  },
};
const traceOk = {
  run_id: RUN_OK,
  state: "stopped",
  script_execution: "error",
  timestamp: {
    start: "2026-10-01T21:10:00+00:00",
    finish: "2026-10-01T21:10:01+00:00",
  },
  trigger: "state of binary_sensor.hall_motion",
  last_step: "action/1",
  error: `Client error for https://user:err-password-canary@hook.example ${TOKEN}`,
  config: hallConfig,
  trace: {
    "trigger/0": [
      {
        path: "trigger/0",
        timestamp: "2026-10-01T21:10:00+00:00",
        changed_variables: {
          trigger: {
            platform: "state",
            entity_id: "binary_sensor.hall_motion",
            from_state: { state: "off" },
            to_state: { state: "on" },
            description: "state of binary_sensor.hall_motion",
          },
        },
      },
    ],
    "action/0": [
      {
        path: "action/0",
        timestamp: "2026-10-01T21:10:00.5+00:00",
        result: {
          params: {
            domain: "light",
            service: "turn_on",
            service_data: {},
            target: { entity_id: ["light.hall"] },
          },
          running_script: false,
        },
      },
    ],
    "action/1": [
      {
        path: "action/1",
        timestamp: "2026-10-01T21:10:00.9+00:00",
        error: "Client error",
        result: {
          params: {
            domain: "rest_command",
            service: "ping",
            service_data: { message: "private-rendered-canary" },
            target: {},
          },
        },
      },
    ],
  },
};
const packageTrace = {
  ...traceOk,
  run_id: "ccccccccccccccccccccccccccccccc3",
  config: packageConfig,
};

type Rest = { method: string; path: string }[];
function fakeRest(calls: Rest): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("http://supervisor/core/api/", "");
    calls.push({ method: String(init?.method), path });
    if (init?.method !== "GET") return new Response("no", { status: 405 });
    if (path.startsWith("states/")) {
      const id = decodeURIComponent(path.slice(7));
      const s = states[id];
      return s
        ? Response.json({ entity_id: id, ...s })
        : new Response("missing", { status: 404 });
    }
    if (path === `config/automation/config/${HALL_ID}`)
      return Response.json(hallConfig);
    if (path.startsWith("config/automation/config/"))
      return Response.json({ message: "Resource not found" }, { status: 404 });
    if (path.startsWith("logbook/"))
      return Response.json([
        {
          when: "2026-10-01T21:10:00+00:00",
          entity_id: "automation.hall_light",
          name: "Hall light at night",
          message: "triggered by state of binary_sensor.hall_motion",
          source: "state of binary_sensor.hall_motion",
          context_entity_id: "binary_sensor.private_door",
          context_name: "private-context-canary",
        },
        {
          when: 1790000000.5,
          entity_id: "binary_sensor.private_door",
          state: "private-logbook-canary",
        },
        {
          when: "2026-10-01T21:09:59+00:00",
          entity_id: "binary_sensor.hall_motion",
          state: "on",
        },
      ]);
    if (path.startsWith("history/period/"))
      return Response.json([
        [
          {
            entity_id: "binary_sensor.hall_motion",
            state: "off",
            last_changed: "2026-10-01T21:00:00+00:00",
          },
          {
            entity_id: "binary_sensor.hall_motion",
            state: "on",
            last_changed: "2026-10-01T21:09:59+00:00",
          },
        ],
      ]);
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}
// Minimal HA WebSocket peer: auth handshake then trace/list and trace/get.
type Frames = Record<string, unknown>[];
function fakeSocket(
  frames: Frames,
  options: {
    silent?: boolean;
    authReply?: string;
    reply?: (m: Record<string, unknown>) => unknown;
  } = {},
): SocketFactory {
  return (url) => {
    assert.equal(url, HA_WEBSOCKET_URL);
    const socket: SocketLike & { closed: boolean } = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      closed: false,
      send(data) {
        const m = JSON.parse(data) as Record<string, unknown>;
        frames.push(m);
        setImmediate(() => {
          if (m.type === "auth")
            return emit({
              type:
                options.authReply ??
                (m.access_token === TOKEN ? "auth_ok" : "auth_invalid"),
            });
          const result = options.reply?.(m) ?? defaultReply(m);
          emit(
            result === "not_found"
              ? {
                  id: m.id,
                  type: "result",
                  success: false,
                  error: { code: "not_found", message: "x" },
                }
              : { id: m.id, type: "result", success: true, result },
          );
        });
      },
      close() {
        socket.closed = true;
      },
    };
    const emit = (value: unknown) =>
      socket.onmessage?.({
        data: typeof value === "string" ? value : JSON.stringify(value),
      });
    if (!options.silent)
      setImmediate(() => emit({ type: "auth_required", ha_version: "x" }));
    return socket;
  };
}
function defaultReply(m: Record<string, unknown>): unknown {
  assert.equal(m.domain, "automation");
  if (m.type === "trace/list") {
    if (m.item_id === HALL_ID)
      return [traceOk, traceFailed].map(
        ({ run_id, timestamp, state, script_execution, trigger }) => ({
          run_id,
          timestamp,
          state,
          script_execution,
          trigger,
        }),
      );
    if (m.item_id === "pkg_motion") return [{ run_id: packageTrace.run_id }];
    return [];
  }
  if (m.type === "trace/get") {
    const all = [traceOk, traceFailed, packageTrace];
    return all.find((t) => t.run_id === m.run_id) ?? "not_found";
  }
  return "not_found";
}
const CANARIES =
  /synthetic-supervisor-token|url-password-canary|query-token-canary|plain-password-canary|bearer-token-canary|err-password-canary|private-(this|from|to|state|rendered|logbook|context)-canary/;

test("automation troubleshooting tools drive the real harness read-only, scoped and redacted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-automations-"));
  const { faux, models, model } = offline();
  const rest: Rest = [];
  const frames: Frames = [];
  const ha = new HAClient(
    TOKEN,
    POLICY,
    fakeRest(rest),
    [],
    fakeSocket(frames),
  );
  const runtime = await Runtime.open(dir, models, model, [haExtension(ha)]);
  try {
    const id = await runtime.create("owner", "Hall light", "create-auto");
    const draft =
      "The run at 23:10 stopped at condition/1. Paste this in Settings > Automations & scenes > Edit in YAML; I can't apply it myself.\n```yaml\nalias: Hall light at night\n```";
    const call = (name: string, args: Record<string, string | number>) =>
      fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    faux.setResponses([
      call("ha_automation_config", { entityId: "automation.hall_light" }),
      call("ha_automation_traces", {
        entityId: "automation.hall_light",
        limit: 5,
      }),
      call("ha_automation_trace_detail", {
        entityId: "automation.hall_light",
        runId: RUN_FAILED,
      }),
      call("ha_automation_activity", {
        entityId: "automation.hall_light",
        hours: 6,
      }),
      call("ha_automation_config", { entityId: "automation.private" }),
      fauxAssistantMessage(draft),
    ]);
    const sid = await runtime.submit(
      "owner",
      id,
      "request-auto",
      "Why didn't the hallway light come on at 23:10?",
    );
    assert.equal(
      (
        await (await runtime.harness.submission(
          sid as SubmissionId,
          ctx,
        ))!.wait(ctx)
      ).status,
      "done",
    );
    const snapshot = JSON.stringify(await runtime.snapshot("owner", id));
    // Explanations: failing condition, trigger, stored runs and errors.
    assert.match(snapshot, /failed_conditions/);
    assert.match(snapshot, /condition\/1/);
    assert.match(snapshot, /\\"passed\\":false/);
    assert.match(snapshot, /light.turn_on/);
    assert.match(snapshot, /Client error/);
    assert.match(snapshot, /\\"storedRuns\\":2/);
    // Out-of-scope references are named, never read.
    assert.match(snapshot, /outside Hearth's read scope/);
    assert.match(snapshot, /binary_sensor.private_door/);
    assert.match(snapshot, /withheld/);
    // !secret refs remain literal; credentials and token are stripped.
    assert.match(snapshot, /!secret ping_api_key/);
    assert.match(snapshot, /REDACTED/);
    assert.doesNotMatch(snapshot, CANARIES);
    // Automations outside the read scope are refused before any HA read.
    assert.match(snapshot, /entity_not_allowed/);
    assert.ok(!rest.some((r) => r.path.includes("automation.private")));
    // Logbook/history only for the automation and in-scope references.
    const logbook = rest.find((r) => r.path.startsWith("logbook/"))!;
    assert.match(
      logbook.path,
      /entity=automation.hall_light,binary_sensor.hall_motion,light.hall&/,
    );
    assert.doesNotMatch(logbook.path, /private_door/);
    assert.ok(
      rest.some(
        (r) =>
          r.path.startsWith("history/period/") &&
          /binary_sensor.hall_motion,light.hall&/.test(r.path),
      ),
    );
    // Only GET over REST; only allowlisted frames over the socket.
    assert.ok(rest.length > 0);
    assert.ok(
      rest.every((r) => r.method === "GET"),
      JSON.stringify(rest),
    );
    assert.ok(
      rest.every((r) =>
        /^(states\/automation\.|config\/automation\/config\/|logbook\/|history\/period\/)/.test(
          r.path,
        ),
      ),
    );
    assert.ok(frames.length > 0);
    assert.ok(
      frames.every((f) =>
        (HA_WEBSOCKET_TYPES as readonly string[]).includes(String(f.type)),
      ),
    );
    assert.match(snapshot, /```yaml/);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("automation reader: no-id, config-editor 404 falls back to the latest trace config, scope and argument bounds", async () => {
  const rest: Rest = [];
  const frames: Frames = [];
  const ha = new HAClient(
    TOKEN,
    POLICY,
    fakeRest(rest),
    [],
    fakeSocket(frames),
  );
  const pkg = (await ha.automations.config("automation.package_motion")) as {
    source?: string;
    referencedEntities?: { readable: string[] };
  };
  assert.equal(pkg.source, "latest_trace");
  assert.deepEqual(pkg.referencedEntities?.readable, [
    "binary_sensor.hall_motion",
    "light.hall",
  ]);
  const none = await ha.automations.traces("automation.no_id", 3);
  assert.equal(none.automationId, null);
  assert.match(String(none.note), /no `id`/);
  const callsBefore = rest.length;
  await assert.rejects(
    ha.automations.config("automation.private"),
    /entity_not_allowed/,
  );
  await assert.rejects(
    ha.automations.config("light.hall"),
    /entity_not_allowed/,
  );
  await assert.rejects(
    ha.automations.traces("automation.hall_light", 6),
    /invalid_request/,
  );
  await assert.rejects(
    ha.automations.activity("automation.hall_light", 25),
    /invalid_request/,
  );
  await assert.rejects(
    ha.automations.traceDetail("automation.hall_light", "../x"),
    /invalid_run_id/,
  );
  assert.equal(rest.length, callsBefore, "refused before any HA request");
  await assert.rejects(
    ha.automations.traceDetail("automation.hall_light", "ffff"),
    /ha_not_found/,
  );
  const limited = await ha.automations.traces("automation.hall_light", 1);
  assert.equal(limited.runs.length, 1);
  assert.equal(
    (limited.runs[0] as { runId?: string }).runId,
    RUN_FAILED,
    "newest first",
  );
});

test("HA WebSocket client sends only allowlisted message types", async () => {
  const sent: string[] = [];
  const sink = { send: (d: string) => sent.push(d) };
  for (const type of [
    "call_service",
    "execute_script",
    "subscribe_events",
    "automation/config",
    "config/automation/config",
    "config/entity_registry/update",
    "fire_event",
    "auth/long_lived_access_token",
    "supervisor/api",
    "",
  ])
    assert.throws(() => sendAllowed(sink, { type }), /ws_type_not_allowed/);
  assert.equal(sent.length, 0);
  for (const type of HA_WEBSOCKET_TYPES) sendAllowed(sink, { type });
  assert.equal(sent.length, HA_WEBSOCKET_TYPES.length);

  const frames: Frames = [];
  await assert.rejects(
    haWebSocketSession(
      fakeSocket(frames),
      TOKEN,
      (s) => s,
      (call) =>
        call("call_service" as string as "trace/list", { domain: "light" }),
    ),
    /ws_type_not_allowed/,
  );
  await assert.rejects(
    haWebSocketSession(
      fakeSocket(frames),
      TOKEN,
      (s) => s,
      (call) => call("auth" as string as "trace/list", { access_token: "x" }),
    ),
    /ws_type_not_allowed/,
  );
  // A payload cannot override the allowlisted type.
  await haWebSocketSession(
    fakeSocket(frames),
    TOKEN,
    (s) => s,
    (call) =>
      call("trace/list", { type: "call_service", domain: "automation" }),
  );
  assert.deepEqual(
    frames.map((f) => f.type),
    ["auth", "auth", "auth", "trace/list"],
  );
});

test("HA WebSocket client is bounded: timeout, frame/total size, command count and auth failure", async (t) => {
  // AbortSignal.timeout timers are unref'd; keep the test loop alive.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const quick = { ...HA_WEBSOCKET_LIMITS, timeoutMs: 50 };
  const started = Date.now();
  await assert.rejects(
    haWebSocketSession(
      fakeSocket([], { silent: true }),
      TOKEN,
      (s) => s,
      async () => 1,
      undefined,
      quick,
    ),
    /ha_read_failed/,
  );
  assert.ok(Date.now() - started < 2000);
  await assert.rejects(
    haWebSocketSession(
      fakeSocket([], { authReply: "auth_invalid" }),
      TOKEN,
      (s) => s,
      async () => 1,
    ),
    /ha_auth_failed/,
  );
  const big = "x".repeat(4096);
  await assert.rejects(
    haWebSocketSession(
      fakeSocket([], { reply: () => [{ run_id: big }] }),
      TOKEN,
      (s) => s,
      (call) => call("trace/list", { domain: "automation", item_id: HALL_ID }),
      undefined,
      { ...HA_WEBSOCKET_LIMITS, messageBytes: 1024 },
    ),
    /ha_response_limit/,
  );
  await assert.rejects(
    haWebSocketSession(
      fakeSocket([], { reply: () => big }),
      TOKEN,
      (s) => s,
      async (call) => {
        for (let i = 0; i < 4; i++)
          await call("trace/list", { domain: "automation", item_id: HALL_ID });
      },
      undefined,
      { ...HA_WEBSOCKET_LIMITS, totalBytes: 10000 },
    ),
    /ha_response_limit/,
  );
  await assert.rejects(
    haWebSocketSession(
      fakeSocket([]),
      TOKEN,
      (s) => s,
      async (call) => {
        for (let i = 0; i < 3; i++)
          await call("trace/list", { domain: "automation", item_id: HALL_ID });
      },
      undefined,
      { ...HA_WEBSOCKET_LIMITS, commands: 2 },
    ),
    /ha_request_limit/,
  );
  // Redaction happens on raw frame text before parsing.
  const value = await haWebSocketSession(
    fakeSocket([], { reply: () => `has ${TOKEN}` }),
    TOKEN,
    redactor([TOKEN]),
    (call) => call("trace/list", { domain: "automation", item_id: HALL_ID }),
  );
  assert.equal(value, "has [REDACTED]");
});

test("HA WebSocket client works over Node's real WebSocket against a local frame server", async () => {
  const seen: string[] = [];
  const server = createServer();
  const sockets = new Set<Socket>();
  server.on("upgrade", (req, socket: Socket) => {
    sockets.add(socket);
    const accept = createHash("sha1")
      .update(
        `${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const send = (value: unknown) => {
      const body = Buffer.from(JSON.stringify(value));
      const head =
        body.length < 126
          ? Buffer.from([0x81, body.length])
          : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
      socket.write(Buffer.concat([head, body]));
    };
    send({ type: "auth_required" });
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 6) {
        const opcode = buffer[0]! & 15;
        let length = buffer[1]! & 127,
          offset = 2;
        if (length === 126) {
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const data = Buffer.from(
          buffer
            .subarray(offset + 4, offset + 4 + length)
            .map((b, i) => b ^ mask[i % 4]!),
        );
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 8) return socket.end();
        if (opcode !== 1) continue;
        const m = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        seen.push(String(m.type));
        if (m.type === "auth") send({ type: "auth_ok" });
        else send({ id: m.id, type: "result", success: true, result: [] });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const result = await haWebSocketSession(
      (url) => {
        assert.equal(url, HA_WEBSOCKET_URL);
        return new WebSocket(`ws://127.0.0.1:${port}`) as unknown as SocketLike;
      },
      TOKEN,
      (s) => s,
      (call) => call("trace/list", { domain: "automation", item_id: "1" }),
    );
    assert.deepEqual(result, []);
    assert.deepEqual(seen, ["auth", "trace/list"]);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
});

test("automation redaction keeps !secret refs and strips credential-shaped text", () => {
  const redact = redactor([TOKEN]);
  const clean = JSON.stringify(
    scrubValue(
      {
        password: "p4ss",
        token: { nested: "x" },
        api_key: "!secret my_key",
        code: 1234,
        webhook_id: "hook-canary",
        url: "http://u:p@host.example/api/webhook/hook-canary?api_key=k1",
        text: `Bearer abcdefghijkl ${TOKEN} eyJhbGciOi.eyJzdWIiOi.c2ln https://api.telegram.example/bot123456:ABCDEFGHIJKLMNOPQRSTUV/send`,
      },
      redact,
    ),
  );
  assert.match(clean, /!secret my_key/);
  assert.doesNotMatch(
    clean,
    /p4ss|"x"|1234|hook-canary|u:p@|k1|abcdefghijkl|synthetic-supervisor|eyJ|ABCDEFGHIJKLMNOP/,
  );
  assert.equal(scrubText("!secret wifi", redact), "!secret wifi");
  const refs = automationReferences(
    {
      trigger: { entity_id: "sensor.a, sensor.b" },
      condition: {
        value_template:
          "{{ is_state('sensor.c','on') and states.sensor.d.state }}",
      },
      action: [
        { device_id: "abc" },
        { data: { message: "{{ expand('group.all') }}" } },
      ],
    },
    ["sensor.a", "sensor.c"],
  );
  assert.deepEqual(refs, {
    readable: ["sensor.a", "sensor.c"],
    outsideReadScope: ["sensor.b", "sensor.d"],
    deviceReferences: 1,
    opaqueTemplates: true,
  });
});

test("static: automation troubleshooting code has no write path to HA", async () => {
  const files = ["../src/automations.ts", "../src/ha-websocket.ts"];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\b(POST|PUT|DELETE|PATCH)\b/, file);
    assert.doesNotMatch(source, /method\s*:/, file);
    assert.doesNotMatch(source, /\bfetch\(/, file);
    assert.doesNotMatch(source, /services\/|call_service|\/reload/, file);
  }
  const ws = await readFile(
    new URL("../src/ha-websocket.ts", import.meta.url),
    "utf8",
  );
  // Only one function writes to the socket, and it checks the allowlist.
  assert.equal(ws.match(/\.send\(/g)?.length, 1);
  const ha = await readFile(new URL("../src/ha.ts", import.meta.url), "utf8");
  // Config paths are read through the GET-only getter; the single POST path is
  // the existing service dispatch with an explicit Action.
  assert.equal(ha.match(/"POST"/g)?.length, 1);
  assert.match(ha, /method: action \? "POST" : "GET"/);
  assert.match(
    ha,
    /get: \(path, signal\) => this\.request\(path, signal, undefined, true\)/,
  );
  assert.equal(ha.match(/this\.request\(\s*`services\//g)?.length, 1);
  assert.doesNotMatch(ha, /config\/automation/);
});

test("automation tool calls render friendly activity labels and drafted YAML stays a text code block", async () => {
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(
    '<html><body><div id="chat"></div></body></html>',
  );
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
  });
  try {
    const { renderMessages } = await import(
      new URL("../public/render.js", import.meta.url).href
    );
    const chat = document.getElementById("chat")!;
    const hostile = "<img src=x onerror=alert(1)>";
    const calls = [
      [
        "c1",
        "ha_automation_traces",
        { entityId: "automation.hall_light", limit: 3 },
      ],
      [
        "c2",
        "ha_automation_trace_detail",
        { entityId: "automation.hall_light", runId: hostile },
      ],
      ["c3", "ha_automation_config", { entityId: "automation.hall_light" }],
      [
        "c4",
        "ha_automation_activity",
        { entityId: "automation.hall_light", hours: 6 },
      ],
    ] as const;
    const yaml = `alias: Hall light\nactions:\n  - action: light.turn_on # ${hostile}`;
    renderMessages(chat, {
      view: {
        entries: [
          ...calls.flatMap(([id, name, args]) => [
            {
              model: [
                {
                  role: "assistant",
                  content: [{ type: "toolCall", id, name, arguments: args }],
                },
              ],
            },
            {
              model: [
                {
                  role: "toolResult",
                  toolCallId: id,
                  toolName: name,
                  content: [{ type: "text", text: `{"note":"${hostile}"}` }],
                  isError: false,
                },
              ],
            },
          ]),
          {
            model: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: `I can't apply this myself. Paste it in Edit in YAML:\n\`\`\`yaml\n${yaml}\n\`\`\``,
                  },
                ],
              },
            ],
          },
        ],
        docs: { "pi.live": {} },
      },
    });
    const summary = chat.querySelector(".activity-summary-text")!.textContent!;
    assert.match(summary, /Checked recent runs/);
    assert.match(summary, /Read one run step by step/);
    assert.match(summary, /Read an automation/);
    assert.match(summary, /Checked logbook and history/);
    assert.equal(chat.querySelector("img"), null);
    assert.ok(chat.textContent!.includes(hostile));
    const code = chat.querySelector(".message.assistant pre.md-code")!;
    assert.equal(code.textContent, yaml);
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
});
