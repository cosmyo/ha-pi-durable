import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicAuthEnabled } from "../src/features.js";
import { Subscription } from "../src/subscription.js";

test("Anthropic flag defaults off, env exact true wins, and HA typed option is a fallback only", async () => {
  assert.equal(anthropicAuthEnabled(false, {}), false);
  assert.equal(anthropicAuthEnabled(true, {}), true);
  for (const value of ["false", "0", "1", "TRUE", "yes", "true ", ""])
    assert.equal(
      anthropicAuthEnabled(true, { HEARTH_ANTHROPIC_AUTH_ENABLED: value }),
      false,
    );
  assert.equal(
    anthropicAuthEnabled(false, { HEARTH_ANTHROPIC_AUTH_ENABLED: "true" }),
    true,
  );
  let calls = 0;
  const disabled = new Subscription(
    {
      login: async () => {
        calls++;
        throw new Error("must_not_run");
      },
      getAuth: async () => {
        calls++;
        return undefined;
      },
      logout: async () => {},
      hasConfiguredAuth: () => true,
    },
    undefined,
    "anthropic",
    false,
  );
  assert.equal(disabled.status("owner").configured, false);
  assert.throws(() => disabled.start("owner"), /anthropic_auth_disabled/);
  assert.throws(() => disabled.verify("owner"), /anthropic_auth_disabled/);
  await assert.rejects(
    Subscription.open("/does-not-exist", [], "anthropic", false),
    /anthropic_auth_disabled/,
  );
  assert.equal(calls, 0);
  const codex = new Subscription({
    login: async () => {
      throw new Error("not_used");
    },
    getAuth: async () => undefined,
    logout: async () => {},
    hasConfiguredAuth: () => true,
  });
  assert.equal(codex.status("owner").configured, true);
});
