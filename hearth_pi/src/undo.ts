// Undo (source slice): for a short window after a low/medium change that
// Hearth read before sending, the receipt offers Undo. Undo never dispatches
// anything by itself: it builds the exact reverse action from the state read
// before the change and files it as a NEW proposal through the same Home
// permissions, barriers and risk classifier as a person's press
// (HomeActions.undo). This module is pure: an allowlist (not a denylist) of
// reversible single-entity actions, the snapshot projection and the reverse
// builders.
import type {
  Action,
  AdminAction,
  JsonObject,
  TodoAction,
} from "./documents.js";

export const UNDO_WINDOW_MS = 600000;
// The entity changed again this long after the attempt: the reverse
// proposal always asks, even in Full access.
export const UNDO_STALE_MS = 30000;
export const UNDO_SNAPSHOT_BYTES = 1024;
// The only attributes a snapshot keeps.
export const UNDO_ATTRS = [
  "brightness",
  "color_temp_kelvin",
  "percentage",
  "current_position",
  "temperature",
  "volume_level",
  "is_volume_muted",
] as const;
type Scalar = number | string | boolean | null;
export type EntitySnapshot = {
  kind: "entity";
  entityId: string;
  state: string;
  attrs: Record<string, Scalar>;
  lastChangedMs: number;
  // Home Assistant's last_updated (attribute changes too), when reported.
  lastUpdatedMs?: number;
  readAt: number;
};
// A list change needs no read: the controller already read the item's text
// into the action's label before it was hashed (HAClient.prepareAction).
export type TodoSnapshot = {
  kind: "todo";
  entityId: string;
  readAt: number;
};
export type UndoSnapshot = EntitySnapshot | TodoSnapshot;
export type UndoRecord = {
  before: UndoSnapshot;
  // Set when the change was accepted: Undo is offered until then.
  until?: number;
  // The reverse proposal's id, set in the commit that created it.
  reverse?: string;
};

// Admin service calls Undo knows how to reverse, with the data keys the
// original may carry (all must be restorable).
const ADMIN_REVERSIBLE: Record<string, readonly string[]> = {
  "light.turn_on": ["brightness", "brightness_pct", "color_temp_kelvin"],
  "light.turn_off": [],
  "light.toggle": [],
  "switch.turn_on": [],
  "switch.turn_off": [],
  "switch.toggle": [],
  "input_boolean.turn_on": [],
  "input_boolean.turn_off": [],
  "input_boolean.toggle": [],
  "fan.turn_on": ["percentage"],
  "fan.turn_off": [],
  "fan.set_percentage": ["percentage"],
  "cover.open_cover": [],
  "cover.close_cover": [],
  "cover.set_cover_position": ["position"],
  "climate.set_temperature": ["temperature"],
  "climate.set_hvac_mode": ["hvac_mode"],
  "media_player.volume_set": ["volume_level"],
  "media_player.volume_mute": ["is_volume_muted"],
  "input_number.set_value": ["value"],
  "input_select.select_option": ["option"],
};
const SCOPED_TOGGLES = new Set([
  "light.turn_on",
  "light.turn_off",
  "switch.turn_on",
  "switch.turn_off",
]);

// The single entity an action changes, if Undo can reverse it at all;
// null for anything outside the allowlist (multiple entities, device/area
// targets, config, registry, Supervisor and list removals).
export function undoSubject(
  action: Action,
  admin: boolean,
): { kind: "entity"; entityId: string } | { kind: "todo" } | null {
  if (!("kind" in action))
    return SCOPED_TOGGLES.has(action.service) &&
      Object.keys(action.data).every((k) => k === "brightness")
      ? { kind: "entity", entityId: action.entityId }
      : null;
  if (action.kind === "todo")
    return action.op === "remove" ? null : { kind: "todo" };
  if (!admin || action.kind !== "service") return null;
  const keys = ADMIN_REVERSIBLE[`${action.domain}.${action.service}`];
  const ids = action.target.entity_id ?? [];
  if (
    !keys ||
    ids.length !== 1 ||
    action.target.device_id?.length ||
    action.target.area_id?.length ||
    !ids[0]!.startsWith(`${action.domain}.`) ||
    !Object.keys(action.data).every((k) => keys.includes(k))
  )
    return null;
  return { kind: "entity", entityId: ids[0]! };
}

// A raw HA state object → the bounded snapshot (allowlisted attributes only).
export function entitySnapshot(
  entityId: string,
  raw: unknown,
  readAt: number,
): EntitySnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.entity_id !== entityId || typeof value.state !== "string")
    return null;
  const source =
    value.attributes && typeof value.attributes === "object"
      ? (value.attributes as Record<string, unknown>)
      : {};
  const attrs: Record<string, Scalar> = {};
  for (const key of UNDO_ATTRS) {
    const v = source[key];
    if (
      v === null ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v))
    )
      attrs[key] = v;
    else if (typeof v === "string") attrs[key] = v.slice(0, 64);
  }
  const changed = Date.parse(String(value.last_changed ?? ""));
  const updated = Date.parse(String(value.last_updated ?? ""));
  const snapshot: EntitySnapshot = {
    kind: "entity",
    entityId,
    state: value.state.slice(0, 64),
    attrs,
    lastChangedMs: Number.isFinite(changed) ? changed : 0,
    ...(Number.isFinite(updated) ? { lastUpdatedMs: updated } : {}),
    readAt,
  };
  return JSON.stringify(snapshot).length <= UNDO_SNAPSHOT_BYTES
    ? snapshot
    : null;
}

const num = (v: Scalar | undefined) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const onOff = (state: string) =>
  state === "on" ? "turn_on" : state === "off" ? "turn_off" : null;

// The exact reverse action (as an unvalidated value for HAClient.action) for
// an entity change, or null when the snapshot cannot express it.
export function reverseEntityAction(
  action: Action,
  before: EntitySnapshot,
): unknown | null {
  if ("kind" in action && action.kind !== "service") return null;
  const domain =
    "kind" in action ? action.domain : action.service.split(".")[0]!;
  const service =
    "kind" in action ? action.service : action.service.split(".")[1]!;
  const entityId = before.entityId;
  const s = before.state;
  if (!("kind" in action)) {
    const verb = onOff(s);
    if (!verb) return null;
    const brightness = num(before.attrs.brightness);
    return {
      service: `${domain}.${verb}`,
      entityId,
      data:
        domain === "light" && verb === "turn_on" && brightness !== undefined
          ? { brightness: Math.round(brightness) }
          : {},
    };
  }
  const call = (svc: string, data: JsonObject = {}) =>
    ({
      kind: "service",
      domain,
      service: svc,
      target: { entity_id: [entityId] },
      data,
    }) satisfies AdminAction;
  switch (domain) {
    case "light": {
      const verb = onOff(s);
      if (!verb) return null;
      if (verb === "turn_off") return call("turn_off");
      const data: JsonObject = {};
      const brightness = num(before.attrs.brightness);
      const kelvin = num(before.attrs.color_temp_kelvin);
      if (brightness !== undefined) data.brightness = Math.round(brightness);
      if (kelvin !== undefined) data.color_temp_kelvin = Math.round(kelvin);
      // Restore only what was read; a key the original set but the snapshot
      // lacks would be lost.
      const original = (action as Extract<AdminAction, { kind: "service" }>)
        .data;
      if (
        ("color_temp_kelvin" in original && kelvin === undefined) ||
        (("brightness" in original || "brightness_pct" in original) &&
          brightness === undefined)
      )
        return null;
      return call("turn_on", data);
    }
    case "switch":
    case "input_boolean": {
      const verb = onOff(s);
      return verb ? call(verb) : null;
    }
    case "fan": {
      if (s === "off") return call("turn_off");
      if (s !== "on") return null;
      const percentage = num(before.attrs.percentage);
      return percentage !== undefined
        ? call("set_percentage", { percentage: Math.round(percentage) })
        : service === "set_percentage" ||
            "percentage" in (action as { data: object }).data
          ? null
          : call("turn_on");
    }
    case "cover": {
      const position = num(before.attrs.current_position);
      if (position !== undefined)
        return call("set_cover_position", { position: Math.round(position) });
      return s === "open"
        ? call("open_cover")
        : s === "closed"
          ? call("close_cover")
          : null;
    }
    case "climate":
      if (service === "set_hvac_mode")
        return /^[a-z_]{1,32}$/.test(s) &&
          s !== "unavailable" &&
          s !== "unknown"
          ? call("set_hvac_mode", { hvac_mode: s })
          : null;
      return num(before.attrs.temperature) !== undefined
        ? call("set_temperature", {
            temperature: num(before.attrs.temperature)!,
          })
        : null;
    case "media_player":
      if (service === "volume_set")
        return num(before.attrs.volume_level) !== undefined
          ? call("volume_set", {
              volume_level: num(before.attrs.volume_level)!,
            })
          : null;
      return typeof before.attrs.is_volume_muted === "boolean"
        ? call("volume_mute", { is_volume_muted: before.attrs.is_volume_muted })
        : null;
    case "input_number": {
      const value = Number(s);
      return s !== "" && Number.isFinite(value)
        ? call("set_value", { value })
        : null;
    }
    case "input_select":
      return s && s !== "unavailable" && s !== "unknown"
        ? call("select_option", { option: s })
        : null;
    default:
      return null;
  }
}
// Whether the entity is already back where it was (nothing to undo).
export function sameAsBefore(
  before: EntitySnapshot,
  now: EntitySnapshot,
): boolean {
  if (before.state !== now.state) return false;
  return UNDO_ATTRS.every((k) => before.attrs[k] === now.attrs[k]);
}

// A list change's reverse. `openMatches` are the uids of open items whose
// text is exactly the added text (read at undo time); an add is reversible
// only when exactly one such item exists.
export function reverseTodoAction(
  action: TodoAction,
  openMatches: readonly string[] = [],
): TodoAction | null {
  switch (action.op) {
    case "complete":
      return {
        kind: "todo",
        entityId: action.entityId,
        op: "reopen",
        uid: action.uid!,
      };
    case "reopen":
      return {
        kind: "todo",
        entityId: action.entityId,
        op: "complete",
        uid: action.uid!,
      };
    case "rename":
      return action.label
        ? {
            kind: "todo",
            entityId: action.entityId,
            op: "rename",
            uid: action.uid!,
            summary: action.label,
          }
        : null;
    case "add":
      return openMatches.length === 1
        ? {
            kind: "todo",
            entityId: action.entityId,
            op: "remove",
            uid: openMatches[0]!,
          }
        : null;
    default:
      return null;
  }
}
