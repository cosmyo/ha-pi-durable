import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { HAClient, haExtension, Actions } from "../src/ha.js";
import { Runtime } from "../src/runtime.js";
import { Proposals, type Proposal } from "../src/documents.js";
import {
  ApprovalPush,
  actionHeadline,
  approvalNotification,
} from "../src/approval-push.js";
import { HA_EVENT_SOCKET_TYPES } from "../src/ha-events.js";
import {
  HA_WEBSOCKET_URL,
  sendAllowed,
  type SocketFactory,
  type SocketLike,
} from "../src/ha-websocket.js";
import { loadConfig, type Config } from "../src/config.js";
import { appServer } from "../src/server.js";
import { offline } from "./fixtures.js";

const OWNER_A = "user-owner-a";
const OWNER_B = "user-owner-b";
const TOKEN = "synthetic-supervisor-token";
const LAMP = "light.example_lamp";
const PHONE_A = "mobile_app_example_phone_a";
const PHONE_B = "mobile_app_example_phone_b";
const action = {
  service: "light.turn_on",
  entityId: LAMP,
  data: { brightness: 42 },
};

type Frame = Record<string, unknown>;
type Post = { url: string; body: Record<string, unknown> };

// A fake HA: REST states/services and notify/light POSTs, plus a WebSocket
// peer that serves the registries and the long-lived event subscription.
function fakeHA(
  options: { notifyFails?: () => boolean; phones?: () => boolean } = {},
) {
  const posts: Post[] = [];
  const frames: Frame[] = [];
  const live: { socket: SocketLike; id: number }[] = [];
  const phones = options.phones ?? (() => true);
  const transport = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const full = String(url);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url: full, body });
      if (full.includes("/services/notify/") && options.notifyFails?.())
        return new Response("down", { status: 500 });
      return Response.json([]);
    }
    if (full.endsWith("/api/services"))
      return Response.json([
        { domain: "light", services: { turn_on: {} } },
        { domain: "notify", services: { [PHONE_A]: {}, [PHONE_B]: {} } },
      ]);
    if (full.endsWith("/api/states"))
      return Response.json([
        {
          entity_id: "person.example_a",
          state: "home",
          attributes: {
            user_id: OWNER_A,
            device_trackers: phones() ? ["device_tracker.example_phone_a"] : [],
          },
        },
        {
          entity_id: "person.example_b",
          state: "home",
          attributes: {
            user_id: OWNER_B,
            device_trackers: ["device_tracker.example_phone_b"],
          },
        },
        { entity_id: LAMP, state: "off", attributes: {} },
      ]);
    return Response.json({
      entity_id: LAMP,
      state: "off",
      attributes: { friendly_name: "Synthetic Secret Lamp Name" },
    });
  }) as typeof fetch;
  const socket: SocketFactory = (url) => {
    assert.equal(url, HA_WEBSOCKET_URL);
    const s: SocketLike = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data) {
        const m = JSON.parse(data) as Frame;
        frames.push(m);
        setImmediate(() => {
          if (m.type === "auth")
            return emit({
              type: m.access_token === TOKEN ? "auth_ok" : "auth_invalid",
            });
          if (m.type === "subscribe_events") {
            live.push({ socket: s, id: m.id as number });
            return emit({ id: m.id, type: "result", success: true });
          }
          if (m.type === "ping") return emit({ id: m.id, type: "pong" });
          const result =
            m.type === "config/entity_registry/list"
              ? [
                  {
                    entity_id: "device_tracker.example_phone_a",
                    platform: "mobile_app",
                    device_id: "dev-a",
                  },
                  {
                    entity_id: "device_tracker.example_phone_b",
                    platform: "mobile_app",
                    device_id: "dev-b",
                  },
                ]
              : m.type === "config/device_registry/list"
                ? [
                    { id: "dev-a", name: "Example Phone A" },
                    { id: "dev-b", name: "Example Phone B" },
                  ]
                : [];
          emit({ id: m.id, type: "result", success: true, result });
        });
      },
      close() {
        const at = live.findIndex((l) => l.socket === s);
        if (at >= 0) live.splice(at, 1);
      },
    };
    const emit = (value: unknown) =>
      s.onmessage?.({ data: JSON.stringify(value) });
    setImmediate(() => emit({ type: "auth_required" }));
    return s;
  };
  // Fire one mobile_app_notification_action on every live subscription.
  const tap = (
    actionId: string,
    userId: string | undefined,
    origin = "REMOTE",
  ) => {
    for (const l of live)
      l.socket.onmessage?.({
        data: JSON.stringify({
          id: l.id,
          type: "event",
          event: {
            event_type: "mobile_app_notification_action",
            origin,
            data: { action: actionId, reply_text: "ignored free text" },
            context: { id: "ctx", ...(userId ? { user_id: userId } : {}) },
          },
        }),
      });
  };
  return { transport, socket, posts, frames, live, tap };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timeout");
    await sleep(5);
  }
}

async function fixture(
  t: TestContext,
  options: {
    notifyFails?: () => boolean;
    phones?: () => boolean;
    now?: () => number;
    available?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "hearth-push-"));
  const fake = fakeHA(options);
  const provider = offline();
  const ha = new HAClient(
    TOKEN,
    { enabled: true, entities: [LAMP], services: ["light.turn_on"] },
    fake.transport,
    [],
    fake.socket,
  );
  ha.actions.authorizeOwners([OWNER_A, OWNER_B]);
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(ha)],
    [],
    undefined,
    ha.actions,
  );
  const push = new ApprovalPush(runtime, ha.actions, {
    available: options.available ?? true,
    selfSlug: "abc123_hearth_pi",
    graceMs: 1,
    ...(options.now ? { now: options.now } : {}),
    subscriber: { minBackoffMs: 5, maxBackoffMs: 20, pingMs: 60000 },
  });
  await push.start();
  t.after(async () => {
    await push.stop();
    await ha.actions.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  const session = await runtime.create(OWNER_A, "Home", "create-push-1");
  let n = 0;
  const propose = async () => {
    provider.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ha_propose_service", action), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Proposed."),
    ]);
    const sid = await runtime.submit(
      OWNER_A,
      session,
      `request-push-${++n}`,
      "Turn on the lamp",
    );
    await (await runtime.harness.submission(sid as SubmissionId, ctx))!.wait(
      ctx,
    );
    return receipts().at(-1)!;
  };
  const items = async () =>
    Object.values(
      (await runtime.harness.snapshot(
        Proposals,
        session as ConversationId,
        ctx,
      ))!.items,
    );
  let cache: Proposal[] = [];
  const receipts = () => cache;
  const refresh = async () => (cache = await items());
  const notifies = () =>
    fake.posts.filter((p) => p.url.includes("/services/notify/"));
  const lights = () =>
    fake.posts.filter((p) => p.url.includes("/services/light/"));
  // Confirm owner A's phone through the round-trip proof.
  const enroll = async () => {
    const view = await push.get(OWNER_A);
    assert.equal(view.candidates.length, 1);
    const added = await push.addTarget(OWNER_A, {
      candidate: view.candidates[0]!.id,
      revision: view.revision,
    });
    await until(() => fake.live.length > 0);
    const proof = notifies().at(-1)!;
    const proofAction = (proof.body.data as { actions: { action: string }[] })
      .actions[0]!.action;
    fake.tap(proofAction, OWNER_A);
    await push.idle();
    const enabled = await push.setEnabled(OWNER_A, {
      enabled: true,
      revision: (await push.get(OWNER_A)).revision,
    });
    assert.equal(added.targets[0]!.status, "proof");
    assert.equal(enabled.targets[0]!.status, "active");
    return enabled;
  };
  const sent = async () => {
    await sleep(20);
    await push.idle();
    await refresh();
  };
  const buttons = (post: Post) =>
    (
      post.body.data as {
        actions: { action: string; title: string; uri?: string }[];
      }
    ).actions;
  return {
    ha,
    runtime,
    push,
    fake,
    session,
    propose: async () => {
      await propose();
      await refresh();
      return cache.at(-1)!;
    },
    refresh,
    notifies,
    lights,
    enroll,
    sent,
    buttons,
  };
}

test("phone approvals: enrollment needs the owner's own phone and a proof tap by that HA user", async (t) => {
  const f = await fixture(t);
  const view = await f.push.get(OWNER_A);
  assert.equal(view.available, true);
  // Only owner A's person's mobile_app devices, never owner B's.
  assert.deepEqual(
    view.candidates.map((c) => c.label),
    ["Example Phone A"],
  );
  await f.push.addTarget(OWNER_A, {
    candidate: view.candidates[0]!.id,
    revision: view.revision,
  });
  await until(() => f.fake.live.length > 0);
  const proof = f.notifies().at(-1)!;
  assert.match(proof.url, /\/services\/notify\/mobile_app_example_phone_a$/);
  const [button] = f.buttons(proof);
  assert.match(button!.action, /^HEARTH_P_[A-Z2-7]{26}$/);
  // Wrong user, LOCAL origin and a missing user id never enroll.
  f.fake.tap(button!.action, OWNER_B);
  f.fake.tap(button!.action, OWNER_A, "LOCAL");
  f.fake.tap(button!.action, undefined);
  await f.push.idle();
  assert.equal((await f.push.get(OWNER_A)).targets[0]!.status, "proof");
  f.fake.tap(button!.action, OWNER_A);
  await f.push.idle();
  assert.equal((await f.push.get(OWNER_A)).targets[0]!.status, "active");
  // Owner B cannot add owner A's phone by id.
  await assert.rejects(
    f.push.addTarget(OWNER_B, {
      candidate: view.candidates[0]!.id,
      revision: 0,
    }),
    /push_candidate_not_found/,
  );
  // Strict bodies and compare-and-swap.
  await assert.rejects(
    f.push.setEnabled(OWNER_A, { enabled: true, revision: 0 }),
    /approval_push_stale/,
  );
  await assert.rejects(
    f.push.setEnabled(OWNER_A, { enabled: true, revision: 2, extra: 1 }),
    /invalid_request/,
  );
});

test("phone approvals: one low-risk send with Approve; only the owner's REMOTE tap decides, once", async (t) => {
  const f = await fixture(t);
  await f.enroll();
  const before = f.notifies().length;
  const proposal = await f.propose();
  assert.equal(proposal.status, "pending");
  await f.sent();
  const sends = f.notifies().slice(before);
  assert.equal(sends.length, 1);
  const body = sends[0]!.body as {
    title: string;
    message: string;
    data: { tag: string; group: string };
  };
  assert.equal(body.title, "Hearth · Low risk");
  assert.equal(body.message, `light.turn_on ${LAMP}`);
  assert.equal(body.data.group, "hearth-approvals");
  // No data values, no friendly name.
  assert.doesNotMatch(body.message, /42/);
  assert.doesNotMatch(JSON.stringify(body), /Secret Lamp|brightness/);
  const [approve, reject, open] = f.buttons(sends[0]!);
  assert.equal(approve!.title, "Approve");
  assert.match(approve!.action, /^HEARTH_A_/);
  assert.equal(
    (approve as { authenticationRequired?: boolean }).authenticationRequired,
    true,
  );
  assert.match(reject!.action, /^HEARTH_R_/);
  assert.deepEqual(open, {
    action: "URI",
    title: "Open Hearth",
    uri: "/hassio/ingress/abc123_hearth_pi",
  });
  const notified = (await f.refresh()).at(-1)!;
  assert.equal(notified.notified?.tag, body.data.tag);
  assert.equal(notified.notified?.count, 1);
  // Another user, LOCAL origin, missing user id, a wrong verb letter, an
  // unknown nonce: refused.
  f.fake.tap(approve!.action, OWNER_B);
  f.fake.tap(approve!.action, OWNER_A, "LOCAL");
  f.fake.tap(approve!.action, undefined);
  f.fake.tap(approve!.action.replace("HEARTH_A_", "HEARTH_R_"), OWNER_A);
  f.fake.tap(`HEARTH_A_${"A".repeat(26)}`, OWNER_A);
  await f.push.idle();
  assert.equal((await f.refresh()).at(-1)!.status, "pending");
  assert.equal(f.lights().length, 0);
  f.fake.tap(approve!.action, OWNER_A);
  await f.push.idle();
  const decided = (await f.refresh()).at(-1)!;
  assert.equal(decided.status, "accepted");
  assert.equal(decided.decidedVia, "push");
  assert.equal(decided.decidedBy, OWNER_A);
  assert.equal(f.lights().length, 1);
  // Cleared by tag once; a replay and the sibling Reject are no-ops.
  await until(() =>
    f
      .notifies()
      .some(
        (p) =>
          p.body.message === "clear_notification" &&
          (p.body.data as { tag: string }).tag === body.data.tag,
      ),
  );
  f.fake.tap(approve!.action, OWNER_A);
  f.fake.tap(reject!.action, OWNER_A);
  await f.push.idle();
  assert.equal(f.lights().length, 1);
  assert.equal((await f.refresh()).at(-1)!.status, "accepted");
});

test("phone approvals: Reject from the phone, a UI decision racing a tap, expiry and restart", async (t) => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock });
  await f.enroll();
  // Reject from the phone.
  let before = f.notifies().length;
  await f.propose();
  await f.sent();
  let [, reject] = f.buttons(f.notifies()[before]!);
  f.fake.tap(reject!.action, OWNER_A);
  await f.push.idle();
  let item = (await f.refresh()).at(-1)!;
  assert.equal(item.status, "rejected");
  assert.equal(item.decidedVia, "push");
  // A UI approval racing a phone Reject: exactly one wins.
  before = f.notifies().length;
  const racing = await f.propose();
  await f.sent();
  [, reject] = f.buttons(f.notifies()[before]!);
  const ui = f.ha.actions.decide(
    OWNER_A,
    f.session,
    racing.id,
    racing.hash,
    "approve",
  );
  f.fake.tap(reject!.action, OWNER_A);
  await Promise.allSettled([ui]);
  await f.push.idle();
  item = (await f.refresh()).at(-1)!;
  assert.ok(["accepted", "rejected"].includes(item.status));
  assert.equal(f.lights().length, item.status === "accepted" ? 1 : 0);
  await until(() =>
    f.notifies().some((p) => p.body.message === "clear_notification"),
  );
  // An expired token is ignored.
  before = f.notifies().length;
  const late = await f.propose();
  await f.sent();
  const [approve] = f.buttons(f.notifies()[before]!);
  clock = late.expires + 1;
  f.fake.tap(approve!.action, OWNER_A);
  await f.push.idle();
  assert.equal((await f.refresh()).at(-1)!.status, "pending");
  clock = Date.now();
  // A fresh controller (restart) knows no nonce: the tap is ignored.
  const restarted = new ApprovalPush(f.runtime, f.ha.actions, {
    available: true,
  });
  restarted.handleEvent({
    eventType: "mobile_app_notification_action",
    origin: "REMOTE",
    action: approve!.action,
    userId: OWNER_A,
  });
  await restarted.idle();
  await restarted.stop();
  f.ha.actions.useApprovalHooks(f.push);
  assert.equal((await f.refresh()).at(-1)!.status, "pending");
});

test("phone approvals: high/critical never get Approve and decide() refuses a phone approval above medium", async (t) => {
  const f = await fixture(t);
  await f.enroll();
  const proposal = await f.propose();
  for (const level of ["high", "critical"] as const) {
    const payload = approvalNotification(
      { ...proposal, risk: { level, rule: "test", reasons: [] } },
      "hearth_0123456789abcdef",
      {
        approve: "HEARTH_A_" + "B".repeat(26),
        reject: "HEARTH_R_" + "C".repeat(26),
      },
      "abc123_hearth_pi",
    );
    assert.ok(
      !("title" in payload) ||
        payload.title.includes(level === "high" ? "High" : "Critical"),
    );
    assert.deepEqual(
      (payload.data as { actions: { title: string }[] }).actions.map(
        (a) => a.title,
      ),
      ["Reject", "Open Hearth"],
    );
  }
  // Server-side: even with a valid hash, a push approval of high is refused.
  await f.runtime.harness.commit(async (tx) => {
    (await tx.doc(Proposals, f.session as ConversationId)).items[
      proposal.id
    ]!.risk = { level: "high", rule: "test", reasons: [] };
  }, ctx);
  await assert.rejects(
    f.ha.actions.decide(
      OWNER_A,
      f.session,
      proposal.id,
      proposal.hash,
      "approve",
      "",
      "",
      "push",
    ),
    /push_approval_not_allowed/,
  );
  await assert.rejects(
    f.ha.actions.decide(
      OWNER_A,
      f.session,
      proposal.id,
      proposal.hash,
      "resolve",
      "x",
      "",
      "push",
    ),
    /invalid_request/,
  );
  assert.equal(f.lights().length, 0);
});

test("phone approvals: a failed send is never resent; disabled owners and app presses get nothing", async (t) => {
  let fail = true;
  const f = await fixture(t, { notifyFails: () => fail });
  fail = false;
  await f.enroll();
  fail = true;
  const before = f.notifies().length;
  const proposal = await f.propose();
  await f.sent();
  assert.equal(f.notifies().length - before, 1);
  assert.ok((await f.refresh()).at(-1)!.notified);
  // A second hook for the same proposal sends nothing.
  f.push.pending(OWNER_A, f.session, proposal);
  await f.sent();
  assert.equal(f.notifies().length - before, 1);
  fail = false;
  // Owner turns phone approvals off: no send.
  await f.push.setEnabled(OWNER_A, {
    enabled: false,
    revision: (await f.push.get(OWNER_A)).revision,
  });
  await f.propose();
  await f.sent();
  assert.equal(f.notifies().length - before, 1);
  await f.push.setEnabled(OWNER_A, {
    enabled: true,
    revision: (await f.push.get(OWNER_A)).revision,
  });
  // A person's own press (app/world/list origin) is never sent to the phone.
  const pressed = await f.ha.actions.press(OWNER_A, f.session, action, {
    kind: "world",
    entityId: LAMP,
  });
  assert.equal(pressed.status, "pending");
  await f.sent();
  assert.equal(f.notifies().length - before, 1);
});

test("phone approvals: a phone no longer linked to the owner is disabled at send time", async (t) => {
  let linked = true;
  const f = await fixture(t, { phones: () => linked });
  await f.enroll();
  // Re-registered: owner A's person no longer lists that tracker.
  linked = false;
  const before = f.notifies().length;
  await f.propose();
  await f.sent();
  assert.equal(f.notifies().length, before);
  const view = await f.push.get(OWNER_A);
  assert.equal(view.targets[0]!.status, "disabled");
});

test("phone approvals: notifier works in scoped mode while notify stays refused for proposals and tools", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () =>
      f.ha.action({
        service: `notify.${PHONE_A}`,
        entityId: LAMP,
        data: {},
      }),
    /service_not_allowed|indirect_or_mismatched_target/,
  );
  await f.ha.notifyDevice(PHONE_A, {
    message: "clear_notification",
    data: { tag: "hearth_0123456789abcdef" },
  });
  assert.equal(f.notifies().length, 1);
  // Fixed shape only: other services and free-form payloads are refused.
  await assert.rejects(
    f.ha.notifyDevice("persistent_notification", {
      message: "clear_notification",
      data: { tag: "hearth_0123456789abcdef" },
    }),
    /push_target_invalid/,
  );
  await assert.rejects(
    f.ha.notifyDevice(PHONE_A, {
      title: "x",
      message: "y",
      data: {
        tag: "hearth_0123456789abcdef",
        group: "hearth-approvals",
        actions: [{ action: "OPEN_DOOR", title: "Go" }],
      },
    }),
    /push_payload_invalid/,
  );
  // No model tool can reach the notifier: no Home tool mentions notify.
  const tools = haExtension(f.ha).tools!.map((tool) => tool.name);
  assert.ok(!tools.some((name) => /notif|push/i.test(name)));
  const src = new URL("../src/", import.meta.url);
  const users: string[] = [];
  for (const file of await readdir(src))
    if (
      file.endsWith(".ts") &&
      (await readFile(new URL(file, src), "utf8")).includes("notifyDevice")
    )
      users.push(file);
  assert.deepEqual(users.sort(), ["approval-push.ts", "ha.ts"]);
});

test("phone approvals: one-line headline never carries data values or secrets", () => {
  const redact = (value: string) =>
    value.split("synthetic-secret").join("[REDACTED]");
  assert.equal(
    actionHeadline(
      {
        kind: "service",
        domain: "lock",
        service: "unlock",
        target: { entity_id: ["lock.example_door"] },
        data: { code: "1234" },
      },
      redact,
    ),
    "lock.unlock lock.example_door",
  );
  assert.equal(
    actionHeadline(
      {
        kind: "todo",
        entityId: "todo.example",
        op: "rename",
        uid: "u1",
        summary: "private text",
        label: "old",
      },
      redact,
    ),
    "todo rename item on todo.example",
  );
  assert.equal(
    actionHeadline(
      {
        kind: "config",
        resource: "automation",
        op: "upsert",
        id: "synthetic-secret",
        body: { alias: "x" },
      },
      redact,
    ),
    "Write automation [REDACTED]",
  );
  assert.ok(
    actionHeadline({
      kind: "service",
      domain: "light",
      service: "turn_on",
      target: {
        entity_id: Array.from({ length: 20 }, (_, i) => `light.example_${i}`),
      },
      data: {},
    }).length <= 100,
  );
});

test("event subscriber: allowlisted frames only, subscribes to one event type and reconnects", async (t) => {
  const f = await fixture(t);
  await f.enroll();
  assert.throws(
    () =>
      sendAllowed(
        { send() {} },
        { type: "call_service" },
        HA_EVENT_SOCKET_TYPES,
      ),
    /ws_type_not_allowed/,
  );
  const subscribes = f.fake.frames.filter((m) => m.type === "subscribe_events");
  assert.ok(subscribes.length >= 1);
  for (const m of subscribes)
    assert.deepEqual(Object.keys(m).sort(), ["event_type", "id", "type"]);
  assert.equal(subscribes[0]!.event_type, "mobile_app_notification_action");
  // Drop the connection: it reconnects and re-subscribes.
  const first = f.fake.live[0]!;
  first.socket.onclose?.({});
  await until(
    () =>
      f.fake.frames.filter((m) => m.type === "subscribe_events").length >
      subscribes.length,
  );
  assert.ok(
    f.fake.frames.every(
      (m) =>
        (HA_EVENT_SOCKET_TYPES as readonly string[]).includes(String(m.type)) ||
        String(m.type).startsWith("config/"),
    ),
  );
  // Still works after reconnecting.
  await until(() => f.fake.live.length > 0);
  assert.ok(f.push.listening);
});

// HTTP: local mode (and ingress without the option) reports unavailable.
async function server(t: TestContext, cfg: Config) {
  const dir = await mkdtemp(join(tmpdir(), "hearth-push-http-"));
  const config = { ...cfg, dataDir: dir };
  const { models, model } = offline();
  const fake = fakeHA();
  const ha = new HAClient(
    TOKEN,
    config.policy,
    fake.transport,
    [],
    fake.socket,
  );
  ha.actions.authorizeOwners(config.authorizedUsers);
  const runtime = await Runtime.open(
    dir,
    models,
    model,
    [haExtension(ha)],
    [],
    undefined,
    ha.actions,
  );
  const app = appServer(config, runtime, new Actions(runtime, ha));
  app.server.prependListener("connection", (socket: Socket) =>
    Object.defineProperty(socket, "remoteAddress", { value: "172.30.32.2" }),
  );
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  config.origin = base;
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const identity = { "x-remote-user-id": OWNER_A };
  const boot = await fetch(`${base}/api/bootstrap`, { headers: identity });
  const csrf = (await boot.json()).csrf;
  const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
  return {
    get: (path: string) => fetch(`${base}${path}`, { headers: identity }),
    post: (path: string, value: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          ...identity,
          cookie,
          origin: base,
          "x-hearth-csrf": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(value),
      }),
  };
}
const ingress = (approvalNotifications: boolean): Config => ({
  mode: "ingress",
  host: "127.0.0.1",
  port: 8099,
  origin: "https://home.example",
  password: "",
  authorizedUsers: [OWNER_A],
  dataDir: "",
  provider: "offline",
  model: "test",
  approvalNotifications,
  selfSlug: "abc123_hearth_pi",
  policy: { enabled: true, entities: [LAMP], services: ["light.turn_on"] },
  haToken: TOKEN,
  apiKey: "",
});

test("HTTP: approval-push routes are owner-scoped, strict and unavailable without the option", async (t) => {
  const off = await server(t, ingress(false));
  const view = await (await off.get("/api/approval-push")).json();
  assert.equal(view.available, false);
  const refused = await off.post("/api/approval-push/enabled", {
    enabled: true,
    revision: 0,
  });
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), {
    error: "approval_notifications_unavailable",
  });
  const on = await server(t, ingress(true));
  const live = await (await on.get("/api/approval-push")).json();
  assert.equal(live.available, true);
  assert.deepEqual(
    live.candidates.map((c: { label: string }) => c.label),
    ["Example Phone A"],
  );
  const bad = await on.post("/api/approval-push/targets/add", {
    candidate: "not-hex",
    revision: 0,
  });
  assert.equal(bad.status, 400);
  const limit = await on.post("/api/approval-push/targets/remove", {
    id: "0123456789abcdef",
    revision: 0,
  });
  assert.equal(limit.status, 404);
});

test("approval_notifications: off by default, ingress only", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-push-config-"));
  const keys = [
    "HEARTH_MODE",
    "HEARTH_LOCAL_PASSWORD",
    "HEARTH_APPROVAL_NOTIFICATIONS",
  ];
  const previous = keys.map((key) => process.env[key]);
  t.after(async () => {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    await rm(dir, { recursive: true, force: true });
  });
  process.env.HEARTH_MODE = "ingress";
  const file = join(dir, "options.json");
  await writeFile(
    file,
    JSON.stringify({
      public_origin: "https://home.example",
      provider: "offline",
    }),
  );
  assert.equal((await loadConfig(file)).approvalNotifications, false);
  await writeFile(
    file,
    JSON.stringify({
      public_origin: "https://home.example",
      provider: "offline",
      approval_notifications: true,
    }),
  );
  assert.equal((await loadConfig(file)).approvalNotifications, true);
  process.env.HEARTH_MODE = "local";
  process.env.HEARTH_LOCAL_PASSWORD = "synthetic-local-password-123456";
  process.env.HEARTH_APPROVAL_NOTIFICATIONS = "true";
  await assert.rejects(
    loadConfig(file),
    /approval_notifications_requires_ingress/,
  );
});
