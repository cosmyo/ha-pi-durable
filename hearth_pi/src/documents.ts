import { defineDoc } from "@earendil-works/pi-durable";
import type { CheckpointInfo } from "@earendil-works/pi-durable";
import type { EntitySnapshot, UndoRecord } from "./undo.js";

const checkpointWhen = (_value: unknown, _ops: unknown, info: CheckpointInfo) =>
  info.deltasSinceBase >= 31;
export type SessionItem = {
  id: number;
  owner: string;
  title: string;
  created: number;
  creationId: string;
  kind?: "home" | "workspace";
};
export const Catalog = defineDoc<{ items: SessionItem[] }>({
  kind: "hearth.catalog",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen,
});
// Revision lives with the conversation so a model choice and its compare-and-swap
// advance in the same durable commit as pi.agent.
export const ModelSelection = defineDoc<{ revision: number }>({
  kind: "hearth.model-selection",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ revision: 0 }),
  checkpointWhen,
});
export type Input = {
  hash: string;
  content: string;
  // Attached images, kept only until the input is placed in the transcript
  // (the durable user message then carries them).
  images?: {
    mimeType: "image/jpeg" | "image/png" | "image/webp";
    data: string;
  }[];
  submissionId: number;
  admitted: number;
  homePermission?: PermissionBinding;
  // Hearth Assist: where the words came from. A voice reply is short and
  // spoken; a satellite input also carries an Ask ceiling, so a run that
  // includes it never auto-runs a Home change (home-actions.ts).
  channel?: InputChannel;
  ceiling?: "ask";
  // A person's own turn: typed in Hearth, or spoken through the Assist
  // button under their own Home Assistant user. Absent for anything else
  // (satellites, work Hearth or another system started). Trusted owners'
  // proposals auto-run only when every input of the run has it.
  direct?: true;
  // Set on every input of a run whose tool output the injection guard
  // flagged (src/injection-guard.ts): that run's Home proposals never
  // auto-run. Never content: the tool name and the score only.
  guard?: GuardMarker;
};
export type GuardMarker = {
  result: "flagged";
  score: number;
  tool: string;
  at: number;
};
export type InputChannel = "assist" | "satellite";
export const Inputs = defineDoc<{ requests: Record<string, Input> }>({
  kind: "hearth.inputs",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ requests: {} }),
  checkpointWhen,
});
// The original scoped light/switch action (no `kind`, so receipts and hashes
// of earlier proposals stay valid).
export type ToggleAction = {
  service: string;
  entityId: string;
  data: { brightness?: number };
};
export type ServiceTarget = {
  entity_id?: string[];
  device_id?: string[];
  area_id?: string[];
};
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
// Admin mode only: each kind is strictly validated and size-capped in admin.ts.
export type AdminAction =
  | {
      kind: "service";
      domain: string;
      service: string;
      target: ServiceTarget;
      data: JsonObject;
    }
  | {
      kind: "config";
      resource: "automation" | "script" | "scene";
      op: "upsert" | "delete";
      id: string;
      body?: JsonObject;
    }
  | { kind: "ws"; type: string; payload: JsonObject }
  | {
      kind: "supervisor";
      method: "DELETE" | "POST";
      path: string;
      body?: JsonObject;
    };
// One change to a Home Assistant to-do list (shared with every household
// member and the HA app). Validated in lists.ts. `label` is the item's current
// text as read by the controller (never supplied by a model or a person): it
// is part of the hash and re-checked right before the attempt.
export type TodoOp = "add" | "complete" | "reopen" | "rename" | "remove";
export type TodoAction = {
  kind: "todo";
  entityId: string;
  op: TodoOp;
  uid?: string;
  summary?: string;
  label?: string;
};
export type Action = ToggleAction | AdminAction | TodoAction;
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type RiskAssessment = {
  level: RiskLevel;
  rule: string;
  reasons: string[];
};
// What the optional cheap judge said. It can only escalate or flag a mismatch.
export type JudgeRecord = {
  model: string;
  verdict:
    | "agreed"
    | "escalated"
    | "misaligned"
    | "unavailable"
    | "off"
    | "not_applicable";
  reason: string;
  escalateTo?: RiskLevel;
  latencyMs: number;
};
export type Proposal = {
  id: string;
  action: Action;
  // Deterministic classification, possibly escalated by the judge.
  risk?: RiskAssessment;
  judge?: JudgeRecord;
  // Critical actions: the approval must repeat this exact word.
  confirmation?: string;
  hash: string;
  policy: string;
  created: number;
  expires: number;
  status:
    | "pending"
    | "rejected"
    | "dispatching"
    | "accepted"
    | "failed"
    | "unknown"
    | "resolved";
  decidedBy: string;
  decidedAt: number;
  resolution: string;
  authorization?: PermissionBinding & {
    // "trusted": a trusted owner's own direct turn on Full access ran it
    // at its risk level without a judge or a typed confirmation.
    source: "human" | "automatic" | "trusted";
    owner: string;
    inputIds: number[];
    // Set when the request came through Hearth Assist; "satellite" means
    // the run's Ask ceiling lowered the owner's mode.
    channel?: InputChannel;
    // The run read tool output the injection guard flagged: this proposal
    // asks ("Ask: outside content looked like instructions").
    guard?: "flagged";
  };
  attemptedAt?: number;
  // Phone approvals: committed before the one send to the owner's phones
  // (never resent, even when the send failed).
  notified?: { at: number; tag: string; count: number };
  // Set when the decision was a tap on a phone notification.
  decidedVia?: "push";
  // Undo: the state read right before the change (committed with the
  // dispatch intent) and, once accepted, until when Undo is offered.
  undo?: UndoRecord;
  // The entities this action can change (targets and group members), for
  // the unknown-outcome pause. Absent: anything (config, Supervisor, device
  // or area targets, older receipts); such an unknown pauses every write.
  scope?: string[];
  // Unknown outcomes: read-only checks of Home Assistant state after the
  // attempt (src/reconcile.ts). Never a service call.
  reconcile?: ReconcileRecord;
  // Set when a person pressed an app ToggleAction or a Home World device
  // instead of a model tool call.
  origin?:
    | { kind: "app"; appId: string; version: number; elementId: string }
    | { kind: "world"; entityId: string }
    | { kind: "list"; entityId: string }
    | { kind: "undo"; proposalId: string; hash: string };
};
export type ReconcileResult = "intended" | "unchanged" | "mixed" | "unreadable";
export type ReconcileRecord = {
  // Target readings right before the attempt (committed with the intent).
  before?: EntitySnapshot[];
  checks: { at: number; result: ReconcileResult; note: string }[];
  outcome?: "succeeded" | "did_not_happen";
};
export const Proposals = defineDoc<{ items: Record<string, Proposal> }>({
  kind: "hearth.proposals",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: {} }),
  checkpointWhen,
});

// Hearth Assist (src/assist.ts): each person's rolling Voice chat, which Home
// Assistant conversation (for about 5 minutes) and which recent request id
// went to which chat, so a repeated request never runs in a second chat.
// Keys are prefixed ("o_…", "c_…", "r_…") and bounded in assist.ts.
export type VoiceOwner = { chat: number; generation: number };
export const VoiceSessions = defineDoc<{
  owners: Record<string, VoiceOwner>;
  conversations: Record<
    string,
    { owner: string; chat: number; expires: number }
  >;
  requests: Record<string, { owner: string; chat: number; at: number }>;
}>({
  kind: "hearth.voice-sessions",
  version: 1,
  scope: "session",
  initial: () => ({ owners: {}, conversations: {}, requests: {} }),
  checkpointWhen,
});

export type HomeMode = "read-only" | "ask" | "full";
export type PermissionBinding = {
  mode: HomeMode;
  revision: number;
  policy: string;
  grant: string;
};
export type HomePermission = {
  explicit: boolean;
  mode: HomeMode;
  revision: number;
  policy: string;
  schema: number;
  grant: null | {
    owner: string;
    policy: string;
    schema: number;
    acknowledgement: string;
    at: number;
  };
  invalidation: string;
  // Household role the permission was last evaluated for; absent = owner.
  role?: "member" | "guest";
};
// Owner settings live in the same single-writer durable store as the action ledger.
export const HomePermissions = defineDoc<{
  actionRevision: number;
  owners: Record<string, HomePermission>;
}>({
  kind: "hearth.home-permissions",
  version: 1,
  scope: "session",
  initial: () => ({ actionRevision: 0, owners: {} }),
  checkpointWhen,
});
