// L0 feedback: 👍/👎 on assistant messages with fixed reason chips, kept in
// the private durable store for the owner's Insights screen. Records hold
// identifiers, enums, a model label and a time — never prompt or response
// text. Nothing leaves the device; there is no telemetry endpoint.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  AgentDoc,
  AssistantEntry,
  defineDoc,
  type CheckpointInfo,
} from "@earendil-works/pi-durable";
import type { Runtime } from "./runtime.js";
import { insist, object } from "./safety.js";

export const FEEDBACK_REASONS = [
  "wrong_value",
  "wrong_device",
  "did_not_do_it",
  "too_long",
  "not_useful",
  "privacy",
] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];
export type FeedbackRecord = {
  owner: string;
  sessionId: number;
  entryId: number;
  rating: "up" | "down";
  reasons: FeedbackReason[];
  // provider/model label of the session when rated, e.g. "openai/gpt-4.1-mini".
  model: string;
  at: number;
};
// The complete stored field list (checked by the schema test).
export const FEEDBACK_FIELDS = [
  "owner",
  "sessionId",
  "entryId",
  "rating",
  "reasons",
  "model",
  "at",
] as const;
export const FEEDBACK_LIMITS = {
  records: 2000,
  retentionMs: 90 * 86400000,
} as const;
const checkpointWhen = (_value: unknown, _ops: unknown, info: CheckpointInfo) =>
  info.deltasSinceBase >= 31;
export const FeedbackLog = defineDoc<{ items: FeedbackRecord[] }>({
  kind: "hearth.feedback",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen,
});
const modelLabel = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,160}$/;

export class FeedbackStore {
  constructor(
    private runtime: Runtime,
    private now: () => number = Date.now,
  ) {}
  private async items() {
    return (await this.runtime.harness.snapshot(FeedbackLog, ctx))?.items ?? [];
  }
  async list(owner: string, sessionId: number) {
    await this.runtime.session(owner, sessionId);
    const items: Record<string, { rating: string; reasons: string[] }> = {};
    for (const r of await this.items())
      if (r.owner === owner && r.sessionId === sessionId)
        items[String(r.entryId)] = {
          rating: r.rating,
          reasons: [...r.reasons],
        };
    return { items, reasons: FEEDBACK_REASONS };
  }
  async record(owner: string, sessionId: number, body: unknown) {
    const v = object(body, ["entryId", "rating", "reasons"]);
    insist(Number.isSafeInteger(v.entryId) && Number(v.entryId) > 0);
    const entryId = v.entryId as number;
    insist(v.rating === "up" || v.rating === "down" || v.rating === "clear");
    const reasons = v.reasons ?? [];
    insist(
      Array.isArray(reasons) &&
        reasons.length <= FEEDBACK_REASONS.length &&
        new Set(reasons).size === reasons.length &&
        reasons.every((r) =>
          (FEEDBACK_REASONS as readonly unknown[]).includes(r),
        ) &&
        (v.rating === "down" || reasons.length === 0),
      "invalid_reasons",
    );
    const conversation = await this.runtime.session(owner, sessionId);
    // Only a committed assistant message of this owner's session is ratable.
    const entry = (await conversation.context(ctx)).entries.find(
      (e) => e.id === entryId,
    );
    insist(AssistantEntry.is(entry), "entry_not_found", 404);
    const agent = await this.runtime.harness.snapshot(
      AgentDoc,
      conversation.id,
      ctx,
    );
    const label = agent?.model
      ? `${agent.model.provider}/${agent.model.modelId}`
      : "";
    const model = modelLabel.test(label) ? label : "";
    const now = this.now();
    return this.runtime.harness.commit(async (tx) => {
      const doc = await tx.doc(FeedbackLog);
      doc.items = doc.items.filter(
        (r) =>
          now - r.at < FEEDBACK_LIMITS.retentionMs &&
          !(
            r.owner === owner &&
            r.sessionId === sessionId &&
            r.entryId === entryId
          ),
      );
      if (v.rating !== "clear")
        doc.items.push({
          owner,
          sessionId,
          entryId,
          rating: v.rating as "up" | "down",
          reasons: reasons as FeedbackReason[],
          model,
          at: now,
        });
      doc.items = doc.items.slice(-FEEDBACK_LIMITS.records);
      return {
        entryId,
        rating: v.rating as string,
        reasons: reasons as string[],
      };
    }, ctx);
  }
  async insights(owner: string) {
    const now = this.now();
    const mine = (await this.items()).filter(
      (r) => r.owner === owner && now - r.at < FEEDBACK_LIMITS.retentionMs,
    );
    const reasons = Object.fromEntries(
      FEEDBACK_REASONS.map((reason) => [
        reason,
        mine.filter((r) => r.reasons.includes(reason)).length,
      ]),
    );
    const models: Record<string, { up: number; down: number }> = {};
    for (const r of mine) {
      const m = (models[r.model || "unknown"] ??= { up: 0, down: 0 });
      m[r.rating]++;
    }
    const titles = new Map(
      (await this.runtime.list(owner)).map((s) => [s.id, s.title]),
    );
    return {
      up: mine.filter((r) => r.rating === "up").length,
      down: mine.filter((r) => r.rating === "down").length,
      reasons,
      models,
      recent: mine
        .slice(-20)
        .reverse()
        .map((r) => ({
          sessionId: r.sessionId,
          session: titles.get(r.sessionId) ?? "Deleted session",
          entryId: r.entryId,
          rating: r.rating,
          reasons: r.reasons,
          model: r.model,
          at: r.at,
        })),
      retentionDays: FEEDBACK_LIMITS.retentionMs / 86400000,
    };
  }
  async exportAll(owner: string) {
    const now = this.now();
    return {
      exportedAt: now,
      fields: FEEDBACK_FIELDS,
      reasons: FEEDBACK_REASONS,
      items: (await this.items()).filter(
        (r) => r.owner === owner && now - r.at < FEEDBACK_LIMITS.retentionMs,
      ),
    };
  }
  // Clears this owner's records from the feedback document. Pi Durable keeps
  // committed history in the private store; see DOCS.md.
  async deleteAll(owner: string, body: unknown) {
    const v = object(body, ["confirm"]);
    insist(v.confirm === true, "confirmation_required");
    const removed = await this.runtime.harness.commit(async (tx) => {
      const doc = await tx.doc(FeedbackLog);
      const before = doc.items.length;
      doc.items = doc.items.filter((r) => r.owner !== owner);
      return before - doc.items.length;
    }, ctx);
    return { deleted: removed };
  }
}
