import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyAction,
  confirmationWord,
  type EntityFacts,
  type RiskContext,
} from "../src/risk.js";
import type { Action, RiskLevel } from "../src/documents.js";

const svc = (
  domain: string,
  service: string,
  target: Record<string, string[]> = {},
  data: Record<string, unknown> = {},
): Action => ({ kind: "service", domain, service, target, data }) as Action;
const sup = (path: string, method: "POST" | "DELETE" = "POST"): Action => ({
  kind: "supervisor",
  method,
  path,
});
const facts = (
  name: string,
  deviceClass = "",
  extra: Partial<EntityFacts> = {},
): EntityFacts => ({ name, deviceClass, title: "", members: null, ...extra });
const context: RiskContext = {
  selfSlug: "abc123_hearth_pi",
  entities: {
    "cover.main_door": facts("Main door", "garage"),
    "cover.blind": facts("Blind", "blind"),
    "cover.zz_side": facts("Side", "door"),
    "scene.movie": facts("Movie", "", {
      members: ["light.a", "media_player.tv"],
    }),
    "scene.cosy": facts("Cosy", "", { members: ["light.a", "climate.hall"] }),
    "scene.leave": facts("Leave", "", {
      members: ["light.a", "lock.front_door"],
    }),
    "update.mosquitto_update": facts("Mosquitto update", "", {
      title: "Mosquitto broker",
    }),
    "update.core_renamed": facts("Core", "", { title: "Home Assistant Core" }),
    "update.hearth_pi_update": facts("Hearth Pi update", "", {
      title: "Hearth Pi",
    }),
    "switch.addon_runner": facts("Hearth Pi running"),
  },
};

const table: [string, Action, RiskLevel, string][] = [
  // low
  [
    "legacy light toggle",
    { service: "light.turn_on", entityId: "light.a", data: {} },
    "low",
    "comfort_device",
  ],
  [
    "legacy switch toggle",
    { service: "switch.turn_off", entityId: "switch.a", data: {} },
    "low",
    "comfort_device",
  ],
  [
    "light",
    svc("light", "turn_on", { entity_id: ["light.a"] }),
    "low",
    "comfort_device",
  ],
  [
    "fan",
    svc("fan", "set_percentage", { entity_id: ["fan.a"] }),
    "low",
    "comfort_device",
  ],
  [
    "media",
    svc("media_player", "volume_set", { entity_id: ["media_player.tv"] }),
    "low",
    "comfort_device",
  ],
  [
    "scene on",
    svc("scene", "turn_on", { entity_id: ["scene.movie"] }),
    "low",
    "scene_on",
  ],
  [
    "update entity",
    svc("homeassistant", "update_entity", { entity_id: ["sensor.a"] }),
    "low",
    "refresh_entity",
  ],
  // medium
  [
    "climate",
    svc(
      "climate",
      "set_temperature",
      { entity_id: ["climate.hall"] },
      { temperature: 20 },
    ),
    "medium",
    "household_device",
  ],
  [
    "blind cover",
    svc("cover", "open_cover", { entity_id: ["cover.blind"] }),
    "medium",
    "cover",
  ],
  [
    "input helper",
    svc("input_boolean", "turn_on", { entity_id: ["input_boolean.guest"] }),
    "medium",
    "household_device",
  ],
  [
    "notify",
    svc("notify", "mobile_app_phone", {}, { message: "hi" }),
    "medium",
    "household_device",
  ],
  [
    "automation off",
    svc("automation", "turn_off", { entity_id: ["automation.a"] }),
    "medium",
    "automation_control",
  ],
  [
    "config upsert",
    {
      kind: "config",
      resource: "automation",
      op: "upsert",
      id: "a1",
      body: { alias: "A", action: [{ action: "light.turn_on" }] },
    },
    "high",
    "config_runs_actions",
  ],
  [
    "registry update",
    {
      kind: "ws",
      type: "config/entity_registry/update",
      payload: { entity_id: "light.a", name: "A" },
    },
    "medium",
    "registry_write",
  ],
  [
    "helper create",
    { kind: "ws", type: "input_number/create", payload: { name: "N" } },
    "medium",
    "helper_config",
  ],
  ["addon start", sup("/addons/core_mosquitto/start"), "medium", "addon_start"],
  ["backup new", sup("/backups/new/full"), "medium", "backup_create"],
  // high
  [
    "lock",
    svc("lock", "unlock", { entity_id: ["lock.front_door"] }),
    "high",
    "lock",
  ],
  [
    "alarm",
    svc("alarm_control_panel", "alarm_disarm", {
      entity_id: ["alarm_control_panel.home"],
    }),
    "high",
    "alarm",
  ],
  [
    "garage by class",
    svc("cover", "open_cover", { entity_id: ["cover.main_door"] }),
    "high",
    "garage_gate_cover",
  ],
  [
    "gate by name",
    svc("cover", "open_cover", { entity_id: ["cover.front_gate"] }),
    "high",
    "cover_unverified",
  ],
  [
    "cover by area",
    svc("cover", "open_cover", { area_id: ["garage"] }),
    "high",
    "cover_indirect",
  ],
  [
    "siren",
    svc("siren", "turn_on", { entity_id: ["siren.a"] }),
    "high",
    "siren",
  ],
  [
    "camera disable",
    svc("camera", "disable_motion_detection", { entity_id: ["camera.a"] }),
    "high",
    "camera_disable",
  ],
  ["ha restart", svc("homeassistant", "restart"), "high", "core_restart"],
  [
    "script",
    svc("script", "turn_on", { entity_id: ["script.a"] }),
    "high",
    "runs_actions",
  ],
  ["unknown service", svc("custom_thing", "do_it"), "high", "unknown_service"],
  [
    "config delete",
    { kind: "config", resource: "script", op: "delete", id: "s1" },
    "high",
    "config_delete",
  ],
  [
    "config calls lock",
    {
      kind: "config",
      resource: "automation",
      op: "upsert",
      id: "a2",
      body: { action: [{ service: "lock.unlock" }] },
    },
    "high",
    "config_runs_actions",
  ],
  ["addon stop", sup("/addons/core_mosquitto/stop"), "high", "addon_stop"],
  [
    "addon install",
    sup("/store/addons/core_samba/install"),
    "high",
    "addon_install",
  ],
  ["addon options", sup("/addons/core_samba/options"), "high", "addon_options"],
  ["core restart", sup("/core/restart"), "high", "core_restart"],
  // critical
  ["host reboot", sup("/host/reboot"), "critical", "host_power"],
  ["host shutdown", sup("/host/shutdown"), "critical", "host_power"],
  [
    "backup restore",
    sup("/backups/abcd1234/restore/full"),
    "critical",
    "backup_restore",
  ],
  [
    "backup remove",
    sup("/backups/abcd1234", "DELETE"),
    "critical",
    "backup_remove",
  ],
  [
    "addon uninstall",
    sup("/addons/core_samba/uninstall"),
    "critical",
    "addon_uninstall",
  ],
  ["core update", sup("/core/update"), "critical", "system_update"],
  ["os update", sup("/os/update"), "critical", "system_update"],
  ["supervisor update", sup("/supervisor/update"), "critical", "system_update"],
  [
    "self stop",
    sup("/addons/abc123_hearth_pi/stop"),
    "critical",
    "self_protection",
  ],
  [
    "self restart (other repo)",
    sup("/addons/zz_hearth_pi/restart"),
    "critical",
    "self_protection",
  ],
  [
    "self options via running slug",
    sup("/addons/abc123_hearth_pi/options"),
    "critical",
    "self_protection",
  ],
  [
    "self via hassio service",
    svc("hassio", "addon_stop", {}, { addon: "abc123_hearth_pi" }),
    "critical",
    "self_protection",
  ],
  [
    "self via automation config",
    {
      kind: "config",
      resource: "automation",
      op: "upsert",
      id: "x",
      body: {
        action: [
          {
            action: "hassio.addon_restart",
            data: { addon: "local_hearth_pi" },
          },
        ],
      },
    },
    "critical",
    "self_protection",
  ],
  [
    "hassio host reboot service",
    svc("hassio", "host_reboot"),
    "critical",
    "host_power",
  ],
];

test(`risk classifier table (${table.length} cases): deterministic level and deciding rule`, () => {
  assert(table.length >= 25);
  for (const [name, action, level, rule] of table) {
    const result = classifyAction(action, context);
    assert.equal(result.level, level, name);
    assert.equal(result.rule, rule, name);
    assert(result.reasons.length > 0, name);
  }
});

test("critical confirmation words name the exact target", () => {
  assert.equal(confirmationWord(sup("/host/reboot")), "REBOOT");
  assert.equal(confirmationWord(sup("/host/shutdown")), "SHUTDOWN");
  assert.equal(
    confirmationWord(sup("/addons/core_samba/uninstall")),
    "core_samba",
  );
  assert.equal(
    confirmationWord(sup("/backups/abcd1234", "DELETE")),
    "abcd1234",
  );
  assert.equal(confirmationWord(sup("/core/update")), "UPDATE");
});

// Security review regressions: the classifier alone is a safe floor.
test("review P0: automation/script bodies are at least high; hidden critical steps stay critical", () => {
  const automation = (action: unknown): Action => ({
    kind: "config",
    resource: "automation",
    op: "upsert",
    id: "porch",
    body: { alias: "Porch", trigger: [], action } as never,
  });
  const padded = [
    ...Array.from({ length: 201 }, () => ({ action: "light.turn_on" })),
    { action: "hassio.host_reboot" },
  ];
  const cases: [string, Action, RiskLevel][] = [
    ["201-item padding then reboot", automation(padded), "critical"],
    [
      "templated reboot",
      automation([{ action: "{{ 'hassio.host_reboot' }}" }]),
      "critical",
    ],
    [
      "uppercase reboot",
      automation([{ service: "Hassio.Host_Reboot" }]),
      "critical",
    ],
    [
      "concatenated template",
      automation([{ action: "{{ 'hassio.' ~ 'host_reboot' }}" }]),
      "high",
    ],
    [
      "device action unlock",
      automation([{ device_id: "abc", domain: "lock", type: "unlock" }]),
      "high",
    ],
    ["unknown step kind", automation([{ weird_step: { x: 1 } }]), "high"],
    [
      "plain light automation",
      automation([{ action: "light.turn_on" }]),
      "high",
    ],
    [
      "self restart in body",
      automation([
        { action: "hassio.addon_restart", data: { addon: "local_hearth_pi" } },
      ]),
      "critical",
    ],
    [
      "script with only a light",
      {
        kind: "config",
        resource: "script",
        op: "upsert",
        id: "s",
        body: { sequence: [{ action: "light.turn_on" }] },
      },
      "high",
    ],
    [
      "update.install of core in script",
      {
        kind: "config",
        resource: "script",
        op: "upsert",
        id: "s2",
        body: {
          sequence: [
            {
              action: "update.install",
              target: { entity_id: "update.home_assistant_core_update" },
            },
          ],
        },
      },
      "critical",
    ],
    [
      "scene with lock",
      {
        kind: "config",
        resource: "scene",
        op: "upsert",
        id: "leave",
        body: {
          name: "Leave",
          entities: { "light.a": "off", "lock.front_door": "unlocked" },
        },
      },
      "high",
    ],
    [
      "scene with lights only",
      {
        kind: "config",
        resource: "scene",
        op: "upsert",
        id: "movie",
        body: { name: "Movie", entities: { "light.a": "on" } },
      },
      "medium",
    ],
    [
      "scene without readable entities",
      {
        kind: "config",
        resource: "scene",
        op: "upsert",
        id: "odd",
        body: { name: "Odd" },
      },
      "high",
    ],
  ];
  for (const [name, action, level] of cases)
    assert.equal(classifyAction(action, context).level, level, name);
});

test("review P1: scenes, covers, update entities and self-protection fail closed", () => {
  const cases: [string, Action, RiskLevel, string][] = [
    [
      "scene.apply with a lock",
      svc(
        "scene",
        "apply",
        {},
        { entities: { "lock.front_door": "unlocked" } },
      ),
      "high",
      "scene_members",
    ],
    [
      "scene.apply with a garage cover",
      svc("scene", "apply", {}, { entities: { "cover.main_door": "open" } }),
      "high",
      "scene_members",
    ],
    [
      "scene.apply with lights",
      svc("scene", "apply", {}, { entities: { "light.a": "on" } }),
      "medium",
      "scene_config",
    ],
    [
      "scene.apply unreadable",
      svc("scene", "apply", {}, { entities: "lock.front_door" }),
      "high",
      "scene_members",
    ],
    [
      "scene.create with a lock",
      svc(
        "scene",
        "create",
        {},
        { scene_id: "x", entities: { "lock.a": "unlocked" } },
      ),
      "high",
      "scene_members",
    ],
    [
      "scene.turn_on containing a lock",
      svc("scene", "turn_on", { entity_id: ["scene.leave"] }),
      "high",
      "scene_members",
    ],
    [
      "scene.turn_on with climate",
      svc("scene", "turn_on", { entity_id: ["scene.cosy"] }),
      "medium",
      "scene_members",
    ],
    [
      "scene.turn_on unknown scene",
      svc("scene", "turn_on", { entity_id: ["scene.nope"] }),
      "high",
      "scene_members",
    ],
    [
      "scene.turn_on by area",
      svc("scene", "turn_on", { area_id: ["x"] }),
      "high",
      "scene_unverified",
    ],
    [
      "cover padded with missing targets",
      svc("cover", "open_cover", {
        entity_id: [
          ...Array.from({ length: 10 }, (_, i) => `cover.a${i}`),
          "cover.blind",
        ],
      }),
      "high",
      "cover_unverified",
    ],
    [
      "cover with a door device class",
      svc("cover", "open_cover", {
        entity_id: ["cover.blind", "cover.zz_side"],
      }),
      "high",
      "garage_gate_cover",
    ],
    [
      "cover close of a blind",
      svc("cover", "close_cover", { entity_id: ["cover.blind"] }),
      "medium",
      "cover",
    ],
    [
      "update.install core by id",
      svc("update", "install", {
        entity_id: ["update.home_assistant_core_update"],
      }),
      "critical",
      "system_update",
    ],
    [
      "update.install core by title",
      svc("update", "install", { entity_id: ["update.core_renamed"] }),
      "critical",
      "system_update",
    ],
    [
      "update.skip core",
      svc("update", "skip", { entity_id: ["update.core_renamed"] }),
      "critical",
      "system_update",
    ],
    [
      "update.install self",
      svc("update", "install", { entity_id: ["update.hearth_pi_update"] }),
      "critical",
      "self_protection",
    ],
    [
      "update.install add-on",
      svc("update", "install", { entity_id: ["update.mosquitto_update"] }),
      "high",
      "update_install",
    ],
    [
      "update.skip add-on",
      svc("update", "skip", { entity_id: ["update.mosquitto_update"] }),
      "medium",
      "update_skip",
    ],
    [
      "update.install unreadable",
      svc("update", "install", { entity_id: ["update.unknown_thing"] }),
      "critical",
      "update_unverified",
    ],
    [
      "self switch by name",
      svc("switch", "turn_off", { entity_id: ["switch.addon_runner"] }),
      "critical",
      "self_protection",
    ],
    [
      "self light by id",
      svc("light", "turn_off", { entity_id: ["light.hearth_pi_status"] }),
      "critical",
      "self_protection",
    ],
    [
      "cover rename",
      {
        kind: "ws",
        type: "config/entity_registry/update",
        payload: { entity_id: "cover.main_door", new_entity_id: "cover.main" },
      },
      "high",
      "sensitive_registry_rename",
    ],
    [
      "lock name change",
      {
        kind: "ws",
        type: "config/entity_registry/update",
        payload: { entity_id: "lock.front_door", name: "Porch light" },
      },
      "high",
      "sensitive_registry_rename",
    ],
    [
      "light rename stays medium",
      {
        kind: "ws",
        type: "config/entity_registry/update",
        payload: { entity_id: "light.a", name: "Lamp" },
      },
      "medium",
      "registry_write",
    ],
  ];
  for (const [name, action, level, rule] of cases) {
    const result = classifyAction(action, context);
    assert.deepEqual([result.level, result.rule], [level, rule], name);
  }
  // A forked add-on name learned from Supervisor is self-protected too.
  assert.equal(
    classifyAction(
      svc("switch", "turn_off", { entity_id: ["switch.my_fork_watchdog"] }),
      {
        selfName: "My Fork",
        entities: {},
      },
    ).level,
    "critical",
  );
  // No live read at all (facts absent) fails closed for covers.
  assert.equal(
    classifyAction(
      svc("cover", "open_cover", { entity_id: ["cover.blind"] }),
      {},
    ).level,
    "high",
  );
});

test("shared lists: add/complete/reopen low; rename/remove medium; admin todo services rated by the same table", () => {
  const todo = (op: string, extra: Record<string, string> = {}): Action =>
    ({
      kind: "todo",
      entityId: "todo.example_groceries",
      op,
      ...extra,
    }) as Action;
  const cases: [Action, RiskLevel, string][] = [
    [todo("add", { summary: "Oat milk" }), "low", "list_add"],
    [todo("complete", { uid: "u1", label: "Oat milk" }), "low", "list_status"],
    [todo("reopen", { uid: "u1", label: "Oat milk" }), "low", "list_status"],
    [
      todo("rename", { uid: "u1", summary: "Rye", label: "Bread" }),
      "medium",
      "list_rename",
    ],
    [todo("remove", { uid: "u1", label: "Bread" }), "medium", "list_remove"],
    // Admin mode's generic service calls.
    [
      svc(
        "todo",
        "add_item",
        { entity_id: ["todo.example_groceries"] },
        { item: "Oat milk" },
      ),
      "low",
      "list_add",
    ],
    [
      svc(
        "todo",
        "update_item",
        { entity_id: ["todo.example_groceries"] },
        { item: "Oat milk", status: "completed" },
      ),
      "low",
      "list_status",
    ],
    [
      svc(
        "todo",
        "update_item",
        { entity_id: ["todo.example_groceries"] },
        { item: "Oat milk", rename: "Rye" },
      ),
      "medium",
      "list_rename",
    ],
    [
      svc(
        "todo",
        "remove_item",
        { entity_id: ["todo.example_groceries"] },
        { item: ["Bread"] },
      ),
      "medium",
      "list_remove",
    ],
    [
      svc("todo", "remove_completed_items", {
        entity_id: ["todo.example_groceries"],
      }),
      "high",
      "list_bulk_remove",
    ],
    [
      svc("todo", "get_items", { entity_id: ["todo.example_groceries"] }),
      "high",
      "unknown_service",
    ],
    [
      svc("todo", "add_item", { area_id: ["kitchen"] }, { item: "x" }),
      "high",
      "list_indirect",
    ],
  ];
  for (const [action, level, rule] of cases) {
    const result = classifyAction(action);
    assert.equal(result.level, level, JSON.stringify(action));
    assert.equal(result.rule, rule, JSON.stringify(action));
  }
  assert.equal(confirmationWord(todo("remove", { uid: "u1" })), "CONFIRM");
});
