// Unknown outcomes (source slice): after a dispatch ends unknown, the
// controller reads the target entities' state from Home Assistant a few
// times (HomeActions.reconcile). It never sends a service call. This module
// is pure: which actions have a well-defined target state (an allowlist),
// how a reading compares with it, and which entities an action can change
// (the unknown-outcome pause).
import type {
  Action,
  JsonValue,
  ReconcileResult,
  TodoAction,
} from "./documents.js";
import type { EntitySnapshot } from "./undo.js";
import { UNDO_ATTRS, sameAsBefore } from "./undo.js";
import type { TodoRead } from "./lists.js";
import type { RiskContext } from "./risk.js";
import { memoryFingerprint } from "./memory.js";

// Checks after the unknown attempt: 5 s, 30 s and 2 min.
export const RECONCILE_DELAYS_MS = [5000, 30000, 120000] as const;
export const RECONCILE_MAX_TARGETS = 10;
export const RECONCILED_SUCCEEDED =
  "Succeeded (confirmed from Home Assistant state). Nothing was sent again.";
export const RECONCILED_DID_NOT_HAPPEN =
  "Did not happen (confirmed from Home Assistant state). Nothing was sent again.";
export const RECONCILE_NOTES: Record<ReconcileResult, string> = {
  intended: "Home Assistant reports every target in the requested state.",
  unchanged:
    "Home Assistant reports every target exactly as it was right before the attempt.",
  mixed: "Home Assistant state does not settle the outcome yet.",
  unreadable: "Home Assistant state could not be read.",
};
export const RECONCILE_GAVE_UP =
  "Still unknown after the last check. Check the device yourself, then record what you saw.";

// What one entity should look like after the action. `toggle`: the
// opposite of its on/off state right before the attempt.
export type EntityGoal = {
  entityId: string;
  state?: string;
  attrs?: Partial<Record<(typeof UNDO_ATTRS)[number], number>>;
  toggle?: true;
};
export type ReconcilePlan =
  | { kind: "entity"; goals: EntityGoal[] }
  | { kind: "todo"; action: TodoAction };

const ON_OFF_DOMAINS = new Set(["light", "switch", "input_boolean", "fan"]);
const STATE_SERVICES: Record<string, string> = {
  "cover.open_cover": "open",
  "cover.close_cover": "closed",
  "lock.lock": "locked",
  "lock.unlock": "unlocked",
};
const finiteNumber = (v: JsonValue | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

// The target state of an action, or null when it has none Hearth can read
// back exactly (config, registry, Supervisor, device/area targets, scenes,
// scripts, data it cannot verify).
export function reconcilePlan(action: Action): ReconcilePlan | null {
  if (!("kind" in action)) {
    const [domain, service] = action.service.split(".");
    if (domain !== "light" && domain !== "switch") return null;
    if (service === "turn_off")
      return {
        kind: "entity",
        goals: [{ entityId: action.entityId, state: "off" }],
      };
    if (service !== "turn_on") return null;
    const brightness = action.data.brightness;
    if (brightness === 0) return null;
    return {
      kind: "entity",
      goals: [
        {
          entityId: action.entityId,
          state: "on",
          ...(brightness !== undefined ? { attrs: { brightness } } : {}),
        },
      ],
    };
  }
  if (action.kind === "todo") return { kind: "todo", action };
  if (action.kind !== "service") return null;
  const { domain, service, target, data } = action;
  const ids = target.entity_id ?? [];
  if (
    !ids.length ||
    ids.length > RECONCILE_MAX_TARGETS ||
    target.device_id?.length ||
    target.area_id?.length ||
    new Set(ids).size !== ids.length ||
    !ids.every((id) => id.startsWith(`${domain}.`))
  )
    return null;
  const keys = Object.keys(data);
  const only = (...allowed: string[]) => keys.every((k) => allowed.includes(k));
  let goal: Omit<EntityGoal, "entityId"> | null = null;
  if (ON_OFF_DOMAINS.has(domain) && service === "turn_off" && !keys.length)
    goal = { state: "off" };
  else if (ON_OFF_DOMAINS.has(domain) && service === "toggle" && !keys.length)
    goal = { toggle: true };
  else if (ON_OFF_DOMAINS.has(domain) && service === "turn_on") {
    if (!keys.length) goal = { state: "on" };
    else if (
      domain === "light" &&
      only("brightness") &&
      finiteNumber(data.brightness) &&
      data.brightness > 0
    )
      goal = { state: "on", attrs: { brightness: data.brightness } };
  } else if (STATE_SERVICES[`${domain}.${service}`] && !keys.length)
    goal = { state: STATE_SERVICES[`${domain}.${service}`]! };
  else if (
    domain === "climate" &&
    service === "set_temperature" &&
    only("temperature") &&
    finiteNumber(data.temperature)
  )
    goal = { attrs: { temperature: data.temperature } };
  else if (
    domain === "climate" &&
    service === "set_hvac_mode" &&
    only("hvac_mode") &&
    typeof data.hvac_mode === "string" &&
    /^[a-z_]{1,32}$/.test(data.hvac_mode)
  )
    goal = { state: data.hvac_mode };
  else if (
    domain === "input_select" &&
    service === "select_option" &&
    only("option") &&
    typeof data.option === "string" &&
    data.option.length <= 64
  )
    goal = { state: data.option };
  if (!goal) return null;
  return {
    kind: "entity",
    goals: ids.map((entityId) => ({ entityId, ...goal })),
  };
}

// Whether one reading shows the goal. A toggle needs the reading from right
// before the attempt (on ↔ off); without it, it is never "met".
export function goalMet(
  goal: EntityGoal,
  now: EntitySnapshot,
  before?: EntitySnapshot,
): boolean {
  if (goal.toggle) {
    if (!before || (before.state !== "on" && before.state !== "off"))
      return false;
    return now.state === (before.state === "on" ? "off" : "on");
  }
  if (goal.state !== undefined && now.state !== goal.state) return false;
  for (const [key, value] of Object.entries(goal.attrs ?? {}))
    if (now.attrs[key] !== value) return false;
  return true;
}
// Exactly as before the attempt: same state and attributes, and Home
// Assistant reports no change since (so a change and a change back is not
// "unchanged").
export function unchangedSince(
  before: EntitySnapshot,
  now: EntitySnapshot,
): boolean {
  return (
    before.entityId === now.entityId &&
    sameAsBefore(before, now) &&
    before.lastChangedMs === now.lastChangedMs &&
    (before.lastUpdatedMs === undefined ||
      before.lastUpdatedMs === now.lastUpdatedMs)
  );
}
// One check over entity readings (null: unreadable).
export function entityResult(
  goals: readonly EntityGoal[],
  now: readonly (EntitySnapshot | null)[],
  before?: readonly EntitySnapshot[],
): ReconcileResult {
  if (now.length !== goals.length || now.some((n) => !n)) return "unreadable";
  const prior = (id: string) => before?.find((b) => b.entityId === id);
  if (goals.every((g, i) => goalMet(g, now[i]!, prior(g.entityId))))
    return "intended";
  if (
    goals.every((g, i) => {
      const b = prior(g.entityId);
      return !!b && unchangedSince(b, now[i]!);
    })
  )
    return "unchanged";
  return "mixed";
}
// One check over a list read. Before the attempt Hearth had just read the
// item (its text is the action's label, its status fit the operation, and
// an added text had no open duplicate).
export function todoResult(
  action: TodoAction,
  read: TodoRead | null,
): ReconcileResult {
  if (!read || read.entityId !== action.entityId) return "unreadable";
  const item = action.uid
    ? read.items.find((i) => i.uid === action.uid)
    : undefined;
  switch (action.op) {
    case "add": {
      // The list's own duplicate rule (lists.ts openDuplicate): an open item
      // with the same text, ignoring case and punctuation.
      const fingerprint = memoryFingerprint(action.summary!);
      const same = read.items.filter(
        (i) => memoryFingerprint(i.summary) === fingerprint,
      );
      if (same.some((i) => i.status === "needs_action")) return "intended";
      // Unchanged only when no item at all (open or done) carries the text:
      // an added item someone already ticked off is not "did not happen".
      return same.length ? "mixed" : "unchanged";
    }
    case "complete":
      return item?.status === "completed"
        ? "intended"
        : item?.status === "needs_action" && item.summary === action.label
          ? "unchanged"
          : "mixed";
    case "reopen":
      return item?.status === "needs_action"
        ? "intended"
        : item?.status === "completed" && item.summary === action.label
          ? "unchanged"
          : "mixed";
    case "rename":
      return item?.summary === action.summary
        ? "intended"
        : item?.summary === action.label
          ? "unchanged"
          : "mixed";
    case "remove":
      return !item
        ? "intended"
        : item.summary === action.label
          ? "unchanged"
          : "mixed";
  }
}

// Domains whose services change only the named entities. Anything else
// (scripts, scenes, automations, homeassistant.*, notify…) can reach the
// whole house.
const ENTITY_WRITE_DOMAINS = new Set([
  "light",
  "switch",
  "input_boolean",
  "fan",
  "cover",
  "climate",
  "lock",
  "media_player",
  "input_number",
  "input_select",
  "todo",
]);
export const WRITE_SCOPE_LIMIT = 200;
// The entities an action can change: its targets plus the members of any
// group target, as read by the controller. `undefined` means anything
// (config, registry, Supervisor, device/area targets, other domains, an
// unreadable target): an unknown outcome of such an action pauses every
// write, and such a new action waits for every unknown.
export function writeScope(
  action: Action,
  members: (entityId: string) => readonly string[] | null | undefined,
): string[] | undefined {
  let ids: string[];
  if (!("kind" in action)) ids = [action.entityId];
  else if (action.kind === "todo") return [action.entityId];
  else if (action.kind === "service") {
    const { domain, target } = action;
    ids = target.entity_id ?? [];
    if (
      !ENTITY_WRITE_DOMAINS.has(domain) ||
      !ids.length ||
      target.device_id?.length ||
      target.area_id?.length ||
      !ids.every((id) => id.startsWith(`${domain}.`))
    )
      return undefined;
  } else return undefined;
  const scope = new Set<string>();
  for (const id of ids) {
    const group = members(id);
    // A target whose state could not be read might be a group: anything.
    if (group === null || group === undefined) return undefined;
    scope.add(id);
    for (const member of group) scope.add(member);
  }
  return scope.size <= WRITE_SCOPE_LIMIT ? [...scope].sort() : undefined;
}
// Group members per target from the classifier's live reads (admin
// actions); null when the target was not readable.
export function riskMembers(context: RiskContext) {
  return (id: string) => {
    const facts = context.entities?.[id];
    return facts ? (facts.members ?? []) : null;
  };
}
// Whether a pause scope and a new scope overlap (undefined: everything).
export function scopesOverlap(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (!a || !b) return true;
  const set = new Set(a);
  return b.some((id) => set.has(id));
}

// What an unresolved outcome pauses (HomeActions.settings().pause).
export type WritePause = { all: boolean; entities: string[] };
// Whether writes to entityId (every write when omitted) are paused. Settings
// without `pause` fall back to `blocked` (any unresolved outcome).
export function writesPaused(
  permissions: { blocked: boolean; pause?: WritePause },
  entityId?: string,
): boolean {
  if (!permissions.pause) return permissions.blocked;
  return (
    permissions.pause.all ||
    (entityId !== undefined && permissions.pause.entities.includes(entityId))
  );
}
