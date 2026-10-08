import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { readFile } from "node:fs/promises";

// The server rejects a session title over 80 chars (runtime.ts: text(title,
// 80)) instead of truncating it. Before this test's fix, typing an ordinary
// long title into the "New chat" prompt silently failed new-chat with a raw
// "invalid_request" error instead of creating a session.
test("new-chat title longer than the server's bound is clamped client-side instead of failing with invalid_request", async () => {
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
  const SERVER_TITLE_MAX = 80;
  const overlongTitle =
    "Why does the living room sensor keep reporting unusually high humidity readings during the afternoon";
  assert(overlongTitle.length > SERVER_TITLE_MAX);
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let created = false;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://hearth.example/app/"),
  });
  for (const id of ["model-choice", "thinking-choice"]) {
    const select = document.getElementById(id)!;
    let value = "";
    Object.defineProperty(select, "value", {
      configurable: true,
      get: () => value,
      set: (v) => {
        value = v;
      },
    });
  }
  window.prompt = () => overlongTitle;
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
            items: created
              ? [{ id: 9, owner: "owner", title: body, kind: "home" }]
              : [],
          });
        if (path.endsWith("/sessions") && method === "POST") {
          // Mirrors the server's real text(title, 80) bound (safety.ts/runtime.ts):
          // a title over the max is rejected, never silently truncated server-side.
          if (
            typeof body?.title !== "string" ||
            body.title.length > SERVER_TITLE_MAX
          )
            return new Response(JSON.stringify({ error: "invalid_request" }), {
              status: 400,
            });
          created = true;
          return new Response(JSON.stringify({ id: 9 }), { status: 201 });
        }
        if (path.endsWith("/sessions/9/snapshot"))
          return Response.json({
            modelSelection: null,
            homePermissions: null,
            homeCanvas: null,
            proposals: {},
            lastInput: null,
            view: { entries: [], docs: {} },
          });
        throw new Error(`Unexpected route ${path}`);
      },
    });
    await import(
      new URL(`../public/app.js?new-chat-title-${Date.now()}`, import.meta.url)
        .href
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    document
      .getElementById("new-chat-icon")!
      .dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const createCall = requests.find(
      (r) => r.path.endsWith("/sessions") && r.method === "POST",
    );
    assert(createCall, "expected a POST /api/sessions call");
    const sentTitle = (createCall!.body as { title: string }).title;
    assert.equal(sentTitle, overlongTitle.slice(0, SERVER_TITLE_MAX));
    assert(sentTitle.length <= SERVER_TITLE_MAX);
    assert(created, "session creation should have succeeded, not 400ed");
    assert.equal(
      document.getElementById("feedback")!.textContent,
      "",
      "no invalid_request error should have reached the user",
    );
  } finally {
    Object.assign(globalThis, previous);
  }
});

// Exercise the same renderer used by the authenticated snapshot/SSE path.
test("Home canvas uses observed values/times and drafts questions, never model HTML or action dispatch", async () => {
  const { document, Event } = parseHTML(
    '<html><body><div id="canvas"></div></body></html>',
  );
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
  });
  try {
    const { renderCanvas } = await import(
      new URL("../public/render.js", import.meta.url).href
    );
    const target = document.getElementById("canvas")!,
      questions: string[] = [];
    const malicious = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    renderCanvas(
      target,
      {
        title: malicious,
        committedAt: 1000,
        sections: [
          {
            title: malicious,
            readings: [
              {
                entityId: "sensor.example",
                state: malicious,
                observedAt: 999,
                attributes: {
                  friendly_name: malicious,
                  unit_of_measurement: malicious,
                },
              },
            ],
          },
        ],
      },
      (q: string) => questions.push(q),
    );
    assert(target.textContent!.includes(malicious));
    assert.match(
      target.textContent!,
      /saved observation|not continuously live/,
    );
    assert.equal(target.querySelector("img"), null);
    assert.equal(target.querySelector("script"), null);
    assert.equal(questions.length, 0);
    const buttons = target.querySelectorAll("button");
    assert.equal(buttons.length, 2);
    buttons[0]!.dispatchEvent(new Event("click"));
    buttons[1]!.dispatchEvent(new Event("click"));
    assert.match(questions[0]!, /ha_build_view/);
    assert.match(questions[1]!, /sensor.example/);
    assert(questions.every((q) => /do not|instead of guessing/.test(q)));
    renderCanvas(target, null, (q: string) => questions.push(q));
    assert.match(target.textContent!, /approved HA entities/);
    assert.equal(target.querySelector(".canvas-card"), null);
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
});

test("UI renders model/entity/tool/action data as text, not executable HTML; exact review binding", async () => {
  const { document, Event } = parseHTML(
    '<html><body><div id="chat"></div><div id="actions"></div></body></html>',
  );
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
  });
  try {
    const { renderMessages, renderProposals } = await import(
      new URL("../public/render.js", import.meta.url).href
    );
    const malicious = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const chat = document.getElementById("chat")!;
    renderMessages(chat, {
      view: {
        entries: [
          {
            model: [
              {
                role: "assistant",
                content: [{ type: "text", text: malicious }],
              },
            ],
          },
          {
            model: [
              {
                role: "toolResult",
                content: [{ type: "text", text: malicious }],
              },
            ],
          },
        ],
        docs: { "pi.live": {} },
      },
    });
    assert(chat.textContent!.includes(malicious));
    assert.equal(chat.querySelector("img"), null);
    renderMessages(chat, {
      view: {
        entries: [
          {
            model: [
              {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: malicious,
              },
            ],
          },
        ],
        docs: { "pi.live": {} },
      },
    });
    assert.match(chat.textContent!, /did not complete/);
    assert(chat.textContent!.includes(malicious));
    assert.equal(chat.querySelector("img"), null);
    assert.equal(chat.querySelector("pre"), null);
    assert.equal(chat.querySelector("script"), null);
    const container = document.getElementById("actions")!;
    const decisions: unknown[] = [];
    const p = {
      id: "123",
      hash: "original-immutable-hash",
      action: {
        service: "light.turn_on",
        entityId: malicious,
        data: { brightness: 8 },
      },
      status: "pending",
      created: Date.now(),
      expires: Date.now() + 10000,
      resolution: malicious,
    };
    renderProposals(
      container,
      { "123": p },
      (proposal: unknown, decision: unknown) =>
        decisions.push({ proposal, decision }),
    );
    assert.equal(container.querySelector("script"), null);
    assert.equal(container.querySelector("img"), null);
    assert(container.textContent!.includes(malicious));
    assert.equal(decisions.length, 0);
    container.querySelector("button")!.dispatchEvent(new Event("click"));
    assert.deepEqual(decisions, [{ proposal: p, decision: "approve" }]);
    renderProposals(
      container,
      { "123": p },
      () => assert.fail("should not dispatch"),
      false,
    );
    assert.equal(container.querySelector("button")!.disabled, true);
    assert.equal(container.querySelectorAll("button")[1]!.disabled, false);
    const script = await readFile(
      new URL("../public/app.js", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      script,
      /innerHTML|outerHTML|insertAdjacentHTML|eval\(/,
    );
    const html = await readFile(
      new URL("../public/index.html", import.meta.url),
      "utf8",
    );
    assert.match(html, /aria-label="Conversation"/);
    assert.match(html, /maxlength="4000"/);
    assert.match(html, /type="module" src="\.\/app.js"/);
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
});

test("assistant markdown renders as DOM elements and never interprets HTML", async () => {
  const { document } = parseHTML(
    '<html><body><div id="chat"></div></body></html>',
  );
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
  });
  try {
    const { renderMessages } = await import(
      new URL("../public/render.js", import.meta.url).href
    );
    const chat = document.getElementById("chat")!;
    const hostile =
      '<img src=x onerror="alert(1)"> [x](javascript:alert(2)) **<script>alert(3)</script>**';
    renderMessages(chat, {
      view: {
        entries: [
          {
            model: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: `## Status\n- **Troubleshoot:** check \`automation.hall\`\n- second _item_\n\n1. one\n2. two\n\n\`\`\`\nraw <b>code</b>\n\`\`\`\n${hostile}`,
                  },
                  {
                    type: "toolCall",
                    name: "ha_state_detail",
                    arguments: { entityId: "light.example" },
                  },
                ],
              },
              { role: "user", content: "**not markdown for user input**" },
            ],
          },
        ],
        docs: { "pi.live": {} },
      },
    });
    assert.equal(chat.querySelectorAll(".md ul li").length, 2);
    assert.equal(chat.querySelectorAll(".md ol li").length, 2);
    assert.equal(
      chat.querySelector(".md strong")!.textContent,
      "Troubleshoot:",
    );
    assert.equal(
      chat.querySelector(".md code")!.textContent,
      "automation.hall",
    );
    assert.equal(chat.querySelector(".md em")!.textContent, "item");
    assert.equal(chat.querySelector(".md .md-h")!.textContent, "Status");
    assert.equal(
      chat.querySelector(".md-code")!.textContent,
      "raw <b>code</b>",
    );
    assert.match(
      chat.querySelector(".tool-call")!.textContent!,
      /light\.example/,
    );
    // Hostile markup stays literal text; nothing executable or linkable appears.
    for (const tag of ["img", "script", "a", "b", "iframe"])
      assert.equal(chat.querySelector(tag), null, tag);
    assert(chat.textContent!.includes('<img src=x onerror="alert(1)">'));
    assert(chat.textContent!.includes("<script>alert(3)</script>"));
    // User text is shown verbatim, not parsed as markdown.
    assert(chat.textContent!.includes("**not markdown for user input**"));
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
});
