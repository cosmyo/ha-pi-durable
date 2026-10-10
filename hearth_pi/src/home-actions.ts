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
import { classifyAction, confirmationWord, maxRisk } from "./risk.js";
import { offJudge, type RiskJudge } from "./judge.js";
import type { Action, JudgeRecord, RiskAssessment } from "./documents.js";

export const ACTION_SCHEMA = 1;
export const FULL_ACKNOWLEDGEMENT =
  "Auto-approve supported Home actions within this exact configured policy; no host or admin access.";
// Admin access mode's Full grant: the risk classifier, not an entity list,
// bounds what may run without a person.
export const ADMIN_FULL_ACKNOWLEDGEMENT =
  "Auto-approve only low-risk Home Assistant admin actions, and medium ones a risk judge agrees with; high and critical always ask; no host shell or filesystem.";
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
  if (risk.level === "low") return true;
  return risk.level === "medium" && judge.verdict === "agreed";
}
const NO_JUDGE: JudgeRecord = {
  model: "off",
  verdict: "not_applicable",
  reason: "Pressed by you directly; no judge needed.",
  latencyMs: 0,
};

// One engine owns permission revisions and both human/automatic action admission.
// The gate never spans HA waits. Dispatch intent and attempt are separate durable commits.
export class HomeActions {
  private gate = new Serial();
  private runtime?: Runtime;
  private stopping = false;
  private controllers = new Map<AbortController, string>();
  private inFlight = new Set<Promise<unknown>>();
  private authorizedOwners = new Set<string>();
  judge: RiskJudge = offJudge;
  constructor(readonly ha: HAClient) {}
  useJudge(judge: RiskJudge) {
    this.judge = judge;
  }
  get acknowledgement() {
    return this.ha.admin ? ADMIN_FULL_ACKNOWLEDGEMENT : FULL_ACKNOWLEDGEMENT;
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
  authorizeOwners(owners: readonly string[]) {
    insist(!this.runtime, "owners_already_attached", 503);
    this.authorizedOwners = new Set(owners);
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
    if (!doc.owners[owner]) {
      insist(Object.keys(doc.owners).length < 100, "owner_limit", 429);
      doc.owners[owner] = {
        explicit: false,
        mode: this.ha.policy.enabled ? "ask" : "read-only",
        revision: 0,
        policy,
        schema: ACTION_SCHEMA,
        grant: null,
        invalidation: "",
      };
    }
    const item = doc.owners[owner]!;
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
        item.grant.acknowledgement !== this.acknowledgement)
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
          acknowledgement: this.acknowledgement,
          access: this.ha.admin ? "admin" : "scoped",
          judge: this.judge.describe(),
          enabled: this.ha.policy.enabled,
          entityScopeCount: new Set(this.ha.policy.entities).size,
          services: [...new Set(this.ha.policy.services)].sort(),
          blocked: barriers.length > 0,
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
    insist(Number.isSafeInteger(revision) && Number(revision) >= 0);
    insist(
      typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint),
    );
    insist(
      acknowledgement === undefined || acknowledgement === this.acknowledgement,
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
            acknowledgement === this.acknowledgement,
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
                acknowledgement: this.acknowledgement,
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
  private async inputBinding(tx: Tx, sessionId: ConversationId) {
    const ids = (await tx.doc(LiveDoc, sessionId)).run?.inputs ?? [];
    const inputs = Object.values((await tx.doc(Inputs, sessionId)).requests);
    return {
      ids: [...ids] as number[],
      bindings: ids.map(
        (id) => inputs.find((i) => i.submissionId === id)?.homePermission,
      ),
    };
  }
  private assertFullGrant(owner: string, p: HomePermission) {
    insist(
      this.binding(p).mode === "full" &&
        p.grant?.owner === owner &&
        p.grant.policy === p.policy &&
        p.grant.schema === ACTION_SCHEMA &&
        p.grant.acknowledgement === this.acknowledgement,
      "full_grant_required",
      403,
    );
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
    const { owner, latest } = await this.gate.run(() =>
      api.commit(async (tx) => {
        const session = await this.home(tx, api.conversationId);
        const p = await this.permission(tx, session.owner);
        insist(this.binding(p).mode !== "read-only", "home_read_only", 403);
        return {
          owner: session.owner,
          latest: await this.latestRequest(tx, api.conversationId),
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
      const existing = (
        await api.snapshot(Proposals, api.conversationId, context)
      )?.items[id];
      if (existing) return existing;
      // Live discovery can be slow; never hold the permission/revocation gate here.
      // List actions get the controller-read item text (hashed, re-checked).
      action = await this.ha.prepareAction(action, signal);
      await this.ha.validateLive(action, signal);
      const base = classifyAction(
        action,
        await this.ha.riskContext(action, signal),
      );
      // The judge sees only the owner's latest message and this exact action.
      const judge = await this.judge.evaluate(
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
      const proposal = await this.gate.run(() =>
        api.commit(async (tx) => {
          insist(!signal.aborted && !this.stopping, "action_cancelled", 409);
          const session = await this.home(tx, api.conversationId, owner);
          const p = await this.permission(tx, session.owner);
          const binding = this.binding(p);
          insist(binding.mode !== "read-only", "home_read_only", 403);
          const input = await this.inputBinding(tx, api.conversationId);
          if (binding.mode === "full") this.assertFull(owner, p, input);
          insist(
            (await this.barriers(tx)).length === 0,
            "home_outcome_unresolved",
            409,
          );
          const doc = await tx.doc(Proposals, api.conversationId);
          if (doc.items[id]) return copy(doc.items[id]!);
          insist(Object.keys(doc.items).length < 100, "proposal_limit", 429);
          const now = Date.now();
          const automatic =
            binding.mode === "full" &&
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
              source: automatic ? "automatic" : "human",
              owner,
              inputIds: input.ids,
            },
          };
          doc.items[id] = item;
          return copy(item);
        }, context),
      );
      if (proposal.authorization?.source === "automatic") {
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
    const runtime = this.host();
    const conversationId = sessionId as ConversationId;
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
      const risk = classifyAction(
        action,
        await this.ha.riskContext(action, signal),
      );
      const proposal = await this.gate.run(() =>
        runtime.harness.commit(async (tx) => {
          insist(!signal.aborted && !this.stopping, "action_cancelled", 409);
          await this.home(tx, conversationId, owner);
          const p = await this.permission(tx, owner);
          const binding = this.binding(p);
          insist(binding.mode !== "read-only", "home_read_only", 403);
          if (binding.mode === "full") this.assertFullGrant(owner, p);
          insist(
            (await this.barriers(tx)).length === 0,
            "home_outcome_unresolved",
            409,
          );
          const doc = await tx.doc(Proposals, conversationId);
          insist(Object.keys(doc.items).length < 100, "proposal_limit", 429);
          // Model proposals use their task id; app presses use a disjoint
          // numeric range so neither can alias the other's receipt.
          let n = 1_000_000_000_000 + Object.keys(doc.items).length;
          while (doc.items[String(n)]) n++;
          const id = String(n);
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
              source: "human",
              owner,
              inputIds: [],
            },
            origin: { ...origin },
          };
          doc.items[id] = item;
          return copy(item);
        }, ctx),
      );
      // A direct press in Full access runs only when low risk; otherwise the
      // owner reviews the exact action like any other proposal.
      if (
        proposal.authorization?.mode !== "full" ||
        !autoRunAllowed(risk, NO_JUDGE, action, this.ha.admin)
      )
        return proposal;
      await this.dispatch(owner, conversationId, proposal, false, signal);
      return (await runtime.harness.snapshot(Proposals, conversationId, ctx))!
        .items[proposal.id]!;
    } finally {
      this.controllers.delete(controller);
    }
  }
  async decide(
    owner: string,
    sessionId: number,
    id: string,
    hash: string,
    decision: "approve" | "reject" | "resolve",
    note = "",
    confirm = "",
  ) {
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
          }
          item.decidedBy = owner;
          item.decidedAt = Date.now();
        }, ctx),
      );
      return;
    }
    insist(proposal.status === "pending", "proposal_already_decided", 409);
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
      );
    } finally {
      this.controllers.delete(controller);
    }
  }
  private async authorize(
    tx: Tx,
    owner: string,
    sessionId: ConversationId,
    proposal: Proposal,
    automatic: boolean,
  ) {
    await this.home(tx, sessionId, owner);
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
      insist(
        proposal.authorization?.source === "automatic",
        "automatic_receipt_required",
        403,
      );
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
      this.assertFull(owner, p, input);
      insist(
        digest(input.ids) === digest(proposal.authorization.inputIds),
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
  ) {
    const runtime = this.host();
    if (validate) await this.ha.validateLive(proposal.action, signal);
    await this.gate.run(() =>
      runtime.harness.commit(async (tx) => {
        insist(!signal.aborted && !this.stopping, "action_cancelled", 409);
        const item = (await tx.doc(Proposals, sessionId)).items[proposal.id]!;
        insist(item.status === "pending", "proposal_already_decided", 409);
        insist(
          item.hash === proposal.hash &&
            digest({ session: sessionId, id: item.id, action: item.action }) ===
              item.hash,
          "proposal_changed",
          409,
        );
        const binding = await this.authorize(
          tx,
          owner,
          sessionId,
          item,
          automatic,
        );
        insist(
          (await this.barriers(tx)).length === 0,
          "home_outcome_unresolved",
          409,
        );
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
        try {
          await post;
          if (!signal.aborted) status = "accepted";
        } catch (error) {
          // A DispatchFailed proposal was definitely refused before it could
          // have any side effect (Supervisor only, today): it is done, not a
          // barrier, and never retried either way.
          if (error instanceof DispatchFailed) {
            status = "failed";
            failure = error.message;
          }
          /* Otherwise: never retry. */
        }
        await runtime.harness.commit(async (tx) => {
          const item = (await tx.doc(Proposals, sessionId)).items[proposal.id]!;
          if (item.status === "dispatching") {
            item.status = status;
            if (status === "failed")
              item.resolution = runtime.redact(failure.slice(0, 300));
            (await tx.doc(HomePermissions)).actionRevision++;
          }
        }, ctx);
      })();
      this.inFlight.add(send);
    });
    try {
      await send;
    } finally {
      if (send) this.inFlight.delete(send);
    }
  }
  async close() {
    this.stopping = true;
    for (const controller of this.controllers.keys()) controller.abort();
    await Promise.allSettled(this.inFlight);
  }
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
