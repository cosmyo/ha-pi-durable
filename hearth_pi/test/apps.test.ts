import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  defineExtension,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.js";
import { HAClient, haExtension } from "../src/ha.js";
import { Proposals } from "../src/documents.js";
import { FULL_ACKNOWLEDGEMENT } from "../src/home-actions.js";
import {
  AppIndex,
  AppState,
  AppStore,
  appTools,
  downsample,
} from "../src/apps.js";
import { offline } from "./fixtures.js";
import { call, fakeHA, laundrySpec } from "./app-fixtures.js";

async function open(dir: string, ha: HAClient, provider = offline()) {
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(ha)],
    [],
    undefined,
    ha.actions,
  );
  return { runtime, provider };
}

test("model app_create through the real harness is validated, durable, owner-scoped and survives reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-apps-"));
  const f = fakeHA();
  let { runtime, provider } = await open(dir, f.ha);
  try {
    const id = await runtime.create("owner", "Laundry chat", "apps-create-1");
    const created = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "app_create",
      { spec: laundrySpec() },
      "apps-input-1",
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.appId, "app_1");
    assert.equal(created.version, 1);
    assert.deepEqual(created.diff.added.length, 8);
    assert.equal(f.gets.length, 0, "creating an app reads no HA values");
    const store = new AppStore(runtime, f.ha);
    assert.deepEqual(
      (await store.list("owner")).items.map((a) => a.title),
      ["Laundry"],
    );
    assert.deepEqual((await store.list("other")).items, []);
    await assert.rejects(store.get("other", "app_1"), /app_not_found/);
    // Model-facing reads.
    const listed = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "app_list",
      {},
      "apps-input-2",
    );
    assert.equal(listed.items[0].id, "app_1");
    const got = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "app_get",
      { appId: "app_1" },
      "apps-input-3",
    );
    assert.equal(got.spec.elements.washer.props.entity, "sensor.washer_state");
    const catalog = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "catalog_describe",
      {},
      "apps-input-4",
    );
    assert.equal(catalog.templates.length, 4);
    // A different owner's conversation cannot read the app.
    const otherId = await runtime.create("other", "Other", "apps-create-other");
    const denied = await call(
      runtime,
      provider.faux,
      "other",
      otherId,
      "app_get",
      { appId: "app_1" },
      "apps-input-5",
    );
    assert.equal(denied.error, "app_not_found");
    await runtime.close();
    const g = fakeHA();
    ({ runtime, provider } = await open(dir, g.ha, provider));
    const reopened = new AppStore(runtime, g.ha);
    const app = await reopened.get("owner", "app_1");
    assert.equal(app.app.title, "Laundry");
    assert.equal(app.spec.elements.fold!.type, "Checklist");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid specs and scope violations return path-specific tool errors and store nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-apps-invalid-"));
  const f = fakeHA();
  const { runtime, provider } = await open(dir, f.ha);
  try {
    const id = await runtime.create("owner", "Bad", "apps-create-2");
    const cases: [unknown, string, string][] = [
      [
        laundrySpec({
          scope: { entities: ["sensor.washer_state", "lock.front_door"] },
        }),
        "entity_not_readable",
        "/scope/entities/1",
      ],
      [{ ...laundrySpec(), extra: "<script>" }, "unknown_key", "/extra"],
      [
        (() => {
          const s = laundrySpec() as any;
          s.elements.washer.props.state = "idle";
          return s;
        })(),
        "literal_value_forbidden",
        "/elements/washer/props/state",
      ],
      [
        (() => {
          const s = laundrySpec() as any;
          s.elements.washer.type = "Html";
          return s;
        })(),
        "unknown_component",
        "/elements/washer/type",
      ],
    ];
    for (const [i, [spec, code, path]] of cases.entries()) {
      const result = await call(
        runtime,
        provider.faux,
        "owner",
        id,
        "app_create",
        { spec },
        `apps-bad-${i}`,
      );
      assert.equal(result.ok, false);
      assert.equal(result.isError, true);
      assert(
        result.errors.some((e: any) => e.code === code && e.path === path),
        JSON.stringify(result.errors),
      );
    }
    // A ToggleAction outside the configured service scope is rejected.
    f.policy.services = ["light.turn_on"];
    const toggle = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "app_create",
      { spec: laundrySpec() },
      "apps-bad-toggle",
    );
    assert(toggle.errors.some((e: any) => e.code === "action_not_in_scope"));
    assert.equal(
      (await runtime.harness.snapshot(AppIndex, ctx))?.items.length ?? 0,
      0,
    );
    assert.equal(f.gets.length + f.posts.length, 0);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("app_update uses JSON Patch with optimistic concurrency, keeps app-local state, and revert appends a version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-apps-update-"));
  const f = fakeHA();
  let { runtime, provider } = await open(dir, f.ha);
  try {
    const id = await runtime.create("owner", "Laundry", "apps-create-3");
    await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "app_create",
      { spec: laundrySpec() },
      "apps-u-1",
    );
    const store = new AppStore(runtime, f.ha);
    await store.setState("owner", "app_1", {
      stateKey: "fold",
      op: "check",
      item: "Towels",
    });
    await store.setState("owner", "app_1", {
      stateKey: "loads",
      op: "increment",
    });
    await store.setState("owner", "app_1", {
      stateKey: "note",
      op: "set",
      text: "Blue <b>bag</b>",
    });
    const updated = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "app_update",
      {
        appId: "app_1",
        baseVersion: 1,
        changeSummary: "Rename and add a tile",
        patch: [
          { op: "replace", path: "/title", value: "Laundry room" },
          { op: "add", path: "/elements/main/children/-", value: "power_tile" },
          {
            op: "add",
            path: "/elements/power_tile",
            value: {
              type: "EntityTile",
              props: { entity: "sensor.washer_power" },
            },
          },
          { op: "remove", path: "/elements/main/children/2" },
          { op: "remove", path: "/elements/chart" },
        ],
      },
      "apps-u-2",
    );
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.version, 2);
    assert.deepEqual(updated.diff.added, ["power_tile"]);
    assert.deepEqual(updated.diff.removed, ["chart"]);
    assert.equal(updated.diff.titleChanged, true);
    const stale = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "app_update",
      {
        appId: "app_1",
        baseVersion: 1,
        patch: [{ op: "replace", path: "/title", value: "Stale" }],
      },
      "apps-u-3",
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.currentVersion, 2);
    assert.equal(stale.errors[0].code, "version_conflict");
    const invalid = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "app_update",
      {
        appId: "app_1",
        baseVersion: 2,
        patch: [
          { op: "add", path: "/elements/washer/props/value", value: "done" },
        ],
      },
      "apps-u-4",
    );
    assert.equal(invalid.errors[0].code, "literal_value_forbidden");
    let app = await store.get("owner", "app_1");
    assert.equal(app.app.version, 2);
    assert.equal(app.app.title, "Laundry room");
    assert.deepEqual(app.state.fold, {
      kind: "checklist",
      checked: ["Towels"],
      updated: app.state.fold!.updated,
    });
    assert.equal((app.state.loads as { value: number }).value, 1);
    assert.equal((app.state.note as { text: string }).text, "Blue <b>bag</b>");
    // Revert creates v3 = copy of v1; it never rewrites history.
    await assert.rejects(
      store.revert("owner", "app_1", { version: 1, baseVersion: 1 }),
      /version_conflict/,
    );
    const reverted = await store.revert("owner", "app_1", {
      version: 1,
      baseVersion: 2,
    });
    assert.equal(reverted.version, 3);
    await runtime.close();
    const g = fakeHA();
    ({ runtime, provider } = await open(dir, g.ha, provider));
    app = await new AppStore(runtime, g.ha).get("owner", "app_1");
    assert.equal(app.app.version, 3);
    assert.equal(app.app.title, "Laundry");
    assert.deepEqual(
      app.versions.map((v) => [v.version, v.by.split(":")[0], v.parent]),
      [
        [1, "conversation", 0],
        [2, "conversation", 1],
        [3, "owner", 2],
      ],
    );
    assert.ok(app.spec.elements.chart);
    assert.equal(
      (app.state.loads as { value: number }).value,
      1,
      "state survives update, revert and reopen",
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolved values are controller reads with as-of times; out-of-scope entities are never read and flag repair", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-apps-values-"));
  const f = fakeHA();
  const { runtime, provider } = await open(dir, f.ha);
  try {
    const id = await runtime.create("owner", "Laundry", "apps-create-4");
    await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "app_create",
      { spec: laundrySpec() },
      "apps-v-1",
    );
    const store = new AppStore(runtime, f.ha);
    const before = Date.now();
    const app = await store.get("owner", "app_1");
    assert.equal(app.values["sensor.washer_power"]!.state, "512.5");
    assert.equal(
      app.values["sensor.washer_power"]!.attributes.unit_of_measurement,
      "W",
    );
    assert(app.values["sensor.washer_state"]!.observedAt >= before);
    assert.doesNotMatch(
      JSON.stringify(app),
      /synthetic-supervisor-token|must-not-export/,
    );
    const chart = app.history.chart![0]!;
    assert.equal(chart.kind, "numeric");
    assert(
      chart.kind === "numeric" &&
        chart.points.length === 48 &&
        chart.max === 500 &&
        chart.unit === "W",
    );
    assert.equal(app.controls.hall!.mode, "ask");
    assert.equal(app.controls.hall!.enabled, true);
    assert.equal(app.needsRepair, false);
    // Unavailable HA state is shown as unavailable, never guessed.
    f.states["sensor.washer_state"] = "unavailable";
    delete f.states["light.hall"];
    const unavailable = await store.get("owner", "app_1");
    assert.equal(unavailable.values["sensor.washer_state"]!.available, false);
    assert.equal(unavailable.values["light.hall"]!.reason, "read_failed");
    assert.equal(unavailable.controls.hall!.enabled, false);
    // Scope revoked: no read, explicit reason, app flagged for repair.
    f.policy.entities = ["sensor.washer_state", "light.hall"];
    f.gets.length = 0;
    const revoked = await store.get("owner", "app_1");
    assert.equal(
      revoked.values["sensor.washer_power"]!.reason,
      "not_in_read_scope",
    );
    assert(!f.gets.some((g) => g.includes("washer_power")));
    assert.equal(revoked.needsRepair, true);
    assert.equal(revoked.history.chart![0]!.kind, "unavailable");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("app-local state is validated per component kind and bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-apps-state-"));
  const f = fakeHA();
  const { runtime, provider } = await open(dir, f.ha);
  try {
    const id = await runtime.create("owner", "Laundry", "apps-create-5");
    await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "app_create",
      { spec: laundrySpec() },
      "apps-s-1",
    );
    const store = new AppStore(runtime, f.ha);
    for (const [body, code] of [
      [{ stateKey: "fold", op: "check", item: "Socks" }, /item_not_found/],
      [{ stateKey: "fold", op: "increment" }, /invalid_request/],
      [{ stateKey: "loads", op: "set", text: "9" }, /invalid_request/],
      [
        { stateKey: "note", op: "set", text: "x".repeat(51) },
        /invalid_request/,
      ],
      [{ stateKey: "note", op: "set", text: "bell\u0007" }, /invalid_request/],
      [{ stateKey: "missing", op: "reset" }, /state_key_not_found/],
      [
        { stateKey: "fold", op: "check", item: "Towels", owner: "x" },
        /invalid_request/,
      ],
    ] as const)
      await assert.rejects(store.setState("owner", "app_1", body), code);
    await assert.rejects(
      store.setState("other", "app_1", { stateKey: "fold", op: "reset" }),
      /app_not_found/,
    );
    for (let i = 0; i < 5; i++)
      await store.setState("owner", "app_1", {
        stateKey: "loads",
        op: "increment",
      });
    const clamped = await store.setState("owner", "app_1", {
      stateKey: "loads",
      op: "increment",
    });
    assert.equal((clamped.state.loads as { value: number }).value, 3);
    const reset = await store.setState("owner", "app_1", {
      stateKey: "loads",
      op: "reset",
    });
    assert.equal((reset.state.loads as { value: number }).value, 0);
    const doc = await runtime.harness.snapshot(AppState, "app_1", ctx);
    assert.equal(doc!.revision, 7);
    // Pin, then delete; another owner cannot do either.
    await assert.rejects(
      store.pin("other", "app_1", { pinned: true }),
      /app_not_found/,
    );
    assert.equal(
      (await store.pin("owner", "app_1", { pinned: true })).pinned,
      true,
    );
    await assert.rejects(
      store.remove("owner", "app_1", { confirm: false }),
      /confirmation_required/,
    );
    assert.deepEqual(await store.remove("owner", "app_1", { confirm: true }), {
      deleted: true,
    });
    await assert.rejects(store.get("owner", "app_1"), /app_not_found/);
    assert.equal(
      await runtime.harness.snapshot(AppState, "app_1", ctx),
      undefined,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ToggleAction press reuses the Home permissions broker: Read-only denies, Ask needs exact approval, Full runs once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-apps-toggle-"));
  const f = fakeHA();
  const { runtime, provider } = await open(dir, f.ha);
  const mode = async (value: "read-only" | "ask" | "full") => {
    const p = await f.ha.actions.settings("owner");
    await f.ha.actions.setMode(
      "owner",
      value,
      p.revision,
      p.policy,
      value === "full" ? FULL_ACKNOWLEDGEMENT : undefined,
    );
  };
  try {
    const id = await runtime.create("owner", "Laundry", "apps-create-6");
    await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "app_create",
      { spec: laundrySpec() },
      "apps-t-1",
    );
    const store = new AppStore(runtime, f.ha);
    const press = (sessionId = id) =>
      store.press("owner", "app_1", {
        elementId: "hall",
        sessionId,
        version: 1,
      });
    // Read-only: disabled with explanation and no HA request.
    await mode("read-only");
    const ro = await store.get("owner", "app_1");
    assert.equal(ro.controls.hall!.enabled, false);
    assert.match(ro.controls.hall!.reason, /Read-only/);
    f.gets.length = 0;
    await assert.rejects(press(), /home_read_only/);
    assert.deepEqual(f.gets, []);
    assert.deepEqual(f.posts, []);
    // Ask: an exact pending proposal in the chosen Home chat; nothing dispatched.
    await mode("ask");
    const asked = await press();
    assert.equal(asked.proposal.status, "pending");
    assert.deepEqual(asked.proposal.action, {
      service: "light.turn_on",
      entityId: "light.hall",
      data: {},
    });
    assert.deepEqual(asked.proposal.origin, {
      kind: "app",
      appId: "app_1",
      version: 1,
      elementId: "hall",
    });
    assert.deepEqual(f.posts, []);
    const ledger = (await runtime.harness.snapshot(
      Proposals,
      id as ConversationId,
      ctx,
    ))!.items;
    assert.equal(Object.keys(ledger).length, 1);
    await assert.rejects(
      f.ha.actions.decide(
        "other",
        id,
        asked.proposal.id,
        asked.proposal.hash,
        "approve",
      ),
      /session_not_found/,
    );
    await f.ha.actions.decide(
      "owner",
      id,
      asked.proposal.id,
      asked.proposal.hash,
      "approve",
    );
    assert.deepEqual(f.posts, ["services/light/turn_on"]);
    await assert.rejects(
      f.ha.actions.decide(
        "owner",
        id,
        asked.proposal.id,
        asked.proposal.hash,
        "approve",
      ),
      /proposal_already_decided/,
    );
    assert.equal(f.posts.length, 1);
    // Full: exactly one dispatch within scope, then a read-back.
    await mode("full");
    const full = await press();
    assert.equal(full.proposal.status, "accepted");
    assert.equal(full.proposal.authorization!.mode, "full");
    assert.deepEqual(f.posts, [
      "services/light/turn_on",
      "services/light/turn_off",
    ]);
    assert.equal(full.readBack!.state, "off");
    // Stale app version, wrong element, Code/other-owner sessions are refused.
    await assert.rejects(
      store.press("owner", "app_1", {
        elementId: "hall",
        sessionId: id,
        version: 9,
      }),
      /version_conflict/,
    );
    await assert.rejects(
      store.press("owner", "app_1", {
        elementId: "washer",
        sessionId: id,
        version: 1,
      }),
      /control_not_found/,
    );
    const otherId = await runtime.create(
      "other",
      "Other",
      "apps-create-other-6",
    );
    await assert.rejects(press(otherId), /session_not_found/);
    assert.equal(f.posts.length, 2);
  } finally {
    await f.ha.actions.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an app press with an unknown outcome is never retried and blocks further Home writes until reconciled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-apps-unknown-"));
  const f = fakeHA({ post: async () => new Response("boom", { status: 500 }) });
  const { runtime, provider } = await open(dir, f.ha);
  try {
    const id = await runtime.create("owner", "Laundry", "apps-create-7");
    await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "app_create",
      { spec: laundrySpec() },
      "apps-k-1",
    );
    const p = await f.ha.actions.settings("owner");
    await f.ha.actions.setMode(
      "owner",
      "full",
      p.revision,
      p.policy,
      FULL_ACKNOWLEDGEMENT,
    );
    const store = new AppStore(runtime, f.ha);
    const first = await store.press("owner", "app_1", {
      elementId: "hall",
      sessionId: id,
      version: 1,
    });
    assert.equal(first.proposal.status, "unknown");
    assert.equal(first.readBack, null);
    assert.equal(f.posts.length, 1);
    const app = await store.get("owner", "app_1");
    assert.equal(app.controls.hall!.enabled, false);
    assert.match(app.controls.hall!.reason, /unknown outcome/);
    await assert.rejects(
      store.press("owner", "app_1", {
        elementId: "hall",
        sessionId: id,
        version: 1,
      }),
      /home_outcome_unresolved/,
    );
    assert.equal(f.posts.length, 1, "no automatic retry");
    await f.ha.actions.decide(
      "owner",
      id,
      first.proposal.id,
      first.proposal.hash,
      "resolve",
      "Checked the hall light by eye.",
    );
    assert.equal(
      (await store.get("owner", "app_1")).controls.hall!.enabled,
      true,
    );
  } finally {
    await f.ha.actions.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("app tools are Home-only, replay-safe receipts never duplicate an app, and nothing lets the model press controls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-apps-receipt-"));
  const f = fakeHA();
  const base = haExtension(f.ha);
  const tools = appTools(f.ha);
  assert.deepEqual(
    tools.map((t) => t.name),
    ["app_create", "app_update", "app_get", "app_list", "catalog_describe"],
  );
  for (const tool of tools)
    assert.doesNotMatch(
      JSON.stringify(tool.parameters),
      /elementId|stateKey|press|approve/,
    );
  const create = tools[0]!;
  const home = defineExtension({
    ...base,
    tools: base.tools!.map((t) =>
      t.name !== "app_create"
        ? t
        : {
            ...create,
            execute: async (args, api, context) => {
              const first = await create.execute(args as never, api, context);
              const again = await create.execute(args as never, api, context);
              assert.deepEqual(again, first);
              return again;
            },
          },
    ),
  });
  const code = defineExtension({ name: "synthetic-code", tools: [] });
  const provider = offline();
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [home, code],
    [],
    { home: [home], workspace: [code] },
    f.ha.actions,
  );
  try {
    const id = await runtime.create("owner", "Laundry", "apps-create-8");
    await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "app_create",
      { spec: laundrySpec() },
      "apps-r-1",
    );
    assert.equal(
      (await runtime.harness.snapshot(AppIndex, ctx))!.items.length,
      1,
    );
    const codeId = await runtime.create(
      "owner",
      "Code",
      "apps-create-code",
      "workspace",
    );
    const agent = await (await runtime.session("owner", codeId)).agent(ctx);
    assert(!agent.tools.some((t) => /^app_|catalog_describe/.test(t.name)));
    const homeAgent = await (await runtime.session("owner", id)).agent(ctx);
    assert(homeAgent.tools.some((t) => t.name === "app_create"));
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("history downsampling is bounded and treats text states as changes", () => {
  const start = 0,
    end = 48 * 1000;
  const numeric = downsample(
    Array.from({ length: 1000 }, (_, i) => ({ at: i * 48, state: String(i) })),
    start,
    end,
  )!;
  assert.equal(numeric.points.length, 48);
  assert.equal(numeric.min < numeric.max, true);
  assert.equal(
    downsample(
      [
        { at: 1, state: "on" },
        { at: 2, state: "off" },
      ],
      start,
      end,
    ),
    null,
  );
  const carried = downsample([{ at: -5, state: "7" }], start, end)!;
  assert(carried.points.every(([, v]) => v === 7));
});
