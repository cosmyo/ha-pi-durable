import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  UserEntry,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.js";
import { Actions, haExtension } from "../src/ha.js";
import { appServer } from "../src/server.js";
import {
  FEEDBACK_FIELDS,
  FEEDBACK_REASONS,
  FeedbackLog,
  FeedbackStore,
} from "../src/feedback.js";
import { Proactive } from "../src/proactive.js";
import { offline } from "./fixtures.js";
import { fakeHA } from "./app-fixtures.js";

const PROMPT = "SYNTHETIC-PRIVATE-PROMPT about the kitchen";
const ANSWER = "SYNTHETIC-PRIVATE-ANSWER: the kitchen is 21 C";

async function answered(
  runtime: Runtime,
  faux: ReturnType<typeof offline>["faux"],
  owner: string,
  key: string,
) {
  const id = await runtime.create(owner, "Feedback chat", `${key}-create`);
  faux.setResponses([fauxAssistantMessage(ANSWER)]);
  const submission = await runtime.submit(owner, id, `${key}-input`, PROMPT);
  await (await runtime.harness.submission(
    submission as SubmissionId,
    ctx,
  ))!.wait(ctx);
  const entries = (await (await runtime.session(owner, id)).context(ctx))
    .entries;
  return {
    id,
    assistant: entries.find((e) => AssistantEntry.is(e))!.id as number,
    user: entries.find((e) => UserEntry.is(e))!.id as number,
  };
}

test("feedback schema stores only ids, enums, a model label and a time — never prompt or response text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-feedback-"));
  const provider = offline();
  const f = fakeHA();
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(f.ha)],
    [],
    undefined,
    f.ha.actions,
  );
  try {
    const store = new FeedbackStore(runtime);
    const chat = await answered(runtime, provider.faux, "owner", "feedback-1");
    await store.record("owner", chat.id, {
      entryId: chat.assistant,
      rating: "down",
      reasons: ["wrong_value", "too_long"],
    });
    // Rating twice replaces; reasons only with a thumbs-down.
    await store.record("owner", chat.id, {
      entryId: chat.assistant,
      rating: "down",
      reasons: ["wrong_value"],
    });
    await assert.rejects(
      store.record("owner", chat.id, {
        entryId: chat.assistant,
        rating: "up",
        reasons: ["too_long"],
      }),
      /invalid_reasons/,
    );
    for (const bad of [
      { entryId: chat.assistant, rating: "down", reasons: ["free text"] },
      { entryId: chat.assistant, rating: "down", note: ANSWER },
      { entryId: chat.assistant, rating: "meh" },
    ])
      await assert.rejects(store.record("owner", chat.id, bad), /invalid/);
    // Only this owner's committed assistant messages are ratable.
    await assert.rejects(
      store.record("owner", chat.id, { entryId: chat.user, rating: "up" }),
      /entry_not_found/,
    );
    await assert.rejects(
      store.record("other", chat.id, { entryId: chat.assistant, rating: "up" }),
      /session_not_found/,
    );
    const doc = (await runtime.harness.snapshot(FeedbackLog, ctx))!;
    assert.equal(doc.items.length, 1);
    const [item] = doc.items;
    assert.deepEqual(Object.keys(item!).sort(), [...FEEDBACK_FIELDS].sort());
    assert.deepEqual(item!.reasons, ["wrong_value"]);
    assert(item!.reasons.every((r) => FEEDBACK_REASONS.includes(r)));
    assert.equal(item!.model, `${provider.model.provider}/test`);
    const stored = JSON.stringify(doc);
    assert(!stored.includes("SYNTHETIC-PRIVATE"), "no prompt/response text");
    assert(!stored.includes("kitchen"));
    assert.deepEqual((await store.list("owner", chat.id)).items, {
      [String(chat.assistant)]: { rating: "down", reasons: ["wrong_value"] },
    });
    const insights = await store.insights("owner");
    assert.equal(insights.down, 1);
    assert.equal(insights.reasons.wrong_value, 1);
    assert.equal(insights.recent[0]!.session, "Feedback chat");
    assert(
      !JSON.stringify(await store.exportAll("owner")).includes(
        "SYNTHETIC-PRIVATE",
      ),
    );
    assert.equal((await store.insights("other")).down, 0);
    await assert.rejects(store.deleteAll("owner", {}), /confirmation_required/);
    assert.deepEqual(await store.deleteAll("owner", { confirm: true }), {
      deleted: 1,
    });
    assert.deepEqual(
      (await runtime.harness.snapshot(FeedbackLog, ctx))!.items,
      [],
    );
    assert.equal((await store.exportAll("owner")).items.length, 0);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Today, Briefings & watchers, feedback and Insights HTTP routes enforce auth/CSRF and never write to HA", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-proactive-http-"));
  const provider = offline();
  const f = fakeHA();
  f.ha.actions.authorizeOwners(["local-admin"]);
  const cfg = {
    mode: "local" as const,
    host: "127.0.0.1",
    port: 8099,
    origin: "http://127.0.0.1:8099",
    password: "synthetic-local-password-0001",
    authorizedUsers: [],
    dataDir: dir,
    provider: "offline" as const,
    model: "test",
    policy: f.policy,
    haToken: "synthetic-supervisor-token",
    apiKey: "synthetic-provider-key",
  };
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(f.ha)],
    [],
    undefined,
    f.ha.actions,
  );
  let clock = new Date(2026, 9, 8, 6).getTime();
  const proactive = new Proactive(runtime.harness, f.ha.reader(), {
    now: () => clock,
  });
  const app = appServer(cfg, runtime, new Actions(runtime, f.ha), {
    proactive,
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  cfg.origin = base;
  const authorization = `Basic ${Buffer.from(`hearth:${cfg.password}`).toString("base64")}`;
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { authorization } });
  try {
    for (const path of ["/api/today", "/api/proactive", "/api/insights"])
      assert.equal((await fetch(`${base}${path}`)).status, 401);
    const boot = await get("/api/bootstrap");
    const csrf = (await boot.json()).csrf;
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const post = (path: string, value: unknown, csrfToken = csrf) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          authorization,
          cookie,
          origin: base,
          "x-hearth-csrf": csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify(value),
      });
    assert.equal(
      (await post("/api/proactive/enabled", { enabled: false }, "wrong"))
        .status,
      403,
    );
    const settings = await (await get("/api/proactive")).json();
    assert.equal(settings.watchersEnabled, true);
    assert.equal(settings.briefings.morning.enabled, false);
    const bad = await post("/api/proactive/watchers/add", {
      watcher: {
        when: { kind: "transition", entity: "light.hall", to: "on" },
        card: { title: "<b>x</b>" },
      },
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).errors[0].code, "unsafe_text");
    const added = await post("/api/proactive/watchers/add", {
      watcher: {
        when: { kind: "schedule", at: "07:00" },
        card: { title: "Morning check" },
      },
    });
    assert.equal(added.status, 200);
    assert.equal((await added.json()).settings.watchers[0].id, "w_1");
    await proactive.tick();
    clock = new Date(2026, 9, 8, 7, 0, 30).getTime();
    await proactive.tick();
    const today = await (await get("/api/today")).json();
    assert.equal(today.unread, 1);
    const cardId = today.cards[0].id;
    assert.equal(
      (await post("/api/today/snooze", { id: cardId, until: "1h" })).status,
      200,
    );
    assert.equal((await (await get("/api/today")).json()).cards.length, 0);
    assert.equal(
      (await post("/api/today/dismiss", { id: "c_999" })).status,
      404,
    );
    assert.equal(
      (await post("/api/today/dismiss", { id: cardId, extra: 1 })).status,
      400,
    );
    assert.equal(
      (await post("/api/today/dismiss", { id: cardId })).status,
      200,
    );
    // Feedback on a real assistant entry through the session route.
    const chat = await answered(
      runtime,
      provider.faux,
      "local-admin",
      "fb-http",
    );
    const rated = await post(`/api/sessions/${chat.id}/feedback`, {
      entryId: chat.assistant,
      rating: "up",
    });
    assert.equal(rated.status, 200);
    const listed = await (
      await get(`/api/sessions/${chat.id}/feedback`)
    ).json();
    assert.equal(listed.items[String(chat.assistant)].rating, "up");
    const insights = await (await get("/api/insights")).json();
    assert.equal(insights.feedback.up, 1);
    assert.equal(insights.today.dismissed, 1);
    const exported = await (await get("/api/insights/export")).json();
    assert.deepEqual(exported.fields, [...FEEDBACK_FIELDS]);
    assert(!JSON.stringify(exported).includes("SYNTHETIC-PRIVATE"));
    assert.equal((await post("/api/insights/delete", {})).status, 400);
    assert.equal(
      (await post("/api/insights/delete", { confirm: true })).status,
      200,
    );
    const cleared = await (await get("/api/insights")).json();
    assert.equal(cleared.feedback.up, 0);
    assert.equal(cleared.today.dismissed, 0);
    assert.equal(f.posts.length, 0, "no Home Assistant writes");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
