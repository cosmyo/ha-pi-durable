import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { offline } from "./fixtures.js";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.js";
import { Inputs } from "../src/documents.js";

test("real SQLite FULL harness admits, deduplicates, persists catalog and hydrates after reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-runtime-"));
  const { faux, models, model } = offline();
  let runtime = await Runtime.open(dir, models, model);
  try {
    faux.setResponses([fauxAssistantMessage("Original offline answer")]);
    const id = await runtime.create("owner", "Kitchen planning", "create-0001");
    assert.equal(
      await runtime.create("owner", "Kitchen planning", "create-0001"),
      id,
    );
    const submission = await runtime.submit(
      "owner",
      id,
      "request-0001",
      "Hello",
    );
    assert.equal(
      await runtime.submit("owner", id, "request-0001", "Hello"),
      submission,
    );
    await assert.rejects(
      runtime.submit("owner", id, "request-0001", "Changed"),
      /idempotency_conflict/,
    );
    const receipt = await runtime.harness.submission(
      submission as SubmissionId,
      ctx,
    );
    assert.equal((await receipt!.wait(ctx)).status, "done");
    assert.equal(faux.state.callCount, 1);
    await assert.rejects(Runtime.open(dir, models, model), /locked/);
    await runtime.close();
    runtime = await Runtime.open(dir, models, model);
    assert.equal((await runtime.list("owner"))[0]!.id, id);
    assert.equal(
      await runtime.submit("owner", id, "request-0001", "Hello"),
      submission,
    );
    assert.match(
      JSON.stringify(await runtime.snapshot("owner", id)),
      /Original offline answer/,
    );
    await assert.rejects(runtime.snapshot("other", id), /session_not_found/);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("configured secrets are redacted before durable input/catalog admission and rejected in request IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-input-secrets-"));
  const { faux, models, model } = offline();
  const secret = "synthetic-private-provider-token";
  const runtime = await Runtime.open(dir, models, model, [], [secret]);
  try {
    faux.setResponses([fauxAssistantMessage("Safe offline answer")]);
    await assert.rejects(
      runtime.create("owner", "Notes", secret),
      /credentials_in_request_id/,
    );
    const id = await runtime.create(
      "owner",
      `${secret} notes`,
      "create-secret-1",
    );
    await assert.rejects(
      runtime.submit("owner", id, secret, "Hello"),
      /credentials_in_request_id/,
    );
    const sid = await runtime.submit(
      "owner",
      id,
      "request-secret-1",
      `Please explain ${secret}`,
    );
    await (await runtime.harness.submission(sid as SubmissionId, ctx))!.wait(
      ctx,
    );
    const conversation = await runtime.session("owner", id);
    const persisted = JSON.stringify({
      catalog: await runtime.list("owner"),
      inputs: await runtime.harness.snapshot(Inputs, conversation.id, ctx),
      transcript: await conversation.context(ctx),
    });
    assert.doesNotMatch(persisted, new RegExp(secret));
    assert.match(persisted, /REDACTED/);
    assert.equal(
      await runtime.submit(
        "owner",
        id,
        "request-secret-1",
        `Please explain ${secret}`,
      ),
      sid,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
