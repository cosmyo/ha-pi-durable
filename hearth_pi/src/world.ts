// Home World v1, HTTP-facing part: the owner's customization document (Pi
// Durable, optimistic concurrency), the cached read-only registry projection,
// live controller reads for the drawn devices and on/off presses through the
// shared Home permissions broker (the same path as app ToggleActions).
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineDoc, type CheckpointInfo } from "@earendil-works/pi-durable";
import type { HAClient } from "./ha.js";
import type { Runtime } from "./runtime.js";
import {
  pool,
  pressHomeToggle,
  toggleControl,
  ADMIN_CONTROL_DOMAINS,
  type ToggleControl,
} from "./apps.js";
import { entityPattern, insist, object, text } from "./safety.js";
import {
  anomalyOf,
  autoLayout,
  deviceKind,
  mergeLayout,
  migratePrototype,
  validateCustom,
  validatePrototypeLayout,
  worldEntities,
  WORLD_REGISTRY_TTL,
  UNASSIGNED_ROOM,
  type Anomaly,
  type AutoLayout,
  type DeviceKind,
  type RegistryProjection,
  type WorldCustom,
} from "./world-layout.js";

export const WORLD_RATES = Object.freeze({
  valuesPerMinute: 12,
  registryTtlMs: WORLD_REGISTRY_TTL.okMs,
  registryFailureTtlMs: WORLD_REGISTRY_TTL.failureMs,
});
const checkpointWhen = (_value: unknown, _ops: unknown, info: CheckpointInfo) =>
  info.deltasSinceBase >= 31;
// A layout Hearth proposed in a Home chat (world_layout_propose): shown as
// a preview until the owner keeps or discards it; never the saved layout.
// One per owner; a new proposal replaces it.
export const WORLD_DRAFT_TTL_MS = 7 * 86400000;
export type WorldDraft = {
  id: string;
  conversationId: number;
  created: number;
  expires: number;
  note: string;
  custom: WorldCustom;
};
export type WorldOwnerLayout = {
  revision: number;
  custom: WorldCustom | null;
  migrated: boolean;
  updated: number;
  // Absent in documents written before drafts existed.
  draft?: WorldDraft | null;
};
export const liveDraft = (stored: WorldOwnerLayout | undefined, now: number) =>
  stored?.draft && stored.draft.expires > now ? stored.draft : null;
// The auto house for the current scope and (cached) registry projection.
export function buildWorld(
  projection: RegistryProjection | null,
  scope: readonly string[],
) {
  const entities = worldEntities(scope, projection);
  return {
    registry: !entities.length
      ? ("empty" as const)
      : projection
        ? ("ok" as const)
        : ("unavailable" as const),
    layout: autoLayout(projection, entities),
  };
}
export function draftSummary(
  draft: WorldDraft,
  auto: AutoLayout,
  scope: readonly string[],
) {
  const merged = mergeLayout(auto, draft.custom, scope);
  return {
    id: draft.id,
    conversationId: draft.conversationId,
    created: draft.created,
    expires: draft.expires,
    note: draft.note,
    // Rooms of areas; the Unassigned shed and outdoor spaces are separate.
    rooms: merged.rooms.filter((r) => !r.decor && r.id !== UNASSIGNED_ROOM)
      .length,
    decor: merged.rooms.filter((r) => r.decor).length,
    cols: merged.grid.cols,
    rows: merged.grid.rows,
  };
}
// One writer (the controller); owners are bounded by the authorized users.
export const WorldLayouts = defineDoc<{
  owners: Record<string, WorldOwnerLayout>;
}>({
  kind: "hearth.world-layouts",
  version: 1,
  scope: "session",
  initial: () => ({ owners: {} }),
  checkpointWhen,
});
export type WorldValue = {
  name: string;
  state: string;
  unit: string;
  kind: DeviceKind;
  available: boolean;
  anomaly: Anomaly;
  observedAt: number;
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class WorldStore {
  private reads = new Map<string, { count: number; until: number }>();
  constructor(
    private runtime: Runtime,
    private ha: HAClient,
    private now: () => number = Date.now,
  ) {}
  private get scope() {
    return this.ha.policy.entities;
  }
  private projection(): Promise<RegistryProjection | null> {
    return this.ha.cachedRegistry(this.now);
  }
  private async ownerLayout(owner: string): Promise<WorldOwnerLayout> {
    const doc = await this.runtime.harness.snapshot(WorldLayouts, ctx);
    return copy(
      doc?.owners[owner] ?? {
        revision: 0,
        custom: null,
        migrated: false,
        updated: 0,
      },
    );
  }
  // The drawn entities depend on the (cached) registry projection.
  private async drawn() {
    return worldEntities(this.scope, await this.projection());
  }
  private async auto() {
    return buildWorld(await this.projection(), this.scope);
  }
  private present(
    stored: WorldOwnerLayout,
    auto: Awaited<ReturnType<WorldStore["auto"]>>,
  ) {
    const draft = liveDraft(stored, this.now());
    return {
      revision: stored.revision,
      customized: !!stored.custom,
      migrated: stored.migrated,
      registry: auto.registry,
      ...mergeLayout(auto.layout, stored.custom, this.scope),
      draft: draft ? draftSummary(draft, auto.layout, this.scope) : null,
    };
  }
  // Structure only (no state reads): rooms, devices, customization.
  async get(owner: string) {
    const [stored, auto] = await Promise.all([
      this.ownerLayout(owner),
      this.auto(),
    ]);
    return this.present(stored, auto);
  }
  // Fresh controller reads of the drawn devices, with anomalies, night and
  // on/off control eligibility. Rate-limited per owner.
  async values(owner: string) {
    const now = this.now();
    for (const [key, rate] of this.reads)
      if (rate.until < now) this.reads.delete(key);
    const rate = this.reads.get(owner) ?? { count: 0, until: now + 60000 };
    rate.count++;
    this.reads.set(owner, rate);
    insist(
      rate.count <= WORLD_RATES.valuesPerMinute && this.reads.size <= 100,
      "rate_limit",
      429,
    );
    const entities = await this.drawn();
    let night = false;
    let nightSource: "sun" | "clock" = "clock";
    if (this.scope.includes("sun.sun"))
      try {
        const sun = await this.ha.state("sun.sun");
        if (sun.state === "below_horizon" || sun.state === "above_horizon") {
          night = sun.state === "below_horizon";
          nightSource = "sun";
        }
      } catch {
        // fall back to the clock
      }
    if (nightSource === "clock") {
      const hour = new Date(now).getHours();
      night = hour >= 21 || hour < 6;
    }
    const clean = (v: string, max: number) => this.ha.sanitize(v).slice(0, max);
    const values: Record<string, WorldValue> = {};
    await pool(entities, 6, async (id) => {
      try {
        const reading = await this.ha.state(id);
        const a = reading.attributes;
        const name = clean(
          typeof a.friendly_name === "string" ? a.friendly_name : id,
          60,
        );
        const deviceClass =
          typeof a.device_class === "string" ? a.device_class : "";
        const state = clean(reading.state, 40);
        const kind = deviceKind(id, deviceClass, name);
        values[id] = {
          name,
          state,
          unit: clean(
            typeof a.unit_of_measurement === "string"
              ? a.unit_of_measurement
              : "",
            12,
          ),
          kind,
          available: state !== "unavailable",
          anomaly: anomalyOf(kind, deviceClass, state, night),
          observedAt: this.now(),
        };
      } catch {
        values[id] = {
          name: id,
          state: "",
          unit: "",
          kind: deviceKind(id, "", id),
          available: false,
          anomaly: "",
          observedAt: this.now(),
        };
      }
    });
    const permissions = await this.ha.actions.settings(owner);
    const controls: Record<string, ToggleControl> = {};
    for (const id of entities) {
      const domain = id.split(".")[0];
      if (
        domain === "light" ||
        domain === "switch" ||
        (this.ha.admin && ADMIN_CONTROL_DOMAINS.includes(domain!))
      )
        controls[id] = toggleControl(
          this.ha,
          permissions,
          id,
          values[id]?.state,
        );
    }
    return {
      observedAt: this.now(),
      night,
      nightSource,
      mode: permissions.effectiveMode,
      blocked: permissions.blocked,
      values,
      controls,
    };
  }
  async save(owner: string, body: unknown) {
    const v = object(body, ["baseRevision", "layout"]);
    insist(Number.isSafeInteger(v.baseRevision) && Number(v.baseRevision) >= 0);
    const custom = validateCustom(v.layout, this.scope, (s) =>
      this.runtime.redact(this.ha.sanitize(s)),
    );
    const stored = await this.commit(owner, (layout) => {
      insist(layout.revision === v.baseRevision, "world_layout_conflict", 409);
      layout.custom = custom;
    });
    return this.present(stored, await this.auto());
  }
  async reset(owner: string, body: unknown) {
    const v = object(body, ["baseRevision"]);
    insist(Number.isSafeInteger(v.baseRevision) && Number(v.baseRevision) >= 0);
    const stored = await this.commit(owner, (layout) => {
      insist(layout.revision === v.baseRevision, "world_layout_conflict", 409);
      layout.custom = null;
    });
    return this.present(stored, await this.auto());
  }
  // One-time import of the prototype's localStorage layout. Refused when the
  // owner already customized or migrated; never repairs an invalid layout.
  async migrate(owner: string, body: unknown) {
    const v = object(body, ["layout"]);
    const prototype = validatePrototypeLayout(v.layout);
    const auto = await this.auto();
    const custom = migratePrototype(prototype, auto.layout, this.scope);
    const stored = await this.commit(owner, (layout) => {
      insist(
        !layout.migrated && !layout.custom,
        "world_already_customized",
        409,
      );
      layout.custom = custom;
      layout.migrated = true;
    });
    return this.present(stored, auto);
  }
  // The pending proposal merged like a saved layout, for the preview.
  // `revision` stays the saved layout's, the base for Keep.
  async draft(owner: string) {
    const [stored, auto] = await Promise.all([
      this.ownerLayout(owner),
      this.auto(),
    ]);
    const draft = liveDraft(stored, this.now());
    insist(draft, "world_draft_not_found", 404);
    return {
      ...this.present({ ...stored, custom: draft.custom }, auto),
      preview: true,
    };
  }
  // Keep = the same validation and revision check as saving from the
  // editor; the draft becomes the owner's layout and is removed.
  async keepDraft(owner: string, body: unknown) {
    const v = object(body, ["baseRevision", "draftId"]);
    insist(Number.isSafeInteger(v.baseRevision) && Number(v.baseRevision) >= 0);
    const draftId = text(v.draftId, 40);
    const draft = liveDraft(await this.ownerLayout(owner), this.now());
    insist(draft && draft.id === draftId, "world_draft_not_found", 404);
    const custom = validateCustom(draft.custom, this.scope, (s) =>
      this.runtime.redact(this.ha.sanitize(s)),
    );
    const stored = await this.commit(owner, (layout) => {
      const current = liveDraft(layout, this.now());
      insist(current && current.id === draftId, "world_draft_not_found", 404);
      insist(layout.revision === v.baseRevision, "world_layout_conflict", 409);
      layout.custom = custom;
      layout.draft = null;
    });
    return this.present(stored, await this.auto());
  }
  // Discarding never touches the saved layout or its revision.
  async discardDraft(owner: string, body: unknown) {
    const v = object(body, ["draftId"]);
    const draftId = text(v.draftId, 40);
    const stored = await this.runtime.harness.commit(async (tx) => {
      const doc = await tx.doc(WorldLayouts);
      const current = doc.owners[owner];
      const draft = liveDraft(current, this.now());
      insist(
        current && draft && draft.id === draftId,
        "world_draft_not_found",
        404,
      );
      current.draft = null;
      return copy(current);
    }, ctx);
    return this.present(stored, await this.auto());
  }
  private async commit(
    owner: string,
    mutate: (layout: WorldOwnerLayout) => void,
  ): Promise<WorldOwnerLayout> {
    return this.runtime.harness.commit(async (tx) => {
      const doc = await tx.doc(WorldLayouts);
      const current = doc.owners[owner] ?? {
        revision: 0,
        custom: null,
        migrated: false,
        updated: 0,
      };
      const next = copy(current) as WorldOwnerLayout;
      mutate(next);
      next.revision = current.revision + 1;
      next.updated = this.now();
      doc.owners[owner] = next;
      return copy(next);
    }, ctx);
  }
  // A person tapped a world light/switch: same broker path as app toggles.
  async press(owner: string, body: unknown) {
    const v = object(body, ["entityId", "sessionId"]);
    const entityId = text(v.entityId, 100);
    insist(entityPattern.test(entityId));
    insist(Number.isSafeInteger(v.sessionId) && Number(v.sessionId) > 0);
    insist((await this.drawn()).includes(entityId), "device_not_found", 404);
    const domain = entityId.split(".")[0];
    insist(
      this.ha.admin
        ? ADMIN_CONTROL_DOMAINS.includes(domain!)
        : (domain === "light" || domain === "switch") &&
            this.ha.policy.enabled &&
            this.ha.policy.services.includes(`${domain}.turn_on`) &&
            this.ha.policy.services.includes(`${domain}.turn_off`),
      "control_not_in_scope",
      403,
    );
    return pressHomeToggle(
      this.runtime,
      this.ha,
      owner,
      v.sessionId as number,
      entityId,
      { kind: "world", entityId },
    );
  }
}
