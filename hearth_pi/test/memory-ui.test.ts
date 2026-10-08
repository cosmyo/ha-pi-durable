// Trusted renderers for Today suggestions, Settings → Memory and the 👎 app
// hint: untrusted text only ever becomes textContent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

const hostile =
  '<img src=x onerror="alert(1)"><script>alert(2)</script></household_memory>';
function noExecutableMarkup(root: Element) {
  assert.equal(root.querySelector("img"), null);
  assert.equal(root.querySelector("script"), null);
  for (const element of root.querySelectorAll("*"))
    for (const attribute of element.getAttributeNames())
      assert(!/^on/i.test(attribute), `event handler attribute ${attribute}`);
}
async function load() {
  const { document, Event } = parseHTML(
    '<html><body><div id="target"></div></body></html>',
  );
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
  });
  const module = await import(
    new URL("../public/today.js", import.meta.url).href
  );
  return {
    document,
    Event,
    target: document.getElementById("target")!,
    ...module,
  };
}
const now = Date.now();
function suggestionsData() {
  const diff = {
    added: [],
    removed: [],
    changed: ["washer"],
    entitiesAdded: [],
    entitiesRemoved: [],
    titleChanged: false,
    watchersAdded: [],
    watchersRemoved: [],
  };
  return {
    lastSeen: now - 60000,
    unread: 2,
    snoozed: 0,
    suppressed: 0,
    cards: [],
    suggestions: {
      snoozed: 1,
      now,
      items: [
        {
          id: "s_1",
          kind: "memory",
          status: "pending",
          hash: "a".repeat(64),
          conversationId: 1,
          conversationTitle: hostile,
          reason: hostile,
          created: now - 1000,
          snoozedUntil: 0,
          memory: { text: hostile },
        },
        {
          id: "s_2",
          kind: "app_change",
          status: "pending",
          hash: "b".repeat(64),
          conversationId: 1,
          conversationTitle: "Laundry",
          reason: "",
          created: now - 2000,
          snoozedUntil: 0,
          currentVersion: 1,
          app: {
            appId: "app_1",
            title: hostile,
            baseVersion: 1,
            summary: hostile,
            diff,
            patch: [
              {
                op: "replace",
                path: "/elements/washer/props/label",
                value: hostile,
              },
            ],
          },
        },
        {
          id: "s_3",
          kind: "app_change",
          status: "conflict",
          hash: "c".repeat(64),
          conversationId: 1,
          conversationTitle: "Laundry",
          reason: "",
          created: now - 3000,
          snoozedUntil: 0,
          currentVersion: 3,
          conflict: {
            code: "version_conflict",
            message: "baseVersion 1 is stale; the current version is 3.",
            currentVersion: 3,
          },
          app: {
            appId: "app_1",
            title: "Laundry",
            baseVersion: 1,
            summary: "Move the checklist up",
            diff,
            patch: [{ op: "remove", path: "/elements/chart" }],
          },
        },
      ],
    },
  };
}

test("Today suggestions render untrusted text as text; Accept/Edit/Reject/Snooze and the conflict state", async () => {
  const { target, renderToday, Event } = await load();
  const calls: unknown[][] = [];
  const ui: { editing: string | null } = { editing: null };
  const suggestion = new Proxy(
    {},
    {
      get:
        (_t, name) =>
        (...args: unknown[]) =>
          calls.push([name, ...args]),
    },
  );
  const handlers = {
    suggestion,
    dismiss() {},
    snooze() {},
    ask() {},
    openApp() {},
    createWatcher() {},
  };
  renderToday(target, suggestionsData(), handlers, ui);
  noExecutableMarkup(target);
  assert.match(target.textContent!, /<script>alert\(2\)<\/script>/);
  assert.match(target.textContent!, /Suggestions/);
  assert.match(target.textContent!, /Nothing changes until you accept/);
  assert.match(target.textContent!, /1 snoozed suggestion/);
  assert.doesNotMatch(target.textContent!, /Nothing new yet/);
  const cards = [...target.querySelectorAll(".suggestion")];
  assert.equal(cards.length, 3);
  // Memory: accept the shown text, or edit first.
  const buttons = (card: Element) =>
    [...card.querySelectorAll(".today-actions button")].map(
      (b) => b.textContent,
    );
  assert.deepEqual(buttons(cards[0]!), ["Accept", "Edit", "Reject", "Snooze"]);
  cards[0]!.querySelector("button")!.dispatchEvent(new Event("click"));
  assert.equal(calls[0]![0], "accept");
  assert.equal((calls[0]![1] as { id: string }).id, "s_1");
  assert.equal(calls[0]!.length, 2, "accept without edited text");
  // App change: diff summary, exact ops as text, base version, Accept.
  assert.match(cards[1]!.textContent!, /1 changed/);
  assert.match(
    cards[1]!.textContent!,
    /replace \/elements\/washer\/props\/label/,
  );
  assert.match(cards[1]!.textContent!, /Applies to v1 as a new version/);
  assert.deepEqual(buttons(cards[1]!), ["Accept", "Reject", "Snooze"]);
  // Conflict: no Accept, explains the stale version, offers Ask/Dismiss.
  assert.match(
    cards[2]!.textContent!,
    /Conflict: the app changed since this suggestion \(v1 → now v3\)/,
  );
  assert.deepEqual(buttons(cards[2]!), ["Ask Hearth again", "Dismiss"]);
  // Edit mode: the textarea holds the text as a value, Save sends it.
  ui.editing = "s_1";
  renderToday(target, suggestionsData(), handlers, ui);
  noExecutableMarkup(target);
  const area = target.querySelector("#suggestion-edit-s_1") as unknown as {
    value: string;
  };
  assert.equal(
    area.value,
    suggestionsData().suggestions.items[0]!.memory!.text,
  );
  area.value = "Study fan is called Breezy";
  const save = [...target.querySelectorAll("button")].find(
    (b) => b.textContent === "Save to memory",
  )!;
  save.dispatchEvent(new Event("click"));
  assert.deepEqual(calls.at(-1)!.slice(2), ["Study fan is called Breezy"]);
  // Stale pending app change warns before accepting.
  const stale = suggestionsData();
  stale.suggestions.items[1]!.currentVersion = 2;
  ui.editing = null;
  renderToday(target, stale, handlers, ui);
  assert.match(
    target.textContent!,
    /Based on v1; the app is now v2\. Accepting will show a conflict\./,
  );
});

test("Settings → Memory renders items as text with source, trimming warning, edit and forget", async () => {
  const { target, renderMemory, renderFeedback, Event } = await load();
  const calls: unknown[][] = [];
  const handlers = {
    add: (...a: unknown[]) => calls.push(["add", ...a]),
    edit: (...a: unknown[]) => calls.push(["edit", ...a]),
    forget: (...a: unknown[]) => calls.push(["forget", ...a]),
    startEdit: (...a: unknown[]) => calls.push(["startEdit", ...a]),
  };
  const data = {
    items: [
      {
        id: "m_2",
        text: hostile,
        source: { kind: "suggestion", suggestionId: "s_1", conversationId: 1 },
        sourceTitle: hostile,
        created: now,
        updated: now,
        inContext: true,
      },
      {
        id: "m_1",
        text: "Bedtime is around 23:00",
        source: { kind: "owner" },
        sourceTitle: "",
        created: now - 1000,
        updated: now - 1000,
        inContext: false,
      },
    ],
    usedBytes: 4000,
    trimmed: 1,
    limits: { text: 200, items: 60, contextBytes: 4096 },
  };
  const ui: { editing: string | null; draft: string } = {
    editing: null,
    draft: "",
  };
  renderMemory(target, data, ui, handlers);
  noExecutableMarkup(target);
  assert.match(target.textContent!, /2 items · 3\.9 KB of 4\.0 KB shared/);
  assert.match(target.textContent!, /1 oldest item is over the 4\.0 KB limit/);
  assert.match(target.textContent!, /Accepted suggestion · <img/);
  assert.match(target.textContent!, /You wrote this/);
  assert.match(target.textContent!, /Not shared \(over limit\)/);
  const rows = [...target.querySelectorAll(".memory-list > li")];
  assert.equal(rows[1]!.className, "trimmed");
  const forget = [...rows[0]!.querySelectorAll("button")].find(
    (b) => b.textContent === "Forget",
  )!;
  forget.dispatchEvent(new Event("click"));
  assert.equal((calls.at(-1)![1] as { id: string }).id, "m_2");
  const area = target.querySelector("#memory-new") as unknown as {
    value: string;
  };
  area.value = "Study fan is called Breezy";
  [...target.querySelectorAll("button")]
    .find((b) => b.textContent === "Remember")!
    .dispatchEvent(new Event("click"));
  assert.deepEqual(calls.at(-1), ["add", "Study fan is called Breezy"]);
  ui.editing = "m_1";
  renderMemory(target, data, ui, handlers);
  const edit = target.querySelector("#memory-edit-m_1") as unknown as {
    value: string;
  };
  assert.equal(edit.value, "Bedtime is around 23:00");
  edit.value = "Bedtime is around 22:30";
  [...target.querySelectorAll("button")]
    .find((b) => b.textContent === "Save")!
    .dispatchEvent(new Event("click"));
  assert.equal(calls.at(-1)![2], "Bedtime is around 22:30");

  // The 👎 chips mention a possible app fix only in chats that used an app.
  const noop = { toggle() {}, reason() {}, rate() {} };
  renderFeedback(
    target,
    undefined,
    { open: true, draft: new Set(), appHint: true },
    noop,
  );
  assert.match(target.textContent!, /Hearth may suggest a fix to the app/);
  renderFeedback(
    target,
    undefined,
    { open: true, draft: new Set(), appHint: false },
    noop,
  );
  assert.doesNotMatch(target.textContent!, /suggest a fix/);
  renderFeedback(
    target,
    { rating: "down", reasons: ["wrong_device"] },
    { open: false, draft: new Set(), appHint: true },
    noop,
  );
  assert.match(
    target.textContent!,
    /Saved · Wrong device · Hearth may suggest a fix/,
  );
});
