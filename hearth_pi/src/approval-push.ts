// Phone approvals (opt-in, App option `approval_notifications`, ingress
// mode only). A pending model proposal is announced on the owner's own
// confirmed phones with a fixed, short notification: the risk level and one
// deterministic line. Low and medium can be approved or rejected from the
// notification; high and critical only rejected or opened in Hearth.
//
// This is a second, narrow way to authenticate a decision, next to Ingress:
// a Home Assistant `mobile_app_notification_action` event whose
// `context.user_id` is the owner, whose `origin` is REMOTE and whose action
// id carries a single-use, in-memory nonce bound to one proposal id and hash
// and its expiry. The nonce links the tap to one proposal and stops replays;
// the HA user binding is the authentication. No free text is ever accepted
// from a notification. HomeActions.decide re-checks everything a UI decision
// checks (hash, pending, permissions, expiry, barriers) and refuses a phone
// approval for anything above medium.
import { createHash, randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  defineDoc,
  type CheckpointInfo,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { Proposals, type Action, type Proposal } from "./documents.js";
import type { ApprovalHooks, HomeActions } from "./home-actions.js";
import type {
  DeviceNotification,
  NotificationButton,
  PhoneCandidate,
} from "./ha.js";
import type { HAEventOptions, NotificationActionEvent } from "./ha-events.js";
import { HA_EVENT_TYPE } from "./ha-events.js";
import type { Runtime } from "./runtime.js";
import { Fault, Serial, digest, insist, object } from "./safety.js";

export const APPROVAL_PUSH_LIMITS = Object.freeze({
  targets: 4,
  graceMs: 20000,
  minRemainingMs: 60000,
  sendsPerHour: 20,
  proofsPerHour: 5,
  proofMs: 600000,
  eventsPerMinute: 30,
  headline: 100,
});
export type PushTargetStatus = "proof" | "active" | "disabled";
export type PushTarget = {
  id: string;
  service: string;
  label: string;
  status: PushTargetStatus;
  proofExpires?: number;
  verifiedAt?: number;
};
export type PushOwner = {
  enabled: boolean;
  revision: number;
  targets: PushTarget[];
};
const checkpointWhen = (_value: unknown, _ops: unknown, info: CheckpointInfo) =>
  info.deltasSinceBase >= 31;
// Durable per-owner opt-in and confirmed phones. Nonces are never stored:
// they die with the process, like pending approvals at boot.
export const ApprovalPushDoc = defineDoc<{ owners: Record<string, PushOwner> }>(
  {
    kind: "hearth.approval-push",
    version: 1,
    scope: "session",
    initial: () => ({ owners: {} }),
    checkpointWhen,
  },
);
type Verb = "approve" | "reject" | "proof";
type Token = {
  owner: string;
  verb: Verb;
  expires: number;
  used: boolean;
  sessionId?: number;
  proposalId?: string;
  hash?: string;
  targetId?: string;
};
const ACTION_PATTERN = /^HEARTH_([ARP])_([A-Z2-7]{26})$/;
const VERB_LETTER: Record<Verb, string> = {
  approve: "A",
  reject: "R",
  proof: "P",
};
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
// 128 random bits as 26 upper-case base32 characters: one alphabet, so no
// case folding on any phone can turn one nonce into another.
function nonce(): string {
  const bytes = randomBytes(16);
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}
const tokenKey = (actionId: string) =>
  createHash("sha256").update(actionId).digest("hex");
const RISK_TITLE: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};
// One deterministic line naming what would change: service and entity ids,
// config resource and id, or Supervisor method and path. Never `data`/`body`
// values (codes), friendly names (attacker-influenced text) or list item
// text. Redacted and capped.
export function actionHeadline(
  action: Action,
  redact: (value: string) => string = (v) => v,
): string {
  let line: string;
  if (!("kind" in action)) line = `${action.service} ${action.entityId}`;
  else if (action.kind === "todo")
    line = `todo ${action.op} item on ${action.entityId}`;
  else if (action.kind === "service") {
    const ids = action.target.entity_id ?? [];
    const others =
      (action.target.device_id?.length ?? 0) +
      (action.target.area_id?.length ?? 0);
    line = `${action.domain}.${action.service} ${
      ids.length ? ids.join(", ") : others ? "" : "(no target)"
    }${others ? `${ids.length ? " + " : ""}${others} device/area target(s)` : ""}`;
  } else if (action.kind === "config")
    line = `${action.op === "delete" ? "Delete" : "Write"} ${action.resource} ${action.id}`;
  else if (action.kind === "ws") line = action.type;
  else line = `Supervisor ${action.method} ${action.path}`;
  const clean = redact(line.replace(/\s+/g, " ").trim());
  return clean.length > APPROVAL_PUSH_LIMITS.headline
    ? `${clean.slice(0, APPROVAL_PUSH_LIMITS.headline - 1)}…`
    : clean;
}
// The fixed approval notification. Approve only for low and medium.
export function approvalNotification(
  proposal: Proposal,
  tag: string,
  ids: { approve?: string; reject: string },
  selfSlug: string,
  redact?: (value: string) => string,
): DeviceNotification {
  const level = proposal.risk?.level ?? "high";
  const actions: NotificationButton[] = [];
  // A turn whose tool output looked like instructions never gets a one-tap
  // phone approval: the person must see the card and why it asked.
  const flagged = proposal.authorization?.guard === "flagged";
  if (ids.approve && !flagged && (level === "low" || level === "medium"))
    actions.push({
      action: ids.approve,
      title: "Approve",
      authenticationRequired: true,
    });
  actions.push({ action: ids.reject, title: "Reject" });
  if (selfSlug)
    actions.push({
      action: "URI",
      title: "Open Hearth",
      uri: `/hassio/ingress/${selfSlug}`,
    });
  return {
    title: `Hearth · ${RISK_TITLE[level] ?? "High"} risk`,
    message: actionHeadline(proposal.action, redact),
    data: { tag, group: "hearth-approvals", actions },
  };
}
const newTag = () => `hearth_${randomBytes(8).toString("hex")}`;
const candidateId = (owner: string, service: string) =>
  digest({ owner, service }).slice(0, 16);
const recent = (log: number[], now: number, windowMs: number) => {
  while (log.length && log[0]! <= now - windowMs) log.shift();
  return log;
};
type Sent = {
  owner: string;
  sessionId: number;
  id: string;
  tag: string;
  services: string[];
  expires: number;
  cleared: boolean;
  // How many phones Home Assistant accepted the notification for.
  delivered: number;
};
type Subscriber = { start(): void; stop(): void; readonly active: boolean };

export class ApprovalPush implements ApprovalHooks {
  private tokens = new Map<string, Token>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private sent = new Map<string, Sent>();
  // The one send attempt per proposal, once started: whether at least one
  // phone accepted it (Hearth Assist speaks only a push that succeeded).
  private deliveries = new Map<string, Promise<boolean>>();
  private sendLog = new Map<string, number[]>();
  private proofLog = new Map<string, number[]>();
  // Per tapping HA user, so one user's spam cannot block another's taps.
  private eventLogs = new Map<string, number[]>();
  private inflight = new Set<Promise<unknown>>();
  private writes = new Serial();
  private subscriber: Subscriber | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly graceMs: number;
  constructor(
    private runtime: Runtime,
    private engine: HomeActions,
    readonly options: {
      available: boolean;
      selfSlug?: string;
      now?: () => number;
      graceMs?: number;
      subscriber?: HAEventOptions;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.graceMs = options.graceMs ?? APPROVAL_PUSH_LIMITS.graceMs;
    if (options.available) engine.useApprovalHooks(this);
  }
  get available() {
    return this.options.available;
  }
  private get ha() {
    return this.engine.ha;
  }
  private track<T>(work: Promise<T>): Promise<T | undefined> {
    const guarded = work.catch(() => undefined);
    this.inflight.add(guarded);
    void guarded.finally(() => this.inflight.delete(guarded));
    return guarded;
  }
  // Tests and shutdown: wait for every send, clear and decision in flight.
  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }
  async start() {
    if (!this.available) return;
    await this.refreshSubscriber();
  }
  async stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.subscriber?.stop();
    await this.idle();
  }
  get listening() {
    return !!this.subscriber?.active;
  }
  private async doc() {
    return (
      (await this.runtime.harness.snapshot(ApprovalPushDoc, ctx))?.owners ?? {}
    );
  }
  // The subscriber runs only while the option is on and some phone is
  // confirmed or waiting for its proof tap.
  private async refreshSubscriber() {
    if (!this.available || this.stopped) return;
    const now = this.now();
    const wanted = Object.values(await this.doc()).some((o) =>
      o.targets.some(
        (t) =>
          t.status === "active" ||
          (t.status === "proof" && (t.proofExpires ?? 0) > now),
      ),
    );
    if (wanted) {
      this.subscriber ??= this.ha.eventSubscriber(
        (event) => this.handleEvent(event),
        this.options.subscriber,
      );
      if (!this.subscriber.active) this.subscriber.start();
    } else this.subscriber?.stop();
  }
  // --- HomeActions hooks ---
  pending(owner: string, sessionId: number, proposal: Proposal) {
    if (!this.available || this.stopped) return;
    const key = `${sessionId}:${proposal.id}`;
    if (this.timers.has(key) || this.sent.has(key)) return;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.deliver(key, owner, sessionId, proposal.id, proposal.hash);
    }, this.graceMs);
    timer.unref?.();
    this.timers.set(key, timer);
  }
  settled() {
    if (!this.available || this.stopped) return;
    void this.track(this.sweep());
  }
  private deliver(
    key: string,
    owner: string,
    sessionId: number,
    id: string,
    hash: string,
  ): Promise<boolean> {
    const existing = this.deliveries.get(key);
    if (existing) return existing;
    const work = this.track(this.send(owner, sessionId, id, hash)).then(
      (delivered) => (delivered ?? 0) > 0,
    );
    this.deliveries.set(key, work);
    // Only a real send stays recorded (until its notification is cleared).
    void work.then(() => {
      if (!this.sent.has(key)) this.deliveries.delete(key);
    });
    return work;
  }
  // Hearth Assist: a person who just asked by voice is not watching the
  // chat, so a pending proposal from that turn is sent now instead of after
  // the grace period. Same checks and single send as the timer; resolves to
  // whether at least one phone accepted the notification.
  expedite(owner: string, sessionId: number, proposal: Proposal) {
    if (!this.available || this.stopped) return Promise.resolve(false);
    const key = `${sessionId}:${proposal.id}`;
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    const sent = this.sent.get(key);
    if (sent && !this.deliveries.has(key))
      return Promise.resolve(sent.delivered > 0);
    return this.deliver(key, owner, sessionId, proposal.id, proposal.hash);
  }
  // Returns how many phones accepted the notification (0 when not sent).
  private async send(
    owner: string,
    sessionId: number,
    id: string,
    hash: string,
  ): Promise<number> {
    if (this.stopped || !this.engine.isAuthorized(owner)) return 0;
    const state = (await this.doc())[owner];
    if (!state?.enabled || !state.targets.some((t) => t.status === "active"))
      return 0;
    const now = this.now();
    const log = recent(this.sendLog.get(owner) ?? [], now, 3600000);
    this.sendLog.set(owner, log);
    if (log.length >= APPROVAL_PUSH_LIMITS.sendsPerHour) return 0;
    const current = (
      await this.runtime.harness.snapshot(
        Proposals,
        sessionId as ConversationId,
        ctx,
      )
    )?.items[id];
    if (
      !current ||
      current.status !== "pending" ||
      current.notified ||
      current.expires - now < APPROVAL_PUSH_LIMITS.minRemainingMs
    )
      return 0;
    // Re-verify at send time that each phone is still this owner's.
    let candidates: PhoneCandidate[];
    try {
      candidates = await this.ha.ownerPhoneCandidates(owner);
    } catch {
      return 0;
    }
    const targets = await this.verifyTargets(owner, candidates);
    if (!targets.length) return 0;
    const tag = newTag();
    const marked = await this.engine.markNotified(
      owner,
      sessionId,
      id,
      hash,
      { at: this.now(), tag, count: targets.length },
      APPROVAL_PUSH_LIMITS.minRemainingMs,
    );
    if (!marked) return 0;
    log.push(now);
    const level = marked.risk?.level;
    const base = {
      owner,
      sessionId,
      proposalId: id,
      hash,
      expires: marked.expires,
      used: false,
    };
    const reject = this.issue({ ...base, verb: "reject" });
    const approve =
      level === "low" || level === "medium"
        ? this.issue({ ...base, verb: "approve" })
        : undefined;
    const payload = approvalNotification(
      marked,
      tag,
      { reject, ...(approve ? { approve } : {}) },
      this.options.selfSlug ?? "",
      (value) => this.ha.sanitize(value),
    );
    const key = `${sessionId}:${id}`;
    this.sent.set(key, {
      owner,
      sessionId,
      id,
      tag,
      services: targets.map((t) => t.service),
      expires: marked.expires,
      cleared: false,
      delivered: 0,
    });
    const expiry = setTimeout(
      () => this.settled(),
      Math.max(0, marked.expires - this.now()) + 1000,
    );
    expiry.unref?.();
    // One attempt per phone; a failed send is never resent.
    let delivered = 0;
    for (const target of targets)
      await this.ha.notifyDevice(target.service, payload).then(
        () => delivered++,
        () => {},
      );
    const entry = this.sent.get(key);
    if (entry) entry.delivered = delivered;
    return delivered;
  }
  private issue(token: Token) {
    const id = `HEARTH_${VERB_LETTER[token.verb]}_${nonce()}`;
    this.tokens.set(tokenKey(id), token);
    return id;
  }
  // Disable confirmed phones that are no longer among the owner's own
  // candidates ("Confirm this phone again"); return the ones still valid.
  private async verifyTargets(owner: string, candidates: PhoneCandidate[]) {
    const services = new Set(candidates.map((c) => c.service));
    return this.writes.run(() =>
      this.runtime.harness.commit(async (tx) => {
        const state = (await tx.doc(ApprovalPushDoc)).owners[owner];
        if (!state) return [];
        let changed = false;
        for (const target of state.targets)
          if (target.status === "active" && !services.has(target.service)) {
            target.status = "disabled";
            changed = true;
          }
        if (changed) state.revision++;
        return state.targets
          .filter((t) => t.status === "active")
          .map((t) => ({ ...t }));
      }, ctx),
    );
  }
  // Clear sent notifications whose proposal is decided or expired, once.
  private async sweep() {
    const now = this.now();
    for (const [key, entry] of this.sent) {
      if (entry.cleared) continue;
      const item = (
        await this.runtime.harness.snapshot(
          Proposals,
          entry.sessionId as ConversationId,
          ctx,
        )
      )?.items[entry.id];
      if (item && item.status === "pending" && item.expires > now) continue;
      entry.cleared = true;
      this.sent.delete(key);
      this.deliveries.delete(key);
      for (const [tokenId, token] of this.tokens)
        if (
          token.sessionId === entry.sessionId &&
          token.proposalId === entry.id
        )
          this.tokens.delete(tokenId);
      for (const service of entry.services)
        await this.ha
          .notifyDevice(service, {
            message: "clear_notification",
            data: { tag: entry.tag },
          })
          .catch(() => {});
    }
    for (const [tokenId, token] of this.tokens)
      if (token.expires <= now) this.tokens.delete(tokenId);
  }
  // --- The HA event bus side ---
  handleEvent(event: NotificationActionEvent) {
    if (!this.available || this.stopped) return;
    if (event.eventType !== HA_EVENT_TYPE) return;
    if (event.origin !== "REMOTE") return;
    if (typeof event.action !== "string") return;
    const match = ACTION_PATTERN.exec(event.action);
    if (!match) return;
    if (typeof event.userId !== "string" || !event.userId) return;
    const now = this.now();
    if (!this.eventLogs.has(event.userId) && this.eventLogs.size >= 64)
      this.eventLogs.clear();
    const log = this.eventLogs.get(event.userId) ?? [];
    recent(log, now, 60000);
    if (log.length >= APPROVAL_PUSH_LIMITS.eventsPerMinute) return;
    log.push(now);
    this.eventLogs.set(event.userId, log);
    const token = this.tokens.get(tokenKey(event.action));
    if (!token || token.used || token.expires <= now) return;
    if (VERB_LETTER[token.verb] !== match[1]) return;
    // The binding: the HA user who tapped must be the owner. A missing or
    // different user id fails closed and leaves the token for its owner.
    if (typeof event.userId !== "string" || event.userId !== token.owner)
      return;
    if (!this.engine.isAuthorized(token.owner)) return;
    // Single use: burn this token and its siblings before deciding.
    token.used = true;
    if (token.verb === "proof") {
      void this.track(this.confirmProof(token, now));
      return;
    }
    for (const other of this.tokens.values())
      if (
        other.sessionId === token.sessionId &&
        other.proposalId === token.proposalId
      )
        other.used = true;
    void this.track(this.decide(token));
  }
  private async decide(token: Token) {
    const state = (await this.doc())[token.owner];
    if (!state?.enabled || !state.targets.some((t) => t.status === "active"))
      return;
    try {
      await this.engine.decide(
        token.owner,
        token.sessionId!,
        token.proposalId!,
        token.hash!,
        token.verb === "approve" ? "approve" : "reject",
        "",
        "",
        "push",
      );
    } catch {
      // Already decided, expired, read-only, blocked: a silent no-op.
    }
  }
  private async confirmProof(token: Token, now: number) {
    await this.writes.run(() =>
      this.runtime.harness.commit(async (tx) => {
        const state = (await tx.doc(ApprovalPushDoc)).owners[token.owner];
        const target = state?.targets.find((t) => t.id === token.targetId);
        if (
          !state ||
          !target ||
          target.status !== "proof" ||
          (target.proofExpires ?? 0) <= now
        )
          return;
        target.status = "active";
        target.verifiedAt = now;
        delete target.proofExpires;
        state.revision++;
      }, ctx),
    );
    await this.refreshSubscriber();
  }
  // --- Settings → You → Phone approvals ---
  private view(owner: string, state: PushOwner | undefined, now: number) {
    return {
      available: this.available,
      enabled: !!state?.enabled,
      revision: state?.revision ?? 0,
      targets: (state?.targets ?? []).map((t) => ({
        id: t.id,
        label: t.label,
        status:
          t.status === "proof" && (t.proofExpires ?? 0) <= now
            ? ("expired" as const)
            : t.status,
      })),
    };
  }
  async get(owner: string) {
    const now = this.now();
    const state = (await this.doc())[owner];
    if (!this.available || this.engine.role(owner) === "guest")
      return {
        ...this.view(owner, undefined, now),
        available: false,
        candidates: [],
      };
    let candidates: { id: string; label: string }[] = [];
    let candidatesUnavailable = false;
    try {
      const active = new Set(
        (state?.targets ?? [])
          .filter((t) => t.status === "active")
          .map((t) => t.service),
      );
      candidates = (await this.ha.ownerPhoneCandidates(owner))
        .filter((c) => !active.has(c.service))
        .map((c) => ({ id: candidateId(owner, c.service), label: c.label }));
    } catch {
      candidatesUnavailable = true;
    }
    return {
      ...this.view(owner, state, now),
      candidates,
      ...(candidatesUnavailable ? { candidatesUnavailable: true } : {}),
    };
  }
  private allowed(owner: string) {
    insist(this.available, "approval_notifications_unavailable", 403);
    insist(this.engine.isAuthorized(owner), "user_not_authorized", 403);
    // Owners and members; guests have no Home changes to approve.
    insist(this.engine.role(owner) !== "guest", "role_guest_read_only", 403);
  }
  private revision(value: unknown) {
    insist(Number.isSafeInteger(value) && Number(value) >= 0);
    return Number(value);
  }
  private async update<T>(
    owner: string,
    revision: number,
    change: (state: PushOwner) => T,
  ): Promise<T> {
    return this.writes.run(() =>
      this.runtime.harness.commit(async (tx) => {
        const doc = await tx.doc(ApprovalPushDoc);
        if (!doc.owners[owner]) {
          insist(Object.keys(doc.owners).length < 100, "owner_limit", 429);
          doc.owners[owner] = { enabled: false, revision: 0, targets: [] };
        }
        const state = doc.owners[owner]!;
        insist(state.revision === revision, "approval_push_stale", 409);
        const result = change(state);
        state.revision++;
        return result;
      }, ctx),
    );
  }
  async setEnabled(owner: string, body: unknown) {
    this.allowed(owner);
    const v = object(body, ["enabled", "revision"]);
    insist(typeof v.enabled === "boolean");
    await this.update(owner, this.revision(v.revision), (state) => {
      state.enabled = v.enabled as boolean;
    });
    await this.refreshSubscriber();
    return this.get(owner);
  }
  async addTarget(owner: string, body: unknown) {
    this.allowed(owner);
    const v = object(body, ["candidate", "revision"]);
    insist(
      typeof v.candidate === "string" && /^[a-f0-9]{16}$/.test(v.candidate),
    );
    const revision = this.revision(v.revision);
    const now = this.now();
    const proofs = recent(this.proofLog.get(owner) ?? [], now, 3600000);
    this.proofLog.set(owner, proofs);
    insist(
      proofs.length < APPROVAL_PUSH_LIMITS.proofsPerHour,
      "push_proof_limit",
      429,
    );
    let candidates: PhoneCandidate[];
    try {
      candidates = await this.ha.ownerPhoneCandidates(owner);
    } catch {
      throw new Fault(502, "ha_read_failed");
    }
    const candidate = candidates.find(
      (c) => candidateId(owner, c.service) === v.candidate,
    );
    insist(candidate, "push_candidate_not_found", 404);
    const id = v.candidate;
    const proofExpires = now + APPROVAL_PUSH_LIMITS.proofMs;
    await this.update(owner, revision, (state) => {
      const existing = state.targets.find((t) => t.id === id);
      insist(existing?.status !== "active", "push_target_exists", 409);
      if (existing) {
        existing.status = "proof";
        existing.label = candidate.label;
        existing.proofExpires = proofExpires;
        delete existing.verifiedAt;
      } else {
        insist(
          state.targets.length < APPROVAL_PUSH_LIMITS.targets,
          "push_target_limit",
          409,
        );
        state.targets.push({
          id,
          service: candidate.service,
          label: candidate.label,
          status: "proof",
          proofExpires,
        });
      }
    });
    proofs.push(now);
    for (const [tokenId, token] of this.tokens)
      if (token.owner === owner && token.targetId === id)
        this.tokens.delete(tokenId);
    const proof = this.issue({
      owner,
      verb: "proof",
      targetId: id,
      expires: proofExpires,
      used: false,
    });
    // Listen before the phone can be tapped.
    await this.refreshSubscriber();
    await this.ha.notifyDevice(candidate.service, {
      title: "Hearth · Confirm phone",
      message: "Tap 'It's my phone' to use this phone for Hearth approvals.",
      data: {
        tag: newTag(),
        group: "hearth-approvals",
        actions: [{ action: proof, title: "It's my phone" }],
      },
    });
    return this.get(owner);
  }
  async removeTarget(owner: string, body: unknown) {
    this.allowed(owner);
    const v = object(body, ["id", "revision"]);
    insist(typeof v.id === "string" && /^[a-f0-9]{16}$/.test(v.id));
    const id = v.id;
    await this.update(owner, this.revision(v.revision), (state) => {
      const before = state.targets.length;
      state.targets = state.targets.filter((t) => t.id !== id);
      insist(state.targets.length < before, "push_target_not_found", 404);
    });
    for (const [tokenId, token] of this.tokens)
      if (token.owner === owner && token.targetId === id)
        this.tokens.delete(tokenId);
    await this.refreshSubscriber();
    return this.get(owner);
  }
}
