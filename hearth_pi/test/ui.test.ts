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

// Regression for a live-install evidence screenshot: raw messages like
// `ha_search_states {"query":"","offset":0}` and huge JSON tool results
// pushed the actual reply far down the transcript. One assistant turn's
// tool calls/results must collapse into a single friendly, collapsed-by-
// default activity row instead.
test("a turn's tool calls and results collapse into one friendly activity row; unknown tools fall back to their name; hostile names/args/results stay text; errors are visible while collapsed; long results truncate with Show more", async () => {
  const { document, Event } = parseHTML(
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
    const hostileArg = "<script>alert(1)</script>";
    const hostileText = '<img src=x onerror="alert(2)">';
    const longResult = JSON.stringify({
      items: Array.from({ length: 60 }, (_, i) => `${hostileText} entity_${i}`),
    });
    renderMessages(chat, {
      view: {
        entries: [
          {
            model: [
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "c1",
                    name: "ha_search_states",
                    arguments: { query: hostileArg, offset: 0 },
                  },
                ],
              },
            ],
          },
          {
            model: [
              {
                role: "toolResult",
                toolCallId: "c1",
                toolName: "ha_search_states",
                content: [{ type: "text", text: longResult }],
                isError: false,
              },
            ],
          },
          {
            model: [
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "c2",
                    name: "a_future_unmapped_tool",
                    arguments: { note: hostileArg },
                  },
                ],
              },
            ],
          },
          {
            model: [
              {
                role: "toolResult",
                toolCallId: "c2",
                toolName: "a_future_unmapped_tool",
                content: [{ type: "text", text: `${hostileText} failed` }],
                isError: true,
              },
            ],
          },
          {
            model: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Here is what I found." }],
              },
            ],
          },
        ],
        docs: { "pi.live": {} },
      },
    });
    const activities = chat.querySelectorAll(".message.activity");
    assert.equal(
      activities.length,
      1,
      "both tool calls of one turn collapse into a single activity row, not one row per call/result",
    );
    const details = activities[0]!.querySelector("details.activity-details")!;
    assert.equal(details.hasAttribute("open"), false, "collapsed by default");
    const summary = details.querySelector("summary.activity-summary")!;
    assert.match(
      summary.querySelector(".activity-summary-text")!.textContent!,
      /Searched home/,
      "known tool maps to a friendly verb",
    );
    assert.match(
      details.textContent!,
      /a_future_unmapped_tool/,
      "unmapped tool falls back to its raw name instead of being hidden",
    );
    // Errors stay visible in the summary line itself, which is the only part
    // shown while the <details> is collapsed.
    assert.match(summary.textContent!, /issue/i);
    assert.equal(activities[0]!.querySelector("img"), null);
    assert.equal(activities[0]!.querySelector("script"), null);
    assert(chat.textContent!.includes(hostileArg));
    assert(chat.textContent!.includes(hostileText));
    // The long tool result is truncated with an explicit "Show more".
    const more = details.querySelector(".tool-result-more") as HTMLElement;
    assert(more, "a long result renders truncated with a Show more control");
    const pre = more.previousElementSibling as HTMLElement;
    const truncatedLength = pre.textContent!.length;
    more.dispatchEvent(new Event("click"));
    assert(pre.textContent!.length > truncatedLength);
    assert.equal(details.querySelector(".tool-result-more"), null);
    // The final reply is plain assistant text, separate from the activity row.
    const assistantArticles = chat.querySelectorAll(".message.assistant");
    assert.equal(assistantArticles.length, 1);
    assert.match(assistantArticles[0]!.textContent!, /Here is what I found\./);
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
});

test("in-progress tool calls render one animated Working\u2026 line, not one raw row per tool", async () => {
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
    renderMessages(chat, {
      view: {
        entries: [],
        docs: {
          "pi.live": {
            tools: [
              {
                callId: "a",
                name: "ha_search_states",
                status: "done",
                output: "ok",
              },
              {
                callId: "b",
                name: "ha_state_detail",
                status: "running",
                output: "",
              },
            ],
          },
        },
      },
    });
    const liveRows = chat.querySelectorAll(".activity-live");
    assert.equal(
      liveRows.length,
      1,
      "the whole in-progress round is one row, not one per tool slot",
    );
    assert.match(liveRows[0]!.textContent!, /Working/);
    assert.match(
      liveRows[0]!.textContent!,
      /Read a device/,
      "shows the currently running step",
    );
    assert.equal(chat.querySelectorAll(".message").length, 1);
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
});

test("assistant replies are plain text with a Copy button using navigator.clipboard, with a fallback when it is unavailable", async () => {
  const { document, Event } = parseHTML(
    '<html><body><div id="chat"></div></body></html>',
  );
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
  });
  const previousNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  try {
    const { renderMessages } = await import(
      new URL("../public/render.js", import.meta.url).href
    );
    let copied = "";
    Object.defineProperty(globalThis, "navigator", {
      value: {
        clipboard: { writeText: async (t: string) => void (copied = t) },
      },
      configurable: true,
    });
    const chat = document.getElementById("chat")!;
    renderMessages(chat, {
      view: {
        entries: [
          {
            model: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Hello **there**" }],
              },
            ],
          },
        ],
        docs: { "pi.live": {} },
      },
    });
    assert.equal(chat.querySelectorAll(".message.assistant").length, 1);
    const copyButton = chat.querySelector(".message-copy") as HTMLElement;
    assert(copyButton, "assistant reply has a copy control");
    copyButton.dispatchEvent(new Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(copied, "Hello **there**");
    assert.equal(copyButton.textContent, "Copied");

    // Without a Clipboard API, the fallback never throws and still reports a status.
    delete (globalThis as { navigator?: unknown }).navigator;
    renderMessages(chat, {
      view: {
        entries: [
          {
            model: [
              { role: "assistant", content: [{ type: "text", text: "Again" }] },
            ],
          },
        ],
        docs: { "pi.live": {} },
      },
    });
    const fallbackButton = chat.querySelector(".message-copy") as HTMLElement;
    fallbackButton.dispatchEvent(new Event("click"));
    assert.notEqual(fallbackButton.textContent, "");
  } finally {
    delete (globalThis as { document?: unknown }).document;
    if (previousNavigator)
      Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});
