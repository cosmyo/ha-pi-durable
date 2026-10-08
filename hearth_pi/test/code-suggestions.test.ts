// L3 "code-level improvement" flow (product-brief.md 4.1/4.4): the
// controller-side tool-failure signal, suggest_code_change's strict
// validation against real counters, the security-review label and typed
// confirmation, "Draft in Code session" (existing Code session machinery,
// no self-apply) and the workspace-disabled path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  UserEntry,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.js";
import { HAClient, haExtension } from "../src/ha.js";
import { WorkspaceClient, workspaceExtension } from "../src/workspace.js";
import { ownerKey } from "../src/memory.js";
import {
  SUGGESTION_LIMITS,
  SuggestionStore,
  ToolFailureLog,
  suggestionTools,
  toolFailureCount,
} from "../src/suggestions.js";
import { offline } from "./fixtures.js";
import { call, fakeHA } from "./app-fixtures.js";

// Builds a runtime wired exactly like main.ts: Home tools in one group, an
// (optional) separate Code/workspace group. Omitting `workspace` leaves it
// empty, i.e. workspace_enabled: false.
async function open(
  dir: string,
  ha: HAClient,
  clock: { now: number },
  options: { workspace?: boolean } = {},
) {
  const provider = offline();
  const home = [haExtension(ha, { now: () => clock.now })];
  const client = new WorkspaceClient(
    "/synthetic-not-connected",
    "a".repeat(64),
  );
  const workspaceExt = workspaceExtension(client);
  const workspace = options.workspace ? [workspaceExt] : [];
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [...home, ...workspace],
    [],
    { home, workspace },
    ha.actions,
  );
  return {
    runtime,
    provider,
    suggestions: new SuggestionStore(runtime, ha, () => clock.now),
  };
}
// One repeated tool failure: a faux tool call that the real Home tool
// rejects deterministically, so the same (tool, errorCode) pair repeats.
async function triggerFailure(
  runtime: Runtime,
  faux: ReturnType<typeof offline>["faux"],
  owner: string,
  id: number,
  key: string,
  tool: string,
  args: unknown,
) {
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(tool, args as Parameters<typeof fauxToolCall>[1]),
      {
        stopReason: "toolUse",
      },
    ),
    fauxAssistantMessage("Noted."),
  ]);
  const submission = await runtime.submit(owner, id, key, "Please check.");
  await (await runtime.harness.submission(
    submission as SubmissionId,
    ctx,
  ))!.wait(ctx);
}

test("tool-failure counters: bounded per owner, 7-day window, reach the 5x threshold", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-code-counter-"));
  const f = fakeHA();
  const clock = { now: Date.now() };
  const { runtime, provider } = await open(dir, f.ha, clock);
  try {
    const id = await runtime.create("owner", "Chat", "code-counter-create-1");
    for (let i = 0; i < 4; i++)
      await triggerFailure(
        runtime,
        provider.faux,
        "owner",
        id,
        `failkey-${i}`,
        "ha_state_detail",
        { entityId: "sensor.not_in_scope" },
      );
    let log = await runtime.harness.snapshot(
      ToolFailureLog,
      ownerKey("owner"),
      ctx,
    );
    assert.equal(
      toolFailureCount(log, "ha_state_detail", "entity_not_allowed", clock.now),
      4,
      "below threshold after 4 failures",
    );
    // A different tool/errorCode pair is counted separately.
    await triggerFailure(
      runtime,
      provider.faux,
      "owner",
      id,
      "fail-other-tool",
      "ha_propose_service",
      { service: "climate.set_temperature", entityId: "light.hall", data: {} },
    );
    log = await runtime.harness.snapshot(
      ToolFailureLog,
      ownerKey("owner"),
      ctx,
    );
    assert.equal(
      toolFailureCount(log, "ha_state_detail", "entity_not_allowed", clock.now),
      4,
    );
    assert.equal(
      toolFailureCount(
        log,
        "ha_propose_service",
        "service_not_allowed",
        clock.now,
      ) > 0,
      true,
      "a distinct tool/errorCode pair is its own counter",
    );
    // The 5th matching failure crosses the threshold.
    await triggerFailure(
      runtime,
      provider.faux,
      "owner",
      id,
      "fail-key-4",
      "ha_state_detail",
      { entityId: "sensor.not_in_scope" },
    );
    log = await runtime.harness.snapshot(
      ToolFailureLog,
      ownerKey("owner"),
      ctx,
    );
    assert.equal(
      toolFailureCount(log, "ha_state_detail", "entity_not_allowed", clock.now),
      5,
    );
    // Outside the 7-day window the same failures no longer count.
    assert.equal(
      toolFailureCount(
        log,
        "ha_state_detail",
        "entity_not_allowed",
        clock.now + SUGGESTION_LIMITS.codeWindowMs + 1,
      ),
      0,
    );
    // A second owner's failures never mix into this owner's counters.
    const otherLog = await runtime.harness.snapshot(
      ToolFailureLog,
      ownerKey("other"),
      ctx,
    );
    assert.equal(
      toolFailureCount(
        otherLog,
        "ha_state_detail",
        "entity_not_allowed",
        clock.now,
      ),
      0,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("suggest_code_change validates evidence against real counters, forbids code text, and never applies anything", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-code-change-"));
  const f = fakeHA();
  const clock = { now: Date.now() };
  const { runtime, provider, suggestions } = await open(dir, f.ha, clock);
  try {
    const id = await runtime.create("owner", "Chat", "code-change-create-1");
    for (let i = 0; i < 5; i++)
      await triggerFailure(
        runtime,
        provider.faux,
        "owner",
        id,
        `cc-fail-${i}`,
        "ha_state_detail",
        { entityId: "sensor.not_in_scope" },
      );
    const draft = {
      title: "Sensor reads keep failing",
      problem: "ha_state_detail keeps refusing a sensor the owner expects.",
      proposal: "Add a clearer refusal message naming the missing entity.",
      evidence: {
        tool: "ha_state_detail",
        errorCode: "entity_not_allowed",
        count: 5,
      },
    };
    // Too small a recorded count: refused, nothing filed.
    const tooFew = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "suggest_code_change",
      { ...draft, evidence: { ...draft.evidence, count: 6 } },
      "cc-input-overcount",
    );
    assert.equal(tooFew.ok, false);
    assert.equal(tooFew.error, "insufficient_evidence");
    // A tool/errorCode pair that never actually failed 5 times: refused.
    const neverFailed = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "suggest_code_change",
      {
        ...draft,
        evidence: {
          tool: "ha_state_detail",
          errorCode: "some_other_code",
          count: 1,
        },
      },
      "cc-input-unseen",
    );
    assert.equal(neverFailed.ok, false);
    assert.equal(neverFailed.error, "insufficient_evidence");
    // Invalid evidence shape (uppercase is not an exact recorded tool name).
    const badShape = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "suggest_code_change",
      { ...draft, evidence: { ...draft.evidence, tool: "HA_STATE_DETAIL" } },
      "cc-input-badshape",
    );
    assert.equal(badShape.ok, false);
    assert.equal(badShape.error, "invalid_evidence");
    // No code, diff or patch text is accepted, even with valid evidence.
    const withCode = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "suggest_code_change",
      { ...draft, proposal: "```js\nfunction fix() { return 1; }\n```" },
      "cc-input-code",
    );
    assert.equal(withCode.ok, false);
    assert.equal(withCode.error, "code_text_not_allowed");
    // A genuine, matching, plain-prose suggestion is filed (never applied).
    const filed = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "suggest_code_change",
      draft,
      "cc-input-ok",
    );
    assert.equal(filed.ok, true, JSON.stringify(filed));
    assert.equal(filed.status, "pending");
    const listed = await suggestions.list("owner");
    assert.equal(listed.items.length, 1);
    const s = listed.items[0]!;
    assert.equal(s.kind, "code");
    assert.equal(s.status, "pending");
    assert.equal(s.code!.evidence.tool, "ha_state_detail");
    assert.equal(s.code!.evidence.errorCode, "entity_not_allowed");
    assert.equal(s.code!.evidence.count, 5);
    assert.equal(s.code!.securitySensitive, false);
    // Filing the same tool/errorCode pair again is refused as a duplicate.
    const again = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "suggest_code_change",
      draft,
      "cc-input-dup",
    );
    assert.equal(again.ok, false);
    assert.equal(again.error, "already_suggested");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("suggest_code_change is absent from Code (workspace) sessions; Home tool parameters carry no code/patch field", async () => {
  const f = fakeHA();
  const names = suggestionTools(f.ha).map((t) => t.name);
  assert.deepEqual(names, [
    "suggest_memory",
    "suggest_app_change",
    "suggest_code_change",
  ]);
  const client = new WorkspaceClient(
    "/synthetic-not-connected",
    "a".repeat(64),
  );
  const workspaceToolNames = workspaceExtension(client).tools!.map(
    (t) => t.name,
  );
  assert.equal(
    workspaceToolNames.some((n) => n.startsWith("suggest_")),
    false,
    "the Code worker's tools never include a suggestion tool",
  );
  const dir = await mkdtemp(join(tmpdir(), "hearth-code-absent-"));
  const clock = { now: Date.now() };
  const { runtime } = await open(dir, f.ha, clock, { workspace: true });
  try {
    const home = await runtime.create("owner", "Home", "code-absent-home-1");
    const code = await runtime.create(
      "owner",
      "Coding",
      "code-absent-code-1",
      "workspace",
    );
    const homeToolNames = (
      await (await runtime.session("owner", home)).agent(ctx)
    ).tools.map((t) => t.name);
    const codeToolNames = (
      await (await runtime.session("owner", code)).agent(ctx)
    ).tools.map((t) => t.name);
    assert(homeToolNames.includes("suggest_code_change"));
    assert.equal(codeToolNames.includes("suggest_code_change"), false);
    assert.equal(
      codeToolNames.some((n) => n.startsWith("suggest_")),
      false,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("security-review label and server-side typed confirmation; Draft in Code session seeds the fixed template; no accept/one-tap path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-code-draft-"));
  const f = fakeHA();
  const clock = { now: Date.now() };
  const { runtime, provider, suggestions } = await open(dir, f.ha, clock, {
    workspace: true,
  });
  try {
    const id = await runtime.create("owner", "Chat", "code-draft-create-1");
    for (let i = 0; i < 5; i++)
      await triggerFailure(
        runtime,
        provider.faux,
        "owner",
        id,
        `plain-fail-${i}`,
        "ha_state_detail",
        { entityId: "sensor.not_in_scope" },
      );
    for (let i = 0; i < 5; i++)
      await triggerFailure(
        runtime,
        provider.faux,
        "owner",
        id,
        `sens-fail-${i}`,
        "ha_propose_service",
        {
          service: "climate.set_temperature",
          entityId: "light.hall",
          data: {},
        },
      );
    const plain = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "suggest_code_change",
      {
        title: "Sensor reads keep failing",
        problem: "ha_state_detail keeps refusing a sensor the owner expects.",
        proposal: "Add a clearer refusal message naming the missing entry.",
        evidence: {
          tool: "ha_state_detail",
          errorCode: "entity_not_allowed",
          count: 5,
        },
      },
      "plain-input-ok",
    );
    assert.equal(plain.ok, true, JSON.stringify(plain));
    const sensitive = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "suggest_code_change",
      {
        title: "Service proposals are rejected",
        problem:
          "Proposing a climate service keeps failing the service scope approval check.",
        proposal: "Explain the allowed-service scope in the refusal message.",
        evidence: {
          tool: "ha_propose_service",
          errorCode: "service_not_allowed",
          count: 5,
        },
      },
      "sens-input-ok",
    );
    assert.equal(sensitive.ok, true, JSON.stringify(sensitive));
    let listed = await suggestions.list("owner");
    const plainS = listed.items.find((s) => s.id === plain.suggestionId)!;
    const sensS = listed.items.find((s) => s.id === sensitive.suggestionId)!;
    assert.equal(plainS.code!.securitySensitive, false);
    assert.equal(sensS.code!.securitySensitive, true);
    // accept() (the one-tap path) never applies a code suggestion.
    await assert.rejects(
      suggestions.accept("owner", { id: plainS.id, hash: plainS.hash }),
      /not_app_change_suggestion/,
    );
    // Security-sensitive: no one-tap draft without the typed confirmation.
    await assert.rejects(
      suggestions.draft("owner", {
        id: sensS.id,
        hash: sensS.hash,
        title: "Fix",
        requestId: "draft-request-noconfirm-1",
      }),
      /confirmation_required/,
    );
    await assert.rejects(
      suggestions.draft("owner", {
        id: sensS.id,
        hash: sensS.hash,
        confirm: "not it",
        title: "Fix",
        requestId: "draft-request-badconfirm-1",
      }),
      /confirmation_required/,
    );
    // Not security-sensitive: drafts directly, no confirmation required.
    const drafted = await suggestions.draft("owner", {
      id: plainS.id,
      hash: plainS.hash,
      title: "Fix sensor reads",
      requestId: "draft-request-plain-1",
    });
    assert.equal(drafted.ok, true);
    assert.equal(typeof drafted.sessionId, "number");
    // The suggestion itself is closed; no further one-tap action is offered.
    listed = await suggestions.list("owner");
    assert.equal(
      listed.items.some((s) => s.id === plainS.id),
      false,
    );
    // A new, separate Code session now exists, seeded with the fixed
    // template: problem/proposal/evidence marked as untrusted data, asking
    // for a patch, a unit test and a PATCH SUMMARY. Hearth itself never
    // writes or applies anything from this call.
    const sessions = await runtime.list("owner");
    const codeSession = sessions.find((s) => s.id === drafted.sessionId)!;
    assert.equal(codeSession.kind, "workspace");
    const entries = (
      await (await runtime.session("owner", drafted.sessionId)).context(ctx)
    ).entries;
    const brief = entries.find((e) => UserEntry.is(e));
    const text = JSON.stringify(brief);
    assert.match(text, /UNTRUSTED DATA/);
    assert.match(text, /Sensor reads keep failing/);
    assert.match(text, /ha_state_detail/);
    assert.match(text, /entity_not_allowed/);
    assert.match(text, /5 time/);
    assert.match(text, /PATCH SUMMARY/);
    assert.doesNotMatch(text, /```/);
    // Drafting again (already decided) is refused.
    await assert.rejects(
      suggestions.draft("owner", {
        id: plainS.id,
        hash: plainS.hash,
        title: "Fix",
        requestId: "draft-request-plain-2",
      }),
      /suggestion_already_decided/,
    );
    // Now drafting the security-sensitive one, correctly confirmed.
    const draftedSensitive = await suggestions.draft("owner", {
      id: sensS.id,
      hash: sensS.hash,
      confirm: "CONFIRM",
      title: "Fix service proposals",
      requestId: "draft-request-sens-1",
    });
    assert.equal(draftedSensitive.ok, true);
    assert.notEqual(draftedSensitive.sessionId, drafted.sessionId);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Draft in Code session is refused when Code sessions (workspace_enabled) are off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-code-disabled-"));
  const f = fakeHA();
  const clock = { now: Date.now() };
  const { runtime, provider, suggestions } = await open(dir, f.ha, clock, {
    workspace: false,
  });
  try {
    const id = await runtime.create("owner", "Chat", "code-disabled-create-1");
    for (let i = 0; i < 5; i++)
      await triggerFailure(
        runtime,
        provider.faux,
        "owner",
        id,
        `off-fail-${i}`,
        "ha_state_detail",
        { entityId: "sensor.not_in_scope" },
      );
    const filed = await call(
      runtime,
      provider.faux,
      "owner",
      id,
      "suggest_code_change",
      {
        title: "Sensor reads keep failing",
        problem: "ha_state_detail keeps refusing a sensor.",
        proposal: "Improve the refusal message.",
        evidence: {
          tool: "ha_state_detail",
          errorCode: "entity_not_allowed",
          count: 5,
        },
      },
      "off-input-ok",
    );
    assert.equal(filed.ok, true, JSON.stringify(filed));
    const listed = await suggestions.list("owner");
    const s = listed.items[0]!;
    await assert.rejects(
      suggestions.draft("owner", {
        id: s.id,
        hash: s.hash,
        title: "Fix",
        requestId: "draft-request-off-1",
      }),
      /workspace_not_enabled/,
    );
    // Nothing was created or decided: the suggestion is still pending.
    const stillListed = await suggestions.list("owner");
    assert.equal(stillListed.items[0]!.status, "pending");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("static: no self-apply path exists for a code suggestion", async () => {
  const source = await readFile(
    new URL("../src/suggestions.ts", import.meta.url),
    "utf8",
  );
  // The whole L3 flow only ever creates/submits to a Code session or files a
  // suggestion document; it never touches the host filesystem or a process.
  assert.doesNotMatch(source, /node:fs|node:child_process/);
  assert.doesNotMatch(source, /\bexecSync\(|\bspawn\(|\bexec\(/);
  assert.doesNotMatch(source, /writeFile|readFile\(/);
  assert.doesNotMatch(source, /\bgit\s+(commit|push|clone)/);
  assert.doesNotMatch(source, /npm\s+(publish|install)/);
  // draft() has exactly one effect besides the suggestion document itself:
  // creating and submitting to a brand-new Code session.
  const draftBody = source.slice(
    source.indexOf("async draft(owner"),
    source.indexOf("\n}", source.indexOf("async draft(owner")),
  );
  assert.match(draftBody, /this\.runtime\.create\(/);
  assert.match(draftBody, /this\.runtime\.submit\(/);
});
