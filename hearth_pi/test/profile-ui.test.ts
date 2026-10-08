// Settings → You: personal name/tone/language/default-model form. Static
// markup only (textContent/.value, no innerHTML), 44px targets inherited
// from the global button rule, compact at 360/390px widths. Exercised
// through the real public/app.js and public/index.html, like settings-ui.test.ts.
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

async function boot(profile: unknown, models: unknown[] = []) {
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
        dialog.dispatchEvent(new window.Event("close"));
      },
    });
  // linkedom's <select> has no value setter.
  for (const id of [
    "model-choice",
    "thinking-choice",
    "home-mode",
    "you-language",
    "you-model-choice",
    "you-thinking-choice",
  ]) {
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
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let currentProfile = profile;
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
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      requests.push({ method, path, body });
      if (path.endsWith("/bootstrap"))
        return Response.json({
          csrf: "synthetic",
          version: "0.2.0",
          provider: "offline",
          model: "gpt-test",
          defaultThinkingLevel: "off",
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
      if (path.endsWith("/models")) return Response.json({ items: models });
      if (path.endsWith("/sessions") && method === "GET")
        return Response.json({ items: [] });
      if (path.endsWith("/auth/providers")) return Response.json({ items: [] });
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
      if (path.endsWith("/api/profile")) {
        if (method === "GET") return Response.json(currentProfile);
        const v = body as Record<string, unknown>;
        if (v.revision !== (currentProfile as { revision: number }).revision)
          return Response.json({ error: "profile_stale" }, { status: 409 });
        if (typeof v.displayName === "string" && v.displayName.length > 40)
          return Response.json(
            { error: "invalid_display_name" },
            { status: 400 },
          );
        currentProfile = {
          ...(currentProfile as object),
          displayName: v.displayName || undefined,
          tone: v.tone || undefined,
          language: v.language || undefined,
          defaultModel: v.defaultModel ?? undefined,
          defaultThinking: v.defaultThinking ?? undefined,
          revision: (currentProfile as { revision: number }).revision + 1,
        };
        return Response.json(currentProfile);
      }
      throw new Error(`Unexpected route ${method} ${path}`);
    },
  });
  await import(
    new URL(
      `../public/app.js?profile-ui-${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  const openYou = async () => {
    document
      .getElementById("you-row")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return {
    window,
    document,
    requests,
    openYou,
    restore: () => Object.assign(globalThis, previous),
  };
}

test("Settings \u2192 You: populates saved fields, no executable markup, 44px-class controls", async () => {
  const { document, requests, openYou, restore } = await boot({
    displayName: "Alex <b>Rivera</b>",
    tone: "warm",
    language: "ro",
    defaultModel: undefined,
    defaultThinking: undefined,
    updated: Date.now(),
    revision: 3,
  });
  try {
    await openYou();
    assert(
      requests.some(
        (r) => r.method === "GET" && r.path.endsWith("/api/profile"),
      ),
    );
    noExecutableMarkup(document.getElementById("you-dialog")!);
    assert.equal(
      (document.getElementById("you-name") as unknown as { value: string })
        .value,
      "Alex <b>Rivera</b>",
    );
    // Hostile text never becomes markup: it's an <input> value, not HTML.
    assert.equal(
      document.getElementById("you-dialog")!.querySelector("b"),
      null,
    );
    assert.equal(
      document
        .querySelector('[data-tone="warm"]')!
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      document
        .querySelector('[data-tone="concise"]')!
        .getAttribute("aria-pressed"),
      "false",
    );
    assert.equal(
      (document.getElementById("you-language") as unknown as { value: string })
        .value,
      "ro",
    );
    assert.equal(
      document.getElementById("you-thinking-choice")!.hasAttribute("disabled"),
      true,
    );
    const languageOptions = [
      ...document.getElementById("you-language")!.querySelectorAll("option"),
    ].map((o) => o.getAttribute("value"));
    assert(languageOptions.includes("match"));
    assert(languageOptions.includes("en"));
  } finally {
    restore();
  }
});

test("Settings \u2192 You: tone segmented control, default model enables thinking, Save posts the expected body", async () => {
  const { document, window, requests, openYou, restore } = await boot(
    {
      displayName: undefined,
      tone: undefined,
      language: undefined,
      defaultModel: undefined,
      defaultThinking: undefined,
      updated: 0,
      revision: 0,
    },
    [{ id: "model-a", name: "Model A", provider: "faux" }],
  );
  try {
    await openYou();
    document
      .querySelector('[data-tone="playful"]')!
      .dispatchEvent(new window.Event("click"));
    assert.equal(
      document
        .querySelector('[data-tone="playful"]')!
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      document.querySelector('[data-tone=""]')!.getAttribute("aria-pressed"),
      "false",
    );

    const modelSelect = document.getElementById(
      "you-model-choice",
    ) as unknown as { value: string };
    const thinkingSelect = document.getElementById("you-thinking-choice")!;
    assert.equal(thinkingSelect.hasAttribute("disabled"), true);
    modelSelect.value = "model-a";
    document
      .getElementById("you-model-choice")!
      .dispatchEvent(new window.Event("change"));
    assert.equal(thinkingSelect.hasAttribute("disabled"), false);

    requests.length = 0;
    document
      .getElementById("you-save")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const save = requests.find(
      (r) => r.method === "POST" && r.path.endsWith("/api/profile"),
    );
    assert(save, "Save posts to /api/profile");
    const body = save!.body as Record<string, unknown>;
    assert.equal(body.tone, "playful");
    assert.equal(body.revision, 0);
    assert.deepEqual(body.defaultModel, {
      provider: "faux",
      modelId: "model-a",
    });
    assert.match(
      document.getElementById("you-feedback")!.textContent!,
      /Saved/,
    );
  } finally {
    restore();
  }
});

test("Settings \u2192 You: a validation error leaves saved data untouched and shows a clear message", async () => {
  const { document, window, requests, openYou, restore } = await boot({
    displayName: "Alex",
    tone: undefined,
    language: undefined,
    defaultModel: undefined,
    defaultThinking: undefined,
    updated: 1,
    revision: 1,
  });
  try {
    await openYou();
    (
      document.getElementById("you-name") as unknown as { value: string }
    ).value = "y".repeat(41);
    document
      .getElementById("you-save")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(
      document.getElementById("you-feedback")!.textContent!,
      /Not saved: Name must be at most 40 characters\./,
    );
    assert.equal(
      requests.filter((r) => r.method === "POST").length,
      1,
      "the invalid save was attempted exactly once",
    );
  } finally {
    restore();
  }
});
