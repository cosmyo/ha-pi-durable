// The browser module (public/app.js) against a synthetic DOM and a fake
// authenticated API: the model sheet's thinking levels, disabled reasons and
// refusal copy, Discard for definitely refused saved messages, and
// follow-ups typed while Hearth answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { readFile } from "node:fs/promises";

type Reply = Response | Error;
type Fake = {
  models?: unknown[];
  kind?: "home" | "workspace";
  snapshot: () => Record<string, unknown>;
  // Returns the reply for a POST; throws for a network failure.
  post?: (path: string, body: Record<string, unknown>) => Reply;
};
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
function baseSnapshot(extra: Record<string, unknown> = {}) {
  return {
    modelSelection: {
      model: { provider: "faux", modelId: "alpha" },
      thinkingLevel: "medium",
      revision: 0,
    },
    view: { entries: [], docs: { "pi.live": {}, "pi.usage": { models: {} } } },
    homePermissions: null,
    homeCanvas: null,
    proposals: {},
    lastInput: null,
    imageInput: true,
    ...extra,
  };
}
async function loadApp(fake: Fake) {
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
  const storage = new Map<string, string>();
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  let emit: (value: unknown) => void = () => {};
  Object.assign(globalThis, {
    window,
    document,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    EventSource: class {
      close() {}
      addEventListener(
        type: string,
        listener: (event: { data: string }) => void,
      ) {
        if (type === "snapshot")
          emit = (value) => listener({ data: JSON.stringify(value) });
      }
    },
    fetch: async (url: URL, options?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (options?.method === "POST") {
        const body = JSON.parse(String(options.body));
        posts.push({ path, body });
        const reply = fake.post?.(path, body);
        if (reply instanceof Error) throw reply;
        if (reply) return reply;
        throw new Error(`Unexpected POST ${path}`);
      }
      if (path.endsWith("/bootstrap"))
        return Response.json({
          csrf: "synthetic",
          provider: "faux",
          defaultThinkingLevel: "off",
          model: "alpha",
          homePermissions: null,
          inferenceReady: true,
        });
      if (path.endsWith("/models"))
        return Response.json({ items: fake.models ?? [] });
      if (path.endsWith("/sessions"))
        return Response.json({
          items: [{ id: 1, title: "Example", kind: fake.kind ?? "home" }],
        });
      if (path.endsWith("/snapshot")) return Response.json(fake.snapshot());
      throw new Error(`Unexpected synthetic route: ${path}`);
    },
  });
  // linkedom's select.value is read-only (a browser's is writable).
  for (const id of ["model-choice", "thinking-choice"]) {
    let value = "";
    Object.defineProperty(document.getElementById(id), "value", {
      configurable: true,
      get: () => value,
      set: (next) => {
        value = String(next);
      },
    });
  }
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://hearth.example/app/"),
  });
  const restore = () => Object.assign(globalThis, previous);
  try {
    await import(
      new URL(
        `../public/app.js?chat-ux-${Date.now()}-${Math.random()}`,
        import.meta.url,
      ).href
    );
  } catch (error) {
    restore();
    throw error;
  }
  const el = <T = HTMLElement>(id: string) =>
    document.getElementById(id) as unknown as T;
  const change = (id: string, value: string) => {
    el<HTMLSelectElement>(id).value = value;
    el(id).dispatchEvent(new window.Event("change"));
  };
  const click = async (id: string) => {
    el(id).dispatchEvent(new window.Event("click"));
    await tick();
  };
  const type = (value: string) => {
    el<HTMLTextAreaElement>("message").value = value;
    el("message").dispatchEvent(new window.Event("input"));
  };
  const send = async () => {
    el("composer").dispatchEvent(
      new window.Event("submit", { cancelable: true }),
    );
    await tick();
  };
  const options = (id: string) =>
    [...el(id).querySelectorAll("option")].map(
      (o) => (o as HTMLOptionElement).value,
    );
  return {
    window,
    document,
    storage,
    posts,
    emit: (value: unknown) => emit(value),
    el,
    change,
    click,
    type,
    send,
    options,
    restore,
  };
}

const MODELS = [
  {
    id: "alpha",
    provider: "faux",
    name: "Alpha",
    thinkingLevels: ["minimal", "low", "medium", "high"],
  },
  { id: "plain", provider: "faux-two", name: "Plain", thinkingLevels: ["off"] },
];
const SEP = "\u0000";

test("model sheet: only the chosen model's thinking levels are offered, so an unsupported pair cannot be applied; a draft survives snapshots", async () => {
  let snapshot = baseSnapshot();
  const app = await loadApp({
    models: MODELS,
    snapshot: () => snapshot,
    post: (path, body) =>
      path.endsWith("/model")
        ? Response.json({ ...body, revision: 1 })
        : new Error("unexpected"),
  });
  try {
    // Two providers: values carry the provider, and the committed model and
    // its level are selected.
    assert.equal(
      app.el<HTMLSelectElement>("model-choice").value,
      `faux${SEP}alpha`,
    );
    assert.deepEqual(app.options("thinking-choice"), [
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    assert.equal(app.el<HTMLSelectElement>("thinking-choice").value, "medium");
    assert.equal(app.el<HTMLButtonElement>("apply-model").disabled, true);
    assert.equal(app.el("model-hint").textContent, "");
    // A model without thinking: only Off, and Off is chosen.
    app.change("model-choice", `faux-two${SEP}plain`);
    assert.deepEqual(app.options("thinking-choice"), ["off"]);
    assert.equal(app.el<HTMLSelectElement>("thinking-choice").value, "off");
    assert.equal(app.el<HTMLButtonElement>("apply-model").disabled, false);
    // A live event with the same revision keeps the draft.
    app.emit(snapshot);
    assert.equal(
      app.el<HTMLSelectElement>("model-choice").value,
      `faux-two${SEP}plain`,
    );
    // Even a stale value outside the model's levels cannot be applied.
    app.el<HTMLSelectElement>("thinking-choice").value = "high";
    app.el("thinking-choice").dispatchEvent(new app.window.Event("change"));
    assert.equal(app.el<HTMLButtonElement>("apply-model").disabled, true);
    app.change("thinking-choice", "off");
    snapshot = {
      ...baseSnapshot(),
      modelSelection: {
        model: { provider: "faux-two", modelId: "plain" },
        thinkingLevel: "off",
        revision: 1,
      },
    };
    await app.click("apply-model");
    assert.deepEqual(
      app.posts.map((p) => p.body),
      [
        {
          provider: "faux-two",
          modelId: "plain",
          thinkingLevel: "off",
          revision: 0,
        },
      ],
    );
    // Back to a thinking model: the installation default (Off) is not
    // offered there, so its first level is chosen.
    app.change("model-choice", `faux${SEP}alpha`);
    assert.equal(app.el<HTMLSelectElement>("thinking-choice").value, "minimal");
  } finally {
    app.restore();
  }
});

test("model sheet: says in plain words why it is disabled, and maps refusals to what to do", async () => {
  const snapshot: Record<string, unknown> = baseSnapshot();
  let refusal = { status: 409, error: "action_unresolved" };
  const app = await loadApp({
    models: MODELS.slice(0, 1),
    snapshot: () => snapshot,
    post: () =>
      Response.json({ error: refusal.error }, { status: refusal.status }),
  });
  try {
    const hint = () => app.el("model-hint").textContent;
    const disabled = () => app.el<HTMLSelectElement>("model-choice").disabled;
    assert.equal(disabled(), false);
    // A running turn.
    app.emit({
      ...baseSnapshot(),
      view: {
        entries: [],
        docs: {
          "pi.live": { run: { inputs: [1] } },
          "pi.usage": { models: {} },
        },
      },
    });
    assert.equal(disabled(), true);
    assert.match(hint()!, /Hearth is answering.*when it finishes/);
    // An action waiting for a person.
    app.emit({
      ...baseSnapshot(),
      proposals: { "1": { id: "1", status: "pending", action: {} } },
    });
    assert.equal(disabled(), true);
    assert.match(hint()!, /Answer or dismiss the approval first/);
    // The refusals the server can still make, in plain words.
    app.emit(baseSnapshot());
    assert.equal(disabled(), false);
    const expected: [string, number, RegExp][] = [
      [
        "action_unresolved",
        409,
        /Answer or dismiss the waiting approval first/,
      ],
      ["session_busy", 409, /still answering.*when it finishes/],
      ["unsupported_thinking", 400, /doesn't offer that thinking level/],
      ["stale_model_selection", 409, /changed somewhere else.*pick again/],
      ["something_new", 400, /^The model was not changed \(something_new\)\.$/],
      // Codes naming Object.prototype members are unknown codes too.
      ["toString", 400, /^The model was not changed \(toString\)\.$/],
      ["constructor", 409, /^The model was not changed \(constructor\)\.$/],
      ["request_failed", 500, /Couldn't confirm the model change/],
    ];
    for (const [error, status, text] of expected) {
      refusal = { status, error };
      app.change("thinking-choice", "high");
      await app.click("apply-model");
      assert.match(app.el("feedback").textContent!, text, error);
      assert.match(hint()!, text, error);
      assert.doesNotMatch(
        app.el("feedback").textContent!,
        /Model not confirmed:/,
      );
    }
  } finally {
    app.restore();
  }
});

test("saved message: Discard only after a definite refusal; an unknown outcome keeps Retry with the same request ID only", async () => {
  let reply: () => Reply = () => new TypeError("Failed to fetch");
  const app = await loadApp({
    models: MODELS.slice(0, 1),
    snapshot: () => baseSnapshot(),
    post: (path) => (path.endsWith("/inputs") ? reply() : new Error("no")),
  });
  try {
    const hidden = (id: string) => app.el(id).hidden;
    const saved = () =>
      [...app.storage.keys()].filter((k) => k.startsWith("hearth:pending:"));
    // Network failure after sending: unknown outcome.
    app.type("Turn on the porch light");
    await app.send();
    assert.equal(saved().length, 1);
    assert.equal(hidden("retry"), false);
    assert.equal(hidden("discard-saved"), true, "no Discard when unknown");
    assert.equal(app.el<HTMLTextAreaElement>("message").disabled, true);
    assert.match(
      app.el("feedback").textContent!,
      /couldn't confirm.*Retry sends it again safely/,
    );
    const requestId = app.posts[0]!.body.requestId;
    // A 5xx is just as unknown.
    reply = () => Response.json({ error: "request_failed" }, { status: 500 });
    await app.click("retry");
    assert.equal(hidden("discard-saved"), true);
    // A definite refusal (4xx, known code): Discard appears.
    reply = () => Response.json({ error: "session_busy" }, { status: 409 });
    await app.click("retry");
    assert.equal(hidden("discard-saved"), false);
    assert.equal(hidden("saved-new-chat"), true);
    assert.match(
      app.el("feedback").textContent!,
      /Retry when Hearth finishes, or discard/,
    );
    // Retrying again clears it first: a following unknown outcome hides Discard.
    reply = () => new TypeError("Failed to fetch");
    await app.click("retry");
    assert.equal(hidden("discard-saved"), true);
    assert.equal(JSON.parse(app.storage.get(saved()[0]!)!).refused, undefined);
    // Every attempt reused the same request ID.
    assert.ok(app.posts.every((p) => p.body.requestId === requestId));
    assert.equal(app.posts.length, 4);
    // A full chat: Discard and Start a new chat.
    reply = () =>
      Response.json(
        { error: "transcript_limit_create_session" },
        { status: 429 },
      );
    await app.click("retry");
    assert.equal(hidden("discard-saved"), false);
    assert.equal(hidden("saved-new-chat"), false);
    assert.match(
      app.el("feedback").textContent!,
      /This chat is full\. Start a new chat/,
    );
    // Discard: the saved key is gone and the text is back in the composer.
    app.el<HTMLTextAreaElement>("message").value = "";
    await app.click("discard-saved");
    assert.equal(saved().length, 0);
    assert.equal(
      app.el<HTMLTextAreaElement>("message").value,
      "Turn on the porch light",
    );
    assert.equal(app.el<HTMLTextAreaElement>("message").disabled, false);
    assert.equal(hidden("saved-actions"), true);
    assert.equal(app.posts.length, 5, "discarding sends nothing");
  } finally {
    app.restore();
  }
});

test("saved message refused for the other known codes offers Discard with a plain sentence; an unknown 4xx code does not", async () => {
  const codes: [string, number, RegExp | null][] = [
    ["capacity", 429, /busy with other chats/],
    ["input_limit_create_session", 429, /message limit\. Start a new chat/],
    ["image_limit_create_session", 429, /many images\. Start a new chat/],
    ["subscription_login_required", 403, /sign in first/],
    ["local_endpoint_required", 403, /local model server isn't set up/],
    ["idempotency_conflict", 409, null],
    // Codes naming Object.prototype members are unknown codes too.
    ["constructor", 409, null],
    ["toString", 400, null],
    ["__proto__", 409, null],
  ];
  let code = codes[0]!;
  const app = await loadApp({
    models: MODELS.slice(0, 1),
    snapshot: () => baseSnapshot(),
    post: () => Response.json({ error: code[0] }, { status: code[1] }),
  });
  try {
    app.type("Hello there");
    for (const next of codes) {
      code = next;
      if (app.el("retry").hidden) await app.send();
      else await app.click("retry");
      assert.equal(app.el("discard-saved").hidden, next[2] === null, next[0]);
      if (next[2]) assert.match(app.el("feedback").textContent!, next[2]);
      else assert.match(app.el("feedback").textContent!, /couldn't confirm/);
    }
  } finally {
    app.restore();
  }
});

test("while Hearth answers a Home chat the composer stays open: a follow-up is sent and shown as queued; Stop stays reachable; Code chats wait", async () => {
  const running = (inbox: unknown[] = []) =>
    baseSnapshot({
      view: {
        entries: [],
        docs: {
          "pi.live": { run: { inputs: [1] } },
          "pi.inbox": { items: inbox },
          "pi.usage": { models: {} },
        },
      },
    });
  let snapshot = running();
  const app = await loadApp({
    models: MODELS.slice(0, 1),
    snapshot: () => snapshot,
    post: (path) =>
      path.endsWith("/inputs")
        ? Response.json({ submissionId: 2 }, { status: 202 })
        : new Error("no"),
  });
  try {
    const message = app.el<HTMLTextAreaElement>("message");
    assert.equal(message.disabled, false);
    assert.equal(message.placeholder, "Add a follow-up…");
    assert.equal(app.el("stop").hidden, false);
    assert.equal(app.el("send").hidden, true, "nothing to send yet");
    // Model changes stay refused while busy.
    assert.equal(app.el<HTMLSelectElement>("model-choice").disabled, true);
    app.type("Also check the hallway");
    assert.equal(app.el("send").hidden, false);
    assert.equal(app.el("stop").hidden, false);
    await app.send();
    assert.deepEqual(
      app.posts.map((p) => [p.path, p.body.content]),
      [["/app/api/sessions/1/inputs", "Also check the hallway"]],
    );
    assert.equal(
      app.el("feedback").textContent,
      "Queued — sends when Hearth finishes.",
    );
    assert.equal(message.value, "");
    // The queued message shows in the transcript, as text.
    snapshot = running([
      {
        id: 2,
        mode: "followUp",
        content: [{ type: "text", text: "Also check the <b>hallway</b>" }],
      },
    ]);
    app.emit(snapshot);
    const queued = app.document.querySelector(".message.user.queued");
    assert.ok(queued);
    assert.match(queued!.textContent!, /Also check the <b>hallway<\/b>/);
    assert.equal(queued!.querySelector("b"), null);
    assert.match(queued!.textContent!, /Queued — sends when Hearth finishes/);
  } finally {
    app.restore();
  }
  const code = await loadApp({
    kind: "workspace",
    models: MODELS.slice(0, 1),
    snapshot: () => running(),
  });
  try {
    assert.equal(code.el<HTMLTextAreaElement>("message").disabled, true);
    code.type("More");
    assert.equal(code.el("send").hidden, true);
    await code.send();
    assert.equal(code.posts.length, 0);
  } finally {
    code.restore();
  }
});

test("after a failed run its waiting follow-ups keep Stop reachable with nothing running: Stop withdraws them; the note and model sheet say so", async () => {
  const idle = (inbox: unknown[]) =>
    baseSnapshot({
      view: {
        entries: [],
        docs: {
          "pi.live": {},
          "pi.inbox": { items: inbox },
          "pi.usage": { models: {} },
        },
      },
      lastInput: { status: "unanswered", reason: "model_error" },
    });
  let snapshot = idle([
    {
      id: 2,
      mode: "followUp",
      content: [{ type: "text", text: "Also check the hallway" }],
    },
  ]);
  const app = await loadApp({
    models: MODELS.slice(0, 1),
    snapshot: () => snapshot,
    post: (path) =>
      path.endsWith("/abort")
        ? Response.json({ stopped: true })
        : new Error("no"),
  });
  try {
    assert.equal(app.el("stop").hidden, false);
    assert.equal(app.el<HTMLButtonElement>("stop").disabled, false);
    // Not answering: the composer is the ordinary one, and Send stays.
    assert.equal(app.el("send").hidden, false);
    assert.equal(
      app.el<HTMLTextAreaElement>("message").placeholder,
      "What would you like to understand?",
    );
    const queued = app.document.querySelector(".message.user.queued");
    assert.ok(queued);
    assert.match(
      queued!.textContent!,
      /Waiting — Stop to withdraw, or send a message to continue/,
    );
    assert.doesNotMatch(queued!.textContent!, /sends when Hearth finishes/);
    assert.equal(app.el<HTMLSelectElement>("model-choice").disabled, true);
    assert.match(
      app.el("model-hint").textContent!,
      /Messages are waiting in this chat\. Stop to withdraw them/,
    );
    assert.doesNotMatch(app.el("model-hint").textContent!, /answering/);
    await app.click("stop");
    assert.deepEqual(
      app.posts.map((p) => p.path),
      ["/app/api/sessions/1/abort"],
    );
    assert.equal(
      app.el("feedback").textContent,
      "Waiting messages withdrawn; they were not sent.",
    );
    // The inbox is empty again: Stop hides and the model can change.
    snapshot = idle([]);
    app.emit(snapshot);
    assert.equal(app.el("stop").hidden, true);
    assert.equal(app.el<HTMLButtonElement>("stop").disabled, true);
    assert.equal(app.document.querySelector(".message.user.queued"), null);
    assert.equal(app.el<HTMLSelectElement>("model-choice").disabled, false);
  } finally {
    app.restore();
  }
});

test("a full chat's refused message moves to a new chat with its text and images, and is not sent by itself", async () => {
  const app = await loadApp({
    models: MODELS.slice(0, 1),
    snapshot: () => baseSnapshot(),
    post: (path) =>
      path.endsWith("/sessions")
        ? Response.json({ id: 2 }, { status: 201 })
        : path.endsWith("/inputs")
          ? Response.json(
              { error: "image_limit_create_session" },
              { status: 429 },
            )
          : new Error("no"),
  });
  try {
    // A saved message with one image, refused because the chat is full.
    app.storage.set(
      "hearth:pending:1",
      JSON.stringify({
        requestId: "synthetic-request-0001",
        content: "Here is the plan",
        imageCount: 1,
        images: [{ mimeType: "image/jpeg", data: "/9j/4AAQ" }],
      }),
    );
    await app.click("retry");
    assert.equal(app.el("saved-new-chat").hidden, false);
    await app.click("saved-new-chat");
    await tick(20);
    assert.equal(app.storage.has("hearth:pending:1"), false);
    assert.equal(
      app.el<HTMLTextAreaElement>("message").value,
      "Here is the plan",
    );
    assert.equal(
      app.document.querySelectorAll("#attachments .attachment").length,
      1,
    );
    assert.deepEqual(
      app.posts.map((p) => p.path),
      ["/app/api/sessions/1/inputs", "/app/api/sessions"],
    );
    assert.match(app.el("feedback").textContent!, /New chat started/);
  } finally {
    app.restore();
  }
});
