import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { readFile } from "node:fs/promises";

const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
function noExecutableMarkup(root: Element) {
  assert.equal(root.querySelector("img"), null);
  assert.equal(root.querySelector("script"), null);
  for (const element of root.querySelectorAll("*"))
    for (const attribute of element.getAttributeNames())
      assert(!/^on/i.test(attribute), `event handler attribute ${attribute}`);
}
const now = Date.now();
function todayData() {
  return {
    lastSeen: now - 120000,
    snoozed: 1,
    suppressed: 0,
    unread: 1,
    cards: [
      {
        id: "c_2",
        key: "k2",
        kind: "watcher",
        source: {
          kind: "app",
          appId: "app_1",
          title: hostile,
          watcherId: "done",
        },
        title: hostile,
        body: hostile,
        values: [
          {
            entityId: "sensor.washer_state",
            label: hostile,
            state: hostile,
            unit: "",
            available: true,
            reason: "",
            observedAt: now - 60000,
          },
          {
            entityId: "sensor.gone",
            label: "Gone",
            state: "",
            unit: "",
            available: false,
            reason: "not_in_read_scope",
            observedAt: now,
          },
        ],
        created: now - 60000,
        scheduledFor: 0,
        late: false,
        repeat: 0,
        snoozedUntil: 0,
      },
      {
        id: "c_1",
        key: "k1",
        kind: "reminder",
        source: { kind: "owner", watcherId: "w_1", title: "Bins" },
        title: "Bins",
        body: "",
        values: [],
        created: now - 3600000,
        scheduledFor: now - 7200000,
        late: true,
        repeat: 0,
        snoozedUntil: 0,
      },
    ],
  };
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

test("Today cards render hostile text and values only as text, with as-of, late and Unavailable", async () => {
  const { target, renderToday, askPrompt, Event } = await load();
  try {
    const calls: unknown[][] = [];
    renderToday(target, todayData(), {
      dismiss: (c: { id: string }) => calls.push(["dismiss", c.id]),
      snooze: (c: { id: string }, until: string) =>
        calls.push(["snooze", c.id, until]),
      ask: (c: { id: string }) => calls.push(["ask", c.id]),
      openApp: (id: string) => calls.push(["open", id]),
    });
    noExecutableMarkup(target);
    assert.match(target.textContent!, /<script>alert\(2\)<\/script>/);
    const cards = target.querySelectorAll(".today-card");
    assert.equal(cards.length, 2);
    assert(cards[0]!.classList.contains("unread"));
    assert(!cards[1]!.classList.contains("unread"));
    assert.match(
      cards[0]!.textContent!,
      /Read by Hearth from Home Assistant at/,
    );
    assert.match(cards[0]!.textContent!, /Unavailable \(not in read scope\)/);
    assert.match(cards[1]!.textContent!, /late · was due/);
    assert.match(target.textContent!, /1 more snoozed/);
    const buttons = [...cards[0]!.querySelectorAll("button")];
    const byText = (t: string) => buttons.find((b) => b.textContent === t)!;
    for (const b of buttons) assert.equal(b.getAttribute("type"), "button");
    byText("Dismiss").dispatchEvent(new Event("click"));
    byText("Open app").dispatchEvent(new Event("click"));
    byText("Ask about this").dispatchEvent(new Event("click"));
    const snooze = byText("Snooze");
    const choices = cards[0]!.querySelector(".today-snooze") as HTMLElement;
    assert.equal(choices.hidden, true);
    snooze.dispatchEvent(new Event("click"));
    assert.equal(choices.hidden, false);
    choices
      .querySelector("button:last-child")!
      .dispatchEvent(new Event("click"));
    assert.deepEqual(calls, [
      ["dismiss", "c_2"],
      ["open", "app_1"],
      ["ask", "c_2"],
      ["snooze", "c_2", "tomorrow"],
    ]);
    // Reminders without an app have no Open app; nothing can control a device.
    assert(
      ![...cards[1]!.querySelectorAll("button")].some(
        (b) => b.textContent === "Open app",
      ),
    );
    assert(
      !/turn on|turn off|approve/i.test(target.textContent!),
      "Today offers no device control",
    );
    const prompt = askPrompt(todayData().cards[0]);
    assert.match(prompt, /Do not call services\./);
    assert.match(prompt, /Unavailable \(not in read scope\)/);
    renderToday(
      target,
      { cards: [], snoozed: 0, suppressed: 2, unread: 0, lastSeen: 0 },
      {},
    );
    assert.match(target.textContent!, /Nothing new/);
    assert.match(target.textContent!, /2 alerts were held back/);
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
});

test("settings form builds only read-only watcher payloads; feedback chips submit enum reasons only", async () => {
  const {
    target,
    renderProactiveSettings,
    renderFeedback,
    watcherFromForm,
    parseSourceKey,
    Event,
  } = await load();
  try {
    assert.deepEqual(
      watcherFromForm({
        kind: "above",
        entity: " sensor.power ",
        value: "2000",
        minutes: "30",
        at: "08:00",
        days: "every",
        title: " High power ",
        note: "",
      }),
      {
        when: { kind: "threshold", entity: "sensor.power", above: 2000 },
        card: { title: "High power" },
      },
    );
    assert.deepEqual(
      watcherFromForm({
        kind: "schedule",
        entity: "",
        value: "",
        minutes: "",
        at: "07:15",
        days: "weekdays",
        title: "Bins",
        note: "Tuesday",
      }).when,
      {
        kind: "schedule",
        at: "07:15",
        days: ["mon", "tue", "wed", "thu", "fri"],
      },
    );
    assert.deepEqual(parseSourceKey("canvas:4"), {
      kind: "canvas",
      sessionId: 4,
    });
    assert.equal(parseSourceKey("bogus"), null);
    const calls: unknown[][] = [];
    renderProactiveSettings(
      target,
      {
        watchersEnabled: true,
        checkEverySeconds: 60,
        briefings: {
          morning: { enabled: false, at: "07:30", source: null },
          evening: {
            enabled: true,
            at: "20:30",
            source: { kind: "app", appId: "app_1" },
          },
        },
        sources: {
          apps: [{ id: "app_1", title: hostile }],
          canvases: [{ sessionId: 3, title: hostile }],
        },
        watchers: [
          {
            key: "app:o:app_1:done",
            source: {
              kind: "app",
              appId: "app_1",
              title: hostile,
              watcherId: "done",
            },
            id: "done",
            title: hostile,
            description: "sensor.washer_state changes from running to idle",
            kind: "transition",
            status: "needs_repair",
            repair: "sensor.washer_state is outside Hearth's read scope.",
          },
          {
            key: "own:o:w_1",
            source: { kind: "owner", watcherId: "w_1", title: "Bins" },
            id: "w_1",
            title: "Bins",
            description: "Every day at 07:00",
            kind: "schedule",
            status: "active",
            repair: "",
          },
        ],
      },
      {
        saveBriefing: (slot: string, value: unknown) =>
          calls.push(["briefing", slot, value]),
        setEnabled: (v: boolean) => calls.push(["enabled", v]),
        removeWatcher: (id: string) => calls.push(["remove", id]),
        openApp: (id: string) => calls.push(["open", id]),
        addWatcher: (w: unknown) => calls.push(["add", w]),
      },
    );
    noExecutableMarkup(target);
    assert.match(target.textContent!, /Needs repair/);
    const evening = target.querySelectorAll(".pro-briefing")[1]!;
    assert.equal(
      (evening.querySelector("select") as HTMLSelectElement).value,
      "app:app_1",
    );
    [...evening.querySelectorAll("button")]
      .find((b) => b.textContent === "Save")!
      .dispatchEvent(new Event("click"));
    [...target.querySelectorAll("button")]
      .find((b) => b.textContent === "Remove")!
      .dispatchEvent(new Event("click"));
    [...target.querySelectorAll("button")]
      .find((b) => b.textContent === "Pause all")!
      .dispatchEvent(new Event("click"));
    assert.deepEqual(calls, [
      [
        "briefing",
        "evening",
        { enabled: true, at: "20:30", source: { kind: "app", appId: "app_1" } },
      ],
      ["remove", "w_1"],
      ["enabled", false],
    ]);
    // Feedback: 👎 opens fixed reason chips; Save sends only enum reasons.
    const rated: unknown[][] = [];
    const ui = { open: false, draft: new Set<string>() };
    const handlers = {
      toggle: () => {
        ui.open = !ui.open;
        renderFeedback(target, undefined, ui, handlers);
      },
      reason: (r: string) => {
        ui.draft.add(r);
        renderFeedback(target, undefined, ui, handlers);
      },
      rate: (rating: string, reasons: string[]) =>
        rated.push([rating, reasons]),
    };
    renderFeedback(target, undefined, ui, handlers);
    const [up, down] = [...target.querySelectorAll(".feedback-thumb")];
    assert.equal(up!.getAttribute("aria-label"), "Helpful");
    up!.dispatchEvent(new Event("click"));
    down!.dispatchEvent(new Event("click"));
    const chips = [...target.querySelectorAll(".feedback-chips button")];
    assert.deepEqual(
      chips.map((c) => c.textContent),
      [
        "Wrong value",
        "Wrong device",
        "Didn't do it",
        "Too long",
        "Not useful",
        "Creepy / privacy",
        "Save 👎",
      ],
    );
    assert.equal(target.querySelector("textarea, input"), null, "no free text");
    chips[1]!.dispatchEvent(new Event("click"));
    target
      .querySelector(".feedback-chips button:last-child")!
      .dispatchEvent(new Event("click"));
    assert.deepEqual(rated, [
      ["up", []],
      ["down", ["wrong_device"]],
    ]);
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
});

test("app shell: Today row with unread badge opens the inbox, marks seen, and Ask only drafts", async () => {
  const { window, document } = parseHTML(
    await readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  );
  const footer = document.querySelector(".drawer-footer")!;
  const rows = [...footer.querySelectorAll("button")].map((b) => b.id);
  assert.equal(rows[0], "today-row");
  assert(rows.indexOf("proactive-row") > rows.indexOf("permissions-row"));
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    EventSource: globalThis.EventSource,
    sessionStorage: globalThis.sessionStorage,
  };
  for (const dialog of document.querySelectorAll("dialog"))
    Object.assign(dialog, {
      showModal() {
        dialog.setAttribute("open", "");
        (dialog as unknown as { open: boolean }).open = true;
      },
      close() {
        dialog.removeAttribute("open");
        (dialog as unknown as { open: boolean }).open = false;
      },
    });
  for (const id of ["model-choice", "thinking-choice"]) {
    const select = document.getElementById(id)!;
    let value = "";
    Object.defineProperty(select, "value", {
      configurable: true,
      get: () => value,
      set: (v) => (value = v),
    });
  }
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://hearth.example/app/"),
  });
  const requests: { method: string; path: string; body?: any }[] = [];
  const data = todayData();
  try {
    Object.assign(globalThis, {
      window,
      document,
      sessionStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
      EventSource: class {
        close() {}
        addEventListener() {}
      },
      fetch: async (url: URL, options?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? JSON.parse(String(options.body))
          : undefined;
        requests.push({ method, path, body });
        if (path.endsWith("/bootstrap"))
          return Response.json({
            csrf: "synthetic",
            provider: "offline",
            inferenceReady: true,
            homePermissions: null,
          });
        if (path.endsWith("/models")) return Response.json({ items: [] });
        if (path.endsWith("/sessions") && method === "GET")
          return Response.json({
            items: [
              { id: 4, owner: "local-admin", title: "Home", kind: "home" },
            ],
          });
        if (path.endsWith("/sessions/4/snapshot"))
          return Response.json({
            modelSelection: null,
            homePermissions: null,
            homeCanvas: null,
            proposals: {},
            lastInput: null,
            view: { entries: [], docs: {} },
          });
        if (path.endsWith("/sessions/4/feedback"))
          return Response.json({ items: {} });
        if (path.endsWith("/api/apps")) return Response.json({ items: [] });
        if (path.endsWith("/api/proactive"))
          return Response.json({
            watchersEnabled: true,
            checkEverySeconds: 60,
            briefings: {
              morning: { enabled: true, at: "07:30", source: null },
              evening: { enabled: false, at: "20:30", source: null },
            },
            sources: { apps: [], canvases: [] },
            watchers: [],
          });
        if (path.endsWith("/api/today")) return Response.json(data);
        if (path.endsWith("/api/today/seen"))
          return Response.json({ ...data, unread: 0, lastSeen: now });
        if (path.endsWith("/api/today/asked"))
          return Response.json({ recorded: true });
        throw new Error(`Unexpected route ${method} ${path}`);
      },
    });
    await import(
      new URL(`../public/app.js?today-shell-${Date.now()}`, import.meta.url)
        .href
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    const badge = document.getElementById("today-badge")!;
    assert.equal(badge.hidden, false);
    assert.equal(badge.textContent, "1");
    assert.equal(document.getElementById("today-dot")!.hidden, false);
    assert.match(
      document.getElementById("proactive-summary")!.textContent!,
      /^1 on$/,
    );
    document
      .getElementById("today-row")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert(document.getElementById("today-dialog")!.hasAttribute("open"));
    const list = document.getElementById("today-list")!;
    noExecutableMarkup(list);
    assert.equal(list.querySelectorAll(".today-card").length, 2);
    assert(requests.some((r) => r.path.endsWith("/today/seen")));
    assert.equal(badge.hidden, true);
    [...list.querySelectorAll("button")]
      .find((b) => b.textContent === "Ask about this")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const draft = (document.getElementById("message") as HTMLTextAreaElement)
      .value;
    assert.match(draft, /^About my Today card/);
    assert.match(draft, /Do not call services\.$/);
    assert(
      !requests.some((r) => r.path.includes("/inputs")),
      "Ask about this never sends",
    );
    assert(!document.getElementById("today-dialog")!.hasAttribute("open"));
  } finally {
    Object.assign(globalThis, previous);
  }
});
