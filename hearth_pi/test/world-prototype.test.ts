// PROTOTYPE Home World (throwaway UI exploration): routes, safety and adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { Runtime } from "../src/runtime.js";
import { HAClient, Actions } from "../src/ha.js";
import { appServer } from "../src/server.js";
import { offline } from "./fixtures.js";

const config: Config = {
  mode: "local",
  host: "127.0.0.1",
  port: 8099,
  origin: "http://127.0.0.1:8099",
  password: "synthetic-local-password-0001",
  authorizedUsers: ["synthetic-admin"],
  dataDir: "",
  provider: "offline",
  model: "test",
  policy: { enabled: false, entities: [], services: [] },
  haToken: "synthetic-supervisor-token",
  apiKey: "synthetic-provider-key",
};
const WORLD_MODULES = [
  "world/prototype-world.js",
  "world/world-pixel.js",
  "world/world-diorama.js",
  "world/world-ambient.js",
];

test("PROTOTYPE Home World static files are exact authenticated routes with correct types", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-world-"));
  const { models, model } = offline();
  const runtime = await Runtime.open(dir, models, model);
  const cfg = { ...config, dataDir: dir };
  const app = appServer(
    cfg,
    runtime,
    new Actions(runtime, new HAClient(cfg.haToken, cfg.policy)),
  );
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const authorization = `Basic ${Buffer.from(`hearth:${cfg.password}`).toString("base64")}`;
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { authorization } });
  try {
    for (const [path, type] of [
      ...WORLD_MODULES.map((m) => [`/${m}`, "text/javascript"]),
      ["/world/prototype-world.css", "text/css"],
      ["/vendor/three/three.module.js", "text/javascript"],
      ["/vendor/three/three.core.js", "text/javascript"],
    ] as const) {
      const response = await get(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("content-type"), type, path);
      assert.match(
        response.headers.get("content-security-policy")!,
        /script-src 'self'/,
      );
      await response.arrayBuffer();
      assert.equal((await fetch(`${base}${path}`)).status, 401, path);
    }
    // No directory serving or neighbouring files.
    for (const path of [
      "/world/",
      "/world",
      "/vendor/three/LICENSE",
      "/vendor/three/",
      "/world/world-pixel.js?x=1",
    ])
      assert.equal((await get(path)).status, path.includes("?") ? 400 : 404);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("PROTOTYPE Home World modules render text safely and never dispatch actions", async () => {
  for (const file of WORLD_MODULES) {
    const source = await readFile(
      new URL(`../public/${file}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /PROTOTYPE/, file);
    assert.doesNotMatch(
      source,
      /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|document\.write/,
      file,
    );
    // Read-only: the world never calls the HTTP API or services itself.
    assert.doesNotMatch(
      source,
      /fetch\(|XMLHttpRequest|api\/|EventSource/,
      file,
    );
  }
  const app = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  assert.match(app, /import\("\.\/world\/prototype-world\.js"\)/);
});

test("PROTOTYPE Home World adapter follows tool reads and sanitises the local layout", async () => {
  const world = await import(
    new URL("../public/world/prototype-world.js", import.meta.url).href
  );
  const snapshot = {
    homeCanvas: {
      title: "Synthetic home",
      committedAt: 1,
      sections: [
        {
          title: "Kitchen",
          readings: [
            {
              entityId: "light.kitchen",
              state: "on",
              observedAt: 2,
              attributes: { friendly_name: "<b>Kitchen light</b>" },
            },
            {
              entityId: "sensor.office_temperature",
              state: "21.4",
              observedAt: 2,
              attributes: { unit_of_measurement: "°C" },
            },
          ],
        },
      ],
    },
    view: {
      entries: [
        { model: [{ role: "user", content: "Is the kitchen light on?" }] },
        {
          model: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call-1",
                  name: "ha_state_detail",
                  arguments: { entityId: "light.kitchen" },
                },
              ],
            },
          ],
        },
      ],
      docs: {
        "pi.live": {
          run: { taskId: "t", inputs: [] },
          tools: [
            { callId: "call-1", name: "ha_state_detail", status: "running" },
          ],
        },
      },
    },
  };
  const derived = world.deriveWorld({ snapshot, busy: false, kind: "home" });
  assert.equal(derived.busy, true);
  assert.equal(derived.focus.entityId, "light.kitchen");
  assert.equal(derived.focus.label, "Reading <b>Kitchen light</b>…");
  assert.equal(derived.devices[0].active, true);
  assert.equal(derived.devices[1].kind, "thermo");
  assert.equal(derived.devices[1].value, "21.4 °C");
  assert.deepEqual(derived.lines, [
    { who: "You", text: "Is the kitchen light on?" },
  ]);
  assert.equal(
    world.deriveWorld({ snapshot, busy: false, kind: "workspace" }).devices
      .length,
    0,
  );
  assert.match(world.askAbout(derived.devices[0]), /do not .*call services/);
  const layout = world.sanitizeLayout({
    rooms: [
      {
        id: "a",
        name: "x".repeat(99),
        x: 99,
        y: -4,
        w: 500,
        h: 1,
        floor: "lava",
      },
      { id: "a", name: "duplicate" },
      { id: "<img>", name: "bad id" },
    ],
    devices: {
      "light.kitchen": { room: "a", fx: 9, fy: -1 },
      "not an entity": { room: "a" },
      "light.ghost": { room: "missing" },
    },
    character: { palette: 99, hat: "<script>" },
    pet: "yes",
  });
  assert.equal(layout.rooms.length, 1);
  assert.deepEqual(
    { ...layout.rooms[0], name: layout.rooms[0].name.length },
    { id: "a", name: 24, x: 0, y: 0, w: 16, h: 2, floor: "wood" },
  );
  assert.deepEqual(layout.devices, {
    "light.kitchen": { room: "a", fx: 1, fy: 0 },
  });
  assert.deepEqual(layout.character, { palette: 3, hat: "none" });
  const starter = world.sanitizeLayout(null);
  const path = world.planPath(starter, { x: 2, y: 2 }, { x: 14, y: 2 });
  assert(path.length > 1, "walks through doors between rooms");
  assert.deepEqual(path.at(-1), { x: 14, y: 2 });
});
