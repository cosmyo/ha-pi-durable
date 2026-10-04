import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  WorkspaceClient,
  workspaceExtension,
  WorkspaceGuard,
} from "../src/workspace.js";
import { serveWorker, verifyWorkerIsolation } from "../src/worker.js";
import { Runtime } from "../src/runtime.js";
import { offline } from "./fixtures.js";
import type { ConversationId } from "@earendil-works/pi-durable";

test("genuine Pi write/read/edit/bash tools work over authenticated bounded worker IPC", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-workspace-"));
  const key = "a".repeat(64),
    path = join(dir, "worker.sock");
  const server = await serveWorker(path, key, dir);
  try {
    const client = new WorkspaceClient(path, key);
    assert.equal(
      (
        await client.call("write", {
          path: "sum.js",
          content: "console.log(2 + 2);\n",
        })
      ).isError,
      false,
    );
    assert.match(
      JSON.stringify(await client.call("read", { path: "sum.js" })),
      /2 \+ 2/,
    );
    assert.equal(
      (
        await client.call("edit", {
          path: "sum.js",
          edits: [{ oldText: "2 + 2", newText: "3 + 4" }],
        })
      ).isError,
      false,
    );
    assert.match(
      JSON.stringify(
        await client.call("bash", { command: "node sum.js", timeout: 5 }),
      ),
      /7/,
    );
    assert.equal(
      await readFile(join(dir, "sum.js"), "utf8"),
      "console.log(3 + 4);\n",
    );
    await assert.rejects(
      new WorkspaceClient(path, "b".repeat(64)).call("write", {
        path: "bad.txt",
        content: "NO",
      }),
    );
    const extension = workspaceExtension(client);
    assert(extension.tools!.every((tool) => tool.replay === "unsafe"));
    assert.deepEqual(
      extension.tools!.map((tool) => tool.name),
      ["read", "bash", "edit", "write"],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("durable sessions select coding explicitly and block automatic reissue after unknown outcome", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-workspace-runtime-"));
  const { models, model, faux } = offline();
  let calls = 0;
  const client = new WorkspaceClient(
    "/synthetic-not-connected",
    "a".repeat(64),
  );
  client.call = async () => {
    calls++;
    return {
      id: "synthetic",
      isError: true,
      unknown: true,
      content: [{ type: "text", text: "Unknown synthetic operation" }],
    };
  };
  const extension = workspaceExtension(client);
  const runtime = await Runtime.open(dir, models, model, [extension], [], {
    home: [],
    workspace: [extension],
  });
  try {
    const home = await runtime.create("owner", "Home only", "home-request-1");
    assert.equal(
      (await (await runtime.session("owner", home)).agent(ctx)).tools.length,
      0,
    );
    const code = await runtime.create(
      "owner",
      "Coding",
      "code-request-1",
      "workspace",
    );
    assert.equal(
      (await (await runtime.session("owner", code)).agent(ctx)).tools.length,
      4,
    );
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", { path: "test.js", content: "synthetic" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("write", { path: "test.js", content: "synthetic" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Paused until a human reconciles files."),
    ]);
    const submission = await runtime.submit(
      "owner",
      code,
      "code-input-1",
      "Write a synthetic file.",
    );
    await (await runtime.harness.submission(
      submission as import("@earendil-works/pi-durable").SubmissionId,
      ctx,
    ))!.wait(ctx);
    assert.equal(calls, 1);
    assert.equal(
      (
        await runtime.harness.snapshot(
          WorkspaceGuard,
          code as ConversationId,
          ctx,
        )
      )?.blockedEpoch,
      1,
    );
    assert.match(
      JSON.stringify(await runtime.snapshot("owner", code)),
      /fresh HUMAN input/,
    );
    await assert.rejects(
      runtime.create("owner", "Coding", "code-request-1", "home"),
      /idempotency_conflict/,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-zero real Pi bash exit with partial mutation blocks same-turn reissue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-failed-bash-")),
    files = join(dir, "files");
  await mkdir(files);
  const key = "a".repeat(64),
    socket = join(dir, "worker.sock");
  const server = await serveWorker(socket, key, files),
    client = new WorkspaceClient(socket, key);
  let calls = 0;
  const original = client.call.bind(client);
  client.call = (...args) => {
    calls++;
    return original(...args);
  };
  const { models, model, faux } = offline(),
    extension = workspaceExtension(client);
  const runtime = await Runtime.open(
    join(dir, "controller"),
    models,
    model,
    [extension],
    [],
    { home: [], workspace: [extension] },
  );
  try {
    const id = await runtime.create(
      "owner",
      "Partial failure",
      "partial-create-1",
      "workspace",
    );
    const command = "printf 'attempt\\n' >> attempts.txt; exit 1";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command, timeout: 5 }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("bash", { command, timeout: 5 }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Await fresh human input."),
    ]);
    const sub = await runtime.submit(
      "owner",
      id,
      "partial-input-1",
      "Run a synthetic partial-failure fixture.",
    );
    await (await runtime.harness.submission(
      sub as import("@earendil-works/pi-durable").SubmissionId,
      ctx,
    ))!.wait(ctx);
    assert.equal(calls, 1);
    assert.equal(
      await readFile(join(files, "attempts.txt"), "utf8"),
      "attempt\n",
    );
    assert.equal(
      (
        await runtime.harness.snapshot(
          WorkspaceGuard,
          id as ConversationId,
          ctx,
        )
      )?.blockedEpoch,
      1,
    );
  } finally {
    await runtime.close();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker production startup refuses an unconfined host process", async () => {
  await assert.rejects(verifyWorkerIsolation());
});
