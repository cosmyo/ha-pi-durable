import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, supportedServices } from "../src/config.js";

test("large exact entity allowlists are bounded and remain deny-all by default", async (t) => {
  const values = {
    HEARTH_MODE: "local",
    HEARTH_PROVIDER: "offline",
    HEARTH_LOCAL_PASSWORD: "synthetic-local-password-0001",
    HEARTH_ORIGIN: "http://127.0.0.1:8099",
    HEARTH_PORT: "8099",
    HEARTH_ACTIONS: "false",
    HEARTH_ALLOWED_SERVICES: "",
    HEARTH_ALLOWED_ENTITIES: "",
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, values);
  assert.deepEqual((await loadConfig()).policy.entities, []);

  const entities = Array.from(
    { length: 10000 },
    (_, i) => `sensor.example_${i}`,
  );
  for (const size of [876, 10000]) {
    process.env.HEARTH_ALLOWED_ENTITIES = entities.slice(0, size).join(",");
    const config = await loadConfig();
    assert.equal(config.policy.entities.length, size);
    assert.equal(config.policy.enabled, false);
    assert.deepEqual(config.policy.services, []);
  }
  process.env.HEARTH_ALLOWED_ENTITIES = [...entities, "sensor.extra"].join(",");
  await assert.rejects(loadConfig(), /invalid_request/);
  for (const value of ["*", "sensor.*", "sensor.example_0,*"]) {
    process.env.HEARTH_ALLOWED_ENTITIES = value;
    await assert.rejects(loadConfig(), /invalid_request/);
  }
  // Shared lists: the three todo services are accepted exactly; at most the
  // seven supported services; bulk removal is never configurable.
  process.env.HEARTH_ALLOWED_ENTITIES = "todo.example_groceries";
  process.env.HEARTH_ALLOWED_SERVICES =
    "todo.add_item,todo.update_item,todo.remove_item";
  assert.deepEqual((await loadConfig()).policy.services, [
    "todo.add_item",
    "todo.update_item",
    "todo.remove_item",
  ]);
  process.env.HEARTH_ALLOWED_SERVICES = supportedServices.join(",");
  assert.equal((await loadConfig()).policy.services.length, 7);
  process.env.HEARTH_ALLOWED_SERVICES = [
    ...supportedServices,
    "todo.add_item",
  ].join(",");
  await assert.rejects(loadConfig(), /invalid_request/, "8 entries");
  for (const value of ["todo.remove_completed_items", "todo.get_items"]) {
    process.env.HEARTH_ALLOWED_SERVICES = value;
    await assert.rejects(loadConfig(), /invalid_request/);
  }
});
