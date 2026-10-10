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
  assert.deepEqual(calls.at(-1)!.slice(2), [
    "Study fan is called Breezy",
    "private",
  ]);
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

test("Today code (L3) suggestions: security-review label + typed confirmation, Draft in Code session, and the workspace-disabled explanation", async () => {
  const { target, renderToday, Event } = await load();
  const calls: unknown[][] = [];
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
  const base = suggestionsData();
  const plain = {
    id: "s_10",
    kind: "code",
    status: "pending",
    hash: "d".repeat(64),
    conversationId: 1,
    conversationTitle: "Laundry",
    reason: "",
    created: now - 500,
    snoozedUntil: 0,
    code: {
      title: hostile,
      problem: hostile,
      proposal: "Add a clearer refusal message.",
      evidence: {
        tool: "ha_state_detail",
        errorCode: "entity_not_allowed",
        count: 5,
      },
      securitySensitive: false,
    },
  };
  const sensitive = {
    id: "s_11",
    kind: "code",
    status: "pending",
    hash: "e".repeat(64),
    conversationId: 1,
    conversationTitle: "Laundry",
    reason: "",
    created: now - 400,
    snoozedUntil: 0,
    code: {
      title: "Service proposals are rejected",
      problem:
        "Proposing a climate service fails the service scope approval check.",
      proposal: "Explain the allowed-service scope in the refusal message.",
      evidence: {
        tool: "ha_propose_service",
        errorCode: "service_not_allowed",
        count: 5,
      },
      securitySensitive: true,
    },
  };
  const data = {
    ...base,
    suggestions: { ...base.suggestions, items: [plain, sensitive] },
  };
  renderToday(target, data, handlers, {
    editing: null,
    workspaceEnabled: true,
  });
  noExecutableMarkup(target);
  const cards = [...target.querySelectorAll(".suggestion")];
  assert.equal(cards.length, 2);
  assert.match(cards[0]!.textContent!, /Suggestion · Code improvement/);
  // Untrusted title/problem text stays text; no Security label on the plain one.
  assert.doesNotMatch(cards[0]!.textContent!, /Security review required/);
  assert.match(
    cards[0]!.textContent!,
    /ha_state_detail failed with entity_not_allowed 5 times in the last 7 days/,
  );
  const draftButtons = (card: Element) =>
    [...card.querySelectorAll("button")].filter(
      (b) => b.textContent === "Draft in Code session",
    );
  // Plain: Draft in Code session is a direct, one-tap button.
  assert.equal(draftButtons(cards[0]!).length, 1);
  draftButtons(cards[0]!)[0]!.dispatchEvent(new Event("click"));
  assert.equal(calls.at(-1)![0], "draft");
  assert.equal((calls.at(-1)![1] as { id: string }).id, "s_10");
  assert.equal(
    calls.at(-1)!.length,
    2,
    "no confirm text for a plain suggestion",
  );
  // Security-sensitive: labelled, and Draft only lives behind opened details
  // with a typed-confirmation field — never a bare one-tap button.
  assert.match(cards[1]!.textContent!, /Security review required/);
  const review = cards[1]!.querySelector("details.code-confirm")!;
  assert(review, "security-sensitive suggestions gate Draft behind details");
  const confirmInput = review.querySelector(
    "#suggestion-confirm-s_11",
  ) as unknown as { value: string };
  confirmInput.value = "CONFIRM";
  const sensitiveDraft = [...review.querySelectorAll("button")].find(
    (b) => b.textContent === "Draft in Code session",
  )!;
  sensitiveDraft.dispatchEvent(new Event("click"));
  assert.equal(calls.at(-1)![0], "draft");
  assert.equal((calls.at(-1)![1] as { id: string }).id, "s_11");
  assert.equal(calls.at(-1)![2], "CONFIRM");
  // Reject/Snooze stay available for a code suggestion like any other.
  const actionLabels = (card: Element) =>
    [...card.querySelectorAll(".today-actions button")].map(
      (b) => b.textContent,
    );
  assert(actionLabels(cards[0]!).includes("Reject"));
  assert(actionLabels(cards[0]!).includes("Snooze"));
  // Workspace (Code sessions) disabled: no Draft button at all, just the
  // explanation — Reject/Snooze still work.
  renderToday(target, data, handlers, {
    editing: null,
    workspaceEnabled: false,
  });
  noExecutableMarkup(target);
  assert.match(
    target.textContent!,
    /Code sessions are off for this installation/,
  );
  assert.equal(
    [...target.querySelectorAll("button")].filter(
      (b) => b.textContent === "Draft in Code session",
    ).length,
    0,
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
  assert.match(
    target.textContent!,
    /2 items · 3\.9 KB of 4\.0 KB used by Hearth/,
  );
  assert.match(target.textContent!, /1 oldest item is over the 4\.0 KB limit/);
  assert.match(target.textContent!, /Accepted suggestion · <img/);
  assert.match(target.textContent!, /You wrote this/);
  assert.match(target.textContent!, /Not used \(over limit\)/);
  assert.doesNotMatch(target.textContent!, /shared with Hearth/);
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
  assert.deepEqual(calls.at(-1), [
    "add",
    "Study fan is called Breezy",
    "private",
  ]);
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

test("Settings → Memory: Only you and Household sections, authorship only as You / another member, scope choice and Share", async () => {
  const { target, renderMemory, Event } = await load();
  const calls: unknown[][] = [];
  const handlers = {
    add: (...a: unknown[]) => calls.push(["add", ...a]),
    edit: (...a: unknown[]) => calls.push(["edit", ...a]),
    forget: (...a: unknown[]) => calls.push(["forget", ...a]),
    startEdit: (...a: unknown[]) => calls.push(["startEdit", ...a]),
    share: (...a: unknown[]) => calls.push(["share", ...a]),
  };
  const data = {
    items: [
      {
        id: "m_1",
        text: "Bedtime is around 23:00",
        source: { kind: "owner" },
        sourceTitle: "",
        created: now,
        updated: now,
        inContext: true,
      },
    ],
    usedBytes: 30,
    trimmed: 0,
    limits: { text: 200, items: 60, contextBytes: 4096 },
    household: {
      items: [
        {
          id: "h_2",
          text: hostile,
          created: now,
          updated: now,
          inContext: true,
          mine: false,
          editedByOther: false,
          sourceKind: "owner",
          sourceTitle: "",
        },
        {
          id: "h_1",
          text: "Bins go out on Tuesday evening",
          created: now - 1000,
          updated: now - 500,
          inContext: false,
          mine: true,
          editedByOther: true,
          sourceKind: "owner",
          sourceTitle: "",
        },
      ],
      revision: 3,
      usedBytes: 200,
      trimmed: 1,
      limits: { text: 200, items: 60, contextBytes: 4096 },
    },
  };
  const ui: { editing: string | null; draft: string; scope?: string } = {
    editing: null,
    draft: "",
  };
  renderMemory(target, data, ui, handlers);
  noExecutableMarkup(target);
  const sections = [...target.querySelectorAll(".memory-section")];
  assert.equal(sections.length, 2);
  assert.match(sections[0]!.textContent!, /^Only you/);
  assert.match(
    sections[1]!.textContent!,
    /^Household — every member's Hearth uses these/,
  );
  assert.match(sections[1]!.textContent!, /<img src=x onerror/);
  assert.match(sections[1]!.textContent!, /Added by another household member/);
  assert.match(
    sections[1]!.textContent!,
    /You added this · edited by another member · .* · Not used \(over limit\)/,
  );
  assert.match(sections[1]!.textContent!, /1 oldest item is over/);
  // Private rows offer Share; household rows do not.
  const privateButtons = [...sections[0]!.querySelectorAll("button")].map(
    (b) => b.textContent,
  );
  assert.deepEqual(privateButtons, ["Edit", "Forget", "Share with household"]);
  const householdButtons = [...sections[1]!.querySelectorAll("button")].map(
    (b) => b.textContent,
  );
  assert.deepEqual(householdButtons, ["Edit", "Forget", "Edit", "Forget"]);
  [...sections[0]!.querySelectorAll("button")]
    .find((b) => b.textContent === "Share with household")!
    .dispatchEvent(new Event("click"));
  assert.deepEqual(calls.at(-1)![0], "share");
  assert.equal((calls.at(-1)![1] as { id: string }).id, "m_1");
  [...sections[1]!.querySelectorAll("button")]
    .find((b) => b.textContent === "Forget")!
    .dispatchEvent(new Event("click"));
  assert.equal((calls.at(-1)![1] as { id: string }).id, "h_2");
  // Two scope choices, Only you by default; choosing Household is sent.
  const radios = [
    ...target.querySelectorAll('input[name="memory-new-scope"]'),
  ] as unknown as {
    value: string;
    checked: boolean;
    dispatchEvent: (e: unknown) => void;
  }[];
  assert.deepEqual(
    radios.map((r) => [r.value, r.checked]),
    [
      ["private", true],
      ["household", false],
    ],
  );
  assert(
    [...target.querySelectorAll(".memory-scope-choice")].every((l) =>
      l.className.includes("memory-scope-choice"),
    ),
  );
  radios[1]!.checked = true;
  radios[1]!.dispatchEvent(new Event("change"));
  (target.querySelector("#memory-new") as unknown as { value: string }).value =
    "Recycling is collected on Friday";
  [...target.querySelectorAll("button")]
    .find((b) => b.textContent === "Remember")!
    .dispatchEvent(new Event("click"));
  assert.deepEqual(calls.at(-1), [
    "add",
    "Recycling is collected on Friday",
    "household",
  ]);
  // No owner ids, chat titles or names are part of the rendered household view.
  assert.doesNotMatch(target.textContent!, /createdBy|updatedBy/);
});

test("Today memory suggestion shows its scope and Edit can switch it", async () => {
  const { target, renderToday, Event } = await load();
  const calls: unknown[][] = [];
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
  const data = suggestionsData();
  const item = data.suggestions.items[0]! as unknown as {
    memory: { text: string; scope?: string };
  };
  item.memory = { text: "Bins go out on Tuesday evening", scope: "household" };
  renderToday(target, data, handlers, { editing: null });
  assert.match(target.textContent!, /For: the household/);
  const legacy = suggestionsData();
  renderToday(target, legacy, handlers, { editing: null });
  assert.match(target.textContent!, /For: only you/);
  renderToday(target, data, handlers, { editing: "s_1" });
  const radios = [
    ...target.querySelectorAll('input[name="suggestion-scope-s_1"]'),
  ] as unknown as {
    value: string;
    checked: boolean;
    dispatchEvent: (e: unknown) => void;
  }[];
  assert.deepEqual(
    radios.map((r) => [r.value, r.checked]),
    [
      ["private", false],
      ["household", true],
    ],
  );
  radios[0]!.checked = true;
  radios[0]!.dispatchEvent(new Event("change"));
  [...target.querySelectorAll("button")]
    .find((b) => b.textContent === "Save to memory")!
    .dispatchEvent(new Event("click"));
  assert.deepEqual(calls.at(-1)!.slice(2), [
    "Bins go out on Tuesday evening",
    "private",
  ]);
});
