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
    assert.equal(
      document.getElementById("account")!.textContent,
      "Anthropic login",
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
