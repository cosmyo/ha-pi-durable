import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { readFile } from "node:fs/promises";

test("actual Anthropic /login UI opens protected auth while disconnected, without conversation/storage admission", async () => {
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
  const requests: string[] = [];
  let stored = 0,
    opened = 0;
  const dialog = document.getElementById("account-dialog")!;
  Object.assign(dialog, {
    showModal: () => {
      opened++;
    },
  });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://hearth.example/app/"),
  });
  try {
    Object.assign(globalThis, {
      window,
      document,
      sessionStorage: {
        getItem: () => null,
        setItem: () => {
          stored++;
        },
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
            provider: "anthropic",
            anthropicAuthEnabled: true,
            inferenceReady: false,
            homePermissions: null,
          });
        if (path.endsWith("/models") || path.endsWith("/sessions"))
          return Response.json({ items: [] });
        if (path.endsWith("/auth/login")) return Response.json({});
        if (path.endsWith("/auth/status"))
          return Response.json({
            provider: "anthropic",
            providerName: "Anthropic / Claude (experimental)",
            configured: false,
            login: {
              id: "synthetic-login",
              state: "waiting",
              url: "",
              prompt: {
                type: "select",
                message: "Choose method",
                options: [
                  { id: "copy_code", label: "Copy code login (headless)" },
                ],
              },
            },
          });
        throw new Error(`Unexpected route ${path}`);
      },
    });
    await import(
      new URL(`../public/app.js?auth-ui-${Date.now()}`, import.meta.url).href
    );
    // The drawer/account control now shows a short cross-provider summary
    // ("ChatGPT \u2713 \u00b7 Claude"), not a single provider-specific label.
    assert.equal(
      document.getElementById("account")!.textContent!.trim(),
      "Claude",
    );
    const message = document.getElementById("message") as HTMLTextAreaElement;
    assert.equal(message.disabled, false);
    message.value = "/login anthropic";
    message.dispatchEvent(new window.Event("input"));
    assert.equal(
      (document.getElementById("send") as HTMLButtonElement).disabled,
      false,
    );
    document
      .getElementById("composer")!
      .dispatchEvent(new window.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(opened, 1);
    assert.equal(stored, 0);
    assert.equal(requests.filter((r) => r.startsWith("POST")).length, 1);
    assert(requests.some((r) => r.endsWith("/auth/login")));
    assert(!requests.some((r) => r.endsWith("/inputs")));
    assert.match(
      document.getElementById("account-details")!.textContent!,
      /extra per-token billing/,
    );
    assert.match(
      document.getElementById("login-options")!.textContent!,
      /Copy code/,
    );
    assert.equal(message.value, "");
    message.value = "/login openai-codex";
    document
      .getElementById("composer")!
      .dispatchEvent(new window.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(requests.filter((r) => r.startsWith("POST")).length, 1);
    assert.equal(stored, 0);
  } finally {
    dialog.dispatchEvent(new window.Event("close"));
    Object.assign(globalThis, previous);
  }
});

test("ChatGPT device code is the recommended, reordered method and renders/copies only as plain text", async () => {
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
  const previousNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const dialog = document.getElementById("account-dialog")!;
  Object.assign(dialog, { showModal: () => {} });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://hearth.example/app/"),
  });
  const copyCalls: unknown[][] = [];
  // Pi returns "browser" before "device_code"; the UI must reorder and
  // annotate without changing Pi's own ids/labels.
  let authStatus: unknown = {
    provider: "openai-codex",
    providerName: "ChatGPT / Codex",
    configured: false,
    login: {
      id: "login-1",
      state: "waiting",
      url: "",
      userCode: "",
      prompt: {
        type: "select",
        message: "Select OpenAI Codex login method:",
        options: [
          { id: "browser", label: "Browser login (default)" },
          { id: "device_code", label: "Device code login (headless)" },
        ],
      },
    },
  };
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          writeText: (...args: unknown[]) => {
            copyCalls.push(args);
            return Promise.resolve();
          },
        },
      },
    });
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
      fetch: async (url: URL, _options?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/bootstrap"))
          return Response.json({
            csrf: "synthetic",
            provider: "openai-codex",
            inferenceReady: true,
            homePermissions: null,
          });
        if (path.endsWith("/models") || path.endsWith("/sessions"))
          return Response.json({ items: [] });
        if (path.endsWith("/auth/status")) return Response.json(authStatus);
        throw new Error(`Unexpected route ${path}`);
      },
    });
    await import(
      new URL(`../public/app.js?auth-ui-device-${Date.now()}`, import.meta.url)
        .href
    );
    document
      .getElementById("account")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const cards = [
      ...document.querySelectorAll("#login-options .login-option"),
    ];
    assert.equal(cards.length, 2);
    assert.match(cards[0]!.textContent!, /Device code login \(headless\)/);
    assert.match(
      cards[0]!.textContent!,
      /Recommended for Home Assistant and phones/,
    );
    assert.match(cards[1]!.textContent!, /Browser login \(default\)/);
    assert.match(cards[1]!.textContent!, /Requires pasting a redirect URL/);
    assert.equal(
      document.getElementById("login-options")!.querySelector("script"),
      null,
    );

    // Now Pi is waiting on the device-code step: a code, a copy button, the
    // steps and the verification link, rendered as plain text only.
    const maliciousCode = '<img src=x onerror="alert(1)">CODE-7777';
    authStatus = {
      provider: "openai-codex",
      providerName: "ChatGPT / Codex",
      configured: false,
      login: {
        id: "login-1",
        state: "waiting",
        url: "https://auth.openai.com/codex/device",
        userCode: maliciousCode,
      },
    };
    document
      .getElementById("account")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const codeEl = document.getElementById("login-code")!;
    assert.equal(codeEl.hidden, false);
    assert.equal(codeEl.textContent, maliciousCode);
    assert.equal(codeEl.querySelector("img"), null);
    assert.equal(codeEl.querySelector("script"), null);
    assert.equal(dialog.querySelector("script"), null);
    assert.equal(document.getElementById("login-steps")!.hidden, false);
    assert.match(
      document.getElementById("login-steps")!.textContent!,
      /Copy the code[\s\S]*Open OpenAI[\s\S]*Approve/,
    );

    const link = document.getElementById("login-url") as HTMLAnchorElement;
    assert.equal(link.hidden, false);
    assert.equal(
      link.getAttribute("href"),
      "https://auth.openai.com/codex/device",
    );
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noopener noreferrer");
    assert.match(
      document.getElementById("account-status")!.textContent!,
      /Waiting for approval at OpenAI\u2026 this window updates automatically/,
    );

    // Copy button calls the stubbed clipboard with exactly the user code.
    document
      .getElementById("login-copy")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(copyCalls.length, 1);
    assert.deepEqual(copyCalls[0], [maliciousCode]);
    assert.equal(
      document.getElementById("login-copy-feedback")!.textContent,
      "Copied",
    );

    const dialogText = dialog.textContent ?? "";
    assert(!dialogText.includes("access_token"));
    assert(!dialogText.includes("refresh_token"));
    assert(!dialogText.includes("Bearer "));
    assert(!/localhost:1455\/auth\/callback\?code=/.test(dialogText));
  } finally {
    dialog.dispatchEvent(new window.Event("close"));
    Object.assign(globalThis, previous);
    if (previousNavigator)
      Object.defineProperty(globalThis, "navigator", previousNavigator);
  }
});

test("Copy code falls back to selecting the text when the Clipboard API is unavailable", async () => {
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
  const previousNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const dialog = document.getElementById("account-dialog")!;
  Object.assign(dialog, { showModal: () => {} });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://hearth.example/app/"),
  });
  try {
    // No navigator.clipboard at all (e.g. insecure context or older browser).
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
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
      fetch: async (url: URL) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/bootstrap"))
          return Response.json({
            csrf: "synthetic",
            provider: "openai-codex",
            inferenceReady: true,
            homePermissions: null,
          });
        if (path.endsWith("/models") || path.endsWith("/sessions"))
          return Response.json({ items: [] });
        if (path.endsWith("/auth/status"))
          return Response.json({
            provider: "openai-codex",
            providerName: "ChatGPT / Codex",
            configured: false,
            login: {
              id: "login-1",
              state: "waiting",
              url: "https://auth.openai.com/codex/device",
              userCode: "CODE-FALLBACK",
            },
          });
        throw new Error(`Unexpected route ${path}`);
      },
    });
    await import(
      new URL(
        `../public/app.js?auth-ui-fallback-${Date.now()}`,
        import.meta.url,
      ).href
    );
    document
      .getElementById("account")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    document
      .getElementById("login-copy")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(
      document.getElementById("login-copy-feedback")!.textContent!,
      /code is selected/,
    );
  } finally {
    dialog.dispatchEvent(new window.Event("close"));
    Object.assign(globalThis, previous);
    if (previousNavigator)
      Object.defineProperty(globalThis, "navigator", previousNavigator);
  }
});
