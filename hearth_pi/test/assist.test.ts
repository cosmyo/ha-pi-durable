import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  UserEntry,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { HAClient, haExtension } from "../src/ha.js";
import { Runtime } from "../src/runtime.js";
import {
  Inputs,
  Proposals,
  VoiceSessions,
  type Proposal,
} from "../src/documents.js";
import { FULL_ACKNOWLEDGEMENT } from "../src/home-actions.js";
import {
  ASSIST_SPEECH,
  Assist,
  VOICE_PROMPT,
  closingSentence,
  type AssistEnd,
  type AssistEvent,
} from "../src/assist.js";
import { CoreLink, CORE_LINK_SERVICE } from "../src/core-link.js";
import { appServer, coreServer } from "../src/server.js";
import { assistSatellites, loadConfig, type Config } from "../src/config.js";

const OWNER = "user-owner-a";
const OWNER_B = "user-owner-b";
const MEMBER = "user-member-c";
const GUEST = "user-guest-d";
const STRANGER = "user-not-authorized";
const SATELLITE = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const GUEST_SATELLITE = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
const UNMAPPED = "0123456789abcdef0123456789abcdef";
const TOKEN = "synthetic-supervisor-token";
const LAMP = "light.example_lamp";
const HOST = "abc12345-hearth-pi";
const turnOn = { service: "light.turn_on", entityId: LAMP, data: {} };

type Discovery = { url: string; auth: string; body: Record<string, unknown> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function faux() {
  const provider = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(provider.provider);
  return {
    faux: provider,
    models,
    model: { provider: provider.getModel().provider, modelId: "test" },
  };
}
// A response that waits until the model call is aborted (runtime close).
const hang: FauxResponseStep = (_context, options) =>
  new Promise((_resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) return reject(new Error("aborted"));
    signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

async function fixture(
  t: TestContext,
  options: {
    dir?: string;
    push?: { available: boolean; expedite: () => Promise<boolean> };
    turnWaitMs?: number;
    now?: () => number;
    logs?: string[];
    // Set before the runtime opens (a resumed run calls the model at once).
    responses?: FauxResponseStep[];
  } = {},
) {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "hearth-assist-")));
  const lights: string[] = [];
  const discovery: Discovery[] = [];
  const transport = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const full = String(url);
    if (init?.method === "POST") {
      lights.push(full);
      return Response.json([]);
    }
    if (full.endsWith("/api/services"))
      return Response.json([
        { domain: "light", services: { turn_on: {}, turn_off: {} } },
      ]);
    return Response.json({
      entity_id: LAMP,
      state: "off",
      attributes: { friendly_name: "Synthetic lamp" },
    });
  }) as typeof fetch;
  const supervisor = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    discovery.push({
      url: String(url),
      auth: String((init?.headers as Record<string, string>).Authorization),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json({ result: "ok", data: { uuid: "0".repeat(32) } });
  }) as typeof fetch;
  const provider = faux();
  if (options.responses) provider.faux.setResponses(options.responses);
  const ha = new HAClient(
    TOKEN,
    {
      enabled: true,
      entities: [LAMP],
      services: ["light.turn_on", "light.turn_off"],
    },
    transport,
  );
  ha.actions.authorizeOwners([OWNER, OWNER_B, MEMBER, GUEST], {
    [MEMBER]: "member",
    [GUEST]: "guest",
  });
  const secrets: string[] = [TOKEN];
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(ha)],
    secrets,
    undefined,
    ha.actions,
  );
  const logs = options.logs ?? [];
  const link = await CoreLink.open(dir, {
    supervisorToken: TOKEN,
    host: HOST,
    transport: supervisor,
    secrets,
    log: (line) => logs.push(line),
  });
  const assist = new Assist(runtime, ha.actions, {
    satellites: assistSatellites(
      [
        { device_id: SATELLITE, user_id: OWNER },
        { device_id: GUEST_SATELLITE, user_id: GUEST },
      ],
      [OWNER, OWNER_B, MEMBER, GUEST],
    ),
    ready: () => true,
    ...(options.push ? { push: options.push } : {}),
    turnWaitMs: options.turnWaitMs ?? 5000,
    pushWaitMs: 200,
    ...(options.now ? { now: options.now } : {}),
  });
  const core = coreServer(link, assist);
  await new Promise<void>((resolve) =>
    core.server.listen(0, "127.0.0.1", resolve),
  );
  const base = `http://127.0.0.1:${(core.server.address() as AddressInfo).port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await core.close();
    await ha.actions.close();
    await runtime.close();
  };
  t.after(async () => {
    await close();
    if (!options.dir) await rm(dir, { recursive: true, force: true });
  });
  const key = async () =>
    (await readFile(join(dir, "core-link.key"), "utf8")).trim();
  const raw = (
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string> },
  ) => fetch(`${base}${path}`, init);
  let n = 0;
  // One voice turn over the real listener; returns the parsed events.
  const say = async (
    words: string,
    who: {
      user_id?: string | null;
      device_id?: string | null;
      conversation_id?: string | null;
      request_id?: string;
      extra_system_prompt?: string | null;
      satellite_id?: string | null;
    } = { user_id: OWNER },
  ) => {
    const response = await raw("/core/v1/conversation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await key()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        api: 1,
        request_id:
          who.request_id ?? `01JTESTREQUEST${String(++n).padStart(8, "0")}`,
        text: words,
        user_id: who.user_id ?? null,
        conversation_id: who.conversation_id ?? null,
        device_id: who.device_id ?? null,
        satellite_id: who.satellite_id ?? null,
        language: "en",
        extra_system_prompt: who.extra_system_prompt ?? null,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    const events = (await response.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AssistEvent);
    assert.equal(events[0]!.type, "start");
    const end = events.at(-1) as AssistEnd;
    assert.equal(end.type, "end");
    const spoken = events
      .filter((e): e is { type: "delta"; text: string } => e.type === "delta")
      .map((e) => e.text)
      .join("");
    return { events, end, spoken };
  };
  const mode = async (value: "read-only" | "ask" | "full", owner = OWNER) => {
    const p = await ha.actions.settings(owner);
    await ha.actions.setMode(
      owner,
      value,
      p.revision,
      p.policy,
      value === "full" ? FULL_ACKNOWLEDGEMENT : undefined,
    );
  };
  const proposals = async (chat: number) =>
    Object.values(
      (await runtime.harness.snapshot(Proposals, chat as ConversationId, ctx))
        ?.items ?? {},
    );
  const voiceChats = async (owner = OWNER) =>
    (await runtime.list(owner)).filter((s) => s.title === "Voice");
  return {
    dir,
    ha,
    runtime,
    provider,
    link,
    core,
    base,
    key,
    raw,
    say,
    mode,
    lights,
    discovery,
    logs,
    secrets,
    proposals,
    voiceChats,
    close,
  };
}

test("assist listener: missing or wrong secret is 401, any Origin is 403, 8 KB cap, strict api 1", async (t) => {
  const f = await fixture(t);
  const body = JSON.stringify({
    api: 1,
    request_id: "01JTESTAUTH0000000001",
    text: "hello",
    user_id: OWNER,
    language: "en",
  });
  const post = (headers: Record<string, string>, value = body) =>
    f.raw("/core/v1/conversation", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: value,
    });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: "Bearer wrong" })).status, 401);
  assert.equal(
    (await post({ authorization: `Basic ${await f.key()}` })).status,
    401,
  );
  assert.equal(
    (await post({ authorization: `bearer ${await f.key()}` })).status,
    401,
  );
  // A browser request (any Origin) is refused even with the right secret.
  const good = { authorization: `Bearer ${await f.key()}` };
  assert.equal(
    (await post({ ...good, origin: "https://home.example" })).status,
    403,
  );
  assert.equal((await post({ ...good, origin: "null" })).status, 403);
  const large = JSON.stringify({
    api: 1,
    request_id: "01JTESTAUTH0000000002",
    text: "x".repeat(9000),
    user_id: OWNER,
    language: "en",
  });
  assert.equal((await post(good, large)).status, 413);
  assert.equal(
    (await post(good, body.replace('"api":1', '"api":2'))).status,
    400,
  );
  assert.equal(
    (await post(good, body.replace('"language"', '"cookie":1,"language"')))
      .status,
    400,
  );
  const info = await f.raw("/core/v1/info", { headers: good });
  assert.equal(info.status, 200);
  assert.deepEqual(await info.json(), {
    api: 1,
    ready: true,
    authenticated: true,
  });
  assert.equal(
    (await f.raw("/core/v1/info", { headers: { authorization: "Bearer x" } }))
      .status,
    401,
  );
  assert.equal(
    (await f.raw("/core/v1/info", { method: "POST", headers: good })).status,
    405,
  );
  assert.equal((await f.raw("/api/sessions", { headers: good })).status, 404);
  // Nothing was admitted by any refused request.
  assert.equal((await f.runtime.list(OWNER)).length, 0);
});

test("assist: unauthorized user, unmapped satellite, no speaker and automation turns are refused with speech", async (t) => {
  const f = await fixture(t);
  const cases: [Parameters<typeof f.say>[1], string][] = [
    [{ user_id: STRANGER }, ASSIST_SPEECH.notAuthorized],
    // A known but unauthorized user never borrows a mapped satellite.
    [{ user_id: STRANGER, device_id: SATELLITE }, ASSIST_SPEECH.notAuthorized],
    [{ device_id: UNMAPPED }, ASSIST_SPEECH.unknownSatellite],
    [{}, ASSIST_SPEECH.noSpeaker],
    [
      { device_id: SATELLITE, extra_system_prompt: "Ask about the door" },
      ASSIST_SPEECH.automation,
    ],
    [
      { user_id: OWNER, extra_system_prompt: "Automation text" },
      ASSIST_SPEECH.automation,
    ],
  ];
  for (const [who, speech] of cases) {
    const { end, spoken } = await f.say("Turn on the lamp", {
      user_id: null,
      ...who,
    });
    assert.equal(end.status, "refused");
    assert.equal(end.speech_suffix, speech);
    assert.equal(spoken, "");
  }
  for (const owner of [OWNER, OWNER_B, MEMBER, GUEST])
    assert.equal((await f.runtime.list(owner)).length, 0);
  assert.equal(f.provider.faux.state.callCount, 0);
});

test("assist: a mapped satellite on an owner with Full access files a pending Ask proposal, never auto-runs", async (t) => {
  const f = await fixture(t);
  await f.mode("full");
  f.provider.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ha_propose_service", turnOn), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Okay, the lamp."),
  ]);
  const { end, spoken } = await f.say("Turn on the lamp", {
    device_id: SATELLITE,
  });
  assert.equal(end.status, "done");
  assert.equal(spoken, "Okay, the lamp.");
  assert.equal(end.speech_suffix, "It's waiting for your approval in Hearth.");
  assert.deepEqual(end.proposals, [
    { risk: "low", status: "pending", notified: false },
  ]);
  const [chat] = await f.voiceChats();
  assert(chat);
  const [proposal] = await f.proposals(chat.id);
  assert.equal(proposal!.status, "pending");
  assert.equal(proposal!.authorization?.source, "human");
  assert.equal(proposal!.authorization?.mode, "ask");
  assert.equal(proposal!.authorization?.channel, "satellite");
  assert.equal(f.lights.length, 0);
  // The input carries the channel and its Ask ceiling.
  const [input] = Object.values(
    (await f.runtime.harness.snapshot(Inputs, chat.id as ConversationId, ctx))!
      .requests,
  );
  assert.equal(input!.channel, "satellite");
  assert.equal(input!.ceiling, "ask");
  assert.equal(input!.homePermission?.mode, "full");
  // Saying "yes" by voice never approves anything.
  f.provider.faux.setResponses([fauxAssistantMessage("Please use Hearth.")]);
  const yes = await f.say("yes", { device_id: SATELLITE });
  assert.equal(yes.end.status, "done");
  assert.equal((await f.proposals(chat.id))[0]!.status, "pending");
  assert.equal(f.lights.length, 0);
  // The person approves on the exact card: it runs once, within the grant.
  await f.ha.actions.decide(
    OWNER,
    chat.id,
    proposal!.id,
    proposal!.hash,
    "approve",
  );
  assert.equal((await f.proposals(chat.id))[0]!.status, "accepted");
  assert.equal(f.lights.length, 1);
});

test("assist: a satellite turn that carries an owner's context still uses the mapping and the Ask ceiling", async (t) => {
  const f = await fixture(t);
  await f.mode("full");
  f.provider.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ha_propose_service", turnOn), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Okay, the lamp."),
  ]);
  // Home Assistant attached the owner's context (e.g. follow-up speech after
  // start_conversation from the owner's dashboard): anyone in the room speaks.
  const { end } = await f.say("Turn on the lamp", {
    user_id: OWNER,
    device_id: SATELLITE,
  });
  assert.equal(end.status, "done");
  const [chat] = await f.voiceChats();
  assert(chat);
  const [proposal] = await f.proposals(chat.id);
  assert.equal(proposal!.status, "pending");
  assert.equal(proposal!.authorization?.mode, "ask");
  assert.equal(proposal!.authorization?.channel, "satellite");
  assert.equal(f.lights.length, 0);
  // A satellite that is not mapped is refused even with an owner's context.
  const unmapped = await f.say("Turn on the lamp", {
    user_id: OWNER,
    device_id: "0123456789abcdef0123456789abcdee",
    satellite_id: "assist_satellite.example",
  });
  assert.equal(unmapped.end.status, "refused");
  assert.equal(f.lights.length, 0);
});

test("assist: the HA app Assist button keeps the person's own permissions and household role", async (t) => {
  const f = await fixture(t);
  await f.mode("full");
  f.provider.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ha_propose_service", turnOn), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Done."),
  ]);
  const owner = await f.say("Turn on the lamp", { user_id: OWNER });
  assert.equal(owner.end.speech_suffix, "Home Assistant accepted the change.");
  assert.deepEqual(owner.end.proposals, [
    { risk: "low", status: "accepted", notified: false },
  ]);
  const [chat] = await f.voiceChats();
  const [receipt] = await f.proposals(chat!.id);
  assert.equal(receipt!.authorization?.source, "automatic");
  assert.equal(receipt!.authorization?.channel, "assist");
  assert.equal(f.lights.length, 1);
  // A guest stays read-only by voice too, through a satellite as well.
  for (const who of [{ user_id: GUEST }, { device_id: GUEST_SATELLITE }]) {
    f.provider.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ha_propose_service", turnOn), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("I can't change that."),
    ]);
    const guest = await f.say("Turn on the lamp", who);
    assert.equal(guest.end.status, "done");
    assert.deepEqual(guest.end.proposals, []);
  }
  const [guestChat] = await f.voiceChats(GUEST);
  assert.equal((await f.proposals(guestChat!.id)).length, 0);
  assert.equal(f.lights.length, 1);
  // A member asks; Full is not available to members.
  f.provider.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ha_propose_service", turnOn), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Asked."),
  ]);
  const member = await f.say("Turn on the lamp", { user_id: MEMBER });
  assert.deepEqual(member.end.proposals, [
    { risk: "low", status: "pending", notified: false },
  ]);
  assert.equal(f.lights.length, 1);
});

test("assist: Read-only stays read-only and Ask stays Ask through a satellite", async (t) => {
  const f = await fixture(t);
  await f.mode("read-only");
  f.provider.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ha_propose_service", turnOn), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Home is read-only."),
  ]);
  const readOnly = await f.say("Turn on the lamp", { device_id: SATELLITE });
  assert.deepEqual(readOnly.end.proposals, []);
  await f.mode("ask");
  f.provider.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ha_propose_service", turnOn), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Asked."),
  ]);
  const ask = await f.say("Turn on the lamp", { device_id: SATELLITE });
  assert.deepEqual(ask.end.proposals, [
    { risk: "low", status: "pending", notified: false },
  ]);
  assert.equal(f.lights.length, 0);
});

test("assist: a repeated request id never runs twice; conversations map to the rolling Voice chat and expire", async (t) => {
  let now = 1_800_000_000_000;
  const f = await fixture(t, { now: () => now });
  f.provider.faux.setResponses([fauxAssistantMessage("It is off.")]);
  const first = await f.say("Is the lamp on?", {
    user_id: OWNER,
    request_id: "01JTESTREPEAT00000001",
    conversation_id: "01JCONVERSATIONA00001",
  });
  assert.equal(first.spoken, "It is off.");
  const again = await f.say("Is the lamp on?", {
    user_id: OWNER,
    request_id: "01JTESTREPEAT00000001",
    conversation_id: "01JCONVERSATIONA00001",
  });
  assert.equal(again.end.status, "done");
  assert.equal(again.spoken, "It is off.");
  assert.equal(f.provider.faux.state.callCount, 1);
  const chats = await f.voiceChats();
  assert.equal(chats.length, 1);
  const entries = (
    await (await f.runtime.harness.conversation(
      chats[0]!.id as ConversationId,
      ctx,
    ))!.context(ctx)
  ).entries;
  assert.equal(entries.filter((e) => UserEntry.is(e)).length, 1);
  // Another person reusing that request id is refused, not re-run.
  const other = await f.say("Is the lamp on?", {
    user_id: OWNER_B,
    request_id: "01JTESTREPEAT00000001",
  });
  assert.equal(other.end.status, "refused");
  assert.equal(other.end.speech_suffix, ASSIST_SPEECH.alreadyHandled);
  assert.equal((await f.voiceChats(OWNER_B)).length, 0);
  // Owner B using owner A's conversation id gets B's own chat.
  f.provider.faux.setResponses([fauxAssistantMessage("Hello B.")]);
  await f.say("Hello", {
    user_id: OWNER_B,
    conversation_id: "01JCONVERSATIONA00001",
  });
  const [chatB] = await f.voiceChats(OWNER_B);
  assert(chatB && chatB.id !== chats[0]!.id);
  // The mapping is durable and expires after about five minutes.
  let sessions = await f.runtime.harness.snapshot(VoiceSessions, ctx);
  assert.equal(
    sessions!.conversations["c_01JCONVERSATIONA00001"]!.expires,
    now + 300000,
  );
  now += 301000;
  f.provider.faux.setResponses([fauxAssistantMessage("Still off.")]);
  await f.say("And now?", {
    user_id: OWNER,
    conversation_id: "01JCONVERSATIONB00002",
  });
  sessions = await f.runtime.harness.snapshot(VoiceSessions, ctx);
  assert.equal(sessions!.conversations["c_01JCONVERSATIONA00001"], undefined);
  assert(sessions!.conversations["c_01JCONVERSATIONB00002"]);
  // One rolling Voice chat per person.
  assert.equal((await f.voiceChats()).length, 1);
});

test("assist: a full Voice chat rolls over to the next one", async (t) => {
  const f = await fixture(t);
  f.provider.faux.setResponses([fauxAssistantMessage("First.")]);
  await f.say("Hello");
  const [full] = await f.voiceChats();
  await f.runtime.harness.commit(async (tx) => {
    const inputs = await tx.doc(Inputs, full!.id as ConversationId);
    for (let i = 0; i < 199; i++)
      inputs.requests[`filler-request-${i}`] = {
        hash: "0",
        content: "filler",
        submissionId: 1,
        admitted: 1,
      };
  }, ctx);
  f.provider.faux.setResponses([fauxAssistantMessage("Next chat.")]);
  const next = await f.say("Hello again");
  assert.equal(next.end.status, "done");
  assert.equal(next.spoken, "Next chat.");
  const chats = await f.voiceChats();
  assert.equal(chats.length, 2);
  const sessions = await f.runtime.harness.snapshot(VoiceSessions, ctx);
  assert.equal(
    Object.values(sessions!.owners)[0]!.chat,
    chats.find((c) => c.id !== full!.id)!.id,
  );
});

test("assist: busy, capacity and the unknown-outcome pause each produce speech", async (t) => {
  const f = await fixture(t, { turnWaitMs: 150 });
  f.provider.faux.setResponses([hang]);
  const slow = await f.say("Think hard");
  assert.equal(slow.end.status, "still_working");
  assert.equal(slow.end.speech_suffix, ASSIST_SPEECH.stillWorking);
  const busy = await f.say("Anything else?");
  assert.equal(busy.end.status, "busy");
  assert.equal(busy.end.speech_suffix, ASSIST_SPEECH.sessionBusy);
  // Fill the installation's concurrent-chat capacity.
  f.provider.faux.appendResponses([hang, hang, hang]);
  for (let i = 0; i < 3; i++) {
    const id = await f.runtime.create(OWNER_B, `Busy ${i}`, `busy-create-${i}`);
    await f.runtime.submit(OWNER_B, id, `busy-input-${i}`, "Wait");
  }
  await sleep(50);
  const capacity = await f.say("Hello", { user_id: MEMBER });
  assert.equal(capacity.end.status, "busy");
  assert.equal(capacity.end.speech_suffix, ASSIST_SPEECH.capacity);
  for (const s of await f.runtime.harness
    .inspect(ctx)
    .then((i) => i.tasks.map((task) => task.record.conversationId)))
    await (await f.runtime.harness.conversation(s, ctx))?.abort(ctx);
  // An unknown outcome pauses Home writes; voice says so.
  const [chat] = await f.voiceChats();
  await f.runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(Proposals, chat!.id as ConversationId);
    doc.items["999"] = {
      id: "999",
      action: turnOn,
      hash: "0".repeat(64),
      policy: "p",
      created: 1,
      expires: 2,
      status: "unknown",
      decidedBy: OWNER,
      decidedAt: 1,
      resolution: "",
    };
  }, ctx);
  f.provider.faux.setResponses([fauxAssistantMessage("It is off.")]);
  const paused = await f.say("Is the lamp on?", { user_id: OWNER_B });
  assert.equal(paused.end.status, "done");
  assert.equal(paused.end.speech_suffix, ASSIST_SPEECH.blocked);
});

test("assist: the closing sentence speaks a phone push only when it was actually sent", async (t) => {
  for (const [delivered, expected] of [
    [true, "I've asked for approval on your phone."],
    [false, "It's waiting for your approval in Hearth."],
  ] as const) {
    let calls = 0;
    const f = await fixture(t, {
      push: {
        available: true,
        expedite: async () => {
          calls++;
          return delivered;
        },
      },
    });
    f.provider.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ha_propose_service", turnOn), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Okay."),
    ]);
    const { end } = await f.say("Turn on the lamp", { device_id: SATELLITE });
    assert.equal(end.speech_suffix, expected);
    assert.equal(end.proposals[0]!.notified, delivered);
    assert.equal(calls, 1);
  }
  // A push that never answers in time is not claimed.
  const f = await fixture(t, {
    push: { available: true, expedite: () => new Promise(() => {}) },
  });
  f.provider.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ha_propose_service", turnOn), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Okay."),
  ]);
  const { end } = await f.say("Turn on the lamp", { device_id: SATELLITE });
  assert.equal(end.speech_suffix, "It's waiting for your approval in Hearth.");
});

test("assist: closing sentences come from real receipts", () => {
  const p = (
    id: string,
    status: Proposal["status"],
    level: "low" | "high" = "low",
  ) =>
    ({
      id,
      status,
      risk: { level, rule: "r", reasons: [] },
    }) as unknown as Proposal;
  assert.equal(closingSentence([], new Set(), false), "");
  assert.equal(closingSentence([], new Set(), true), ASSIST_SPEECH.blocked);
  assert.equal(
    closingSentence([p("1", "accepted")], new Set(), true),
    "Home Assistant accepted the change.",
  );
  assert.equal(
    closingSentence([p("1", "failed")], new Set(), false),
    "That change failed.",
  );
  assert.match(
    closingSentence([p("1", "unknown")], new Set(), false),
    /couldn't confirm whether it happened/,
  );
  assert.equal(
    closingSentence([p("1", "pending", "high")], new Set(["1"]), false),
    "I've sent it to your phone; approve it in Hearth.",
  );
  assert.equal(
    closingSentence(
      [p("1", "pending"), p("2", "pending")],
      new Set(["1"]),
      false,
    ),
    "I've asked for approval on your phone. One change is waiting for your approval in Hearth.",
  );
  assert.equal(
    closingSentence([p("1", "rejected")], new Set(), false),
    "No change was made.",
  );
  // A receipt never claims more than it says.
  assert.doesNotMatch(
    closingSentence([p("1", "pending")], new Set(), false),
    /phone/,
  );
});

test("assist: the voice prompt asks for short spoken replies only while a voice input is newest", async (t) => {
  const f = await fixture(t);
  const prompts: string[] = [];
  f.provider.faux.setResponses([
    (context) => {
      prompts.push(JSON.stringify(context.messages));
      return fauxAssistantMessage("Short.");
    },
  ]);
  await f.say("What's up?");
  assert.match(prompts[0]!, /<voice>/);
  assert(prompts[0]!.includes(VOICE_PROMPT));
  const home = await f.runtime.create(OWNER, "Home", "create-home-typed");
  f.provider.faux.setResponses([
    (context) => {
      prompts.push(JSON.stringify(context.messages));
      return fauxAssistantMessage("Typed.");
    },
  ]);
  const sid = await f.runtime.submit(OWNER, home, "typed-input-1", "Hi");
  await (await f.runtime.harness.submission(sid as never, ctx))!.wait(ctx);
  assert.doesNotMatch(prompts[1]!, /<voice>/);
});

test("assist: streamed text arrives as deltas and matches the committed answer", async (t) => {
  const f = await fixture(t);
  const long =
    "The lamp in the study is off and the window sensor reads closed right now.";
  f.provider.faux.setResponses([fauxAssistantMessage(long)]);
  const { events, spoken } = await f.say("Status?");
  assert.equal(spoken, long);
  assert(events.filter((e) => e.type === "delta").length >= 1);
  const [chat] = await f.voiceChats();
  const entries = (
    await (await f.runtime.harness.conversation(
      chat!.id as ConversationId,
      ctx,
    ))!.context(ctx)
  ).entries;
  assert.equal(entries.filter((e) => AssistantEntry.is(e)).length, 1);
});

test("assist: a restart mid-turn resumes durably; voice said still_working and the same request then answers once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-assist-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await fixture(t, { dir, turnWaitMs: 150 });
  first.provider.faux.setResponses([hang]);
  const request = { user_id: OWNER, request_id: "01JTESTRESTART0000001" };
  const before = await first.say("Check everything", request);
  assert.equal(before.end.status, "still_working");
  await first.close();
  const second = await fixture(t, {
    dir,
    turnWaitMs: 5000,
    responses: [fauxAssistantMessage("All checked.")],
  });
  const after = await second.say("Check everything", request);
  assert.equal(after.end.status, "done");
  assert.equal(after.spoken, "All checked.");
  const chats = await second.voiceChats();
  assert.equal(chats.length, 1);
  const entries = (
    await (await second.runtime.harness.conversation(
      chats[0]!.id as ConversationId,
      ctx,
    ))!.context(ctx)
  ).entries;
  assert.equal(entries.filter((e) => UserEntry.is(e)).length, 1);
});

test("core link: 0600 secret, published to discovery as {host, port, api, token}, rotation; never logged or in snapshots", async (t) => {
  const logs: string[] = [];
  const console_ = {
    info: console.info,
    error: console.error,
    log: console.log,
  };
  const captured: string[] = [];
  for (const name of ["info", "error", "log"] as const)
    console[name] = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
  t.after(() => Object.assign(console, console_));
  const f = await fixture(t, { logs });
  const first = await f.key();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await stat(join(f.dir, "core-link.key"))).mode & 0o777, 0o600);
  assert(f.secrets.includes(first));
  assert.equal(await f.link.publish(), true);
  assert.equal(f.discovery.length, 1);
  assert.equal(f.discovery[0]!.url, "http://supervisor/discovery");
  assert.equal(f.discovery[0]!.auth, `Bearer ${TOKEN}`);
  assert.deepEqual(f.discovery[0]!.body, {
    service: CORE_LINK_SERVICE,
    config: { host: HOST, port: 8098, api: 1, token: first },
  });
  assert.equal(f.link.status().published, true);
  // Spoken text and the snapshot as served (redacted like every API
  // response) never contain the secret, even if a model repeated it.
  f.provider.faux.setResponses([fauxAssistantMessage(`Secret ${first} here`)]);
  const { spoken } = await f.say("Say the secret");
  assert(!spoken.includes(first));
  assert.match(spoken, /\[REDACTED\]/);
  const [chat] = await f.voiceChats();
  const snapshot = f.runtime.redact(
    JSON.stringify(await f.runtime.snapshot(OWNER, chat!.id)),
  );
  assert(!snapshot.includes(first));
  // Rotation: new secret on disk (0600), old one refused, new one published.
  const status = await f.link.rotate();
  assert(status.rotatedAt > 0);
  const second = await f.key();
  assert.notEqual(second, first);
  assert.equal((await stat(join(f.dir, "core-link.key"))).mode & 0o777, 0o600);
  assert.equal(
    (
      await f.raw("/core/v1/info", {
        headers: { authorization: `Bearer ${first}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.raw("/core/v1/info", {
        headers: { authorization: `Bearer ${second}` },
      })
    ).status,
    200,
  );
  assert.equal(
    (f.discovery.at(-1)!.body.config as { token: string }).token,
    second,
  );
  for (const line of [...logs, ...captured]) {
    assert(!line.includes(first), line);
    assert(!line.includes(second), line);
    assert(!line.includes(TOKEN), line);
  }
  assert(logs.some((l) => /published through Supervisor discovery/.test(l)));
  // A reopened link keeps the stored secret.
  const again = await CoreLink.open(f.dir, {
    supervisorToken: TOKEN,
    host: HOST,
    log: () => {},
  });
  assert(again.verify(`Bearer ${second}`));
  assert(!again.verify(`Bearer ${first}`));
  // A damaged key file is replaced, never trusted.
  await writeFile(join(f.dir, "core-link.key"), "short");
  const replaced = await CoreLink.open(f.dir, {
    supervisorToken: TOKEN,
    host: HOST,
    log: () => {},
  });
  assert(!replaced.verify("Bearer short"));
  assert.match(await f.key(), /^[A-Za-z0-9_-]{43}$/);
});

test("core link: a failed discovery is reported without the secret and retried", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-link-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logs: string[] = [];
  let calls = 0;
  const link = await CoreLink.open(dir, {
    supervisorToken: TOKEN,
    host: HOST,
    transport: (async () => {
      calls++;
      if (calls === 1) throw new Error(`boom ${TOKEN}`);
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    log: (line) => logs.push(line),
  });
  link.start(3, 10);
  const end = Date.now() + 2000;
  while (!link.status().published && Date.now() < end) await sleep(5);
  link.stop();
  assert.equal(link.status().published, true);
  assert.equal(calls, 2);
  assert.match(logs[0]!, /could not publish/);
  assert(!logs.join("\n").includes(TOKEN));
});

test("config: assist options are validated; satellites map only to authorized users", async (t) => {
  assert.deepEqual(
    assistSatellites([{ device_id: SATELLITE, user_id: OWNER }], [OWNER]),
    [{ deviceId: SATELLITE, userId: OWNER }],
  );
  assert.throws(
    () =>
      assistSatellites([{ device_id: SATELLITE, user_id: STRANGER }], [OWNER]),
    /assist_satellite_user_not_authorized/,
  );
  assert.throws(
    () =>
      assistSatellites(
        [
          { device_id: SATELLITE, user_id: OWNER },
          { device_id: SATELLITE, user_id: OWNER },
        ],
        [OWNER],
      ),
    /invalid_assist_satellites/,
  );
  assert.throws(
    () => assistSatellites([{ device_id: "bad id!", user_id: OWNER }], [OWNER]),
    /invalid_assist_satellites/,
  );
  assert.throws(
    () =>
      assistSatellites(
        [{ device_id: SATELLITE, user_id: OWNER, extra: 1 }],
        [OWNER],
      ),
    /invalid_assist_satellites/,
  );
  const dir = await mkdtemp(join(tmpdir(), "hearth-assist-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "options.json");
  const previous = process.env.HEARTH_MODE;
  t.after(() => {
    if (previous === undefined) delete process.env.HEARTH_MODE;
    else process.env.HEARTH_MODE = previous;
  });
  process.env.HEARTH_MODE = "ingress";
  const base = {
    authorized_user_ids: [OWNER],
    service_actions_enabled: false,
    allowed_services: [],
    allowed_entities: [],
    public_origin: "https://home.example",
    provider: "offline",
    model: "",
  };
  await writeFile(file, JSON.stringify(base));
  const off = await loadConfig(file);
  assert.equal(off.assistEnabled, false);
  assert.deepEqual(off.assistSatellites, []);
  await writeFile(
    file,
    JSON.stringify({
      ...base,
      assist_enabled: true,
      assist_satellites: [{ device_id: SATELLITE, user_id: OWNER }],
    }),
  );
  const on = await loadConfig(file);
  assert.equal(on.assistEnabled, true);
  assert.deepEqual(on.assistSatellites, [
    { deviceId: SATELLITE, userId: OWNER },
  ]);
  await writeFile(
    file,
    JSON.stringify({
      ...base,
      assist_enabled: true,
      assist_satellites: [{ device_id: SATELLITE, user_id: STRANGER }],
    }),
  );
  await assert.rejects(
    loadConfig(file),
    /assist_satellite_user_not_authorized/,
  );
  process.env.HEARTH_MODE = "local";
  const local = process.env.HEARTH_LOCAL_PASSWORD;
  process.env.HEARTH_LOCAL_PASSWORD = "synthetic-local-password-0001";
  t.after(() => {
    if (local === undefined) delete process.env.HEARTH_LOCAL_PASSWORD;
    else process.env.HEARTH_LOCAL_PASSWORD = local;
  });
  assert.equal((await loadConfig(file)).assistEnabled, false);
});

test("HTTP: Settings shows Assist status without the secret; only owners rotate it, with confirmation", async (t) => {
  const f = await fixture(t);
  const before = await f.key();
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
    policy: { enabled: true, entities: [LAMP], services: ["light.turn_on"] },
    haToken: TOKEN,
    apiKey: "",
  };
  const serve = async (coreLink?: CoreLink) => {
    const app = appServer(
      config,
      f.runtime,
      {
        engine: f.ha.actions,
        decide: () => Promise.resolve(),
        close: () => Promise.resolve(),
      } as never,
      { ...(coreLink ? { coreLink } : {}), secrets: f.secrets },
    );
    await new Promise<void>((resolve) =>
      app.server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    t.after(
      () => new Promise<void>((resolve) => app.server.close(() => resolve())),
    );
    t.after(() => app.server.closeAllConnections());
    config.origin = base;
    const authorization = `Basic ${Buffer.from(`hearth:${config.password}`).toString("base64")}`;
    const boot = await fetch(`${base}/api/bootstrap`, {
      headers: { authorization },
    });
    const csrf = (await boot.json()).csrf as string;
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const get = (path: string) =>
      fetch(`${base}${path}`, { headers: { authorization } });
    const post = (path: string, value: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          authorization,
          cookie,
          origin: base,
          "x-hearth-csrf": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(value),
      });
    return { get, post };
  };
  const on = await serve(f.link);
  const status = await (await on.get("/api/assist")).text();
  assert(!status.includes(before));
  assert.equal(JSON.parse(status).enabled, true);
  assert.equal((await on.post("/api/assist/rotate", {})).status, 400);
  const rotated = await on.post("/api/assist/rotate", { confirm: true });
  assert.equal(rotated.status, 200);
  const text = await rotated.text();
  const after = await f.key();
  assert.notEqual(after, before);
  assert(!text.includes(after) && !text.includes(before));
  assert(JSON.parse(text).link.rotatedAt > 0);
  const off = await serve();
  assert.equal((await (await off.get("/api/assist")).json()).enabled, false);
  assert.equal(
    (await off.post("/api/assist/rotate", { confirm: true })).status,
    409,
  );
});
