import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, selfSlug } from "../src/config.js";
import { adminAction, redactLog, supervisorReadAllowed } from "../src/admin.js";
import { HA_WEBSOCKET_TYPES } from "../src/ha-websocket.js";
import { HA_ADMIN_WEBSOCKET_TYPES } from "../src/ha-admin.js";
import { haExtension } from "../src/ha.js";
import { fakeAdminHA, TOKEN } from "./admin-fixtures.js";

const big = "x".repeat(40000);
test("admin action kinds are strictly validated and size-capped", () => {
  const ok = [
    {
      kind: "service",
      domain: "climate",
      service: "set_temperature",
      target: { entity_id: "climate.hall" },
      data: { temperature: 20 },
    },
    {
      kind: "config",
      resource: "automation",
      op: "upsert",
      id: "porch_lights",
      body: { alias: "Porch", action: [] },
    },
    { kind: "config", resource: "scene", op: "delete", id: "movie" },
    {
      kind: "ws",
      type: "config/entity_registry/update",
      payload: { entity_id: "light.kitchen", name: "Kitchen" },
    },
    { kind: "ws", type: "input_boolean/create", payload: { name: "Guest" } },
    { kind: "supervisor", method: "POST", path: "/addons/core_samba/restart" },
    { kind: "supervisor", method: "DELETE", path: "/backups/abcd1234" },
  ];
  for (const value of ok) assert.doesNotThrow(() => adminAction(value));
  // Target normalized to sorted unique lists.
  assert.deepEqual((adminAction(ok[0]) as { target: unknown }).target, {
    entity_id: ["climate.hall"],
  });
  const bad: [unknown, RegExp][] = [
    [{ kind: "shell", command: "ls" }, /invalid_action_kind/],
    [null, /invalid_action_shape/],
    [{ ...ok[0], extra: 1 }, /invalid_request/],
    [{ ...ok[0], domain: "Climate!" }, /invalid_request|invalid_service/],
    [{ ...ok[0], target: { entity_id: ["not an entity"] } }, /invalid_target/],
    [
      {
        ...ok[0],
        target: {
          entity_id: Array.from({ length: 51 }, (_, i) => `light.l${i}`),
        },
      },
      /invalid_target/,
    ],
    [{ ...ok[0], data: { entity_id: "lock.front_door" } }, /target_in_data/],
    [{ ...ok[0], data: { blob: big } }, /action_too_large/],
    [
      { ...ok[0], data: JSON.parse('{"a":'.repeat(20) + "1" + "}".repeat(20)) },
      /action_too_deep/,
    ],
    [{ ...ok[1], resource: "configuration_yaml" }, /invalid_config_resource/],
    [{ ...ok[1], id: "../../etc" }, /invalid_config_id/],
    [{ ...ok[1], body: { big } }, /action_too_large/],
    [{ ...ok[1], body: {} }, /config_body_required/],
    [{ ...ok[2], body: { a: 1 } }, /invalid_action_shape/],
    [
      { kind: "ws", type: "auth/delete_refresh_token", payload: {} },
      /ws_type_not_allowed/,
    ],
    [
      { kind: "ws", type: "config/auth/create", payload: {} },
      /ws_type_not_allowed/,
    ],
    [
      { ...ok[3], payload: { entity_id: "light.kitchen", platform: "x" } },
      /invalid_ws_payload/,
    ],
    [{ ...ok[3], payload: { name: "missing id" } }, /invalid_ws_payload/],
    [
      { kind: "supervisor", method: "POST", path: "/host/exec" },
      /supervisor_endpoint_not_allowed/,
    ],
    [{ kind: "supervisor", method: "GET", path: "/addons" }, /invalid_method/],
    [
      { kind: "supervisor", method: "DELETE", path: "/host/reboot" },
      /supervisor_endpoint_not_allowed/,
    ],
    [
      { kind: "supervisor", method: "POST", path: "/addons/../host/reboot" },
      /supervisor_endpoint_not_allowed/,
    ],
    [
      { kind: "supervisor", method: "POST", path: "/docker/registries" },
      /supervisor_endpoint_not_allowed/,
    ],
    [
      {
        kind: "supervisor",
        method: "POST",
        path: "/addons/core_samba/options",
        body: { big },
      },
      /action_too_large/,
    ],
  ];
  for (const [value, error] of bad)
    assert.throws(
      () => adminAction(value),
      error,
      JSON.stringify(value).slice(0, 80),
    );
});

test("supervisor read allowlist refuses everything else; logs are redacted and capped", () => {
  for (const path of [
    "/addons",
    "/addons/core_samba/info",
    "/addons/core_samba/logs",
    "/addons/core_samba/stats",
    "/backups",
    "/backups/abcd1234/info",
    "/core/info",
    "/core/logs",
    "/supervisor/logs",
    "/os/info",
    "/host/info",
    "/network/info",
    "/resolution/info",
    "/store",
    "/store/addons",
  ])
    assert.equal(supervisorReadAllowed(path), path);
  for (const path of [
    "/auth",
    "/host/logs/follow",
    "/addons/x/info/../../auth",
    "/hardware/info",
    "/docker/info",
    "/addons/core_samba/stdin",
  ])
    assert.throws(
      () => supervisorReadAllowed(path),
      /supervisor_endpoint_not_allowed/,
    );
  const log = redactLog(
    `a\npassword: hunter2hunter\nAuthorization: Bearer abcdefghijklmnopqrst\nsk-abcdefghijklmnop\n${"z".repeat(30000)}\nTAIL`,
    (s) => s.split("knownsecret").join("[REDACTED]"),
  );
  assert(log.truncated);
  assert.match(log.text, /TAIL$/);
  assert(Buffer.byteLength(log.text) <= 16384);
  const short = redactLog(
    "password: hunter2hunter Bearer abcdefghijklmnopqrst sk-abcdefghijklmnop knownsecret",
    (s) => s.split("knownsecret").join("[REDACTED]"),
  );
  assert.doesNotMatch(
    short.text,
    /hunter2|abcdefghijklmnopqrst|sk-abc|knownsecret/,
  );
});

test("scoped mode: admin tools absent, admin actions refused, read-only WebSocket allowlist unchanged", async () => {
  const { ha } = fakeAdminHA({ access: "scoped" });
  const names = haExtension(ha).tools!.map((t) => t.name);
  for (const name of [
    "ha_admin_read",
    "ha_call_service",
    "ha_config_get",
    "ha_config_propose",
    "ha_registry_propose",
    "supervisor_read",
    "supervisor_propose",
  ])
    assert(!names.includes(name), name);
  assert(names.includes("ha_propose_service"));
  assert.throws(
    () =>
      ha.action({
        kind: "service",
        domain: "light",
        service: "turn_on",
        target: { entity_id: ["light.kitchen"] },
        data: {},
      }),
    /admin_mode_required/,
  );
  await assert.rejects(ha.supervisorRead("/addons"), /admin_mode_required/);
  await assert.rejects(ha.adminRead("states", "", 0), /admin_mode_required/);
  await assert.rejects(ha.state("lock.front_door"), /entity_not_allowed/);
  assert(!(HA_WEBSOCKET_TYPES as readonly string[]).includes("supervisor/api"));
  assert(HA_ADMIN_WEBSOCKET_TYPES.includes("supervisor/api"));
  // The prompt has no admin text in scoped mode.
  const extension = haExtension(ha);
  assert.doesNotMatch(JSON.stringify(extension.sections ?? []), /ADMIN ACCESS/);
});

test("admin mode reads every entity, registries and config; supervisor reads go over Core's supervisor/api", async () => {
  const { ha, frames } = fakeAdminHA();
  const names = haExtension(ha).tools!.map((t) => t.name);
  for (const name of ["ha_admin_read", "ha_call_service", "supervisor_propose"])
    assert(names.includes(name));
  assert(!names.includes("ha_propose_service"));
  assert.equal(await ha.refreshScope(), 10);
  assert(ha.policy.entities.includes("lock.front_door"));
  assert.equal((await ha.state("lock.front_door")).state, "locked");
  const states = (await ha.adminRead("states", "door", 0)) as {
    items: unknown[];
  };
  assert.deepEqual(
    (states.items as { entity_id: string }[]).map((i) => i.entity_id),
    ["cover.main_door", "lock.front_door"],
  );
  const config = await ha.adminRead("config", "", 0);
  assert.equal((config as { version: string }).version, "2099.1.0");
  assert.doesNotMatch(JSON.stringify(config), /latitude|1\.23/);
  const entities = (await ha.adminRead("entities", "", 0)) as {
    items: unknown[];
  };
  assert.equal((entities.items as unknown[]).length, 1);
  const automation = await ha.configGet("automation", "porch_lights");
  assert.equal((automation as { found: boolean }).found, true);
  const services = (await ha.adminRead("services", "lock", 0)) as {
    items: unknown[];
  };
  assert.deepEqual(services.items, ["lock.lock", "lock.unlock"]);

  frames.length = 0;
  await assert.rejects(
    ha.supervisorRead("/host/exec"),
    /supervisor_endpoint_not_allowed/,
  );
  assert.equal(frames.length, 0, "refused before any frame is sent");
  const info = await ha.supervisorRead("/addons");
  assert.equal((info as { truncated: boolean }).truncated, false);
  const sent = frames.find((f) => f.type === "supervisor/api")!;
  assert.equal(sent.endpoint, "/addons");
  assert.equal(sent.method, "get");
  const logs = (await ha.supervisorRead("/core/logs")) as {
    log: { text: string };
  };
  assert.doesNotMatch(
    logs.log.text,
    new RegExp(`supersecretvalue123|abcdefghijklmnop|${TOKEN}`),
  );
  assert.match(logs.log.text, /line three/);
});

test("access_mode and risk judge options are configuration-only and validated", async (t) => {
  const keys = [
    "HEARTH_MODE",
    "HEARTH_PROVIDER",
    "HEARTH_LOCAL_PASSWORD",
    "HEARTH_ORIGIN",
    "HEARTH_ACCESS_MODE",
    "HEARTH_ALLOWED_ENTITIES",
    "HEARTH_ALLOWED_SERVICES",
    "HEARTH_ACTIONS",
    "HEARTH_RISK_JUDGE_MODEL",
    "HEARTH_RISK_JUDGE_URL",
    "HEARTH_RISK_JUDGE_API_KEY",
    "HEARTH_RISK_JUDGE_TIMEOUT_MS",
    "HOSTNAME",
  ];
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, {
    HEARTH_MODE: "local",
    HEARTH_PROVIDER: "offline",
    HEARTH_LOCAL_PASSWORD: "synthetic-local-password-0001",
    HEARTH_ORIGIN: "http://127.0.0.1:8099",
    HEARTH_ALLOWED_ENTITIES: "light.kitchen",
  });
  const scoped = await loadConfig();
  assert.equal(scoped.policy.access, undefined);
  assert.deepEqual(scoped.policy.entities, ["light.kitchen"]);
  assert.equal(scoped.policy.enabled, false);
  assert.equal(scoped.judge?.model, "auto");
  assert.equal(scoped.judge?.timeoutMs, 15000);
  process.env.HEARTH_ACCESS_MODE = "admin";
  process.env.HOSTNAME = "abc123-hearth-pi";
  const admin = await loadConfig();
  assert.equal(admin.policy.access, "admin");
  assert.equal(admin.policy.enabled, true);
  assert.deepEqual(admin.policy.entities, [], "allowed_entities ignored");
  assert.equal(admin.policy.selfSlug, "abc123_hearth_pi");
  process.env.HEARTH_ACCESS_MODE = "root";
  await assert.rejects(loadConfig(), /invalid_access_mode/);
  process.env.HEARTH_ACCESS_MODE = "scoped";
  for (const [key, value, error] of [
    ["HEARTH_RISK_JUDGE_MODEL", "gpt", /invalid_risk_judge_model/],
    [
      "HEARTH_RISK_JUDGE_MODEL",
      "endpoint/qwen3-1.7b",
      /risk_judge_url_required/,
    ],
    ["HEARTH_RISK_JUDGE_TIMEOUT_MS", "60000", /invalid_risk_judge_timeout/],
    ["HEARTH_RISK_JUDGE_URL", "ftp://192.168.1.5", /invalid_risk_judge_url/],
    [
      "HEARTH_RISK_JUDGE_URL",
      "http://user:pw@192.168.1.5",
      /invalid_risk_judge_url/,
    ],
  ] as const) {
    process.env[key] = value;
    await assert.rejects(loadConfig(), error, `${key}=${value}`);
    delete process.env[key];
  }
  Object.assign(process.env, {
    HEARTH_RISK_JUDGE_MODEL: "endpoint/qwen3-1.7b",
    HEARTH_RISK_JUDGE_URL: "http://192.168.1.50:8080",
    HEARTH_RISK_JUDGE_API_KEY: "synthetic-judge-key-0001",
    HEARTH_RISK_JUDGE_TIMEOUT_MS: "20000",
  });
  const judged = await loadConfig();
  assert.deepEqual(
    { ...judged.judge, apiKey: judged.judge?.apiKey.length },
    {
      model: "endpoint/qwen3-1.7b",
      url: "http://192.168.1.50:8080",
      apiKey: 24,
      timeoutMs: 20000,
      sessionTtlMs: 300000,
    },
  );
  assert.equal(selfSlug("unrelated-host"), "");
});

test("review P1/P2: Supervisor info never carries add-on options/secrets; WS prototype keys refused cleanly; admin attributes are bounded and redacted", async () => {
  const { ha, frames } = fakeAdminHA();
  const info = await ha.supervisorRead("/addons/core_mosquitto/info");
  const text = JSON.stringify(info);
  for (const canary of [
    "ADDON_OPTION_CANARY",
    "options",
    "schema",
    "INGRESS_CANARY",
    "OBJECT_LEAF_CANARY",
    "1883",
  ])
    assert(!text.includes(canary), canary);
  assert.match(text, /Mosquitto broker/);
  assert.match(text, /"version":"6.4.0"/);
  // Prototype-named WS types: a clean 403, nothing sent.
  const before = frames.length;
  for (const type of ["__proto__", "constructor", "toString", "hasOwnProperty"])
    assert.throws(
      () => adminAction({ kind: "ws", type, payload: {} }),
      /ws_type_not_allowed/,
      type,
    );
  assert.equal(frames.length, before);
  // ha_state_detail in admin mode: ≤40 keys, ≤200 chars, no secret-ish keys,
  // no tokenized picture URLs, no nested objects.
  const detail = await ha.state("sensor.big");
  const attrs = detail.attributes as Record<string, unknown>;
  assert(Object.keys(attrs).length <= 40);
  assert(Object.values(attrs).every((v) => String(v).length <= 200));
  assert.doesNotMatch(
    JSON.stringify(detail),
    /ATTR_TOKEN_CANARY|ATTR_KEY_CANARY|PICTURE_TOKEN_CANARY|NESTED_CANARY/,
  );
  assert.equal(attrs.friendly_name, "Big sensor");
  const page = (await ha.adminRead("states", "big", 0)) as {
    items: { attributes: Record<string, unknown> }[];
  };
  assert(Object.keys(page.items[0]!.attributes).length <= 12);
  assert.doesNotMatch(JSON.stringify(page), /CANARY/);
  // Scoped mode keeps the narrow four-attribute projection.
  const scoped = fakeAdminHA({
    access: "scoped",
    policy: { enabled: false, entities: ["sensor.big"], services: [] },
  });
  assert.deepEqual(
    Object.keys((await scoped.ha.state("sensor.big")).attributes),
    ["friendly_name"],
  );
});
