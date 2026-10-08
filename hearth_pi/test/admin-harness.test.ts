// Admin access mode end to end: the real durable harness driven by the offline
// faux provider, synthetic HA REST/WebSocket fakes and a fake Core
// Supervisor REST API (http://supervisor).
import { test } from "node:test";
import { rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { adminHarness, TOKEN } from "./admin-fixtures.js";
import type { JudgeRecord } from "../src/documents.js";
import {
  RiskJudgeService,
  resolveJudge,
  type JudgeAdapter,
  type RiskJudge,
} from "../src/judge.js";
import { Actions } from "../src/ha.js";
import { pressHomeToggle, toggleControl } from "../src/apps.js";
import { appServer } from "../src/server.js";

const fixedJudge = (
  verdict: Partial<JudgeRecord> & Pick<JudgeRecord, "verdict">,
): RiskJudge & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    describe: () => ({ setting: "test/judge", model: "test/judge" }),
    evaluate: async (request) => {
      calls.push(request);
      return {
        model: "test/judge",
        reason: "test verdict",
        latencyMs: 3,
        ...verdict,
      };
    },
  };
};
const light = {
  domain: "light",
  service: "turn_on",
  target: { entity_id: ["light.kitchen"] },
  data: { brightness: 100 },
};
const climate = {
  domain: "climate",
  service: "set_temperature",
  target: { entity_id: ["climate.hall"] },
  data: { temperature: 20 },
};
const unlock = {
  domain: "lock",
  service: "unlock",
  target: { entity_id: ["lock.front_door"] },
};

test("admin Full access: low auto-runs; medium only with an agreeing judge; high/critical always pending; receipts record level, rule and judge", async () => {
  const f = await adminHarness();
  try {
    await f.mode("full");
    // Low with judge off → automatic dispatch.
    const low = await f.run(
      "ha_call_service",
      light,
      "Turn on the kitchen light",
    );
    assert.equal(low?.status, "accepted");
    assert.equal(low?.authorization?.source, "automatic");
    assert.deepEqual(
      [low?.risk?.level, low?.risk?.rule, low?.judge?.verdict],
      ["low", "comfort_device", "off"],
    );
    assert.deepEqual(f.writes.at(-1), {
      method: "POST",
      url: "services/light/turn_on",
      body: { brightness: 100, entity_id: ["light.kitchen"] },
    });
    // Medium with judge off → ask.
    const medium = await f.run("ha_call_service", climate, "Set hall to 20");
    assert.equal(medium?.status, "pending");
    assert.equal(medium?.risk?.level, "medium");
    assert.equal(medium?.authorization?.source, "human");
    await f.ha.actions.decide(
      "owner",
      f.id,
      medium!.id,
      medium!.hash,
      "reject",
    );
    // High: garage cover by live device class, even with an agreeing judge.
    f.ha.actions.useJudge(fixedJudge({ verdict: "agreed" }));
    const garage = await f.run(
      "ha_call_service",
      {
        domain: "cover",
        service: "open_cover",
        target: { entity_id: ["cover.main_door"] },
      },
      "Open the main door",
    );
    assert.equal(garage?.status, "pending");
    assert.deepEqual(
      [garage?.risk?.level, garage?.risk?.rule],
      ["high", "garage_gate_cover"],
    );
    await f.ha.actions.decide(
      "owner",
      f.id,
      garage!.id,
      garage!.hash,
      "reject",
    );
    // Medium + agreeing judge → automatic.
    const writes = f.writes.length;
    const agreed = await f.run("ha_call_service", climate, "Set hall to 20");
    assert.equal(agreed?.status, "accepted");
    assert.equal(agreed?.judge?.verdict, "agreed");
    assert.equal(agreed?.judge?.model, "test/judge");
    assert.equal(agreed?.judge?.latencyMs, 3);
    assert.equal(f.writes.length, writes + 1);
    // The judge cannot lower: high stays high with an "agreeing low" judge.
    f.ha.actions.useJudge(fixedJudge({ verdict: "agreed" }));
    const high = await f.run(
      "ha_call_service",
      unlock,
      "Unlock the front door",
    );
    assert.equal(high?.status, "pending");
    assert.equal(high?.risk?.level, "high");
    await f.ha.actions.decide("owner", f.id, high!.id, high!.hash, "reject");
    // Escalation: low → high by the judge → pending, rule records it.
    f.ha.actions.useJudge(
      fixedJudge({ verdict: "escalated", escalateTo: "high", reason: "night" }),
    );
    const escalated = await f.run("ha_call_service", light, "Lights on");
    assert.equal(escalated?.status, "pending");
    assert.equal(escalated?.risk?.level, "high");
    assert.match(escalated!.risk!.rule, /^judge_escalated:comfort_device$/);
    await f.ha.actions.decide(
      "owner",
      f.id,
      escalated!.id,
      escalated!.hash,
      "reject",
    );
    // Misaligned low → ask, with the judge's reason on the receipt.
    f.ha.actions.useJudge(
      fixedJudge({
        verdict: "misaligned",
        reason: "Owner asked about the porch",
      }),
    );
    const mis = await f.run("ha_call_service", light, "Is the porch light on?");
    assert.equal(mis?.status, "pending");
    assert.equal(mis?.judge?.reason, "Owner asked about the porch");
    await f.ha.actions.decide("owner", f.id, mis!.id, mis!.hash, "reject");
    // Judge timeout / garbage → ask (no agreement).
    for (const classifyIntent of [
      () => new Promise<never>(() => {}),
      async () => {
        throw new Error("garbage");
      },
    ]) {
      const adapter: JudgeAdapter = { id: "test/bad", classifyIntent };
      f.ha.actions.useJudge(
        new RiskJudgeService(
          "test/bad",
          () => ({ adapter, model: adapter.id }),
          50,
        ),
      );
      const r = await f.run("ha_call_service", climate, "Set hall to 20");
      assert.equal(r?.status, "pending");
      assert.equal(r?.judge?.verdict, "unavailable");
      await f.ha.actions.decide("owner", f.id, r!.id, r!.hash, "reject");
    }
    // Critical: pending with a confirmation word; approval needs the word.
    f.ha.actions.useJudge(fixedJudge({ verdict: "agreed" }));
    const reboot = await f.run(
      "supervisor_propose",
      { method: "POST", path: "/host/reboot" },
      "Reboot the host",
    );
    assert.equal(reboot?.status, "pending");
    assert.equal(reboot?.risk?.level, "critical");
    assert.equal(reboot?.confirmation, "REBOOT");
    await assert.rejects(
      f.ha.actions.decide("owner", f.id, reboot!.id, reboot!.hash, "approve"),
      /confirmation_required/,
    );
    await assert.rejects(
      f.ha.actions.decide(
        "owner",
        f.id,
        reboot!.id,
        reboot!.hash,
        "approve",
        "",
        "reboot",
      ),
      /confirmation_required/,
    );
    await f.ha.actions.decide(
      "owner",
      f.id,
      reboot!.id,
      reboot!.hash,
      "approve",
      "",
      "REBOOT",
    );
    const done = (await f.receipts()).find((r) => r.id === reboot!.id);
    assert.equal(done?.status, "accepted");
    const call = f.supervisorCalls.at(-1)!;
    assert.deepEqual([call.path, call.method], ["/host/reboot", "POST"]);
    // Home World / app toggles are classified too (low → runs in Full).
    const pressed = await f.ha.actions.press(
      "owner",
      f.id,
      { service: "light.turn_off", entityId: "light.kitchen", data: {} },
      { kind: "world", entityId: "light.kitchen" },
    );
    assert.equal(pressed.status, "accepted");
    assert.deepEqual(
      [pressed.risk?.level, pressed.judge?.verdict],
      ["low", "not_applicable"],
    );
  } finally {
    await f.close();
  }
});

test("admin Ask: every kind becomes an exact pending proposal; config/registry/supervisor dispatch exactly once on approval; bad shapes never become proposals", async () => {
  const f = await adminHarness();
  try {
    assert.equal((await f.ha.actions.settings("owner")).effectiveMode, "ask");
    const low = await f.run("ha_call_service", light);
    assert.equal(low?.status, "pending", "Ask: even low risk waits");
    await f.ha.actions.decide("owner", f.id, low!.id, low!.hash, "approve");
    const config = await f.run("ha_config_propose", {
      resource: "automation",
      op: "upsert",
      id: "porch_lights",
      body: {
        alias: "Porch",
        trigger: [],
        action: [{ action: "light.turn_on" }],
      },
    });
    assert.deepEqual(
      [config?.risk?.level, config?.risk?.rule],
      ["high", "config_runs_actions"],
    );
    await f.ha.actions.decide(
      "owner",
      f.id,
      config!.id,
      config!.hash,
      "approve",
    );
    assert.deepEqual(f.writes.at(-1), {
      method: "POST",
      url: "config/automation/config/porch_lights",
      body: {
        alias: "Porch",
        trigger: [],
        action: [{ action: "light.turn_on" }],
      },
    });
    const del = await f.run("ha_config_propose", {
      resource: "automation",
      op: "delete",
      id: "porch_lights",
    });
    assert.equal(del?.risk?.level, "high");
    await f.ha.actions.decide("owner", f.id, del!.id, del!.hash, "approve");
    assert.deepEqual(
      [f.writes.at(-1)?.method, f.writes.at(-1)?.url],
      ["DELETE", "config/automation/config/porch_lights"],
    );
    const registry = await f.run("ha_registry_propose", {
      type: "config/entity_registry/update",
      payload: { entity_id: "light.kitchen", name: "Kitchen ceiling" },
    });
    await f.ha.actions.decide(
      "owner",
      f.id,
      registry!.id,
      registry!.hash,
      "approve",
    );
    const sent = f.frames.filter(
      (m) => m.type === "config/entity_registry/update",
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.name, "Kitchen ceiling");
    const addon = await f.run("supervisor_propose", {
      method: "POST",
      path: "/addons/core_mosquitto/restart",
    });
    assert.equal(addon?.risk?.level, "medium");
    await f.ha.actions.decide("owner", f.id, addon!.id, addon!.hash, "approve");
    assert.equal(
      f.supervisorCalls.filter(
        (c) => c.path === "/addons/core_mosquitto/restart",
      ).length,
      1,
    );
    // Rejected before any proposal or HA request.
    const before = (await f.receipts()).length;
    const framesBefore = f.frames.length;
    const supervisorCallsBefore = f.supervisorCalls.length;
    const writesBefore = f.writes.length;
    for (const [tool, args] of [
      ["supervisor_propose", { method: "POST", path: "/host/exec" }],
      [
        "ha_registry_propose",
        { type: "auth/delete_refresh_token", payload: {} },
      ],
      ["ha_call_service", { ...light, data: { entity_id: "lock.front_door" } }],
      ["ha_call_service", { domain: "nope", service: "missing", target: {} }],
      [
        "ha_config_propose",
        {
          resource: "automation",
          op: "upsert",
          id: "big",
          body: { x: "y".repeat(40000) },
        },
      ],
    ] as const)
      await f.run(tool, args as Record<string, unknown>);
    assert.equal((await f.receipts()).length, before);
    assert.equal(f.frames.length, framesBefore);
    assert.equal(f.supervisorCalls.length, supervisorCallsBefore);
    assert.equal(f.writes.length, writesBefore);
    // Self-protection: stopping Hearth's own add-on is critical.
    const self = await f.run("supervisor_propose", {
      method: "POST",
      path: "/addons/abc123_hearth_pi/stop",
    });
    assert.deepEqual(
      [self?.risk?.level, self?.risk?.rule, self?.confirmation],
      ["critical", "self_protection", "abc123_hearth_pi"],
    );
  } finally {
    await f.close();
  }
});

test("new action kinds keep the installation-wide unknown-outcome barrier and are never retried", async () => {
  let calls = 0;
  const f = await adminHarness({
    supervisor: (endpoint) => {
      if (endpoint === "/addons/core_samba/restart") calls++;
      // 5xx: Supervisor's handler may have started before failing. Unknown.
      return { status: 503 };
    },
  });
  try {
    await f.mode("full");
    const addon = await f.run("supervisor_propose", {
      method: "POST",
      path: "/addons/core_samba/restart",
    });
    await f.ha.actions.decide("owner", f.id, addon!.id, addon!.hash, "approve");
    const after = (await f.receipts()).find((r) => r.id === addon!.id);
    assert.equal(after?.status, "unknown");
    assert.equal(calls, 1);
    const settings = await f.ha.actions.settings("owner");
    assert.equal(settings.blocked, true);
    // Even a low action is refused while the outcome is unknown.
    const blocked = await f.run("ha_call_service", light);
    assert.equal(blocked?.id, addon!.id, "no new proposal");
    assert.match(await f.toolResults(), /home_outcome_unresolved/);
    await assert.rejects(
      f.ha.actions.decide("owner", f.id, addon!.id, addon!.hash, "approve"),
      /proposal_already_decided/,
    );
    assert.equal(calls, 1, "never retried");
    // A failed REST config write is unknown too.
    await f.ha.actions.decide(
      "owner",
      f.id,
      addon!.id,
      addon!.hash,
      "resolve",
      "Checked: samba restarted.",
    );
  } finally {
    await f.close();
  }
  const g = await adminHarness({ writeStatus: 500 });
  try {
    const cfg = await g.run("ha_config_propose", {
      resource: "script",
      op: "upsert",
      id: "night",
      body: { alias: "Night", sequence: [] },
    });
    await g.ha.actions.decide("owner", g.id, cfg!.id, cfg!.hash, "approve");
    assert.equal(
      (await g.receipts()).find((r) => r.id === cfg!.id)?.status,
      "unknown",
    );
    assert.equal(g.writes.length, 1);
  } finally {
    await g.close();
  }
});

test('a Supervisor mutation Supervisor rejected before any side effect is "failed", not "unknown": it never blocks later actions and is never retried', async () => {
  let calls = 0;
  const f = await adminHarness({
    supervisor: (endpoint) => {
      if (endpoint === "/addons/core_samba/restart") calls++;
      // A definite 4xx (e.g. the add-on slug no longer exists): Supervisor's
      // token/role/shape checks all run before its handler, so nothing ran.
      return { status: 404 };
    },
  });
  try {
    await f.mode("full");
    const addon = await f.run("supervisor_propose", {
      method: "POST",
      path: "/addons/core_samba/restart",
    });
    await f.ha.actions.decide("owner", f.id, addon!.id, addon!.hash, "approve");
    const after = (await f.receipts()).find((r) => r.id === addon!.id);
    assert.equal(after?.status, "failed");
    assert.match(after!.resolution, /404/);
    assert.equal(calls, 1);
    // Unlike "unknown", a definite failure is done: it never blocks later
    // actions and cannot be "resolve"d (nothing to reconcile).
    const settings = await f.ha.actions.settings("owner");
    assert.equal(settings.blocked, false);
    const low = await f.run("ha_call_service", light);
    assert.equal(low?.status, "accepted");
    await assert.rejects(
      f.ha.actions.decide("owner", f.id, addon!.id, addon!.hash, "approve"),
      /proposal_already_decided/,
    );
    await assert.rejects(
      f.ha.actions.decide(
        "owner",
        f.id,
        addon!.id,
        addon!.hash,
        "resolve",
        "n/a",
      ),
      /not_unknown/,
    );
    assert.equal(calls, 1, "never retried");
  } finally {
    await f.close();
  }
});

test("judge prompt canary: only the owner's latest message and the exact action reach the judge — never tool output, attributes, logs, memory or secrets", async () => {
  const judgeFaux = fauxProvider({
    provider: "judge-faux",
    models: [{ id: "judge" }],
  });
  const judgeModels = createModels();
  judgeModels.setProvider(judgeFaux.provider);
  const prompts: string[] = [];
  judgeFaux.setResponses(
    Array.from({ length: 4 }, () => (context: unknown) => {
      prompts.push(JSON.stringify(context));
      return fauxAssistantMessage('{"aligned":true,"reason":"matches"}');
    }),
  );
  const judge = new RiskJudgeService("judge-faux/judge", () =>
    resolveJudge("judge-faux/judge", {
      models: judgeModels,
      signedIn: () => false,
    }),
  );
  const f = await adminHarness({ judge });
  try {
    await f.mode("full");
    const first = await f.run(
      "ha_call_service",
      climate,
      "Earlier message OLD_MESSAGE_CANARY",
    );
    await f.ha.actions
      .decide("owner", f.id, first!.id, first!.hash, "reject")
      .catch(() => {});
    const r = await f.run(
      "ha_call_service",
      climate,
      "Please set the hall to 20 degrees LATEST_CANARY",
      [
        { tool: "ha_admin_read", args: { source: "states", query: "canary" } },
        { tool: "supervisor_read", args: { path: "/core/logs" } },
      ],
    );
    assert.equal(r?.status, "accepted", "medium + agreeing judge auto-ran");
    const prompt = prompts.at(-1)!;
    assert.match(prompt, /LATEST_CANARY/);
    assert.match(prompt, /climate/);
    assert.match(prompt, /set_temperature/);
    // The conversation did see these; the judge must not.
    assert.match(await f.toolResults(), /ATTRIBUTE_CANARY/);
    for (const canary of [
      "ATTRIBUTE_CANARY",
      "line three",
      "supersecretvalue123",
      TOKEN,
      "household_memory",
      "Hearth Pi, an independent home companion",
      "ha_admin_read",
    ])
      assert(!prompt.includes(canary), canary);
    // Earlier exchanges in the same judge session are its own prior
    // request/action/verdict only.
    assert.match(prompt, /OLD_MESSAGE_CANARY/);
  } finally {
    await f.close();
  }
});

test("HTTP: a critical proposal is approved only with CSRF and the typed confirmation; bootstrap and settings show Access: Admin and the judge model", async () => {
  const f = await adminHarness({ judge: fixedJudge({ verdict: "agreed" }) });
  const cfg = {
    mode: "local" as const,
    host: "127.0.0.1",
    port: 8099,
    origin: "http://127.0.0.1:8099",
    password: "synthetic-local-password-0001",
    authorizedUsers: [],
    dataDir: f.dir,
    provider: "offline" as const,
    model: "test",
    policy: f.ha.policy,
    judge: {
      model: "endpoint/qwen3-1.7b",
      url: "http://192.168.1.50:8080",
      apiKey: "synthetic-judge-key-0001",
      timeoutMs: 15000,
      sessionTtlMs: 300000,
    },
    haToken: TOKEN,
    apiKey: "",
  };
  const app = appServer(cfg, f.runtime, new Actions(f.runtime, f.ha), {
    secrets: [TOKEN, cfg.password, cfg.judge.apiKey],
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  cfg.origin = base;
  const authorization = `Basic ${Buffer.from(`hearth:${cfg.password}`).toString("base64")}`;
  try {
    const sessionId = await f.runtime.create(
      "local-admin",
      "Home",
      "create-admin-http",
    );
    const boot = await fetch(`${base}/api/bootstrap`, {
      headers: { authorization },
    });
    const bootstrap = await boot.json();
    assert.equal(bootstrap.access, "admin");
    assert.equal(bootstrap.homePermissions.access, "admin");
    assert.equal(bootstrap.riskJudge.model, "test/judge");
    assert.doesNotMatch(
      JSON.stringify(bootstrap),
      /synthetic-judge-key|synthetic-admin-ha-token/,
    );
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const post = (path: string, body: unknown, csrf = bootstrap.csrf) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          authorization,
          cookie,
          origin: base,
          "x-hearth-csrf": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    // A local-admin conversation proposing a critical backup removal.
    f.provider.faux.setResponses([
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: "c1",
          name: "supervisor_propose",
          arguments: { method: "DELETE", path: "/backups/abcd1234" },
        },
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Pending your confirmation."),
    ]);
    const submitted = await post(`/api/sessions/${sessionId}/inputs`, {
      requestId: "request-http-critical-1",
      content: "Delete backup abcd1234",
    });
    assert.equal(submitted.status, 202);
    let proposal:
      | {
          id: string;
          hash: string;
          confirmation: string;
          status: string;
          risk: { level: string };
        }
      | undefined;
    for (let i = 0; i < 100 && !proposal; i++) {
      const snap = await (
        await fetch(`${base}/api/sessions/${sessionId}/snapshot`, {
          headers: { authorization },
        })
      ).json();
      proposal = Object.values(snap.proposals)[0] as typeof proposal;
      if (!proposal) await new Promise((r) => setTimeout(r, 20));
    }
    assert(proposal);
    assert.equal(proposal.risk.level, "critical");
    assert.equal(proposal.confirmation, "abcd1234");
    const decision = {
      id: proposal.id,
      hash: proposal.hash,
      decision: "approve",
    };
    assert.equal(
      (await post(`/api/sessions/${sessionId}/actions`, decision, "forged"))
        .status,
      403,
    );
    const missing = await post(`/api/sessions/${sessionId}/actions`, decision);
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, "confirmation_required");
    const wrong = await post(`/api/sessions/${sessionId}/actions`, {
      ...decision,
      confirm: "abcd",
    });
    assert.equal(wrong.status, 400);
    assert.equal(f.supervisorCalls.length, 0);
    const ok = await post(`/api/sessions/${sessionId}/actions`, {
      ...decision,
      confirm: "abcd1234",
    });
    assert.equal(ok.status, 200);
    assert.equal(f.supervisorCalls.length, 1);
    assert.deepEqual(
      [f.supervisorCalls[0]!.path, f.supervisorCalls[0]!.method],
      ["/backups/abcd1234", "DELETE"],
    );
    const snap = await (
      await fetch(`${base}/api/sessions/${sessionId}/snapshot`, {
        headers: { authorization },
      })
    ).text();
    assert.match(snap, /"status":"accepted"/);
    assert.doesNotMatch(snap, /synthetic-judge-key|synthetic-admin-ha-token/);
  } finally {
    await app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("review exploits through the real harness: Full access + an agreeing judge never auto-runs hidden or unverifiable high/critical actions", async () => {
  const judge = fixedJudge({ verdict: "agreed" });
  const f = await adminHarness({ judge });
  try {
    await f.mode("full");
    const writes = f.writes.length;
    const hidden = await f.run(
      "ha_config_propose",
      {
        resource: "automation",
        op: "upsert",
        id: "porch",
        body: {
          alias: "Porch at sunset",
          trigger: [{ trigger: "sun", event: "sunset" }],
          action: [
            ...Array.from({ length: 201 }, () => ({ action: "light.turn_on" })),
            { action: "{{ 'Hassio.Host_Reboot' }}" },
          ],
        },
      },
      "Make an automation that turns on the porch light at sunset",
    );
    assert.equal(hidden?.status, "pending");
    assert.equal(hidden?.risk?.level, "critical");
    const plain = await f.run(
      "ha_config_propose",
      {
        resource: "automation",
        op: "upsert",
        id: "porch2",
        body: { alias: "Porch", action: [{ action: "light.turn_on" }] },
      },
      "Make a porch automation",
    );
    assert.equal(plain?.status, "pending", "automation writes always ask");
    const padded = await f.run(
      "ha_call_service",
      {
        domain: "cover",
        service: "open_cover",
        target: {
          entity_id: [
            ...Array.from({ length: 10 }, (_, i) => `cover.a${i}`),
            "cover.blind",
          ],
        },
      },
      "Open the blind",
    );
    assert.deepEqual(
      [padded?.status, padded?.risk?.rule],
      ["pending", "cover_unverified"],
    );
    const sceneOn = await f.run(
      "ha_call_service",
      {
        domain: "scene",
        service: "turn_on",
        target: { entity_id: ["scene.leave"] },
      },
      "Activate leave home",
    );
    assert.deepEqual(
      [sceneOn?.status, sceneOn?.risk?.level],
      ["pending", "high"],
    );
    const apply = await f.run(
      "ha_call_service",
      {
        domain: "scene",
        service: "apply",
        target: {},
        data: { entities: { "lock.front_door": "unlocked" } },
      },
      "Apply a scene",
    );
    assert.deepEqual([apply?.status, apply?.risk?.level], ["pending", "high"]);
    assert.equal(f.writes.length, writes, "nothing auto-ran");
    // Add-on options never reach the model through supervisor_read.
    await f.run(
      "ha_admin_read",
      { source: "config" },
      "What does mosquitto look like?",
      [
        {
          tool: "supervisor_read",
          args: { path: "/addons/core_mosquitto/info" },
        },
      ],
    );
    const transcript = await f.toolResults();
    assert.match(transcript, /Mosquitto broker/);
    assert.doesNotMatch(transcript, /ADDON_OPTION_CANARY|INGRESS_CANARY/);
  } finally {
    await f.close();
  }
});

test("admin controls: Home World/app presses use the entity's own domain service; fan (low) runs in Full, cover (medium) and lock (high) wait", async () => {
  const f = await adminHarness();
  try {
    await f.mode("full");
    const settings = await f.ha.actions.settings("owner");
    const fanControl = toggleControl(f.ha, settings, "fan.purifier", "off");
    assert.deepEqual([fanControl.enabled, fanControl.label], [true, "Turn on"]);
    assert.equal(
      toggleControl(f.ha, settings, "cover.blind", "closed").label,
      "Open",
    );
    assert.equal(
      toggleControl(f.ha, settings, "lock.front_door", "locked").label,
      "Unlock",
    );
    assert.equal(
      toggleControl(f.ha, settings, "sensor.big", "42").enabled,
      false,
    );
    const press = (entityId: string) =>
      pressHomeToggle(f.runtime, f.ha, "owner", f.id, entityId, {
        kind: "world",
        entityId,
      });
    const fan = await press("fan.purifier");
    assert.equal(fan.proposal.status, "accepted");
    assert.deepEqual(fan.proposal.action, {
      kind: "service",
      domain: "fan",
      service: "turn_on",
      target: { entity_id: ["fan.purifier"] },
      data: {},
    });
    assert.equal(fan.proposal.risk?.level, "low");
    const cover = await press("cover.blind");
    assert.deepEqual(
      [cover.proposal.status, cover.proposal.risk?.level],
      ["pending", "medium"],
    );
    await f.ha.actions.decide(
      "owner",
      f.id,
      cover.proposal.id,
      cover.proposal.hash,
      "reject",
    );
    const lock = await press("lock.front_door");
    assert.deepEqual(
      [lock.proposal.status, lock.proposal.risk?.level],
      ["pending", "high"],
    );
    assert.deepEqual(
      f.writes.map((w) => w.url),
      ["services/fan/turn_on"],
    );
  } finally {
    await f.close();
  }
  // Scoped mode: controls stay light/switch only.
  const g = await adminHarness({ access: "scoped" });
  try {
    const settings = await g.ha.actions.settings("owner");
    assert.equal(
      toggleControl(g.ha, settings, "fan.purifier", "off").enabled,
      false,
    );
    assert.equal(
      toggleControl(g.ha, settings, "fan.purifier", "off").label,
      undefined,
    );
  } finally {
    await g.close();
  }
});
