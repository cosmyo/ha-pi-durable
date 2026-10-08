// Home World v1: registry projection/scope, the registry WebSocket allowlist,
// the deterministic auto layout, the durable customization document
// (concurrency, reset, restart, one-time prototype migration), on/off presses
// through the Home permissions broker, static safety of the browser modules
// and think-mode motion driven only by tool events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";
import { Actions, HAClient, haExtension } from "../src/ha.js";
import { appServer } from "../src/server.js";
import { FULL_ACKNOWLEDGEMENT } from "../src/home-actions.js";
import {
  HA_REGISTRY_LIMITS,
  HA_WEBSOCKET_TYPES,
  HA_WEBSOCKET_URL,
  sendAllowed,
  type SocketFactory,
  type SocketLike,
} from "../src/ha-websocket.js";
import {
  anomalyOf,
  autoLayout,
  deviceKind,
  mergeLayout,
  projectRegistry,
  roomSize,
  validateCustom,
  worldEntities,
  UNAVAILABLE_SETTLE_MS,
  WORLD_GRID,
  WORLD_LIMITS,
} from "../src/world-layout.js";
import { WorldStore } from "../src/world.js";
import { offline } from "./fixtures.js";

const TOKEN = "synthetic-supervisor-token";
const SCOPE = [
  "light.kitchen_ceiling",
  "switch.coffee_maker",
  "sensor.kitchen_temperature",
  "light.living_lamp",
  "media_player.living_tv",
  "binary_sensor.front_door",
  "lock.front_door",
  "sensor.office_printer_progress",
  "climate.bedroom",
  "binary_sensor.bedroom_window",
  "sensor.bathroom_humidity",
  "binary_sensor.garden_motion",
  "sensor.hall_motion_battery",
  "fan.bedroom",
  "vacuum.robot",
  "sun.sun",
  "automation.lights",
];
const REGISTRY = {
  areas: [
    {
      area_id: "kitchen",
      name: "Kitchen",
      floor_id: "ground",
      picture: "/api/image/serve/x",
      aliases: ["cuisine"],
    },
    { area_id: "living_room", name: "Living room", floor_id: "ground" },
    { area_id: "office", name: "Office", floor_id: "upstairs" },
    { area_id: "bedroom", name: `Bedroom ${TOKEN}`, floor_id: "upstairs" },
    { area_id: "bathroom", name: "Bathroom", floor_id: "upstairs" },
    { area_id: "garden", name: "Garden", floor_id: "ground" },
    { area_id: "private_vault", name: "Private vault", floor_id: "ground" },
  ],
  devices: [
    {
      id: "dev_kitchen",
      area_id: "kitchen",
      name: "Kitchen bulb",
      config_entries: ["secret-entry"],
      identifiers: [["hue", "x"]],
    },
    {
      id: "dev_printer",
      area_id: "office",
      name: "Printer",
      name_by_user: "Prusa MK4",
    },
    { id: "dev_vault", area_id: "private_vault", name: "Vault sensor" },
    { id: "dev_tv", area_id: "living_room", name: "TV" },
  ],
  entities: [
    {
      entity_id: "light.kitchen_ceiling",
      device_id: "dev_kitchen",
      area_id: null,
      unique_id: "u1",
      platform: "hue",
    },
    { entity_id: "switch.coffee_maker", area_id: "kitchen" },
    { entity_id: "sensor.kitchen_temperature", area_id: "kitchen" },
    { entity_id: "light.living_lamp", area_id: "living_room" },
    { entity_id: "media_player.living_tv", device_id: "dev_tv" },
    { entity_id: "binary_sensor.front_door", area_id: null },
    { entity_id: "lock.front_door" },
    { entity_id: "sensor.office_printer_progress", device_id: "dev_printer" },
    // Entity area overrides the device's area.
    {
      entity_id: "climate.bedroom",
      area_id: "bedroom",
      device_id: "dev_printer",
    },
    { entity_id: "binary_sensor.bedroom_window", area_id: "bedroom" },
    { entity_id: "sensor.bathroom_humidity", area_id: "bathroom" },
    { entity_id: "binary_sensor.garden_motion", area_id: "garden" },
    { entity_id: "fan.bedroom", area_id: "bedroom" },
    { entity_id: "vacuum.robot", area_id: "ghost_area" },
    // Out of scope: never projected.
    {
      entity_id: "sensor.vault_secret",
      device_id: "dev_vault",
      area_id: "private_vault",
    },
    { entity_id: "camera.private", area_id: "kitchen" },
  ],
};
// Third tuple entry: minutes since last_changed (default 20, well past the
// unavailable settle window) so existing anomaly expectations keep meaning
// "genuinely stuck", not "just read".
const STATES: Record<string, [string, Record<string, unknown>, number?]> = {
  "light.kitchen_ceiling": ["on", { friendly_name: "Kitchen ceiling" }],
  "switch.coffee_maker": ["off", { friendly_name: "Coffee maker" }],
  "sensor.kitchen_temperature": [
    "21.4",
    {
      friendly_name: "Kitchen temperature",
      unit_of_measurement: "°C",
      device_class: "temperature",
    },
  ],
  "light.living_lamp": ["off", { friendly_name: "Living lamp" }],
  "media_player.living_tv": ["unavailable", { friendly_name: "TV" }],
  "binary_sensor.front_door": [
    "on",
    { friendly_name: "Front door", device_class: "door" },
  ],
  "lock.front_door": ["locked", { friendly_name: "Front lock" }],
  "sensor.office_printer_progress": [
    "42",
    { friendly_name: "Printer progress", unit_of_measurement: "%" },
  ],
  "climate.bedroom": ["heat", { friendly_name: "Bedroom heating" }],
  "binary_sensor.bedroom_window": [
    "off",
    { friendly_name: "Bedroom window", device_class: "window" },
  ],
  "sensor.bathroom_humidity": [
    "61",
    {
      friendly_name: "Bathroom humidity",
      unit_of_measurement: "%",
      device_class: "humidity",
    },
  ],
  "binary_sensor.garden_motion": [
    "off",
    {
      friendly_name: `<img src=x onerror=alert(1)> ${TOKEN}`,
      device_class: "motion",
    },
  ],
  "sensor.hall_motion_battery": [
    "12",
    {
      friendly_name: "Hall sensor battery",
      unit_of_measurement: "%",
      device_class: "battery",
    },
  ],
  "fan.bedroom": ["off", { friendly_name: "Bedroom fan" }],
  "vacuum.robot": ["docked", { friendly_name: "Robot" }],
  "sun.sun": ["below_horizon", { friendly_name: "Sun" }],
};

type Frames = Record<string, unknown>[];
function registrySocket(
  frames: Frames,
  registry: { areas: unknown; devices: unknown; entities: unknown } = REGISTRY,
): SocketFactory {
  return (url) => {
    assert.equal(url, HA_WEBSOCKET_URL);
    const socket: SocketLike = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data) {
        const m = JSON.parse(data) as Record<string, unknown>;
        frames.push(m);
        setImmediate(() => {
          if (m.type === "auth")
            return emit({
              type: m.access_token === TOKEN ? "auth_ok" : "auth_invalid",
            });
          const result =
            m.type === "config/area_registry/list"
              ? registry.areas
              : m.type === "config/device_registry/list"
                ? registry.devices
                : m.type === "config/entity_registry/list"
                  ? registry.entities
                  : null;
          emit({ id: m.id, type: "result", success: result !== null, result });
        });
      },
      close() {},
    };
    const emit = (value: unknown) =>
      socket.onmessage?.({ data: JSON.stringify(value) });
    setImmediate(() => emit({ type: "auth_required" }));
    return socket;
  };
}
function fakeWorldHA(
  options: {
    policy?: { enabled: boolean; entities: string[]; services: string[] };
    socket?: SocketFactory;
    states?: typeof STATES;
  } = {},
) {
  const states = Object.fromEntries(
    Object.entries({ ...STATES, ...options.states }).map(([k, v]) => [
      k,
      [v[0], { ...v[1] }, v[2]],
    ]),
  ) as typeof STATES;
  const posts: string[] = [];
  const gets: string[] = [];
  const frames: Frames = [];
  const policy = options.policy ?? {
    enabled: true,
    entities: [...SCOPE],
    services: [
      "light.turn_on",
      "light.turn_off",
      "switch.turn_on",
      "switch.turn_off",
    ],
  };
  const ha = new HAClient(
    TOKEN,
    policy,
    (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace("http://supervisor/core/api/", "");
      if (init?.method === "POST") {
        posts.push(path);
        const entity = JSON.parse(String(init.body)).entity_id;
        states[entity]![0] = path.endsWith("turn_on") ? "on" : "off";
        return Response.json([]);
      }
      gets.push(path);
      if (path === "services")
        return Response.json([
          { domain: "light", services: { turn_on: {}, turn_off: {} } },
          { domain: "switch", services: { turn_on: {}, turn_off: {} } },
        ]);
      const id = decodeURIComponent(path.replace("states/", ""));
      const s = states[id];
      if (!s) return new Response("missing", { status: 404 });
      const lastChanged = new Date(
        Date.now() - (s[2] ?? 20) * 60000,
      ).toISOString();
      return Response.json({
        entity_id: id,
        state: s[0],
        attributes: s[1],
        last_changed: lastChanged,
      });
    }) as typeof fetch,
    [],
    options.socket ?? registrySocket(frames),
  );
  ha.actions.authorizeOwners(["local-admin", "owner", "other"]);
  return { ha, states, posts, gets, frames, policy };
}

test("registry projection keeps only in-scope entities with their area and device names", () => {
  const clean = (s: string) => s.split(TOKEN).join("[REDACTED]");
  const projection = projectRegistry(REGISTRY, SCOPE, clean);
  // Exactly the scope, sorted; nothing from outside it.
  assert.deepEqual(Object.keys(projection.entities), [...SCOPE].sort());
  const json = JSON.stringify(projection);
  for (const leak of [
    "sensor.vault_secret",
    "camera.private",
    "Private vault",
    "Vault sensor",
    "secret-entry",
    "unique_id",
    "picture",
    "/api/image",
    "cuisine",
    TOKEN,
  ])
    assert(!json.includes(leak), `projection leaks ${leak}`);
  // The registry's "platform" is the one hint Home World's anomaly filter
  // needs (to calm groups and mobile_app sensors); it travels this far but
  // no further (never into a room/device sent to the browser, see below).
  assert.deepEqual(projection.entities["light.kitchen_ceiling"], {
    area: "kitchen",
    device: "Kitchen bulb",
    platform: "hue",
  });
  // Entity area wins over its device's area; user device name wins.
  assert.deepEqual(projection.entities["climate.bedroom"], {
    area: "bedroom",
    device: "Prusa MK4",
  });
  assert.equal(
    projection.entities["sensor.office_printer_progress"]!.area,
    "office",
  );
  // Unknown area ids and entities missing from the registry are unassigned.
  assert.equal(projection.entities["vacuum.robot"]!.area, null);
  assert.equal(projection.entities["sensor.hall_motion_battery"]!.area, null);
  assert.deepEqual(
    projection.areas.map((a) => [a.id, a.name, a.level]),
    [
      ["bathroom", "Bathroom", "upstairs"],
      ["bedroom", "Bedroom [REDACTED]", "upstairs"],
      ["garden", "Garden", "ground"],
      ["kitchen", "Kitchen", "ground"],
      ["living_room", "Living room", "ground"],
      ["office", "Office", "upstairs"],
    ],
  );
  for (const area of projection.areas)
    assert.deepEqual(Object.keys(area).sort(), ["id", "level", "name"]);
  // Malformed registry replies fail closed instead of guessing.
  assert.throws(
    () =>
      projectRegistry(
        { ...REGISTRY, entities: { not: "a list" } },
        SCOPE,
        clean,
      ),
    /ha_read_failed/,
  );
  assert.throws(
    () =>
      projectRegistry(
        { ...REGISTRY, areas: Array(WORLD_LIMITS.registryItems + 1).fill({}) },
        SCOPE,
        clean,
      ),
    /ha_read_failed/,
  );
});

test("registry WebSocket reads use only the three list types; every other registry type stays refused", async () => {
  const sent: string[] = [];
  const sink = { send: (d: string) => sent.push(d) };
  for (const type of [
    "config/floor_registry/list",
    "config/label_registry/list",
    "config/area_registry/create",
    "config/area_registry/update",
    "config/area_registry/delete",
    "config/device_registry/update",
    "config/device_registry/remove_config_entry",
    "config/entity_registry/get",
    "config/entity_registry/update",
    "config/entity_registry/remove",
    "config/entity_registry/list_for_display",
    "get_states",
    "call_service",
    "subscribe_entities",
  ])
    assert.throws(
      () => sendAllowed(sink, { type }),
      /ws_type_not_allowed/,
      type,
    );
  assert.equal(sent.length, 0);
  for (const type of [
    "config/area_registry/list",
    "config/device_registry/list",
    "config/entity_registry/list",
  ]) {
    assert((HA_WEBSOCKET_TYPES as readonly string[]).includes(type));
    sendAllowed(sink, { type });
  }
  assert.equal(sent.length, 3);
  assert.equal(HA_REGISTRY_LIMITS.commands, 3);

  const f = fakeWorldHA();
  const projection = await f.ha.registry();
  assert.deepEqual(
    f.frames.map((m) => m.type),
    [
      "auth",
      "config/area_registry/list",
      "config/device_registry/list",
      "config/entity_registry/list",
    ],
  );
  // List commands carry no payload beyond id/type.
  for (const frame of f.frames.slice(1))
    assert.deepEqual(Object.keys(frame).sort(), ["id", "type"]);
  assert.equal(projection.entities["light.living_lamp"]!.area, "living_room");
  assert.equal(f.posts.length, 0);
});

test("auto layout is deterministic, packs areas onto the grid and sheds unassigned entities", () => {
  const projection = projectRegistry(REGISTRY, SCOPE, (s) => s);
  const entities = worldEntities(SCOPE);
  assert(
    !entities.includes("sun.sun") && !entities.includes("automation.lights"),
  );
  const a = autoLayout(projection, entities);
  const b = autoLayout(
    { ...projection, areas: [...projection.areas].reverse() },
    [...entities].reverse(),
  );
  assert.deepEqual(a, b, "input order does not change the house");
  assert.deepEqual(a, autoLayout(projection, entities));
  const ids = a.rooms.map((r) => r.id);
  assert(ids.includes("unassigned"));
  assert.deepEqual(
    a.rooms.find((r) => r.id === "unassigned")!.name,
    "Unassigned",
  );
  assert(!ids.includes("area:private_vault"));
  // Levels (HA floor ids) are separate bands with a label row.
  assert.deepEqual(
    a.levels.map((l) => [l.id, l.name]),
    [
      ["ground", "Ground"],
      ["upstairs", "Upstairs"],
    ],
  );
  for (const room of a.rooms) {
    assert(room.x >= 0 && room.x + room.w <= WORLD_GRID.cols, room.id);
    assert(room.y >= 0 && room.y + room.h <= a.rows, room.id);
    for (const other of a.rooms)
      if (other !== room)
        assert(
          room.x + room.w <= other.x ||
            other.x + other.w <= room.x ||
            room.y + room.h <= other.y ||
            other.y + other.h <= room.y,
          `${room.id} overlaps ${other.id}`,
        );
  }
  const upstairs = a.levels.find((l) => l.id === "upstairs")!;
  for (const room of a.rooms)
    assert.equal(room.y > upstairs.y, room.level === "upstairs", room.id);
  // Floor styles and devices by area.
  const floor = (id: string) => a.rooms.find((r) => r.id === id)!.floor;
  assert.equal(floor("area:garden"), "grass");
  assert.equal(floor("area:kitchen"), "tile");
  assert.equal(floor("area:bedroom"), "carpet");
  assert.equal(floor("unassigned"), "stone");
  const room = (entity: string) =>
    a.devices.find((d) => d.entityId === entity)!.room;
  assert.equal(room("light.kitchen_ceiling"), "area:kitchen");
  assert.equal(room("media_player.living_tv"), "area:living_room");
  assert.equal(room("vacuum.robot"), "unassigned");
  assert.equal(room("lock.front_door"), "unassigned");
  assert.deepEqual(
    a.devices.map((d) => d.entityId),
    [...entities].sort(),
  );
  for (const d of a.devices)
    assert(d.fx >= 0 && d.fx <= 1 && d.fy >= 0 && d.fy <= 1);
  // Bigger areas get bigger rooms before rows are stretched to full width.
  const area = (n: number) => roomSize(n).w * roomSize(n).h;
  assert(area(1) <= area(3) && area(3) <= area(6) && area(6) <= area(15));
  // No registry: everything in the shed; too many areas: overflow to the shed.
  const none = autoLayout(null, entities);
  assert.deepEqual(
    none.rooms.map((r) => r.id),
    ["unassigned"],
  );
  assert.equal(none.devices.length, entities.length);
  const many = Array.from(
    { length: 30 },
    (_, i) => `sensor.s${String(i).padStart(2, "0")}`,
  );
  const crowded = autoLayout(
    {
      areas: many.map((_, i) => ({
        id: `a${i}`,
        name: `Area ${i}`,
        level: "",
      })),
      entities: Object.fromEntries(
        many.map((id, i) => [id, { area: `a${i}`, device: null }]),
      ),
    },
    many,
  );
  assert.equal(crowded.rooms.length, WORLD_LIMITS.rooms);
  assert.equal(crowded.rooms.at(-1)!.id, "unassigned");
  assert.equal(crowded.devices.length, 30);
  assert(crowded.rows <= WORLD_GRID.maxRows);
  assert.deepEqual(autoLayout(null, []).rooms, []);
});

test("device kinds and anomalies follow domain, device class and night", () => {
  assert.equal(deviceKind("sensor.x", "temperature", "x"), "thermo");
  assert.equal(deviceKind("sensor.x", "humidity", "x"), "humidity");
  assert.equal(deviceKind("binary_sensor.x", "door", "x"), "door");
  assert.equal(deviceKind("binary_sensor.x", "window", "x"), "window");
  assert.equal(deviceKind("binary_sensor.x", "motion", "x"), "motion");
  assert.equal(deviceKind("sensor.prusa_progress", "", "Progress"), "printer");
  assert.equal(deviceKind("lock.front", "", "x"), "lock");
  assert.equal(deviceKind("vacuum.robot", "", "x"), "vacuum");
  assert.equal(deviceKind("fan.x", "", "x"), "fan");
  assert.equal(deviceKind("media_player.x", "", "x"), "media");
  assert.equal(anomalyOf("door", "door", "on", true), "open_at_night");
  assert.equal(anomalyOf("door", "door", "on", false), "");
  assert.equal(anomalyOf("battery", "battery", "12", false), "low_battery");
  assert.equal(anomalyOf("battery", "battery", "80", false), "");
  assert.equal(anomalyOf("sensor", "", "21", true), "");
});

test("'unavailable' only glints for a physical device stuck that way, never a fresh blip, a phone or a group", () => {
  const now = 1700000000000;
  // No last_changed hint at all: calm by default, never flagged.
  assert.equal(anomalyOf("light", "", "unavailable", false), "");
  assert.equal(
    anomalyOf("light", "", "unavailable", false, { nowMs: now }),
    "",
  );
  // Just went unavailable (a Wi-Fi blip, a brief HA restart): not yet flagged.
  assert.equal(
    anomalyOf("light", "", "unavailable", false, {
      lastChangedMs: now - 60000,
      nowMs: now,
    }),
    "",
  );
  // Unavailable for the full settle window: a real physical device, flagged.
  assert.equal(
    anomalyOf("light", "", "unavailable", false, {
      lastChangedMs: now - UNAVAILABLE_SETTLE_MS,
      nowMs: now,
    }),
    "unavailable",
  );
  const persistentHints = {
    lastChangedMs: now - UNAVAILABLE_SETTLE_MS - 1,
    nowMs: now,
  };
  // A phone/app sensor (mobile_app) normally goes unavailable when the app
  // is backgrounded: never flagged, no matter how long.
  assert.equal(
    anomalyOf("binary", "", "unavailable", false, {
      ...persistentHints,
      platform: "mobile_app",
    }),
    "",
  );
  // A "group." helper or a Hue entertainment area reads unavailable between
  // member updates by design: never flagged, by registry platform...
  assert.equal(
    anomalyOf("light", "", "unavailable", false, {
      ...persistentHints,
      platform: "group",
    }),
    "",
  );
  // ...or by its live attributes (entity_id list / is_hue_group / hue_type).
  assert.equal(
    anomalyOf("light", "", "unavailable", false, {
      ...persistentHints,
      isGroup: true,
    }),
    "",
  );
  // A diagnostic/hidden/disabled entity never even reaches anomalyOf: it is
  // filtered out of the drawn set by worldEntities before any state read.
});

test("customization validation is strict and merge never returns out-of-scope entities", () => {
  const clean = (s: string) => s;
  const ok = {
    rooms: {
      "area:kitchen": {
        name: "Cosy kitchen",
        x: 0,
        y: 1,
        w: 6,
        h: 4,
        floor: "wood",
      },
    },
    devices: {
      "light.kitchen_ceiling": { room: "area:kitchen", fx: 0.25, fy: 0.75 },
    },
    character: { palette: 2, hat: "crown" },
    pet: false,
  };
  assert.deepEqual(
    validateCustom(ok, SCOPE, clean).rooms["area:kitchen"]!.name,
    "Cosy kitchen",
  );
  const bad: unknown[] = [
    null,
    [],
    { ...ok, extra: 1 },
    { ...ok, pet: "yes" },
    { ...ok, rooms: { "<img>": ok.rooms["area:kitchen"] } },
    {
      ...ok,
      rooms: { "area:kitchen": { ...ok.rooms["area:kitchen"], w: 99 } },
    },
    {
      ...ok,
      rooms: { "area:kitchen": { ...ok.rooms["area:kitchen"], x: 15 } },
    },
    {
      ...ok,
      rooms: { "area:kitchen": { ...ok.rooms["area:kitchen"], floor: "lava" } },
    },
    {
      ...ok,
      rooms: {
        "area:kitchen": { ...ok.rooms["area:kitchen"], name: "a\u0007b" },
      },
    },
    {
      ...ok,
      rooms: { "area:kitchen": { ...ok.rooms["area:kitchen"], style: "x" } },
    },
    {
      ...ok,
      devices: {
        "light.kitchen_ceiling": { room: "area:kitchen", fx: 2, fy: 0 },
      },
    },
    {
      ...ok,
      devices: JSON.parse(
        '{"__proto__": {"room": "area:kitchen", "fx": 0, "fy": 0}}',
      ),
    },
    { ...ok, character: { palette: 9, hat: "crown" } },
    { ...ok, character: { palette: 1, hat: "<script>" } },
  ];
  for (const value of bad)
    assert.throws(
      () => validateCustom(value, SCOPE, clean),
      /invalid/,
      JSON.stringify(value),
    );
  assert.throws(
    () =>
      validateCustom(
        {
          ...ok,
          devices: {
            "sensor.vault_secret": { room: "area:kitchen", fx: 0, fy: 0 },
          },
        },
        SCOPE,
        clean,
      ),
    /entity_not_allowed/,
  );
  const projection = projectRegistry(REGISTRY, SCOPE, clean);
  const auto = autoLayout(projection, worldEntities(SCOPE));
  const custom = validateCustom(ok, SCOPE, clean);
  const merged = mergeLayout(auto, custom, SCOPE);
  const kitchen = merged.rooms.find((r) => r.id === "area:kitchen")!;
  assert.deepEqual(
    [kitchen.name, kitchen.area, kitchen.floor],
    ["Cosy kitchen", "Kitchen", "wood"],
  );
  assert.deepEqual(merged.character, { palette: 2, hat: "crown" });
  assert.equal(merged.pet, false);
  assert.equal(
    merged.devices.find((d) => d.entityId === "light.kitchen_ceiling")!.moved,
    true,
  );
  // Scope shrinks: the stored override for a removed entity is not returned.
  const smaller = SCOPE.filter((e) => e !== "light.kitchen_ceiling");
  const shrunk = mergeLayout(
    autoLayout(projection, worldEntities(smaller)),
    custom,
    smaller,
  );
  assert(!JSON.stringify(shrunk).includes("light.kitchen_ceiling"));
});

async function worldServer(f = fakeWorldHA()) {
  const dir = await mkdtemp(join(tmpdir(), "hearth-world-"));
  const provider = offline();
  const cfg = {
    mode: "local" as const,
    host: "127.0.0.1",
    port: 8099,
    origin: "http://127.0.0.1:8099",
    password: "synthetic-local-password-0001",
    authorizedUsers: [],
    dataDir: dir,
    provider: "offline" as const,
    model: "test",
    policy: f.policy,
    haToken: TOKEN,
    apiKey: "synthetic-provider-key",
  };
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(f.ha)],
    [],
    undefined,
    f.ha.actions,
  );
  const app = appServer(cfg, runtime, new Actions(runtime, f.ha));
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  cfg.origin = base;
  const authorization = `Basic ${Buffer.from(`hearth:${cfg.password}`).toString("base64")}`;
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { authorization } });
  const boot = await get("/api/bootstrap");
  const csrf = (await boot.json()).csrf;
  const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
  const post = (
    path: string,
    value: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization,
        cookie,
        origin: base,
        "x-hearth-csrf": csrf,
        "content-type": "application/json",
        ...extra,
      },
      body: typeof value === "string" ? value : JSON.stringify(value),
    });
  return {
    f,
    runtime,
    base,
    get,
    post,
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("Home World HTTP: authenticated structure and values, scoped and redacted, static modules only", async () => {
  const s = await worldServer();
  try {
    for (const path of [
      "/api/world",
      "/api/world/values",
      "/world/world.js",
      "/world/house.js",
      "/world/strip.js",
      "/world/world.css",
    ])
      assert.equal((await fetch(`${s.base}${path}`)).status, 401, path);
    for (const [path, type] of [
      ["/world/world.js", "text/javascript"],
      ["/world/house.js", "text/javascript"],
      ["/world/strip.js", "text/javascript"],
      ["/world/world.css", "text/css"],
    ] as const) {
      const response = await s.get(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("content-type"), type);
      assert.match(
        response.headers.get("content-security-policy")!,
        /script-src 'self'; style-src 'self'/,
      );
      await response.arrayBuffer();
    }
    // The prototype, its switcher and the vendored three.js are gone.
    for (const path of [
      "/world/prototype-world.js",
      "/world/world-pixel.js",
      "/world/world-diorama.js",
      "/world/world-ambient.js",
      "/world/prototype-world.css",
      "/vendor/three/three.module.js",
      "/vendor/three/three.core.js",
      "/world/",
    ])
      assert.equal((await s.get(path)).status, 404, path);
    const structure = await (await s.get("/api/world")).json();
    assert.equal(structure.registry, "ok");
    assert.equal(structure.revision, 0);
    assert.equal(structure.customized, false);
    assert(structure.rooms.some((r: { name: string }) => r.name === "Kitchen"));
    assert.deepEqual(
      structure.devices.map((d: { entityId: string }) => d.entityId),
      worldEntities(SCOPE),
    );
    const text = JSON.stringify(structure);
    for (const leak of [
      "vault",
      "camera.private",
      TOKEN,
      "secret-entry",
      "unique_id",
      "sun.sun",
      "automation.",
      // The registry platform hint (e.g. "hue") used to calm the anomaly
      // list never leaves the registry projection into a client response.
      "hue",
      "platform",
    ])
      assert(!text.includes(leak), `structure leaks ${leak}`);
    // The registry is cached: a second structure read opens no socket.
    const sockets = s.f.frames.filter((m) => m.type === "auth").length;
    await (await s.get("/api/world")).json();
    assert.equal(s.f.frames.filter((m) => m.type === "auth").length, sockets);
    const values = await (await s.get("/api/world/values")).json();
    assert.equal(values.night, true);
    assert.equal(values.nightSource, "sun");
    assert.equal(values.values["sensor.kitchen_temperature"].kind, "thermo");
    assert.equal(values.values["sensor.kitchen_temperature"].unit, "°C");
    assert.equal(
      values.values["binary_sensor.front_door"].anomaly,
      "open_at_night",
    );
    assert.equal(
      values.values["media_player.living_tv"].anomaly,
      "unavailable",
    );
    assert.equal(
      values.values["sensor.hall_motion_battery"].anomaly,
      "low_battery",
    );
    assert.equal(
      values.values["sensor.office_printer_progress"].kind,
      "printer",
    );
    assert(values.values["light.kitchen_ceiling"].observedAt > 0);
    // Controls only for light/switch; lock and others stay read-only.
    assert.deepEqual(Object.keys(values.controls).sort(), [
      "light.kitchen_ceiling",
      "light.living_lamp",
      "switch.coffee_maker",
    ]);
    assert(!JSON.stringify(values).includes(TOKEN));
    assert(!JSON.stringify(values).includes("sun.sun"));
    assert(!s.f.gets.some((g) => /vault|camera/.test(g)));
    assert.equal(s.f.posts.length, 0);
  } finally {
    await s.close();
  }
});

test("Home World customization persists per owner with optimistic concurrency, reset and restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-world-doc-"));
  const provider = offline();
  const f = fakeWorldHA();
  let runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(f.ha)],
    [],
    undefined,
    f.ha.actions,
  );
  try {
    let store = new WorldStore(runtime, f.ha);
    const first = await store.get("owner");
    assert.equal(first.revision, 0);
    const kitchen = first.rooms.find((r) => r.id === "area:kitchen")!;
    const layout = {
      rooms: {
        [kitchen.id]: {
          name: "Galley",
          x: kitchen.x,
          y: kitchen.y,
          w: kitchen.w,
          h: kitchen.h,
          floor: "stone",
        },
      },
      devices: {
        "switch.coffee_maker": { room: "area:living_room", fx: 0.5, fy: 0.5 },
      },
      character: { palette: 3, hat: "cap" },
      pet: false,
    };
    const saved = await store.save("owner", { baseRevision: 0, layout });
    assert.equal(saved.revision, 1);
    assert.equal(saved.customized, true);
    assert.equal(saved.rooms.find((r) => r.id === kitchen.id)!.name, "Galley");
    assert.equal(
      saved.devices.find((d) => d.entityId === "switch.coffee_maker")!.room,
      "area:living_room",
    );
    // A stale writer is refused and nothing changes.
    await assert.rejects(
      store.save("owner", {
        baseRevision: 0,
        layout: { ...layout, pet: true },
      }),
      /world_layout_conflict/,
    );
    await assert.rejects(
      store.save("owner", { baseRevision: 1, layout: { ...layout, extra: 1 } }),
      /invalid/,
    );
    await assert.rejects(store.save("owner", { baseRevision: 1 }), /invalid/);
    // Per owner: another owner still sees the auto layout.
    assert.equal((await store.get("other")).customized, false);
    // Restart: the document survives.
    await runtime.close();
    // A restarted controller has a fresh HA client (actions attach once).
    const g = fakeWorldHA();
    runtime = await Runtime.open(
      dir,
      provider.models,
      provider.model,
      [haExtension(g.ha)],
      [],
      undefined,
      g.ha.actions,
    );
    store = new WorldStore(runtime, g.ha);
    const reopened = await store.get("owner");
    assert.equal(reopened.revision, 1);
    assert.equal(reopened.pet, false);
    assert.deepEqual(reopened.character, { palette: 3, hat: "cap" });
    await assert.rejects(
      store.reset("owner", { baseRevision: 0 }),
      /world_layout_conflict/,
    );
    const reset = await store.reset("owner", { baseRevision: 1 });
    assert.equal(reset.revision, 2);
    assert.equal(reset.customized, false);
    assert.equal(reset.custom, null);
    assert.equal(reset.rooms.find((r) => r.id === kitchen.id)!.name, "Kitchen");
    assert.equal(reset.pet, true);

    // One-time prototype migration: strict, then refused.
    const prototype = {
      version: 1,
      rooms: [
        {
          id: "kitchen",
          name: "Kitchen",
          x: 7,
          y: 0,
          w: 5,
          h: 6,
          floor: "carpet",
        },
        { id: "patio", name: "Patio", x: 11, y: 6, w: 5, h: 6, floor: "grass" },
      ],
      devices: {
        "light.kitchen_ceiling": { room: "kitchen", fx: 0.2, fy: 0.3 },
      },
      character: { palette: 1, hat: "bow" },
      pet: false,
    };
    await assert.rejects(
      store.migrate("third", {
        layout: { ...prototype, rooms: [{ id: "<x>", name: "x" }] },
      }),
      /invalid_prototype_layout/,
    );
    await assert.rejects(
      store.migrate("third", { layout: { ...prototype, version: 2 } }),
      /invalid_prototype_layout/,
    );
    await assert.rejects(
      store.migrate("third", { layout: { ...prototype, extra: true } }),
      /invalid_prototype_layout/,
    );
    const migrated = await store.migrate("third", { layout: prototype });
    assert.equal(migrated.migrated, true);
    assert.equal(
      migrated.rooms.find((r) => r.id === "area:kitchen")!.floor,
      "carpet",
    );
    assert.deepEqual(migrated.character, { palette: 1, hat: "bow" });
    const light = migrated.devices.find(
      (d) => d.entityId === "light.kitchen_ceiling",
    )!;
    assert.deepEqual(
      [light.room, light.fx, light.fy],
      ["area:kitchen", 0.2, 0.3],
    );
    await assert.rejects(
      store.migrate("third", { layout: prototype }),
      /world_already_customized/,
    );
    // The owner who customized cannot import over their layout either.
    await store.save("owner", { baseRevision: 2, layout });
    await assert.rejects(
      store.migrate("owner", { layout: prototype }),
      /world_already_customized/,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Home World toggles go through the Home permissions broker: Read-only, Ask and Full", async () => {
  const s = await worldServer();
  try {
    const id = (
      await (
        await s.post("/api/sessions", {
          title: "Home",
          requestId: "world-http-1",
        })
      ).json()
    ).id;
    const press = (entityId: string, sessionId = id) =>
      s.post("/api/world/actions", { entityId, sessionId });
    const setMode = async (mode: "read-only" | "ask" | "full") => {
      const p = await s.f.ha.actions.settings("local-admin");
      await s.f.ha.actions.setMode(
        "local-admin",
        mode,
        p.revision,
        p.policy,
        mode === "full" ? FULL_ACKNOWLEDGEMENT : undefined,
      );
    };
    // CSRF/Origin like every mutation.
    assert.equal(
      (
        await s.post(
          "/api/world/actions",
          { entityId: "light.living_lamp", sessionId: id },
          { origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await s.post("/api/world/actions", {
          entityId: "light.living_lamp",
          sessionId: id,
          extra: 1,
        })
      ).status,
      400,
    );
    // Read-only: refused before any HA write.
    await setMode("read-only");
    const ro = await press("light.living_lamp");
    assert.equal(ro.status, 403);
    assert.equal((await ro.json()).error, "home_read_only");
    const roValues = await (await s.get("/api/world/values")).json();
    assert.equal(roValues.controls["light.living_lamp"].enabled, false);
    assert.match(roValues.controls["light.living_lamp"].reason, /Read-only/);
    // Not a toggleable device / not drawn / not in scope.
    await setMode("ask");
    assert.equal((await press("lock.front_door")).status, 403);
    assert.equal((await press("sensor.vault_secret")).status, 404);
    assert.equal((await press("light.living_lamp", 999)).status, 404);
    // Ask: an exact pending proposal with a world origin, decided by a human.
    const asked = await (await press("light.living_lamp")).json();
    assert.equal(asked.proposal.status, "pending");
    assert.deepEqual(asked.proposal.action, {
      service: "light.turn_on",
      entityId: "light.living_lamp",
      data: {},
    });
    assert.deepEqual(s.f.posts, []);
    const snapshot = await (await s.get(`/api/sessions/${id}/snapshot`)).json();
    assert.deepEqual(snapshot.proposals[asked.proposal.id].origin, {
      kind: "world",
      entityId: "light.living_lamp",
    });
    assert.equal(
      (
        await s.post(`/api/sessions/${id}/actions`, {
          id: asked.proposal.id,
          hash: asked.proposal.hash,
          decision: "approve",
        })
      ).status,
      200,
    );
    assert.deepEqual(s.f.posts, ["services/light/turn_on"]);
    // Full: dispatched once within the grant, read back.
    await setMode("full");
    const full = await (await press("switch.coffee_maker")).json();
    assert.equal(full.proposal.status, "accepted");
    // A person pressed it: human-authorized under the Full grant's binding.
    assert.equal(full.proposal.authorization.source, "human");
    assert.equal(full.proposal.authorization.mode, "full");
    assert.equal(full.readBack.state, "on");
    assert.deepEqual(s.f.posts, [
      "services/light/turn_on",
      "services/switch/turn_on",
    ]);
    // Unknown state never toggles.
    s.f.states["light.kitchen_ceiling"]![0] = "unavailable";
    const unknown = await press("light.kitchen_ceiling");
    assert.equal(unknown.status, 409);
    assert.equal((await unknown.json()).error, "toggle_state_unknown");
    assert.equal(s.f.posts.length, 2);
  } finally {
    await s.close();
  }
});

test("Home World layout routes: bounded bodies, CSRF, conflicts and migration over HTTP", async () => {
  const s = await worldServer();
  try {
    const structure = await (await s.get("/api/world")).json();
    const layout = {
      rooms: {},
      devices: {},
      character: { palette: 1, hat: "none" },
      pet: true,
    };
    assert.equal(
      (
        await s.post(
          "/api/world/layout",
          { baseRevision: 0, layout },
          { "x-hearth-csrf": "forged" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await s.post("/api/world/layout", "x".repeat(40000))).status,
      413,
    );
    const saved = await s.post("/api/world/layout", {
      baseRevision: structure.revision,
      layout,
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).revision, 1);
    const stale = await s.post("/api/world/layout", {
      baseRevision: 0,
      layout,
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "world_layout_conflict");
    const migrate = await s.post("/api/world/migrate", {
      layout: { version: 1 },
    });
    assert.equal(migrate.status, 400);
    assert.equal((await migrate.json()).error, "invalid_prototype_layout");
    assert.equal(
      (await s.post("/api/world/reset", { baseRevision: 1 })).status,
      200,
    );
    assert.equal((await s.post("/api/world/unknown", {})).status, 404);
  } finally {
    await s.close();
  }
});

test("Home World without a readable registry still builds: everything in the Unassigned shed", async () => {
  const failing: SocketFactory = () => {
    throw new Error("no socket");
  };
  const f = fakeWorldHA({ socket: failing });
  const dir = await mkdtemp(join(tmpdir(), "hearth-world-noreg-"));
  const provider = offline();
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(f.ha)],
    [],
    undefined,
    f.ha.actions,
  );
  try {
    const world = await new WorldStore(runtime, f.ha).get("owner");
    assert.equal(world.registry, "unavailable");
    assert.deepEqual(
      world.rooms.map((r) => r.id),
      ["unassigned"],
    );
    assert.equal(world.devices.length, worldEntities(SCOPE).length);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const WORLD_MODULES = ["world/world.js", "world/house.js", "world/strip.js"];
test("Home World browser modules render text safely and make no requests of their own", async () => {
  for (const file of WORLD_MODULES) {
    const source = await readFile(
      new URL(`../public/${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|document\.write|setAttribute\(\s*["']on/,
      file,
    );
    // Network access only through the helpers app.js passes in (host.api.*).
    assert.doesNotMatch(
      source,
      /fetch\(|XMLHttpRequest|EventSource|WebSocket|sendBeacon|api\//,
      file,
    );
    assert.doesNotMatch(source, /PROTOTYPE variant|three|world-diorama/i, file);
  }
  const app = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  assert.match(app, /import\("\.\/world\/world\.js"\)/);
  for (const route of [
    'api("world")',
    'api("world/values")',
    'api("world/layout"',
    'api("world/reset"',
    'api("world/migrate"',
    'api("world/actions"',
  ])
    assert(app.includes(route), route);
  assert.doesNotMatch(app, /#world=|prototype-world/);
  const html = await readFile(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(html, /Prototype/);
});

test("think mode moves the avatar only for tool events naming a drawn device", async () => {
  const world = await import(
    new URL("../public/world/world.js", import.meta.url).href
  );
  const devices = [
    { entityId: "light.kitchen", room: "area:kitchen", x: 3, y: 2 },
    { entityId: "sensor.office", room: "area:office", x: 12, y: 2 },
  ];
  const snapshot = (
    live: unknown,
    args: Record<string, unknown> = { entityId: "light.kitchen" },
  ) => ({
    view: {
      entries: [
        {
          model: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call-1",
                  name: "ha_state_detail",
                  arguments: args,
                },
              ],
            },
          ],
        },
      ],
      docs: { "pi.live": live },
    },
  });
  const running = {
    run: { taskId: "t", inputs: [] },
    tools: [{ callId: "call-1", name: "ha_state_detail", status: "running" }],
  };
  // Derivation: only pi.live with a running/pending call; workspace never.
  assert.deepEqual(world.deriveThink(snapshot({}), "home"), {
    busy: false,
    callId: "",
    tool: "",
    entityId: "",
  });
  assert.equal(world.deriveThink(snapshot(running), "workspace").busy, false);
  assert.deepEqual(world.deriveThink(snapshot(running), "home"), {
    busy: true,
    callId: "call-1",
    tool: "ha_state_detail",
    entityId: "light.kitchen",
  });
  assert.equal(
    world.deriveThink(snapshot({ run: { taskId: "t", inputs: [] } }), "home")
      .entityId,
    "",
  );
  assert.equal(
    world.deriveThink(snapshot(running, { query: "kitchen" }), "home").entityId,
    "",
  );
  const think = world.deriveThink(snapshot(running), "home");
  assert.equal(
    world.thinkLabel(think, { name: "Kitchen light" }, "Kitchen"),
    "Reading Kitchen light · Kitchen…",
  );

  const actor = world.createThinkActor({
    motion: true,
    target: (d: { x: number; y: number }) => ({ x: d.x, y: d.y + 1 }),
    path: (_from: unknown, to: unknown) => [to],
  });
  actor.place({ x: 10, y: 5 });
  // Idle snapshots, busy-without-tool and tools without entityId never walk.
  for (const idle of [
    world.deriveThink(snapshot({}), "home"),
    world.deriveThink(snapshot({ run: { taskId: "t", inputs: [] } }), "home"),
    world.deriveThink(snapshot(running, { query: "kitchen" }), "home"),
    {
      busy: true,
      callId: "x",
      tool: "ha_state_detail",
      entityId: "light.not_drawn",
    },
  ]) {
    assert.equal(actor.follow(idle, devices), false);
    assert.equal(actor.moving, false);
    assert.equal(actor.step(0.1), false);
  }
  assert.deepEqual([actor.hearth.x, actor.hearth.y], [10, 5]);
  // A real tool event starts one walk; repeating the same event does not.
  assert.equal(actor.follow(think, devices), true);
  assert.equal(actor.moving, true);
  assert.equal(actor.follow(think, devices), false);
  let frames = 0;
  while (actor.step(1 / 30) && frames < 1000) frames++;
  assert(frames > 0 && frames < 1000);
  assert.equal(actor.moving, false);
  assert.deepEqual([actor.hearth.x, actor.hearth.y], [3, 3]);
  // Reduced motion: no walking; the avatar is simply there.
  const still = world.createThinkActor({
    motion: false,
    target: (d: { x: number; y: number }) => ({ x: d.x, y: d.y }),
    path: (_from: unknown, to: unknown) => [to],
  });
  still.place({ x: 0, y: 0 });
  assert.equal(still.follow(think, devices), false);
  assert.equal(still.moving, false);
  assert.deepEqual([still.hearth.x, still.hearth.y], [3, 2]);

  // Render loop: idle → one frame per invalidate, nothing after; animation
  // frames continue only while render() reports motion; 30 fps cap; hidden →
  // nothing.
  const queue: ((t: number) => void)[] = [];
  let hidden = false;
  let moving = 0;
  let draws = 0;
  const loop = world.createRenderLoop(
    () => {
      draws++;
      return moving-- > 0;
    },
    {
      raf: (fn: (t: number) => void) => queue.push(fn),
      cancel: () => {},
      hidden: () => hidden,
    },
  );
  let clock = 0;
  const tick = (ms: number) => {
    clock += ms;
    const fn = queue.shift();
    fn?.(clock);
  };
  assert.equal(queue.length, 0, "no frames until asked");
  loop.invalidate();
  assert.equal(queue.length, 1);
  tick(16);
  assert.equal(draws, 1);
  assert.equal(queue.length, 0, "idle after a static redraw");
  moving = 3;
  loop.animate();
  for (let i = 0; i < 40 && queue.length; i++) tick(16);
  assert.equal(queue.length, 0, "stops when motion ends");
  assert(draws >= 4 && draws <= 6, `capped frames: ${draws}`);
  hidden = true;
  loop.invalidate();
  assert.equal(queue.length, 0, "hidden pages request no frames");
  hidden = false;
  loop.stop();
  loop.invalidate();
  assert.equal(queue.length, 0);
});

test("house dialogue shows plain speech, not raw markdown", async () => {
  const world = await import(
    new URL("../public/world/world.js", import.meta.url).href
  );
  assert.equal(
    world.plainSpeech(
      "## Status\nThe study fan currently reports **off** in `Home Assistant`.\n\n- see [docs](https://example.invalid)",
    ),
    "Status\nThe study fan currently reports off in Home Assistant.\nsee docs",
  );
  assert.equal(world.plainSpeech("2 * 3 * 4 stays"), "2 * 3 * 4 stays");
  const lines = world.recentLines({
    view: {
      entries: [
        {
          model: [
            {
              role: "assistant",
              content: [{ type: "text", text: "It is **on**." }],
            },
          ],
        },
      ],
    },
  });
  assert.deepEqual(lines, [{ who: "Hearth", text: "It is on." }]);
});

test("drawn devices are picked fairly per room, most telling first", () => {
  const sensors = Array.from(
    { length: 90 },
    (_, i) => `sensor.busy_${String(i).padStart(2, "0")}`,
  );
  const phones = Array.from(
    { length: 20 },
    (_, i) => `binary_sensor.phone_${i}`,
  );
  const scope = [
    ...sensors,
    ...phones,
    "light.busy_lamp",
    "light.quiet_lamp",
    "climate.quiet_ac",
    "sensor.quiet_firmware",
    "switch.hidden_plug",
  ];
  const entities: Record<
    string,
    { area: string | null; device: null; secondary?: boolean }
  > = {};
  for (const id of sensors) entities[id] = { area: "busy", device: null };
  for (const id of phones) entities[id] = { area: null, device: null };
  entities["light.busy_lamp"] = { area: "busy", device: null };
  entities["light.quiet_lamp"] = { area: "quiet", device: null };
  entities["climate.quiet_ac"] = { area: "quiet", device: null };
  entities["sensor.quiet_firmware"] = {
    area: "quiet",
    device: null,
    secondary: true,
  };
  entities["switch.hidden_plug"] = {
    area: "quiet",
    device: null,
    secondary: true,
  };
  const projection = {
    areas: [
      { id: "busy", name: "Busy", level: "" },
      { id: "quiet", name: "Quiet", level: "" },
    ],
    entities,
  };
  const drawn = worldEntities(scope, projection);
  assert.equal(drawn.length, WORLD_LIMITS.devices);
  assert.deepEqual(drawn, [...drawn].sort());
  for (const id of ["light.busy_lamp", "light.quiet_lamp", "climate.quiet_ac"])
    assert.ok(drawn.includes(id), id);
  assert.ok(!drawn.includes("sensor.quiet_firmware"));
  assert.ok(!drawn.includes("switch.hidden_plug"));
  assert.equal(
    drawn.filter((id) => id.startsWith("binary_sensor.phone_")).length,
    8,
  );
  // Without the registry: the previous bounded alphabetical set.
  assert.deepEqual(
    worldEntities(scope),
    [...new Set(scope)].sort().slice(0, 64),
  );
});

test("registry projection marks diagnostic, config, hidden and disabled entities", () => {
  const projection = projectRegistry(
    {
      areas: [{ area_id: "office", name: "Office" }],
      devices: [],
      entities: [
        { entity_id: "light.desk", area_id: "office" },
        {
          entity_id: "sensor.fw",
          area_id: "office",
          entity_category: "diagnostic",
        },
        {
          entity_id: "switch.led",
          area_id: "office",
          entity_category: "config",
        },
        { entity_id: "light.old", area_id: "office", hidden_by: "user" },
        {
          entity_id: "light.off",
          area_id: "office",
          disabled_by: "integration",
        },
      ],
    },
    ["light.desk", "sensor.fw", "switch.led", "light.old", "light.off"],
    (s) => s,
  );
  assert.equal(projection.entities["light.desk"]!.secondary, undefined);
  for (const id of ["sensor.fw", "switch.led", "light.old", "light.off"])
    assert.equal(projection.entities[id]!.secondary, true, id);
});

test("Needs a look end to end: a phone sensor and a Hue entertainment group never glint, a stuck lounge light does", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-world-calm-"));
  const provider = offline();
  // A synthetic lounge: a Hue "All Lights" entertainment group (platform
  // "hue" plus is_hue_group), a phone's own Focus sensor (platform
  // "mobile_app") and one genuinely stuck physical lamp.
  const registry = {
    areas: [{ area_id: "lounge", name: "Lounge", floor_id: "ground" }],
    devices: [],
    entities: [
      {
        entity_id: "light.lounge_entertainment",
        area_id: "lounge",
        platform: "hue",
      },
      { entity_id: "binary_sensor.phone_focus", platform: "mobile_app" },
      { entity_id: "light.lounge_lamp", area_id: "lounge" },
    ],
  };
  const scope = [
    "light.lounge_entertainment",
    "binary_sensor.phone_focus",
    "light.lounge_lamp",
  ];
  const f = fakeWorldHA({
    policy: { enabled: true, entities: scope, services: [] },
    socket: registrySocket([], registry),
    states: {
      "light.lounge_entertainment": [
        "unavailable",
        { friendly_name: "All Lights", is_hue_group: true },
        1000,
      ],
      "binary_sensor.phone_focus": [
        "unavailable",
        { friendly_name: "Focus" },
        1000,
      ],
      "light.lounge_lamp": ["unavailable", { friendly_name: "Lamp" }, 1000],
    },
  });
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(f.ha)],
    [],
    undefined,
    f.ha.actions,
  );
  try {
    const store = new WorldStore(runtime, f.ha);
    const values = await store.values("owner");
    assert.equal(values.values["light.lounge_entertainment"]!.anomaly, "");
    assert.equal(values.values["binary_sensor.phone_focus"]!.anomaly, "");
    assert.equal(values.values["light.lounge_lamp"]!.anomaly, "unavailable");
    // A fresh blip (well within the settle window) never glints either, on
    // the very same device: only how long it has been unavailable changed.
    f.states["light.lounge_lamp"]![2] = 1;
    const freshValues = await store.values("owner");
    assert.equal(freshValues.values["light.lounge_lamp"]!.anomaly, "");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an owner floor plan may widen the grid and add decor spaces", () => {
  const scope = ["light.desk", "light.sofa"];
  const projection = {
    areas: [
      { id: "office", name: "Office", level: "" },
      { id: "living", name: "Living", level: "" },
    ],
    entities: {
      "light.desk": { area: "office", device: null },
      "light.sofa": { area: "living", device: null },
    },
  };
  const auto = autoLayout(projection, scope);
  const clean = (s: string) => s;
  const plan = {
    cols: 32,
    rooms: {
      "area:office": {
        name: "Office",
        x: 0,
        y: 2,
        w: 7,
        h: 8,
        floor: "carpet",
      },
      "area:living": {
        name: "Living",
        x: 7,
        y: 2,
        w: 25,
        h: 12,
        floor: "wood",
      },
      "decor:balcony": {
        name: "Balcony",
        x: 6,
        y: 0,
        w: 20,
        h: 2,
        floor: "wood",
      },
    },
    devices: { "light.desk": { room: "decor:balcony", fx: 0.5, fy: 0.5 } },
    character: { palette: 0, hat: "none" },
    pet: true,
  };
  const custom = validateCustom(plan, scope, clean);
  assert.equal(custom.cols, 32);
  const merged = mergeLayout(auto, custom, scope);
  assert.deepEqual(merged.grid, { cols: 32, rows: 14 });
  const balcony = merged.rooms.find((r) => r.id === "decor:balcony")!;
  assert.equal(balcony.decor, true);
  assert.equal(balcony.area, null);
  assert.deepEqual([balcony.x, balcony.y, balcony.w, balcony.h], [6, 0, 20, 2]);
  assert.equal(
    merged.devices.find((d) => d.entityId === "light.desk")!.room,
    "decor:balcony",
  );
  assert.equal(merged.custom!.cols, 32);
  assert.ok(merged.custom!.rooms["decor:balcony"]);
  // The default grid stays 16 wide and is not written back.
  const plain = validateCustom(
    { ...plan, cols: undefined, rooms: {} },
    scope,
    clean,
  );
  assert.equal("cols" in plain, false);
  assert.equal(mergeLayout(auto, plain, scope).grid.cols, WORLD_GRID.cols);
  // Bounds: grid width, room inside the grid, decor ids and count.
  const refuse = (layout: unknown) =>
    assert.throws(
      () => validateCustom(layout, scope, clean),
      /invalid_world_layout/,
    );
  refuse({ ...plan, cols: 41 });
  refuse({ ...plan, cols: 15 });
  refuse({ ...plan, cols: 24 });
  refuse({ ...plan, rooms: { "decor:Bad-Id": plan.rooms["decor:balcony"] } });
  refuse({
    ...plan,
    rooms: Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `decor:d${i}`,
        { name: "D", x: 0, y: i * 2, w: 2, h: 2, floor: "grass" },
      ]),
    ),
  });
});
