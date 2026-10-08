// Settings sheet: the drawer footer has at most three rows (Today, Apps,
// Settings). Settings opens one grouped sheet whose list rows are the exact
// same entry points (ids, dialogs, logic) that used to sit directly in the
// drawer footer \u2014 only where you reach them moved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { readFile } from "node:fs/promises";

function noExecutableMarkup(root: Element) {
  assert.equal(root.querySelector("script"), null);
  assert.equal(root.querySelector("img[onerror]"), null);
  for (const el of root.querySelectorAll("*"))
    for (const attr of el.getAttributeNames())
      assert(!attr.startsWith("on"), `${attr} handler leaked into markup`);
}

test("app shell: drawer footer has exactly Today/Apps/Settings; Settings routes to every existing sheet without duplicating logic", async () => {
  const { window, document } = parseHTML(
    await readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  );
  const footer = document.querySelector(".drawer-footer")!;
  const rows = [...footer.querySelectorAll("button")].map((b) => b.id);
  assert.deepEqual(rows, ["today-row", "apps-row", "settings-row"]);

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
        dialog.dispatchEvent(new window.Event("close"));
      },
    });
  // linkedom's <select> has no value setter; model/thinking and Home mode
  // selects all need this to let updatePermissions()/loadModels() run.
  for (const id of ["model-choice", "thinking-choice", "home-mode"]) {
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
  const requests: string[] = [];
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
        requests.push(`${options?.method ?? "GET"} ${path}`);
        if (path.endsWith("/bootstrap"))
          return Response.json({
            csrf: "synthetic",
            version: "0.2.0",
            provider: "offline",
            inferenceReady: true,
            homePermissions: {
              explicit: true,
              mode: "ask",
              revision: 1,
              policy: "f".repeat(64),
              schema: 1,
              grant: null,
              invalidation: "",
              effectiveMode: "ask",
              acknowledgement: "Auto-approve supported Home actions.",
              enabled: true,
              entityScopeCount: 2,
              services: ["light.turn_on", "light.turn_off"],
              blocked: false,
              unresolved: [],
            },
          });
        if (
          path.endsWith("/models") ||
          (path.endsWith("/sessions") && (options?.method ?? "GET") === "GET")
        )
          return Response.json({ items: [] });
        if (path.endsWith("/auth/providers"))
          return Response.json({
            items: [
              {
                provider: "openai-codex",
                providerName: "ChatGPT / Codex",
                configured: true,
                subscription: true,
              },
              {
                provider: "anthropic",
                providerName: "Anthropic / Claude (experimental)",
                configured: true,
                subscription: true,
              },
            ],
          });
        if (path.endsWith("/api/apps")) return Response.json({ items: [] });
        if (path.endsWith("/api/today"))
          return Response.json({
            cards: [],
            unread: 0,
            snoozed: 0,
            suppressed: 0,
            lastSeen: 0,
            now: Date.now(),
            checkEverySeconds: 60,
          });
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
        if (path.endsWith("/api/memory"))
          return Response.json({
            items: [
              {
                id: "m_1",
                text: "Bedtime is around 23:00",
                source: { kind: "owner" },
                sourceTitle: "",
                created: Date.now(),
                updated: Date.now(),
                inContext: true,
              },
            ],
            revision: 1,
            usedBytes: 26,
            trimmed: 0,
            limits: { text: 200, items: 60, contextBytes: 4096 },
          });
        if (path.endsWith("/api/insights"))
          return Response.json({
            feedback: {
              up: 0,
              down: 0,
              retentionDays: 90,
              reasons: {},
              models: {},
              recent: [],
            },
            today: {
              created: 0,
              dismissed: 0,
              snoozed: 0,
              asked: 0,
              suppressed: 0,
            },
          });
        throw new Error(`Unexpected route ${options?.method ?? "GET"} ${path}`);
      },
    });
    await import(
      new URL(`../public/app.js?settings-shell-${Date.now()}`, import.meta.url)
        .href
    );
    await new Promise((resolve) => setTimeout(resolve, 40));

    // The footer's one compact status line combines Home permissions and
    // Account, matching the task's own example shape.
    assert.equal(
      document.getElementById("settings-summary")!.textContent,
      "Ask \u00b7 ChatGPT \u2713 \u00b7 Claude \u2713",
    );

    // The top-bar permission badge still opens Home permissions directly,
    // without going through Settings.
    document
      .getElementById("permissions-toggle")!
      .dispatchEvent(new window.Event("click"));
    assert.equal(
      document.getElementById("permissions-dialog")!.hasAttribute("open"),
      true,
    );
    assert.equal(
      document.getElementById("settings-dialog")!.hasAttribute("open"),
      false,
    );
    (document.getElementById("permissions-dialog") as any).close();

    // Settings opens one sheet containing every moved entry point, each
    // still the same id, inside the sheet rather than the drawer footer.
    document
      .getElementById("settings-row")!
      .dispatchEvent(new window.Event("click"));
    assert.equal(
      document.getElementById("settings-dialog")!.hasAttribute("open"),
      true,
    );
    assert.equal(
      document.getElementById("settings-row")!.getAttribute("aria-expanded"),
      "true",
    );
    const sheet = document.getElementById("settings-dialog")!;
    noExecutableMarkup(sheet);
    for (const id of [
      "permissions-row",
      "account",
      "proactive-row",
      "memory-row",
      "settings-insights-row",
      "open-world",
      "settings-about-row",
    ])
      assert(
        sheet.contains(document.getElementById(id)),
        `#${id} is inside Settings`,
      );

    const reopenSettings = () => {
      (document.getElementById("settings-dialog") as any).close();
      document
        .getElementById("settings-row")!
        .dispatchEvent(new window.Event("click"));
    };

    // Home permissions row: closes Settings, opens the existing dialog.
    document
      .getElementById("permissions-row")!
      .dispatchEvent(new window.Event("click"));
    assert.equal(
      document.getElementById("permissions-dialog")!.hasAttribute("open"),
      true,
    );
    assert.equal(
      document.getElementById("settings-dialog")!.hasAttribute("open"),
      false,
    );
    (document.getElementById("permissions-dialog") as any).close();

    // Account row: closes Settings, opens the existing Account dialog and
    // reuses its exact refresh logic (GET /api/auth/providers).
    reopenSettings();
    requests.length = 0;
    document
      .getElementById("account")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      document.getElementById("account-dialog")!.hasAttribute("open"),
      true,
    );
    assert.equal(
      document.getElementById("settings-dialog")!.hasAttribute("open"),
      false,
    );
    assert(requests.some((r) => r.endsWith("/auth/providers")));
    (document.getElementById("account-dialog") as any).close();

    // Briefings & watchers row: closes Settings, opens the existing dialog.
    reopenSettings();
    requests.length = 0;
    document
      .getElementById("proactive-row")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      document.getElementById("proactive-dialog")!.hasAttribute("open"),
      true,
    );
    assert.equal(
      document.getElementById("settings-dialog")!.hasAttribute("open"),
      false,
    );
    assert(requests.some((r) => r.endsWith("/api/proactive")));
    (document.getElementById("proactive-dialog") as any).close();

    // Memory row: closes Settings, opens Memory and loads GET /api/memory;
    // it is not a drawer row.
    reopenSettings();
    requests.length = 0;
    document
      .getElementById("memory-row")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      document.getElementById("memory-dialog")!.hasAttribute("open"),
      true,
    );
    assert.equal(
      document.getElementById("settings-dialog")!.hasAttribute("open"),
      false,
    );
    assert(
      requests.some((r) => r.startsWith("GET ") && r.endsWith("/api/memory")),
    );
    assert.match(
      document.getElementById("memory-body")!.textContent!,
      /Bedtime is around 23:00/,
    );
    assert.equal(
      document.getElementById("memory-summary")!.textContent,
      "1 item",
    );
    (document.getElementById("memory-dialog") as any).close();

    // Insights row: a new direct entry point into the same Insights dialog
    // that Briefings & watchers also opens (no duplicated rendering logic).
    reopenSettings();
    requests.length = 0;
    document
      .getElementById("settings-insights-row")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      document.getElementById("insights-dialog")!.hasAttribute("open"),
      true,
    );
    assert.equal(
      document.getElementById("settings-dialog")!.hasAttribute("open"),
      false,
    );
    assert(requests.some((r) => r.endsWith("/api/insights")));
    (document.getElementById("insights-dialog") as any).close();

    // Home World row: still closes Settings (world rendering itself is
    // covered by world.test.ts, not re-tested here).
    reopenSettings();
    document
      .getElementById("open-world")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      document.getElementById("settings-dialog")!.hasAttribute("open"),
      false,
    );

    // About row: version, the unreleased-app/Pi-Durable boilerplate and the
    // configured provider, none of it writable or fetched from HA.
    reopenSettings();
    document
      .getElementById("settings-about-row")!
      .dispatchEvent(new window.Event("click"));
    assert.equal(
      document.getElementById("about-dialog")!.hasAttribute("open"),
      true,
    );
    assert.equal(
      document.getElementById("settings-dialog")!.hasAttribute("open"),
      false,
    );
    assert.match(
      document.getElementById("about-version")!.textContent!,
      /0\.2\.0/,
    );
    assert.match(
      document.getElementById("about-provider")!.textContent!,
      /offline/,
    );
    noExecutableMarkup(document.getElementById("about-dialog")!);
    (document.getElementById("about-dialog") as any).close();

    // Settings' own Close button.
    reopenSettings();
    document
      .getElementById("settings-close")!
      .dispatchEvent(new window.Event("click"));
    assert.equal(
      document.getElementById("settings-dialog")!.hasAttribute("open"),
      false,
    );
    assert.equal(
      document.getElementById("settings-row")!.getAttribute("aria-expanded"),
      "false",
    );
  } finally {
    Object.assign(globalThis, previous);
  }
});
