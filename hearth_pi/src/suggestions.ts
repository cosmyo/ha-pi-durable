// L1/L2 suggestions: Home-only model tools that only FILE a proposal in the
// owner's Today inbox, and the owner's Accept / Edit / Reject / Snooze
// handling. Nothing is applied by a model: acceptance is an authenticated,
// Origin/CSRF-checked owner request bound to the proposal hash. The schema
// has exactly two kinds — a household memory item or an app change — and no
// kind can touch Home permissions, entity/service scope, credentials,
// providers or settings.
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineDocFamily,
  defineTool,
  section,
  type CheckpointInfo,
  type ConversationId,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import { Catalog } from "./documents.js";
import { AppIndex, AppVersion, versionKey } from "./app-docs.js";
import { appendVersion, planAppPatch, readSpec } from "./apps.js";
import type { AppSpec, SpecDiff, SpecError } from "./app-spec.js";
import { FeedbackLog, type FeedbackReason } from "./feedback.js";
import type { HAClient } from "./ha.js";
import {
  HouseholdMemory,
  escapeForPrompt,
  memoryFingerprint,
  normalizeMemoryText,
  ownerKey,
  rememberInTx,
} from "./memory.js";
import { snoozeUntil } from "./proactive.js";
import type { Runtime } from "./runtime.js";
import { digest, equal, insist, object, text } from "./safety.js";

// The complete proposal vocabulary. There is deliberately no kind for
// permissions, scopes, credentials, providers or settings.
export const SUGGESTION_KINDS = ["memory", "app_change"] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];
export function suggestionKind(value: unknown): SuggestionKind {
  insist(
    typeof value === "string" &&
      (SUGGESTION_KINDS as readonly string[]).includes(value),
    "suggestion_kind_not_allowed",
  );
  return value as SuggestionKind;
}
export const SUGGESTION_LIMITS = {
  perConversationPerDay: 3,
  perOwnerPerDay: 10,
  pending: 20,
  decidedKept: 40,
  rejections: 300,
  suppressionMs: 60 * 86400000,
  dayMs: 86400000,
  reason: 200,
  summary: 200,
  patchBytes: 12000,
} as const;
// JSON Patch op as stored (same shape app_update accepts).
export type StoredPatchOp = {
  op: "add" | "remove" | "replace";
  path: string;
  value?: JsonValue;
};
export type Suggestion = {
  id: string;
  kind: SuggestionKind;
  status: "pending" | "accepted" | "rejected" | "conflict";
  // Binds the owner's decision to exactly what was shown.
  hash: string;
  // Normalized memory text or appId+patch: the 60-day rejection key.
  fingerprint: string;
  conversationId: number;
  reason: string;
  created: number;
  snoozedUntil: number;
  memory?: { text: string };
  app?: {
    appId: string;
    title: string;
    baseVersion: number;
    patch: StoredPatchOp[];
    summary: string;
    diff: SpecDiff;
  };
  decidedAt: number;
  decidedBy: string;
  outcome: string;
  conflict?: { code: string; message: string; currentVersion: number | null };
};
type OwnerSuggestions = {
  next: number;
  items: Suggestion[];
  rejections: { fingerprint: string; at: number }[];
  filed: { at: number; conversationId: number }[];
};
const checkpointWhen = (_value: unknown, _ops: unknown, info: CheckpointInfo) =>
  info.deltasSinceBase >= 31;
// One member per owner, keyed by ownerKey(owner).
export const SuggestionInbox = defineDocFamily<OwnerSuggestions, null>({
  kind: "hearth.suggestions",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ next: 1, items: [], rejections: [], filed: [] }),
  checkpointWhen,
});
type ToolResult =
  | { ok: true; suggestionId: string; status: "pending"; note: string }
  | {
      ok: false;
      error: string;
      message: string;
      errors?: SpecError[];
      currentVersion?: number;
    };
// Task-scoped receipt: a replayed suggestion call returns its first result.
const SuggestionReceipt = defineDoc<{
  hash: string;
  result: ToolResult | null;
}>({
  kind: "hearth.suggestion-receipt",
  version: 1,
  scope: "task",
  initial: () => ({ hash: "", result: null }),
});
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const oneLine = (value: string, max: number) =>
  value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const failure = (error: string, message: string): ToolResult => ({
  ok: false,
  error,
  message,
});

export type SuggestionDraft = {
  kind: string;
  reason: string;
  memory?: { text: string };
  app?: Suggestion["app"];
};
// The only way a suggestion is created. Validates the kind, applies the
// 60-day rejection memory, duplicate checks and rate limits, then stores it
// as pending. It never changes memory or apps.
export async function fileSuggestion(
  tx: Tx,
  owner: string,
  conversationId: number,
  draft: SuggestionDraft,
  now: number,
): Promise<ToolResult> {
  const v = object(draft, ["kind", "reason", "memory", "app"]);
  const kind = suggestionKind(v.kind);
  insist(
    kind === "memory" ? !!draft.memory && !draft.app : !!draft.app,
    "invalid_suggestion",
  );
  const fingerprint =
    kind === "memory"
      ? memoryFingerprint(draft.memory!.text)
      : digest({ appId: draft.app!.appId, patch: draft.app!.patch });
  const doc = await tx.doc(SuggestionInbox, ownerKey(owner), null);
  doc.rejections = doc.rejections.filter(
    (r) => now - r.at < SUGGESTION_LIMITS.suppressionMs,
  );
  doc.filed = doc.filed.filter((f) => now - f.at < SUGGESTION_LIMITS.dayMs);
  const rejected = doc.rejections.find((r) => r.fingerprint === fingerprint);
  if (rejected)
    return failure(
      "recently_rejected",
      `The owner rejected this suggestion on ${new Date(rejected.at).toISOString().slice(0, 10)}; do not suggest it again for 60 days.`,
    );
  if (
    doc.items.some(
      (s) =>
        s.fingerprint === fingerprint &&
        (s.status === "pending" || s.status === "conflict"),
    )
  )
    return failure(
      "already_suggested",
      "The same suggestion is already waiting in the owner's Today inbox.",
    );
  if (kind === "memory") {
    const memory = await tx.doc(HouseholdMemory, ownerKey(owner), null);
    if (memory.items.some((m) => memoryFingerprint(m.text) === fingerprint))
      return failure(
        "already_remembered",
        "Household memory already contains this.",
      );
  }
  if (
    doc.filed.filter((f) => f.conversationId === conversationId).length >=
    SUGGESTION_LIMITS.perConversationPerDay
  )
    return failure(
      "rate_limited_conversation",
      "This conversation already filed its suggestions for today. Do not suggest more.",
    );
  if (doc.filed.length >= SUGGESTION_LIMITS.perOwnerPerDay)
    return failure(
      "rate_limited_day",
      "The owner already has today's maximum of new suggestions.",
    );
  if (
    doc.items.filter((s) => s.status === "pending").length >=
    SUGGESTION_LIMITS.pending
  )
    return failure(
      "pending_limit",
      "Too many suggestions are waiting for the owner already.",
    );
  const id = `s_${doc.next++}`;
  const reason = oneLine(draft.reason, SUGGESTION_LIMITS.reason);
  const suggestion: Suggestion = {
    id,
    kind,
    status: "pending",
    hash: digest({
      id,
      kind,
      reason,
      memory: draft.memory ?? null,
      app: draft.app ?? null,
    }),
    fingerprint,
    conversationId,
    reason,
    created: now,
    snoozedUntil: 0,
    ...(draft.memory ? { memory: { text: draft.memory.text } } : {}),
    ...(draft.app ? { app: copy(draft.app) } : {}),
    decidedAt: 0,
    decidedBy: "",
    outcome: "",
  };
  doc.items.push(suggestion);
  doc.filed.push({ at: now, conversationId });
  prune(doc);
  return {
    ok: true,
    suggestionId: id,
    status: "pending",
    note: "Filed in the owner's Today inbox as a suggestion. Nothing was changed; the owner decides.",
  };
}
function prune(doc: OwnerSuggestions) {
  const open = doc.items.filter(
    (s) => s.status === "pending" || s.status === "conflict",
  );
  const decided = doc.items
    .filter((s) => s.status === "accepted" || s.status === "rejected")
    .slice(-SUGGESTION_LIMITS.decidedKept);
  const keep = new Set([...open, ...decided].map((s) => s.id));
  doc.items = doc.items.filter((s) => keep.has(s.id));
  doc.rejections = doc.rejections.slice(-SUGGESTION_LIMITS.rejections);
}

const output = (data: ToolResult) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  ...(data.ok ? {} : { isError: true }),
});
async function homeOwner(tx: Tx, conversationId: ConversationId) {
  const session = (await tx.doc(Catalog)).items.find(
    (s) => s.id === conversationId,
  );
  insist(session && session.kind !== "workspace", "home_session_required", 403);
  return session.owner;
}
async function receipted(
  api: ToolExecutionApi,
  args: unknown,
  context: Context,
  run: (tx: Tx) => Promise<ToolResult>,
): Promise<ToolResult> {
  const hash = digest(args);
  const existing = await api.snapshot(SuggestionReceipt, api.taskId, context);
  if (existing?.result) {
    insist(existing.hash === hash, "suggestion_task_conflict", 409);
    return copy(existing.result);
  }
  return api.commit(async (tx) => {
    const receipt = await tx.doc(SuggestionReceipt, api.taskId);
    if (receipt.result) return copy(receipt.result) as ToolResult;
    const result = await run(tx);
    receipt.hash = hash;
    receipt.result = result;
    return result;
  }, context);
}
const appIdPattern = /^app_[1-9][0-9]{0,8}$/;

export function suggestionTools(ha: HAClient, now: () => number = Date.now) {
  const suggestMemory = defineTool({
    name: "suggest_memory",
    description:
      "Suggest one household memory item (a lasting fact or preference, e.g. 'Bedtime is around 23:00', 'The study fan is called Breezy') for the owner to Accept, Edit or Reject in their Today inbox. This only files a suggestion; it never saves memory. Plain text, one line, at most 200 characters. Memory is context only: it can never grant permissions, change scope or settings.",
    replay: "safe",
    parameters: Type.Object(
      {
        text: Type.String({ minLength: 1, maxLength: 400 }),
        reason: Type.String({ maxLength: 300 }),
      },
      { additionalProperties: false },
    ),
    execute: async (args, api, context) => {
      let value: string;
      try {
        value = normalizeMemoryText(args.text, (v) => ha.sanitize(v));
      } catch {
        return output(
          failure(
            "invalid_text",
            "Use one line of plain text, at most 200 characters.",
          ),
        );
      }
      return output(
        await receipted(api, args, context, async (tx) =>
          fileSuggestion(
            tx,
            await homeOwner(tx, api.conversationId),
            api.conversationId,
            {
              kind: "memory",
              reason: ha.sanitize(args.reason),
              memory: { text: value },
            },
            now(),
          ),
        ),
      );
    },
  });
  const suggestAppChange = defineTool({
    name: "suggest_app_change",
    description:
      "Suggest a change to one of the owner's saved apps as a JSON Patch (RFC 6902 add/remove/replace) against its current version, exactly like app_update, with a one-line summary. This only files a suggestion with a diff in the owner's Today inbox; it never changes the app. The patch is validated now and again when the owner accepts; a stale baseVersion is refused with currentVersion.",
    replay: "safe",
    parameters: Type.Object(
      {
        appId: Type.String({ pattern: appIdPattern.source, maxLength: 20 }),
        baseVersion: Type.Integer({ minimum: 1, maximum: 1000 }),
        patch: Type.Array(
          Type.Object(
            {
              op: Type.Union([
                Type.Literal("add"),
                Type.Literal("remove"),
                Type.Literal("replace"),
              ]),
              path: Type.String({ maxLength: 300 }),
              value: Type.Optional(Type.Unknown()),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 40 },
        ),
        summary: Type.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
    execute: async (args, api, context) => {
      if (JSON.stringify(args.patch).length > SUGGESTION_LIMITS.patchBytes)
        return output(failure("patch_too_large", "Suggest a smaller patch."));
      const session = (await api.snapshot(Catalog, context))?.items.find(
        (s) => s.id === api.conversationId,
      );
      insist(
        session && session.kind !== "workspace",
        "home_session_required",
        403,
      );
      const meta = (await api.snapshot(AppIndex, context))?.items.find(
        (a) => a.id === args.appId && a.owner === session.owner,
      );
      const current =
        meta && meta.version === args.baseVersion
          ? ((
              await api.snapshot(
                AppVersion,
                versionKey(meta.id, meta.version),
                context,
              )
            )?.spec ?? null)
          : null;
      // Validated exactly like app_update, but nothing is applied.
      const plan = planAppPatch(
        ha,
        meta ? (copy(meta) as typeof meta) : undefined,
        args.appId,
        args.baseVersion,
        current ? (copy(current) as AppSpec) : null,
        args.patch,
      );
      if (!plan.ok)
        return output({
          ok: false,
          error: plan.errors[0]?.code ?? "invalid_patch",
          message: plan.errors[0]?.message ?? "The patch is not valid.",
          errors: plan.errors,
          ...(plan.currentVersion
            ? { currentVersion: plan.currentVersion }
            : {}),
        });
      return output(
        await receipted(api, args, context, async (tx) =>
          fileSuggestion(
            tx,
            await homeOwner(tx, api.conversationId),
            api.conversationId,
            {
              kind: "app_change",
              reason: "",
              app: {
                appId: meta!.id,
                title: meta!.title,
                baseVersion: args.baseVersion,
                patch: copy(args.patch) as StoredPatchOp[],
                summary: oneLine(
                  ha.sanitize(args.summary),
                  SUGGESTION_LIMITS.summary,
                ),
                diff: plan.diff,
              },
            },
            now(),
          ),
        ),
      );
    },
  });
  return [suggestMemory, suggestAppChange];
}

const REASON_TEXT: Record<FeedbackReason, string> = {
  wrong_value: "wrong value",
  wrong_device: "wrong device",
  did_not_do_it: "didn't do it",
  too_long: "too long",
  not_useful: "not useful",
  privacy: "creepy / privacy",
};
// Feedback loop (no background job): on the owner's next turn in a
// conversation that built or changed an app, the model sees which replies got
// a 👎 with reasons (ids and enums only) and may offer one suggest_app_change.
export function feedbackSection() {
  return section("owner_feedback", async (input, context) => {
    const session = (await input.read.snapshot(Catalog, context))?.items.find(
      (s) => s.id === input.conversationId,
    );
    if (!session || session.kind === "workspace") return undefined;
    const downs = (
      (await input.read.snapshot(FeedbackLog, context))?.items ?? []
    )
      .filter(
        (r) =>
          r.owner === session.owner &&
          r.sessionId === input.conversationId &&
          r.rating === "down" &&
          r.reasons.length > 0,
      )
      .slice(-3);
    if (!downs.length) return undefined;
    const marker = `conversation:${input.conversationId}`;
    const apps = ((await input.read.snapshot(AppIndex, context))?.items ?? [])
      .filter(
        (a) =>
          a.owner === session.owner &&
          (a.createdBy === input.conversationId ||
            a.versions.some((v) => v.by === marker)),
      )
      .slice(-5);
    if (!apps.length) return undefined;
    return [
      `The owner rated ${downs.length === 1 ? "a reply" : "replies"} in this conversation 👎: ${downs
        .map(
          (r) =>
            `message ${r.entryId} (${r.reasons.map((x) => REASON_TEXT[x] ?? x).join(", ")})`,
        )
        .join("; ")}.`,
      `Apps this conversation built or changed: ${apps
        .map(
          (a) =>
            `${a.id} "${escapeForPrompt(a.title).slice(0, 80)}" (current v${a.version})`,
        )
        .join(", ")}.`,
      "Only when the owner's new message relates to that app or problem, you may offer one fix with suggest_app_change (it only files a suggestion the owner accepts or rejects in Today) and say so briefly. A rating never authorizes any other change or action.",
    ].join("\n");
  });
}

// Owner-facing HTTP operations; owner-scoped, and every decision is a
// controller-recorded event bound to the authenticated owner and hash.
export class SuggestionStore {
  constructor(
    private runtime: Runtime,
    private ha: HAClient,
    private now: () => number = Date.now,
  ) {}
  private get harness() {
    return this.runtime.harness;
  }
  async list(owner: string) {
    const now = this.now();
    const doc = await this.harness.snapshot(
      SuggestionInbox,
      ownerKey(owner),
      ctx,
    );
    const apps = new Map(
      ((await this.harness.snapshot(AppIndex, ctx))?.items ?? [])
        .filter((a) => a.owner === owner)
        .map((a) => [a.id, a]),
    );
    const titles = new Map(
      (await this.runtime.list(owner)).map((s) => [s.id, s.title]),
    );
    const open = (doc?.items ?? []).filter(
      (s) => s.status === "pending" || s.status === "conflict",
    );
    return {
      items: (copy(open) as Suggestion[])
        .filter((s) => s.snoozedUntil <= now)
        .sort(
          (a, b) =>
            Math.max(b.created, b.snoozedUntil) -
            Math.max(a.created, a.snoozedUntil),
        )
        .map((s) => ({
          ...s,
          fingerprint: undefined,
          conversationTitle: titles.get(s.conversationId) ?? "Deleted chat",
          ...(s.app
            ? { currentVersion: apps.get(s.app.appId)?.version ?? null }
            : {}),
        })),
      snoozed: open.filter((s) => s.snoozedUntil > now).length,
      now,
    };
  }
  private target(body: unknown, keys: string[]) {
    const v = object(body, ["id", ...keys]);
    const id = text(v.id, 20);
    insist(/^s_[1-9][0-9]{0,8}$/.test(id), "suggestion_not_found", 404);
    return { id, v };
  }
  private async change<T>(
    owner: string,
    id: string,
    run: (doc: OwnerSuggestions, s: Suggestion, tx: Tx) => Promise<T> | T,
  ) {
    return this.harness.commit(async (tx) => {
      const doc = await tx.doc(SuggestionInbox, ownerKey(owner), null);
      const s = doc.items.find((x) => x.id === id);
      insist(s, "suggestion_not_found", 404);
      const result = await run(doc, s, tx);
      prune(doc);
      return result;
    }, ctx);
  }
  private decide(s: Suggestion, owner: string, hash: unknown) {
    insist(s.status === "pending", "suggestion_already_decided", 409);
    const expected = text(hash, 64);
    insist(equal(expected, s.hash), "suggestion_changed", 409);
    s.decidedAt = this.now();
    s.decidedBy = owner;
  }
  // Memory: saves the (optionally edited) text. App change: applies the
  // patch through the same validation as app_update, only when the app is
  // still at baseVersion; otherwise the suggestion is kept as a conflict.
  async accept(owner: string, body: unknown) {
    const { id, v } = this.target(body, ["hash", "text"]);
    const edited =
      v.text === undefined
        ? undefined
        : normalizeMemoryText(v.text, this.runtime.redact);
    const now = this.now();
    const result = await this.change(owner, id, async (_doc, s, tx) => {
      this.decide(s, owner, v.hash);
      if (s.kind === "memory") {
        const value = edited ?? s.memory!.text;
        const saved = await rememberInTx(
          tx,
          owner,
          value,
          {
            kind: "suggestion",
            suggestionId: s.id,
            conversationId: s.conversationId,
          },
          now,
        );
        s.status = "accepted";
        s.outcome = saved.added
          ? `Saved to memory as ${saved.item.id}${edited !== undefined && edited !== s.memory!.text ? " (edited)" : ""}`
          : "Already in memory";
        return { ok: true as const, kind: s.kind, memoryId: saved.item.id };
      }
      insist(edited === undefined, "edit_not_supported");
      const app = s.app!;
      const index = await tx.doc(AppIndex);
      const meta = index.items.find(
        (a) => a.id === app.appId && a.owner === owner,
      );
      const plan = planAppPatch(
        this.ha,
        meta,
        app.appId,
        app.baseVersion,
        meta && meta.version === app.baseVersion
          ? await readSpec(tx, meta.id, meta.version)
          : null,
        app.patch,
      );
      if (!plan.ok || !meta) {
        const first = plan.ok ? undefined : plan.errors[0];
        s.status = "conflict";
        s.conflict = {
          code: first?.code ?? "app_not_found",
          message: first?.message ?? "The app no longer exists.",
          currentVersion: meta?.version ?? null,
        };
        s.outcome = "Not applied";
        return { ok: false as const, kind: s.kind, conflict: copy(s.conflict) };
      }
      await appendVersion(
        tx,
        meta,
        plan.spec,
        "owner",
        `Accepted suggestion: ${app.summary}`.slice(0, 200),
      );
      s.status = "accepted";
      s.outcome = `Applied as v${meta.version}`;
      return {
        ok: true as const,
        kind: s.kind,
        appId: meta.id,
        version: meta.version,
      };
    });
    return result;
  }
  // Remembered for 60 days so the same idea is not proposed again.
  async reject(owner: string, body: unknown) {
    const { id, v } = this.target(body, ["hash"]);
    const now = this.now();
    await this.change(owner, id, (doc, s) => {
      this.decide(s, owner, v.hash);
      s.status = "rejected";
      s.outcome = "Rejected";
      doc.rejections.push({ fingerprint: s.fingerprint, at: now });
    });
    return { ok: true as const, rejected: id };
  }
  async snooze(owner: string, body: unknown) {
    const { id, v } = this.target(body, ["until"]);
    const until = snoozeUntil(v.until, this.now());
    await this.change(owner, id, (_doc, s) => {
      insist(s.status === "pending", "suggestion_already_decided", 409);
      s.snoozedUntil = until;
    });
    return { ok: true as const, snoozedUntil: until };
  }
  // A conflicted app change is closed without counting as a rejection.
  async dismiss(owner: string, body: unknown) {
    const { id } = this.target(body, []);
    await this.change(owner, id, (doc, s) => {
      insist(s.status === "conflict", "suggestion_not_conflicted", 409);
      doc.items.splice(doc.items.indexOf(s), 1);
    });
    return { ok: true as const, dismissed: id };
  }
}
