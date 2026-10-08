import { defineDoc } from "@earendil-works/pi-durable";
import type { CheckpointInfo } from "@earendil-works/pi-durable";

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
  submissionId: number;
  admitted: number;
  homePermission?: PermissionBinding;
};
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
export type Action = ToggleAction | AdminAction;
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
    source: "human" | "automatic";
    owner: string;
    inputIds: number[];
  };
  attemptedAt?: number;
  // Set when a person pressed an app ToggleAction or a Home World device
  // instead of a model tool call.
  origin?:
    | { kind: "app"; appId: string; version: number; elementId: string }
    | { kind: "world"; entityId: string };
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
