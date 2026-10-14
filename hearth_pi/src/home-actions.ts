import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  LiveDoc,
  type ConversationId,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  Catalog,
  Inputs,
  Proposals,
  HomePermissions,
  type HomePermission,
  type HomeMode,
  type PermissionBinding,
  type Proposal,
} from "./documents.js";
import type { HAClient } from "./ha.js";
import { DispatchFailed } from "./ha.js";
import type { Runtime } from "./runtime.js";
import { Serial, digest, insist, text } from "./safety.js";
import { classifyAction, confirmationWord, maxRisk, riskRank } from "./risk.js";
import type { HouseholdRole } from "./config.js";
import { offJudge, type RiskJudge } from "./judge.js";
import type { InjectionGuard } from "./injection-guard.js";
import type {
  Action,
  JudgeRecord,
  RiskAssessment,
  TodoAction,
} from "./documents.js";
import {
  UNDO_STALE_MS,
  UNDO_WINDOW_MS,
  reverseEntityAction,
  reverseTodoAction,
  sameAsBefore,
  type EntitySnapshot,
} from "./undo.js";
import {
  RECONCILE_DELAYS_MS,
  RECONCILE_GAVE_UP,
  RECONCILE_NOTES,
  RECONCILED_DID_NOT_HAPPEN,
  RECONCILED_SUCCEEDED,
  entityResult,
  reconcilePlan,
  riskMembers,
  scopesOverlap,
  todoResult,
  writeScope,
} from "./reconcile.js";
import type { RiskContext } from "./risk.js";
import { assertFlowCurrent, knownFlows } from "./flow-setup.js";
import type { FlowResultSummary } from "./documents.js";

export const ACTION_SCHEMA = 1;
export const FULL_ACKNOWLEDGEMENT =
  "Auto-approve supported Home actions within this exact configured policy; no host or admin access.";
// Admin access mode's Full grant: the risk classifier, not an entity list,
// bounds what may run without a person.
export const ADMIN_FULL_ACKNOWLEDGEMENT =
  "Auto-approve only low-risk Home Assistant admin actions, and medium ones a risk judge agrees with; high and critical always ask; no host shell or filesystem.";
// A trusted owner's Full grant (trusted_user_ids, App configuration only):
// their own direct turns run at every risk level, without the risk judge or
// a typed confirmation. The text says so; acknowledging it is the one
// confirmation.
export const TRUSTED_FULL_ACKNOWLEDGEMENT =
  "Trusted: everything runs on Full. Every supported Home action within this exact configured policy runs without asking, at every risk level, when it comes from your own turn in Hearth or the Assist button; voice satellites still ask, and work you did not start follows the normal Full rules (low risk may still run). Anything Home Assistant sends under your own user, including scripts you run that call Assist, counts as your turn. No host or admin access.";
export const TRUSTED_ADMIN_FULL_ACKNOWLEDGEMENT =
  "Trusted: everything runs on Full. Every Home Assistant admin action from your own turn in Hearth or the Assist button runs without asking at every risk level, including high and critical, with no risk judge and no typed confirmation; voice satellites still ask, and work you did not start follows the normal Full rules (low risk may still run). Anything Home Assistant sends under your own user, including scripts you run that call Assist, counts as your turn. No host shell or filesystem.";
export function policyFingerprint(ha: HAClient): string {
  if (ha.policy.access === "admin")
    return digest({
      schema: ACTION_SCHEMA,
      access: "admin",
      enabled: true,
    });
  return digest({
    schema: ACTION_SCHEMA,
    enabled: ha.policy.enabled,
    entities: [...new Set(ha.policy.entities)].sort(),
    services: [...new Set(ha.policy.services)].sort(),
  });
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
// Full access may run a proposal without a person only when it is low risk,
// or medium with an agreeing judge; never high/critical or judge-misaligned.
// The judge may see only the owner's words: text blocks of a message with
// attachments, never image data or other block types.
export function requestText(content: unknown): string {
  if (typeof content === "string") return content;
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
    .join("\n");
}
// Shared list changes: a medium one (rename, remove) always asks, whatever
// the judge says. AGENTS.md lets scoped Full access auto-approve only the
// supported light/switch actions, so in scoped mode every list change asks;
// in admin mode a low one (add, complete, reopen) may run once.
export function autoRunAllowed(
  risk: RiskAssessment,
  judge: JudgeRecord,
  action: Action,
  admin: boolean,
) {
  if (judge.verdict === "misaligned") return false;
  if (
    "kind" in action &&
    action.kind === "todo" &&
    (!admin || risk.level !== "low")
  )
    return false;
  // A generic admin service call into a to-do list (rename, remove, any
  // non-low change) asks too, so lists behave the same on every path.
  if (
    "kind" in action &&
    action.kind === "service" &&
    action.domain === "todo" &&
    risk.level !== "low"
  )
    return false;
  if (risk.level === "low") return true;
  return risk.level === "medium" && judge.verdict === "agreed";
}
// Phone approvals (src/approval-push.ts) learn about new pending model
// proposals and about decisions through these hooks; they never decide.
export type ApprovalHooks = {
  pending(owner: string, sessionId: number, proposal: Proposal): void;
  settled(): void;
};
// Where a decision came from. "push" is a tap on a phone notification bound
// to the owner's HA user and a single-use nonce (src/approval-push.ts).
export type DecisionVia = "ui" | "push";
const NO_JUDGE: JudgeRecord = {
  model: "off",
  verdict: "not_applicable",
  reason: "Pressed by you directly; no judge needed.",
  latencyMs: 0,
};
const TRUSTED_JUDGE: JudgeRecord = {
  model: "off",
  verdict: "not_applicable",
  reason: "Trusted person's own turn on Full access; no judge.",
  latencyMs: 0,
};
// Waits between reconciliation checks (fake in tests).
export type ReconcileSleep = (ms: number, signal: AbortSignal) => Promise<void>;
const realSleep: ReconcileSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("stopped"));
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("stopped"));
      },
      { once: true },
    );
  });

// One engine owns permission revisions and both human/automatic action admission.
// The gate never spans HA waits. Dispatch intent and attempt are separate durable commits.
export class HomeActions {
  private gate = new Serial();
  private runtime?: Runtime;
  private stopping = false;
  private controllers = new Map<AbortController, string>();
  private inFlight = new Set<Promise<unknown>>();
  private authorizedOwners = new Set<string>();
  private trustedOwners = new Set<string>();
  private roles: Readonly<Record<string, Exclude<HouseholdRole, "owner">>> = {};
  // Unknown-outcome reconciliation: read-only checks, stopped on close.
  private reconcileStop = new AbortController();
  private reconciling = new Set<string>();
  sleep: ReconcileSleep = realSleep;
  judge: RiskJudge = offJudge;
  // Optional prompt-injection guard for Home tool output (main.ts).
  injectionGuard?: InjectionGuard;
  private hooks?: ApprovalHooks;
  constructor(readonly ha: HAClient) {}
  useApprovalHooks(hooks: ApprovalHooks) {
    this.hooks = hooks;
  }
  // Whether the server boundary's current configuration authorizes owner.
  isAuthorized(owner: string) {
    return this.authorizedOwners.has(owner);
  }
  private settled() {
    try {
      this.hooks?.settled();
    } catch {
      // Notification cleanup is best effort and never affects a decision.
    }
  }
  useJudge(judge: RiskJudge) {
    this.judge = judge;
  }
  useInjectionGuard(guard: InjectionGuard) {
    this.injectionGuard = guard;
  }
  get acknowledgement() {
    return this.ha.admin ? ADMIN_FULL_ACKNOWLEDGEMENT : FULL_ACKNOWLEDGEMENT;
  }
  // A trusted owner acknowledges what their Full grant means; a change of
  // trust therefore invalidates an earlier grant (acknowledge again).
  acknowledgementFor(owner: string) {
    if (!this.isTrusted(owner)) return this.acknowledgement;
    return this.ha.admin
      ? TRUSTED_ADMIN_FULL_ACKNOWLEDGEMENT
      : TRUSTED_FULL_ACKNOWLEDGEMENT;
  }
  // A configured trusted owner who is still an authorized owner.
  isTrusted(owner: string) {
    return (
      this.trustedOwners.has(owner) &&
      this.authorizedOwners.has(owner) &&
      this.role(owner) === "owner"
    );
  }
  // Deterministic class first; the judge may then only escalate.
  private assess(
    action: Action,
    base: RiskAssessment,
    judge: JudgeRecord,
  ): RiskAssessment {
    const level = judge.escalateTo
      ? maxRisk(base.level, judge.escalateTo)
      : base.level;
    return level === base.level
      ? base
      : {
          level,
          rule: `judge_escalated:${base.rule}`,
          reasons: [
            ...base.reasons,
            `Judge escalated ${base.level} → ${level}.`,
          ],
        };
  }
  // Supply the server-boundary's current configured owners before opening the
  // durable harness. An unconfigured engine grants no Home write authority.
  // Household roles come from the same configuration: members and guests;
  // everyone else authorized is an owner.
  // Trusted owners (trusted_user_ids) must be authorized owners.
  authorizeOwners(
    owners: readonly string[],
    roles: Readonly<Record<string, Exclude<HouseholdRole, "owner">>> = {},
    trusted: readonly string[] = [],
  ) {
    insist(!this.runtime, "owners_already_attached", 503);
    insist(
      trusted.every((id) => owners.includes(id) && !Object.hasOwn(roles, id)),
      "trusted_user_not_owner_role",
      503,
    );
    this.authorizedOwners = new Set(owners);
    this.roles = { ...roles };
    this.trustedOwners = new Set(trusted);
  }
  role(owner: string): HouseholdRole {
    return Object.hasOwn(this.roles, owner) ? this.roles[owner]! : "owner";
  }
  // Guests never write; members never get high or critical (checked after
  // judge escalation, at admission and again at dispatch).
  private assertRoleAllows(owner: string, level?: RiskAssessment["level"]) {
    const role = this.role(owner);
    insist(role !== "guest", "role_guest_read_only", 403);
    if (role === "member")
      insist(
        !!level && riskRank(level) < riskRank("high"),
        "role_requires_owner",
        403,
      );
  }
  attach(runtime: Runtime) {
    insist(
      !this.runtime || this.runtime === runtime,
      "actions_already_attached",
      503,
    );
    this.runtime = runtime;
    this.gate = runtime.admission;
    runtime.homeActions = this;
  }
  private host() {
    insist(
      this.runtime && !this.runtime.closing && !this.stopping,
      "closing",
      503,
    );
    return this.runtime;
  }
  async permission(tx: Tx, owner: string): Promise<HomePermission> {
    const doc = await tx.doc(HomePermissions);
    const policy = policyFingerprint(this.ha);
    const role = this.role(owner);
    if (!doc.owners[owner]) {
      insist(Object.keys(doc.owners).length < 100, "owner_limit", 429);
      doc.owners[owner] = {
        explicit: false,
        mode: this.ha.policy.enabled && role !== "guest" ? "ask" : "read-only",
        revision: 0,
        policy,
        schema: ACTION_SCHEMA,
        grant: null,
        invalidation: "",
        ...(role === "owner" ? {} : { role }),
      };
    }
    const item = doc.owners[owner]!;
    // A household role change bumps the revision (pending proposals go
    // stale) and never keeps a Full grant.
    if ((item.role ?? "owner") !== role) {
      item.revision++;
      item.grant = null;
      if (role === "owner") delete item.role;
      else item.role = role;
      if (item.mode === "full" || !item.explicit)
        item.mode = this.ha.policy.enabled ? "ask" : "read-only";
      item.invalidation =
        role === "owner"
          ? "Household role changed to owner; review Home permissions."
          : role === "member"
            ? "Member role: Full access is not available; owners approve high-risk changes."
            : "Guest role: Home is read-only.";
    }
    if (role === "guest" && (item.mode !== "read-only" || item.grant)) {
      item.revision++;
      item.mode = "read-only";
      item.grant = null;
      item.invalidation = "Guest role: Home is read-only.";
    }
    if (role === "member" && (item.mode === "full" || item.grant)) {
      item.revision++;
      item.mode = this.ha.policy.enabled ? "ask" : "read-only";
      item.grant = null;
      item.invalidation =
        "Member role: Full access is not available; owners approve high-risk changes.";
    }
    if (!this.authorizedOwners.has(owner)) {
      if (item.mode !== "read-only" || item.grant || !item.explicit) {
        item.revision++;
        item.mode = "read-only";
        item.explicit = true;
        item.grant = null;
        item.invalidation =
          "Owner removed from configured Home access; acknowledge permissions again if re-authorized.";
      }
    }
    if (item.policy !== policy || item.schema !== ACTION_SCHEMA) {
      item.revision++;
      item.policy = policy;
      item.schema = ACTION_SCHEMA;
      if (!item.explicit && this.authorizedOwners.has(owner))
        item.mode = this.ha.policy.enabled ? "ask" : "read-only";
      if (item.mode === "full") {
        item.mode = this.ha.policy.enabled ? "ask" : "read-only";
        item.invalidation =
          "Full access invalidated by policy/schema change; acknowledge again.";
      }
      item.grant = null;
    }
    if (
      item.mode === "full" &&
      (!this.ha.policy.enabled ||
        !item.grant ||
        item.grant.owner !== owner ||
        item.grant.policy !== policy ||
        item.grant.schema !== ACTION_SCHEMA ||
        item.grant.acknowledgement !== this.acknowledgementFor(owner))
    ) {
      item.mode = this.ha.policy.enabled ? "ask" : "read-only";
      item.revision++;
      item.grant = null;
      item.invalidation =
        "Full access grant invalid or missing; acknowledge again.";
    }
    return copy(item);
  }
  binding(permission: HomePermission): PermissionBinding {
    return {
      mode: this.ha.policy.enabled ? permission.mode : "read-only",
      revision: permission.revision,
      policy: permission.policy,
      grant: permission.grant ? digest(permission.grant) : "",
    };
  }
  async bind(tx: Tx, owner: string) {
    return this.binding(await this.permission(tx, owner));
  }
  async initialize() {
    const runtime = this.host();
    await runtime.harness.commit(async (tx) => {
      const permissions = await tx.doc(HomePermissions);
      const owners = new Set([
        ...Object.keys(permissions.owners),
        ...(await tx.doc(Catalog)).items.map((s) => s.owner),
      ]);
      for (const owner of owners) await this.permission(tx, owner);
    }, ctx);
  }
  private async barriers(tx: Tx) {
    const barriers: {
      sessionId: number;
      id: string;
      hash: string;
      status: string;
      owner: string;
      scope?: string[];
    }[] = [];
    for (const session of (await tx.doc(Catalog)).items) {
      if (session.kind === "workspace") continue;
      for (const item of Object.values(
        (await tx.doc(Proposals, session.id as ConversationId)).items,
      ))
        if (item.status === "unknown" || item.status === "dispatching")
          barriers.push({
            sessionId: session.id,
            id: item.id,
            hash: item.hash,
            status: item.status,
            owner: session.owner,
            ...(item.scope ? { scope: [...item.scope] } : {}),
          });
    }
    return barriers;
  }
  async settings(owner: string) {
    const runtime = this.host();
    return this.gate.run(() =>
      runtime.harness.commit(async (tx) => {
        const p = await this.permission(tx, owner);
        const barriers = await this.barriers(tx);
        return {
          ...p,
          effectiveMode: this.binding(p).mode,
          acknowledgement: this.acknowledgementFor(owner),
          trusted: this.isTrusted(owner),
          access: this.ha.admin ? "admin" : "scoped",
          judge: this.judge.describe(),
          enabled: this.ha.policy.enabled,
          role: this.role(owner),
          entityScopeCount: new Set(this.ha.policy.entities).size,
          services: [...new Set(this.ha.policy.services)].sort(),
          blocked: barriers.length > 0,
          // What an unresolved outcome pauses: every write, or only writes
          // to these entities (src/reconcile.ts writeScope).
          pause: {
            all: barriers.some((b) => !b.scope),
            entities: [
              ...new Set(barriers.flatMap((b) => b.scope ?? [])),
            ].sort(),
          },
          unresolved: barriers
            .filter((b) => b.owner === owner)
            .map(({ owner: _owner, ...b }) => b),
        };
      }, ctx),
    );
  }
  async setMode(
    owner: string,
    mode: unknown,
    revision: unknown,
    fingerprint: unknown,
    acknowledgement: unknown,
  ) {
    insist(this.authorizedOwners.has(owner), "user_not_authorized", 403);
    insist(mode === "read-only" || mode === "ask" || mode === "full");
    const role = this.role(owner);
    insist(
      role !== "guest" || mode === "read-only",
      "role_guest_read_only",
      403,
    );
    insist(role !== "member" || mode !== "full", "role_forbids_full", 403);
    insist(Number.isSafeInteger(revision) && Number(revision) >= 0);
    insist(
      typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint),
    );
    insist(
      acknowledgement === undefined ||
        acknowledgement === this.acknowledgementFor(owner),
    );
    const runtime = this.host();
    await this.gate.run(async () => {
      // Persist invalidation separately: a rejected stale client must not roll it back.
      await runtime.harness.commit((tx) => this.permission(tx, owner), ctx);
      await runtime.harness.commit(async (tx) => {
        const p = (await tx.doc(HomePermissions)).owners[owner]!;
        insist(
          p.revision === revision && p.policy === fingerprint,
          "permissions_stale",
          409,
        );
        if (mode !== "read-only")
          insist(this.ha.policy.enabled, "actions_disabled", 403);
        if (mode === "full")
          insist(
            acknowledgement === this.acknowledgementFor(owner),
            "full_acknowledgement_required",
            400,
          );
        p.explicit = true;
        p.mode = mode as HomeMode;
        p.revision++;
        p.invalidation = "";
        p.grant =
          mode === "full"
            ? {
                owner,
                policy: p.policy,
                schema: ACTION_SCHEMA,
                acknowledgement: this.acknowledgementFor(owner),
                at: Date.now(),
              }
            : null;
        for (const session of (await tx.doc(Catalog)).items) {
          if (session.owner !== owner || session.kind === "workspace") continue;
          for (const item of Object.values(
            (await tx.doc(Proposals, session.id as ConversationId)).items,
          )) {
            if (
              item.status === "pending" ||
              (item.status === "dispatching" && !item.attemptedAt)
            ) {
              item.status = "rejected";
              item.resolution =
                "Home permission change invalidated this action. Request a new action; nothing was retried.";
            }
          }
        }
      }, ctx);
      // Aborting an attempted transport cannot undo effects; its receipt stays unknown.
      for (const [controller, actionOwner] of this.controllers)
        if (actionOwner === owner) controller.abort();
    });
    this.settled();
    return this.settings(owner);
  }
  private async home(tx: Tx, sessionId: ConversationId, owner?: string) {
    const session = (await tx.doc(Catalog)).items.find(
      (s) => s.id === sessionId && (!owner || s.owner === owner),
    );
    insist(
      session && session.kind !== "workspace",
      "home_session_required",
      403,
    );
    return session;
  }
  // The owner's latest message in this conversation's current run: the only
  // conversation text the risk judge may see.
  private async latestRequest(tx: Tx, sessionId: ConversationId) {
    const ids = new Set((await tx.doc(LiveDoc, sessionId)).run?.inputs ?? []);
    const inputs = Object.values((await tx.doc(Inputs, sessionId)).requests)
      .filter((i) => ids.has(i.submissionId as never))
      .sort((a, b) => b.admitted - a.admitted);
    return requestText(inputs[0]?.content);
  }
  // The current run's inputs: their permission bindings, and the channel
  // ceiling (Hearth Assist). One satellite input in the run is enough to
  // lower the whole run to Ask, and so is the injection guard's mark on the
  // run (flagged tool output; src/injection-guard.ts), which only this
  // run's inputs carry. An input without a record keeps failing the Full
  // checks exactly as before (its binding is missing).
  private async inputBinding(tx: Tx, sessionId: ConversationId) {
    const ids = (await tx.doc(LiveDoc, sessionId)).run?.inputs ?? [];
    const inputs = Object.values((await tx.doc(Inputs, sessionId)).requests);
    const found = ids.map((id) => inputs.find((i) => i.submissionId === id));
    const channel = found.some((i) => i?.channel === "satellite")
      ? ("satellite" as const)
      : found.some((i) => i?.channel === "assist")
        ? ("assist" as const)
        : undefined;
    return {
      ids: [...ids] as number[],
      bindings: found.map((i) => i?.homePermission),
      ceiled: found.some((i) => i?.ceiling === "ask"),
      guarded: found.some((i) => i?.guard?.result === "flagged"),
      // Every input of the run is the person's own turn.
      direct: found.length > 0 && found.every((i) => i?.direct === true),
      channel,
    };
  }
  // Effective mode for a model proposal: the lower of the owner's mode and
  // the run's channel ceiling or injection-guard mark. Full falls to Ask (a
  // pending proposal for exact human approval) instead of failing; Ask and
  // Read-only stay.
  private effectiveMode(
    binding: PermissionBinding,
    input: { ceiled: boolean; guarded: boolean },
  ): HomeMode {
    return binding.mode === "full" && (input.ceiled || input.guarded)
      ? "ask"
      : binding.mode;
  }
  private assertFullGrant(owner: string, p: HomePermission) {
    insist(
      this.binding(p).mode === "full" &&
        p.grant?.owner === owner &&
        p.grant.policy === p.policy &&
        p.grant.schema === ACTION_SCHEMA &&
        p.grant.acknowledgement === this.acknowledgementFor(owner),
      "full_grant_required",
      403,
    );
  }
  // A trusted owner's proposal may run at any risk level only from their own
  // direct turn on Full access: no channel ceiling, no injection-guard mark,
  // every input of the run direct and admitted under this exact Full grant
  // (never upgraded).
  private trustedRun(
    owner: string,
    p: HomePermission,
    input: {
      ids: number[];
      bindings: (PermissionBinding | undefined)[];
      ceiled: boolean;
      guarded: boolean;
      direct: boolean;
    },
  ) {
    if (
      !this.isTrusted(owner) ||
      input.ceiled ||
      input.guarded ||
      !input.direct
    )
      return false;
    try {
      this.assertFull(owner, p, input);
      return true;
    } catch {
      return false;
    }
  }
  private assertFull(
    owner: string,
    p: HomePermission,
    input: { ids: number[]; bindings: (PermissionBinding | undefined)[] },
  ) {
    const binding = this.binding(p);
    this.assertFullGrant(owner, p);
    insist(
      input.ids.length > 0 &&
        input.bindings.every((b) => b && digest(b) === digest(binding)),
      "input_permission_not_elevated",
      403,
    );
  }
  async request(
    value: unknown,
    api: ToolExecutionApi,
    context: Context,
  ): Promise<Proposal> {
    const id = String(api.taskId);
    const { owner, latest, trusted } = await this.gate.run(() =>
      api.commit(async (tx) => {
        const session = await this.home(tx, api.conversationId);
        insist(
          this.role(session.owner) !== "guest",
          "role_guest_read_only",
          403,
        );
        const p = await this.permission(tx, session.owner);
        insist(this.binding(p).mode !== "read-only", "home_read_only", 403);
        return {
          owner: session.owner,
          latest: await this.latestRequest(tx, api.conversationId),
          trusted: this.trustedRun(
            session.owner,
            p,
            await this.inputBinding(tx, api.conversationId),
          ),
        };
      }, context),
    );
    let action = this.ha.action(value);
    insist(this.controllers.size < 4, "action_capacity", 429);
    const controller = new AbortController();
    this.controllers.set(controller, owner);
    const signal = AbortSignal.any([
      controller.signal,
      ...(context.abortSignal ? [context.abortSignal] : []),
    ]);
    try {
      const earlier =
        (await api.snapshot(Proposals, api.conversationId, context))?.items ??
        {};
      const existing = earlier[id];
      if (existing) return existing;
      // Live discovery can be slow; never hold the permission/revocation gate here.
      // List actions get the controller-read item text (hashed, re-checked);
      // config flow steps get their handler and step from Home Assistant or
      // this conversation's own flow receipts.
      action = await this.ha.prepareAction(action, signal, knownFlows(earlier));
      await this.ha.validateLive(action, signal);
      const facts = await this.ha.riskContext(action, signal);
      const base = classifyAction(action, facts);
      const scope = await this.scopeOf(action, facts, signal);
      // The judge sees only the owner's latest message and this exact action.
      // A trusted person's own turn on Full access never asks the judge.
      const judge = trusted
        ? TRUSTED_JUDGE
        : await this.judge.evaluate(
            {
              owner,
              conversation: api.conversationId,
              request: latest,
              action,
              level: base.level,
            },
            signal,
          );
      const risk = this.assess(action, base, judge);
      this.assertRoleAllows(owner, risk.level);
      const proposal = await this.gate.run(() =>
        api.commit(async (tx) => {
          insist(!signal.aborted && !this.stopping, "action_cancelled", 409);
          const session = await this.home(tx, api.conversationId, owner);
          this.assertRoleAllows(owner, risk.level);
          const p = await this.permission(tx, session.owner);
          const binding = this.binding(p);
          insist(binding.mode !== "read-only", "home_read_only", 403);
          const input = await this.inputBinding(tx, api.conversationId);
          const mode = this.effectiveMode(binding, input);
          if (mode === "full") this.assertFull(owner, p, input);
          await this.assertNotPaused(tx, scope);
          const doc = await tx.doc(Proposals, api.conversationId);
          if (doc.items[id]) return copy(doc.items[id]!);
          insist(Object.keys(doc.items).length < 100, "proposal_limit", 429);
          const now = Date.now();
          // Trusted: checked before the judge was skipped and again here.
          const trustedNow =
            trusted && mode === "full" && this.trustedRun(owner, p, input);
          const automatic =
            !trustedNow &&
            mode === "full" &&
            autoRunAllowed(risk, judge, action, this.ha.admin);
          const item: Proposal = {
            id,
            action,
            hash: digest({ session: api.conversationId, id, action }),
            policy: binding.policy,
            created: now,
            expires: now + 300000,
            status: "pending",
            decidedBy: "",
            decidedAt: 0,
            resolution: "",
            risk,
            judge,
            ...(risk.level === "critical"
              ? { confirmation: confirmationWord(action) }
              : {}),
            authorization: {
              ...binding,
              mode,
              source: trustedNow
                ? "trusted"
                : automatic
                  ? "automatic"
                  : "human",
              owner,
              inputIds: input.ids,
              ...(input.channel ? { channel: input.channel } : {}),
              ...(input.guarded ? { guard: "flagged" as const } : {}),
            },
            ...(scope ? { scope } : {}),
          };
          doc.items[id] = item;
          return copy(item);
        }, context),
      );
      if (
        proposal.status === "pending" &&
        proposal.authorization?.source === "human" &&
        !proposal.origin
      )
        try {
          this.hooks?.pending(owner, api.conversationId, proposal);
        } catch {
          // Phone approvals never affect admission.
        }
      if (
        proposal.authorization?.source === "automatic" ||
        proposal.authorization?.source === "trusted"
      ) {
        this.host();
        await this.dispatch(owner, api.conversationId, proposal, true, signal);
        return (await this.host().harness.snapshot(
          Proposals,
          api.conversationId,
          ctx,
        ))!.items[id]!;
      }
      return proposal;
    } finally {
      this.controllers.delete(controller);
    }
  }
  // The entities an action can change, for the unknown-outcome pause:
  // admin service targets' group members come from the classifier's live
  // read; a scoped toggle reads its one entity.
  private async scopeOf(
    action: Action,
    facts: RiskContext,
    signal: AbortSignal,
  ): Promise<string[] | undefined> {
    if (!("kind" in action)) {
      const members = await this.ha.groupMembers(action.entityId, signal);
      return writeScope(action, () => members);
    }
    return writeScope(action, riskMembers(facts));
  }
  // An unresolved outcome pauses new writes to the same entities, and every
  // write when either side can reach anything. Never a retry path: a new
  // proposal for the same entity waits until the unknown is settled.
  private async assertNotPaused(tx: Tx, scope: string[] | undefined) {
    insist(
      !(await this.barriers(tx)).some((b) => scopesOverlap(b.scope, scope)),
      "home_outcome_unresolved",
      409,
    );
  }
  // A person pressed an app ToggleAction. Same ledger, barriers, approval and
  // dispatch as model proposals: Read-only denies before any HA request; Ask
  // records a pending proposal for the exact approval card; Full dispatches
  // once within the current grant. Never retried; unknown stays unknown.
  async press(
    owner: string,
    sessionId: number,
    value: unknown,
    origin: NonNullable<Proposal["origin"]>,
  ): Promise<Proposal> {
    return this.admitHuman(owner, sessionId, value, origin);
  }
  // A person's own request (a press, or Undo's reverse action): the exact
  // same admission. `forceAsk` makes it ask even in Full access; `link` runs
  // inside the commit that creates the proposal (and may refuse it).
  private async admitHuman(
    owner: string,
    sessionId: number,
    value: unknown,
    origin: NonNullable<Proposal["origin"]>,
    options: {
      forceAsk?: boolean;
      link?: (items: Record<string, Proposal>, id: string) => void;
    } = {},
  ): Promise<Proposal> {
    const runtime = this.host();
    const conversationId = sessionId as ConversationId;
    insist(this.role(owner) !== "guest", "role_guest_read_only", 403);
    await this.gate.run(() =>
      runtime.harness.commit(async (tx) => {
        await this.home(tx, conversationId, owner);
        const p = await this.permission(tx, owner);
        insist(this.binding(p).mode !== "read-only", "home_read_only", 403);
      }, ctx),
    );
    let action = this.ha.action(value);
    insist(this.controllers.size < 4, "action_capacity", 429);
    const controller = new AbortController();
    this.controllers.set(controller, owner);
    const signal = controller.signal;
    try {
      action = await this.ha.prepareAction(action, signal);
      await this.ha.validateLive(action, signal);
      const facts = await this.ha.riskContext(action, signal);
      const risk = classifyAction(action, facts);
      const scope = await this.scopeOf(action, facts, signal);
      this.assertRoleAllows(owner, risk.level);
      const proposal = await this.gate.run(() =>
        runtime.harness.commit(async (tx) => {
          insist(!signal.aborted && !this.stopping, "action_cancelled", 409);
          await this.home(tx, conversationId, owner);
          this.assertRoleAllows(owner, risk.level);
          const p = await this.permission(tx, owner);
          const binding = this.binding(p);
          insist(binding.mode !== "read-only", "home_read_only", 403);
          if (binding.mode === "full") this.assertFullGrant(owner, p);
          await this.assertNotPaused(tx, scope);
          const doc = await tx.doc(Proposals, conversationId);
          insist(Object.keys(doc.items).length < 100, "proposal_limit", 429);
          // Model proposals use their task id; app presses use a disjoint
          // numeric range so neither can alias the other's receipt.
          let n = 1_000_000_000_000 + Object.keys(doc.items).length;
          while (doc.items[String(n)]) n++;
          const id = String(n);
          options.link?.(doc.items, id);
          const now = Date.now();
          const item: Proposal = {
            id,
            action,
            hash: digest({ session: conversationId, id, action }),
            policy: binding.policy,
            created: now,
            expires: now + 300000,
            status: "pending",
            decidedBy: "",
            decidedAt: 0,
            resolution: "",
            risk,
            judge: NO_JUDGE,
            ...(risk.level === "critical"
              ? { confirmation: confirmationWord(action) }
              : {}),
            authorization: {
              ...binding,
              // A trusted owner's own press on Full access runs at its
              // risk level (Undo's forced ask still asks).
              source:
                binding.mode === "full" &&
                !options.forceAsk &&
                this.isTrusted(owner)
                  ? "trusted"
                  : "human",
              owner,
              inputIds: [],
            },
            origin: { ...origin },
            ...(scope ? { scope } : {}),
          };
          doc.items[id] = item;
          return copy(item);
        }, ctx),
      );
      // A direct press in Full access runs only when low risk; otherwise the
      // owner reviews the exact action like any other proposal.
      if (
        proposal.authorization?.source !== "trusted" &&
        (options.forceAsk ||
          proposal.authorization?.mode !== "full" ||
          !autoRunAllowed(risk, NO_JUDGE, action, this.ha.admin))
      )
        return proposal;
      await this.dispatch(owner, conversationId, proposal, false, signal);
      return (await runtime.harness.snapshot(Proposals, conversationId, ctx))!
        .items[proposal.id]!;
    } finally {
      this.controllers.delete(controller);
    }
  }
  // Undo: a NEW exact proposal for the reverse of an accepted low/medium
  // change, built from the state Hearth read before sending it. Same
  // admission as a press (Read-only, Ask, Full, barriers, risk); it asks
  // whenever the entity changed again well after the attempt. Single use:
  // offered again only if the reverse was rejected or expired unsent.
  async undo(
    owner: string,
    sessionId: number,
    id: string,
    hash: string,
  ): Promise<Proposal> {
    insist(this.role(owner) !== "guest", "role_guest_read_only", 403);
    const runtime = this.host();
    const conversation = await runtime.session(owner, sessionId);
    const items =
      (await runtime.harness.snapshot(Proposals, conversation.id, ctx))
        ?.items ?? {};
    const original = items[id];
    insist(
      original &&
        original.hash === hash &&
        digest({ session: conversation.id, id, action: original.action }) ===
          hash,
      "proposal_not_found",
      404,
    );
    undoAllowed(original, items, Date.now());
    const before = original.undo!.before;
    const signal = AbortSignal.timeout(10000);
    let reverse: unknown = null;
    let forceAsk = false;
    if (before.kind === "entity") {
      const current = await this.ha.undoState(before.entityId, signal);
      insist(current, "ha_read_failed", 502);
      insist(!sameAsBefore(before, current), "nothing_to_undo", 409);
      reverse = reverseEntityAction(original.action, before);
      forceAsk =
        current.lastChangedMs > (original.attemptedAt ?? 0) + UNDO_STALE_MS;
    } else {
      const action = original.action as TodoAction;
      let matches: string[] = [];
      if (action.op === "add")
        matches = (await this.ha.readTodo(action.entityId, signal)).items
          .filter(
            (i) => i.status === "needs_action" && i.summary === action.summary,
          )
          .map((i) => i.uid);
      reverse = reverseTodoAction(action, matches);
      insist(
        reverse || action.op !== "add",
        matches.length ? "undo_item_ambiguous" : "nothing_to_undo",
        409,
      );
    }
    insist(reverse, "undo_unavailable", 409);
    return this.admitHuman(
      owner,
      sessionId,
      reverse,
      { kind: "undo", proposalId: id, hash },
      {
        forceAsk,
        link: (doc, reverseId) => {
          const item = doc[id];
          insist(item && item.hash === hash, "proposal_changed", 409);
          undoAllowed(item, doc, Date.now());
          item.undo!.reverse = reverseId;
        },
      },
    );
  }
  async decide(
    owner: string,
    sessionId: number,
    id: string,
    hash: string,
    decision: "approve" | "reject" | "resolve",
    note = "",
    confirm = "",
    via: DecisionVia = "ui",
  ) {
    try {
      return await this.decideOnce(
        owner,
        sessionId,
        id,
        hash,
        decision,
        note,
        confirm,
        via,
      );
    } finally {
      if (decision !== "resolve") this.settled();
    }
  }
  private async decideOnce(
    owner: string,
    sessionId: number,
    id: string,
    hash: string,
    decision: "approve" | "reject" | "resolve",
    note: string,
    confirm: string,
    via: DecisionVia,
  ) {
    insist(via === "ui" || decision !== "resolve", "invalid_request");
    const runtime = this.host();
    const conversation = await runtime.session(owner, sessionId);
    const proposal = (
      await runtime.harness.snapshot(Proposals, conversation.id, ctx)
    )?.items[id];
    insist(
      proposal &&
        proposal.hash === hash &&
        digest({ session: conversation.id, id, action: proposal.action }) ===
          hash,
      "proposal_not_found",
      404,
    );
    if (decision !== "approve") {
      await this.gate.run(() =>
        conversation.commit(async (tx) => {
          await this.home(tx, conversation.id, owner);
          const item = (await tx.doc(Proposals, conversation.id)).items[id]!;
          insist(item.hash === hash, "proposal_changed", 409);
          if (decision === "resolve") {
            insist(item.status === "unknown", "not_unknown", 409);
            item.resolution = runtime.redact(text(note, 300));
            item.status = "resolved";
            (await tx.doc(HomePermissions)).actionRevision++;
          } else {
            insist(item.status === "pending", "proposal_already_decided", 409);
            item.status = "rejected";
            if (via === "push") item.decidedVia = "push";
          }
          item.decidedBy = owner;
          item.decidedAt = Date.now();
        }, ctx),
      );
      return;
    }
    insist(proposal.status === "pending", "proposal_already_decided", 409);
    // A phone notification may approve only low and medium; high and
    // critical need the exact card in Hearth (and critical its typed word).
    // A proposal from a turn the injection guard flagged needs the card too.
    if (via === "push")
      insist(
        (proposal.risk?.level === "low" || proposal.risk?.level === "medium") &&
          proposal.authorization?.guard !== "flagged",
        "push_approval_not_allowed",
        403,
      );
    // Critical: a second explicit step, typing the exact word shown.
    if (proposal.risk?.level === "critical")
      insist(
        typeof confirm === "string" &&
          !!proposal.confirmation &&
          confirm === proposal.confirmation,
        "confirmation_required",
        400,
      );
    insist(
      (await this.settings(owner)).effectiveMode !== "read-only",
      "home_read_only",
      403,
    );
    this.ha.action(proposal.action);
    insist(this.controllers.size < 4, "action_capacity", 429);
    const controller = new AbortController();
    this.controllers.set(controller, owner);
    try {
      await this.dispatch(
        owner,
        conversation.id,
        proposal,
        false,
        controller.signal,
        true,
        via,
      );
    } finally {
      this.controllers.delete(controller);
    }
  }
  // Phone approvals: record that this pending model proposal is about to be
  // sent to the owner's phones, BEFORE the send, so it is sent at most once.
  // Returns the proposal, or null when it may not (or no longer) be sent.
  async markNotified(
    owner: string,
    sessionId: number,
    id: string,
    hash: string,
    notified: NonNullable<Proposal["notified"]>,
    minRemainingMs: number,
  ): Promise<Proposal | null> {
    const runtime = this.host();
    const conversationId = sessionId as ConversationId;
    return this.gate.run(() =>
      runtime.harness.commit(async (tx) => {
        const session = (await tx.doc(Catalog)).items.find(
          (s) => s.id === sessionId && s.owner === owner,
        );
        if (!session || session.kind === "workspace") return null;
        const item = (await tx.doc(Proposals, conversationId)).items[id];
        if (
          !item ||
          item.hash !== hash ||
          item.status !== "pending" ||
          item.origin ||
          item.notified ||
          item.authorization?.owner !== owner ||
          item.expires - notified.at < minRemainingMs
        )
          return null;
        item.notified = { ...notified };
        return copy(item);
      }, ctx),
    );
  }
  private async authorize(
    tx: Tx,
    owner: string,
    sessionId: ConversationId,
    proposal: Proposal,
    automatic: boolean,
  ) {
    await this.home(tx, sessionId, owner);
    this.assertRoleAllows(owner, proposal.risk?.level);
    const p = await this.permission(tx, owner);
    const binding = this.binding(p);
    insist(binding.mode !== "read-only", "home_read_only", 403);
    insist(
      proposal.expires > Date.now() && proposal.policy === binding.policy,
      "proposal_expired_or_policy_changed",
      409,
    );
    this.ha.action(proposal.action);
    if (proposal.authorization)
      insist(
        proposal.authorization.owner === owner &&
          proposal.authorization.revision === binding.revision &&
          proposal.authorization.grant === binding.grant,
        "action_permission_stale",
        409,
      );
    if (automatic) {
      const source = proposal.authorization?.source;
      insist(
        source === "automatic" || source === "trusted",
        "automatic_receipt_required",
        403,
      );
      // Trusted: the configured trusted owner's own direct turn, at any
      // risk level; otherwise only what the risk rules allow.
      if (source === "trusted")
        insist(this.isTrusted(owner), "trusted_owner_required", 403);
      else
        insist(
          proposal.risk &&
            proposal.judge &&
            autoRunAllowed(
              proposal.risk,
              proposal.judge,
              proposal.action,
              this.ha.admin,
            ),
          "risk_requires_approval",
          403,
        );
      const input = await this.inputBinding(tx, sessionId);
      // A channel ceiling (voice satellite) never runs without a person.
      insist(!input.ceiled, "input_channel_ceiling", 403);
      // Flagged tool output in this run never runs without a person.
      insist(!input.guarded, "input_guard_flagged", 403);
      if (source === "trusted") insist(input.direct, "input_not_direct", 403);
      this.assertFull(owner, p, input);
      insist(
        digest(input.ids) === digest(proposal.authorization!.inputIds),
        "action_input_changed",
        409,
      );
    }
    return binding;
  }
  private async dispatch(
    owner: string,
    sessionId: ConversationId,
    proposal: Proposal,
    automatic: boolean,
    signal: AbortSignal,
    validate = false,
    via: DecisionVia = "ui",
  ) {
    const runtime = this.host();
    if (validate) await this.ha.validateLive(proposal.action, signal);
    // Undo: read the entity right before the change (bounded; a failure
    // only means no Undo, never a blocked or delayed dispatch decision).
    const before =
      proposal.origin?.kind !== "undo" &&
      (proposal.risk?.level === "low" || proposal.risk?.level === "medium")
        ? await this.ha.undoSnapshot(proposal.action, signal)
        : null;
    // Reconciliation: the targets' readings right before the attempt, so an
    // unknown outcome can later be read back (never a reason to block).
    const prior = await this.reconcileBefore(proposal.action, before, signal);
    await this.gate.run(() =>
      runtime.harness.commit(async (tx) => {
        insist(!signal.aborted && !this.stopping, "action_cancelled", 409);
        const items = (await tx.doc(Proposals, sessionId)).items;
        const item = items[proposal.id]!;
        insist(item.status === "pending", "proposal_already_decided", 409);
        insist(
          item.hash === proposal.hash &&
            digest({ session: sessionId, id: item.id, action: item.action }) ===
              item.hash,
          "proposal_changed",
          409,
        );
        assertFlowCurrent(items, item);
        const binding = await this.authorize(
          tx,
          owner,
          sessionId,
          item,
          automatic,
        );
        await this.assertNotPaused(tx, item.scope);
        item.authorization ??= {
          ...binding,
          owner,
          source: "human",
          inputIds: [],
        };
        item.status = "dispatching";
        (await tx.doc(HomePermissions)).actionRevision++;
        item.decidedBy = owner;
        item.decidedAt = Date.now();
        if (via === "push") item.decidedVia = "push";
        if (before) item.undo = { before };
        if (prior) item.reconcile = { before: prior, checks: [] };
      }, ctx),
    );
    let send: Promise<void> | undefined;
    await this.gate.run(async () => {
      await runtime.harness.commit(async (tx) => {
        const item = (await tx.doc(Proposals, sessionId)).items[proposal.id]!;
        insist(
          item.status === "dispatching" && !item.attemptedAt,
          "dispatch_not_admitted",
          409,
        );
        insist(!signal.aborted && !this.stopping, "action_cancelled", 409);
        await this.authorize(tx, owner, sessionId, item, automatic);
        item.attemptedAt = Date.now();
      }, ctx);
      // Invoke exactly one POST before releasing the same gate used by revocation.
      const post = this.ha.dispatch(proposal.action, signal);
      send = (async () => {
        let status: "accepted" | "unknown" | "failed" = "unknown";
        let failure = "";
        // Config flows: Home Assistant's bounded, redacted reply.
        let flowResult: FlowResultSummary | undefined;
        try {
          flowResult = (await post) ?? undefined;
          if (!signal.aborted) status = "accepted";
        } catch (error) {
          // A DispatchFailed proposal was definitely refused before it could
          // have any side effect (Supervisor and config flows): it is done,
          // not a barrier, and never retried either way.
          if (error instanceof DispatchFailed) {
            status = "failed";
            failure = error.message;
            flowResult = error.flowResult;
          }
          /* Otherwise: never retry. */
        }
        const ended = await runtime.harness.commit(async (tx) => {
          const item = (await tx.doc(Proposals, sessionId)).items[proposal.id]!;
          if (item.status === "dispatching") {
            item.status = status;
            if (status === "accepted" && item.undo)
              item.undo.until = Date.now() + UNDO_WINDOW_MS;
            if (status === "failed")
              item.resolution = runtime.redact(failure.slice(0, 300));
            if (flowResult && status !== "unknown")
              item.flowResult = flowResult;
            (await tx.doc(HomePermissions)).actionRevision++;
          }
          return item.status;
        }, ctx);
        if (ended === "unknown") this.reconcileLater(sessionId, proposal.id);
      })();
      this.inFlight.add(send);
    });
    try {
      await send;
    } finally {
      if (send) this.inFlight.delete(send);
    }
  }
  // Entity readings before the attempt for an action with a well-defined
  // target state (the Undo reading when it covers the one target). Bounded;
  // a failure only means "did not happen" cannot be confirmed later.
  private async reconcileBefore(
    action: Action,
    undo: Awaited<ReturnType<HAClient["undoSnapshot"]>>,
    signal: AbortSignal,
  ): Promise<EntitySnapshot[] | null> {
    const plan = reconcilePlan(action);
    if (plan?.kind !== "entity") return null;
    const ids = plan.goals.map((g) => g.entityId);
    if (undo?.kind === "entity" && ids.length === 1 && ids[0] === undo.entityId)
      return [undo];
    const read = await this.readEntities(ids, signal, 2000);
    return read.every((r) => r) ? (read as EntitySnapshot[]) : null;
  }
  private readEntities(
    ids: readonly string[],
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ) {
    return Promise.all(
      ids.map((id) =>
        this.ha.undoState(id, signal, timeoutMs).catch(() => null),
      ),
    );
  }
  // After an unknown outcome: read the targets back at 5 s, 30 s and 2 min
  // (continuing after a restart). Read-only; it never sends a service call.
  private reconcileLater(sessionId: ConversationId, id: string, from = 0) {
    const key = `${sessionId}:${id}`;
    if (this.stopping || this.reconciling.has(key)) return;
    if (from >= RECONCILE_DELAYS_MS.length) return;
    this.reconciling.add(key);
    const signal = this.reconcileStop.signal;
    const run = (async () => {
      try {
        for (let i = from; i < RECONCILE_DELAYS_MS.length; i++) {
          await this.sleep(
            RECONCILE_DELAYS_MS[i]! -
              (i > from ? RECONCILE_DELAYS_MS[i - 1]! : 0),
            signal,
          );
          const more = await this.reconcileOnce(
            sessionId,
            id,
            i === RECONCILE_DELAYS_MS.length - 1,
            signal,
          );
          if (!more) break;
        }
      } catch {
        // Stopped or unreadable: the outcome stays unknown for a person.
      } finally {
        this.reconciling.delete(key);
      }
    })();
    this.inFlight.add(run);
    void run.finally(() => this.inFlight.delete(run));
  }
  // One read-only check. Returns whether another check should follow.
  private async reconcileOnce(
    sessionId: ConversationId,
    id: string,
    last: boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    const runtime = this.host();
    const item = (await runtime.harness.snapshot(Proposals, sessionId, ctx))
      ?.items[id];
    if (!item || item.status !== "unknown") return false;
    const plan = reconcilePlan(item.action);
    if (!plan) return false;
    const result =
      plan.kind === "entity"
        ? entityResult(
            plan.goals,
            await this.readEntities(
              plan.goals.map((g) => g.entityId),
              signal,
              5000,
            ),
            item.reconcile?.before,
          )
        : todoResult(
            plan.action,
            await this.ha
              .readTodo(plan.action.entityId, signal)
              .catch(() => null),
          );
    insist(!signal.aborted && !this.stopping, "closing", 503);
    return this.gate.run(() =>
      runtime.harness.commit(async (tx) => {
        const current = (await tx.doc(Proposals, sessionId)).items[id];
        // A person resolved it meanwhile (or it changed): nothing to record.
        if (
          !current ||
          current.status !== "unknown" ||
          current.hash !== item.hash
        )
          return false;
        const record = (current.reconcile ??= { checks: [] });
        const at = Date.now();
        record.checks.push({ at, result, note: RECONCILE_NOTES[result] });
        const settled =
          result === "intended"
            ? "succeeded"
            : last && result === "unchanged"
              ? "did_not_happen"
              : undefined;
        if (settled) {
          record.outcome = settled;
          current.status = "resolved";
          current.resolution =
            settled === "succeeded"
              ? RECONCILED_SUCCEEDED
              : RECONCILED_DID_NOT_HAPPEN;
          (await tx.doc(HomePermissions)).actionRevision++;
          return false;
        }
        if (last)
          record.checks.push({
            at,
            result,
            note: RECONCILE_GAVE_UP,
          });
        return !last;
      }, ctx),
    );
  }
  // At startup: continue reconciling unknown outcomes that still have
  // checks left (dispatches a restart interrupted included).
  async resumeReconciliation() {
    const runtime = this.host();
    for (const session of (await runtime.harness.snapshot(Catalog, ctx))
      ?.items ?? []) {
      if (session.kind === "workspace") continue;
      const items =
        (
          await runtime.harness.snapshot(
            Proposals,
            session.id as ConversationId,
            ctx,
          )
        )?.items ?? {};
      for (const item of Object.values(items))
        if (item.status === "unknown" && reconcilePlan(item.action))
          this.reconcileLater(
            session.id as ConversationId,
            item.id,
            item.reconcile?.checks.filter((c) => c.note !== RECONCILE_GAVE_UP)
              .length ?? 0,
          );
    }
  }
  async close() {
    this.stopping = true;
    this.reconcileStop.abort();
    for (const controller of this.controllers.keys()) controller.abort();
    await Promise.allSettled(this.inFlight);
  }
}
// Whether Undo may (still) be used on an accepted receipt; throws why not.
function undoAllowed(
  original: Proposal,
  items: Record<string, Proposal>,
  now: number,
) {
  insist(
    original.status === "accepted" &&
      original.undo &&
      original.origin?.kind !== "undo" &&
      (original.risk?.level === "low" || original.risk?.level === "medium"),
    "undo_unavailable",
    409,
  );
  insist((original.undo.until ?? 0) > now, "undo_expired", 409);
  const reverse = original.undo.reverse
    ? items[original.undo.reverse]
    : undefined;
  insist(
    !reverse ||
      reverse.status === "rejected" ||
      (reverse.status === "pending" && reverse.expires <= now),
    "undo_already_used",
    409,
  );
}
// Compatibility facade: HTTP and existing human-review clients share HA's engine.
export class Actions {
  readonly engine: HomeActions;
  constructor(runtime: Runtime, ha: HAClient) {
    this.engine = ha.actions;
    this.engine.attach(runtime);
  }
  decide(...args: Parameters<HomeActions["decide"]>) {
    return this.engine.decide(...args);
  }
  close() {
    return this.engine.close();
  }
}
