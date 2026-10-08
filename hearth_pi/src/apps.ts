// Household mini-apps: durable HAS/1 specs (append-only versions), owner-scoped
// metadata and app-local state, the Home-only model tools, and the
// controller-side value resolver used by the HTTP API. The model writes
// structure; the controller reads every value; people press every control.
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineDocFamily,
  defineTool,
  type CheckpointInfo,
  type ConversationId,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { Catalog, type Proposal } from "./documents.js";
import {
  AppIndex,
  AppVersion,
  versionKey,
  type AppMeta,
  type AppVersionInfo,
} from "./app-docs.js";
import type { HAClient } from "./ha.js";
import type { Runtime } from "./runtime.js";
import {
  COMPONENTS,
  applyPatch,
  boundEntities,
  catalogSummary,
  describeCatalog,
  diffSpecs,
  idPattern,
  validateSpec,
  type AppSpec,
  type SpecDiff,
  type SpecError,
  type ValidationContext,
} from "./app-spec.js";
import { digest, insist, object, text } from "./safety.js";

export const APP_LIMITS = {
  perOwner: 30,
  total: 200,
  versions: 50,
  stateKeys: 40,
  resolvesPerMinute: 30,
} as const;
const appIdPattern = /^app_[1-9][0-9]{0,8}$/;
const checkpointWhen = (_value: unknown, _ops: unknown, info: CheckpointInfo) =>
  info.deltasSinceBase >= 31;

export { AppIndex, AppVersion, type AppMeta, type AppVersionInfo };
export type LocalValue =
  | { kind: "checklist"; checked: string[]; updated: number }
  | { kind: "counter"; value: number; updated: number }
  | { kind: "note"; text: string; updated: number };
// App-local household data, separate from specs so updates never wipe it.
export const AppState = defineDocFamily<
  { revision: number; values: Record<string, LocalValue> },
  null
>({
  kind: "hearth.app-state",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ revision: 0, values: {} }),
  checkpointWhen,
});
export type AppToolResult =
  | {
      ok: true;
      appId: string;
      version: number;
      title: string;
      summary: string;
      elements: number;
      entities: string[];
      warnings: string[];
      diff: SpecDiff;
    }
  | {
      ok: false;
      errors: SpecError[];
      warnings: string[];
      currentVersion?: number;
    };
// Task-scoped receipt: a replayed create/update returns its committed result.
const AppReceipt = defineDoc<{ hash: string; result: AppToolResult | null }>({
  kind: "hearth.app-receipt",
  version: 1,
  scope: "task",
  initial: () => ({ hash: "", result: null }),
});
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function validationContext(ha: HAClient): ValidationContext {
  return {
    readable: ha.policy.entities,
    services: ha.policy.services,
    redact: (value) => ha.sanitize(value),
  };
}
function lite(meta: AppMeta) {
  return {
    id: meta.id,
    title: meta.title,
    summary: meta.summary,
    version: meta.version,
    pinned: meta.pinned,
    created: meta.created,
    updated: meta.updated,
    createdBy: meta.createdBy,
  };
}
export type AppPatchOp = {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
};
export type AppPatchPlan =
  | { ok: true; spec: AppSpec; diff: SpecDiff; warnings: string[] }
  | {
      ok: false;
      errors: SpecError[];
      warnings: string[];
      currentVersion?: number;
    };
// The one app-change validation shared by app_update, change suggestions and
// their acceptance: owner's app, exact baseVersion, patch, full revalidation
// against the current read/service scope, and a real change.
export function planAppPatch(
  ha: HAClient,
  meta: AppMeta | undefined,
  appId: string,
  baseVersion: number,
  current: AppSpec | null,
  patch: readonly AppPatchOp[],
): AppPatchPlan {
  if (!meta || (meta.version === baseVersion && !current))
    return {
      ok: false,
      warnings: [],
      errors: [
        {
          path: "/appId",
          code: "app_not_found",
          message: `No app ${appId}.`,
          hint: "Use app_list.",
        },
      ],
    };
  if (meta.version !== baseVersion)
    return {
      ok: false,
      warnings: [],
      currentVersion: meta.version,
      errors: [
        {
          path: "/baseVersion",
          code: "version_conflict",
          message: `baseVersion ${baseVersion} is stale; the current version is ${meta.version}.`,
          hint: "Call app_get, then patch the current spec with that baseVersion.",
        },
      ],
    };
  if (!current) throw new Error("app_version_missing");
  const patched = applyPatch(current, patch as AppPatchOp[]);
  if (!patched.ok) return { ok: false, warnings: [], errors: patched.errors };
  const v = validateSpec(patched.value, validationContext(ha));
  if (!v.ok) return v;
  if (digest(v.spec) === digest(current))
    return {
      ok: false,
      warnings: [],
      errors: [
        {
          path: "/patch",
          code: "no_change",
          message: "The patch does not change the app.",
        },
      ],
    };
  return {
    ok: true,
    spec: v.spec,
    diff: diffSpecs(current, v.spec),
    warnings: v.warnings,
  };
}
export async function readSpec(tx: Tx, appId: string, version: number) {
  const spec = (await tx.doc(AppVersion, versionKey(appId, version), null))
    .spec;
  insist(spec, "app_version_missing", 500);
  return copy(spec) as AppSpec;
}
export async function appendVersion(
  tx: Tx,
  meta: AppMeta,
  spec: AppSpec,
  by: string,
  summary: string,
) {
  insist(meta.versions.length < APP_LIMITS.versions, "app_version_limit", 429);
  const version = meta.version + 1;
  await tx.doc(AppVersion, versionKey(meta.id, version), spec);
  meta.versions.push({
    version,
    created: Date.now(),
    by,
    summary,
    parent: meta.version,
    elements: Object.keys(spec.elements).length,
  });
  meta.version = version;
  meta.title = spec.title;
  meta.summary = spec.summary;
  meta.updated = Date.now();
}
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
  run: (tx: Tx) => Promise<AppToolResult>,
): Promise<AppToolResult> {
  const hash = digest(args);
  const existing = await api.snapshot(AppReceipt, api.taskId, context);
  if (existing?.result) {
    insist(existing.hash === hash, "app_task_conflict", 409);
    return copy(existing.result) as AppToolResult;
  }
  return api.commit(async (tx) => {
    const receipt = await tx.doc(AppReceipt, api.taskId);
    if (receipt.result) {
      insist(receipt.hash === hash, "app_task_conflict", 409);
      return copy(receipt.result) as AppToolResult;
    }
    const result = await run(tx);
    if (result.ok) {
      receipt.hash = hash;
      receipt.result = result;
    }
    return result;
  }, context);
}
const output = (data: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  ...(isError ? { isError: true } : {}),
});
const summaryText = (value: unknown, fallback: string, ha: HAClient) =>
  typeof value === "string" && value.trim()
    ? ha.sanitize(value.trim()).slice(0, 200)
    : fallback;

export function appTools(ha: HAClient) {
  const create = defineTool({
    name: "app_create",
    description: `Save a new household mini-app (HAS/1 JSON spec). Call catalog_describe first if unsure. You choose structure and exact entity bindings; the controller reads every value and people press every control. Components: ${catalogSummary()}. Returns {ok, appId, version, warnings} or {ok:false, errors:[{path, code, message, hint}]} — fix every listed path and call again.`,
    replay: "safe",
    outputLimits: { maxBytes: 24000 },
    parameters: Type.Object(
      {
        spec: Type.Unknown({
          description:
            'HAS/1 spec: {"specVersion":"has/1","title","summary","scope":{"entities":[...]},"root","elements":{id:{type,props,children}}}',
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (args, api, context) => {
      const first = validateSpec(args.spec, validationContext(ha));
      if (!first.ok) return output(first, true);
      const result = await receipted(api, args, context, async (tx) => {
        const owner = await homeOwner(tx, api.conversationId);
        // Recheck current scope in the committing callback.
        const v = validateSpec(args.spec, validationContext(ha));
        if (!v.ok) return v;
        const index = await tx.doc(AppIndex);
        insist(
          index.items.length < APP_LIMITS.total &&
            index.items.filter((a) => a.owner === owner).length <
              APP_LIMITS.perOwner,
          "app_limit",
          429,
        );
        const id = `app_${index.next++}`;
        const now = Date.now();
        await tx.doc(AppVersion, versionKey(id, 1), v.spec);
        index.items.push({
          id,
          owner,
          title: v.spec.title,
          summary: v.spec.summary,
          created: now,
          createdBy: api.conversationId,
          updated: now,
          version: 1,
          pinned: false,
          versions: [
            {
              version: 1,
              created: now,
              by: `conversation:${api.conversationId}`,
              summary: "Created",
              parent: 0,
              elements: Object.keys(v.spec.elements).length,
            },
          ],
        });
        return {
          ok: true,
          appId: id,
          version: 1,
          title: v.spec.title,
          summary: v.spec.summary,
          elements: Object.keys(v.spec.elements).length,
          entities: boundEntities(v.spec),
          warnings: v.warnings,
          diff: diffSpecs(null, v.spec),
        };
      });
      return output(result, !result.ok);
    },
  });
  const update = defineTool({
    name: "app_update",
    description:
      "Change a saved app with JSON Patch (RFC 6902 add/remove/replace) against its current spec, e.g. [{op:'replace',path:'/elements/washer/props/label',value:'Washer'}]. baseVersion must equal the current version (from app_get/app_list); a stale baseVersion returns {ok:false,currentVersion} — re-read and retry. The full patched spec is revalidated; household data (checklist ticks, counters, notes) is kept.",
    replay: "safe",
    outputLimits: { maxBytes: 24000 },
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
        changeSummary: Type.Optional(Type.String({ maxLength: 200 })),
      },
      { additionalProperties: false },
    ),
    execute: async (args, api, context) => {
      const result = await receipted(api, args, context, async (tx) => {
        const owner = await homeOwner(tx, api.conversationId);
        const index = await tx.doc(AppIndex);
        const meta = index.items.find(
          (a) => a.id === args.appId && a.owner === owner,
        );
        const v = planAppPatch(
          ha,
          meta,
          args.appId,
          args.baseVersion,
          meta && meta.version === args.baseVersion
            ? await readSpec(tx, meta.id, meta.version)
            : null,
          args.patch,
        );
        if (!v.ok || !meta) return v as AppToolResult;
        const diff = v.diff;
        await appendVersion(
          tx,
          meta,
          v.spec,
          `conversation:${api.conversationId}`,
          summaryText(args.changeSummary, "Updated", ha),
        );
        return {
          ok: true,
          appId: meta.id,
          version: meta.version,
          title: v.spec.title,
          summary: v.spec.summary,
          elements: Object.keys(v.spec.elements).length,
          entities: boundEntities(v.spec),
          warnings: v.warnings,
          diff,
        };
      });
      return output(result, !result.ok);
    },
  });
  const ownerOf = async (api: ToolExecutionApi, context: Context) => {
    const session = (await api.snapshot(Catalog, context))?.items.find(
      (s) => s.id === api.conversationId,
    );
    insist(
      session && session.kind !== "workspace",
      "home_session_required",
      403,
    );
    return session.owner;
  };
  const get = defineTool({
    name: "app_get",
    description:
      "Read one saved app's spec and version history (optionally an older version). Household data is not included.",
    replay: "safe",
    outputLimits: { maxBytes: 40000 },
    parameters: Type.Object(
      {
        appId: Type.String({ pattern: appIdPattern.source, maxLength: 20 }),
        version: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      },
      { additionalProperties: false },
    ),
    execute: async (args, api, context) => {
      const owner = await ownerOf(api, context);
      const meta = (await api.snapshot(AppIndex, context))?.items.find(
        (a) => a.id === args.appId && a.owner === owner,
      );
      if (!meta) return output({ ok: false, error: "app_not_found" }, true);
      const version = args.version ?? meta.version;
      if (!meta.versions.some((v) => v.version === version))
        return output({ ok: false, error: "version_not_found" }, true);
      const spec = (
        await api.snapshot(AppVersion, versionKey(meta.id, version), context)
      )?.spec;
      return output({
        ok: true,
        app: lite(meta),
        version,
        versions: meta.versions,
        spec,
      });
    },
  });
  const list = defineTool({
    name: "app_list",
    description: "List this household owner's saved apps (id, title, version).",
    replay: "safe",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (_args, api, context) => {
      const owner = await ownerOf(api, context);
      return output({
        items: ((await api.snapshot(AppIndex, context))?.items ?? [])
          .filter((a) => a.owner === owner)
          .map(lite),
      });
    },
  });
  const catalog = defineTool({
    name: "catalog_describe",
    description:
      "Describe the HAS/1 app catalog: components, props, rules, limits and starting templates (Bedtime lock-up, Laundry, 3D print monitor, Maintenance checklist).",
    replay: "safe",
    outputLimits: { maxBytes: 40000 },
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => output(describeCatalog()),
  });
  return [create, update, get, list, catalog];
}

export type EntityValue = {
  available: boolean;
  reason: "" | "not_in_read_scope" | "read_failed" | "unavailable";
  state: string;
  attributes: Record<string, string | number | boolean>;
  observedAt: number;
};
export type HistoryValue =
  | {
      kind: "numeric";
      entityId: string;
      unit: string;
      points: [number, number | null][];
      min: number;
      max: number;
    }
  | { kind: "changes"; entityId: string; changes: [number, string][] }
  | { kind: "unavailable"; entityId: string; reason: string };
const BUCKETS = 48;
// Bucket means; empty buckets carry the previous value (states are steps).
export function downsample(
  points: { at: number; state: string }[],
  start: number,
  end: number,
): Omit<
  Extract<HistoryValue, { kind: "numeric" }>,
  "entityId" | "unit"
> | null {
  const numeric = points
    .map((p) => ({ at: p.at, value: Number(p.state) }))
    .filter((p) => p.value === p.value && Number.isFinite(p.value));
  if (!numeric.length || numeric.length < points.length * 0.8) return null;
  const width = (end - start) / BUCKETS;
  const sums = Array.from({ length: BUCKETS }, () => ({ sum: 0, n: 0 }));
  let carry: number | null = null;
  for (const p of numeric) {
    if (p.at < start) {
      carry = p.value;
      continue;
    }
    const i = Math.min(BUCKETS - 1, Math.floor((p.at - start) / width));
    sums[i]!.sum += p.value;
    sums[i]!.n++;
  }
  const out: [number, number | null][] = [];
  for (let i = 0; i < BUCKETS; i++) {
    const bucket = sums[i]!;
    if (bucket.n) carry = Math.round((bucket.sum / bucket.n) * 100) / 100;
    out.push([Math.round(start + width * (i + 0.5)), carry]);
  }
  const values = out.flatMap(([, v]) => (v === null ? [] : [v]));
  if (!values.length) return null;
  return {
    kind: "numeric",
    points: out,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}
export async function pool<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift())
        await run(item);
    }),
  );
}

export type ToggleControl = { enabled: boolean; mode: string; reason: string };
// Whether a person may press an on/off control for one light/switch entity
// right now (shared by app ToggleActions and Home World devices).
export function toggleControl(
  ha: HAClient,
  permissions: { effectiveMode: string; blocked: boolean },
  entityId: string,
  state: string | undefined,
): ToggleControl {
  const domain = entityId.split(".")[0]!;
  const scoped =
    ha.policy.enabled &&
    (domain === "light" || domain === "switch") &&
    ha.policy.entities.includes(entityId) &&
    ha.policy.services.includes(`${domain}.turn_on`) &&
    ha.policy.services.includes(`${domain}.turn_off`);
  const reason = !scoped
    ? "Outside Hearth's configured service scope; this control stays read-only."
    : permissions.effectiveMode === "read-only"
      ? "Home permissions are Read-only. Choose Ask or Full access in Home permissions to use this control."
      : permissions.blocked
        ? "Home writes are paused: an earlier action has an unknown outcome. Resolve it in its chat first."
        : state !== "on" && state !== "off"
          ? "Hearth only toggles from a known on/off state."
          : permissions.effectiveMode === "ask"
            ? "Ask: you review the exact action before it runs."
            : "Full access: runs once within the configured scope.";
  return {
    enabled:
      scoped &&
      permissions.effectiveMode !== "read-only" &&
      !permissions.blocked &&
      (state === "on" || state === "off"),
    mode: permissions.effectiveMode,
    reason,
  };
}
// A person pressed an on/off control (app ToggleAction or Home World device):
// the controller picks the service from a fresh read and hands one exact
// action to the shared Home permissions broker. Never retried.
export async function pressHomeToggle(
  runtime: Runtime,
  ha: HAClient,
  owner: string,
  sessionId: number,
  entityId: string,
  origin: NonNullable<Proposal["origin"]>,
) {
  const settings = await ha.actions.settings(owner);
  insist(settings.effectiveMode !== "read-only", "home_read_only", 403);
  insist(!settings.blocked, "home_outcome_unresolved", 409);
  await runtime.session(owner, sessionId);
  const current = await ha.state(entityId);
  insist(
    current.state === "on" || current.state === "off",
    "toggle_state_unknown",
    409,
  );
  const service = `${entityId.split(".")[0]}.turn_${current.state === "on" ? "off" : "on"}`;
  const proposal: Proposal = await ha.actions.press(
    owner,
    sessionId,
    { service, entityId, data: {} },
    origin,
  );
  let readBack: { state: string; observedAt: number } | null = null;
  if (proposal.status === "accepted")
    try {
      const after = await ha.state(entityId);
      readBack = {
        state: ha.sanitize(after.state).slice(0, 200),
        observedAt: Date.now(),
      };
    } catch {
      readBack = null;
    }
  return { proposal, readBack, sessionId };
}

// HTTP-facing household operations. Every method is owner-scoped; another
// owner's app answers 404 exactly like an absent one.
export class AppStore {
  private resolves = new Map<string, { count: number; until: number }>();
  constructor(
    private runtime: Runtime,
    private ha: HAClient,
  ) {}
  private get harness() {
    return this.runtime.harness;
  }
  private async meta(owner: string, appId: unknown) {
    const id = text(appId, 20);
    insist(appIdPattern.test(id), "app_not_found", 404);
    const meta = (await this.harness.snapshot(AppIndex, ctx))?.items.find(
      (a) => a.id === id && a.owner === owner,
    );
    insist(meta, "app_not_found", 404);
    return copy(meta) as AppMeta;
  }
  private async spec(meta: AppMeta, version = meta.version) {
    const spec = (
      await this.harness.snapshot(AppVersion, versionKey(meta.id, version), ctx)
    )?.spec;
    insist(spec, "app_version_missing", 500);
    return copy(spec) as AppSpec;
  }
  async list(owner: string) {
    return {
      items: ((await this.harness.snapshot(AppIndex, ctx))?.items ?? [])
        .filter((a) => a.owner === owner)
        .map(lite),
    };
  }
  async get(owner: string, appId: unknown) {
    const meta = await this.meta(owner, appId);
    const now = Date.now();
    for (const [key, rate] of this.resolves)
      if (rate.until < now) this.resolves.delete(key);
    const rate = this.resolves.get(owner) ?? { count: 0, until: now + 60000 };
    rate.count++;
    this.resolves.set(owner, rate);
    insist(
      rate.count <= APP_LIMITS.resolvesPerMinute && this.resolves.size <= 100,
      "rate_limit",
      429,
    );
    const spec = await this.spec(meta);
    const state = await this.harness.snapshot(AppState, meta.id, ctx);
    const validation = validateSpec(spec, validationContext(this.ha));
    const sanitize = (v: string) => this.ha.sanitize(v).slice(0, 200);
    const values: Record<string, EntityValue> = {};
    // Values come only from the controller's scoped reads, never the spec.
    await pool(boundEntities(spec), 6, async (id) => {
      const empty = { state: "", attributes: {}, observedAt: Date.now() };
      if (!this.ha.policy.entities.includes(id)) {
        values[id] = {
          available: false,
          reason: "not_in_read_scope",
          ...empty,
        };
        return;
      }
      try {
        const reading = await this.ha.state(id);
        values[id] = {
          available: reading.state !== "unavailable",
          reason: reading.state === "unavailable" ? "unavailable" : "",
          state: sanitize(reading.state),
          attributes: Object.fromEntries(
            Object.entries(reading.attributes).map(([k, v]) => [
              k,
              typeof v === "string" ? sanitize(v) : v,
            ]),
          ),
          observedAt: Date.now(),
        };
      } catch {
        values[id] = { available: false, reason: "read_failed", ...empty };
      }
    });
    const history: Record<string, HistoryValue[]> = {};
    for (const [id, element] of Object.entries(spec.elements)) {
      if (element.type !== "HistoryChart") continue;
      const entities = element.props.entities as string[];
      const readable = entities.filter((e) =>
        this.ha.policy.entities.includes(e),
      );
      const result: HistoryValue[] = entities
        .filter((e) => !readable.includes(e))
        .map((entityId) => ({
          kind: "unavailable",
          entityId,
          reason: "not_in_read_scope",
        }));
      if (readable.length)
        try {
          const read = await this.ha.history(
            readable,
            element.props.hours as number,
          );
          for (const entityId of readable) {
            const points = read.series[entityId] ?? [];
            const numeric = downsample(points, read.start, read.end);
            const unit = values[entityId]?.attributes.unit_of_measurement;
            result.push(
              numeric
                ? {
                    ...numeric,
                    entityId,
                    unit: typeof unit === "string" ? unit : "",
                  }
                : points.length
                  ? {
                      kind: "changes",
                      entityId,
                      changes: points
                        .slice(-12)
                        .map((p) => [p.at, sanitize(p.state).slice(0, 40)]),
                    }
                  : { kind: "unavailable", entityId, reason: "no_history" },
            );
          }
        } catch {
          for (const entityId of readable)
            result.push({
              kind: "unavailable",
              entityId,
              reason: "read_failed",
            });
        }
      history[id] = result;
    }
    const permissions = await this.ha.actions.settings(owner);
    const controls: Record<string, ToggleControl> = {};
    for (const [id, element] of Object.entries(spec.elements)) {
      if (element.type !== "ToggleAction") continue;
      const entityId = element.props.entity as string;
      controls[id] = toggleControl(
        this.ha,
        permissions,
        entityId,
        values[entityId]?.state,
      );
    }
    return {
      app: lite(meta),
      versions: meta.versions,
      spec,
      state: state?.values ?? {},
      stateRevision: state?.revision ?? 0,
      values,
      history,
      controls,
      observedAt: Date.now(),
      needsRepair: !validation.ok,
      repair: validation.ok ? [] : validation.errors.slice(0, 5),
    };
  }
  async setState(owner: string, appId: unknown, body: unknown) {
    const v = object(body, ["stateKey", "op", "item", "text"]);
    const stateKey = text(v.stateKey, 40);
    insist(idPattern.test(stateKey));
    const meta = await this.meta(owner, appId);
    const spec = await this.spec(meta);
    const element = Object.values(spec.elements).find(
      (e) => e.props.stateKey === stateKey,
    );
    insist(
      element && COMPONENTS[element.type]?.safety === "local",
      "state_key_not_found",
      404,
    );
    const op = v.op;
    const kind =
      element.type === "Checklist"
        ? "checklist"
        : element.type === "Counter"
          ? "counter"
          : "note";
    let next: (current: LocalValue | undefined) => LocalValue;
    const now = Date.now();
    if (element.type === "Checklist") {
      const items = element.props.items as string[];
      if (op === "reset") {
        insist(v.item === undefined && v.text === undefined);
        next = () => ({ kind: "checklist", checked: [], updated: now });
      } else {
        insist((op === "check" || op === "uncheck") && v.text === undefined);
        const item = text(v.item, 80);
        insist(items.includes(item), "item_not_found", 404);
        next = (current) => {
          const checked = new Set(
            current?.kind === "checklist" ? current.checked : [],
          );
          if (op === "check") checked.add(item);
          else checked.delete(item);
          // Keep only ticks for items that still exist (bounded).
          return {
            kind: "checklist",
            checked: items.filter((i) => checked.has(i)),
            updated: now,
          };
        };
      }
    } else if (element.type === "Counter") {
      insist(
        (op === "increment" || op === "decrement" || op === "reset") &&
          v.item === undefined &&
          v.text === undefined,
      );
      const step = (element.props.step as number | undefined) ?? 1;
      const min = (element.props.min as number | undefined) ?? 0;
      const max = (element.props.max as number | undefined) ?? 1000;
      const initial = Math.min(max, Math.max(min, 0));
      next = (current) => {
        const value = current?.kind === "counter" ? current.value : initial;
        const changed =
          op === "reset"
            ? initial
            : value + (op === "increment" ? step : -step);
        return {
          kind: "counter",
          value: Math.min(max, Math.max(min, changed)),
          updated: now,
        };
      };
    } else {
      insist(op === "set" && v.item === undefined);
      const maxLength = (element.props.maxLength as number | undefined) ?? 1000;
      const note = text(v.text, maxLength, 0);
      // eslint-disable-next-line no-control-regex
      insist(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(note));
      const stored = this.runtime.redact(this.ha.sanitize(note));
      next = () => ({ kind: "note", text: stored, updated: now });
    }
    return this.harness.commit(async (tx) => {
      const index = await tx.doc(AppIndex);
      insist(
        index.items.some((a) => a.id === meta.id && a.owner === owner),
        "app_not_found",
        404,
      );
      const doc = await tx.doc(AppState, meta.id, null);
      const keys = Object.keys(doc.values);
      if (!keys.includes(stateKey) && keys.length >= APP_LIMITS.stateKeys) {
        // Keep data of the current spec; drop keys no version uses anymore.
        const live = new Set(
          Object.values(spec.elements).flatMap((e) =>
            typeof e.props.stateKey === "string" ? [e.props.stateKey] : [],
          ),
        );
        for (const key of keys) if (!live.has(key)) delete doc.values[key];
        insist(
          Object.keys(doc.values).length < APP_LIMITS.stateKeys,
          "state_limit",
          429,
        );
      }
      const current = doc.values[stateKey];
      doc.values[stateKey] = next(
        current && current.kind === kind
          ? (copy(current) as LocalValue)
          : undefined,
      );
      doc.revision++;
      return { state: copy(doc.values), stateRevision: doc.revision };
    }, ctx);
  }
  async pin(owner: string, appId: unknown, body: unknown) {
    const v = object(body, ["pinned"]);
    insist(typeof v.pinned === "boolean");
    const meta = await this.meta(owner, appId);
    return this.harness.commit(async (tx) => {
      const item = (await tx.doc(AppIndex)).items.find(
        (a) => a.id === meta.id && a.owner === owner,
      );
      insist(item, "app_not_found", 404);
      item.pinned = v.pinned as boolean;
      return lite(copy(item) as AppMeta);
    }, ctx);
  }
  // Revert never rewrites history: version N+1 is a revalidated copy of K.
  async revert(owner: string, appId: unknown, body: unknown) {
    const v = object(body, ["version", "baseVersion"]);
    insist(
      Number.isSafeInteger(v.version) && Number.isSafeInteger(v.baseVersion),
    );
    const meta = await this.meta(owner, appId);
    insist(
      meta.versions.some((x) => x.version === v.version) &&
        v.version !== meta.version,
      "version_not_found",
      404,
    );
    const old = await this.spec(meta, v.version as number);
    const validation = validateSpec(old, validationContext(this.ha));
    insist(validation.ok, "version_outside_current_scope", 409);
    return this.harness.commit(async (tx) => {
      const item = (await tx.doc(AppIndex)).items.find(
        (a) => a.id === meta.id && a.owner === owner,
      );
      insist(item, "app_not_found", 404);
      insist(item.version === v.baseVersion, "version_conflict", 409);
      await appendVersion(
        tx,
        item,
        validation.spec,
        "owner",
        `Reverted to v${v.version}`,
      );
      return lite(copy(item) as AppMeta);
    }, ctx);
  }
  // Removes the app from the owner's list and retires its documents. Like
  // session delete, Pi Durable keeps committed history in the private store.
  async remove(owner: string, appId: unknown, body: unknown) {
    const v = object(body, ["confirm"]);
    insist(v.confirm === true, "confirmation_required");
    const meta = await this.meta(owner, appId);
    await this.harness.commit(async (tx) => {
      const index = await tx.doc(AppIndex);
      const at = index.items.findIndex(
        (a) => a.id === meta.id && a.owner === owner,
      );
      insist(at >= 0, "app_not_found", 404);
      for (const version of index.items[at]!.versions)
        await tx.retireDoc(AppVersion, versionKey(meta.id, version.version));
      await tx.retireDoc(AppState, meta.id);
      index.items.splice(at, 1);
    }, ctx);
    return { deleted: true };
  }
  // A person pressed a ToggleAction: the controller picks the service from a
  // fresh read and hands one exact action to the shared Home permissions broker.
  async press(owner: string, appId: unknown, body: unknown) {
    const v = object(body, ["elementId", "sessionId", "version"]);
    const elementId = text(v.elementId, 40);
    insist(idPattern.test(elementId));
    insist(Number.isSafeInteger(v.sessionId) && Number(v.sessionId) > 0);
    const meta = await this.meta(owner, appId);
    insist(v.version === meta.version, "version_conflict", 409);
    const spec = await this.spec(meta);
    const element = spec.elements[elementId];
    insist(element?.type === "ToggleAction", "control_not_found", 404);
    insist(
      validateSpec(spec, validationContext(this.ha)).ok,
      "app_needs_repair",
      409,
    );
    return pressHomeToggle(
      this.runtime,
      this.ha,
      owner,
      v.sessionId as number,
      element.props.entity as string,
      { kind: "app", appId: meta.id, version: meta.version, elementId },
    );
  }
}
