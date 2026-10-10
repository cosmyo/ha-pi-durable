// Shared lists (Home Assistant to-do lists) through the real durable harness,
// the Home permissions broker and fake HA REST/WebSocket transports. All data
// is synthetic (todo.example_groceries, "Oat milk", "Bread").
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.js";
import { Actions, HAClient, haExtension } from "../src/ha.js";
import { Proposals, type Proposal } from "../src/documents.js";
import { HA_WEBSOCKET_TYPES, sendAllowed } from "../src/ha-websocket.js";
import { LIST_LIMITS, ListStore, todoAction, todoView } from "../src/lists.js";
import type { RiskJudge } from "../src/judge.js";
import type { JudgeRecord } from "../src/documents.js";
import type { Policy } from "../src/config.js";
import { appServer } from "../src/server.js";
import { offline } from "./fixtures.js";
import { call } from "./app-fixtures.js";
import { GROCERIES, TOKEN, fakeListHA } from "./list-fixtures.js";

async function harness(ha: HAClient) {
  const dir = await mkdtemp(join(tmpdir(), "hearth-lists-"));
  const provider = offline();
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(ha)],
    [],
    undefined,
    ha.actions,
  );
  const mode = async (value: "read-only" | "ask" | "full", owner = "owner") => {
    const p = await ha.actions.settings(owner);
    return ha.actions.setMode(
      owner,
      value,
      p.revision,
      p.policy,
      value === "full" ? ha.actions.acknowledgement : undefined,
    );
  };
  return {
    dir,
    runtime,
    provider,
    mode,
    store: new ListStore(runtime, ha),
    close: async () => {
      await ha.actions.close();
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const judgeSaying = (verdict: JudgeRecord["verdict"]): RiskJudge => ({
  describe: () => ({ setting: "spy", model: "spy" }),
  evaluate: async () => ({
    model: "spy",
    verdict,
    reason: verdict,
    latencyMs: 0,
  }),
});
const press = (
  ha: HAClient,
  owner: string,
  sessionId: number,
  value: Record<string, unknown>,
) =>
  ha.actions.press(
    owner,
    sessionId,
    { kind: "todo", entityId: GROCERIES, ...value },
    { kind: "list", entityId: GROCERIES },
  );

test("list reads: todo/item/list is projected to uid/summary/status, capped, redacted; the socket allowlist adds only todo/item/list", async () => {
  const items = [
    {
      uid: "d",
      summary: `Line one\nline two ${TOKEN} ${"y".repeat(300)}`,
      status: "needs_action",
      due: "2026-03-01",
      description: "synthetic description",
    },
    { uid: "x", summary: "Odd status", status: "in_progress" },
    { uid: "", summary: "No uid", status: "needs_action" },
    { uid: "bad\u0007", summary: "Control uid", status: "needs_action" },
    ...Array.from({ length: 150 }, (_, i) => ({
      uid: `o${i}`,
      summary: `Item ${i}`,
      status: "needs_action",
    })),
    ...Array.from({ length: 30 }, (_, i) => ({
      uid: `c${i}`,
      summary: `Done ${i}`,
      status: "completed",
    })),
  ];
  const f = fakeListHA({
    lists: { [GROCERIES]: { name: "Groceries", features: 7, items } },
  });
  const read = await f.ha.readTodo(GROCERIES);
  assert.equal(read.name, "Groceries");
  assert.equal(read.features, 7);
  const view = todoView(read);
  assert.equal(view.openCount, 151);
  assert.equal(view.doneCount, 30);
  assert.equal(
    view.items.filter((i) => i.status === "needs_action").length,
    LIST_LIMITS.openItems,
  );
  assert.equal(
    view.items.filter((i) => i.status === "completed").length,
    LIST_LIMITS.doneItems,
  );
  const first = view.items[0]!;
  assert.deepEqual(Object.keys(first).sort(), ["status", "summary", "uid"]);
  assert.doesNotMatch(first.summary, /\n/);
  assert.doesNotMatch(JSON.stringify(view), new RegExp(TOKEN));
  assert.match(first.summary, /\[REDACTED\]/);
  assert.ok(first.summary.length <= LIST_LIMITS.summary);
  assert.doesNotMatch(
    JSON.stringify(view),
    /due|description|Odd status|No uid|Control uid/,
  );
  assert.deepEqual(
    f.frames.filter((m) => m.type !== "auth").map((m) => m.type),
    ["todo/item/list"],
  );
  assert.deepEqual(
    HA_WEBSOCKET_TYPES.filter((t) => t.startsWith("todo/")),
    ["todo/item/list"],
  );
  for (const type of ["todo/item/move", "todo/item/subscribe"])
    assert.throws(
      () => sendAllowed({ send() {} }, { type }),
      /ws_type_not_allowed/,
    );
  // Outside the exact read scope: refused before any request.
  const before = f.frames.length + f.gets.length;
  await assert.rejects(
    f.ha.readTodo("todo.example_other"),
    /entity_not_allowed/,
  );
  assert.equal(f.frames.length + f.gets.length, before);
  // A list Home Assistant cannot find is a read failure, never a guess.
  const missing = fakeListHA({
    policy: {
      enabled: true,
      entities: ["todo.example_missing"],
      services: ["todo.add_item"],
    },
  });
  await assert.rejects(
    missing.ha.readTodo("todo.example_missing"),
    /ha_read_failed/,
  );
});

test("todoAction shapes are strict; a supplied label is never trusted", async () => {
  const base = { kind: "todo", entityId: GROCERIES };
  for (const [value, code] of [
    [{ ...base, op: "add" }, /invalid_list_action/],
    [
      { ...base, op: "add", summary: "Bread", uid: "u1" },
      /invalid_list_action/,
    ],
    [{ ...base, op: "complete" }, /invalid_list_action/],
    [
      { ...base, op: "complete", uid: "u1", summary: "x" },
      /invalid_list_action/,
    ],
    [{ ...base, op: "rename", uid: "u1" }, /invalid_list_action/],
    [{ ...base, op: "move", uid: "u1" }, /invalid_list_action/],
    [{ ...base, op: "add", summary: " \n " }, /invalid_list_text/],
    [{ ...base, op: "add", summary: "y".repeat(201) }, /invalid_list_text/],
    [{ ...base, op: "remove", uid: "u\u0000" }, /invalid_request/],
    [{ ...base, op: "remove", uid: "u\u0007" }, /invalid_list_item/],
    [{ ...base, op: "remove", uid: "u".repeat(101) }, /invalid_request/],
    [{ ...base, op: "remove", uid: "u1", extra: 1 }, /invalid_request/],
    [
      { ...base, entityId: "light.example", op: "add", summary: "x" },
      /invalid_list/,
    ],
  ] as const)
    assert.throws(() => todoAction(value), code, JSON.stringify(value));
  assert.deepEqual(
    todoAction({ ...base, op: "add", summary: "  Oat\n milk " }),
    { kind: "todo", entityId: GROCERIES, op: "add", summary: "Oat milk" },
  );
  const f = fakeListHA();
  // The controller overwrites any label with its own read of the item.
  assert.deepEqual(
    await f.ha.prepareAction({
      kind: "todo",
      entityId: GROCERIES,
      op: "remove",
      uid: "u1",
      label: "Forged label",
    }),
    {
      kind: "todo",
      entityId: GROCERIES,
      op: "remove",
      uid: "u1",
      label: "Oat milk",
    },
  );
  assert.deepEqual(
    await f.ha.prepareAction({
      kind: "todo",
      entityId: GROCERIES,
      op: "add",
      summary: "Bread rolls",
      label: "Forged label",
    }),
    { kind: "todo", entityId: GROCERIES, op: "add", summary: "Bread rolls" },
  );
  await assert.rejects(
    f.ha.prepareAction({
      kind: "todo",
      entityId: GROCERIES,
      op: "add",
      summary: "oat MILK!",
    }),
    /already_on_list/,
  );
  await assert.rejects(
    f.ha.prepareAction({
      kind: "todo",
      entityId: GROCERIES,
      op: "complete",
      uid: "u9",
    }),
    /list_item_not_found/,
  );
  await assert.rejects(
    f.ha.prepareAction({
      kind: "todo",
      entityId: GROCERIES,
      op: "complete",
      uid: "u2",
    }),
    /list_item_changed/,
    "Bread is already done",
  );
  // validateLive needs the controller label to still match.
  await assert.rejects(
    f.ha.validateLive({
      kind: "todo",
      entityId: GROCERIES,
      op: "remove",
      uid: "u1",
      label: "Forged label",
    }),
    /list_item_changed/,
  );
  await assert.rejects(
    f.ha.validateLive({
      kind: "todo",
      entityId: GROCERIES,
      op: "remove",
      uid: "u1",
    }),
    /list_item_changed/,
  );
  f.lists[GROCERIES]!.features = 1;
  await assert.rejects(
    f.ha.validateLive({
      kind: "todo",
      entityId: GROCERIES,
      op: "remove",
      uid: "u1",
      label: "Oat milk",
    }),
    /list_feature_unsupported/,
  );
  assert.equal(f.posts.length, 0);
});

test("scoped lists need the exact entity AND the exact service; Read-only denies; all before any Home Assistant request", async () => {
  const scoped = fakeListHA({
    policy: {
      enabled: true,
      entities: [GROCERIES],
      services: ["todo.add_item", "todo.update_item"],
    },
  });
  const h = await harness(scoped.ha);
  try {
    const id = await h.runtime.create("owner", "Shared lists", "lists-s-1");
    await assert.rejects(
      press(scoped.ha, "owner", id, { op: "remove", uid: "u1" }),
      /service_not_allowed/,
    );
    await assert.rejects(
      scoped.ha.actions.press(
        "owner",
        id,
        {
          kind: "todo",
          entityId: "todo.example_other",
          op: "add",
          summary: "Bread",
        },
        { kind: "list", entityId: "todo.example_other" },
      ),
      /entity_not_allowed/,
    );
    assert.deepEqual(scoped.gets, []);
    assert.deepEqual(scoped.frames, []);
    // The scoped light/switch tool never carries a todo service.
    assert.throws(
      () =>
        scoped.ha.action({
          service: "todo.add_item",
          entityId: GROCERIES,
          data: {},
        }),
      /service_not_allowed|indirect_or_mismatched_target/,
    );
  } finally {
    await h.close();
  }
  const disabled = fakeListHA({
    policy: {
      enabled: false,
      entities: [GROCERIES],
      services: ["todo.add_item"],
    },
  });
  const d = await harness(disabled.ha);
  try {
    const id = await d.runtime.create("owner", "Shared lists", "lists-r-1");
    await assert.rejects(
      press(disabled.ha, "owner", id, { op: "add", summary: "Bread rolls" }),
      /home_read_only/,
    );
    await assert.rejects(
      d.store.press("owner", {
        sessionId: id,
        entityId: GROCERIES,
        op: "add",
        summary: "Bread rolls",
      }),
      /home_read_only/,
    );
    assert.deepEqual(disabled.gets, []);
    assert.deepEqual(disabled.frames, []);
    assert.equal(disabled.posts.length, 0);
  } finally {
    await d.close();
  }
});

test("scoped Full access never auto-runs a list change (AGENTS.md: scoped Full is light/switch only)", async () => {
  const f = fakeListHA();
  const h = await harness(f.ha);
  try {
    const id = await h.runtime.create("owner", "Shared lists", "lists-sf-1");
    await h.mode("full");
    f.ha.actions.useJudge(judgeSaying("agreed"));
    const added = await press(f.ha, "owner", id, {
      op: "add",
      summary: "Bread rolls",
    });
    assert.equal(added.status, "pending");
    assert.equal(added.authorization?.mode, "full");
    assert.equal(added.risk?.level, "low");
    const modelAdd = await call(
      h.runtime,
      h.provider.faux,
      "owner",
      id,
      "list_propose",
      { entityId: GROCERIES, op: "add", summary: "Apples" },
      "lists-sf-2",
    );
    assert.equal(modelAdd.status, "pending");
    assert.equal(modelAdd.judge.verdict, "agreed");
    assert.equal(f.posts.length, 0);
    const view = await h.store.lists("owner");
    assert.match(view.lists[0]!.controls.add.reason, /still ask/);
    // The approved change runs once, like any Ask proposal.
    await f.ha.actions.decide("owner", id, added.id, added.hash, "approve");
    assert.equal(f.posts.length, 1);
    // Light toggles keep their scoped Full behaviour.
    const light = await f.ha.actions.press(
      "owner",
      id,
      { service: "light.turn_on", entityId: "light.example", data: {} },
      { kind: "world", entityId: "light.example" },
    );
    assert.equal(light.status, "accepted");
  } finally {
    await h.close();
  }
});

test("admin Full access runs low list changes once; rename/remove always ask, even when the judge agrees; a misaligned add asks", async () => {
  const f = fakeListHA({
    policy: { enabled: true, entities: [], services: [], access: "admin" },
  });
  const h = await harness(f.ha);
  let n = 0;
  const propose = (id: number, args: Record<string, unknown>) =>
    call(
      h.runtime,
      h.provider.faux,
      "owner",
      id,
      "list_propose",
      { entityId: GROCERIES, ...args },
      `lists-full-${++n}`,
    );
  try {
    const id = await h.runtime.create("owner", "Shared lists", "lists-f-1");
    await h.mode("full");
    const added = await press(f.ha, "owner", id, {
      op: "add",
      summary: "Bread rolls",
    });
    assert.equal(added.status, "accepted");
    assert.equal(added.authorization?.mode, "full");
    assert.equal(added.risk?.level, "low");
    assert.equal(added.risk?.rule, "list_add");
    assert.deepEqual(f.posts, [
      {
        path: "services/todo/add_item",
        body: { item: "Bread rolls", entity_id: GROCERIES },
      },
    ]);
    const done = await press(f.ha, "owner", id, { op: "complete", uid: "u1" });
    assert.equal(done.status, "accepted");
    assert.equal((done.action as { label?: string }).label, "Oat milk");
    assert.deepEqual(f.posts[1]!.body, {
      item: "u1",
      status: "completed",
      entity_id: GROCERIES,
    });
    const removal = await press(f.ha, "owner", id, { op: "remove", uid: "u2" });
    assert.equal(removal.status, "pending");
    assert.equal(removal.risk?.level, "medium");
    assert.equal(f.posts.length, 2);

    // Model path: the judge sees the controller-read label; it may only
    // make things stricter.
    f.ha.actions.useJudge(judgeSaying("agreed"));
    const modelAdd = await propose(id, { op: "add", summary: "Apples" });
    assert.equal(modelAdd.status, "accepted");
    assert.equal(modelAdd.authorization.source, "automatic");
    assert.equal(f.posts.length, 3);
    const modelRemove = await propose(id, { op: "remove", uid: "u2" });
    assert.equal(
      modelRemove.status,
      "pending",
      "medium list ops never auto-run",
    );
    assert.equal(modelRemove.judge.verdict, "agreed");
    assert.equal(modelRemove.action.label, "Bread");
    const modelRename = await propose(id, {
      op: "rename",
      uid: "u2",
      summary: "Rye bread",
    });
    assert.equal(modelRename.status, "pending");
    f.ha.actions.useJudge(judgeSaying("misaligned"));
    const misaligned = await propose(id, { op: "add", summary: "Pears" });
    assert.equal(misaligned.status, "pending");
    assert.equal(f.posts.length, 3);
    // The tool schema has no label; an extra key is refused.
    const forged = await propose(id, {
      op: "remove",
      uid: "u2",
      label: "Forged",
    }).catch((error: Error) => error);
    assert.ok(forged instanceof Error || forged.isError);
    // Only list_read/list_propose are added, both only with a todo entity.
    const names = haExtension(f.ha).tools!.map((t) => t.name);
    assert(names.includes("list_read") && names.includes("list_propose"));
    const view = await h.store.lists("owner");
    assert.equal(
      view.lists[0]!.controls.add.reason,
      "Full access: adding runs once.",
    );
    const noLists = new HAClient(TOKEN, {
      enabled: true,
      entities: ["light.example"],
      services: ["light.turn_on"],
    });
    assert(
      !haExtension(noLists)
        .tools!.map((t) => t.name)
        .some((name) => name.startsWith("list_")),
    );
    const read = await call(
      h.runtime,
      h.provider.faux,
      "owner",
      id,
      "list_read",
      { entityId: GROCERIES },
      `lists-full-${++n}`,
    );
    assert.equal(read.name, "Groceries");
    assert.deepEqual(
      read.done.map((i: { summary: string }) => i.summary),
      ["Oat milk", "Bread"],
    );
  } finally {
    await h.close();
  }
});

test("Ask: an item renamed between proposal and approval is refused with zero POSTs; the proposal stays pending", async () => {
  const f = fakeListHA();
  const h = await harness(f.ha);
  try {
    const id = await h.runtime.create("owner", "Shared lists", "lists-a-1");
    const pending = await press(f.ha, "owner", id, {
      op: "complete",
      uid: "u1",
    });
    assert.equal(pending.status, "pending");
    assert.equal(pending.authorization?.mode, "ask");
    // Someone renames the item in the Home Assistant app.
    f.lists[GROCERIES]!.items[0]!.summary = "Oat milk (2 cartons)";
    await assert.rejects(
      f.ha.actions.decide("owner", id, pending.id, pending.hash, "approve"),
      /list_item_changed/,
    );
    assert.equal(f.posts.length, 0);
    const after = (await h.runtime.harness.snapshot(
      Proposals,
      id as ConversationId,
      ctx,
    ))!.items[pending.id]!;
    assert.equal(after.status, "pending");
    // Unchanged item: approval sends exactly one POST.
    f.lists[GROCERIES]!.items[0]!.summary = "Oat milk";
    await f.ha.actions.decide("owner", id, pending.id, pending.hash, "approve");
    assert.equal(f.posts.length, 1);
  } finally {
    await h.close();
  }
});

test("a failed list write is unknown, never retried, and pauses Home writes for every owner until its owner resolves it", async () => {
  const f = fakeListHA({
    post: async () => {
      throw new Error("synthetic transport failure");
    },
  });
  const h = await harness(f.ha);
  try {
    const id = await h.runtime.create("owner", "Shared lists", "lists-u-1");
    const otherId = await h.runtime.create(
      "other",
      "Shared lists",
      "lists-u-2",
    );
    const proposed = await press(f.ha, "owner", id, {
      op: "add",
      summary: "Bread rolls",
    });
    assert.equal(proposed.status, "pending");
    await f.ha.actions.decide(
      "owner",
      id,
      proposed.id,
      proposed.hash,
      "approve",
    );
    const unknown = (await h.runtime.harness.snapshot(
      Proposals,
      id as ConversationId,
      ctx,
    ))!.items[proposed.id]!;
    assert.equal(unknown.status, "unknown");
    assert.equal(f.posts.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.posts.length, 1, "never retried");
    const settings = await f.ha.actions.settings("other");
    assert.equal(settings.blocked, true);
    assert.deepEqual(settings.unresolved, []);
    await assert.rejects(
      h.store.press("other", {
        sessionId: otherId,
        entityId: GROCERIES,
        op: "complete",
        uid: "u1",
      }),
      /home_outcome_unresolved/,
    );
    await assert.rejects(
      press(f.ha, "other", otherId, { op: "complete", uid: "u1" }),
      /home_outcome_unresolved/,
    );
    await assert.rejects(
      f.ha.actions.press(
        "other",
        otherId,
        { service: "light.turn_on", entityId: "light.example", data: {} },
        { kind: "world", entityId: "light.example" },
      ),
      /home_outcome_unresolved/,
    );
    const lists = await h.store.lists("other");
    assert.equal(lists.blocked, true);
    assert.match(lists.lists[0]!.controls.add.reason, /paused/);
    assert.equal(lists.lists[0]!.controls.add.enabled, false);
    // Only the owning human can resolve it.
    await assert.rejects(
      f.ha.actions.decide(
        "other",
        id,
        unknown.id,
        unknown.hash,
        "resolve",
        "x",
      ),
      /session_not_found/,
    );
    await f.ha.actions.decide(
      "owner",
      id,
      unknown.id,
      unknown.hash,
      "resolve",
      "Checked the list: it is there.",
    );
    assert.equal((await f.ha.actions.settings("other")).blocked, false);
    assert.equal(f.posts.length, 1);
  } finally {
    await h.close();
  }
});

test("ListStore: scoped list filtering, controls and reasons, owner-scoped presses, validation, read rate limit and proposal_limit", async () => {
  const lists = {
    "todo.example_b": {
      name: "Hardware",
      features: 1 | 4,
      items: [{ uid: "h1", summary: "Hinges", status: "needs_action" }],
    },
    "todo.example_a": {
      name: "<img src=x onerror=alert(1)>",
      features: 7,
      items: [{ uid: "a1", summary: "Oat milk", status: "needs_action" }],
    },
  };
  const policy: Policy = {
    enabled: true,
    entities: ["todo.example_b", "light.example", "todo.example_a", "sensor.x"],
    services: ["todo.add_item", "todo.update_item"],
  };
  const f = fakeListHA({ policy, lists });
  const h = await harness(f.ha);
  let clock = 1_000_000;
  const store = new ListStore(h.runtime, f.ha, () => clock);
  try {
    const id = await h.runtime.create("owner", "Shared lists", "lists-h-1");
    const otherId = await h.runtime.create("other", "Other", "lists-h-2");
    const view = await store.lists("owner");
    assert.deepEqual(
      view.lists.map((l) => l.entityId),
      ["todo.example_a", "todo.example_b"],
    );
    assert.equal(view.mode, "ask");
    const [a, b] = view.lists;
    assert.equal(a!.available, true);
    assert.equal(a!.controls.add.enabled, true);
    assert.match(a!.controls.add.reason, /^Ask:/);
    assert.equal(a!.controls.remove.enabled, false);
    assert.match(
      a!.controls.remove.reason,
      /Outside Hearth's configured service scope \(todo\.remove_item\)/,
    );
    assert.equal(b!.controls.update.enabled, true);
    // Read-only shows its own reason.
    await h.mode("read-only");
    const readOnly = await store.lists("owner");
    assert.match(readOnly.lists[0]!.controls.add.reason, /Read-only/);
    await h.mode("ask");
    // Owner-scoped: another owner's chat is not found.
    await assert.rejects(
      store.press("owner", {
        sessionId: otherId,
        entityId: "todo.example_a",
        op: "add",
        summary: "Bread",
      }),
      /session_not_found/,
    );
    for (const body of [
      {
        sessionId: id,
        entityId: "todo.example_a",
        op: "add",
        summary: "x",
        label: "y",
      },
      { sessionId: id, entityId: "todo.example_a", op: "move", uid: "a1" },
      { sessionId: 0, entityId: "todo.example_a", op: "add", summary: "x" },
      { sessionId: id, entityId: "todo.example_a", op: "add" },
    ])
      await assert.rejects(store.press("owner", body), /invalid/);
    const pending = await store.press("owner", {
      sessionId: id,
      entityId: "todo.example_a",
      op: "complete",
      uid: "a1",
    });
    assert.equal(pending.proposal.status, "pending");
    assert.deepEqual(pending.proposal.origin, {
      kind: "list",
      entityId: "todo.example_a",
    });
    assert.equal(pending.list, null);
    // proposal_limit: a full chat refuses the press; nothing is sent.
    await h.runtime.harness.commit(async (tx) => {
      const doc = await tx.doc(Proposals, id as ConversationId);
      for (let i = 0; Object.keys(doc.items).length < 100; i++)
        doc.items[`filler-${i}`] = {
          ...pending.proposal,
          id: `filler-${i}`,
          status: "rejected",
        } as Proposal;
    }, ctx);
    await assert.rejects(
      store.press("owner", {
        sessionId: id,
        entityId: "todo.example_a",
        op: "add",
        summary: "Bread",
      }),
      /proposal_limit/,
    );
    assert.equal(f.posts.length, 0);
    // Reads: 20 per owner per minute.
    const limited = new ListStore(h.runtime, f.ha, () => clock);
    for (let i = 0; i < LIST_LIMITS.readsPerMinute; i++)
      await limited.lists("owner");
    await assert.rejects(limited.lists("owner"), /rate_limit/);
    await limited.lists("other");
    clock += 61000;
    await limited.lists("owner");
  } finally {
    await h.close();
  }
  // Admin mode: every todo.* entity Home Assistant reports, at most 8.
  const many = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [
      `todo.example_${String(i).padStart(2, "0")}`,
      { name: `List ${i}`, features: 7, items: [] },
    ]),
  );
  const admin = fakeListHA({
    policy: {
      enabled: true,
      entities: [],
      services: [],
      access: "admin",
    },
    lists: many,
  });
  const ids = await admin.ha.todoEntities();
  assert.equal(ids.length, LIST_LIMITS.lists);
  assert.equal(ids[0], "todo.example_00");
});

test("HTTP: /api/lists and /api/lists/actions require authentication and Origin/CSRF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-lists-http-"));
  const provider = offline();
  const f = fakeListHA({ owners: ["local-admin"] });
  const cfg = {
    mode: "local" as const,
    host: "127.0.0.1",
    port: 8099,
    origin: "http://127.0.0.1:8099",
    password: "synthetic-local-password-0003",
    authorizedUsers: [],
    dataDir: dir,
    provider: "offline" as const,
    model: "test",
    policy: f.policy,
    haToken: TOKEN,
    apiKey: "synthetic-provider-key",
  };
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(f.ha)],
    [],
    undefined,
    f.ha.actions,
  );
  const app = appServer(cfg, runtime, new Actions(runtime, f.ha));
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  cfg.origin = base;
  const authorization = `Basic ${Buffer.from(`hearth:${cfg.password}`).toString("base64")}`;
  try {
    assert.equal((await fetch(`${base}/api/lists`)).status, 401);
    const boot = await fetch(`${base}/api/bootstrap`, {
      headers: { authorization },
    });
    const bootBody = await boot.json();
    assert.match(bootBody.safety, /to-do lists/);
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const post = (path: string, value: unknown, csrf = bootBody.csrf) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          authorization,
          cookie,
          origin: base,
          "x-hearth-csrf": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(value),
      });
    const listed = await (
      await fetch(`${base}/api/lists`, { headers: { authorization } })
    ).json();
    assert.equal(listed.lists[0].name, "Groceries");
    const id = (
      await (
        await post("/api/sessions", {
          title: "Shared lists",
          requestId: "lists-http-1",
        })
      ).json()
    ).id;
    const body = {
      sessionId: id,
      entityId: GROCERIES,
      op: "add",
      summary: "Bread rolls",
    };
    assert.equal(
      (await post("/api/lists/actions", body, "forged")).status,
      403,
    );
    const pressed = await post("/api/lists/actions", body);
    assert.equal(pressed.status, 200);
    assert.equal((await pressed.json()).proposal.status, "pending");
    assert.equal(f.posts.length, 0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("admin generic service calls into a to-do list follow the list rule: non-low changes always ask", async () => {
  const { autoRunAllowed } = await import("../src/home-actions.js");
  const agreed = {
    model: "systemone/example",
    verdict: "agreed",
    reason: "",
    latencyMs: 1,
  } as JudgeRecord;
  const medium = {
    level: "medium",
    rule: "service_default",
    reasons: [],
  } as never;
  const low = { level: "low", rule: "list_add", reasons: [] } as never;
  const remove = {
    kind: "service",
    domain: "todo",
    service: "remove_item",
    data: { entity_id: "todo.example_groceries", item: ["uid-1"] },
  } as never;
  const lamp = {
    kind: "service",
    domain: "fan",
    service: "turn_on",
    data: { entity_id: "fan.example_breezy" },
  } as never;
  assert.equal(autoRunAllowed(medium, agreed, remove, true), false);
  assert.equal(autoRunAllowed(low, agreed, remove, true), true);
  // other admin services keep the existing medium + agreed rule
  assert.equal(autoRunAllowed(medium, agreed, lamp, true), true);
});
