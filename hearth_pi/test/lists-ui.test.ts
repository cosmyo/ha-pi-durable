// Today → Lists: untrusted list text renders only as text, 44px controls,
// disabled reasons, and the app shell's Ask path (exact approval card in a
// dedicated "Shared lists" chat; a full chat is never resubmitted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { readFile } from "node:fs/promises";

const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
const GROCERIES = "todo.example_groceries";
function noExecutableMarkup(root: Element) {
  assert.equal(root.querySelector("img"), null);
  assert.equal(root.querySelector("script"), null);
  for (const element of root.querySelectorAll("*"))
    for (const attribute of element.getAttributeNames())
      assert(!/^on/i.test(attribute), `event handler attribute ${attribute}`);
}
const now = Date.now();
function listsData(summary = hostile) {
  return {
    mode: "ask",
    blocked: false,
    lists: [
      {
        entityId: GROCERIES,
        name: hostile,
        available: true,
        items: [
          { uid: "u1", summary, status: "needs_action" },
          { uid: "u2", summary: "Bread", status: "completed" },
        ],
        openCount: 1,
        doneCount: 1,
        readAt: now,
        controls: {
          add: {
            enabled: true,
            reason: "Ask: you review the exact change before it runs.",
          },
          update: {
            enabled: true,
            reason: "Ask: you review the exact change before it runs.",
          },
          remove: {
            enabled: false,
            reason:
              "Outside Hearth's configured service scope (todo.remove_item); this stays read-only.",
          },
        },
      },
    ],
  };
}
const today = () => ({
  lastSeen: now,
  snoozed: 0,
  suppressed: 0,
  unread: 0,
  cards: [],
  suggestions: { items: [], snoozed: 0, now },
});

test("Today Lists render untrusted text as text, collapsed by default, with 44px controls and disabled reasons", async () => {
  const { document, Event } = parseHTML(
    '<html><body><div id="target"></div></body></html>',
  );
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
    writable: true,
  });
  const { renderToday } = await import(
    new URL("../public/today.js", import.meta.url).href
  );
  const { renderProposals, todoActionTitle } = await import(
    new URL("../public/render.js", import.meta.url).href
  );
  const target = document.getElementById("target")!;
  const calls: unknown[][] = [];
  const lists = new Proxy(
    {},
    {
      get:
        (_t, name) =>
        (...args: unknown[]) =>
          calls.push([name, ...args]),
    },
  );
  const handlers = {
    lists,
    dismiss() {},
    snooze() {},
    ask() {},
    openApp() {},
    createWatcher() {},
  };
  const ui: Record<string, unknown> = {
    lists: listsData(),
    listOpen: new Set<string>(),
  };
  renderToday(target, today(), handlers, ui);
  noExecutableMarkup(target);
  const section = target.querySelector(".lists")!;
  assert.match(section.textContent!, /^Lists/);
  const header = section.querySelector(".list-header")!;
  assert.equal(header.getAttribute("aria-expanded"), "false");
  assert.match(header.textContent!, /<img src=x onerror="alert\(1\)">.*1 open/);
  assert.equal(section.querySelectorAll(".list-item").length, 0);
  header.dispatchEvent(new Event("click"));
  assert.deepEqual(calls.at(-1), ["toggle", GROCERIES]);

  (ui.listOpen as Set<string>).add(GROCERIES);
  renderToday(target, today(), handlers, ui);
  noExecutableMarkup(target);
  const check = target.querySelector(".list-check")!;
  assert.equal(check.getAttribute("aria-label"), `Mark ${hostile} done`);
  assert.equal(check.textContent, "");
  check.dispatchEvent(new Event("click"));
  assert.equal(calls.at(-1)![0], "complete");
  assert.equal((calls.at(-1)![2] as { uid: string }).uid, "u1");
  assert.match(target.textContent!, /Done \(1\)/);
  assert.match(
    target.textContent!,
    /Outside Hearth's configured service scope \(todo\.remove_item\)/,
  );
  assert.match(target.textContent!, /Ask: you review the exact change/);
  assert.match(
    target.textContent!,
    /As of .* shared with everyone in the household/,
  );
  const reopen = [...target.querySelectorAll("button")].find(
    (b) => b.textContent === "Reopen",
  )!;
  reopen.dispatchEvent(new Event("click"));
  assert.equal(calls.at(-1)![0], "reopen");
  (
    target.querySelector('input[aria-label^="Add to"]') as unknown as {
      value: string;
    }
  ).value = "Oat milk";
  [...target.querySelectorAll("button")]
    .find((b) => b.textContent === "Add")!
    .dispatchEvent(new Event("click"));
  assert.equal(calls.at(-1)![0], "add");
  assert.equal(calls.at(-1)![2], "Oat milk");
  // The ⋯ menu: Rename allowed, Remove disabled (outside service scope).
  ui.listMenu = `${GROCERIES}|u1`;
  renderToday(target, today(), handlers, ui);
  const menu = target.querySelector(".list-menu")!;
  const [rename, remove] = [...menu.querySelectorAll("button")] as unknown as {
    textContent: string;
    disabled: boolean;
  }[];
  assert.equal(rename!.textContent, "Rename");
  assert.equal(rename!.disabled, false);
  assert.equal(remove!.textContent, "Remove");
  assert.equal(remove!.disabled, true);
  // Writes paused and a full Shared lists chat are explained calmly.
  ui.lists = { ...listsData(), blocked: true };
  ui.listFull = true;
  renderToday(target, today(), handlers, ui);
  assert.match(target.textContent!, /Home writes are paused/);
  assert.match(
    target.textContent!,
    /This chat is full of receipts\. Start a new Shared lists chat\?/,
  );
  [...target.querySelectorAll("button")]
    .find((b) => b.textContent === "Start a new chat")!
    .dispatchEvent(new Event("click"));
  assert.deepEqual(calls.at(-1), ["newChat"]);
  // No lists configured: no section at all.
  ui.lists = { lists: [], mode: "ask", blocked: false };
  renderToday(target, today(), handlers, ui);
  assert.equal(target.querySelector(".lists"), null);
  // 44px targets for every list control.
  const css = await readFile(
    new URL("../public/app.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.list-card button,\n\.list-card input \{\n {2}min-height: 44px;/,
  );
  assert.match(css, /\.list-check \{\n {2}width: 44px;\n {2}min-width: 44px;/);

  // The approval card names the exact change, with the controller-read text.
  assert.equal(
    todoActionTitle({
      kind: "todo",
      op: "rename",
      label: "Bread",
      summary: "Rye",
    }),
    'Rename "Bread" → "Rye"',
  );
  renderProposals(
    target,
    {
      p1: {
        id: "p1",
        hash: "a".repeat(64),
        status: "pending",
        created: now,
        expires: now + 300000,
        action: {
          kind: "todo",
          entityId: GROCERIES,
          op: "complete",
          uid: "u1",
          label: hostile,
        },
        risk: { level: "low", rule: "list_status", reasons: [] },
        origin: { kind: "list", entityId: GROCERIES },
      },
    },
    () => {},
  );
  noExecutableMarkup(target);
  assert.match(
    target.textContent!,
    /Mark "<img src=x onerror="alert\(1\)">.*" done · pending/,
  );
  assert.match(
    target.textContent!,
    /Requested by you from Today → Lists \(todo\.example_groceries\)/,
  );
});

test("app shell: a list press uses the Shared lists chat, Ask opens the exact approval card, and a full chat is never resubmitted", async () => {
  const { window, document } = parseHTML(
    await readFile(new URL("../public/index.html", import.meta.url), "utf8"),
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
  let full = false;
  const pending = {
    id: "1000000000000",
    hash: "b".repeat(64),
    status: "pending",
    created: now,
    expires: now + 300000,
    action: {
      kind: "todo",
      entityId: GROCERIES,
      op: "complete",
      uid: "u1",
      label: "Oat milk",
    },
    risk: { level: "low", rule: "list_status", reasons: [] },
    origin: { kind: "list", entityId: GROCERIES },
  };
  const sleep = () => new Promise((resolve) => setTimeout(resolve, 40));
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
              { id: 4, title: "Home", kind: "home", created: now - 9000 },
              {
                id: 6,
                title: "Shared lists",
                kind: "home",
                created: now - 8000,
              },
              {
                id: 7,
                title: "Shared lists",
                kind: "home",
                created: now - 1000,
              },
            ],
          });
        if (path.endsWith("/sessions") && method === "POST")
          return Response.json({ id: 8 }, { status: 201 });
        if (/\/sessions\/\d+\/snapshot$/.test(path))
          return Response.json({
            modelSelection: null,
            homePermissions: null,
            homeCanvas: null,
            proposals: {},
            lastInput: null,
            view: { entries: [], docs: {} },
          });
        if (/\/sessions\/\d+\/feedback$/.test(path))
          return Response.json({ items: {} });
        if (path.endsWith("/api/apps")) return Response.json({ items: [] });
        if (path.endsWith("/api/proactive"))
          return Response.json({
            watchersEnabled: true,
            checkEverySeconds: 60,
            briefings: {
              morning: { enabled: false, at: "07:30", source: null },
              evening: { enabled: false, at: "20:30", source: null },
            },
            sources: { apps: [], canvases: [] },
            watchers: [],
          });
        if (path.endsWith("/api/today")) return Response.json(today());
        if (path.endsWith("/api/lists"))
          return Response.json(listsData("Oat milk"));
        if (path.endsWith("/api/lists/actions"))
          return full
            ? Response.json({ error: "proposal_limit" }, { status: 429 })
            : Response.json({ proposal: pending, list: null, sessionId: 7 });
        throw new Error(`Unexpected route ${method} ${path}`);
      },
    });
    await import(
      new URL(`../public/app.js?lists-shell-${Date.now()}`, import.meta.url)
        .href
    );
    await sleep();
    document
      .getElementById("today-row")!
      .dispatchEvent(new window.Event("click"));
    await sleep();
    const list = document.getElementById("today-list")!;
    list
      .querySelector(".list-header")!
      .dispatchEvent(new window.Event("click"));
    await sleep();
    list.querySelector(".list-check")!.dispatchEvent(new window.Event("click"));
    await sleep();
    const press = requests.filter((r) => r.path.endsWith("/lists/actions"));
    assert.equal(press.length, 1);
    assert.deepEqual(press[0]!.body, {
      sessionId: 7,
      entityId: GROCERIES,
      op: "complete",
      uid: "u1",
    });
    assert(document.getElementById("app-approval")!.hasAttribute("open"));
    assert.match(
      document.getElementById("app-approval-card")!.textContent!,
      /Mark "Oat milk" done · pending/,
    );
    assert.match(
      document.getElementById("today-feedback")!.textContent!,
      /Review the exact change to continue/,
    );
    (document.getElementById("app-approval") as any).close();

    // A full chat: the press is refused, the owner is asked, nothing resent.
    full = true;
    document
      .getElementById("today-list")!
      .querySelector(".list-check")!
      .dispatchEvent(new window.Event("click"));
    await sleep();
    assert.match(
      document.getElementById("today-list")!.textContent!,
      /This chat is full of receipts\. Start a new Shared lists chat\?/,
    );
    const before = requests.filter((r) =>
      r.path.endsWith("/lists/actions"),
    ).length;
    assert.equal(before, 2);
    [...document.getElementById("today-list")!.querySelectorAll("button")]
      .find((b) => b.textContent === "Start a new chat")!
      .dispatchEvent(new window.Event("click"));
    await sleep();
    const created = requests.filter(
      (r) => r.path.endsWith("/api/sessions") && r.method === "POST",
    );
    assert.equal(created.length, 1);
    assert.equal(created[0]!.body.title, "Shared lists");
    assert.equal(created[0]!.body.kind, "home");
    assert.equal(
      requests.filter((r) => r.path.endsWith("/lists/actions")).length,
      before,
      "never resubmitted automatically",
    );
    assert.doesNotMatch(
      document.getElementById("today-list")!.textContent!,
      /full of receipts/,
    );
  } finally {
    Object.assign(globalThis, previous);
  }
});
