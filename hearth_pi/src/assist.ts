// Hearth Assist: Home Assistant's conversation agent (the hearth_pi custom
// integration) talks to Hearth over the separate Core listener (server.ts
// coreServer, authenticated by the link secret in core-link.ts). This file
// decides who is speaking, which chat the words go to, and what Hearth's
// controller itself says at the end of a voice turn.
//
// Who is speaking (owner decisions, v1):
// - context.user_id of an authorized Home Assistant user (the Assist button
//   in the HA app or frontend): that person, with their normal Home
//   permissions and household role;
// - otherwise a satellite device in the admin-set `assist_satellites` map:
//   the mapped person, with an Ask ceiling (never Full; home-actions.ts);
// - anything else is refused with a short spoken line, including turns with
//   no user and no mapped satellite (for example automations) and turns that
//   carry an automation's extra system prompt.
// Voice never approves anything: approvals happen on the exact card in
// Hearth or from a confirmed phone (approval-push.ts).
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  section,
  watchEvents,
  type AgentEvent,
  type AgentEventStream,
  type ConversationId,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import {
  Inputs,
  Proposals,
  VoiceSessions,
  type InputChannel,
  type Proposal,
} from "./documents.js";
import type { AssistSatellite } from "./config.js";
import { ASSIST_DEVICE_PATTERN } from "./config.js";
import type { HomeActions } from "./home-actions.js";
import type { ApprovalPush } from "./approval-push.js";
import type { Runtime } from "./runtime.js";
import { ownerKey } from "./memory.js";
import { Fault, Serial, digest, insist, object, text } from "./safety.js";

export const ASSIST_API = 1;
export const ASSIST_LIMITS = Object.freeze({
  // Total time a voice request waits for the turn before still_working.
  turnWaitMs: 22000,
  // Extra time a pending proposal's phone send may take before speaking.
  pushWaitMs: 3000,
  // A Home Assistant conversation keeps its Voice chat this long.
  conversationMs: 300000,
  conversations: 200,
  requests: 500,
  requestMs: 3600000,
  perOwnerPerMinute: 20,
  refusedPerMinute: 60,
  concurrent: 4,
  text: 2000,
});
export const VOICE_CHAT_TITLE = "Voice";
// Fixed spoken lines. The controller writes them; a model never does.
export const ASSIST_SPEECH = Object.freeze({
  notAuthorized: "Sorry, you're not set up to use Hearth.",
  unknownSatellite:
    "Sorry, this device isn't linked to anyone in Hearth yet. An owner can map it in the App configuration.",
  noSpeaker: "Sorry, Hearth needs to know who is speaking.",
  automation: "Sorry, Hearth doesn't take requests started by automations yet.",
  notReady:
    "Hearth's model isn't connected right now. Check Hearth's Account settings.",
  sessionBusy: "I'm still working on your last request.",
  capacity: "Hearth is busy right now. Please try again in a moment.",
  rateLimited: "That's a lot of requests. Please wait a minute.",
  sessionLimit:
    "You have too many chats in Hearth. Delete one in Hearth, then try again.",
  alreadyHandled: "That request was already handled.",
  failed: "Sorry, something went wrong in Hearth.",
  stillWorking:
    "I'm still working on that. The result will be in your Voice chat in Hearth.",
  unanswered: "Sorry, I couldn't finish that. Check your Voice chat in Hearth.",
  blocked:
    "Home changes are paused until an earlier unknown result is checked in Hearth.",
});

export type AssistEnd = {
  type: "end";
  status: "done" | "still_working" | "refused" | "busy";
  speech_suffix: string;
  continue_conversation: boolean;
  proposals: { risk: string; status: string; notified: boolean }[];
};
export type AssistEvent =
  | { type: "start" }
  | { type: "delta"; text: string }
  | AssistEnd;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_PATTERN = /^[A-Za-z0-9_-]{8,72}$/;
const LANGUAGE_PATTERN = /^(\*|[A-Za-z0-9_-]{1,20})$/;
export type AssistRequest = {
  requestId: string;
  text: string;
  userId: string | null;
  conversationId: string | null;
  deviceId: string | null;
  satelliteId: string | null;
  language: string;
  extraSystemPrompt: string | null;
};
const nullable = (
  value: unknown,
  check: (value: string) => boolean,
): string | null => {
  if (value === null || value === undefined) return null;
  insist(typeof value === "string" && check(value), "invalid_request");
  return value;
};
// The one request shape (api 1). Unknown fields are refused.
export function parseAssistRequest(value: unknown): AssistRequest {
  const v = object(value, [
    "api",
    "request_id",
    "text",
    "user_id",
    "conversation_id",
    "device_id",
    "satellite_id",
    "language",
    "extra_system_prompt",
  ]);
  insist(v.api === ASSIST_API, "unsupported_api", 400);
  const requestId = text(v.request_id, 72, 8);
  insist(REQUEST_PATTERN.test(requestId));
  const words = text(v.text, ASSIST_LIMITS.text, 1);
  insist(words.trim().length > 0);
  const language = text(v.language ?? "*", 20);
  insist(LANGUAGE_PATTERN.test(language));
  const extra = nullable(v.extra_system_prompt, (s) => s.length <= 8000);
  return {
    requestId,
    text: words.trim(),
    userId: nullable(v.user_id, (s) => /^[a-zA-Z0-9_-]{1,100}$/.test(s)),
    conversationId: nullable(v.conversation_id, (s) => ID_PATTERN.test(s)),
    deviceId: nullable(v.device_id, (s) => ASSIST_DEVICE_PATTERN.test(s)),
    satelliteId: nullable(v.satellite_id, (s) =>
      /^[a-z][a-z0-9_]*\.[a-z0-9_]{1,100}$/.test(s),
    ),
    language,
    extraSystemPrompt: extra && extra.trim() ? extra : null,
  };
}

export type Speaker =
  | { kind: "person"; owner: string; channel: InputChannel; ceiling?: "ask" }
  | { kind: "refused"; speech: string };
// Owner resolution, in order. A user id that is present but not authorized
// is refused outright: a satellite map never lends someone else's identity
// to a known, unauthorized Home Assistant user.
export function resolveSpeaker(
  request: AssistRequest,
  authorized: (user: string) => boolean,
  satellites: readonly AssistSatellite[],
): Speaker {
  if (request.extraSystemPrompt)
    return { kind: "refused", speech: ASSIST_SPEECH.automation };
  if (request.userId && !authorized(request.userId))
    return { kind: "refused", speech: ASSIST_SPEECH.notAuthorized };
  // A turn from a satellite always speaks as the mapped person with the Ask
  // ceiling, even when Home Assistant attaches a user's context to it (follow-up
  // speech after start_conversation/announce inherits the caller's context, and
  // anyone in the room can speak).
  const mapped = request.deviceId
    ? satellites.find((s) => s.deviceId === request.deviceId)
    : undefined;
  if (request.satelliteId || mapped) {
    if (mapped && authorized(mapped.userId))
      return {
        kind: "person",
        owner: mapped.userId,
        channel: "satellite",
        ceiling: "ask",
      };
    return { kind: "refused", speech: ASSIST_SPEECH.unknownSatellite };
  }
  if (request.userId)
    return { kind: "person", owner: request.userId, channel: "assist" };
  if (request.deviceId)
    return { kind: "refused", speech: ASSIST_SPEECH.unknownSatellite };
  return { kind: "refused", speech: ASSIST_SPEECH.noSpeaker };
}

// Follows the live assistant text of a run from durable agent events and
// passes on only text that was not spoken yet. Text can arrive in the
// message_start partial, as text_start/text_delta changes, or as a whole
// block or message; each assistant message is tracked per content block and
// only the new suffix is emitted. A rewrite (text that no longer extends what
// was spoken) or a replayed snapshot stops streaming; the controller then
// sends the committed answer's continuation, if any, at the end.
export function speechTracker(
  emit: (text: string) => void,
  desync: () => void,
): (event: AgentEvent) => void {
  let blocks = new Map<number, string>();
  let spoken = "";
  let assistant = false;
  const load = (content: readonly unknown[]) => {
    blocks = new Map();
    content.forEach((block, index) => {
      const b = block as { type?: string; text?: unknown };
      if (b.type === "text" && typeof b.text === "string")
        blocks.set(index, b.text);
    });
  };
  const flush = () => {
    const now = [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1])
      .join("");
    if (!now.startsWith(spoken)) return desync();
    const added = now.slice(spoken.length);
    if (!added) return;
    spoken = now;
    emit(added);
  };
  return (event) => {
    if (event.type === "snapshot") return desync();
    if (event.type === "message_start") {
      const message = event.message as { role?: string; content?: unknown };
      assistant = message.role === "assistant";
      spoken = "";
      blocks = new Map();
      if (assistant && Array.isArray(message.content)) load(message.content);
      if (assistant) flush();
      return;
    }
    if (event.type !== "message_update" || !assistant) return;
    for (const change of event.changes) {
      if (change.type === "text_start" || change.type === "block") {
        if (change.block.type === "text")
          blocks.set(change.contentIndex, change.block.text ?? "");
      } else if (change.type === "text_delta")
        blocks.set(
          change.contentIndex,
          (blocks.get(change.contentIndex) ?? "") + change.delta,
        );
      else if (change.type === "message")
        load(change.message.content as readonly unknown[]);
    }
    flush();
  };
}

// The words the controller adds after a voice turn, from the real proposals
// and receipts of that turn. `pushed` holds the proposals whose phone
// notification Home Assistant actually accepted; nothing else may be called
// a push.
export function closingSentence(
  proposals: readonly Proposal[],
  pushed: ReadonlySet<string>,
  blocked: boolean,
): string {
  const pending = proposals.filter((p) => p.status === "pending");
  const parts: string[] = [];
  if (pending.length) {
    const sent = pending.filter((p) => pushed.has(p.id));
    const unsent = pending.length - sent.length;
    const highSent = sent.some(
      (p) => p.risk?.level === "high" || p.risk?.level === "critical",
    );
    if (sent.length)
      parts.push(
        highSent
          ? "I've sent it to your phone; approve it in Hearth."
          : "I've asked for approval on your phone.",
      );
    if (unsent)
      parts.push(
        unsent === 1 && !sent.length
          ? "It's waiting for your approval in Hearth."
          : `${unsent === 1 ? "One change is" : `${unsent} changes are`} waiting for your approval in Hearth.`,
      );
  }
  const count = (status: Proposal["status"]) =>
    proposals.filter((p) => p.status === status).length;
  const accepted = count("accepted");
  const failed = count("failed");
  const unknown = count("unknown") + count("dispatching");
  const rejected = count("rejected");
  if (accepted)
    parts.push(
      accepted === 1
        ? "Home Assistant accepted the change."
        : `Home Assistant accepted ${accepted} changes.`,
    );
  if (failed)
    parts.push(
      failed === 1 ? "That change failed." : `${failed} changes failed.`,
    );
  if (unknown)
    parts.push(
      "I couldn't confirm whether it happened. Please check, then record what you saw in Hearth.",
    );
  if (rejected && !pending.length && !accepted)
    parts.push(
      rejected === 1 ? "No change was made." : "No changes were made.",
    );
  if (!proposals.length && blocked) parts.push(ASSIST_SPEECH.blocked);
  return parts.join(" ");
}

// Voice replies are spoken: short and plain. Shown only while the newest
// input of a Home chat came through Assist; data, never a permission.
export const VOICE_PROMPT =
  "VOICE: The newest message came through Home Assistant Assist and your reply will be spoken aloud. Answer in one to three short, plain sentences: no markdown, lists, tables, code, emoji, links or entity IDs unless asked. The text was transcribed from speech and may contain mistakes; if a request is unclear or could change the wrong device, ask one short question instead of guessing. Never say a change happened unless its receipt says accepted. Do not describe approval steps or say you asked for approval: Hearth adds one short sentence about pending approvals and results itself. Saying yes by voice never approves anything; approvals happen in Hearth or on a confirmed phone.";
export function voiceSection() {
  return section("voice", async (input, context) => {
    const requests = Object.values(
      (await input.read.snapshot(Inputs, input.conversationId, context))
        ?.requests ?? {},
    );
    let latest: (typeof requests)[number] | undefined;
    for (const item of requests)
      if (!latest || item.admitted >= latest.admitted) latest = item;
    return latest?.channel ? VOICE_PROMPT : undefined;
  });
}

const textOf = (entry: unknown): string => {
  const model = (entry as { model?: unknown[] }).model;
  const message = Array.isArray(model) ? model[0] : undefined;
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : [],
    )
    .join("");
};
// Several assistant messages of one run are spoken as one text.
const joinSpoken = (texts: readonly string[]) =>
  texts.reduce(
    (all, next) =>
      !next ? all : !all || /\s$/.test(all) ? all + next : `${all} ${next}`,
    "",
  );
const speechSafe = (value: string) =>
  // eslint-disable-next-line no-control-regex
  value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

export type AssistOptions = {
  satellites: readonly AssistSatellite[];
  // Whether the chat's committed model provider is ready (signed in).
  ready: (owner: string, chat: number) => Promise<boolean> | boolean;
  push?: Pick<ApprovalPush, "available" | "expedite">;
  now?: () => number;
  turnWaitMs?: number;
  pushWaitMs?: number;
};

export class Assist {
  private selection = new Serial();
  private rates = new Map<string, number[]>();
  private active = 0;
  private readonly now: () => number;
  constructor(
    private runtime: Runtime,
    private engine: HomeActions,
    private options: AssistOptions,
  ) {
    this.now = options.now ?? Date.now;
  }
  // Whether Hearth can take voice turns at all (for /core/v1/info).
  get ready() {
    return !this.runtime.closing;
  }
  private limited(key: string, max: number) {
    const now = this.now();
    if (!this.rates.has(key) && this.rates.size >= 128) this.rates.clear();
    const log = (this.rates.get(key) ?? []).filter((t) => t > now - 60000);
    log.push(now);
    this.rates.set(key, log);
    return log.length > max;
  }
  private end(
    status: AssistEnd["status"],
    speech: string,
    extra: Partial<AssistEnd> = {},
  ): AssistEnd {
    return {
      type: "end",
      status,
      speech_suffix: speech,
      continue_conversation: false,
      proposals: [],
      ...extra,
    };
  }
  // One voice turn. `write` receives start, deltas and one end event; the
  // turn itself keeps running durably whatever happens to the connection.
  async converse(
    body: unknown,
    write: (event: AssistEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const request = parseAssistRequest(body);
    const speaker = resolveSpeaker(
      request,
      (user) => this.engine.isAuthorized(user),
      this.options.satellites,
    );
    write({ type: "start" });
    if (speaker.kind === "refused") {
      write(
        this.end(
          "refused",
          this.limited("refused", ASSIST_LIMITS.refusedPerMinute)
            ? ASSIST_SPEECH.rateLimited
            : speaker.speech,
        ),
      );
      return;
    }
    const owner = speaker.owner;
    if (this.limited(ownerKey(owner), ASSIST_LIMITS.perOwnerPerMinute))
      return write(this.end("busy", ASSIST_SPEECH.rateLimited));
    if (this.active >= ASSIST_LIMITS.concurrent)
      return write(this.end("busy", ASSIST_SPEECH.capacity));
    this.active++;
    try {
      await this.turn(request, speaker, write, signal);
    } finally {
      this.active--;
    }
  }
  private async turn(
    request: AssistRequest,
    speaker: Extract<Speaker, { kind: "person" }>,
    write: (event: AssistEvent) => void,
    signal?: AbortSignal,
  ) {
    const owner = speaker.owner;
    const started = this.now();
    let chat: number;
    try {
      chat = await this.chatFor(owner, request);
    } catch (error) {
      return write(this.fault(error));
    }
    if (!(await this.options.ready(owner, chat)))
      return write(this.end("refused", ASSIST_SPEECH.notReady));
    const key = `assist-${request.requestId}`;
    let stream: AgentEventStream | undefined;
    let streamed = "";
    let desynced = false;
    let separate = false;
    const emit = (delta: string) => {
      const clean = speechSafe(this.runtime.redact(delta));
      if (!clean || desynced) return;
      const piece =
        separate && streamed && !/\s$/.test(streamed) ? ` ${clean}` : clean;
      separate = false;
      streamed += piece;
      if (!signal?.aborted) write({ type: "delta", text: piece });
    };
    const speech = speechTracker(emit, () => {
      desynced = true;
    });
    const onEvents = async (events: readonly AgentEvent[]) => {
      for (const event of events) {
        if (event.type === "message_start") separate = true;
        speech(event);
      }
    };
    // Attach before submitting so no early text of this run is missed;
    // runtime.submit refuses a busy chat, so the next run is this one.
    const attach = async (id: number) => {
      const watch = await watchEvents(
        this.runtime.harness,
        id as ConversationId,
        ctx,
      );
      watch.start(onEvents);
      return watch;
    };
    let submissionId: number;
    try {
      stream = await attach(chat);
      try {
        submissionId = await this.submit(owner, chat, key, request, speaker);
      } catch (error) {
        if (
          error instanceof Fault &&
          /^(input|transcript|image)_limit_create_session$/.test(error.code)
        ) {
          // The rolling Voice chat is full: start the next one, once.
          await stream.stop();
          chat = await this.rollOver(owner, request, chat);
          stream = await attach(chat);
          submissionId = await this.submit(owner, chat, key, request, speaker);
        } else throw error;
      }
    } catch (error) {
      await stream?.stop().catch(() => undefined);
      return write(this.fault(error));
    }
    const submission = (await this.runtime.harness.submission(
      submissionId as SubmissionId,
      ctx,
    ))!;
    const budget = Math.max(
      0,
      (this.options.turnWaitMs ?? ASSIST_LIMITS.turnWaitMs) -
        (this.now() - started),
    );
    let settled: Awaited<ReturnType<typeof submission.wait>> | undefined;
    try {
      const timeout = AbortSignal.timeout(budget);
      settled = await submission.wait(
        withAbortSignal(
          signal ? AbortSignal.any([timeout, signal]) : timeout,
          ctx,
        ),
      );
    } catch {
      settled = undefined;
    } finally {
      await stream.stop().catch(() => undefined);
    }
    if (signal?.aborted) return;
    if (!settled)
      return write(this.end("still_working", ASSIST_SPEECH.stillWorking));
    // Whatever the stream missed (a replayed request, a late attach) is
    // sent now, but only as a continuation of what was already spoken.
    const full = speechSafe(
      this.runtime.redact(await this.runText(chat, settled)),
    );
    if (full.startsWith(streamed) && full.length > streamed.length) {
      const rest = full.slice(streamed.length);
      streamed = full;
      write({ type: "delta", text: rest });
    }
    const proposals = Object.values(
      (
        await this.runtime.harness.snapshot(
          Proposals,
          chat as ConversationId,
          ctx,
        )
      )?.items ?? {},
    ).filter((p) => p.authorization?.inputIds.includes(submissionId));
    const pushed = await this.pushPending(owner, chat, proposals);
    let blocked = false;
    try {
      blocked = (await this.engine.settings(owner)).blocked;
    } catch {
      blocked = false;
    }
    // Re-read: an expedited send never changes a status, but a decision
    // made meanwhile (in Hearth or on the phone) does.
    const current =
      (
        await this.runtime.harness.snapshot(
          Proposals,
          chat as ConversationId,
          ctx,
        )
      )?.items ?? {};
    const final = proposals.map((p) => current[p.id] ?? p);
    const suffix = [
      settled.status === "done" ? "" : ASSIST_SPEECH.unanswered,
      closingSentence(final, pushed, blocked),
    ]
      .filter(Boolean)
      .join(" ");
    write(
      this.end("done", suffix, {
        continue_conversation:
          settled.status === "done" && !suffix && /[?？;]\s*$/.test(streamed),
        proposals: final.map((p) => ({
          risk: p.risk?.level ?? "high",
          status: p.status,
          notified: pushed.has(p.id),
        })),
      }),
    );
  }
  private async submit(
    owner: string,
    chat: number,
    key: string,
    request: AssistRequest,
    speaker: Extract<Speaker, { kind: "person" }>,
  ) {
    // The Assist button under the person's own user is their direct turn;
    // a satellite (Ask ceiling: anyone in the room can speak) never is.
    return this.runtime.submit(owner, chat, key, request.text, undefined, {
      channel: speaker.channel,
      ...(speaker.ceiling
        ? { ceiling: speaker.ceiling }
        : speaker.channel === "assist"
          ? { direct: true }
          : {}),
    });
  }
  // The assistant text of one settled run: every assistant message after
  // the user's entry, up to the answer.
  private async runText(
    chat: number,
    settled: { status: string; entry?: unknown; answer?: unknown },
  ) {
    const from = typeof settled.entry === "number" ? settled.entry : undefined;
    if (from === undefined) return "";
    const to =
      typeof settled.answer === "number" ? settled.answer : Number.MAX_VALUE;
    const conversation = await this.runtime.harness.conversation(
      chat as ConversationId,
      ctx,
    );
    if (!conversation) return "";
    const entries = (await conversation.context(ctx)).entries;
    return joinSpoken(
      entries
        .filter(
          (e) =>
            (e.id as number) > from &&
            (e.id as number) <= to &&
            AssistantEntry.is(e),
        )
        .map(textOf),
    );
  }
  // Send this turn's pending proposals to the owner's confirmed phones now,
  // within a short bound; only an accepted send counts.
  private async pushPending(
    owner: string,
    chat: number,
    proposals: readonly Proposal[],
  ) {
    const pushed = new Set<string>();
    const push = this.options.push;
    if (!push?.available) return pushed;
    const pending = proposals.filter(
      (p) =>
        p.status === "pending" &&
        p.authorization?.source === "human" &&
        !p.origin,
    );
    if (!pending.length) return pushed;
    const wait = this.options.pushWaitMs ?? ASSIST_LIMITS.pushWaitMs;
    await Promise.all(
      pending.map(async (p) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const ok = await Promise.race([
          push.expedite(owner, chat, p).catch(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), wait);
          }),
        ]);
        clearTimeout(timer);
        if (ok) pushed.add(p.id);
      }),
    );
    return pushed;
  }
  private fault(error: unknown): AssistEnd {
    const code = error instanceof Fault ? error.code : "";
    if (code === "session_busy")
      return this.end("busy", ASSIST_SPEECH.sessionBusy);
    if (code === "capacity" || code === "closing")
      return this.end("busy", ASSIST_SPEECH.capacity);
    if (code === "session_limit")
      return this.end("refused", ASSIST_SPEECH.sessionLimit);
    if (code === "assist_request_handled" || code === "idempotency_conflict")
      return this.end("refused", ASSIST_SPEECH.alreadyHandled);
    return this.end("refused", ASSIST_SPEECH.failed);
  }
  // Which Voice chat this request goes to, committed (with the request id)
  // before anything is submitted, so a repeated request id always finds the
  // same chat and is never run twice.
  private async chatFor(owner: string, request: AssistRequest) {
    return this.selection.run(async () => {
      const now = this.now();
      const requestKey = `r_${request.requestId}`;
      const conversationKey = request.conversationId
        ? `c_${request.conversationId}`
        : "";
      const snapshot = await this.runtime.harness.snapshot(VoiceSessions, ctx);
      const chats = new Set(
        (await this.runtime.list(owner))
          .filter((s) => (s.kind ?? "home") === "home")
          .map((s) => s.id),
      );
      const seen = snapshot?.requests[requestKey];
      if (seen) {
        insist(
          seen.owner === owner && chats.has(seen.chat),
          "assist_request_handled",
          409,
        );
        return seen.chat;
      }
      const mapped = conversationKey
        ? snapshot?.conversations[conversationKey]
        : undefined;
      const state = snapshot?.owners[ownerKey(owner)];
      let chat =
        mapped &&
        mapped.owner === owner &&
        mapped.expires > now &&
        chats.has(mapped.chat)
          ? mapped.chat
          : state && chats.has(state.chat)
            ? state.chat
            : 0;
      if (!chat) chat = await this.createChat(owner, state?.generation ?? 0);
      await this.remember(owner, request, chat, state?.generation ?? 0);
      return chat;
    });
  }
  private async createChat(owner: string, generation: number) {
    return this.runtime.create(
      owner,
      VOICE_CHAT_TITLE,
      `voice-${digest(owner).slice(0, 24)}-${generation}`,
    );
  }
  private async rollOver(owner: string, request: AssistRequest, full: number) {
    return this.selection.run(async () => {
      const state = (await this.runtime.harness.snapshot(VoiceSessions, ctx))
        ?.owners[ownerKey(owner)];
      const generation = (state?.generation ?? 0) + 1;
      const chat =
        state && state.chat !== full
          ? state.chat
          : await this.createChat(owner, generation);
      await this.remember(
        owner,
        request,
        chat,
        state && state.chat !== full ? state.generation : generation,
      );
      return chat;
    });
  }
  private async remember(
    owner: string,
    request: AssistRequest,
    chat: number,
    generation: number,
  ) {
    const now = this.now();
    await this.runtime.harness.commit(async (tx) => {
      const doc = await tx.doc(VoiceSessions);
      doc.owners[ownerKey(owner)] = { chat, generation };
      for (const [key, item] of Object.entries(doc.conversations))
        if (item.expires <= now) delete doc.conversations[key];
      for (const [key, item] of Object.entries(doc.requests))
        if (item.at <= now - ASSIST_LIMITS.requestMs) delete doc.requests[key];
      const trim = <T extends { at?: number; expires?: number }>(
        record: Record<string, T>,
        max: number,
      ) => {
        const keys = Object.keys(record);
        if (keys.length <= max) return;
        keys
          .sort(
            (a, b) =>
              (record[a]!.at ?? record[a]!.expires ?? 0) -
              (record[b]!.at ?? record[b]!.expires ?? 0),
          )
          .slice(0, keys.length - max)
          .forEach((key) => delete record[key]);
      };
      if (request.conversationId)
        doc.conversations[`c_${request.conversationId}`] = {
          owner,
          chat,
          expires: now + ASSIST_LIMITS.conversationMs,
        };
      doc.requests[`r_${request.requestId}`] = { owner, chat, at: now };
      trim(doc.conversations, ASSIST_LIMITS.conversations);
      trim(doc.requests, ASSIST_LIMITS.requests);
    }, ctx);
  }
}
