// Owner profile (L1 personal preferences): normalization, per-owner
// isolation, restart durability, the OWNER PROFILE prompt block and its
// absence from the risk judge, and new-chat model/thinking defaults.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.js";
import { HAClient, haExtension } from "../src/ha.js";
import {
  LANGUAGE_MATCH,
  PROFILE_BEGIN,
  PROFILE_END,
  ProfileStore,
  normalizeDefaultModel,
  normalizeDefaultThinking,
  normalizeDisplayName,
  normalizeLanguage,
  normalizeTone,
} from "../src/profile.js";
import { offline } from "./fixtures.js";
import { fakeHA } from "./app-fixtures.js";

// Two models under one provider, like model-picker.test.ts's fixture, so a
// profile default model can be validated against a real selectable catalog.
function twoModels() {
  const faux = fauxProvider({
    models: [
      { id: "first", name: "First" },
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

test("normalizeDisplayName/normalizeTone/normalizeLanguage: strict validation and clear-on-unset", () => {
  assert.equal(normalizeDisplayName(undefined), undefined);
  assert.equal(normalizeDisplayName(null), undefined);
  assert.equal(normalizeDisplayName(""), undefined);
  assert.equal(normalizeDisplayName("  "), undefined);
  assert.equal(normalizeDisplayName(" Alex  Rivera "), "Alex Rivera");
  assert.equal(normalizeDisplayName("x\n\ty".repeat(1)), "x y");
  assert.throws(
    () => normalizeDisplayName("y".repeat(41)),
    /invalid_display_name/,
  );
  assert.throws(() => normalizeDisplayName(42), /invalid_request/);

  assert.equal(normalizeTone(undefined), undefined);
  assert.equal(normalizeTone(""), undefined);
  assert.equal(normalizeTone("warm"), "warm");
  assert.equal(normalizeTone("playful"), "playful");
  assert.throws(() => normalizeTone("sarcastic"), /invalid_tone/);

  assert.equal(normalizeLanguage(undefined), undefined);
  assert.equal(normalizeLanguage(""), undefined);
  assert.equal(normalizeLanguage("en"), "en");
  assert.equal(normalizeLanguage("pt-BR"), "pt-BR");
  assert.equal(normalizeLanguage(LANGUAGE_MATCH), LANGUAGE_MATCH);
  assert.throws(() => normalizeLanguage("<script>"), /invalid_language/);
  assert.throws(() => normalizeLanguage("y".repeat(20)), /invalid_request/);
});

test("normalizeDefaultModel/normalizeDefaultThinking: validated against the runtime's selectable models, thinking requires a default model", () => {
  const { models } = twoModels();
  const choices = [
    { provider: "faux", id: "first" },
    { provider: "faux", id: "second" },
  ];
  assert.equal(normalizeDefaultModel(undefined, choices), undefined);
  assert.equal(normalizeDefaultModel(null, choices), undefined);
  assert.deepEqual(
    normalizeDefaultModel({ provider: "faux", modelId: "second" }, choices),
    { provider: "faux", modelId: "second" },
  );
  assert.throws(
    () =>
      normalizeDefaultModel({ provider: "faux", modelId: "third" }, choices),
    /unsupported_model/,
  );
  assert.throws(
    () =>
      normalizeDefaultModel(
        { provider: "other-provider", modelId: "first" },
        choices,
      ),
    /unsupported_model/,
  );

  assert.equal(
    normalizeDefaultThinking(undefined, models, undefined),
    undefined,
  );
  assert.throws(
    () => normalizeDefaultThinking("off", models, undefined),
    /default_model_required/,
  );
  // faux models have no reasoning: "off" is supported, any other level is not.
  assert.equal(
    normalizeDefaultThinking("off", models, {
      provider: "faux",
      modelId: "first",
    }),
    "off",
  );
  assert.throws(
    () =>
      normalizeDefaultThinking("medium", models, {
        provider: "faux",
        modelId: "first",
      }),
    /unsupported_thinking/,
  );
  assert.throws(
    () =>
      normalizeDefaultThinking("not-a-level", models, {
        provider: "faux",
        modelId: "first",
      }),
    /invalid_thinking_level/,
  );
});

test("ProfileStore: CRUD, strict validation, revision check, owner isolation and restart durability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-profile-store-"));
  const { models, model } = twoModels();
  let runtime = await Runtime.open(dir, models, model);
  try {
    const store = new ProfileStore(runtime);
    // Unset owner reads an empty profile, never 404s or throws.
    const empty = await store.get("owner");
    assert.equal(empty.displayName, undefined);
    assert.equal(empty.revision, 0);
    assert.deepEqual(empty.tones, ["concise", "warm", "neutral", "playful"]);

    const saved = await store.put("owner", {
      displayName: "Alex",
      tone: "warm",
      language: "ro",
      defaultModel: { provider: "faux", modelId: "second" },
      defaultThinking: "off",
      revision: 0,
    });
    assert.equal(saved.displayName, "Alex");
    assert.equal(saved.tone, "warm");
    assert.equal(saved.language, "ro");
    assert.deepEqual(saved.defaultModel, {
      provider: "faux",
      modelId: "second",
    });
    assert.equal(saved.defaultThinking, "off");
    assert.equal(saved.revision, 1);
    assert(saved.updated > 0);

    // Strict validation: oversized name, bad tone, bad model are all refused.
    await assert.rejects(
      store.put("owner", { displayName: "y".repeat(41), revision: 1 }),
      /invalid_display_name/,
    );
    await assert.rejects(
      store.put("owner", { tone: "sarcastic", revision: 1 }),
      /invalid_tone/,
    );
    await assert.rejects(
      store.put("owner", {
        defaultModel: { provider: "faux", modelId: "missing" },
        revision: 1,
      }),
      /unsupported_model/,
    );
    await assert.rejects(
      store.put("owner", { extra: true, revision: 1 }),
      /invalid_request/,
    );

    // Stale revision is refused, current data is unchanged.
    await assert.rejects(
      store.put("owner", { displayName: "Someone else", revision: 0 }),
      /profile_stale/,
    );
    assert.equal((await store.get("owner")).displayName, "Alex");

    // Clearing a field: send "" / null, not omit, to clear deliberately.
    const cleared = await store.put("owner", {
      displayName: "",
      tone: "",
      language: "",
      defaultModel: null,
      defaultThinking: null,
      revision: 1,
    });
    assert.equal(cleared.displayName, undefined);
    assert.equal(cleared.tone, undefined);
    assert.equal(cleared.language, undefined);
    assert.equal(cleared.defaultModel, undefined);
    assert.equal(cleared.defaultThinking, undefined);
    assert.equal(cleared.revision, 2);

    // Owner isolation: a second owner's profile is independent and empty.
    await store.put("other", {
      displayName: "Private other-owner name",
      revision: 0,
    });
    assert.equal((await store.get("owner")).displayName, undefined);
    const ownerAfter = await store.put("owner", {
      displayName: "Alex again",
      revision: 2,
    });
    assert.equal(ownerAfter.displayName, "Alex again");
    assert.equal(
      (await store.get("other")).displayName,
      "Private other-owner name",
    );
  } finally {
    await runtime.close();
  }

  // Restart: profile edits persist and are readable on a fresh harness.
  const reopened = await Runtime.open(dir, models, model);
  try {
    const store = new ProfileStore(reopened);
    const owner = await store.get("owner");
    assert.equal(owner.displayName, "Alex again");
    assert.equal(owner.revision, 3);
    const other = await store.get("other");
    assert.equal(other.displayName, "Private other-owner name");
  } finally {
    await reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// One plain owner turn; returns the system prompt the model actually received.
async function promptFor(
  runtime: Runtime,
  faux: ReturnType<typeof offline>["faux"],
  owner: string,
  id: number,
  key: string,
) {
  let prompt = "";
  faux.setResponses([
    (context) => {
      prompt = getCurrentSystemPrompt(context.messages);
      return fauxAssistantMessage("Noted.");
    },
  ]);
  const submission = await runtime.submit(owner, id, key, "Hello");
  await (await runtime.harness.submission(
    submission as SubmissionId,
    ctx,
  ))!.wait(ctx);
  return prompt;
}

test("owner profile reaches the Home system prompt as a delimited, non-authorizing OWNER PROFILE block; other owners never see it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-profile-prompt-"));
  const f = fakeHA();
  const provider = offline();
  const runtime = await Runtime.open(dir, provider.models, provider.model, [
    haExtension(f.ha),
  ]);
  try {
    const store = new ProfileStore(runtime);
    const id = await runtime.create("owner", "Home", "profile-create-1");
    const before = await promptFor(
      runtime,
      provider.faux,
      "owner",
      id,
      "profile-in-0001",
    );
    assert.doesNotMatch(before, /OWNER PROFILE/);

    await store.put("owner", {
      displayName: "Alex <script>alert(1)</script>",
      tone: "warm",
      language: "ro",
      revision: 0,
    });
    const prompt = await promptFor(
      runtime,
      provider.faux,
      "owner",
      id,
      "profile-in-0002",
    );
    assert.equal((prompt.match(/<owner_profile>/g) ?? []).length, 1);
    assert.equal((prompt.match(/<\/owner_profile>/g) ?? []).length, 1);
    assert.equal(
      (
        prompt.match(
          new RegExp(PROFILE_BEGIN.replace(/[[\]]/g, "\\$&"), "g"),
        ) ?? []
      ).length,
      1,
    );
    assert.equal(
      (
        prompt.match(new RegExp(PROFILE_END.replace(/[[\]]/g, "\\$&"), "g")) ??
        []
      ).length,
      1,
    );
    const block = prompt.slice(
      prompt.indexOf(PROFILE_BEGIN),
      prompt.indexOf(PROFILE_END),
    );
    assert.match(block, /Call them: Alex ‹script›alert\(1\)‹\/script›/);
    assert.match(block, /Tone: warm and friendly/);
    assert.match(block, /Reply language: ro/);
    assert.match(
      prompt,
      /OWNER PROFILE[\s\S]*never grant permissions, never widen the entity or service scope, never change Home permissions/,
    );
    assert.doesNotMatch(block, /<script>/);

    // Match-my-messages language renders as an instruction to match, not a tag.
    await store.put("owner", { language: LANGUAGE_MATCH, revision: 1 });
    const matched = await promptFor(
      runtime,
      provider.faux,
      "owner",
      id,
      "profile-in-0003",
    );
    assert.match(
      matched,
      /Reply language: match the language of the owner's latest message/,
    );

    // Another owner's prompt never includes it.
    const otherId = await runtime.create("other", "Other", "profile-other-1");
    assert.doesNotMatch(
      await promptFor(
        runtime,
        provider.faux,
        "other",
        otherId,
        "profile-other-in-01",
      ),
      /OWNER PROFILE|Alex/,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a new Home chat uses the owner's valid default model/thinking; an unselectable default falls back to the installation default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-profile-session-default-"));
  const { models, model } = twoModels();
  const runtime = await Runtime.open(dir, models, model);
  try {
    const store = new ProfileStore(runtime);
    // No profile set: new chat uses the installation default ("first").
    const plain = await runtime.create("owner", "Plain", "default-create-1");
    const plainSnapshot = await runtime.snapshot("owner", plain);
    assert.equal(plainSnapshot.modelSelection.model?.modelId, "first");
    assert.equal(plainSnapshot.modelSelection.thinkingLevel, "off");

    await store.put("owner", {
      defaultModel: { provider: "faux", modelId: "second" },
      defaultThinking: "off",
      revision: 0,
    });
    const withDefault = await runtime.create(
      "owner",
      "With default",
      "default-create-2",
    );
    const withDefaultSnapshot = await runtime.snapshot("owner", withDefault);
    assert.equal(withDefaultSnapshot.modelSelection.model?.modelId, "second");

    // Another owner is unaffected by this owner's default.
    const otherId = await runtime.create("other", "Other", "default-other-1");
    const otherSnapshot = await runtime.snapshot("other", otherId);
    assert.equal(otherSnapshot.modelSelection.model?.modelId, "first");

    // A default pointing at a model that no longer exists in the catalog
    // (e.g. after an App restart removed it) falls back silently.
    await runtime.harness.commit(async (tx) => {
      const { OwnerProfile } = await import("../src/profile.js");
      const { ownerKey } = await import("../src/memory.js");
      const doc = await tx.doc(OwnerProfile, ownerKey("owner"), null);
      doc.defaultModel = { provider: "faux", modelId: "no-longer-offered" };
    }, ctx);
    const fallback = await runtime.create(
      "owner",
      "Fallback",
      "default-create-3",
    );
    const fallbackSnapshot = await runtime.snapshot("owner", fallback);
    assert.equal(fallbackSnapshot.modelSelection.model?.modelId, "first");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the risk judge never receives the owner's profile: it sees only the owner's request text and the exact proposed action", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-profile-judge-"));
  const provider = offline();
  const calls: unknown[] = [];
  const ha = new HAClient(
    "synthetic-token",
    { enabled: true, entities: ["light.example"], services: ["light.turn_on"] },
    (async (url, init) => {
      if (init?.method === "POST") return Response.json([]);
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
  ha.actions.useJudge({
    describe: () => ({ setting: "test/judge", model: "test/judge" }),
    evaluate: async (request) => {
      calls.push(request);
      return {
        model: "test/judge",
        verdict: "agreed",
        reason: "ok",
        latencyMs: 1,
      };
    },
  });
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(ha)],
    [],
    undefined,
    ha.actions,
  );
  try {
    const store = new ProfileStore(runtime);
    const canary = "PROFILE_CANARY_NEVER_IN_JUDGE_PROMPT";
    await store.put("owner", {
      displayName: canary,
      tone: "playful",
      revision: 0,
    });
    const id = await runtime.create("owner", "Home", "judge-create-1");
    // Confirm the canary does reach the main model's system prompt.
    const prompt = await promptFor(
      runtime,
      provider.faux,
      "owner",
      id,
      "judge-in-1",
    );
    assert.match(prompt, new RegExp(canary));

    const action = {
      service: "light.turn_on",
      entityId: "light.example",
      data: { brightness: 10 },
    };
    provider.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ha_propose_service", action), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Filed for approval."),
    ]);
    const sid = await runtime.submit(
      "owner",
      id,
      "judge-in-2",
      "Turn on the light",
    );
    await (await runtime.harness.submission(sid as SubmissionId, ctx))!.wait(
      ctx,
    );

    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify(calls), new RegExp(canary));
    assert.doesNotMatch(JSON.stringify(calls), /playful/);
    const call = calls[0] as { request: string; action: unknown };
    assert.equal(call.request, "Turn on the light");
    assert.deepEqual(call.action, action);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
