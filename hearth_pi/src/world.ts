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
  type Anomaly,
  type DeviceKind,
  type RegistryProjection,
  type WorldCustom,
} from "./world-layout.js";

export const WORLD_RATES = Object.freeze({
  valuesPerMinute: 12,
  registryTtlMs: 300000,
  registryFailureTtlMs: 60000,
});
const checkpointWhen = (_value: unknown, _ops: unknown, info: CheckpointInfo) =>
  info.deltasSinceBase >= 31;
export type WorldOwnerLayout = {
  revision: number;
  custom: WorldCustom | null;
  migrated: boolean;
  updated: number;
};
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
  private registryCache: {
    at: number;
    projection: RegistryProjection | null;
  } | null = null;
  private registryLoad: Promise<RegistryProjection | null> | null = null;
  private reads = new Map<string, { count: number; until: number }>();
  constructor(
    private runtime: Runtime,
    private ha: HAClient,
    private now: () => number = Date.now,
  ) {}
  private get scope() {
    return this.ha.policy.entities;
  }
  // Registries change rarely: one bounded WebSocket read per 5 minutes, and
  // a failure (no admin token, HA down) is remembered for a minute.
  private async projection(): Promise<RegistryProjection | null> {
    const now = this.now();
    const cached = this.registryCache;
    if (
      cached &&
      now - cached.at <
        (cached.projection
          ? WORLD_RATES.registryTtlMs
          : WORLD_RATES.registryFailureTtlMs)
    )
      return cached.projection;
    this.registryLoad ??= this.ha
      .registry()
      .catch(() => null)
      .then((projection) => {
        this.registryCache = { at: this.now(), projection };
        this.registryLoad = null;
        return projection;
      });
    return this.registryLoad;
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
    const projection = await this.projection();
    const entities = worldEntities(this.scope, projection);
    return {
      registry: !entities.length
        ? ("empty" as const)
        : projection
          ? ("ok" as const)
          : ("unavailable" as const),
      layout: autoLayout(projection, entities),
    };
  }
  private present(
    stored: WorldOwnerLayout,
    auto: Awaited<ReturnType<WorldStore["auto"]>>,
  ) {
    return {
      revision: stored.revision,
      customized: !!stored.custom,
      migrated: stored.migrated,
      registry: auto.registry,
      ...mergeLayout(auto.layout, stored.custom, this.scope),
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
      if (domain === "light" || domain === "switch")
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
      (domain === "light" || domain === "switch") &&
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
