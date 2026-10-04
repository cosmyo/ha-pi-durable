import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Runtime } from "../src/runtime.js";
import {
  AgentDoc,
  defineExtension,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { WorkspaceGuard } from "../src/workspace.js";
import { HomePermissions, Proposals } from "../src/documents.js";
import { HAClient, Actions } from "../src/ha.js";
import { appServer } from "../src/server.js";
import type { Config } from "../src/config.js";

function catalog() {
  const faux = fauxProvider({
    models: [
      { id: "first", name: "First <img src=x onerror=alert(1)>" },
      { id: "second", name: "Second" },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    faux,
    models,
    model: { provider: faux.getModel().provider, modelId: "first" },
  };
}

test("real durable multi-model selection preserves history and permissions across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-model-reopen-"));
  const { faux, models, model } = catalog();
  let runtime = await Runtime.open(dir, models, model);
  try {
    const id = await runtime.create("owner", "Example", "model-create");
    const used: string[] = [];
    faux.setResponses([
      (_ctx, _opts, _state, m) => {
        used.push(m.id);
        return fauxAssistantMessage("First response");
      },
      (_ctx, _opts, _state, m) => {
        used.push(m.id);
        return fauxAssistantMessage("Second response");
      },
    ]);
    await runtime.submit("owner", id, "turn-one", "Before switching");
    await runtime.harness.waitForIdle(ctx);
    const before = await runtime.snapshot("owner", id);
    await runtime.harness.commit(async (tx) => {
      (await tx.doc(HomePermissions)).owners.owner = {
        explicit: true,
        mode: "full",
        revision: 7,
        policy: "a".repeat(64),
        schema: 1,
        grant: {
          owner: "owner",
          policy: "a".repeat(64),
          schema: 1,
          acknowledgement: "synthetic owner acknowledgement",
          at: 1000,
        },
        invalidation: "",
      };
    }, ctx);
    const grant = await runtime.harness.snapshot(HomePermissions, ctx);
    assert.equal(before.modelSelection.model?.modelId, "first");
    assert.equal(before.modelSelection.revision, 0);
    await runtime.selectModel("owner", id, "second", "off", 0);
    assert.deepEqual(
      (await runtime.snapshot("owner", id)).view.entries,
      before.view.entries,
    );
    assert.deepEqual(
      await runtime.harness.snapshot(HomePermissions, ctx),
      grant,
    );
    await runtime.close();
    runtime = await Runtime.open(dir, models, model);
    assert.deepEqual(
      (await runtime.snapshot("owner", id)).view.entries,
      before.view.entries,
    );
    assert.deepEqual(
      await runtime.harness.snapshot(HomePermissions, ctx),
      grant,
    );
    assert.equal(
      (await runtime.snapshot("owner", id)).modelSelection.model?.modelId,
      "second",
    );
    assert.equal(
      (await runtime.harness.snapshot(AgentDoc, id as ConversationId, ctx))
        ?.model?.modelId,
      "second",
    );
    await runtime.submit("owner", id, "turn-two", "After switching");
    await runtime.harness.waitForIdle(ctx);
    assert.deepEqual(used, ["first", "second"]);
    assert.equal(
      (await runtime.snapshot("owner", id)).modelSelection.revision,
      1,
    );
    const other = await runtime.create("owner", "Another", "model-create-two");
    assert.equal(
      (await runtime.snapshot("owner", other)).modelSelection.model?.modelId,
      "first",
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("medium thinking is committed for new and switched turns, survives reopen, and unsupported levels fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-thinking-reopen-"));
  const faux = fauxProvider({
    models: [
      { id: "gpt-6.1-sol", reasoning: true },
      { id: "other", reasoning: true },
      { id: "plain", reasoning: false },
    ],
  });
  faux.getModel("gpt-6.1-sol")!.thinkingLevelMap = {
    off: null,
    medium: "medium",
  };
  faux.getModel("other")!.thinkingLevelMap = { off: null, medium: "medium" };
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: faux.getModel().provider, modelId: "gpt-6.1-sol" };
  let runtime = await Runtime.open(
    dir,
    models,
    model,
    [],
    [],
    undefined,
    undefined,
    "medium",
  );
  try {
    const id = await runtime.create("owner", "Thinking", "thinking-create");
    const observed: unknown[] = [];
    faux.setResponses([
      (_ctx, options, _state, m) => {
        observed.push([m.id, options?.reasoning]);
        return fauxAssistantMessage("One");
      },
      (_ctx, options, _state, m) => {
        observed.push([m.id, options?.reasoning]);
        return fauxAssistantMessage("Two");
      },
      (_ctx, options, _state, m) => {
        observed.push([m.id, options?.reasoning]);
        return fauxAssistantMessage("Three");
      },
    ]);
    await runtime.submit("owner", id, "thinking-one", "First");
    await runtime.harness.waitForIdle(ctx);
    assert.equal(
      (await runtime.snapshot("owner", id)).modelSelection.thinkingLevel,
      "medium",
    );
    assert.deepEqual(observed, [["gpt-6.1-sol", "medium"]]);
    await assert.rejects(
      runtime.selectModel("owner", id, "plain", "medium", 0),
      /unsupported_thinking/,
    );
    await assert.rejects(
      runtime.selectModel("owner", id, "gpt-6.1-sol", "off", 0),
      /unsupported_thinking/,
    );
    await runtime.close();
    runtime = await Runtime.open(
      dir,
      models,
      model,
      [],
      [],
      undefined,
      undefined,
      "medium",
    );
    assert.equal(
      (await runtime.snapshot("owner", id)).modelSelection.thinkingLevel,
      "medium",
    );
    await runtime.submit("owner", id, "thinking-two", "Second");
    await runtime.harness.waitForIdle(ctx);
    assert.deepEqual(observed, [
      ["gpt-6.1-sol", "medium"],
      ["gpt-6.1-sol", "medium"],
    ]);
    await runtime.selectModel("owner", id, "other", "medium", 0);
    assert.equal(
      (await runtime.snapshot("owner", id)).modelSelection.thinkingLevel,
      "medium",
    );
    await runtime.submit("owner", id, "thinking-three", "Third");
    await runtime.harness.waitForIdle(ctx);
    assert.deepEqual(observed, [
      ["gpt-6.1-sol", "medium"],
      ["gpt-6.1-sol", "medium"],
      ["other", "medium"],
    ]);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unsafe Code continuation blocks switching until a new human input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-model-code-"));
  const { models, model, faux } = catalog();
  const extension = defineExtension({ name: "synthetic-code" });
  const runtime = await Runtime.open(dir, models, model, [extension], [], {
    home: [],
    workspace: [extension],
  });
  try {
    const id = await runtime.create(
      "owner",
      "Code",
      "code-create",
      "workspace",
    );
    faux.setResponses([fauxAssistantMessage("Done")]);
    await runtime.submit(
      "owner",
      id,
      "code-input",
      "Inspect synthetic workspace",
    );
    await runtime.harness.waitForIdle(ctx);
    await runtime.harness.commit(async (tx) => {
      (await tx.doc(WorkspaceGuard, id as ConversationId)).blockedEpoch = 1;
    }, ctx);
    await assert.rejects(
      runtime.selectModel("owner", id, "second", "off", 0),
      /workspace_continuation_blocked/,
    );
    assert.equal(
      (await runtime.snapshot("owner", id)).modelSelection.revision,
      0,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("model API is owner-bound, CSRF-protected and CAS guarded; busy and unresolved actions fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-model-http-"));
  const { faux, models, model } = catalog();
  const runtime = await Runtime.open(dir, models, model);
  const cfg: Config = {
    mode: "local",
    host: "127.0.0.1",
    port: 8099,
    origin: "http://127.0.0.1:8099",
    password: "synthetic-local-password-0001",
    authorizedUsers: [],
    dataDir: dir,
    provider: "offline",
    model: "first",
    haToken: "synthetic-ha-token",
    apiKey: "synthetic-api-key",
    policy: { enabled: false, entities: [], services: [] },
  };
  const app = appServer(
    cfg,
    runtime,
    new Actions(runtime, new HAClient(cfg.haToken, cfg.policy)),
  );
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  cfg.origin = `http://127.0.0.1:${address.port}`;
  const auth = `Basic ${Buffer.from(`hearth:${cfg.password}`).toString("base64")}`;
  const endpoint = (path: string, init: RequestInit = {}) =>
    fetch(`${cfg.origin}${path}`, {
      ...init,
      headers: { authorization: auth, ...init.headers },
    });
  try {
    const id = await runtime.create(
      "local-admin",
      "Example",
      "model-http-create",
    );
    const other = await runtime.create(
      "another-owner",
      "Private",
      "model-http-private",
    );
    const boot = await endpoint("/api/bootstrap");
    const csrf = (await boot.json()).csrf;
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const post = (
      session: number,
      value: unknown,
      headers: Record<string, string> = {},
    ) =>
      endpoint(`/api/sessions/${session}/model`, {
        method: "POST",
        headers: {
          cookie,
          origin: cfg.origin,
          "x-hearth-csrf": csrf,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(value),
      });
    const body = { modelId: "second", thinkingLevel: "off", revision: 0 };
    assert.equal((await fetch(`${cfg.origin}/api/models`)).status, 401);
    assert.equal(
      (
        await fetch(`${cfg.origin}/api/sessions/${id}/model`, {
          method: "POST",
          body: JSON.stringify({
            modelId: "second",
            thinkingLevel: "off",
            revision: 0,
          }),
        })
      ).status,
      401,
    );
    assert.equal((await post(id, body, { "x-hearth-csrf": "" })).status, 403);
    assert.equal((await post(other, body)).status, 404);
    const choices = await (await endpoint("/api/models")).json();
    assert.deepEqual(
      choices.items.map((m: { id: string }) => m.id),
      ["first", "second"],
    );
    assert.deepEqual(Object.keys(choices.items[0]).sort(), [
      "id",
      "name",
      "provider",
    ]);
    assert.equal(
      (
        await post(id, {
          modelId: "other/third",
          thinkingLevel: "off",
          revision: 0,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post(id, {
          modelId: "sk-secret",
          thinkingLevel: "off",
          revision: 0,
        })
      ).status,
      400,
    );
    assert.equal((await post(id, { ...body, injected: true })).status, 400);
    assert.equal((await post(id, { ...body, revision: "0" })).status, 400);
    assert.equal((await post(id, body)).status, 200);
    assert.equal((await post(id, body)).status, 409);
    assert.equal(
      (await runtime.snapshot("local-admin", id)).modelSelection.revision,
      1,
    );
    let unblock!: () => void;
    const hold = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    faux.setResponses([
      async () => {
        await hold;
        return fauxAssistantMessage("Done");
      },
    ]);
    await runtime.submit("local-admin", id, "model-busy", "Keep running");
    assert.equal(
      (await post(id, { modelId: "first", thinkingLevel: "off", revision: 1 }))
        .status,
      409,
    );
    unblock();
    await runtime.harness.waitForIdle(ctx);
    await runtime.harness.commit(async (tx) => {
      (await tx.doc(Proposals, id as ConversationId)).items["1"] = {
        id: "1",
        action: {
          service: "light.turn_on",
          entityId: "light.example",
          data: {},
        },
        hash: "a".repeat(64),
        policy: "synthetic",
        created: Date.now(),
        expires: Date.now() + 10000,
        status: "unknown",
        decidedBy: "",
        decidedAt: 0,
        resolution: "",
      };
    }, ctx);
    assert.equal(
      (await post(id, { modelId: "first", thinkingLevel: "off", revision: 1 }))
        .status,
      409,
    );
    assert.equal(
      (await runtime.snapshot("local-admin", id)).modelSelection.model?.modelId,
      "second",
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Run the actual browser module against a synthetic DOM and a fake authenticated API.
test("model dropdown is text-only, drafts do not apply, failures refresh authoritative state", async () => {
  const { parseHTML } = await import("linkedom");
  const { readFile } = await import("node:fs/promises");
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
  const requests: {
    modelId: string;
    thinkingLevel: string;
    revision: number;
  }[] = [];
  let active = "first",
    revision = 0,
    fail = false;
  const snapshot = () => ({
    modelSelection: {
      model: { provider: "faux", modelId: active },
      thinkingLevel: "off",
      revision,
    },
    view: { entries: [], docs: { "pi.live": {}, "pi.usage": { models: {} } } },
    homePermissions: null,
    homeCanvas: null,
    proposals: {},
    lastInput: null,
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
        if (path.endsWith("/model")) {
          const body = JSON.parse(String(options?.body));
          requests.push(body);
          if (fail)
            return Response.json(
              { error: "stale_model_selection" },
              { status: 409 },
            );
          active = body.modelId;
          revision++;
          return Response.json({
            model: { provider: "faux", modelId: active },
            revision,
          });
        }
        if (path.endsWith("/bootstrap"))
          return Response.json({
            csrf: "synthetic",
            provider: "faux",
            homePermissions: null,
            inferenceReady: true,
          });
        if (path.endsWith("/models"))
          return Response.json({
            items: [
              { id: "first", provider: "faux", name: "First" },
              {
                id: "second",
                provider: "faux",
                name: '<img src=x onerror="alert(1)">',
              },
            ],
          });
        if (path.endsWith("/sessions"))
          return Response.json({
            items: [{ id: 1, title: "Example", kind: "home" }],
          });
        if (path.endsWith("/snapshot")) return Response.json(snapshot());
        throw new Error(`Unexpected synthetic route: ${path}`);
      },
    });
    // linkedom's select.value is read-only (browser select.value is writable).
    for (const [id, initial] of [
      ["model-choice", "first"],
      ["thinking-choice", "off"],
    ] as const) {
      let value = initial;
      Object.defineProperty(document.getElementById(id), "value", {
        configurable: true,
        get: () => value,
        set: (next) => {
          value = next;
        },
      });
    }
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://hearth.example/app/"),
    });
    await import(
      new URL(`../public/app.js?model-picker-${Date.now()}`, import.meta.url)
        .href
    );
    const picker = document.getElementById("model-choice") as HTMLSelectElement;
    const apply = document.getElementById("apply-model") as HTMLButtonElement;
    assert.equal(
      picker.disabled,
      false,
      document.getElementById("feedback")!.textContent,
    );
    assert.equal(apply.disabled, true);
    assert.equal(document.querySelector(".model-picker img"), null);
    picker.value = "second";
    picker.dispatchEvent(new window.Event("change"));
    assert.equal(apply.disabled, false);
    assert.equal(requests.length, 0);
    apply.dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(requests, [
      { modelId: "second", thinkingLevel: "off", revision: 0 },
    ]);
    assert.match(
      document.getElementById("active-model")!.textContent!,
      /second/,
    );
    assert.equal(apply.disabled, true);
    picker.value = "first";
    picker.dispatchEvent(new window.Event("change"));
    fail = true;
    apply.dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(
      document.getElementById("feedback")!.textContent!,
      /not confirmed/,
    );
    assert.equal(picker.value, "second");
    assert.equal(apply.disabled, true);
    assert.equal(requests.length, 2); // no automatic retry
  } finally {
    Object.assign(globalThis, previous);
  }
});
