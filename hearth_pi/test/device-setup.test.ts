// Device and integration setup through Home Assistant config flows (Admin
// access mode): the `flow` action kind's validation, risk levels, secret
// refusal and redaction, receipt summaries, trusted vs untrusted owners, a
// guard-flagged turn and unknown outcomes. The real durable harness, the
// offline faux provider and synthetic Home Assistant fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adminHarness,
  CONFIG_ENTRIES,
  DISCOVERED_FLOW,
  fakeAdminHA,
  flowForm,
  HEARTH_FLOW_ID,
  TOKEN,
} from "./admin-fixtures.js";
import { adminAction } from "../src/admin.js";
import {
  FLOW_LINK,
  SECRET_FIELD,
  flowAction,
  assertFlowCurrent,
  flowSummary,
  knownFlows,
} from "../src/flow-setup.js";
import { HA_ADMIN_WEBSOCKET_TYPES, ADMIN_PROMPT } from "../src/ha-admin.js";
import { HA_WEBSOCKET_TYPES } from "../src/ha-websocket.js";
import {
  REMOTE_ACCESS_HANDLERS,
  classifyAction,
  confirmationWord,
} from "../src/risk.js";
import { actionHeadline } from "../src/approval-push.js";
import { haExtension } from "../src/ha.js";
import { bundledSkills } from "../src/skills.js";
import { InjectionGuard } from "../src/injection-guard.js";
import type { FlowAction, Proposal } from "../src/documents.js";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { SubmissionId } from "@earendil-works/pi-durable";

const DIRECT = { direct: true } as const;
const init = (handler = "example_printer") => ({ op: "init", handler });
const hearthStep = (userInput: Record<string, unknown>) => ({
  op: "step",
  handler: "example_printer",
  flowId: HEARTH_FLOW_ID,
  userInput,
});
const light = {
  domain: "light",
  service: "turn_on",
  target: { entity_id: ["light.kitchen"] },
  data: { brightness: 100 },
};
// Each test's harness: an admin install with a started printer flow.
async function started(options: Parameters<typeof adminHarness>[0] = {}) {
  const f = await adminHarness(options);
  await f.mode("ask");
  const r = await f.run("ha_flow_propose", init(), "Add my printer");
  assert.equal(r?.status, "pending");
  await f.ha.actions.decide("owner", f.id, r!.id, r!.hash, "approve");
  return f;
}

test("flow actions: strict validation of handler, flow id, op shape and flat non-secret user input", () => {
  assert.deepEqual(
    flowAction({ kind: "flow", op: "init", handler: "17track" }),
    {
      kind: "flow",
      op: "init",
      handler: "17track",
    },
  );
  const step = flowAction({
    kind: "flow",
    op: "step",
    handler: "example_hub",
    flowId: "01ABCDEF",
    userInput: { host: "hub.example", port: 80, ssl: false, name: null },
  });
  assert.deepEqual((step as Extract<FlowAction, { op: "step" }>).userInput, {
    host: "hub.example",
    port: 80,
    ssl: false,
    name: null,
  });
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ op: "init", handler: "Example" }, /invalid_flow_handler/],
    [{ op: "init", handler: "a/b" }, /invalid_flow_handler/],
    [{ op: "init", handler: "x".repeat(65) }, /invalid_request/],
    [{ op: "init", handler: "ok", flowId: "01ABCDEF" }, /invalid_request/],
    [{ op: "configure", handler: "ok" }, /invalid_flow_op/],
    [{ op: "abort", handler: "ok", flowId: "../etc" }, /invalid_flow_id/],
    [{ op: "abort", handler: "ok", flowId: "short" }, /invalid_flow_id/],
    [
      { op: "abort", handler: "ok", flowId: "01ABCDEF", userInput: {} },
      /invalid_request/,
    ],
    [
      { op: "step", handler: "ok", flowId: "01ABCDEF", userInput: [] },
      /invalid_flow_input/,
    ],
    [
      {
        op: "step",
        handler: "ok",
        flowId: "01ABCDEF",
        userInput: { host: { nested: 1 } },
      },
      /invalid_flow_input/,
    ],
    [
      {
        op: "step",
        handler: "ok",
        flowId: "01ABCDEF",
        userInput: { hosts: ["a", "b"] },
      },
      /invalid_flow_input/,
    ],
    [
      {
        op: "step",
        handler: "ok",
        flowId: "01ABCDEF",
        userInput: { host: "x".repeat(257) },
      },
      /invalid_flow_input/,
    ],
    [
      {
        op: "step",
        handler: "ok",
        flowId: "01ABCDEF",
        userInput: { host: "a\nb" },
      },
      /invalid_flow_input/,
    ],
    [
      {
        op: "step",
        handler: "ok",
        flowId: "01ABCDEF",
        userInput: { port: Number.NaN },
      },
      /invalid_flow_input/,
    ],
    [
      {
        op: "step",
        handler: "ok",
        flowId: "01ABCDEF",
        userInput: JSON.parse('{"__proto__": "x"}'),
      },
      /invalid_flow_input/,
    ],
    [
      {
        op: "step",
        handler: "ok",
        flowId: "01ABCDEF",
        userInput: Object.fromEntries(
          Array.from({ length: 21 }, (_, i) => [`f${i}`, i]),
        ),
      },
      /flow_input_too_large/,
    ],
  ];
  for (const [value, error] of bad)
    assert.throws(() => flowAction({ kind: "flow", ...value }), error);
  // The admin action entry point routes the new kind.
  assert.equal(
    adminAction({ kind: "flow", op: "init", handler: "ok" }).kind,
    "flow",
  );
});

test("flow actions: secret-looking field names and credential-shaped values are refused before anything is stored", () => {
  for (const name of [
    "password",
    "PASSWORD",
    "access_token",
    "api_key",
    "pin",
    "pin_code",
    "code",
    "client_secret",
    "pairing_code",
    "psk",
    "otp",
    "credentials",
    "certificate",
  ]) {
    assert.ok(SECRET_FIELD.test(name), name);
    assert.throws(
      () =>
        flowAction({
          kind: "flow",
          op: "step",
          handler: "example_hub",
          flowId: "01ABCDEF",
          userInput: { [name]: "SECRET_CANARY" },
        }),
      (error: Error) =>
        /flow_secret_field/.test(error.message) &&
        !error.message.includes("SECRET_CANARY"),
      name,
    );
  }
  for (const value of [
    "Bearer abcdefghijklmnop",
    "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig",
    "sk-abcdefghijklmnop",
    "-----BEGIN CERTIFICATE-----",
  ])
    assert.throws(
      () =>
        flowAction({
          kind: "flow",
          op: "step",
          handler: "example_hub",
          flowId: "01ABCDEF",
          userInput: { host: value },
        }),
      /flow_secret_value/,
    );
  // A configured credential (here the HA token) in any field is refused too.
  const { ha } = fakeAdminHA();
  assert.throws(
    () =>
      ha.action({
        kind: "flow",
        op: "step",
        handler: "example_hub",
        flowId: "01ABCDEF",
        userInput: { host: `x${TOKEN}` },
      }),
    /flow_secret_value/,
  );
  // Scoped mode has no flow action at all.
  const scoped = fakeAdminHA({ access: "scoped" });
  assert.throws(
    () => scoped.ha.action({ kind: "flow", op: "init", handler: "ok" }),
    /admin_mode_required/,
  );
});

test("flow risk: every setup step is high; Hearth's own handler and remote-access integrations are critical with the handler as the typed word", () => {
  const level = (action: FlowAction) => classifyAction(action);
  for (const action of [
    { kind: "flow", op: "init", handler: "example_hub" },
    {
      kind: "flow",
      op: "step",
      handler: "example_hub",
      flowId: "01ABCDEF",
      stepId: "user",
      userInput: { host: "hub.example" },
    },
    { kind: "flow", op: "abort", handler: "example_hub", flowId: "01ABCDEF" },
  ] as FlowAction[]) {
    const risk = level(action);
    assert.equal(risk.level, "high", action.op);
    assert.match(risk.rule, /^integration_setup/);
  }
  // Cancelling a discovered flow does not promise when it comes back.
  const cancel = level({
    kind: "flow",
    op: "abort",
    handler: "example_hub",
    flowId: "01ABCDEF",
    source: "discovered",
  });
  assert.match(
    cancel.reasons.join(" "),
    /that Home Assistant discovered; Home Assistant may offer it again/,
  );
  assert.ok(!/leaves the Discovered list/.test(cancel.reasons.join(" ")));
  assert.deepEqual([...REMOTE_ACCESS_HANDLERS].sort(), [
    "cloud",
    "homekit",
    "mcp_server",
    "remote_homeassistant",
  ]);
  for (const handler of REMOTE_ACCESS_HANDLERS) {
    const action: FlowAction = { kind: "flow", op: "init", handler };
    assert.deepEqual(
      [level(action).level, level(action).rule],
      ["critical", "remote_access_integration"],
    );
    assert.equal(confirmationWord(action), handler);
  }
  const self = level({ kind: "flow", op: "init", handler: "hearth_pi" });
  assert.deepEqual([self.level, self.rule], ["critical", "self_protection"]);
  const pointsAtSelf = classifyAction(
    {
      kind: "flow",
      op: "step",
      handler: "example_hub",
      flowId: "01ABCDEF",
      userInput: { url: "http://abc123-hearth-pi:8099" },
    },
    { selfSlug: "abc123_hearth_pi" },
  );
  assert.equal(pointsAtSelf.level, "critical");
  // The phone headline names only the handler and op, never values.
  const headline = actionHeadline({
    kind: "flow",
    op: "step",
    handler: "example_hub",
    flowId: "01ABCDEF",
    stepId: "user",
    userInput: { host: "VALUE_CANARY" },
  });
  assert.equal(headline, "example_hub setup step user");
});

test("flow summaries: only names, types, codes and an entry title; secret fields marked; placeholders, defaults, descriptions and URLs dropped", () => {
  const redact = (s: string) => s.split(TOKEN).join("[REDACTED]");
  const action: FlowAction = {
    kind: "flow",
    op: "init",
    handler: "example_printer",
  };
  const form = flowSummary(flowForm("example_printer"), redact, action);
  assert.deepEqual(form, {
    type: "form",
    flowId: HEARTH_FLOW_ID,
    handler: "example_printer",
    stepId: "user",
    fields: [
      { name: "host", type: "string", required: true },
      { name: "password", type: "string", required: false, secret: true },
      {
        name: "account",
        type: "selector:text",
        required: false,
        secret: true,
      },
      {
        name: "mode",
        type: "selector:select",
        required: true,
        options: ["local", "cloud"],
      },
    ],
    continueIn: "/config/integrations/dashboard/add?domain=example_printer",
  });
  const text = JSON.stringify(form);
  for (const canary of ["DEFAULT_CANARY", "PLACEHOLDER_CANARY"])
    assert.ok(!text.includes(canary), canary);
  const created = flowSummary(
    {
      type: "create_entry",
      flow_id: HEARTH_FLOW_ID,
      handler: "example_printer",
      title: `Printer ${TOKEN}\nnext`,
      description: "DESCRIPTION_CANARY",
      data: { password: "DATA_CANARY" },
      result: { entry_id: "entry_new_1", data: { token: "RESULT_CANARY" } },
    },
    redact,
    action,
  );
  assert.deepEqual(created, {
    type: "create_entry",
    flowId: HEARTH_FLOW_ID,
    handler: "example_printer",
    entryId: "entry_new_1",
    title: "Printer [REDACTED] next",
    continueIn: "/config/integrations/integration/example_printer",
  });
  const external = flowSummary(
    {
      type: "external",
      flow_id: "01DISCOVEREDFLOW000000001",
      handler: "example_hub",
      step_id: "auth",
      url: "https://login.example/authorize?state=URL_CANARY",
    },
    redact,
    {
      kind: "flow",
      op: "step",
      handler: "example_hub",
      flowId: "01DISCOVEREDFLOW000000001",
      source: "discovered",
      userInput: {},
    },
  );
  assert.equal(external.continueIn, "/config/integrations/dashboard");
  assert.ok(!JSON.stringify(external).includes("URL_CANARY"));
  const menu = flowSummary(
    {
      type: "menu",
      flow_id: HEARTH_FLOW_ID,
      handler: "example_hub",
      step_id: "pick",
      menu_options: { local: "Local", "bad key!": "x" },
      errors: { base: "cannot_connect", host: "<b>html</b>" },
    },
    redact,
    action,
  );
  assert.deepEqual(menu.menuOptions, ["local"]);
  assert.deepEqual(menu.errors, { base: "cannot_connect" });
  assert.equal(menu.continueIn, undefined);
  // Garbage is bounded to an "unknown" summary, never thrown.
  assert.deepEqual(flowSummary("<html>", redact, action), { type: "unknown" });
  const many = flowSummary(
    {
      type: "form",
      data_schema: Array.from({ length: 80 }, (_, i) => ({
        name: `f${i}`,
        type: "string",
      })),
    },
    redact,
    action,
  );
  assert.equal(many.fields?.length, 30);
  // Every link the server builds passes the browser's fixed-path rule.
  for (const path of [
    "/config/integrations/dashboard",
    "/config/integrations/dashboard/add?domain=example_hub",
    "/config/integrations/integration/example_hub",
  ])
    assert.ok(FLOW_LINK.test(path), path);
  for (const path of [
    "https://evil.example/",
    "//evil.example",
    "/config/integrations/dashboard/add?domain=x&y=1",
    "javascript:alert(1)",
  ])
    assert.ok(!FLOW_LINK.test(path), path);
});

test("knownFlows: only flows Hearth started (from Home Assistant's own reply), their current step, secret fields and end", () => {
  const receipt = (
    id: string,
    action: FlowAction,
    flowResult: Proposal["flowResult"],
    status: Proposal["status"] = "accepted",
    attemptedAt = Number(id),
  ) =>
    ({
      id,
      action,
      status,
      attemptedAt,
      flowResult,
    }) as Proposal;
  const items = {
    "1": receipt(
      "1",
      { kind: "flow", op: "init", handler: "example_printer" },
      {
        type: "form",
        flowId: HEARTH_FLOW_ID,
        handler: "example_printer",
        stepId: "user",
        fields: [
          { name: "host", type: "string", required: true },
          {
            name: "account",
            type: "selector:text",
            required: false,
            secret: true,
          },
        ],
      },
    ),
    // A step on a flow Hearth never started is not adopted.
    "2": receipt(
      "2",
      {
        kind: "flow",
        op: "step",
        handler: "cloud",
        flowId: "01FOREIGNFLOW000000001",
        userInput: {},
      },
      { type: "form", flowId: "01FOREIGNFLOW000000001", handler: "cloud" },
    ),
    // Pending/failed receipts do not move a flow on.
    "3": receipt(
      "3",
      {
        kind: "flow",
        op: "step",
        handler: "example_printer",
        flowId: HEARTH_FLOW_ID,
        userInput: { host: "a" },
      },
      { type: "create_entry" },
      "failed",
    ),
  };
  const flows = knownFlows(items);
  assert.deepEqual([...flows.keys()], [HEARTH_FLOW_ID]);
  assert.deepEqual(flows.get(HEARTH_FLOW_ID), {
    handler: "example_printer",
    source: "hearth",
    stepId: "user",
    secretFields: ["account"],
    finished: false,
  });
  // Hearth's own accepted step on a flow the controller found in Home
  // Assistant's discovered list is adopted (source "discovered"), so the
  // password fields of its next step are known.
  const discovered = knownFlows({
    ...items,
    "5": receipt(
      "5",
      {
        kind: "flow",
        op: "step",
        handler: "example_hub",
        flowId: DISCOVERED_FLOW.flow_id,
        stepId: "confirm",
        source: "discovered",
        userInput: {},
      },
      {
        type: "form",
        flowId: DISCOVERED_FLOW.flow_id,
        handler: "example_hub",
        stepId: "auth",
        fields: [
          {
            name: "account",
            type: "selector:text",
            required: false,
            secret: true,
          },
        ],
      },
    ),
  });
  assert.deepEqual(discovered.get(DISCOVERED_FLOW.flow_id), {
    handler: "example_hub",
    source: "discovered",
    stepId: "auth",
    secretFields: ["account"],
    finished: false,
  });
  const done = knownFlows({
    ...items,
    "4": receipt(
      "4",
      {
        kind: "flow",
        op: "step",
        handler: "example_printer",
        flowId: HEARTH_FLOW_ID,
        userInput: { host: "a" },
      },
      { type: "create_entry", entryId: "e1" },
    ),
  });
  assert.equal(done.get(HEARTH_FLOW_ID)?.finished, true);
});

test("Ask: start a flow, read Home Assistant's next step from the receipt, then submit one non-secret step; secrets and unverified flows are refused", async () => {
  const f = await started();
  try {
    const first = (await f.receipts()).at(-1)!;
    assert.equal(first.status, "accepted");
    assert.deepEqual(f.writes.at(-1), {
      method: "POST",
      url: "config/config_entries/flow",
      body: { handler: "example_printer" },
    });
    assert.equal(first.risk?.level, "high");
    assert.equal(first.risk?.rule, "integration_setup");
    assert.equal(first.flowResult?.type, "form");
    assert.equal(first.flowResult?.flowId, HEARTH_FLOW_ID);
    assert.deepEqual(
      first.flowResult?.fields?.filter((x) => x.secret).map((x) => x.name),
      ["password", "account"],
    );
    assert.equal(
      first.flowResult?.continueIn,
      "/config/integrations/dashboard/add?domain=example_printer",
    );
    // A secret field by name: refused by validation, nothing stored.
    const writes = f.writes.length;
    const count = (await f.receipts()).length;
    await f.run(
      "ha_flow_propose",
      hearthStep({ host: "printer.example", password: "SECRET_CANARY" }),
    );
    assert.equal((await f.receipts()).length, count);
    assert.match(await f.toolResults(), /flow_secret_field/);
    // Home Assistant's password selector on an innocuous name: refused too.
    const refusals = async () =>
      (await f.toolResults()).split("flow_secret_field").length;
    const before = await refusals();
    await f.run(
      "ha_flow_propose",
      hearthStep({ host: "printer.example", account: "SECRET_CANARY" }),
    );
    assert.equal((await f.receipts()).length, count);
    assert.ok((await refusals()) > before, "refused as a secret field");
    // A handler that differs from the flow Hearth started: refused.
    await f.run("ha_flow_propose", {
      ...hearthStep({ host: "printer.example" }),
      handler: "cloud",
    });
    assert.match(await f.toolResults(), /flow_handler_mismatch/);
    // A flow id neither Home Assistant nor Hearth's receipts know: refused.
    await f.run("ha_flow_propose", {
      ...hearthStep({ host: "printer.example" }),
      flowId: "01UNKNOWNFLOW00000000001",
    });
    assert.match(await f.toolResults(), /flow_not_found/);
    assert.equal((await f.receipts()).length, count);
    assert.equal(f.writes.length, writes, "nothing was sent");
    // The refused secret never lands in a receipt (the model's own call
    // arguments stay in its transcript; it must never have one to send).
    assert.ok(!JSON.stringify(await f.receipts()).includes("SECRET_CANARY"));
    // Home Assistant's defaults and placeholders reach neither the receipts,
    // the session snapshot nor anything the model saw.
    const snapshot = JSON.stringify(await f.runtime.snapshot("owner", f.id));
    for (const text of [
      snapshot,
      JSON.stringify(await f.receipts()),
      await f.toolResults(),
    ])
      for (const canary of ["DEFAULT_CANARY", "PLACEHOLDER_CANARY"])
        assert.ok(!text.includes(canary), canary);
    // The non-secret step: handler, step and source are the controller's.
    const step = await f.run(
      "ha_flow_propose",
      hearthStep({ host: "printer.example", mode: "local" }),
    );
    assert.equal(step?.status, "pending");
    assert.deepEqual(step?.action, {
      kind: "flow",
      op: "step",
      handler: "example_printer",
      flowId: HEARTH_FLOW_ID,
      stepId: "user",
      source: "hearth",
      userInput: { host: "printer.example", mode: "local" },
    });
    assert.equal(step?.risk?.rule, "integration_setup_step");
    await f.ha.actions.decide("owner", f.id, step!.id, step!.hash, "approve");
    const done = (await f.receipts()).at(-1)!;
    assert.equal(done.status, "accepted");
    assert.deepEqual(f.writes.at(-1), {
      method: "POST",
      url: `config/config_entries/flow/${HEARTH_FLOW_ID}`,
      body: { host: "printer.example", mode: "local" },
    });
    assert.deepEqual(done.flowResult, {
      type: "create_entry",
      flowId: HEARTH_FLOW_ID,
      handler: "example_printer",
      entryId: "entry_new_1",
      title: "Example Printer [REDACTED]",
      continueIn: "/config/integrations/integration/example_printer",
    });
    assert.ok(!JSON.stringify(done).includes("DESCRIPTION_CANARY"));
    assert.ok(!JSON.stringify(done).includes(TOKEN));
    // The flow ended: a further step on it is refused.
    await f.run("ha_flow_propose", hearthStep({ host: "again.example" }));
    assert.match(await f.toolResults(), /flow_not_found/);
  } finally {
    await f.close();
  }
});

test("discovered flows: read with ha_integrations_read, stepped with the controller's handler and step, re-checked before sending", async () => {
  const progress = [DISCOVERED_FLOW];
  const f = await adminHarness({ progress });
  try {
    await f.mode("ask");
    const r = await f.run(
      "ha_flow_propose",
      {
        op: "step",
        handler: "example_hub",
        flowId: DISCOVERED_FLOW.flow_id,
        userInput: {},
      },
      "Add the hub it found",
      [{ tool: "ha_integrations_read", args: { source: "discovered" } }],
    );
    const seen = await f.toolResults();
    assert.match(seen, /Example Hub/);
    assert.match(
      seen,
      /\\"continueIn\\":\\"\/config\/integrations\/dashboard\\"/,
    );
    assert.ok(!seen.includes("UNIQUE_ID_CANARY"));
    assert.deepEqual(r?.action, {
      kind: "flow",
      op: "step",
      handler: "example_hub",
      flowId: DISCOVERED_FLOW.flow_id,
      stepId: "confirm",
      source: "discovered",
      userInput: {},
    });
    // Someone moved the flow on in Home Assistant meanwhile: refused at
    // dispatch, nothing sent, and the proposal stays pending.
    progress[0] = { ...DISCOVERED_FLOW, step_id: "other" };
    const writes = f.writes.length;
    await assert.rejects(
      f.ha.actions.decide("owner", f.id, r!.id, r!.hash, "approve"),
      /flow_changed/,
    );
    assert.equal(f.writes.length, writes);
    progress[0] = DISCOVERED_FLOW;
    await f.ha.actions.decide("owner", f.id, r!.id, r!.hash, "approve");
    assert.equal((await f.receipts()).at(-1)?.flowResult?.type, "create_entry");
    // Handlers and entries: domains only; entry data/options never.
    await f.run("ha_integrations_read", {
      source: "handlers",
      query: "example",
    });
    const handlers = await f.toolResults();
    assert.match(handlers, /example_printer/);
    await f.run("ha_integrations_read", { source: "entries" });
    const entries = await f.toolResults();
    assert.match(entries, /entry_example_1/);
    for (const canary of ["ENTRY_DATA_CANARY", "ENTRY_OPTIONS_CANARY"])
      assert.ok(!entries.includes(canary), canary);
    assert.ok(CONFIG_ENTRIES.length > 0);
  } finally {
    await f.close();
  }
});

test("assertFlowCurrent: a Hearth-started flow step is sent only at the step it was made for, and never while another action on the flow is being sent", () => {
  const step = (
    id: string,
    stepId: string,
    status: Proposal["status"] = "pending",
  ) =>
    ({
      id,
      status,
      action: {
        kind: "flow",
        op: "step",
        handler: "example_printer",
        flowId: HEARTH_FLOW_ID,
        stepId,
        source: "hearth",
        userInput: { host: "printer.example" },
      },
    }) as unknown as Proposal;
  const start = {
    id: "1",
    status: "accepted",
    attemptedAt: 1,
    action: { kind: "flow", op: "init", handler: "example_printer" },
    flowResult: {
      type: "form",
      flowId: HEARTH_FLOW_ID,
      handler: "example_printer",
      stepId: "user",
    },
  } as Proposal;
  const current = step("2", "user");
  assert.doesNotThrow(() =>
    assertFlowCurrent({ "1": start, "2": current }, current),
  );
  // The flow moved on to another step: refused.
  const moved = {
    ...start,
    flowResult: { ...start.flowResult!, stepId: "details" },
  } as Proposal;
  assert.throws(
    () => assertFlowCurrent({ "1": moved, "2": current }, current),
    /flow_changed/,
  );
  // Another action on the same flow is being sent: refused.
  const sending = step("3", "user", "dispatching");
  assert.throws(
    () =>
      assertFlowCurrent({ "1": start, "2": current, "3": sending }, current),
    /flow_changed/,
  );
  // No receipt of Hearth's own start: refused.
  assert.throws(
    () => assertFlowCurrent({ "2": current }, current),
    /flow_changed/,
  );
});

test("discovered flows: Home Assistant's password selector on the next step is refused; a flow Home Assistant no longer lists is not found", async () => {
  const progress = [DISCOVERED_FLOW];
  const f = await adminHarness({
    progress,
    flow: (method, path) =>
      method === "POST" &&
      path === `config/config_entries/flow/${DISCOVERED_FLOW.flow_id}`
        ? Response.json({
            type: "form",
            flow_id: DISCOVERED_FLOW.flow_id,
            handler: "example_hub",
            step_id: "auth",
            data_schema: [
              { name: "host", type: "string", required: true },
              { name: "account", selector: { text: { type: "password" } } },
            ],
          })
        : undefined,
  });
  const discoveredStep = (userInput: Record<string, unknown>) => ({
    op: "step",
    handler: "example_hub",
    flowId: DISCOVERED_FLOW.flow_id,
    userInput,
  });
  try {
    await f.mode("ask");
    const r = await f.run("ha_flow_propose", discoveredStep({}));
    assert.equal(
      (r?.action as FlowAction & { op: "step" }).source,
      "discovered",
    );
    await f.ha.actions.decide("owner", f.id, r!.id, r!.hash, "approve");
    const first = (await f.receipts()).at(-1)!;
    assert.equal(first.status, "accepted");
    assert.equal(first.flowResult?.stepId, "auth");
    assert.deepEqual(
      first.flowResult?.fields?.filter((x) => x.secret).map((x) => x.name),
      ["account"],
    );
    // Home Assistant now lists the flow at its next step.
    progress[0] = { ...DISCOVERED_FLOW, step_id: "auth" };
    const writes = f.writes.length;
    const count = (await f.receipts()).length;
    const refusals = async (code: string) =>
      (await f.toolResults()).split(code).length;
    const secret = await refusals("flow_secret_field");
    await f.run(
      "ha_flow_propose",
      discoveredStep({ account: "SECRET_CANARY" }),
    );
    assert.ok((await refusals("flow_secret_field")) > secret);
    assert.equal((await f.receipts()).length, count, "nothing stored");
    assert.equal(f.writes.length, writes, "nothing was sent");
    assert.ok(!JSON.stringify(await f.receipts()).includes("SECRET_CANARY"));
    // A non-secret value for the same step is a normal proposal.
    const host = await f.run(
      "ha_flow_propose",
      discoveredStep({ host: "hub.example" }),
    );
    assert.equal(host?.status, "pending");
    assert.equal((host?.action as FlowAction & { op: "step" }).stepId, "auth");
    // The flow vanished from Home Assistant's list: Hearth's own receipt
    // for it does not make it a flow Hearth started.
    progress.length = 0;
    const missing = await refusals("flow_not_found");
    await f.run("ha_flow_propose", discoveredStep({ host: "hub.example" }));
    assert.ok((await refusals("flow_not_found")) > missing);
    assert.equal(f.writes.length, writes);
  } finally {
    await f.close();
  }
});

test("discovered list: reauth, reconfigure, import, system and user flows are listed but never stepped or cancelled", async () => {
  const progress: Record<string, unknown>[] = [];
  const f = await adminHarness({ progress });
  try {
    await f.mode("ask");
    for (const source of [
      "reauth",
      "reconfigure",
      "import",
      "system",
      "user",
    ]) {
      progress[0] = {
        ...DISCOVERED_FLOW,
        context: { ...DISCOVERED_FLOW.context, source },
      };
      await f.run("ha_integrations_read", { source: "discovered" });
      assert.match(
        await f.toolResults(),
        new RegExp(`\\\\"source\\\\":\\\\"${source}\\\\"`),
      );
      for (const action of [
        {
          op: "step",
          handler: "example_hub",
          flowId: DISCOVERED_FLOW.flow_id,
          userInput: {},
        },
        {
          op: "abort",
          handler: "example_hub",
          flowId: DISCOVERED_FLOW.flow_id,
        },
      ]) {
        const before = (await f.toolResults()).split(
          "flow_source_not_supported",
        ).length;
        await f.run("ha_flow_propose", action);
        assert.ok(
          (await f.toolResults()).split("flow_source_not_supported").length >
            before,
          `${source} ${action.op}`,
        );
      }
    }
    assert.equal((await f.receipts()).length, 0);
    // A discovery flow whose source turns into one of these before the
    // approval is refused at dispatch, and nothing is sent.
    progress[0] = DISCOVERED_FLOW;
    const r = await f.run("ha_flow_propose", {
      op: "step",
      handler: "example_hub",
      flowId: DISCOVERED_FLOW.flow_id,
      userInput: {},
    });
    assert.equal(r?.status, "pending");
    progress[0] = {
      ...DISCOVERED_FLOW,
      context: { ...DISCOVERED_FLOW.context, source: "reauth" },
    };
    const writes = f.writes.length;
    await assert.rejects(
      f.ha.actions.decide("owner", f.id, r!.id, r!.hash, "approve"),
      /flow_source_not_supported/,
    );
    assert.equal(f.writes.length, writes);
    assert.equal((await f.receipts()).at(-1)?.status, "pending");
  } finally {
    await f.close();
  }
});

test("Hearth-started flows: a stale pending step is refused at dispatch once an earlier one moved the flow on; the next step proposed from the receipt runs", async () => {
  const f = await started({
    flow: (method, path) =>
      method === "POST" &&
      path === `config/config_entries/flow/${HEARTH_FLOW_ID}`
        ? Response.json({
            type: "form",
            flow_id: HEARTH_FLOW_ID,
            handler: "example_printer",
            step_id: "details",
            data_schema: [{ name: "room", type: "string" }],
          })
        : undefined,
  });
  try {
    const a = await f.run(
      "ha_flow_propose",
      hearthStep({ host: "a.example", mode: "local" }),
    );
    const b = await f.run(
      "ha_flow_propose",
      hearthStep({ host: "b.example", mode: "local" }),
    );
    assert.deepEqual([a?.status, b?.status], ["pending", "pending"]);
    await f.ha.actions.decide("owner", f.id, a!.id, a!.hash, "approve");
    const moved = (await f.receipts()).find((p) => p.id === a!.id)!;
    assert.equal(moved.status, "accepted");
    assert.equal(moved.flowResult?.stepId, "details");
    // b was made for step "user"; the flow is now at "details".
    const writes = f.writes.length;
    await assert.rejects(
      f.ha.actions.decide("owner", f.id, b!.id, b!.hash, "approve"),
      /flow_changed/,
    );
    assert.equal(f.writes.length, writes, "nothing was sent");
    assert.equal(
      (await f.receipts()).find((p) => p.id === b!.id)?.status,
      "pending",
    );
    const c = await f.run("ha_flow_propose", hearthStep({ room: "Study" }));
    assert.equal((c?.action as FlowAction & { op: "step" }).stepId, "details");
    await f.ha.actions.decide("owner", f.id, c!.id, c!.hash, "approve");
    assert.equal(
      (await f.receipts()).find((p) => p.id === c!.id)?.status,
      "accepted",
    );
    // A step still pending when the flow was cancelled is refused.
    const stale = await f.run("ha_flow_propose", hearthStep({ room: "Study" }));
    const abort = await f.run("ha_flow_propose", {
      op: "abort",
      handler: "example_printer",
      flowId: HEARTH_FLOW_ID,
    });
    await f.ha.actions.decide("owner", f.id, abort!.id, abort!.hash, "approve");
    await assert.rejects(
      f.ha.actions.decide("owner", f.id, stale!.id, stale!.hash, "approve"),
      /flow_changed/,
    );
  } finally {
    await f.close();
  }
});

test("Full access: an untrusted owner's setup step always waits (high); a trusted owner's own direct turn runs it; critical integrations need the typed word", async () => {
  const untrusted = await adminHarness();
  try {
    await untrusted.mode("full");
    const r = await untrusted.run("ha_flow_propose", init());
    assert.deepEqual(
      [r?.status, r?.risk?.level, r?.authorization?.source],
      ["pending", "high", "human"],
    );
    assert.equal(
      untrusted.writes.filter((w) => w.url.startsWith("config/config_entries"))
        .length,
      0,
    );
    const critical = await untrusted.run("ha_flow_propose", init("homekit"));
    assert.deepEqual(
      [critical?.status, critical?.risk?.level, critical?.confirmation],
      ["pending", "critical", "homekit"],
    );
    await assert.rejects(
      untrusted.ha.actions.decide(
        "owner",
        untrusted.id,
        critical!.id,
        critical!.hash,
        "approve",
      ),
      /confirmation_required/,
    );
    await untrusted.ha.actions.decide(
      "owner",
      untrusted.id,
      critical!.id,
      critical!.hash,
      "approve",
      "",
      "homekit",
    );
    assert.equal((await untrusted.receipts()).at(-1)?.status, "accepted");
  } finally {
    await untrusted.close();
  }
  const trusted = await adminHarness({ trusted: ["owner"], submit: DIRECT });
  try {
    await trusted.mode("full");
    const r = await trusted.run("ha_flow_propose", init());
    assert.deepEqual(
      [r?.status, r?.risk?.level, r?.authorization?.source],
      ["accepted", "high", "trusted"],
    );
    assert.equal(r?.flowResult?.flowId, HEARTH_FLOW_ID);
  } finally {
    await trusted.close();
  }
});

test("guard-flagged turn: a trusted owner's setup step waits for exact approval", async () => {
  const f = await adminHarness({ trusted: ["owner"], submit: DIRECT });
  try {
    const fetcher = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { texts: string[] };
      return Response.json({
        scanned: true,
        results: body.texts.map((t) =>
          t.includes("ATTRIBUTE_CANARY")
            ? { score: 0.97, flagged: true }
            : { score: 0.01, flagged: false },
        ),
      });
    }) as typeof fetch;
    f.ha.actions.useInjectionGuard(
      new InjectionGuard(
        { url: "http://10.0.0.5:8090", apiKey: "k", timeoutMs: 500 },
        { fetcher, log: () => {} },
      ),
    );
    await f.mode("full");
    const r = await f.run("ha_flow_propose", init(), "Add my printer", [
      { tool: "ha_search_states", args: { query: "canary", offset: 0 } },
    ]);
    assert.deepEqual(
      [r?.status, r?.authorization?.source, r?.authorization?.guard],
      ["pending", "human", "flagged"],
    );
    assert.equal(
      f.writes.filter((w) => w.url.startsWith("config/config_entries")).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("outcomes: refused values and unknown flows fail definitely; network errors and 5xx stay unknown, pause every write and are never retried", async () => {
  let mode: "invalid" | "missing" | "network" | "error" = "invalid";
  const f = await started({
    flow: (method, path) => {
      if (path === "config/config_entries/flow") return;
      if (mode === "invalid")
        return Response.json(
          { errors: { host: "expected str for dictionary value" } },
          { status: 400 },
        );
      if (mode === "missing")
        return Response.json(
          { message: "Invalid flow specified" },
          { status: 404 },
        );
      if (mode === "network") return "network";
      return new Response("boom", { status: 500 });
    },
  });
  try {
    const propose = async () => {
      const r = await f.run(
        "ha_flow_propose",
        hearthStep({ host: "printer.example" }),
      );
      assert.equal(r?.status, "pending");
      await f.ha.actions.decide("owner", f.id, r!.id, r!.hash, "approve");
      return (await f.receipts()).at(-1)!;
    };
    const invalid = await propose();
    assert.equal(invalid.status, "failed");
    assert.match(invalid.resolution, /refused these values/);
    assert.deepEqual(invalid.flowResult?.errors, { host: "invalid_value" });
    mode = "missing";
    const missing = await propose();
    assert.equal(missing.status, "failed");
    assert.match(missing.resolution, /HTTP 404/);
    mode = "network";
    const sent = f.writes.length;
    const unknown = await propose();
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.scope, undefined, "a flow can reach anything");
    assert.equal(unknown.flowResult, undefined);
    assert.equal(f.writes.length, sent + 1, "sent once, never retried");
    // Every other write is paused until a person resolves it.
    await f.run("ha_call_service", light);
    assert.match(await f.toolResults(), /home_outcome_unresolved/);
    await f.ha.actions.decide(
      "owner",
      f.id,
      unknown.id,
      unknown.hash,
      "resolve",
      "Checked Devices & services: not added.",
    );
    mode = "error";
    const failed500 = await propose();
    assert.equal(failed500.status, "unknown");
    assert.equal(f.writes.length, sent + 2);
  } finally {
    await f.close();
  }
});

test("abort: cancels the flow Hearth started; tools, prompt and skill are present in Admin mode only and roles keep them owner-only", async () => {
  const f = await started();
  try {
    const r = await f.run("ha_flow_propose", {
      op: "abort",
      handler: "example_printer",
      flowId: HEARTH_FLOW_ID,
    });
    assert.equal(r?.risk?.rule, "integration_setup_abort");
    await f.ha.actions.decide("owner", f.id, r!.id, r!.hash, "approve");
    assert.deepEqual(f.writes.at(-1), {
      method: "DELETE",
      url: `config/config_entries/flow/${HEARTH_FLOW_ID}`,
      body: undefined,
    });
    const done = (await f.receipts()).at(-1)!;
    assert.equal(done.flowResult?.type, "abort");
    assert.equal(done.flowResult?.reason, "cancelled");
  } finally {
    await f.close();
  }
  const names = (role?: "member" | "guest", access?: "scoped") =>
    haExtension(fakeAdminHA({ access }).ha, role ? { role } : {}).tools!.map(
      (t) => t.name,
    );
  assert.ok(names().includes("ha_flow_propose"));
  assert.ok(names().includes("ha_integrations_read"));
  assert.ok(!names(undefined, "scoped").includes("ha_flow_propose"));
  assert.ok(!names(undefined, "scoped").includes("ha_integrations_read"));
  assert.ok(!names("guest").includes("ha_flow_propose"));
  assert.ok(!names("guest").includes("ha_integrations_read"));
  assert.ok(!names("member").includes("ha_integrations_read"));
  // Admin-only WebSocket reads: never in the scoped read allowlist.
  for (const type of ["config_entries/flow/progress", "config_entries/get"]) {
    assert.ok(HA_ADMIN_WEBSOCKET_TYPES.includes(type), type);
    assert.ok(!(HA_WEBSOCKET_TYPES as readonly string[]).includes(type), type);
  }
  // True with trusted people too: high and critical wait unless a trusted
  // owner's own direct turn on Full access (not a guard-flagged one).
  assert.ok(!ADMIN_PROMPT.includes("always wait"));
  assert.match(
    ADMIN_PROMPT,
    /high and critical wait for that approval, and critical also needs a typed confirmation, except that a trusted owner's own direct turn on Full access runs at every level with a trusted receipt \(not when the injection guard flagged that turn's tool output\)/,
  );
  assert.match(ADMIN_PROMPT, /ha_flow_propose/);
  assert.match(ADMIN_PROMPT, /add-a-device/);
  assert.match(ADMIN_PROMPT, /Never ask for, accept or repeat passwords/);
  const skill = bundledSkills().find((s) => s.name === "add-a-device");
  assert.ok(skill);
  assert.match(skill.body, /ha_flow_propose/);
  assert.match(skill.body, /never in chat/i);
  assert.match(skill.body, /Scoped mode/);
});

// The system prompt Hearth sends for one turn in the given access mode.
async function promptFor(access?: "scoped") {
  const f = await adminHarness({ access });
  try {
    let prompt = "";
    f.provider.faux.setResponses([
      (context) => {
        prompt = getCurrentSystemPrompt(context.messages);
        return fauxAssistantMessage("Hi.");
      },
    ]);
    const sid = await f.runtime.submit("owner", f.id, "prompt-input-1", "Hi");
    await (await f.runtime.harness.submission(sid as SubmissionId, ctx))!.wait(
      ctx,
    );
    return prompt;
  } finally {
    await f.close();
  }
}

test("prompt: the configuration sentence is true in both access modes; Admin adds device setup guidance and both list the add-a-device skill", async () => {
  const scoped = await promptFor("scoped");
  const admin = await promptFor();
  for (const prompt of [scoped, admin]) {
    assert.ok(!prompt.includes("you cannot create, edit, enable"));
    assert.match(
      prompt,
      /you never change automations, devices, integrations or any Home Assistant configuration directly/,
    );
    assert.match(prompt, /- add-a-device: /);
  }
  assert.ok(!scoped.includes("ha_flow_propose"));
  assert.match(admin, /ha_flow_propose/);
  assert.match(admin, /continueIn/);
});

test("UI: a flow receipt names the step, shows Home Assistant's next step as text and links only fixed Home Assistant paths", async () => {
  const { parseHTML } = await import("linkedom");
  const { document, window } = parseHTML(
    '<html><body><div id="cards"></div></body></html>',
  );
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
  };
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: window,
    configurable: true,
  });
  try {
    const {
      renderProposals,
      flowActionTitle,
      FLOW_LINK: UI_FLOW_LINK,
    } = await import(new URL("../public/render.js", import.meta.url).href);
    assert.equal(String(UI_FLOW_LINK), String(FLOW_LINK));
    const base = {
      created: 1,
      hash: "a".repeat(64),
      policy: "p",
      expires: Date.now() + 60000,
      decidedBy: "",
      decidedAt: 0,
      resolution: "",
      risk: { level: "high", rule: "integration_setup_step", reasons: [] },
    };
    const container = document.getElementById("cards")!;
    renderProposals(
      container,
      {
        "1": {
          ...base,
          id: "1",
          status: "accepted",
          action: {
            kind: "flow",
            op: "step",
            handler: "example_hub",
            flowId: "01DISCOVEREDFLOW000000001",
            stepId: "confirm",
            source: "discovered",
            userInput: { host: "hub.example" },
          },
          flowResult: {
            type: "form",
            stepId: "link",
            fields: [
              { name: "name", type: "string", required: true },
              { name: "pin", type: "string", required: true, secret: true },
            ],
            errors: { base: "cannot_connect" },
            continueIn: "/config/integrations/dashboard",
          },
        },
        "2": {
          ...base,
          id: "2",
          created: 2,
          status: "accepted",
          action: { kind: "flow", op: "init", handler: "example_printer" },
          flowResult: {
            type: "create_entry",
            title: "<img src=x onerror=alert(1)>",
            continueIn: "https://evil.example/",
          },
        },
      },
      () => {},
    );
    const text = container.textContent ?? "";
    assert.match(text, /example_hub setup: step confirm/);
    assert.match(text, /Found by Home Assistant/);
    assert.match(text, /Home Assistant asks next: step link/);
    assert.match(text, /pin \(secret: enter it in Home Assistant\)/);
    assert.match(text, /Errors: base: cannot_connect/);
    assert.match(text, /Added: <img src=x onerror=alert\(1\)>/);
    assert.equal(container.querySelectorAll("img").length, 0);
    const links = [...container.querySelectorAll("a")];
    assert.equal(links.length, 1, "the unexpected URL is never a link");
    assert.equal(
      links[0]!.getAttribute("href"),
      "/config/integrations/dashboard",
    );
    assert.equal(links[0]!.getAttribute("target"), "_top");
    assert.equal(
      flowActionTitle({ kind: "flow", op: "abort", handler: "example_hub" }),
      "Cancel example_hub setup",
    );
  } finally {
    Object.defineProperty(globalThis, "document", {
      value: previous.document,
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: previous.window,
      configurable: true,
    });
  }
});
