import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  defineExtension,
  type ConversationId,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { Catalog, Inputs } from "../src/documents.js";
import { WorkspaceGuard } from "../src/workspace.js";
import { HAClient, Actions, haExtension } from "../src/ha.js";
import { FULL_ACKNOWLEDGEMENT } from "../src/home-actions.js";
import { appServer } from "../src/server.js";
import type { Config } from "../src/config.js";
import { offline } from "./fixtures.js";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const config: Config = {
  mode: "local",
  host: "127.0.0.1",
  port: 8099,
  origin: "http://127.0.0.1:8099",
  password: "synthetic-local-password-0001",
  authorizedUsers: [],
  dataDir: "",
  provider: "offline",
  model: "test",
  policy: { enabled: false, entities: [], services: [] },
  haToken: "synthetic-supervisor-token",
  apiKey: "synthetic-provider-key",
};

test("deleting a session over HTTP is owner-bound, CSRF/Origin-protected, frees the catalog slot, 404s afterward and survives reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-delete-http-"));
  const { models, model } = offline();
  let runtime = await Runtime.open(dir, models, model);
  const cfg = { ...config, dataDir: dir };
  let app = appServer(
    cfg,
    runtime,
    new Actions(runtime, new HAClient(cfg.haToken, cfg.policy)),
  );
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  let address = app.server.address();
  assert(address && typeof address !== "string");
  let base = `http://127.0.0.1:${address.port}`;
  cfg.origin = base;
  const authorization = `Basic ${Buffer.from(`hearth:${cfg.password}`).toString("base64")}`;
  try {
    const boot = await fetch(`${base}/api/bootstrap`, {
      headers: { authorization },
    });
    const csrf = (await boot.json()).csrf;
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const get = (path: string) =>
      fetch(`${base}${path}`, { headers: { authorization } });
    const post = (
      path: string,
      value: unknown,
      extra: Record<string, string> = {},
    ) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          authorization,
          cookie,
          origin: base,
          "x-hearth-csrf": csrf,
          "content-type": "application/json",
          ...extra,
        },
        body: JSON.stringify(value),
      });
    const keep = (
      await (
        await post("/api/sessions", {
          title: "Keep",
          requestId: "delete-http-keep",
        })
      ).json()
    ).id;
    const gone = (
      await (
        await post("/api/sessions", {
          title: "Gone",
          requestId: "delete-http-gone",
        })
      ).json()
    ).id;
    assert.equal((await (await get("/api/sessions")).json()).items.length, 2);
    // Another owner's session is 404 to this owner, same as every other route.
    const otherId = await runtime.create(
      "other-owner",
      "Private",
      "delete-http-other",
    );
    assert.equal(
      (await post(`/api/sessions/${otherId}/delete`, { confirm: true })).status,
      404,
    );
    assert.equal(
      (
        await post(
          `/api/sessions/${gone}/delete`,
          { confirm: true },
          { "x-hearth-csrf": "" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          `/api/sessions/${gone}/delete`,
          { confirm: true },
          { origin: "https://attacker.example" },
        )
      ).status,
      403,
    );
    // Still present: neither rejected attempt deleted it.
    assert.equal((await (await get("/api/sessions")).json()).items.length, 2);
    const deletion = await post(`/api/sessions/${gone}/delete`, {
      confirm: true,
    });
    assert.equal(deletion.status, 200);
    assert.deepEqual(await deletion.json(), { deleted: true });
    const remaining = (await (await get("/api/sessions")).json()).items;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, keep);
    assert.equal((await get(`/api/sessions/${gone}/snapshot`)).status, 404);
    assert.equal((await get(`/api/sessions/${gone}/events`)).status, 404);
    // Deleting an already-deleted id is idempotent: 404, not a crash.
    assert.equal(
      (await post(`/api/sessions/${gone}/delete`, { confirm: true })).status,
      404,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
  // The removal is durably committed: it survives a fresh process reopening the store.
  runtime = await Runtime.open(dir, models, model);
  try {
    assert.equal((await runtime.list("local-admin")).length, 0);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a session held open by an unresolved Home proposal cannot be deleted; the installation-wide barrier stays up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-delete-barrier-"));
  const provider = offline();
  const ha = new HAClient(
    "synthetic-token",
    { enabled: true, entities: ["light.example"], services: ["light.turn_on"] },
    (async (url, init) => {
      if (init?.method === "POST") throw new Error("uncertain transport");
      return String(url).endsWith("services")
        ? Response.json([{ domain: "light", services: { turn_on: {} } }])
        : Response.json({
            entity_id: "light.example",
            state: "off",
            attributes: {},
          });
    }) as typeof fetch,
  );
  ha.actions.authorizeOwners(["owner"]);
  const extension = haExtension(ha);
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [extension],
    [],
    undefined,
    ha.actions,
  );
  try {
    const id = await runtime.create("owner", "Home", "delete-barrier-create");
    const p = await ha.actions.settings("owner");
    await ha.actions.setMode(
      "owner",
      "full",
      p.revision,
      p.policy,
      FULL_ACKNOWLEDGEMENT,
    );
    provider.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("ha_propose_service", {
          service: "light.turn_on",
          entityId: "light.example",
          data: { brightness: 42 },
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        "See authoritative receipt; no physical verification.",
      ),
    ]);
    const sub = await runtime.submit(
      "owner",
      id,
      "delete-barrier-request",
      "Turn it on",
    );
    await (await runtime.harness.submission(sub as SubmissionId, ctx))!.wait(
      ctx,
    );
    assert.equal((await ha.actions.settings("owner")).blocked, true);
    await assert.rejects(
      runtime.delete("owner", id),
      /delete_proposal_unresolved/,
    );
    assert(
      (await runtime.list("owner")).some((s) => s.id === id),
      "refused deletion must not remove the session",
    );
    assert.equal(
      (await ha.actions.settings("owner")).blocked,
      true,
      "an unresolved receipt must not be silently dropped by a refused delete",
    );
  } finally {
    await ha.actions.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a session with a running durable task cannot be deleted until it finishes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-delete-task-"));
  const { faux, models, model } = offline();
  const runtime = await Runtime.open(dir, models, model);
  try {
    const id = await runtime.create("owner", "Busy", "delete-task-create");
    const started = latch();
    let release!: () => void;
    const blocking = new Promise<void>((r) => {
      release = r;
    });
    faux.setResponses([
      async () => {
        started.resolve();
        await blocking;
        return fauxAssistantMessage("Done");
      },
    ]);
    const sub = await runtime.submit("owner", id, "delete-task-request", "Go");
    await started.promise;
    await assert.rejects(runtime.delete("owner", id), /delete_task_running/);
    release();
    await (await runtime.harness.submission(sub as SubmissionId, ctx))!.wait(
      ctx,
    );
    // Once the task has finished the session is deletable again.
    await runtime.delete("owner", id);
    assert.equal((await runtime.list("owner")).length, 0);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a session with an admitted input that is not yet placed/answered cannot be deleted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-delete-input-"));
  const { models, model } = offline();
  const runtime = await Runtime.open(dir, models, model);
  try {
    const id = await runtime.create("owner", "Pending", "delete-input-create");
    // Simulate the narrow durable window between admitting an input and
    // placing it with the harness (hearth.inputs commits before the matching
    // conversation.submit()); deletion must refuse to skip over it.
    await runtime.harness.commit(async (tx) => {
      (await tx.doc(Inputs, id as ConversationId)).requests[
        "synthetic-unplaced"
      ] = {
        hash: "synthetic",
        content: "synthetic",
        submissionId: 0,
        admitted: Date.now(),
      };
    }, ctx);
    await assert.rejects(runtime.delete("owner", id), /delete_session_busy/);
    assert((await runtime.list("owner")).some((s) => s.id === id));
    await runtime.harness.commit(async (tx) => {
      delete (await tx.doc(Inputs, id as ConversationId)).requests[
        "synthetic-unplaced"
      ];
    }, ctx);
    await runtime.delete("owner", id);
    assert.equal((await runtime.list("owner")).length, 0);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a coding workspace session blocked by an uncertain outcome cannot be deleted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-delete-workspace-"));
  const { faux, models, model } = offline();
  const extension = defineExtension({ name: "synthetic-code" });
  const runtime = await Runtime.open(dir, models, model, [extension], [], {
    home: [],
    workspace: [extension],
  });
  try {
    const id = await runtime.create(
      "owner",
      "Code",
      "delete-workspace-create",
      "workspace",
    );
    faux.setResponses([fauxAssistantMessage("Done")]);
    await runtime.submit("owner", id, "delete-workspace-input", "Inspect");
    await runtime.harness.waitForIdle(ctx);
    await runtime.harness.commit(async (tx) => {
      (await tx.doc(WorkspaceGuard, id as ConversationId)).blockedEpoch = 1;
    }, ctx);
    await assert.rejects(
      runtime.delete("owner", id),
      /delete_workspace_blocked/,
    );
    assert((await runtime.list("owner")).some((s) => s.id === id));
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting a session at the per-owner cap frees a slot for a new one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-delete-limit-"));
  const { models, model } = offline();
  const runtime = await Runtime.open(dir, models, model);
  try {
    let first = 0;
    for (let i = 0; i < 30; i++) {
      const id = await runtime.create(
        "owner",
        `Session ${i}`,
        `delete-limit-create-${i}`,
      );
      if (i === 0) first = id;
    }
    await assert.rejects(
      runtime.create("owner", "Overflow", "delete-limit-overflow"),
      /session_limit/,
    );
    await runtime.delete("owner", first);
    assert.equal((await runtime.list("owner")).length, 29);
    const created = await runtime.create(
      "owner",
      "Overflow",
      "delete-limit-overflow",
    );
    assert.equal((await runtime.list("owner")).length, 30);
    assert.notEqual(created, first);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete UI control calls the API only after an explicit window.confirm", async () => {
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
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let sessionDeleted = false;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://hearth.example/app/"),
  });
  // linkedom's <select> exposes only a value getter; real browsers also have
  // a setter. Shim it so app.js's strict-mode assignments do not throw.
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
        requests.push({
          method,
          path,
          body: options?.body ? JSON.parse(String(options.body)) : undefined,
        });
        if (path.endsWith("/bootstrap"))
          return Response.json({
            csrf: "synthetic",
            provider: "offline",
            inferenceReady: true,
            homePermissions: null,
          });
        if (path.endsWith("/models")) return Response.json({ items: [] });
        if (path.endsWith("/sessions"))
          return Response.json({
            items: sessionDeleted
              ? []
              : [
                  {
                    id: 7,
                    owner: "owner",
                    title: "Kitchen planning",
                    kind: "home",
                  },
                ],
          });
        if (path.endsWith("/sessions/7/snapshot"))
          return Response.json({
            modelSelection: null,
            homePermissions: null,
            homeCanvas: null,
            proposals: {},
            lastInput: null,
            view: { entries: [], docs: {} },
          });
        if (path.endsWith("/sessions/7/delete")) {
          sessionDeleted = true;
          return Response.json({ deleted: true });
        }
        throw new Error(`Unexpected route ${path}`);
      },
    });
    await import(
      new URL(`../public/app.js?delete-ui-${Date.now()}`, import.meta.url).href
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      document.getElementById("title")!.textContent,
      "Kitchen planning",
    );
    const button = document.getElementById(
      "delete-session",
    ) as HTMLButtonElement;
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute("aria-label"), "Delete session");
    window.confirm = () => false;
    button.dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert(!requests.some((r) => r.path.endsWith("/delete")));
    assert.equal(
      document.getElementById("title")!.textContent,
      "Kitchen planning",
    );
    window.confirm = () => true;
    button.dispatchEvent(new window.Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const deleteCalls = requests.filter((r) =>
      r.path.endsWith("/sessions/7/delete"),
    );
    assert.equal(deleteCalls.length, 1);
    assert.equal(deleteCalls[0]!.method, "POST");
    assert.deepEqual(deleteCalls[0]!.body, { confirm: true });
    assert.equal(
      document.getElementById("title")!.textContent,
      "A little warmth. A little more certainty.",
    );
    assert.match(
      document.getElementById("feedback")!.textContent!,
      /not securely erased/,
    );
  } finally {
    Object.assign(globalThis, previous);
  }
});
