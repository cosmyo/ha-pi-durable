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
export type Action = {
  service: string;
  entityId: string;
  data: { brightness?: number };
};
export type Proposal = {
  id: string;
  action: Action;
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
