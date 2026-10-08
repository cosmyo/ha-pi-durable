/* PROTOTYPE — Hearth "Home World" UI exploration (throwaway, not a feature).
 *
 * Shared shell for three radically different variants, switchable with a
 * floating ◀ label ▶ bar, ←/→ keys (when not typing) or the URL hash
 * (#world=A|B|C; the server rejects query strings):
 *   A  world-pixel.js    — 3DS-like split screen: pixel house + RPG dialogue
 *   B  world-diorama.js  — three.js low-poly dollhouse + chat bottom sheet
 *   C  world-ambient.js  — chat stays primary; side-view strip while thinking
 *
 * Data is read-only and comes only from the snapshot app.js already receives
 * (saved Home canvas, conversation entries, pi.live). Nothing here calls
 * Home Assistant or services: tapping a device can only draft a question via
 * app.js draftQuestion. The owner's layout lives in memory and is mirrored to
 * localStorage under LAYOUT_KEY; there is no server persistence.
 * Untrusted text is rendered with textContent / canvas fillText only.
 */

export const LAYOUT_KEY = "hearth-PROTOTYPE-world-layout";
export const GRID = { cols: 16, rows: 12 };
export const FLOORS = {
  wood: "Wood",
  tile: "Tile",
  carpet: "Carpet",
  stone: "Stone",
  grass: "Garden",
};
export const PALETTES = [
  { name: "Ember", body: "#d9664a", trim: "#ffc58e", hair: "#4a2f22" },
  { name: "Sage", body: "#4f8f72", trim: "#d6efd0", hair: "#2e2a24" },
  { name: "Dusk", body: "#5f62b0", trim: "#dcdaff", hair: "#1f1a2e" },
  { name: "Sun", body: "#d9a12c", trim: "#fff2c2", hair: "#7a3f1d" },
];
export const HATS = {
  none: "No hat",
  beanie: "Beanie",
  cap: "Cap",
  bow: "Bow",
  crown: "Crown",
};
export const VARIANTS = [
  { id: "A", label: "Pixel house", load: () => import("./world-pixel.js") },
  { id: "B", label: "Diorama", load: () => import("./world-diorama.js") },
  {
    id: "C",
    label: "Ambient think mode",
    load: () => import("./world-ambient.js"),
  },
];
export const BUILD_PROMPT_FALLBACK =
  "Discover the exact HA entities you are allowed to read, then use ha_build_view to build a useful status canvas with sensible named sections. Use controller-read facts; do not invent entities/rooms or call services. If the scope is empty, explain that.";

// ---------------------------------------------------------------- helpers
export function el(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = String(options.text);
  for (const [name, value] of Object.entries(options.attrs ?? {}))
    element.setAttribute(name, String(value));
  for (const child of children) if (child) element.append(child);
  return element;
}
export function button(text, className = "", label = "") {
  const b = el("button", { className, text, attrs: { type: "button" } });
  if (label) b.setAttribute("aria-label", label);
  return b;
}
export const reducedMotion = () =>
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isEditable = (target) =>
  !!target?.closest?.("input, textarea, select, [contenteditable='true']");
export function hash32(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ------------------------------------------------------------ layout store
function defaultLayout() {
  return {
    version: 1,
    rooms: [
      {
        id: "living",
        name: "Living room",
        x: 0,
        y: 0,
        w: 7,
        h: 6,
        floor: "wood",
      },
      { id: "kitchen", name: "Kitchen", x: 7, y: 0, w: 5, h: 6, floor: "tile" },
      {
        id: "office",
        name: "Office",
        x: 12,
        y: 0,
        w: 4,
        h: 6,
        floor: "carpet",
      },
      {
        id: "bedroom",
        name: "Bedroom",
        x: 0,
        y: 6,
        w: 6,
        h: 6,
        floor: "carpet",
      },
      { id: "hall", name: "Hall", x: 6, y: 6, w: 5, h: 6, floor: "stone" },
      { id: "patio", name: "Patio", x: 11, y: 6, w: 5, h: 6, floor: "grass" },
    ],
    devices: {},
    character: { palette: 0, hat: "beanie" },
    pet: true,
  };
}
// localStorage is untrusted input: rebuild a bounded layout from it.
export function sanitizeLayout(raw) {
  const fallback = defaultLayout();
  if (!raw || typeof raw !== "object") return fallback;
  const rooms = [];
  const ids = new Set();
  for (const room of Array.isArray(raw.rooms) ? raw.rooms.slice(0, 12) : []) {
    if (!room || typeof room !== "object") continue;
    const id = String(room.id ?? "").slice(0, 24);
    if (!/^[a-z0-9-]+$/.test(id) || ids.has(id)) continue;
    const w = clamp(Math.round(Number(room.w) || 3), 2, GRID.cols);
    const h = clamp(Math.round(Number(room.h) || 3), 2, GRID.rows);
    ids.add(id);
    rooms.push({
      id,
      name: String(room.name ?? "Room").slice(0, 24) || "Room",
      w,
      h,
      x: clamp(Math.round(Number(room.x) || 0), 0, GRID.cols - w),
      y: clamp(Math.round(Number(room.y) || 0), 0, GRID.rows - h),
      floor: Object.hasOwn(FLOORS, room.floor) ? room.floor : "wood",
    });
  }
  const devices = {};
  const rawDevices =
    raw.devices && typeof raw.devices === "object" ? raw.devices : {};
  for (const [entityId, place] of Object.entries(rawDevices).slice(0, 64)) {
    if (
      !/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(entityId) ||
      entityId.length > 100
    )
      continue;
    if (!place || !ids.has(place.room)) continue;
    devices[entityId] = {
      room: place.room,
      fx: clamp(Number(place.fx) || 0.5, 0, 1),
      fy: clamp(Number(place.fy) || 0.5, 0, 1),
    };
  }
  const character =
    raw.character && typeof raw.character === "object" ? raw.character : {};
  return {
    version: 1,
    rooms: rooms.length ? rooms : fallback.rooms,
    devices,
    character: {
      palette: clamp(
        Math.round(Number(character.palette) || 0),
        0,
        PALETTES.length - 1,
      ),
      hat: Object.hasOwn(HATS, character.hat) ? character.hat : "none",
    },
    pet: raw.pet !== false,
  };
}
function loadLayout() {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    return saved ? sanitizeLayout(JSON.parse(saved)) : defaultLayout();
  } catch {
    return defaultLayout();
  }
}
export function createStore() {
  let layout = loadLayout();
  const listeners = new Set();
  const notify = () => {
    for (const listener of listeners) listener(layout);
  };
  const save = () => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* Prototype: memory-only when storage is unavailable. */
    }
  };
  return {
    get: () => layout,
    update(mutate) {
      mutate(layout);
      layout = sanitizeLayout(layout);
      save();
      notify();
    },
    reset() {
      layout = defaultLayout();
      try {
        localStorage.removeItem(LAYOUT_KEY);
      } catch {
        /* ignore */
      }
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// --------------------------------------------------------- geometry/paths
export function roomAt(layout, x, y) {
  return (
    layout.rooms.find(
      (r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h,
    ) ?? null
  );
}
// Doors: one tile-wide opening in the middle of every shared edge of ≥2 tiles.
export function doorsOf(layout) {
  const doors = [];
  const rooms = layout.rooms;
  for (let i = 0; i < rooms.length; i++)
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i],
        b = rooms[j];
      for (const [p, q] of [
        [a, b],
        [b, a],
      ]) {
        // A vertical door sits on the line x, covering tile row y; a
        // horizontal door sits on the line y, covering tile column x.
        if (p.x + p.w === q.x) {
          const lo = Math.max(p.y, q.y),
            hi = Math.min(p.y + p.h, q.y + q.h);
          if (hi - lo >= 2)
            doors.push({
              a: p.id,
              b: q.id,
              vertical: true,
              x: q.x,
              y: Math.floor((lo + hi - 1) / 2),
            });
        }
        if (p.y + p.h === q.y) {
          const lo = Math.max(p.x, q.x),
            hi = Math.min(p.x + p.w, q.x + q.w);
          if (hi - lo >= 2)
            doors.push({
              a: p.id,
              b: q.id,
              vertical: false,
              y: q.y,
              x: Math.floor((lo + hi - 1) / 2),
            });
        }
      }
    }
  return doors;
}
// Wall segments in grid units with door openings removed. A vertical wall
// runs along x from y0 to y1; a horizontal one along y from x0 to x1.
export function wallsOf(layout) {
  const doors = doorsOf(layout);
  const walls = [];
  const seen = new Set();
  const push = (wall) => {
    const key = `${wall.vertical}|${wall.at}|${wall.from}|${wall.to}`;
    if (wall.to - wall.from <= 0 || seen.has(key)) return;
    seen.add(key);
    walls.push(wall);
  };
  for (const room of layout.rooms) {
    const edges = [
      {
        vertical: false,
        at: room.y,
        from: room.x,
        to: room.x + room.w,
        side: "n",
      },
      {
        vertical: false,
        at: room.y + room.h,
        from: room.x,
        to: room.x + room.w,
        side: "s",
      },
      {
        vertical: true,
        at: room.x,
        from: room.y,
        to: room.y + room.h,
        side: "w",
      },
      {
        vertical: true,
        at: room.x + room.w,
        from: room.y,
        to: room.y + room.h,
        side: "e",
      },
    ];
    for (const edge of edges) {
      const gaps = doors
        .filter(
          (d) =>
            d.vertical === edge.vertical &&
            (edge.vertical ? d.x === edge.at : d.y === edge.at) &&
            (d.a === room.id || d.b === room.id),
        )
        .map((d) => (edge.vertical ? d.y : d.x))
        .sort((p, q) => p - q);
      let from = edge.from;
      for (const gap of gaps) {
        push({ ...edge, from, to: gap });
        from = gap + 1;
      }
      push({ ...edge, from, to: edge.to });
    }
  }
  return walls;
}
// Waypoints (grid units, floats) from one point to another through doors.
export function planPath(layout, from, to) {
  const start = roomAt(layout, from.x, from.y),
    goal = roomAt(layout, to.x, to.y);
  if (!start || !goal || start.id === goal.id) return [to];
  const doors = doorsOf(layout);
  const previous = new Map([[start.id, null]]);
  const queue = [start.id];
  while (queue.length) {
    const id = queue.shift();
    if (id === goal.id) break;
    for (const door of doors) {
      const next = door.a === id ? door.b : door.b === id ? door.a : null;
      if (next && !previous.has(next)) {
        previous.set(next, { id, door });
        queue.push(next);
      }
    }
  }
  if (!previous.has(goal.id)) return [to];
  const hops = [];
  for (let id = goal.id; previous.get(id); id = previous.get(id).id)
    hops.unshift({ door: previous.get(id).door, into: id });
  const points = [];
  for (const { door, into } of hops) {
    const target = layout.rooms.find((r) => r.id === into);
    if (door.vertical) {
      const enteringEast = target.x === door.x;
      const cy = door.y + 0.5;
      points.push({ x: door.x + (enteringEast ? -0.6 : 0.6), y: cy });
      points.push({ x: door.x + (enteringEast ? 0.6 : -0.6), y: cy });
    } else {
      const enteringSouth = target.y === door.y;
      const cx = door.x + 0.5;
      points.push({ x: cx, y: door.y + (enteringSouth ? -0.6 : 0.6) });
      points.push({ x: cx, y: door.y + (enteringSouth ? 0.6 : -0.6) });
    }
  }
  points.push(to);
  return points;
}

// ------------------------------------------------------------ data adapter
const DOMAIN_KIND = {
  light: "light",
  switch: "switch",
  climate: "climate",
  fan: "fan",
  media_player: "media",
  cover: "cover",
  lock: "lock",
  binary_sensor: "binary",
  sensor: "sensor",
};
function deviceKind(entityId, name, unit) {
  const text = `${entityId} ${name}`.toLowerCase();
  if (/printer|3d|prusa|bambu|octo/.test(text)) return "printer";
  const kind = DOMAIN_KIND[entityId.split(".")[0]] ?? "sensor";
  if (kind === "sensor" && /°|temp/.test(`${unit} ${text}`)) return "thermo";
  return kind;
}
const ACTIVE_STATES = new Set([
  "on",
  "open",
  "playing",
  "heat",
  "cool",
  "heat_cool",
  "auto",
  "dry",
  "fan_only",
  "printing",
  "unlocked",
]);
function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
function toolCalls(message, into) {
  if (!Array.isArray(message?.content)) return;
  for (const block of message.content)
    if (block?.type === "toolCall" && typeof block.id === "string")
      into.set(block.id, {
        name: String(block.name ?? ""),
        args: block.arguments ?? {},
      });
}
const TOOL_VERB = {
  ha_state_detail: "Reading",
  ha_search_states: "Searching",
  ha_build_view: "Arranging",
  ha_discover_services: "Checking what I may change",
  ha_propose_service: "Proposing a change to",
};
// Turn the snapshot app.js already has into a small, display-only world.
export function deriveWorld(input) {
  const snapshot = input.snapshot ?? null;
  const home = (input.kind ?? "home") === "home";
  const canvas = home ? (snapshot?.homeCanvas ?? null) : null;
  const devices = [];
  const seen = new Set();
  for (const section of canvas?.sections ?? []) {
    for (const reading of section?.readings ?? []) {
      const entityId = String(reading?.entityId ?? "");
      if (!entityId || seen.has(entityId) || devices.length >= 24) continue;
      seen.add(entityId);
      const attributes = reading.attributes ?? {};
      const name = String(attributes.friendly_name ?? entityId).slice(0, 60);
      const unit = String(attributes.unit_of_measurement ?? "").slice(0, 12);
      const state = String(reading.state ?? "unknown").slice(0, 40);
      devices.push({
        entityId,
        name,
        unit,
        state,
        section: String(section.title ?? "").slice(0, 60),
        observedAt: Number(reading.observedAt) || 0,
        kind: deviceKind(entityId, name, unit),
        active: ACTIVE_STATES.has(state.toLowerCase()),
        value: unit ? `${state} ${unit}` : state,
      });
    }
  }
  const entries = Array.isArray(snapshot?.view?.entries)
    ? snapshot.view.entries
    : [];
  const live = snapshot?.view?.docs?.["pi.live"] ?? {};
  const calls = new Map();
  const lines = [];
  for (const entry of entries.slice(-12))
    for (const message of Array.isArray(entry?.model) ? entry.model : []) {
      toolCalls(message, calls);
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text = messageText(message);
      if (text)
        lines.push({
          who: message.role === "user" ? "You" : "Hearth",
          text: text.slice(0, 600),
        });
    }
  if (live.generation?.message) {
    toolCalls(live.generation.message, calls);
    const partial = messageText(live.generation.message);
    if (partial)
      lines.push({ who: "Hearth", text: partial.slice(0, 600), partial: true });
  }
  const busy = !!input.busy || !!live.run;
  let focus = null;
  const tools = Array.isArray(live.tools) ? live.tools : [];
  const current =
    [...tools].reverse().find((t) => t?.status === "running") ??
    tools.find((t) => t?.status === "pending") ??
    tools[tools.length - 1];
  if (busy && current) {
    const call = calls.get(current.callId) ?? { name: current.name, args: {} };
    const name = String(call.name || current.name || "tool");
    let entityId =
      typeof call.args?.entityId === "string" ? call.args.entityId : "";
    if (!entityId && name === "ha_build_view")
      entityId = String(call.args?.sections?.[0]?.entities?.[0] ?? "");
    const device = devices.find((d) => d.entityId === entityId) ?? null;
    const target = device?.name ?? entityId;
    const query =
      typeof call.args?.query === "string" ? call.args.query.slice(0, 40) : "";
    const verb = TOOL_VERB[name] ?? `Using ${name}`;
    focus = {
      tool: name,
      status: String(current.status ?? ""),
      entityId,
      device,
      label:
        name === "ha_search_states"
          ? `Searching your home${query ? ` for “${query}”` : ""}…`
          : name === "ha_build_view"
            ? "Arranging your home view…"
            : `${verb}${target ? ` ${target}` : ""}…`,
    };
  }
  return {
    home,
    canvas: canvas
      ? {
          title: String(canvas.title ?? "Home").slice(0, 80),
          committedAt: Number(canvas.committedAt) || 0,
        }
      : null,
    devices,
    busy,
    focus,
    lines: lines.slice(-8),
    status: !home
      ? "Home World only shows Home conversations."
      : busy
        ? (focus?.label ?? "Hearth is thinking…")
        : "",
    canDraft: input.canDraft !== false && home,
  };
}

// Device positions (grid units). Unplaced devices get a deterministic spot,
// guessed from names (kitchen light → Kitchen) or spread round-robin.
const ROOM_HINTS = [
  [/kitchen|fridge|oven|coffee/, /kitchen/],
  [/living|lounge|sofa|tv|lamp/, /living|lounge/],
  [/office|desk|study|printer|3d|pc/, /office|study/],
  [/bed|sleep/, /bed/],
  [/hall|door|entry|front/, /hall|entry/],
  [/patio|garden|outdoor|outside|balcony/, /patio|garden|outdoor/],
];
const SLOTS = [
  [0.22, 0.3],
  [0.78, 0.3],
  [0.22, 0.72],
  [0.78, 0.72],
  [0.5, 0.22],
  [0.5, 0.78],
  [0.35, 0.5],
  [0.65, 0.5],
];
export function placeDevices(layout, devices) {
  const counts = new Map();
  let spread = 0;
  return devices.map((device) => {
    let place = layout.devices[device.entityId];
    let room = place && layout.rooms.find((r) => r.id === place.room);
    if (!room) {
      const text =
        `${device.entityId} ${device.name} ${device.section}`.toLowerCase();
      for (const [match, roomName] of ROOM_HINTS)
        if (match.test(text)) {
          room = layout.rooms.find((r) => roomName.test(r.name.toLowerCase()));
          if (room) break;
        }
      room ??= layout.rooms[spread++ % layout.rooms.length];
      const n = counts.get(room.id) ?? 0;
      counts.set(room.id, n + 1);
      const [fx, fy] = SLOTS[n % SLOTS.length];
      place = { room: room.id, fx, fy };
    }
    const margin = 0.6;
    return {
      ...device,
      room: room.id,
      x: room.x + margin + place.fx * (room.w - 2 * margin),
      y: room.y + margin + place.fy * (room.h - 2 * margin),
    };
  });
}
export function placementFor(layout, x, y) {
  const room = roomAt(layout, x, y);
  if (!room) return null;
  const margin = 0.6;
  return {
    room: room.id,
    fx: clamp((x - room.x - margin) / (room.w - 2 * margin), 0, 1),
    fy: clamp((y - room.y - margin) / (room.h - 2 * margin), 0, 1),
  };
}
export const askAbout = (device) =>
  `Read ${device.entityId} now and explain its state. Compare only with observed earlier evidence in this session; do not infer physical effects or call services.`;

// ------------------------------------------------------- walking actors
// A walker follows waypoints in grid units. Reduced motion → it teleports.
export class Walker {
  constructor(x, y, speed) {
    Object.assign(this, {
      x,
      y,
      speed,
      path: [],
      dir: "down",
      moving: false,
      phase: 0,
    });
  }
  goTo(points) {
    if (reducedMotion() && points.length) {
      const last = points[points.length - 1];
      Object.assign(this, { x: last.x, y: last.y, path: [], moving: false });
      return;
    }
    this.path = points.slice();
  }
  step(dt) {
    const next = this.path[0];
    this.moving = !!next;
    if (!next) return false;
    const dx = next.x - this.x,
      dy = next.y - this.y,
      d = Math.hypot(dx, dy),
      move = this.speed * dt;
    if (Math.abs(dx) > Math.abs(dy)) this.dir = dx > 0 ? "right" : "left";
    else if (d > 0.01) this.dir = dy > 0 ? "down" : "up";
    this.phase += dt * 8;
    if (d <= move) {
      this.x = next.x;
      this.y = next.y;
      this.path.shift();
    } else {
      this.x += (dx / d) * move;
      this.y += (dy / d) * move;
    }
    return true;
  }
}
// Shared behaviour for 2D/3D variants: walk to the device being read, think
// in place while busy, otherwise wander a little (no wandering when reduced).
export function createActors(layout) {
  const first = layout.rooms[0];
  const hearth = new Walker(first.x + first.w / 2, first.y + first.h / 2, 3.2);
  const pet = new Walker(hearth.x - 1, hearth.y + 0.6, 3.6);
  let focusKey = "",
    idleTimer = 1.5,
    petTimer = 0;
  return {
    hearth,
    pet,
    tick(dt, world, layout, devices) {
      const target =
        world.focus && devices.find((d) => d.entityId === world.focus.entityId);
      const key = target
        ? `${target.entityId}@${target.x.toFixed(2)},${target.y.toFixed(2)}`
        : "";
      if (key !== focusKey) {
        focusKey = key;
        if (target) {
          const stand = {
            x: target.x,
            y: clamp(target.y + 0.9, 0, GRID.rows - 0.5),
          };
          if (!roomAt(layout, stand.x, stand.y)) stand.y = target.y - 0.9;
          hearth.goTo(planPath(layout, hearth, stand));
        }
      }
      if (!target && !world.busy && !reducedMotion()) {
        idleTimer -= dt;
        if (idleTimer <= 0 && !hearth.path.length) {
          idleTimer = 3 + Math.random() * 4;
          const room =
            Math.random() < 0.25
              ? layout.rooms[Math.floor(Math.random() * layout.rooms.length)]
              : (roomAt(layout, hearth.x, hearth.y) ?? layout.rooms[0]);
          const spot = {
            x: room.x + 0.8 + Math.random() * (room.w - 1.6),
            y: room.y + 0.8 + Math.random() * (room.h - 1.6),
          };
          hearth.goTo(planPath(layout, hearth, spot));
        }
      }
      if (!roomAt(layout, hearth.x, hearth.y) && !hearth.path.length) {
        const room = layout.rooms[0];
        hearth.goTo([{ x: room.x + room.w / 2, y: room.y + room.h / 2 }]);
      }
      hearth.step(dt);
      petTimer -= dt;
      const gap = Math.hypot(pet.x - hearth.x, pet.y - hearth.y);
      if ((gap > 1.6 || (petTimer <= 0 && gap > 1.1)) && !reducedMotion()) {
        petTimer = 0.8;
        const side = hearth.dir === "left" ? 0.9 : -0.9;
        const spot = { x: hearth.x + side, y: hearth.y + 0.5 };
        pet.goTo(
          roomAt(layout, spot.x, spot.y)
            ? planPath(layout, pet, spot)
            : [{ x: hearth.x, y: hearth.y + 0.6 }],
        );
      } else if (reducedMotion()) {
        pet.x = hearth.x - 0.9;
        pet.y = hearth.y + 0.5;
      }
      pet.step(dt);
      return hearth.moving || pet.moving;
    },
  };
}

// -------------------------------------------------------------- edit panel
// One accessible editor shared by every variant; variants add direct
// manipulation (drag devices, tap rooms) on top of it.
export function createEditPanel(ctx, { onDone, title = "Edit home" } = {}) {
  const { store } = ctx;
  let selectedRoom = store.get().rooms[0]?.id ?? "";
  let devices = [];
  const panel = el("section", {
    className: "world-edit",
    attrs: { "aria-label": "Edit home layout (prototype)" },
  });
  const head = el("div", { className: "world-edit-head" });
  const done = button("Done", "world-primary");
  done.addEventListener("click", () => onDone?.());
  head.append(
    el("div", {}, [
      el("strong", { text: title }),
      el("p", {
        className: "world-muted",
        text: "Prototype · saved on this device only",
      }),
    ]),
    done,
  );
  const roomSelect = el("select", { attrs: { "aria-label": "Room" } });
  const add = button("＋ Room", "", "Add room");
  const remove = button("Remove", "", "Remove room");
  const name = el("input", {
    attrs: {
      type: "text",
      maxlength: "24",
      "aria-label": "Room name",
      autocomplete: "off",
    },
  });
  const floor = el("select", { attrs: { "aria-label": "Floor style" } });
  for (const [id, label] of Object.entries(FLOORS)) {
    const option = el("option", { text: label });
    option.value = id;
    floor.append(option);
  }
  const stepper = (label, apply) => {
    const minus = button("−", "world-step", `${label} smaller`);
    const plus = button("＋", "world-step", `${label} larger`);
    const value = el("span", { className: "world-step-value" });
    minus.addEventListener("click", () => apply(-1));
    plus.addEventListener("click", () => apply(1));
    return {
      node: el("div", { className: "world-stepper" }, [
        el("span", { text: label }),
        minus,
        value,
        plus,
      ]),
      value,
    };
  };
  const editRoom = (mutate) =>
    store.update((layout) => {
      const room = layout.rooms.find((r) => r.id === selectedRoom);
      if (room) mutate(room, layout);
    });
  const width = stepper("W", (d) =>
    editRoom((r) => (r.w = clamp(r.w + d, 2, GRID.cols - r.x))),
  );
  const height = stepper("H", (d) =>
    editRoom((r) => (r.h = clamp(r.h + d, 2, GRID.rows - r.y))),
  );
  const move = el("div", {
    className: "world-move",
    attrs: { role: "group", "aria-label": "Move room" },
  });
  for (const [arrow, dx, dy, label] of [
    ["←", -1, 0, "left"],
    ["↑", 0, -1, "up"],
    ["↓", 0, 1, "down"],
    ["→", 1, 0, "right"],
  ]) {
    const b = button(arrow, "world-step", `Move room ${label}`);
    b.addEventListener("click", () =>
      editRoom((r) => {
        r.x = clamp(r.x + dx, 0, GRID.cols - r.w);
        r.y = clamp(r.y + dy, 0, GRID.rows - r.h);
      }),
    );
    move.append(b);
  }
  roomSelect.addEventListener("change", () => select(roomSelect.value));
  name.addEventListener("input", () =>
    editRoom((r) => (r.name = name.value.slice(0, 24) || "Room")),
  );
  floor.addEventListener("change", () =>
    editRoom((r) => (r.floor = floor.value)),
  );
  add.addEventListener("click", () =>
    store.update((layout) => {
      const id = `room-${Date.now().toString(36)}`;
      let spot = { x: 0, y: 0 };
      search: for (let y = 0; y <= GRID.rows - 3; y++)
        for (let x = 0; x <= GRID.cols - 3; x++)
          if (
            ![0, 1, 2].some((i) =>
              [0, 1, 2].some((j) => roomAt(layout, x + i, y + j)),
            )
          ) {
            spot = { x, y };
            break search;
          }
      layout.rooms.push({
        id,
        name: `Room ${layout.rooms.length + 1}`,
        ...spot,
        w: 3,
        h: 3,
        floor: "wood",
      });
      selectedRoom = id;
    }),
  );
  remove.addEventListener("click", () =>
    store.update((layout) => {
      if (layout.rooms.length <= 1) return;
      layout.rooms = layout.rooms.filter((r) => r.id !== selectedRoom);
      selectedRoom = layout.rooms[0].id;
    }),
  );
  const deviceList = el("div", { className: "world-device-list" });
  const swatches = el("div", {
    className: "world-swatches",
    attrs: { role: "radiogroup", "aria-label": "Character colours" },
  });
  PALETTES.forEach((palette, index) => {
    const swatch = button("", "world-swatch", palette.name);
    swatch.dataset.palette = String(index);
    swatch.style.setProperty("--swatch", palette.body);
    swatch.setAttribute("role", "radio");
    swatch.addEventListener("click", () =>
      store.update((l) => (l.character.palette = index)),
    );
    swatches.append(swatch);
  });
  const hat = el("select", { attrs: { "aria-label": "Hat" } });
  for (const [id, label] of Object.entries(HATS)) {
    const option = el("option", { text: label });
    option.value = id;
    hat.append(option);
  }
  hat.addEventListener("change", () =>
    store.update((l) => (l.character.hat = hat.value)),
  );
  const pet = el("input", { attrs: { type: "checkbox" } });
  pet.addEventListener("change", () =>
    store.update((l) => (l.pet = pet.checked)),
  );
  const reset = button("Reset layout", "world-danger");
  reset.addEventListener("click", () => {
    if (window.confirm("Reset the prototype home layout on this device?"))
      store.reset();
  });
  panel.append(
    head,
    el("div", { className: "world-edit-body" }, [
      el("fieldset", {}, [
        el("legend", { text: "Rooms" }),
        el("div", { className: "world-row" }, [roomSelect, add, remove]),
        el("label", { className: "world-field" }, [
          el("span", { text: "Name" }),
          name,
        ]),
        el("label", { className: "world-field" }, [
          el("span", { text: "Floor" }),
          floor,
        ]),
        el("div", { className: "world-row" }, [width.node, height.node]),
        move,
      ]),
      el("fieldset", {}, [
        el("legend", { text: "Devices" }),
        el("p", {
          className: "world-muted",
          text: "Drag devices on the map, or pick a room here.",
        }),
        deviceList,
      ]),
      el("fieldset", {}, [
        el("legend", { text: "Hearth" }),
        swatches,
        el("label", { className: "world-field" }, [
          el("span", { text: "Hat" }),
          hat,
        ]),
        el("label", { className: "world-check" }, [
          pet,
          el("span", { text: "Pet companion" }),
        ]),
      ]),
      reset,
    ]),
  );
  function render() {
    const layout = store.get();
    if (!layout.rooms.some((r) => r.id === selectedRoom))
      selectedRoom = layout.rooms[0].id;
    const room = layout.rooms.find((r) => r.id === selectedRoom);
    roomSelect.replaceChildren(
      ...layout.rooms.map((r) => {
        const option = el("option", { text: r.name });
        option.value = r.id;
        return option;
      }),
    );
    roomSelect.value = selectedRoom;
    if (document.activeElement !== name) name.value = room.name;
    floor.value = room.floor;
    width.value.textContent = String(room.w);
    height.value.textContent = String(room.h);
    remove.disabled = layout.rooms.length <= 1;
    for (const swatch of swatches.children)
      swatch.setAttribute(
        "aria-checked",
        String(Number(swatch.dataset.palette) === layout.character.palette),
      );
    hat.value = layout.character.hat;
    pet.checked = layout.pet;
    const placed = placeDevices(layout, devices);
    deviceList.replaceChildren(
      ...(placed.length
        ? placed.map((device) => {
            const pick = el("select", {
              attrs: { "aria-label": `Room for ${device.name}` },
            });
            for (const r of layout.rooms) {
              const option = el("option", { text: r.name });
              option.value = r.id;
              pick.append(option);
            }
            pick.value = device.room;
            pick.addEventListener("change", () =>
              store.update(
                (l) =>
                  (l.devices[device.entityId] = {
                    room: pick.value,
                    fx: 0.5,
                    fy: 0.5,
                  }),
              ),
            );
            return el("label", { className: "world-field" }, [
              el("span", { text: device.name }),
              pick,
            ]);
          })
        : [
            el("p", {
              className: "world-muted",
              text: "No devices yet — ask Hearth to build a home view first.",
            }),
          ]),
    );
  }
  function select(id) {
    selectedRoom = id;
    ctx.onRoomSelected?.(id);
    render();
  }
  const unsubscribe = store.subscribe(render);
  render();
  return {
    element: panel,
    selectRoom: select,
    selectedRoom: () => selectedRoom,
    setDevices(next) {
      devices = next;
      render();
    },
    destroy: unsubscribe,
  };
}

// ---------------------------------------------------------------- shell
let shell = null;
const hostState = {
  snapshot: null,
  busy: false,
  kind: "home",
  canDraft: true,
  draftQuestion: null,
  buildViewPrompt: BUILD_PROMPT_FALLBACK,
};

function variantFromHash() {
  const match = /^#world=([ABC])$/.exec(window.location.hash);
  return match ? match[1] : null;
}
function measure() {
  if (!shell) return;
  const composer = document.getElementById("composer");
  const feedback = document.getElementById("feedback");
  const main = document.getElementById("main");
  const candidates = [composer];
  if (feedback?.textContent) candidates.push(feedback);
  const tops = candidates
    .filter((n) => n && n.getClientRects().length)
    .map((n) => n.getBoundingClientRect().top)
    .filter((top) => top > 0);
  const viewport = window.innerHeight;
  const top = tops.length ? Math.min(...tops) : viewport;
  const root = document.documentElement;
  root.style.setProperty(
    "--world-bottom",
    `${Math.max(0, viewport - top + 6)}px`,
  );
  root.style.setProperty(
    "--world-left",
    `${Math.max(0, main?.getBoundingClientRect().left ?? 0)}px`,
  );
}
function emit() {
  if (!shell?.variant) return;
  try {
    shell.variant.update(deriveWorld(hostState));
  } catch (error) {
    shell.error.textContent = `Prototype variant failed: ${error?.message ?? error}`;
  }
}
async function show(id) {
  if (!shell) return;
  const index = Math.max(
    0,
    VARIANTS.findIndex((v) => v.id === id),
  );
  const spec = VARIANTS[index];
  shell.index = index;
  shell.label.textContent = `${spec.id} · ${spec.label}`;
  history.replaceState(null, "", `#world=${spec.id}`);
  const token = ++shell.token;
  shell.variant?.destroy();
  shell.variant = null;
  shell.overlay.replaceChildren();
  shell.inline.replaceChildren();
  shell.error.textContent = "";
  document.body.dataset.world = spec.id;
  try {
    const module = await spec.load();
    if (token !== shell?.token) return;
    shell.variant = module.createVariant({
      overlay: shell.overlay,
      inline: shell.inline,
      store: shell.store,
      ask(device) {
        hostState.draftQuestion?.(askAbout(device));
      },
      build() {
        hostState.draftQuestion?.(
          hostState.buildViewPrompt || BUILD_PROMPT_FALLBACK,
        );
      },
    });
    emit();
  } catch (error) {
    if (token === shell?.token)
      shell.error.textContent = `Variant ${spec.id} could not load (${error?.message ?? "error"}). Chat is unaffected.`;
  }
  measure();
}
function step(delta) {
  if (!shell) return;
  const next = (shell.index + delta + VARIANTS.length) % VARIANTS.length;
  void show(VARIANTS[next].id);
}
function onKey(event) {
  if (
    !shell ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    isEditable(event.target)
  )
    return;
  if (document.querySelector("dialog[open]")) return;
  if (event.key === "ArrowLeft") step(-1);
  else if (event.key === "ArrowRight") step(1);
  else if (
    event.key === "Escape" &&
    !document.body.classList.contains("drawer-open")
  )
    closeWorld();
}
function onHash() {
  const id = variantFromHash();
  if (id && shell && VARIANTS[shell.index].id !== id) void show(id);
}
// Public API used by the app.js hook (and by screenshot scripts).
export function openWorld(input = {}) {
  Object.assign(hostState, input);
  if (shell) {
    emit();
    return;
  }
  if (!document.querySelector("link[data-world-css]")) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("./prototype-world.css", import.meta.url).href;
    link.dataset.worldCss = "";
    document.head.append(link);
  }
  const overlay = el("div", {
    className: "world-overlay",
    attrs: { "data-prototype": "home-world" },
  });
  const inline = el("div", {
    className: "world-inline",
    attrs: { "data-prototype": "home-world" },
  });
  const previous = button("◀", "world-nav", "Previous prototype variant");
  const next = button("▶", "world-nav", "Next prototype variant");
  const close = button("✕", "world-nav", "Close Home World");
  const label = el("span", {
    className: "world-switch-label",
    attrs: { "aria-live": "polite" },
  });
  const error = el("p", {
    className: "world-error",
    attrs: { role: "status" },
  });
  const switcher = el(
    "div",
    {
      className: "world-switcher",
      attrs: { role: "toolbar", "aria-label": "Home World prototype variants" },
    },
    [
      el("span", { className: "world-proto-tag", text: "Prototype" }),
      previous,
      label,
      next,
      close,
    ],
  );
  previous.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  close.addEventListener("click", closeWorld);
  const main = document.getElementById("main");
  const anchor = document.getElementById("connection");
  if (main && anchor) anchor.after(inline);
  else document.body.append(inline);
  document.body.append(overlay, switcher, error);
  document.body.classList.add("world-open");
  const resize = new ResizeObserver(measure);
  for (const id of ["composer", "feedback", "main"]) {
    const target = document.getElementById(id);
    if (target) resize.observe(target);
  }
  window.addEventListener("resize", measure);
  window.visualViewport?.addEventListener("resize", measure);
  document.addEventListener("keydown", onKey);
  window.addEventListener("hashchange", onHash);
  shell = {
    overlay,
    inline,
    switcher,
    label,
    error,
    resize,
    store: createStore(),
    variant: null,
    index: 0,
    token: 0,
  };
  measure();
  void show(variantFromHash() ?? "A");
}
export function updateWorld(input = {}) {
  Object.assign(hostState, input);
  if (shell) {
    measure();
    emit();
  }
}
export function closeWorld() {
  if (!shell) return;
  shell.token++;
  shell.variant?.destroy();
  shell.resize.disconnect();
  window.removeEventListener("resize", measure);
  window.visualViewport?.removeEventListener("resize", measure);
  document.removeEventListener("keydown", onKey);
  window.removeEventListener("hashchange", onHash);
  for (const node of [shell.overlay, shell.inline, shell.switcher, shell.error])
    node.remove();
  document.body.classList.remove("world-open");
  delete document.body.dataset.world;
  shell = null;
  history.replaceState(null, "", window.location.pathname);
}
export const worldIsOpen = () => !!shell;
