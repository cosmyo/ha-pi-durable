// Home World v1, pure part: projects Home Assistant's area/device/entity
// registries down to Hearth's read scope, builds a deterministic auto layout
// (rooms on a tile grid, one per area, plus an "Unassigned" shed), validates
// owner customizations and merges them over the auto layout. No I/O here.
import { entityPattern, insist, object, text } from "./safety.js";

// 16 columns by default; an owner floor plan may widen the grid (the map
// then pans horizontally on narrow screens).
export const WORLD_GRID = Object.freeze({ cols: 16, maxCols: 40, maxRows: 64 });
export const WORLD_LIMITS = Object.freeze({
  devices: 64,
  rooms: 24,
  decor: 8,
  registryItems: 20000,
});
// Physical device domains shown as sprites. Others (automation, person, sun,
// weather, zone, calendar, …) stay out of the house; sun.sun only sets night.
export const WORLD_DOMAINS = Object.freeze([
  "light",
  "switch",
  "climate",
  "fan",
  "media_player",
  "vacuum",
  "lock",
  "cover",
  "binary_sensor",
  "sensor",
  "humidifier",
  "water_heater",
  "valve",
]);
export const FLOOR_STYLES = Object.freeze([
  "wood",
  "tile",
  "carpet",
  "stone",
  "grass",
] as const);
export type FloorStyle = (typeof FLOOR_STYLES)[number];
export const HATS = Object.freeze([
  "none",
  "beanie",
  "cap",
  "bow",
  "crown",
] as const);
export type Hat = (typeof HATS)[number];
export const PALETTE_COUNT = 4;
export const UNASSIGNED_ROOM = "unassigned";
export const roomIdPattern = /^(area:[a-z0-9_]{1,64}|unassigned)$/;
// Owner-drawn spaces without a Home Assistant area (balcony, garden, …).
export const decorIdPattern = /^decor:[a-z0-9_]{1,24}$/;
const areaIdPattern = /^[a-z0-9_]{1,64}$/;

export type RegistryProjection = {
  // Only areas holding at least one in-scope entity.
  areas: { id: string; name: string; level: string }[];
  // Exactly the in-scope entities, with their effective area and device name.
  // secondary: diagnostic/config category, hidden or disabled in HA.
  entities: Record<
    string,
    { area: string | null; device: string | null; secondary?: boolean }
  >;
};
export type WorldRoom = {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  floor: FloorStyle;
  level: string;
  // The Home Assistant area name (or null for the shed), never customized.
  area: string | null;
  // An owner-drawn space (decor:*) with no Home Assistant area.
  decor?: boolean;
};
export type WorldPlace = { room: string; fx: number; fy: number };
export type WorldDevice = WorldPlace & {
  entityId: string;
  area: string | null;
  device: string | null;
  moved: boolean;
};
export type WorldLevel = { id: string; name: string; y: number };
export type AutoLayout = {
  rows: number;
  levels: WorldLevel[];
  rooms: WorldRoom[];
  devices: WorldDevice[];
};
export type WorldCustom = {
  rooms: Record<
    string,
    { name: string; x: number; y: number; w: number; h: number; floor: string }
  >;
  devices: Record<string, WorldPlace>;
  character: { palette: number; hat: string };
  pet: boolean;
  // Grid width for an owner floor plan; absent means WORLD_GRID.cols.
  cols?: number;
};

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\u0000-\u001f\u007f]/;
function cleanName(value: unknown, clean: (s: string) => string): string {
  return typeof value === "string"
    ? clean(value).replace(CONTROL, " ").trim().slice(0, 40)
    : "";
}
// "ground_floor" → "Ground floor" (the floor registry is not read).
export function prettify(id: string): string {
  const words = id.replace(/_/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "";
}
function records(value: unknown): Record<string, unknown>[] {
  insist(
    Array.isArray(value) && value.length <= WORLD_LIMITS.registryItems,
    "ha_read_failed",
    502,
  );
  return (value as unknown[]).filter(
    (v): v is Record<string, unknown> =>
      !!v && typeof v === "object" && !Array.isArray(v),
  );
}

// Registry lists are untrusted and broad: keep only what the world needs for
// in-scope entities (area id/name/floor id, device display name). Registry
// internals (config entries, unique ids, pictures, labels, other entities)
// never leave this function.
export function projectRegistry(
  raw: { areas: unknown; devices: unknown; entities: unknown },
  scope: readonly string[],
  clean: (s: string) => string,
): RegistryProjection {
  const inScope = new Set(scope.filter((id) => entityPattern.test(id)));
  const entities = new Map<
    string,
    { area: string | null; deviceId: string | null; secondary: boolean }
  >();
  for (const e of records(raw.entities)) {
    const id = e.entity_id;
    if (typeof id !== "string" || !inScope.has(id) || entities.has(id))
      continue;
    entities.set(id, {
      area:
        typeof e.area_id === "string" && areaIdPattern.test(e.area_id)
          ? e.area_id
          : null,
      deviceId:
        typeof e.device_id === "string" && e.device_id.length <= 64
          ? e.device_id
          : null,
      secondary:
        e.entity_category === "diagnostic" ||
        e.entity_category === "config" ||
        !!e.hidden_by ||
        !!e.disabled_by,
    });
  }
  const wantedDevices = new Set(
    [...entities.values()].flatMap((e) => (e.deviceId ? [e.deviceId] : [])),
  );
  const devices = new Map<string, { area: string | null; name: string }>();
  for (const d of records(raw.devices)) {
    if (typeof d.id !== "string" || !wantedDevices.has(d.id)) continue;
    devices.set(d.id, {
      area:
        typeof d.area_id === "string" && areaIdPattern.test(d.area_id)
          ? d.area_id
          : null,
      name: cleanName(d.name_by_user, clean) || cleanName(d.name, clean),
    });
  }
  const out: RegistryProjection["entities"] = {};
  for (const id of [...inScope].sort()) {
    const e = entities.get(id);
    const device = e?.deviceId ? devices.get(e.deviceId) : undefined;
    // Entity area overrides its device's area, as in Home Assistant.
    out[id] = {
      area: e?.area ?? device?.area ?? null,
      device: device?.name || null,
      ...(e?.secondary ? { secondary: true } : {}),
    };
  }
  const wantedAreas = new Set(
    Object.values(out).flatMap((e) => (e.area ? [e.area] : [])),
  );
  const areas: RegistryProjection["areas"] = [];
  const seen = new Set<string>();
  for (const a of records(raw.areas)) {
    const id = a.area_id;
    if (typeof id !== "string" || !wantedAreas.has(id) || seen.has(id))
      continue;
    seen.add(id);
    areas.push({
      id,
      name: cleanName(a.name, clean) || prettify(id),
      level:
        typeof a.floor_id === "string" && areaIdPattern.test(a.floor_id)
          ? a.floor_id
          : "",
    });
  }
  // An area id without an area record is treated as unassigned.
  for (const e of Object.values(out))
    if (e.area && !seen.has(e.area)) e.area = null;
  areas.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { areas, entities: out };
}

// Most telling first: what a person notices in a room.
const PICK_ORDER = [
  "light",
  "climate",
  "cover",
  "lock",
  "media_player",
  "fan",
  "vacuum",
  "humidifier",
  "water_heater",
  "valve",
  "switch",
  "binary_sensor",
  "sensor",
];
const SHED_QUOTA = 8;
// The entities drawn in the world: in scope, physical domains, bounded.
// With the registry projection the bounded set is chosen fairly: rooms take
// turns picking their most telling device (lights, climate, covers… before
// switches and sensors), diagnostic/config/hidden/disabled entities are left
// out and unassigned entities get a small share. Output is sorted.
export function worldEntities(
  scope: readonly string[],
  projection: RegistryProjection | null = null,
): string[] {
  const physical = [...new Set(scope)].filter(
    (id) =>
      entityPattern.test(id) &&
      WORLD_DOMAINS.includes(id.split(".")[0]!) &&
      id !== "sun.sun",
  );
  if (!projection) return physical.sort().slice(0, WORLD_LIMITS.devices);
  const rank = (id: string) => PICK_ORDER.indexOf(id.split(".")[0]!);
  const byRank = (a: string, b: string) =>
    rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  const groups = new Map<string, string[]>();
  const shed: string[] = [];
  for (const id of physical) {
    const info = projection.entities[id];
    if (info?.secondary) continue;
    if (!info?.area) shed.push(id);
    else groups.set(info.area, [...(groups.get(info.area) ?? []), id]);
  }
  const queues = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, ids]) => ids.sort(byRank));
  shed.sort(byRank);
  const picked: string[] = [];
  const roomBudget = WORLD_LIMITS.devices - Math.min(SHED_QUOTA, shed.length);
  for (let i = 0; picked.length < roomBudget; i++) {
    const round = queues.filter((q) => i < q.length).map((q) => q[i]!);
    if (!round.length) break;
    picked.push(...round.slice(0, roomBudget - picked.length));
  }
  picked.push(...shed.slice(0, WORLD_LIMITS.devices - picked.length));
  return picked.sort();
}

// Floor style by area name: gardens are grass, wet rooms tile, quiet rooms
// carpet, garages and the shed stone, everything else wood.
export function floorFor(name: string, shed = false): FloorStyle {
  const n = name.toLowerCase();
  if (shed || /garage|shed|basement|cellar|utility|laundry/.test(n))
    return "stone";
  if (/garden|patio|yard|outdoor|outside|balcony|terrace|porch|lawn/.test(n))
    return "grass";
  if (/kitchen|bath|toilet|wc|shower|wash/.test(n)) return "tile";
  if (/bed|office|study|nursery|kid|guest|den/.test(n)) return "carpet";
  return "wood";
}
// Bigger rooms for areas with more devices.
export function roomSize(count: number): { w: number; h: number } {
  const n = Math.max(1, count);
  const w = clamp(3 + Math.ceil(Math.sqrt(n) * 1.5), 5, 9);
  const h = clamp(3 + Math.ceil(n / (w - 2)), 4, 7);
  return { w, h };
}
const DOMAIN_ORDER = WORLD_DOMAINS as readonly string[];
function slotPlaces(ids: string[], room: { w: number; h: number }) {
  const sorted = [...ids].sort((a, b) => {
    const da = DOMAIN_ORDER.indexOf(a.split(".")[0]!);
    const db = DOMAIN_ORDER.indexOf(b.split(".")[0]!);
    return da - db || (a < b ? -1 : a > b ? 1 : 0);
  });
  const cols = Math.max(1, Math.min(sorted.length, Math.floor(room.w / 1.6)));
  const rows = Math.max(1, Math.ceil(sorted.length / cols));
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return new Map(
    sorted.map((id, i) => [
      id,
      {
        fx: round((((i % cols) + 0.5) / cols) * 0.9 + 0.05),
        fy: round(((Math.floor(i / cols) + 0.5) / rows) * 0.9 + 0.05),
      },
    ]),
  );
}

// Deterministic: same registry projection and scope → same house. Areas are
// grouped by level (HA floor id), largest first, packed into full-width rows
// of a 16-column grid so neighbours share walls (doors). Levels are separated
// by one label row. Entities without an area live in the "Unassigned" shed.
export function autoLayout(
  projection: RegistryProjection | null,
  entities: readonly string[],
): AutoLayout {
  const byArea = new Map<string, string[]>();
  const shed: string[] = [];
  const areaInfo = new Map(
    (projection?.areas ?? []).map((a) => [a.id, a] as const),
  );
  for (const id of entities) {
    const area = projection?.entities[id]?.area ?? null;
    if (area && areaInfo.has(area)) {
      const list = byArea.get(area) ?? [];
      list.push(id);
      byArea.set(area, list);
    } else shed.push(id);
  }
  type Pending = {
    id: string;
    name: string;
    level: string;
    area: string | null;
    ids: string[];
    floor: FloorStyle;
  };
  let pending: Pending[] = [...byArea.entries()]
    .map(([areaId, ids]) => {
      const info = areaInfo.get(areaId)!;
      return {
        id: `area:${areaId}`,
        name: info.name,
        level: info.level,
        area: info.name,
        ids,
        floor: floorFor(info.name),
      };
    })
    .sort(
      (a, b) =>
        (a.level < b.level ? -1 : a.level > b.level ? 1 : 0) ||
        b.ids.length - a.ids.length ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
        (a.id < b.id ? -1 : 1),
    );
  // Beyond the room limit, the smallest areas' devices move to the shed.
  if (pending.length > WORLD_LIMITS.rooms - 1) {
    const keep = [...pending]
      .sort((a, b) => b.ids.length - a.ids.length || (a.id < b.id ? -1 : 1))
      .slice(0, WORLD_LIMITS.rooms - 1);
    const kept = new Set(keep.map((p) => p.id));
    for (const p of pending) if (!kept.has(p.id)) shed.push(...p.ids);
    pending = pending.filter((p) => kept.has(p.id));
  }
  if (shed.length) {
    const lastLevel = pending.length ? pending[pending.length - 1]!.level : "";
    pending.push({
      id: UNASSIGNED_ROOM,
      name: "Unassigned",
      level: lastLevel,
      area: null,
      ids: shed.sort(),
      floor: "stone",
    });
  }
  const levelIds = [...new Set(pending.map((p) => p.level))];
  const labelled = levelIds.length > 1;
  const rooms: WorldRoom[] = [];
  const devices: WorldDevice[] = [];
  const levels: WorldLevel[] = [];
  let y = 0;
  for (const level of levelIds) {
    if (labelled) {
      levels.push({
        id: level,
        name: level ? prettify(level) : "Other areas",
        y,
      });
      y += 1;
    }
    let row: { p: Pending; w: number; h: number }[] = [];
    const flush = () => {
      if (!row.length) return;
      let spare = WORLD_GRID.cols - row.reduce((n, r) => n + r.w, 0);
      // Stretch rooms (at most +4 each) so rows read as one house.
      for (let pass = 0; pass < 4 && spare > 0; pass++)
        for (const r of row) if (spare > 0) (r.w++, spare--);
      const height = Math.max(...row.map((r) => r.h));
      let x = 0;
      for (const r of row) {
        const room: WorldRoom = {
          id: r.p.id,
          name: r.p.name,
          x,
          y,
          w: r.w,
          h: height,
          floor: r.p.floor,
          level: r.p.level,
          area: r.p.area,
        };
        rooms.push(room);
        const places = slotPlaces(r.p.ids, room);
        for (const id of r.p.ids) {
          const place = places.get(id)!;
          devices.push({
            entityId: id,
            room: room.id,
            fx: place.fx,
            fy: place.fy,
            area: r.p.area,
            device: projection?.entities[id]?.device ?? null,
            moved: false,
          });
        }
        x += r.w;
      }
      y += height;
      row = [];
    };
    for (const p of pending.filter((q) => q.level === level)) {
      const size = roomSize(p.ids.length);
      if (row.reduce((n, r) => n + r.w, 0) + size.w > WORLD_GRID.cols) flush();
      row.push({ p, ...size });
    }
    flush();
  }
  devices.sort((a, b) => (a.entityId < b.entityId ? -1 : 1));
  return { rows: Math.min(WORLD_GRID.maxRows, y), levels, rooms, devices };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const int = (v: unknown, lo: number, hi: number) =>
  Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;
const fraction = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const roomName = (v: unknown) => {
  const name = text(v, 24).trim();
  insist(name && !HAS_CONTROL.test(name), "invalid_world_layout");
  return name;
};

// Strict: every field is required, typed and bounded, unknown keys are
// refused, device overrides must name in-scope entities.
export function validateCustom(
  raw: unknown,
  scope: readonly string[],
  clean: (s: string) => string,
): WorldCustom {
  const fail = "invalid_world_layout";
  insist(isPlainObject(raw), fail);
  const v = object(raw, ["rooms", "devices", "character", "pet", "cols"]);
  insist(
    v.cols === undefined || int(v.cols, WORLD_GRID.cols, WORLD_GRID.maxCols),
    fail,
  );
  const cols = (v.cols as number | undefined) ?? WORLD_GRID.cols;
  insist(
    isPlainObject(v.rooms) &&
      isPlainObject(v.devices) &&
      isPlainObject(v.character) &&
      typeof v.pet === "boolean",
    fail,
  );
  const roomKeys = Object.keys(v.rooms);
  insist(
    roomKeys.filter((id) => decorIdPattern.test(id)).length <=
      WORLD_LIMITS.decor &&
      roomKeys.length <= WORLD_LIMITS.rooms + WORLD_LIMITS.decor,
    fail,
  );
  const rooms: WorldCustom["rooms"] = {};
  for (const id of roomKeys) {
    insist(roomIdPattern.test(id) || decorIdPattern.test(id), fail);
    const r = object(v.rooms[id], ["name", "x", "y", "w", "h", "floor"]);
    insist(
      int(r.w, 2, cols) &&
        int(r.h, 2, 16) &&
        int(r.x, 0, cols - (r.w as number)) &&
        int(r.y, 0, WORLD_GRID.maxRows - (r.h as number)) &&
        (FLOOR_STYLES as readonly unknown[]).includes(r.floor),
      fail,
    );
    rooms[id] = {
      name: clean(roomName(r.name)).slice(0, 24),
      x: r.x as number,
      y: r.y as number,
      w: r.w as number,
      h: r.h as number,
      floor: r.floor as string,
    };
  }
  const readable = new Set(scope);
  const deviceKeys = Object.keys(v.devices);
  insist(deviceKeys.length <= WORLD_LIMITS.devices, fail);
  const devices: WorldCustom["devices"] = {};
  for (const id of deviceKeys) {
    insist(entityPattern.test(id) && id.length <= 100, fail);
    insist(readable.has(id), "entity_not_allowed", 403);
    const d = object(v.devices[id], ["room", "fx", "fy"]);
    insist(
      typeof d.room === "string" &&
        (roomIdPattern.test(d.room) || decorIdPattern.test(d.room)) &&
        fraction(d.fx) &&
        fraction(d.fy),
      fail,
    );
    devices[id] = {
      room: d.room,
      fx: Math.round((d.fx as number) * 1000) / 1000,
      fy: Math.round((d.fy as number) * 1000) / 1000,
    };
  }
  const c = object(v.character, ["palette", "hat"]);
  insist(
    int(c.palette, 0, PALETTE_COUNT - 1) &&
      (HATS as readonly unknown[]).includes(c.hat),
    fail,
  );
  return {
    rooms,
    devices,
    character: { palette: c.palette as number, hat: c.hat as string },
    pet: v.pet,
    ...(cols !== WORLD_GRID.cols ? { cols } : {}),
  };
}

// The prototype's localStorage layout (one-time migration). Strict schema;
// anything else is refused rather than repaired.
export function validatePrototypeLayout(raw: unknown) {
  const fail = "invalid_prototype_layout";
  insist(isPlainObject(raw), fail);
  const keys = ["version", "rooms", "devices", "character", "pet"];
  insist(
    Object.keys(raw).every((k) => keys.includes(k)) && raw.version === 1,
    fail,
  );
  insist(
    Array.isArray(raw.rooms) &&
      raw.rooms.length >= 1 &&
      raw.rooms.length <= 12 &&
      isPlainObject(raw.devices) &&
      isPlainObject(raw.character) &&
      typeof raw.pet === "boolean",
    fail,
  );
  const rooms = new Map<string, { name: string; floor: string }>();
  for (const room of raw.rooms as unknown[]) {
    insist(isPlainObject(room), fail);
    const allowed = ["id", "name", "x", "y", "w", "h", "floor"];
    insist(
      Object.keys(room).every((k) => allowed.includes(k)) &&
        typeof room.id === "string" &&
        /^[a-z0-9-]{1,24}$/.test(room.id) &&
        !rooms.has(room.id) &&
        typeof room.name === "string" &&
        room.name.length >= 1 &&
        room.name.length <= 24 &&
        int(room.w, 2, 16) &&
        int(room.h, 2, 12) &&
        int(room.x, 0, 16 - (room.w as number)) &&
        int(room.y, 0, 12 - (room.h as number)) &&
        (FLOOR_STYLES as readonly unknown[]).includes(room.floor),
      fail,
    );
    rooms.set(room.id as string, {
      name: room.name as string,
      floor: room.floor as string,
    });
  }
  const devices = Object.entries(raw.devices);
  insist(devices.length <= 64, fail);
  const places: Record<string, { room: string; fx: number; fy: number }> = {};
  for (const [id, place] of devices) {
    insist(entityPattern.test(id) && id.length <= 100, fail);
    insist(isPlainObject(place), fail);
    insist(
      Object.keys(place).every((k) => ["room", "fx", "fy"].includes(k)) &&
        typeof place.room === "string" &&
        rooms.has(place.room) &&
        fraction(place.fx) &&
        fraction(place.fy),
      fail,
    );
    places[id] = {
      room: place.room,
      fx: place.fx as number,
      fy: place.fy as number,
    };
  }
  const c = raw.character;
  insist(
    Object.keys(c).every((k) => ["palette", "hat"].includes(k)) &&
      int(c.palette, 0, PALETTE_COUNT - 1) &&
      (HATS as readonly unknown[]).includes(c.hat),
    fail,
  );
  return {
    rooms,
    devices: places,
    character: { palette: c.palette as number, hat: c.hat as string },
    pet: raw.pet,
  };
}

// Carries over what still means something on the new auto house: character,
// pet, floor styles of rooms whose names match an area, and device room
// choices that map to such a room. Prototype grid positions are not reused.
export function migratePrototype(
  prototype: ReturnType<typeof validatePrototypeLayout>,
  auto: AutoLayout,
  scope: readonly string[],
): WorldCustom {
  const byName = new Map(
    auto.rooms.map((r) => [r.name.toLowerCase(), r] as const),
  );
  const target = new Map<string, WorldRoom>();
  const rooms: WorldCustom["rooms"] = {};
  for (const [id, room] of prototype.rooms) {
    const match = byName.get(room.name.toLowerCase());
    if (!match) continue;
    target.set(id, match);
    rooms[match.id] = {
      name: match.name.slice(0, 24) || "Room",
      x: match.x,
      y: match.y,
      w: match.w,
      h: match.h,
      floor: room.floor,
    };
  }
  const readable = new Set(scope);
  const devices: WorldCustom["devices"] = {};
  for (const [id, place] of Object.entries(prototype.devices)) {
    const room = target.get(place.room);
    if (room && readable.has(id))
      devices[id] = {
        room: room.id,
        fx: Math.round(place.fx * 1000) / 1000,
        fy: Math.round(place.fy * 1000) / 1000,
      };
  }
  return {
    rooms,
    devices,
    character: prototype.character,
    pet: prototype.pet,
  };
}

// Custom geometry, names and device rooms over the current auto house. Room
// overrides for areas that no longer exist and device overrides for entities
// that left the scope are ignored (and never returned).
export function mergeLayout(
  auto: AutoLayout,
  custom: WorldCustom | null,
  scope: readonly string[],
) {
  const cols = clamp(
    custom?.cols ?? WORLD_GRID.cols,
    WORLD_GRID.cols,
    WORLD_GRID.maxCols,
  );
  const place = (room: WorldRoom, o: WorldCustom["rooms"][string]) => {
    const w = clamp(o.w, 2, cols);
    const h = clamp(o.h, 2, 16);
    return {
      ...room,
      name: o.name,
      w,
      h,
      x: clamp(o.x, 0, cols - w),
      y: clamp(o.y, 0, WORLD_GRID.maxRows - h),
      floor: (FLOOR_STYLES as readonly string[]).includes(o.floor)
        ? (o.floor as FloorStyle)
        : room.floor,
    };
  };
  const rooms: WorldRoom[] = auto.rooms.map((room) => {
    const o = custom?.rooms[room.id];
    return o ? place(room, o) : { ...room };
  });
  // Owner-drawn spaces (balcony, garden…) follow the areas, in id order.
  for (const [id, o] of Object.entries(custom?.rooms ?? {}).sort(([a], [b]) =>
    a < b ? -1 : 1,
  ))
    if (decorIdPattern.test(id))
      rooms.push(
        place(
          {
            id,
            name: o.name,
            x: 0,
            y: 0,
            w: 2,
            h: 2,
            floor: "wood",
            level: "",
            area: null,
            decor: true,
          },
          o,
        ),
      );
  const roomIds = new Set(rooms.map((r) => r.id));
  const readable = new Set(scope);
  const devices = auto.devices.map((d) => {
    const o = custom?.devices[d.entityId];
    return o && roomIds.has(o.room) && readable.has(d.entityId)
      ? { ...d, room: o.room, fx: o.fx, fy: o.fy, moved: true }
      : { ...d };
  });
  const visible: WorldCustom | null = custom
    ? {
        rooms: Object.fromEntries(
          Object.entries(custom.rooms).filter(([id]) => roomIds.has(id)),
        ),
        devices: Object.fromEntries(
          Object.entries(custom.devices).filter(
            ([id, place]) =>
              readable.has(id) &&
              roomIds.has(place.room) &&
              auto.devices.some((d) => d.entityId === id),
          ),
        ),
        character: { ...custom.character },
        pet: custom.pet,
        ...(cols !== WORLD_GRID.cols ? { cols } : {}),
      }
    : null;
  // The house is as tall as its rooms (and level labels), so a moved-in
  // floor plan does not keep the auto layout's empty rows.
  const rows = Math.min(
    WORLD_GRID.maxRows,
    Math.max(
      1,
      ...auto.levels.map((l) => l.y + 1),
      ...rooms.map((r) => r.y + r.h),
    ),
  );
  return {
    grid: { cols, rows },
    levels: auto.levels,
    rooms,
    devices,
    character: custom?.character
      ? {
          palette: clamp(custom.character.palette, 0, PALETTE_COUNT - 1),
          hat: (HATS as readonly string[]).includes(custom.character.hat)
            ? custom.character.hat
            : "none",
        }
      : { palette: 0, hat: "beanie" },
    pet: custom ? custom.pet : true,
    custom: visible,
  };
}

export type DeviceKind =
  | "light"
  | "switch"
  | "climate"
  | "fan"
  | "media"
  | "vacuum"
  | "lock"
  | "cover"
  | "garage"
  | "door"
  | "window"
  | "motion"
  | "leak"
  | "battery"
  | "thermo"
  | "humidity"
  | "printer"
  | "binary"
  | "sensor";
// Sprite choice by domain, device class and printer-like names.
export function deviceKind(
  entityId: string,
  deviceClass: string,
  name: string,
): DeviceKind {
  const domain = entityId.split(".")[0];
  const words = `${entityId} ${name}`.toLowerCase();
  const printer =
    /printer|3d_print|3d print|prusa|bambu|octoprint|nozzle|filament|klipper/;
  if (
    (domain === "sensor" || domain === "binary_sensor") &&
    printer.test(words)
  )
    return "printer";
  switch (domain) {
    case "light":
      return "light";
    case "switch":
      return "switch";
    case "climate":
    case "water_heater":
      return "climate";
    case "fan":
      return "fan";
    case "media_player":
      return "media";
    case "vacuum":
      return "vacuum";
    case "lock":
      return "lock";
    case "cover":
      return deviceClass === "garage" ? "garage" : "cover";
    case "valve":
      return "cover";
    case "humidifier":
      return "humidity";
    case "binary_sensor":
      if (deviceClass === "door" || deviceClass === "opening") return "door";
      if (deviceClass === "garage_door") return "garage";
      if (deviceClass === "window") return "window";
      if (["motion", "occupancy", "presence"].includes(deviceClass))
        return "motion";
      if (deviceClass === "moisture") return "leak";
      if (deviceClass === "battery") return "battery";
      return "binary";
    default:
      if (deviceClass === "temperature") return "thermo";
      if (deviceClass === "humidity" || deviceClass === "moisture")
        return "humidity";
      if (deviceClass === "battery") return "battery";
      return "sensor";
  }
}
export type Anomaly =
  | ""
  | "unavailable"
  | "open_at_night"
  | "low_battery"
  | "leak";
// Calm by default: only these states glint.
export function anomalyOf(
  kind: DeviceKind,
  deviceClass: string,
  state: string,
  night: boolean,
): Anomaly {
  if (state === "unavailable") return "unavailable";
  const open = state === "on" || state === "open" || state === "opening";
  if (
    night &&
    open &&
    (kind === "door" || kind === "window" || kind === "garage")
  )
    return "open_at_night";
  if (deviceClass === "battery") {
    const level = Number(state);
    if (
      state === "on" ||
      (state.trim() !== "" && Number.isFinite(level) && level < 20)
    )
      return "low_battery";
  }
  if (kind === "leak" && state === "on") return "leak";
  return "";
}
