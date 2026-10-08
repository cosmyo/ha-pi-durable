import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Runtime } from "../src/runtime.js";
import { HAClient, haExtension } from "../src/ha.js";
import {
  Proactive,
  TodayInbox,
  WatchRuntime,
  evaluateWatch,
  scheduledSlot,
  type StateReader,
} from "../src/proactive.js";
import type { WatcherSpec } from "../src/app-spec.js";
import { Catalog } from "../src/documents.js";
import { offline } from "./fixtures.js";
import { call, fakeHA, laundrySpec } from "./app-fixtures.js";

// Runtime (non-type) relative imports of a source file.
function runtimeImports(source: string) {
  const found: string[] = [];
  for (const match of source.matchAll(
    /^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\s+from\s+)?"(\.\/[^"]+)";/gm,
  ))
    found.push(match[1]!.replace(/\.js$/, ".ts").replace(/^\.\//, ""));
  return found;
}

test("watcher module has no code path to services or the action broker (static)", async () => {
  const seen = new Set<string>();
  const queue = ["proactive.ts"];
  for (let file = queue.shift(); file; file = queue.shift()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(
      new URL(`../src/${file}`, import.meta.url),
      "utf8",
    );
    // No service call, broker, model input or HTTP write vocabulary anywhere
    // in the module or anything it loads.
    for (const forbidden of [
      /\bdispatch\s*\(/,
      /\.press\s*\(/,
      /\.propose\w*\s*\(/,
      /HomeActions|homeActions|\.actions\./,
      /services\//,
      /\.submit\s*\(/,
      /createConversation|createTask/,
      /method:\s*"POST"/,
      /\bfetch\s*\(/,
    ])
      assert(!forbidden.test(source), `${file} matches ${forbidden}`);
    queue.push(...runtimeImports(source));
  }
  // The closure is exactly these pure modules: no HA client, broker, app
  // tools, conversation runtime or server.
  assert.deepEqual([...seen].sort(), [
    "app-docs.ts",
    "app-spec.ts",
    "canvas.ts",
    "documents.ts",
    "proactive.ts",
    "safety.ts",
  ]);
  const own = await readFile(
    new URL("../src/proactive.ts", import.meta.url),
    "utf8",
  );
  assert(!/from "\.\/(ha|home-actions|apps|runtime|server)\.js"/.test(own));
  // The HA client hands proactive code a frozen read-only view.
  const { ha } = fakeHA();
  const reader = ha.reader();
  assert.deepEqual(Object.keys(reader).sort(), ["entities", "read"]);
  assert(Object.isFrozen(reader));
});

const at = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

test("evaluateWatch: transitions, thresholds, durations and bounded repeats are deterministic", () => {
  const done: WatcherSpec & { when: { kind: "transition" } } = {
    id: "done",
    when: {
      kind: "transition",
      entity: "sensor.w",
      from: "running",
      to: "idle",
    },
    card: { title: "Done", body: "" },
    repeatAfterMinutes: 30,
    maxRepeats: 2,
  };
  const t0 = at(2026, 10, 8, 9);
  let r = evaluateWatch(done, undefined, "idle", t0);
  assert.equal(r.fire, null, "first sight never fires");
  r = evaluateWatch(done, r.next, "running", t0 + 60000);
  assert.equal(r.fire, null);
  r = evaluateWatch(done, r.next, "idle", t0 + 120000);
  assert.deepEqual(r.fire, { episode: t0 + 120000, repeat: 0 });
  r = evaluateWatch(done, r.next, "idle", t0 + 180000);
  assert.equal(r.fire, null, "no duplicate while still idle");
  r = evaluateWatch(done, r.next, "idle", t0 + 120000 + 30 * 60000);
  assert.equal(r.fire?.repeat, 1);
  r = evaluateWatch(done, r.next, "idle", t0 + 120000 + 60 * 60000);
  assert.equal(r.fire?.repeat, 2);
  r = evaluateWatch(done, r.next, "idle", t0 + 120000 + 90 * 60000);
  assert.equal(r.fire, null, "maxRepeats bounds reminders");
  // Coming back from unavailable is not a real transition unless named.
  const any: WatcherSpec & { when: { kind: "transition" } } = {
    id: "any",
    when: { kind: "transition", entity: "sensor.w", to: "idle" },
    card: { title: "Idle", body: "" },
  };
  r = evaluateWatch(any, undefined, "unavailable", t0);
  r = evaluateWatch(any, r.next, "idle", t0 + 60000);
  assert.equal(r.fire, null);
  const high: WatcherSpec & { when: { kind: "threshold" } } = {
    id: "high",
    when: { kind: "threshold", entity: "sensor.p", above: 100 },
    card: { title: "High", body: "" },
  };
  r = evaluateWatch(high, undefined, "150", t0);
  assert(r.fire, "already above on first sight fires once");
  r = evaluateWatch(high, r.next, "160", t0 + 60000);
  assert.equal(r.fire, null);
  r = evaluateWatch(high, r.next, "unavailable", t0 + 120000);
  r = evaluateWatch(high, r.next, "150", t0 + 180000);
  assert(r.fire, "a new crossing is a new episode");
  const stay: WatcherSpec & { when: { kind: "duration" } } = {
    id: "stay",
    when: {
      kind: "duration",
      entity: "binary_sensor.door",
      state: "on",
      minutes: 10,
    },
    card: { title: "Door open", body: "" },
  };
  r = evaluateWatch(stay, undefined, "on", t0);
  r = evaluateWatch(stay, r.next, "on", t0 + 9 * 60000);
  assert.equal(r.fire, null);
  r = evaluateWatch(stay, r.next, "on", t0 + 10 * 60000);
  assert.deepEqual(r.fire, { episode: t0, repeat: 0 });
  r = evaluateWatch(stay, r.next, "off", t0 + 11 * 60000);
  r = evaluateWatch(stay, r.next, "on", t0 + 12 * 60000);
  assert.equal(r.fire, null, "a new stay restarts the timer");
});

test("scheduledSlot finds the newest local slot on allowed weekdays", () => {
  // 2026-10-08 is a Thursday.
  assert.equal(
    scheduledSlot("07:30", undefined, at(2026, 10, 8, 9)),
    at(2026, 10, 8, 7, 30),
  );
  assert.equal(
    scheduledSlot("07:30", undefined, at(2026, 10, 8, 7)),
    at(2026, 10, 7, 7, 30),
  );
  assert.equal(
    scheduledSlot("07:30", ["mon"], at(2026, 10, 8, 9)),
    at(2026, 10, 5, 7, 30),
  );
});

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
const washerWatcher = {
  id: "washer_done",
  when: {
    kind: "transition",
    entity: "sensor.washer_state",
    from: "running",
    to: "idle",
  },
  card: { title: "Washer finished", body: "Move laundry to the dryer." },
  repeatAfterMinutes: 30,
  maxRepeats: 1,
};

test("app watcher survives restart: one card per transition, bounded repeat, no duplicates, reads only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-proactive-"));
  const f = fakeHA();
  let clock = at(2026, 10, 8, 9);
  let { runtime, provider } = await open(dir, f.ha);
  const watch = (rt: Runtime, reader: StateReader = f.ha.reader()) =>
    new Proactive(rt.harness, reader, {
      now: () => clock,
      owners: () => ["owner"],
    });
  try {
    const chat = await runtime.create("owner", "Laundry", "proactive-create-1");
    const created = await call(
      runtime,
      provider.faux,
      "owner",
      chat,
      "app_create",
      { spec: laundrySpec({ watchers: [washerWatcher] }) },
      "proactive-input-1",
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.deepEqual(created.diff.watchersAdded, ["washer_done"]);
    const sessions = (await runtime.harness.snapshot(Catalog, ctx))!.items
      .length;
    let proactive = watch(runtime);
    assert.equal((await proactive.tick()).cards, 0, "first sight: running");
    f.states["sensor.washer_state"] = "idle";
    clock += 60000;
    assert.equal((await proactive.tick()).cards, 1);
    clock += 60000;
    assert.equal((await proactive.tick()).cards, 0, "still idle: no duplicate");
    let today = await proactive.today("owner");
    assert.equal(today.cards.length, 1);
    assert.equal(today.unread, 1);
    const card = today.cards[0]!;
    assert.equal(card.title, "Washer finished");
    assert.deepEqual(card.source, {
      kind: "app",
      appId: "app_1",
      title: "Laundry",
      watcherId: "washer_done",
    });
    assert.equal(card.values[0]!.entityId, "sensor.washer_state");
    assert.equal(card.values[0]!.state, "idle");
    assert.equal(card.values[0]!.available, true);
    assert(card.values[0]!.observedAt >= clock - 60000);
    // Another owner sees nothing and cannot act on the card.
    assert.equal((await proactive.today("other")).cards.length, 0);
    await assert.rejects(
      proactive.dismiss("other", { id: card.id }),
      /card_not_found/,
    );
    // Restart: committed watch state and ledger prevent a re-fire.
    await proactive.stop();
    await runtime.close();
    const g = fakeHA();
    Object.assign(g.states, f.states);
    ({ runtime, provider } = await open(dir, g.ha, provider));
    proactive = watch(runtime, g.ha.reader());
    clock += 60000;
    assert.equal((await proactive.tick()).cards, 0);
    // One bounded repeat while the condition still holds.
    clock += 30 * 60000;
    assert.equal((await proactive.tick()).cards, 1);
    clock += 30 * 60000;
    assert.equal((await proactive.tick()).cards, 0);
    today = await proactive.today("owner");
    assert.equal(today.cards.length, 2);
    assert.equal(today.cards[0]!.repeat, 1);
    // Read-only by construction: no HA writes, only exact state reads, no
    // new conversations and no model input were created.
    assert.equal(f.posts.length + g.posts.length, 0);
    assert(
      [...f.gets, ...g.gets].every((p) => p === "states/sensor.washer_state"),
    );
    assert.equal(
      (await runtime.harness.snapshot(Catalog, ctx))!.items.length,
      sessions,
    );
    assert.equal((await runtime.harness.inspect(ctx)).tasks.length, 0);
    // Out of read scope: the watcher pauses for repair instead of reading.
    g.policy.entities.splice(
      g.policy.entities.indexOf("sensor.washer_state"),
      1,
    );
    const reads = g.gets.length;
    clock += 60000;
    await proactive.tick();
    assert.equal(g.gets.length, reads);
    const settings = await proactive.settings("owner");
    assert.equal(settings.watchers[0]!.status, "needs_repair");
    await proactive.stop();
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("fixed clock: a schedule missed during downtime runs once, marked late, across restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-proactive-late-"));
  const f = fakeHA();
  let clock = at(2026, 10, 8, 6);
  let { runtime, provider } = await open(dir, f.ha);
  const watch = (rt: Runtime, ha = f.ha) =>
    new Proactive(rt.harness, ha.reader(), { now: () => clock });
  try {
    let proactive = watch(runtime);
    const added = await proactive.addWatcher("owner", {
      watcher: {
        when: { kind: "schedule", at: "07:00" },
        card: { title: "Take out the bins", body: "Collection is today." },
      },
    });
    assert(added.ok, JSON.stringify(added));
    assert.equal((await proactive.tick()).cards, 0, "created before 07:00");
    await proactive.stop();
    await runtime.close();
    // Hearth is off for two days; it comes back at 09:00 on day three.
    clock = at(2026, 10, 10, 9);
    const g = fakeHA();
    ({ runtime, provider } = await open(dir, g.ha, provider));
    proactive = watch(runtime, g.ha);
    assert.equal((await proactive.tick()).cards, 1);
    assert.equal((await proactive.tick()).cards, 0);
    let today = await proactive.today("owner");
    assert.equal(today.cards.length, 1);
    const card = today.cards[0]!;
    assert.equal(card.kind, "reminder");
    assert.equal(card.late, true);
    assert.equal(card.scheduledFor, at(2026, 10, 10, 7));
    assert.deepEqual(card.values, []);
    const ledger = (await runtime.harness.snapshot(WatchRuntime, ctx))!.ledger;
    assert.equal(Object.keys(ledger).length, 1);
    await proactive.stop();
    await runtime.close();
    const h = fakeHA();
    ({ runtime, provider } = await open(dir, h.ha, provider));
    proactive = watch(runtime, h.ha);
    assert.equal(
      (await proactive.tick()).cards,
      0,
      "no duplicate after reopen",
    );
    // The next slot on time is not late.
    clock = at(2026, 10, 11, 7, 1);
    assert.equal((await proactive.tick()).cards, 1);
    today = await proactive.today("owner");
    assert.equal(today.cards[0]!.late, false);
    assert.equal(
      f.gets.length + g.gets.length + h.gets.length,
      0,
      "a reminder reads nothing",
    );
    await proactive.stop();
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("briefing is off by default; at its time every value is a controller read and missing entities show unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-proactive-brief-"));
  const f = fakeHA();
  let clock = at(2026, 10, 8, 6);
  const { runtime, provider } = await open(dir, f.ha);
  try {
    const chat = await runtime.create("owner", "Laundry", "proactive-brief-1");
    await call(
      runtime,
      provider.faux,
      "owner",
      chat,
      "app_create",
      { spec: laundrySpec() },
      "proactive-brief-input",
    );
    const proactive = new Proactive(runtime.harness, f.ha.reader(), {
      now: () => clock,
    });
    let settings = await proactive.settings("owner");
    assert.equal(settings.briefings.morning.enabled, false);
    assert.equal(settings.briefings.evening.enabled, false);
    assert.deepEqual(settings.sources.apps, [
      { id: "app_1", title: "Laundry" },
    ]);
    await assert.rejects(
      proactive.saveBriefing("owner", {
        slot: "morning",
        enabled: true,
        at: "07:00",
        source: null,
      }),
      /briefing_source_required/,
    );
    await assert.rejects(
      proactive.saveBriefing("other", {
        slot: "morning",
        enabled: true,
        at: "07:00",
        source: { kind: "app", appId: "app_1" },
      }),
      /app_not_found/,
    );
    settings = await proactive.saveBriefing("owner", {
      slot: "morning",
      enabled: true,
      at: "07:00",
      source: { kind: "app", appId: "app_1" },
    });
    assert.equal(settings.briefings.morning.enabled, true);
    assert.equal((await proactive.tick()).cards, 0);
    // The washer power sensor leaves the read scope; the hall light's read fails.
    f.policy.entities.splice(
      f.policy.entities.indexOf("sensor.washer_power"),
      1,
    );
    delete f.states["light.hall"];
    f.states["sensor.washer_state"] = "unavailable";
    clock = at(2026, 10, 8, 7, 0) + 20000;
    assert.equal((await proactive.tick()).cards, 1);
    const card = (await proactive.today("owner")).cards[0]!;
    assert.equal(card.kind, "briefing");
    assert.equal(card.title, "Morning briefing");
    assert.equal(card.late, false);
    const byId = Object.fromEntries(card.values.map((v) => [v.entityId, v]));
    assert.deepEqual(Object.keys(byId).sort(), [
      "light.hall",
      "sensor.washer_power",
      "sensor.washer_state",
    ]);
    assert.equal(byId["sensor.washer_power"]!.available, false);
    assert.equal(byId["sensor.washer_power"]!.reason, "not_in_read_scope");
    assert.equal(byId["sensor.washer_power"]!.state, "");
    assert.equal(byId["light.hall"]!.reason, "read_failed");
    assert.equal(byId["sensor.washer_state"]!.reason, "unavailable");
    assert.equal(byId["sensor.washer_state"]!.label, "Washer");
    assert.match(card.body, /3 readings, 3 unavailable/);
    // Not a model run: no tasks, no conversations, no writes.
    assert.equal((await runtime.harness.inspect(ctx)).tasks.length, 0);
    assert.equal(f.posts.length, 0);
    assert.equal((await proactive.tick()).cards, 0);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Today inbox: unread, seen, snooze 1h/tonight/tomorrow and dismiss are owner-scoped and durable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-proactive-today-"));
  const f = fakeHA();
  let clock = at(2026, 10, 8, 6);
  const { runtime } = await open(dir, f.ha);
  try {
    const proactive = new Proactive(runtime.harness, f.ha.reader(), {
      now: () => clock,
    });
    for (const time of ["06:30", "06:45"])
      assert(
        (
          await proactive.addWatcher("owner", {
            watcher: {
              when: { kind: "schedule", at: time },
              card: { title: `Reminder ${time}` },
            },
          })
        ).ok,
      );
    const rejected = await proactive.addWatcher("owner", {
      watcher: {
        when: { kind: "transition", entity: "lock.front_door", to: "unlocked" },
        card: { title: "x" },
      },
    });
    assert.equal(rejected.ok, false);
    await proactive.tick();
    clock = at(2026, 10, 8, 7);
    assert.equal((await proactive.tick()).cards, 2);
    let today = await proactive.today("owner");
    assert.equal(today.unread, 2);
    today = await proactive.seen("owner", {});
    assert.equal(today.unread, 0);
    const [first, second] = today.cards;
    const snoozed = await proactive.snooze("owner", {
      id: first!.id,
      until: "1h",
    });
    assert.equal(snoozed.snoozedUntil, clock + 3600000);
    assert.equal(snoozed.cards.length, 1);
    assert.equal(snoozed.snoozed, 1);
    assert.equal(proactive.snoozeUntil("tonight", clock), at(2026, 10, 8, 19));
    assert.equal(proactive.snoozeUntil("tomorrow", clock), at(2026, 10, 9, 8));
    assert.throws(
      () => proactive.snoozeUntil("tonight", at(2026, 10, 8, 20)),
      /snooze_tonight_passed/,
    );
    await assert.rejects(
      proactive.snooze("owner", { id: first!.id, until: "forever" }),
      /invalid_snooze/,
    );
    // A snoozed card comes back unread once its time passes.
    clock += 3600000 + 1;
    today = await proactive.today("owner");
    assert.equal(today.cards.length, 2);
    assert.equal(today.unread, 1);
    await proactive.dismiss("owner", { id: second!.id });
    await proactive.asked("owner", { id: first!.id });
    today = await proactive.today("owner");
    assert.deepEqual(
      today.cards.map((c) => c.id),
      [first!.id],
    );
    assert.deepEqual(await proactive.signals("owner"), {
      created: 2,
      dismissed: 1,
      snoozed: 1,
      asked: 1,
      suppressed: 0,
    });
    const stored = JSON.stringify(
      await runtime.harness.snapshot(TodayInbox, ctx),
    );
    assert(!stored.includes("synthetic-supervisor-token"));
    const removed = await proactive.removeWatcher("owner", { id: "w_1" });
    assert.equal(removed.watchers.length, 1);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the timer polls only after its start delay, never overlaps passes and stops cleanly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-proactive-timer-"));
  const f = fakeHA();
  const { runtime } = await open(dir, f.ha);
  let reads = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const reader: StateReader = {
    entities: f.policy.entities,
    read: async (id) => {
      reads++;
      maxConcurrent = Math.max(maxConcurrent, ++concurrent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      concurrent--;
      return f.ha.state(id);
    },
  };
  try {
    const proactive = new Proactive(runtime.harness, reader, {
      intervalMs: 5,
      startDelayMs: 20,
    });
    assert(
      (
        await proactive.addWatcher("owner", {
          watcher: {
            when: {
              kind: "threshold",
              entity: "sensor.washer_power",
              above: 100,
            },
            card: { title: "Washer drawing power" },
          },
        })
      ).ok,
    );
    proactive.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(reads, 0, "nothing runs before the start delay");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await proactive.stop();
    const after = reads;
    assert(after >= 2, `polled ${after} times`);
    assert.equal(maxConcurrent, 1, "passes never overlap");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(reads, after, "no reads after stop");
    assert.equal((await proactive.today("owner")).cards.length, 1);
    assert.equal(f.posts.length, 0);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
