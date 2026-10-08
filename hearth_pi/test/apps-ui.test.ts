import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { readFile } from "node:fs/promises";

const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
function appData(overrides: Record<string, unknown> = {}) {
  return {
    app: { id: "app_1", title: hostile, version: 2, pinned: false },
    versions: [
      {
        version: 1,
        created: 1,
        by: "conversation:1",
        summary: hostile,
        parent: 0,
        elements: 3,
      },
      {
        version: 2,
        created: 2,
        by: "owner",
        summary: "Reverted to v1",
        parent: 1,
        elements: 3,
      },
    ],
    spec: {
      specVersion: "has/1",
      title: hostile,
      summary: hostile,
      icon: "",
      scope: { entities: ["sensor.power", "sensor.gone", "light.hall"] },
      root: "main",
      elements: {
        main: {
          type: "Stack",
          props: {},
          children: [
            "text",
            "value",
            "gone",
            "pill",
            "list",
            "count",
            "note",
            "ask",
            "toggle",
            "future",
            "chart",
          ],
        },
        text: { type: "Text", props: { text: hostile }, children: [] },
        value: {
          type: "EntityValue",
          props: { entity: "sensor.power" },
          children: [],
        },
        gone: {
          type: "EntityTile",
          props: { entity: "sensor.gone", label: hostile },
          children: [],
        },
        pill: {
          type: "StatusPill",
          props: { entity: "sensor.power", okStates: ["0"] },
          children: [],
        },
        list: {
          type: "Checklist",
          props: {
            stateKey: "list",
            title: hostile,
            items: [hostile, "Towels"],
          },
          children: [],
        },
        count: {
          type: "Counter",
          props: { stateKey: "count", label: "Loads", min: 0, max: 2 },
          children: [],
        },
        note: {
          type: "Note",
          props: { stateKey: "note", label: "Note" },
          children: [],
        },
        ask: {
          type: "AskButton",
          props: { label: hostile, prompt: `Why ${hostile}?` },
          children: [],
        },
        toggle: {
          type: "ToggleAction",
          props: { entity: "light.hall" },
          children: [],
        },
        future: {
          type: "Iframe",
          props: { src: "javascript:alert(1)" },
          children: [],
        },
        chart: {
          type: "HistoryChart",
          props: { entities: ["sensor.power"], hours: 6 },
          children: [],
        },
      },
    },
    state: {
      list: { kind: "checklist", checked: ["Towels"], updated: 5 },
      count: { kind: "counter", value: 2, updated: 5 },
      note: { kind: "note", text: hostile, updated: 5 },
    },
    values: {
      "sensor.power": {
        available: true,
        reason: "",
        state: hostile,
        attributes: { friendly_name: hostile, unit_of_measurement: "W" },
        observedAt: Date.UTC(2026, 9, 8, 7, 5),
      },
      "sensor.gone": {
        available: false,
        reason: "not_in_read_scope",
        state: "",
        attributes: {},
        observedAt: 1,
      },
      "light.hall": {
        available: true,
        reason: "",
        state: "off",
        attributes: { friendly_name: hostile },
        observedAt: 3,
      },
    },
    history: {
      chart: [
        {
          kind: "numeric",
          entityId: "sensor.power",
          unit: "W",
          min: 0,
          max: 10,
          points: [
            [1, 0],
            [2, null],
            [3, 10],
          ],
        },
      ],
    },
    controls: {
      toggle: {
        enabled: false,
        mode: "read-only",
        reason:
          "Home permissions are Read-only. Choose Ask or Full access in Home permissions to use this control.",
      },
    },
    observedAt: Date.UTC(2026, 9, 8, 7, 5),
    needsRepair: false,
    repair: [],
    ...overrides,
  };
}
function noExecutableMarkup(root: Element) {
  assert.equal(root.querySelector("img"), null);
  assert.equal(root.querySelector("script"), null);
  assert.equal(root.querySelector("iframe"), null);
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
    new URL("../public/apps.js", import.meta.url).href
  );
  return {
    document,
    Event,
    target: document.getElementById("target")!,
    ...module,
  };
}

test("app renderer shows hostile spec, HA and household text only as text, with as-of times and Unavailable", async () => {
  const { target, renderApp, renderAppHistory, Event } = await load();
  try {
    const calls: unknown[] = [];
    renderApp(target, appData(), {
      ask: (p: string) => calls.push(["ask", p]),
      state: (k: string, b: unknown) => calls.push(["state", k, b]),
      toggle: (id: string) => calls.push(["toggle", id]),
    });
    noExecutableMarkup(target);
    const text = target.textContent!;
    assert(text.includes(hostile));
    assert.match(text, /Values read by Hearth from Home Assistant as of/);
    assert.match(text, /as of /);
    assert.match(text, /Unavailable \(not in read scope\)/);
    assert.match(text, /Unsupported block/);
    assert.match(text, /1 of 2 done/);
    assert.match(text, /Read-only/);
    assert.equal(target.querySelector(".app-note textarea")!.value, hostile);
    // The read-only toggle is disabled; nothing is pressed.
    const toggle = target.querySelector(".app-toggle-button")!;
    assert.equal(toggle.disabled, true);
    // People interact: checklist, counter bounds, ask drafts.
    const boxes = target.querySelectorAll(".app-check input");
    boxes[0]!.checked = true;
    boxes[0]!.dispatchEvent(new Event("change"));
    const [minus, plus] = target.querySelectorAll(".app-step");
    assert.equal(plus!.disabled, true, "counter at max");
    minus!.dispatchEvent(new Event("click"));
    target.querySelector(".app-ask-button")!.dispatchEvent(new Event("click"));
    assert.deepEqual(calls, [
      ["state", "list", { op: "check", item: hostile }],
      ["state", "count", { op: "decrement" }],
      ["ask", `Why ${hostile}?`],
    ]);
    // Charts are built from numbers into SVG by trusted code.
    assert(
      target.querySelector("polyline")!.getAttribute("points")!.includes(","),
    );
    renderAppHistory(target, appData(), {
      revert: (v: number) => (calls as unknown[]).push(["revert", v]),
    });
    noExecutableMarkup(target);
    assert(target.textContent!.includes(hostile));
    target.querySelector("button")!.dispatchEvent(new Event("click"));
    assert.deepEqual(calls.at(-1), ["revert", 1]);
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
});

test("enabled ToggleAction only calls the press handler; unavailable values are never shown as numbers", async () => {
  const { target, renderApp, Event } = await load();
  try {
    const pressed: string[] = [];
    const data = appData({
      controls: {
        toggle: {
          enabled: true,
          mode: "ask",
          reason: "Ask: you review the exact action before it runs.",
        },
      },
    });
    (data.values as Record<string, any>)["sensor.power"] = {
      available: false,
      reason: "unavailable",
      state: "unavailable",
      attributes: {},
      observedAt: 1,
    };
    renderApp(target, data, {
      ask() {},
      state() {},
      toggle: (id: string) => pressed.push(id),
    });
    const value = target.querySelector(".app-value strong")!;
    assert.equal(value.textContent, "Unavailable");
    assert.match(
      target.querySelector(".app-pill")!.getAttribute("aria-label")!,
      /unknown/,
    );
    const toggle = target.querySelector(".app-toggle-button")!;
    assert.equal(toggle.textContent, "Turn on");
    toggle.dispatchEvent(new Event("click"));
    assert.deepEqual(pressed, ["toggle"]);
    // A cycle or too-deep tree from stored data never recurses forever.
    const cyclic = appData();
    (cyclic.spec.elements as Record<string, any>).main.children.push("main");
    renderApp(target, cyclic, { ask() {}, state() {}, toggle() {} });
    assert.match(target.textContent!, /Unsupported block/);
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
});

test("transcript app card shows diff summary and Open/Pin, with hostile titles as text", async () => {
  const {
    target,
    renderAppResult,
    renderPinnedApps,
    renderAppList,
    diffSummary,
    Event,
  } = await load();
  try {
    const opened: unknown[] = [];
    const handlers = {
      open: (id: string) => opened.push(["open", id]),
      pin: (id: string, p: boolean) => opened.push(["pin", id, p]),
    };
    const card = renderAppResult(
      {
        role: "toolResult",
        toolName: "app_update",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              appId: "app_3",
              version: 2,
              title: hostile,
              summary: hostile,
              elements: 4,
              entities: [],
              warnings: [],
              diff: {
                added: ["a"],
                removed: ["b", "c"],
                changed: [],
                entitiesAdded: ["sensor.dryer_power"],
                entitiesRemoved: [],
                titleChanged: false,
              },
            }),
          },
        ],
      },
      handlers,
    )!;
    target.replaceChildren(card);
    noExecutableMarkup(target);
    assert(target.textContent!.includes(hostile));
    assert.match(target.textContent!, /App updated · v2/);
    assert.match(
      target.textContent!,
      /\+1 element · −2 elements · entities added: sensor\.dryer_power/,
    );
    const [open, pin] = target.querySelectorAll("button");
    open!.dispatchEvent(new Event("click"));
    pin!.dispatchEvent(new Event("click"));
    assert.deepEqual(opened, [
      ["open", "app_3"],
      ["pin", "app_3", true],
    ]);
    assert.equal(
      renderAppResult(
        {
          role: "toolResult",
          toolName: "app_create",
          content: [{ type: "text", text: '{"ok":false}' }],
        },
        handlers,
      ),
      null,
    );
    assert.equal(
      renderAppResult(
        {
          role: "toolResult",
          toolName: "app_create",
          content: [{ type: "text", text: "<b>not json" }],
        },
        handlers,
      ),
      null,
    );
    assert.equal(
      diffSummary({
        added: [],
        removed: [],
        changed: [],
        entitiesAdded: [],
        entitiesRemoved: [],
      }),
      "No visible change",
    );
    assert.equal(
      diffSummary({
        added: [],
        removed: [],
        changed: [],
        entitiesAdded: [],
        entitiesRemoved: [],
        watchersAdded: ["washer_done"],
        watchersRemoved: [],
      }),
      "watchers added: washer_done",
    );
    const items = [
      {
        id: "app_1",
        title: hostile,
        summary: hostile,
        version: 1,
        pinned: true,
      },
      { id: "app_2", title: "Laundry", summary: "", version: 3, pinned: false },
    ];
    renderPinnedApps(target, items, handlers);
    noExecutableMarkup(target);
    assert.equal(target.querySelectorAll(".app-card").length, 1);
    assert.equal(target.hidden, false);
    renderPinnedApps(target, [], handlers);
    assert.equal(target.hidden, true);
    renderAppList(target, items, handlers);
    assert.equal(target.querySelectorAll(".app-card").length, 2);
    assert.equal(target.querySelector(".app-card-pin")!.textContent, "Unpin");
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
});

test("app shell: Apps row sits between conversations and Settings; opening, ticking and AskButton draft without sending", async () => {
  const { window, document } = parseHTML(
    await readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  );
  const footer = document.querySelector(".drawer-footer")!;
  const rows = [...footer.querySelectorAll("button")].map((b) => b.id);
  assert.deepEqual(rows, ["today-row", "apps-row", "settings-row"]);
  // Home permissions, Account, Briefings & watchers and Insights moved into
  // the Settings sheet, not the drawer footer; their ids/dialogs still work.
  assert.equal(document.querySelector(".drawer-footer #permissions-row"), null);
  assert(
    document
      .getElementById("settings-dialog")!
      .contains(document.getElementById("permissions-row")),
  );
  assert(
    document
      .getElementById("sessions")!
      .compareDocumentPosition(document.getElementById("apps-row")!) & 4,
  );
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
      },
      close() {
        dialog.removeAttribute("open");
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
  const data = appData({
    app: { id: "app_1", title: "Laundry", version: 2, pinned: true },
  });
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
        if (path.endsWith("/api/apps"))
          return Response.json({ items: [{ ...data.app, summary: "Washer" }] });
        if (path.endsWith("/api/apps/app_1")) return Response.json(data);
        if (path.endsWith("/api/apps/app_1/state"))
          return Response.json({
            state: {
              ...data.state,
              list: {
                kind: "checklist",
                checked: ["Towels", hostile],
                updated: 9,
              },
            },
            stateRevision: 4,
          });
        throw new Error(`Unexpected route ${method} ${path}`);
      },
    });
    await import(
      new URL(`../public/app.js?apps-shell-${Date.now()}`, import.meta.url).href
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Pinned apps appear at the top of the empty chat.
    const pinned = document.getElementById("pinned-apps")!;
    assert.equal(pinned.hidden, false);
    assert.match(pinned.textContent!, /Laundry/);
    assert.equal(document.getElementById("apps-count")!.textContent, "1");
    pinned
      .querySelector(".app-card-open")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(document.getElementById("app-view")!.hidden, false);
    assert.equal(
      (document.querySelector(".conversation") as HTMLElement).hidden,
      true,
    );
    assert.equal(document.getElementById("app-title")!.textContent, "Laundry");
    const body = document.getElementById("app-body")!;
    noExecutableMarkup(body);
    const box = body.querySelector(".app-check input") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new window.Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const tick = requests.find((r) => r.path.endsWith("/state"))!;
    assert.deepEqual(tick.body, {
      stateKey: "list",
      op: "check",
      item: hostile,
    });
    assert.match(body.textContent!, /2 of 2 done/);
    body
      .querySelector(".app-ask-button")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(document.getElementById("app-view")!.hidden, true);
    assert.equal(
      (document.getElementById("message") as HTMLTextAreaElement).value,
      `Why ${hostile}?`,
    );
    assert(
      !requests.some((r) => r.path.includes("/inputs")),
      "AskButton never sends",
    );
    // Back arrow returns to the Apps sheet.
    pinned
      .querySelector(".app-card-open")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    document
      .getElementById("app-back")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(document.getElementById("app-view")!.hidden, true);
    assert(document.getElementById("apps-dialog")!.hasAttribute("open"));
  } finally {
    Object.assign(globalThis, previous);
  }
});
