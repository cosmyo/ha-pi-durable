// Trusted owners (trusted_user_ids), unknown-outcome reconciliation and the
// per-entity unknown-outcome pause: the real durable harness, the offline
// faux provider and synthetic Home Assistant fakes.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { adminHarness } from "./admin-fixtures.js";
import { offline } from "./fixtures.js";
import { HAClient, haExtension } from "../src/ha.js";
import { Runtime } from "../src/runtime.js";
import { Proposals, type JudgeRecord } from "../src/documents.js";
import {
  ADMIN_FULL_ACKNOWLEDGEMENT,
  FULL_ACKNOWLEDGEMENT,
  TRUSTED_ADMIN_FULL_ACKNOWLEDGEMENT,
  TRUSTED_FULL_ACKNOWLEDGEMENT,
  type ReconcileSleep,
} from "../src/home-actions.js";
import { loadConfig, trustedOwners } from "../src/config.js";
import {
  RECONCILED_DID_NOT_HAPPEN,
  RECONCILED_SUCCEEDED,
  RECONCILE_GAVE_UP,
  reconcilePlan,
  writeScope,
  writesPaused,
} from "../src/reconcile.js";
import type { RiskJudge } from "../src/judge.js";

const countingJudge = (): RiskJudge & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    describe: () => ({ setting: "test/judge", model: "test/judge" }),
    evaluate: async (request) => {
      calls.push(request);
      return {
        model: "test/judge",
        verdict: "agreed",
        reason: "test verdict",
        latencyMs: 1,
      } satisfies JudgeRecord;
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
const reboot = { method: "POST", path: "/host/reboot" };
const DIRECT = { direct: true } as const;

test("trusted owner on Full: their own direct turns auto-run low, medium, high and critical with a 'trusted' receipt and no judge call", async () => {
  const judge = countingJudge();
  const f = await adminHarness({ trusted: ["owner"], judge, submit: DIRECT });
  try {
    const settings = await f.ha.actions.settings("owner");
    assert.equal(settings.trusted, true);
    assert.equal(settings.acknowledgement, TRUSTED_ADMIN_FULL_ACKNOWLEDGEMENT);
    // Switching to Full still needs the one confirmation, with the trusted
    // text: the ordinary acknowledgement is refused.
    await assert.rejects(
      f.ha.actions.setMode(
        "owner",
        "full",
        settings.revision,
        settings.policy,
        ADMIN_FULL_ACKNOWLEDGEMENT,
      ),
      /invalid_request/,
    );
    await f.mode("full");
    const runs = [
      ["ha_call_service", light, "low", "services/light/turn_on"],
      [
        "ha_call_service",
        climate,
        "medium",
        "services/climate/set_temperature",
      ],
      ["ha_call_service", unlock, "high", "services/lock/unlock"],
    ] as const;
    for (const [tool, args, level, url] of runs) {
      const writes = f.writes.length;
      const r = await f.run(tool, args, "Please do it");
      assert.equal(r?.status, "accepted", level);
      assert.equal(r?.risk?.level, level);
      assert.ok(r?.risk?.rule);
      assert.equal(r?.authorization?.source, "trusted");
      assert.equal(r?.authorization?.mode, "full");
      assert.equal(r?.judge?.verdict, "not_applicable");
      assert.equal(f.writes.length, writes + 1);
      assert.equal(f.writes.at(-1)?.url, url);
    }
    const critical = await f.run("supervisor_propose", reboot, "Reboot host");
    assert.deepEqual(
      [
        critical?.status,
        critical?.risk?.level,
        critical?.authorization?.source,
      ],
      ["accepted", "critical", "trusted"],
    );
    assert.deepEqual(
      f.supervisorCalls.map((c) => [c.method, c.path]),
      [["POST", "/host/reboot"]],
    );
    assert.equal(judge.calls.length, 0, "the judge is never asked");
    // A trusted person's own press runs at its level too (lock: high).
    const pressed = await f.ha.actions.press(
      "owner",
      f.id,
      { ...unlock, kind: "service", data: {} },
      { kind: "world", entityId: "lock.front_door" },
    );
    assert.deepEqual(
      [pressed.status, pressed.risk?.level, pressed.authorization?.source],
      ["accepted", "high", "trusted"],
    );
  } finally {
    await f.close();
  }
});

test("trusted owner on Ask still gets pending proposals; Read-only refuses", async () => {
  const f = await adminHarness({ trusted: ["owner"], submit: DIRECT });
  try {
    assert.equal((await f.ha.actions.settings("owner")).effectiveMode, "ask");
    for (const [tool, args] of [
      ["ha_call_service", light],
      ["ha_call_service", unlock],
      ["supervisor_propose", reboot],
    ] as const) {
      const r = await f.run(tool, args);
      assert.equal(r?.status, "pending");
      assert.equal(r?.authorization?.source, "human");
      await f.ha.actions.decide("owner", f.id, r!.id, r!.hash, "reject");
    }
    assert.equal(f.writes.length + f.supervisorCalls.length, 0);
    await f.mode("read-only");
    const before = (await f.receipts()).length;
    await f.run("ha_call_service", light);
    assert.equal((await f.receipts()).length, before);
    assert.match(await f.toolResults(), /home_read_only/);
  } finally {
    await f.close();
  }
});

test("untrusted owner on Full with the judge off: low runs; medium, high and critical stay pending", async () => {
  const f = await adminHarness({ submit: DIRECT });
  try {
    assert.equal((await f.ha.actions.settings("owner")).trusted, false);
    await f.mode("full");
    const low = await f.run("ha_call_service", light);
    assert.deepEqual(
      [low?.status, low?.authorization?.source, low?.judge?.verdict],
      ["accepted", "automatic", "off"],
    );
    for (const [tool, args, level] of [
      ["ha_call_service", climate, "medium"],
      ["ha_call_service", unlock, "high"],
      ["supervisor_propose", reboot, "critical"],
    ] as const) {
      const r = await f.run(tool, args);
      assert.deepEqual(
        [r?.status, r?.risk?.level, r?.authorization?.source],
        ["pending", level, "human"],
      );
      await f.ha.actions.decide("owner", f.id, r!.id, r!.hash, "reject");
    }
    assert.equal(f.writes.length, 1);
    assert.equal(f.supervisorCalls.length, 0);
  } finally {
    await f.close();
  }
});

test("trusted owner: a voice satellite keeps the Ask ceiling, and turns the person did not type (no direct flag) never run high or critical", async () => {
  const judge = countingJudge();
  const f = await adminHarness({ trusted: ["owner"], judge });
  try {
    await f.mode("full");
    // Satellite: anyone in the room can speak. Ask ceiling → pending.
    const spoken = await f.run("ha_call_service", light, "Lights on", [], {
      channel: "satellite",
      ceiling: "ask",
    });
    assert.deepEqual(
      [
        spoken?.status,
        spoken?.authorization?.mode,
        spoken?.authorization?.source,
        spoken?.authorization?.channel,
      ],
      ["pending", "ask", "human", "satellite"],
    );
    await f.ha.actions.decide(
      "owner",
      f.id,
      spoken!.id,
      spoken!.hash,
      "reject",
    );
    // A ceiled input can never claim to be direct.
    await assert.rejects(
      f.runtime.submit("owner", f.id, "request-bad-1", "x", undefined, {
        channel: "satellite",
        ceiling: "ask",
        direct: true,
      }),
      /invalid_request/,
    );
    // Work the person did not start (proactive, watchers, automations…):
    // the normal Full rules apply, so high and critical stay pending.
    for (const [tool, args] of [
      ["ha_call_service", unlock],
      ["supervisor_propose", reboot],
    ] as const) {
      const r = await f.run(tool, args, "Background work", [], {});
      assert.deepEqual(
        [r?.status, r?.authorization?.source],
        ["pending", "human"],
      );
      await f.ha.actions.decide("owner", f.id, r!.id, r!.hash, "reject");
    }
    assert.equal(f.writes.length + f.supervisorCalls.length, 0);
    // The Assist button (channel assist, the person's own user) is direct.
    const button = await f.run("ha_call_service", unlock, "Unlock", [], {
      channel: "assist",
      direct: true,
    });
    assert.deepEqual(
      [button?.status, button?.authorization?.source],
      ["accepted", "trusted"],
    );
  } finally {
    await f.close();
  }
});

test("trusted_user_ids: empty by default; each must be an authorized owner, never a member or guest", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-trusted-config-"));
  const previous = process.env.HEARTH_MODE;
  t.after(async () => {
    if (previous === undefined) delete process.env.HEARTH_MODE;
    else process.env.HEARTH_MODE = previous;
    await rm(dir, { recursive: true, force: true });
  });
  process.env.HEARTH_MODE = "ingress";
  const options = async (values: Record<string, unknown>) => {
    const file = join(dir, "options.json");
    await writeFile(
      file,
      JSON.stringify({
        public_origin: "https://home.example",
        provider: "offline",
        authorized_user_ids: ["user-a", "user-b", "user-c"],
        ...values,
      }),
    );
    return loadConfig(file);
  };
  assert.deepEqual((await options({})).trustedUsers, []);
  const set = await options({ trusted_user_ids: ["user-a", "user-a"] });
  assert.deepEqual(set.trustedUsers, ["user-a"]);
  assert.deepEqual(trustedOwners(set), ["user-a"]);
  assert.deepEqual(trustedOwners({ ...set, mode: "local" }), []);
  for (const [values, code] of [
    [{ trusted_user_ids: ["bad id"] }, "invalid_trusted_user_ids"],
    [{ trusted_user_ids: "user-a" }, "invalid_trusted_user_ids"],
    [{ trusted_user_ids: ["user-outsider"] }, "trusted_user_not_authorized"],
    [
      { trusted_user_ids: ["user-b"], member_user_ids: ["user-b"] },
      "trusted_user_not_owner_role",
    ],
    [
      { trusted_user_ids: ["user-c"], guest_user_ids: ["user-c"] },
      "trusted_user_not_owner_role",
    ],
  ] as const)
    await assert.rejects(options(values), new RegExp(code));
  // The engine refuses the same at attach time.
  const ha = new HAClient("synthetic-token", {
    enabled: true,
    entities: [],
    services: [],
  });
  assert.throws(
    () => ha.actions.authorizeOwners(["user-a"], {}, ["user-x"]),
    /trusted_user_not_owner_role/,
  );
  assert.throws(
    () =>
      ha.actions.authorizeOwners(["user-a", "user-b"], { "user-b": "member" }, [
        "user-b",
      ]),
    /trusted_user_not_owner_role/,
  );
});

// --- Scoped synthetic home for reconciliation and the per-entity pause ---

const LAMP = "light.example_lamp";
const DESK = "light.example_desk";
const GROUP = "light.example_group";
type FakeState = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
};
function fakeClock() {
  const waits: { ms: number; resolve: () => void }[] = [];
  const sleep: ReconcileSleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      waits.push({ ms, resolve: () => resolve() });
      signal.addEventListener("abort", () => reject(new Error("stopped")), {
        once: true,
      });
    });
  return {
    waits,
    sleep,
    // Let the next pending wait elapse; returns its length.
    async tick() {
      for (let i = 0; i < 500 && !waits.length; i++)
        await new Promise((r) => setTimeout(r, 5));
      const next = waits.shift();
      assert.ok(next, "a reconciliation check is scheduled");
      next.resolve();
      return next.ms;
    },
  };
}
async function scopedHome(t: TestContext, trusted = false) {
  const dir = await mkdtemp(join(tmpdir(), "hearth-reconcile-"));
  const provider = offline();
  const at = "2099-01-01T00:00:00.000Z";
  const states: Record<string, FakeState> = {
    [LAMP]: {
      entity_id: LAMP,
      state: "off",
      attributes: { friendly_name: "Example lamp" },
      last_changed: at,
      last_updated: at,
    },
    [DESK]: {
      entity_id: DESK,
      state: "off",
      attributes: { friendly_name: "Example desk" },
      last_changed: at,
      last_updated: at,
    },
    [GROUP]: {
      entity_id: GROUP,
      state: "off",
      attributes: { friendly_name: "Example group", entity_id: [LAMP] },
      last_changed: at,
      last_updated: at,
    },
  };
  const posts: { url: string; body: unknown }[] = [];
  let failPosts = 0;
  const ha = new HAClient(
    "synthetic-token",
    {
      enabled: true,
      entities: [LAMP, DESK, GROUP],
      services: ["light.turn_on", "light.turn_off"],
    },
    (async (url: string | URL, init?: RequestInit) => {
      const path = String(url).replace("http://supervisor/core/api/", "");
      if (init?.method === "POST") {
        posts.push({ url: path, body: JSON.parse(String(init.body)) });
        if (failPosts > 0) {
          failPosts--;
          throw new Error("connection reset after send");
        }
        return Response.json([]);
      }
      if (path === "services")
        return Response.json([
          { domain: "light", services: { turn_on: {}, turn_off: {} } },
        ]);
      if (path === "states") return Response.json(Object.values(states));
      const id = decodeURIComponent(path.replace(/^states\//, ""));
      return states[id]
        ? Response.json(states[id])
        : Response.json({ message: "not found" }, { status: 404 });
    }) as typeof fetch,
  );
  const clock = fakeClock();
  ha.actions.sleep = clock.sleep;
  ha.actions.authorizeOwners(["owner"], {}, trusted ? ["owner"] : []);
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(ha)],
    [],
    undefined,
    ha.actions,
  );
  t.after(async () => {
    await ha.actions.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  const id = await runtime.create("owner", "Home", "create-reconcile-1");
  const p = await ha.actions.settings("owner");
  await ha.actions.setMode(
    "owner",
    "full",
    p.revision,
    p.policy,
    trusted ? TRUSTED_FULL_ACKNOWLEDGEMENT : FULL_ACKNOWLEDGEMENT,
  );
  let n = 0;
  const receipts = async () =>
    Object.values(
      (await runtime.harness.snapshot(Proposals, id as ConversationId, ctx))!
        .items,
    ).sort((a, b) => a.created - b.created || Number(a.id) - Number(b.id));
  const propose = async (args: Record<string, unknown>) => {
    provider.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ha_propose_service", args as never), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("See the receipt."),
    ]);
    const sid = await runtime.submit(
      "owner",
      id,
      `request-reconcile-${++n}`,
      "Please do it",
      undefined,
      { direct: true },
    );
    await (await runtime.harness.submission(sid as SubmissionId, ctx))!.wait(
      ctx,
    );
    return (await receipts()).at(-1);
  };
  const transcript = async () =>
    JSON.stringify(
      (
        await (await runtime.harness.conversation(
          id as ConversationId,
          ctx,
        ))!.context(ctx)
      ).entries,
    );
  // Wait until the receipt has `count` reconciliation checks.
  const checks = async (proposalId: string, count: number) => {
    for (let i = 0; i < 500; i++) {
      const item = (await receipts()).find((r) => r.id === proposalId)!;
      if ((item.reconcile?.checks.length ?? 0) >= count) return item;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail(`no reconciliation check ${count}`);
  };
  return {
    ha,
    runtime,
    id,
    states,
    posts,
    clock,
    receipts,
    propose,
    transcript,
    checks,
    failNextPost: () => {
      failPosts = 1;
    },
  };
}
const lampOn = { service: "light.turn_on", entityId: LAMP, data: {} };

test("reconciliation: an unknown outcome whose target reaches the intended state becomes 'succeeded (confirmed from Home Assistant state)' without a second service call", async (t) => {
  const h = await scopedHome(t);
  h.failNextPost();
  const unknown = await h.propose(lampOn);
  assert.equal(unknown?.status, "unknown");
  assert.equal(unknown?.reconcile?.before?.[0]?.state, "off");
  // The device did switch on; Home Assistant now reports it.
  h.states[LAMP] = {
    ...h.states[LAMP]!,
    state: "on",
    last_changed: "2099-01-01T00:00:01.000Z",
    last_updated: "2099-01-01T00:00:01.000Z",
  };
  assert.equal(await h.clock.tick(), 5000);
  const done = await h.checks(unknown!.id, 1);
  assert.equal(done.status, "resolved");
  assert.equal(done.reconcile?.outcome, "succeeded");
  assert.equal(done.resolution, RECONCILED_SUCCEEDED);
  assert.match(
    done.resolution,
    /Succeeded \(confirmed from Home Assistant state\)/,
  );
  assert.equal(done.reconcile?.checks[0]?.result, "intended");
  assert.equal(h.posts.length, 1, "never a second service call");
  assert.equal((await h.ha.actions.settings("owner")).blocked, false);
  assert.equal(h.clock.waits.length, 0, "no further checks");
});

test("reconciliation: a target exactly as before the attempt at the last check becomes 'did not happen'; earlier checks never conclude it", async (t) => {
  const h = await scopedHome(t);
  h.failNextPost();
  const unknown = await h.propose(lampOn);
  assert.equal(unknown?.status, "unknown");
  assert.equal(await h.clock.tick(), 5000);
  let item = await h.checks(unknown!.id, 1);
  assert.equal(item.status, "unknown");
  assert.equal(item.reconcile?.checks[0]?.result, "unchanged");
  assert.equal(await h.clock.tick(), 25000);
  item = await h.checks(unknown!.id, 2);
  assert.equal(item.status, "unknown");
  assert.equal(await h.clock.tick(), 90000);
  item = await h.checks(unknown!.id, 3);
  assert.equal(item.status, "resolved");
  assert.equal(item.reconcile?.outcome, "did_not_happen");
  assert.equal(item.resolution, RECONCILED_DID_NOT_HAPPEN);
  assert.equal(h.posts.length, 1, "never a second service call");
});

test("reconciliation: a target that changed some other way stays unknown for a person after the last check", async (t) => {
  const h = await scopedHome(t);
  h.failNextPost();
  const unknown = await h.propose(lampOn);
  // Someone switched it on and off again: same state, new last_changed.
  h.states[LAMP] = {
    ...h.states[LAMP]!,
    last_changed: "2099-01-01T00:00:05.000Z",
    last_updated: "2099-01-01T00:00:05.000Z",
  };
  for (const ms of [5000, 25000, 90000]) assert.equal(await h.clock.tick(), ms);
  const item = await h.checks(unknown!.id, 4);
  assert.equal(item.status, "unknown");
  assert.deepEqual(
    item.reconcile?.checks.map((c) => c.result),
    ["mixed", "mixed", "mixed", "mixed"],
  );
  assert.equal(item.reconcile?.checks.at(-1)?.note, RECONCILE_GAVE_UP);
  assert.equal(item.reconcile?.outcome, undefined);
  assert.equal(h.posts.length, 1);
  // A person still settles it.
  await h.ha.actions.decide(
    "owner",
    h.id,
    item.id,
    item.hash,
    "resolve",
    "Checked: still off.",
  );
  assert.equal((await h.receipts()).at(-1)?.status, "resolved");
});

test("unknown-outcome pause is per entity: other entities stay writable; the same entity (or a group containing it) stays blocked and is never retried", async (t) => {
  const h = await scopedHome(t, true);
  h.failNextPost();
  const unknown = await h.propose(lampOn);
  assert.equal(unknown?.status, "unknown");
  assert.deepEqual(unknown?.scope, [LAMP]);
  const settings = await h.ha.actions.settings("owner");
  assert.equal(settings.blocked, true);
  assert.deepEqual(settings.pause, { all: false, entities: [LAMP] });
  assert.equal(writesPaused(settings, LAMP), true);
  assert.equal(writesPaused(settings, DESK), false);
  assert.equal(writesPaused(settings), false);
  // Another entity: runs (trusted owner on Full).
  const desk = await h.propose({ ...lampOn, entityId: DESK });
  assert.deepEqual(
    [desk?.status, desk?.authorization?.source],
    ["accepted", "trusted"],
  );
  assert.equal(h.posts.length, 2);
  // The same entity, and a group that contains it: refused, no proposal.
  const before = (await h.receipts()).length;
  await h.propose(lampOn);
  await h.propose({ ...lampOn, entityId: GROUP });
  assert.equal((await h.receipts()).length, before);
  assert.match(await h.transcript(), /home_outcome_unresolved/);
  assert.equal(h.posts.length, 2, "never retried");
  // Settled by a person: the lamp is writable again.
  await h.ha.actions.decide(
    "owner",
    h.id,
    unknown!.id,
    unknown!.hash,
    "resolve",
    "Checked the lamp.",
  );
  const fresh = await h.propose(lampOn);
  assert.equal(fresh?.status, "accepted");
  assert.equal(h.posts.length, 3);
});

test("reconcile plans and write scopes are allowlists: config, Supervisor, device/area and other-domain targets reconcile nothing and pause everything", () => {
  assert.deepEqual(reconcilePlan(lampOn), {
    kind: "entity",
    goals: [{ entityId: LAMP, state: "on" }],
  });
  assert.deepEqual(reconcilePlan({ ...lampOn, data: { brightness: 40 } }), {
    kind: "entity",
    goals: [{ entityId: LAMP, state: "on", attrs: { brightness: 40 } }],
  });
  assert.equal(reconcilePlan({ ...lampOn, data: { brightness: 0 } }), null);
  assert.deepEqual(
    reconcilePlan({
      kind: "service",
      domain: "cover",
      service: "open_cover",
      target: { entity_id: ["cover.a", "cover.b"] },
      data: {},
    })?.kind,
    "entity",
  );
  for (const action of [
    {
      kind: "service" as const,
      domain: "script",
      service: "turn_on",
      target: { entity_id: ["script.x"] },
      data: {},
    },
    {
      kind: "service" as const,
      domain: "light",
      service: "turn_on",
      target: { area_id: ["study"] },
      data: {},
    },
    {
      kind: "config" as const,
      resource: "automation" as const,
      op: "delete" as const,
      id: "x",
    },
    {
      kind: "supervisor" as const,
      method: "POST" as const,
      path: "/host/reboot",
    },
  ]) {
    assert.equal(reconcilePlan(action), null);
    assert.equal(
      writeScope(action, () => []),
      undefined,
    );
  }
  // A target that could not be read might be a group: pause everything.
  assert.equal(
    writeScope(lampOn, () => null),
    undefined,
  );
  assert.deepEqual(
    writeScope(lampOn, () => ["light.b", "light.a"]),
    ["light.a", "light.b", LAMP],
  );
});

test("UI: a trusted receipt says it ran without asking, reconciliation notes show on the card, and Settings shows 'Trusted: everything runs on Full'", async () => {
  const { parseHTML } = await import("linkedom");
  const { document, window } = parseHTML(
    '<html><body><div id="cards"></div></body></html>',
  );
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: window,
    configurable: true,
  });
  try {
    const { renderProposals } = await import(
      new URL("../public/render.js", import.meta.url).href
    );
    const base = {
      hash: "a".repeat(64),
      policy: "p",
      expires: Date.now() + 60000,
      decidedBy: "owner",
      decidedAt: 1,
      resolution: "",
      action: { service: "light.turn_on", entityId: LAMP, data: {} },
      risk: { level: "high", rule: "example_rule", reasons: [] },
      authorization: {
        mode: "full",
        revision: 3,
        policy: "p",
        grant: "g",
        source: "trusted",
        owner: "owner",
        inputIds: [1],
      },
    };
    const container = document.getElementById("cards")!;
    renderProposals(
      container,
      {
        "1": { ...base, id: "1", created: 1, status: "accepted" },
        "2": {
          ...base,
          id: "2",
          created: 2,
          status: "resolved",
          resolution: RECONCILED_SUCCEEDED,
          reconcile: {
            checks: [
              {
                at: 1,
                result: "intended",
                note: "Home Assistant reports every target in the requested state.",
              },
            ],
            outcome: "succeeded",
          },
        },
      },
      () => {},
    );
    const cards = [...container.querySelectorAll(".action-card")].map(
      (c) => (c as HTMLElement).textContent ?? "",
    );
    assert.match(cards[0]!, /every target in the requested state/);
    assert.match(
      cards[0]!,
      /Succeeded \(confirmed from Home Assistant state\)/,
    );
    assert.match(cards[1]!, /Trusted \/ ran without asking \(high risk\)/);
  } finally {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
  }
  const html = await readFile(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /id="permission-trusted" hidden/);
  const app = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  assert.match(app, /Trusted: everything runs on Full\./);
});
