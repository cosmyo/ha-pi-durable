// Durable documents for household apps, kept apart from the app tools and the
// HTTP store so read-only consumers (watchers, briefings) can read specs
// without importing any code that reaches the Home permissions broker.
import {
  defineDoc,
  defineDocFamily,
  type CheckpointInfo,
} from "@earendil-works/pi-durable";
import type { AppSpec } from "./app-spec.js";

const checkpointWhen = (_value: unknown, _ops: unknown, info: CheckpointInfo) =>
  info.deltasSinceBase >= 31;

export type AppVersionInfo = {
  version: number;
  created: number;
  // "conversation:<id>" for model tools, "owner" for human reverts.
  by: string;
  summary: string;
  parent: number;
  elements: number;
};
export type AppMeta = {
  id: string;
  owner: string;
  title: string;
  summary: string;
  created: number;
  createdBy: number;
  updated: number;
  version: number;
  pinned: boolean;
  versions: AppVersionInfo[];
};
// Index of household apps. Each owner sees only their own entries.
export const AppIndex = defineDoc<{ next: number; items: AppMeta[] }>({
  kind: "hearth.apps",
  version: 1,
  scope: "session",
  initial: () => ({ next: 1, items: [] }),
  checkpointWhen,
});
// One immutable document per version, keyed "<appId>.v<n>"; never rewritten.
export const AppVersion = defineDocFamily<
  { spec: AppSpec | null },
  AppSpec | null
>({
  kind: "hearth.app-version",
  version: 1,
  scope: "session",
  family: true,
  initial: (spec) => ({ spec }),
});
export const versionKey = (appId: string, version: number) =>
  `${appId}.v${version}`;
