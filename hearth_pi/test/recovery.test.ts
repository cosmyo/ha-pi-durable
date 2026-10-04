import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.js";
import { HAClient, haExtension, Actions } from "../src/ha.js";
import { Inputs, Proposals } from "../src/documents.js";
import { offline } from "./fixtures.js";
import {
  WorkspaceClient,
  workspaceExtension,
  WorkspaceGuard,
} from "../src/workspace.js";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

for (const mode of ["canvas-before", "canvas-after"])
  test(`SIGKILL ${mode}: genuine Home canvas recovery repeats only uncommitted safe reads`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `hearth-kill-${mode}-`));
    await dieAt(
      dir,
      mode,
      mode === "canvas-before" ? "canvas-reading" : "canvas-committed",
      "./canvas-crash-child.ts",
    );
    const { faux, models, model } = offline();
    faux.setResponses([
      fauxAssistantMessage(
        "Recovered the saved Home view; readings are observations.",
      ),
    ]);
    let reads = 0;
    const ha = new HAClient(
      "synthetic-recovery-token",
      { enabled: false, services: [], entities: ["light.example"] },
      (async (_url, init) => {
        assert.equal(init?.method, "GET");
        reads++;
        return Response.json({
          entity_id: "light.example",
          state: "off",
          attributes: {},
        });
      }) as typeof fetch,
    );
    const runtime = await Runtime.open(dir, models, model, [haExtension(ha)]);
    try {
      const id = (await runtime.list("owner"))[0]!.id;
      const input = (await runtime.harness.snapshot(
        Inputs,
        id as ConversationId,
        ctx,
      ))!.requests["canvas-crash-request"]!;
      assert.equal(
        (
          await (await runtime.harness.submission(
            input.submissionId as SubmissionId,
            ctx,
          ))!.wait(ctx)
        ).status,
        "done",
      );
      assert.equal(reads, mode === "canvas-before" ? 1 : 0);
      const canvas = (await runtime.snapshot("owner", id, ha.policy.entities))
        .homeCanvas!;
      assert.equal(canvas.title, "Saved view");
      assert.equal(canvas.sections[0]!.readings[0]!.state, "off");
      assert(canvas.committedAt > 0);
      assert.equal(
        await runtime.submit(
          "owner",
          id,
          "canvas-crash-request",
          "Synthetic canvas input",
        ),
        input.submissionId,
      );
      assert.equal(faux.state.callCount, 1);
      assert.equal(
        (
          JSON.stringify(await runtime.snapshot("owner", id)).match(
            /"kind":"pi.user"/g,
          ) ?? []
        ).length,
        1,
      );
    } finally {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

async function dieAt(
  dir: string,
  mode: string,
  stage: string,
  fixture = "./crash-child.ts",
) {
  const child = fork(
    fileURLToPath(new URL(fixture, import.meta.url)),
    [mode, dir],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`child_timeout:${mode}:${stderr.slice(0, 300)}`)),
        10000,
      );
      child.on("message", (message) => {
        if ((message as { stage: string }).stage === stage) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`child_exit:${code}:${stderr.slice(0, 300)}`));
      });
    });
  } finally {
    const exit = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGKILL");
    await exit;
  }
}
test("SIGKILL during coding: no worker replay and no model-driven reissue without new human input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-kill-code-"));
  await dieAt(
    dir,
    "workspace",
    "workspace-writing",
    "./workspace-crash-child.ts",
  );
  const { models, model, faux } = offline();
  let calls = 0;
  const client = new WorkspaceClient("/synthetic-unconnected", "a".repeat(64));
  client.call = async () => {
    calls++;
    return { id: "synthetic", content: [], isError: false, unknown: false };
  };
  const extension = workspaceExtension(client);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "synthetic.txt", content: "synthetic" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Await fresh human instruction; no repeat."),
  ]);
  const runtime = await Runtime.open(dir, models, model, [extension], [], {
    home: [],
    workspace: [extension],
  });
  try {
    const id = (await runtime.list("owner"))[0]!.id;
    const input = (await runtime.harness.snapshot(
      Inputs,
      id as ConversationId,
      ctx,
    ))!.requests["workspace-input-1"]!;
    await (await runtime.harness.submission(
      input.submissionId as SubmissionId,
      ctx,
    ))!.wait(ctx);
    assert.equal(calls, 0);
    assert.equal(
      await readFile(join(dir, "workspace-attempts.txt"), "utf8"),
      "write attempted\n",
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
    assert.match(
      JSON.stringify(await runtime.snapshot("owner", id)),
      /interrupted|fresh HUMAN/,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
for (const mode of ["model", "read"])
  test(`SIGKILL: unfinished ${mode} task really resumes with admitted input deduplication`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `hearth-kill-${mode}-`));
    await dieAt(dir, mode, mode === "model" ? "generating" : "reading");
    const { faux, models, model } = offline();
    faux.setResponses([fauxAssistantMessage("Recovered committed input")]);
    let reads = 0;
    const ha = new HAClient(
      "synthetic-recovery-token",
      {
        enabled: true,
        services: ["light.turn_on"],
        entities: ["light.example"],
      },
      (async () => {
        reads++;
        return Response.json({
          entity_id: "light.example",
          state: "off",
          attributes: {},
        });
      }) as typeof fetch,
    );
    const runtime = await Runtime.open(dir, models, model, [haExtension(ha)]);
    try {
      const id = (await runtime.list("owner"))[0]!.id;
      const input = (await runtime.harness.snapshot(
        Inputs,
        id as ConversationId,
        ctx,
      ))!.requests["request-crash-1"]!;
      assert(input.submissionId > 0);
      assert.equal(
        (
          await (await runtime.harness.submission(
            input.submissionId as SubmissionId,
            ctx,
          ))!.wait(ctx)
        ).status,
        "done",
      );
      assert.equal(
        await runtime.submit(
          "owner",
          id,
          "request-crash-1",
          "Synthetic crash input",
        ),
        input.submissionId,
      );
      const snapshot = JSON.stringify(await runtime.snapshot("owner", id));
      assert.match(snapshot, /Recovered committed input/);
      assert.equal((snapshot.match(/"kind":"pi.user"/g) ?? []).length, 1);
      assert.equal(faux.state.callCount, 1);
      assert.equal(reads, mode === "read" ? 1 : 0);
    } finally {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
test("SIGKILL after persisted dispatch intent: external write is unknown and never replayed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-kill-write-"));
  await dieAt(dir, "write", "dispatched");
  const { models, model } = offline();
  let posts = 0;
  const ha = new HAClient(
    "synthetic-recovery-token",
    { enabled: true, services: ["light.turn_on"], entities: ["light.example"] },
    (async (_url, init) => {
      if (init?.method === "POST") posts++;
      return Response.json([]);
    }) as typeof fetch,
  );
  const runtime = await Runtime.open(dir, models, model, [haExtension(ha)]);
  try {
    const id = (await runtime.list("owner"))[0]!.id;
    const p = Object.values(
      (await runtime.harness.snapshot(Proposals, id as ConversationId, ctx))!
        .items,
    )[0]!;
    assert.equal(p.status, "unknown");
    assert.equal(posts, 0);
    assert.equal(await readFile(join(dir, "posts.txt"), "utf8"), "attempt\n");
    const actions = new Actions(runtime, ha);
    await assert.rejects(
      actions.decide("owner", id, p.id, p.hash, "approve"),
      /already_decided/,
    );
    await actions.decide(
      "owner",
      id,
      p.id,
      p.hash,
      "resolve",
      "Human reconciliation only.",
    );
    assert.equal(posts, 0);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
