import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { HAClient, haExtension } from "../src/ha.js";
import { Runtime } from "../src/runtime.js";
import { Proposals, type Proposal } from "../src/documents.js";
import { FULL_ACKNOWLEDGEMENT } from "../src/home-actions.js";
import {
  UNDO_WINDOW_MS,
  entitySnapshot,
  reverseEntityAction,
  reverseTodoAction,
  undoSubject,
} from "../src/undo.js";
import { GROCERIES, fakeListHA } from "./list-fixtures.js";
import { offline } from "./fixtures.js";

const LAMP = "light.example_lamp";
const OWNER = "user-owner-a";

// A lamp whose state the fake HA changes on each accepted POST.
function lampHA(
  options: {
    services?: string[];
    post?: () => Promise<Response> | Response;
    onPost?: () => Promise<void>;
  } = {},
) {
  const lamp = {
    state: "off",
    brightness: null as number | null,
    changed: Date.now() - 3600000,
  };
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const transport = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const path = String(url).replace("http://supervisor/core/api/", "");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path, body });
      await options.onPost?.();
      if (options.post) return options.post();
      lamp.state = path.endsWith("turn_on") ? "on" : "off";
      lamp.brightness =
        lamp.state === "on" ? Number(body.brightness ?? 255) : null;
      lamp.changed = Date.now();
      return Response.json([]);
    }
    if (path === "services")
      return Response.json([
        { domain: "light", services: { turn_on: {}, turn_off: {} } },
      ]);
    return Response.json({
      entity_id: LAMP,
      state: lamp.state,
      last_changed: new Date(lamp.changed).toISOString(),
      attributes: {
        friendly_name: "Example lamp",
        ...(lamp.brightness === null ? {} : { brightness: lamp.brightness }),
      },
    });
  }) as typeof fetch;
  const ha = new HAClient(
    "synthetic-token",
    {
      enabled: true,
      entities: [LAMP],
      services: options.services ?? ["light.turn_on", "light.turn_off"],
    },
    transport,
  );
  ha.actions.authorizeOwners([OWNER]);
  return { ha, lamp, posts };
}
async function open(t: TestContext, ha: HAClient, dir?: string) {
  const home = dir ?? (await mkdtemp(join(tmpdir(), "hearth-undo-")));
  const { models, model } = offline();
  const runtime = await Runtime.open(
    home,
    models,
    model,
    [haExtension(ha)],
    [],
    undefined,
    ha.actions,
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await ha.actions.close();
    await runtime.close();
  };
  if (!dir)
    t.after(async () => {
      await close();
      await rm(home, { recursive: true, force: true });
    });
  return { runtime, dir: home, close };
}
async function setup(
  t: TestContext,
  options: Parameters<typeof lampHA>[0] = {},
) {
  const fake = lampHA(options);
  const { runtime, dir, close } = await open(t, fake.ha);
  const session = await runtime.create(OWNER, "Home", "create-undo-1");
  const items = async () =>
    (await runtime.harness.snapshot(Proposals, session as ConversationId, ctx))!
      .items;
  const mode = async (value: "ask" | "full") => {
    const p = await fake.ha.actions.settings(OWNER);
    await fake.ha.actions.setMode(
      OWNER,
      value,
      p.revision,
      p.policy,
      value === "full" ? FULL_ACKNOWLEDGEMENT : undefined,
    );
  };
  const press = (data: { brightness?: number } = { brightness: 42 }) =>
    fake.ha.actions.press(
      OWNER,
      session,
      { service: "light.turn_on", entityId: LAMP, data },
      { kind: "world", entityId: LAMP },
    );
  const approve = (p: Proposal) =>
    fake.ha.actions.decide(OWNER, session, p.id, p.hash, "approve");
  const undo = (p: Proposal) =>
    fake.ha.actions.undo(OWNER, session, p.id, p.hash);
  return {
    ...fake,
    runtime,
    dir,
    close,
    session,
    items,
    mode,
    press,
    approve,
    undo,
  };
}

test("undo: the snapshot is committed before the POST; Ask files the exact reverse as a new pending proposal, once", async (t) => {
  let seen: Proposal | undefined;
  let f!: Awaited<ReturnType<typeof setup>>;
  f = await setup(t, {
    onPost: async () => {
      if (!seen)
        seen = Object.values(await f.items()).find(
          (p) => p.status === "dispatching",
        );
    },
  });
  const pending = await f.press();
  assert.equal(pending.status, "pending");
  await f.approve(pending);
  // Read before the change, persisted with the dispatch intent.
  assert.equal(seen?.undo?.before.kind, "entity");
  assert.equal((seen!.undo!.before as { state: string }).state, "off");
  assert.ok(seen!.attemptedAt);
  const accepted = (await f.items())[pending.id]!;
  assert.equal(accepted.status, "accepted");
  assert.ok(
    accepted.undo!.until! > Date.now() + UNDO_WINDOW_MS - 5000 &&
      accepted.undo!.until! <= Date.now() + UNDO_WINDOW_MS,
  );
  assert.deepEqual(Object.keys(accepted.undo!.before).sort(), [
    "attrs",
    "entityId",
    "kind",
    "lastChangedMs",
    "readAt",
    "state",
  ]);
  // No friendly name or other attribute in the snapshot.
  assert.doesNotMatch(JSON.stringify(accepted.undo), /Example lamp/);
  const reverse = await f.undo(accepted);
  assert.equal(reverse.status, "pending");
  assert.deepEqual(reverse.action, {
    service: "light.turn_off",
    entityId: LAMP,
    data: {},
  });
  assert.deepEqual(reverse.origin, {
    kind: "undo",
    proposalId: accepted.id,
    hash: accepted.hash,
  });
  assert.equal(reverse.risk?.level, "low");
  assert.equal((await f.items())[accepted.id]!.undo!.reverse, reverse.id);
  assert.equal(f.posts.length, 1);
  // Double undo while the reverse is pending.
  await assert.rejects(f.undo(accepted), /undo_already_used/);
  // Rejecting the reverse offers Undo again.
  await f.ha.actions.decide(
    OWNER,
    f.session,
    reverse.id,
    reverse.hash,
    "reject",
  );
  const again = await f.undo(accepted);
  await f.approve(again);
  assert.equal(f.lamp.state, "off");
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[1]!.path, "services/light/turn_off");
  // Undo of an undo is refused; the reverse has no undo of its own.
  const done = (await f.items())[again.id]!;
  assert.equal(done.status, "accepted");
  assert.equal(done.undo, undefined);
  await assert.rejects(f.undo(done), /undo_unavailable/);
  await assert.rejects(f.undo(accepted), /undo_already_used/);
});

test("undo: Full access auto-runs a low reverse once, but asks when the entity changed again later", async (t) => {
  const f = await setup(t);
  await f.mode("full");
  const first = await f.press();
  assert.equal(first.status, "accepted");
  const reverse = await f.undo(first);
  assert.equal(reverse.status, "accepted");
  assert.equal(f.posts.length, 2);
  assert.equal(f.lamp.state, "off");
  // Changed again well after the attempt: the reverse must ask.
  const second = await f.press({ brightness: 10 });
  assert.equal(second.status, "accepted");
  f.lamp.brightness = 99;
  f.lamp.changed = Date.now() + 60000;
  const asked = await f.undo(second);
  assert.equal(asked.status, "pending");
  assert.equal(f.posts.length, 3);
});

test("undo: nothing to undo, an expired window, unknown/failed and high outcomes", async (t) => {
  const f = await setup(t);
  const p = await f.press();
  await f.approve(p);
  let accepted = (await f.items())[p.id]!;
  // Someone already turned it back off.
  f.lamp.state = "off";
  f.lamp.brightness = null;
  await assert.rejects(f.undo(accepted), /nothing_to_undo/);
  f.lamp.state = "on";
  f.lamp.brightness = 42;
  // Window passed.
  await f.runtime.harness.commit(async (tx) => {
    (await tx.doc(Proposals, f.session as ConversationId)).items[
      p.id
    ]!.undo!.until = Date.now() - 1;
  }, ctx);
  accepted = (await f.items())[p.id]!;
  await assert.rejects(f.undo(accepted), /undo_expired/);
  // A high (e.g. judge-escalated) receipt gets no snapshot and no undo.
  const high = await f.press({ brightness: 20 });
  await f.runtime.harness.commit(async (tx) => {
    (await tx.doc(Proposals, f.session as ConversationId)).items[
      high.id
    ]!.risk = { level: "high", rule: "judge_escalated:test", reasons: [] };
  }, ctx);
  await f.approve(high);
  const highDone = (await f.items())[high.id]!;
  assert.equal(highDone.status, "accepted");
  assert.equal(highDone.undo, undefined);
  await assert.rejects(f.undo(highDone), /undo_unavailable/);
  await assert.rejects(
    f.ha.actions.undo(OWNER, f.session, p.id, "0".repeat(64)),
    /proposal_not_found/,
  );
});

test("undo: unknown outcomes have no undo and their barrier blocks undo of other receipts", async (t) => {
  let fail = false;
  const f = await setup(t, {
    post: () => {
      if (fail) throw new Error("uncertain");
      return Response.json([]);
    },
  });
  const ok = await f.press();
  await f.approve(ok);
  const accepted = (await f.items())[ok.id]!;
  assert.ok(accepted.undo?.until);
  fail = true;
  const lost = await f.press({ brightness: 7 });
  await f.approve(lost).catch(() => {});
  const unknown = (await f.items())[lost.id]!;
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.undo?.until, undefined);
  await assert.rejects(f.undo(unknown), /undo_unavailable/);
  // The lamp is still "off" in this fake (POSTs did not change it), so
  // make it differ from the snapshot, then the barrier must refuse.
  f.lamp.state = "on";
  f.lamp.brightness = 42;
  await assert.rejects(f.undo(accepted), /home_outcome_unresolved/);
});

test("undo: scoped mode offers it only when the reverse service is configured", async (t) => {
  const f = await setup(t, { services: ["light.turn_on"] });
  const p = await f.press();
  await f.approve(p);
  const accepted = (await f.items())[p.id]!;
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.undo, undefined);
  await assert.rejects(f.undo(accepted), /undo_unavailable/);
});

test("undo: accepted receipts keep their undo data across a restart", async (t) => {
  const f = await setup(t);
  const p = await f.press();
  await f.approve(p);
  const until = (await f.items())[p.id]!.undo!.until;
  await f.close();
  const again = lampHA();
  again.lamp.state = "on";
  again.lamp.brightness = 42;
  const reopened = await open(t, again.ha, f.dir);
  t.after(async () => {
    await reopened.close();
    await rm(f.dir, { recursive: true, force: true });
  });
  const item = (await reopened.runtime.harness.snapshot(
    Proposals,
    f.session as ConversationId,
    ctx,
  ))!.items[p.id]!;
  assert.equal(item.undo!.until, until);
  const reverse = await again.ha.actions.undo(OWNER, f.session, p.id, p.hash);
  assert.equal(reverse.status, "pending");
});

test("undo: list changes reverse exactly; an added item with a duplicate is refused; removals have none", async (t) => {
  const fake = fakeListHA({ owners: [OWNER] });
  const { runtime } = await open(t, fake.ha);
  const session = await runtime.create(OWNER, "Home", "create-undo-list");
  const items = async () =>
    (await runtime.harness.snapshot(Proposals, session as ConversationId, ctx))!
      .items;
  const run = async (value: Record<string, unknown>) => {
    const p = await fake.ha.actions.press(
      OWNER,
      session,
      { kind: "todo", entityId: GROCERIES, ...value },
      { kind: "list", entityId: GROCERIES },
    );
    await fake.ha.actions.decide(OWNER, session, p.id, p.hash, "approve");
    return (await items())[p.id]!;
  };
  const completed = await run({ op: "complete", uid: "u1" });
  assert.ok(completed.undo?.until);
  const reopen = await fake.ha.actions.undo(
    OWNER,
    session,
    completed.id,
    completed.hash,
  );
  assert.deepEqual(reopen.action, {
    kind: "todo",
    entityId: GROCERIES,
    op: "reopen",
    uid: "u1",
    label: "Oat milk",
  });
  const added = await run({ op: "add", summary: "Rye bread" });
  assert.ok(added.undo?.until);
  // Someone added the same text again: which one to remove is ambiguous.
  fake.lists[GROCERIES]!.items.push({
    uid: "u-dup",
    summary: "Rye bread",
    status: "needs_action",
  });
  await assert.rejects(
    fake.ha.actions.undo(OWNER, session, added.id, added.hash),
    /undo_item_ambiguous/,
  );
  fake.lists[GROCERIES]!.items = fake.lists[GROCERIES]!.items.filter(
    (i) => i.uid !== "u-dup",
  );
  const removal = await fake.ha.actions.undo(
    OWNER,
    session,
    added.id,
    added.hash,
  );
  assert.equal((removal.action as { op: string }).op, "remove");
  const removed = await run({ op: "remove", uid: "u2" });
  assert.equal(removed.status, "accepted");
  assert.equal(removed.undo, undefined);
});

test("undo allowlist: single entity only, no device/area targets, restorable data keys", () => {
  const service = (data: Record<string, unknown>, target: object) =>
    ({
      kind: "service",
      domain: "light",
      service: "turn_on",
      target,
      data,
    }) as never;
  assert.ok(
    undoSubject(service({ brightness: 3 }, { entity_id: [LAMP] }), true),
  );
  assert.equal(
    undoSubject(service({}, { entity_id: [LAMP, "light.b"] }), true),
    null,
  );
  assert.equal(
    undoSubject(service({}, { entity_id: [LAMP], area_id: ["study"] }), true),
    null,
  );
  assert.equal(
    undoSubject(service({ effect: "x" }, { entity_id: [LAMP] }), true),
    null,
  );
  // Admin service calls are not reversible in scoped mode.
  assert.equal(undoSubject(service({}, { entity_id: [LAMP] }), false), null);
  assert.equal(
    undoSubject(
      {
        kind: "service",
        domain: "lock",
        service: "unlock",
        target: { entity_id: ["lock.example"] },
        data: {},
      },
      true,
    ),
    null,
  );
  assert.equal(
    undoSubject(
      { kind: "config", resource: "automation", op: "delete", id: "x" },
      true,
    ),
    null,
  );
  const before = entitySnapshot(
    "climate.example",
    {
      entity_id: "climate.example",
      state: "heat",
      attributes: { temperature: 19.5, hvac_modes: ["heat"] },
    },
    1,
  )!;
  assert.deepEqual(before.attrs, { temperature: 19.5 });
  assert.deepEqual(
    reverseEntityAction(
      {
        kind: "service",
        domain: "climate",
        service: "set_temperature",
        target: { entity_id: ["climate.example"] },
        data: { temperature: 22 },
      },
      before,
    ),
    {
      kind: "service",
      domain: "climate",
      service: "set_temperature",
      target: { entity_id: ["climate.example"] },
      data: { temperature: 19.5 },
    },
  );
  assert.equal(
    reverseTodoAction(
      { kind: "todo", entityId: GROCERIES, op: "add", summary: "x" },
      ["a", "b"],
    ),
    null,
  );
  assert.equal(
    reverseTodoAction({
      kind: "todo",
      entityId: GROCERIES,
      op: "remove",
      uid: "a",
    }),
    null,
  );
});

test("receipt UI: Undo button with its deadline only while offered", async () => {
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
  const { renderProposals, undoOffered } = await import(
    new URL("../public/render.js", import.meta.url).href
  );
  const base = {
    hash: "a".repeat(64),
    policy: "p",
    expires: Date.now() + 60000,
    decidedBy: OWNER,
    decidedAt: 1,
    resolution: "",
    action: { service: "light.turn_on", entityId: LAMP, data: {} },
    risk: { level: "low", rule: "low_domain", reasons: [] },
    status: "accepted",
  };
  const later = Date.now() + 300000;
  const proposals = {
    "1": { ...base, id: "1", created: 1, undo: { before: {}, until: later } },
    "2": {
      ...base,
      id: "2",
      created: 2,
      undo: { before: {}, until: Date.now() - 1 },
    },
    "3": {
      ...base,
      id: "3",
      created: 3,
      undo: { before: {}, until: later, reverse: "4" },
    },
    "4": {
      ...base,
      id: "4",
      created: 4,
      status: "pending",
      origin: { kind: "undo", proposalId: "3", hash: "a".repeat(64) },
    },
  };
  assert.deepEqual(
    Object.values(proposals).map((p) => undoOffered(p, proposals)),
    [true, false, false, false],
  );
  const decisions: unknown[][] = [];
  const container = document.getElementById("cards")!;
  renderProposals(container, proposals, (...args: unknown[]) =>
    decisions.push(args),
  );
  const buttons = [...container.querySelectorAll("button.undo")];
  assert.equal(buttons.length, 1);
  assert.match(container.textContent ?? "", /Undo until/);
  assert.match(container.textContent ?? "", /Undo of an earlier change/);
  (buttons[0] as HTMLButtonElement).click();
  assert.equal(decisions[0]![1], "undo");
});
