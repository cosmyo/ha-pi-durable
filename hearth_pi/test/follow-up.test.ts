// Follow-ups typed while Hearth works on a Home chat (Runtime.submit with
// followUp): the real durable harness, the offline faux provider and the
// synthetic Home Assistant fakes of admin-fixtures.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import { InboxDoc } from "@earendil-works/pi-durable";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { adminHarness } from "./admin-fixtures.js";
import { Inputs } from "../src/documents.js";
import { InjectionGuard } from "../src/injection-guard.js";
import { FOLLOW_UP_QUEUE_LIMIT, Runtime } from "../src/runtime.js";
import { appServer } from "../src/server.js";
import { Actions } from "../src/ha.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineExtension } from "@earendil-works/pi-durable";
import { offline } from "./fixtures.js";
import type { Config } from "../src/config.js";

const DIRECT = { direct: true } as const;
const FOLLOW_UP = { direct: true, followUp: true } as const;
const light = {
  domain: "light",
  service: "turn_on",
  target: { entity_id: ["light.kitchen"] },
  data: { brightness: 100 },
};
const unlock = {
  domain: "lock",
  service: "unlock",
  target: { entity_id: ["lock.front_door"] },
};
const call = (tool: string, args: Record<string, unknown>) =>
  fauxAssistantMessage(fauxToolCall(tool, args as never), {
    stopReason: "toolUse",
  });
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}
async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}
type Fixture = Awaited<ReturnType<typeof adminHarness>>;
const records = async (f: Fixture, id = f.id) =>
  (await f.runtime.harness.snapshot(Inputs, id as ConversationId, ctx))!
    .requests;
const done = async (f: Fixture, submission: number) =>
  (await f.runtime.harness.submission(submission as SubmissionId, ctx))!.wait(
    ctx,
  );

test("a message typed while a Home turn runs waits as a follow-up, runs after the turn with its own input record, and an approval of the earlier turn does not carry over", async () => {
  const f = await adminHarness({ submit: DIRECT });
  try {
    await f.mode("ask");
    const hold = gate();
    f.provider.faux.setResponses([
      call("ha_call_service", light),
      async () => {
        await hold.opened;
        return fauxAssistantMessage("Waiting for your approval.");
      },
      call("ha_call_service", light),
      fauxAssistantMessage("Asked again."),
    ]);
    const first = await f.runtime.submit(
      "owner",
      f.id,
      "turn-one",
      "Kitchen light on",
      undefined,
      DIRECT,
    );
    await until(async () => (await f.receipts()).length === 1, "a proposal");
    const second = await f.runtime.submit(
      "owner",
      f.id,
      "turn-two",
      "And once more, please",
      undefined,
      FOLLOW_UP,
    );
    // Same request id, same content: the same queued submission.
    assert.equal(
      await f.runtime.submit(
        "owner",
        f.id,
        "turn-two",
        "And once more, please",
        undefined,
        FOLLOW_UP,
      ),
      second,
    );
    const queued = await f.runtime.harness.snapshot(
      InboxDoc,
      f.id as ConversationId,
      ctx,
    );
    assert.deepEqual(
      queued?.items.map((item) => [item.id, item.mode]),
      [[second, "followUp"]],
    );
    const snapshot = await f.runtime.snapshot("owner", f.id);
    assert.equal(snapshot.lastInput?.status, "queued");
    assert.equal(
      (snapshot.view.docs as Record<string, { items?: unknown[] }>)["pi.inbox"]
        ?.items?.length,
      1,
    );
    // The person approves the first turn's exact card while the follow-up waits.
    const [earlier] = await f.receipts();
    assert.equal(earlier?.status, "pending");
    await f.ha.actions.decide(
      "owner",
      f.id,
      earlier!.id,
      earlier!.hash,
      "approve",
    );
    assert.equal(f.writes.length, 1);
    hold.open();
    await done(f, second);
    // The follow-up's identical proposal is a new card of its own: the
    // earlier approval is not reused.
    const receipts = await f.receipts();
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0]!.status, "accepted");
    assert.equal(receipts[1]!.status, "pending");
    assert.notEqual(receipts[1]!.id, receipts[0]!.id);
    assert.equal(f.writes.length, 1, "nothing more ran without a person");
    // Its own input record: own submission, the person's direct turn and its
    // own permission binding, committed when it was admitted.
    const inputs = await records(f);
    assert.deepEqual(Object.keys(inputs).sort(), ["turn-one", "turn-two"]);
    assert.equal(inputs["turn-one"]!.submissionId, first);
    assert.equal(inputs["turn-two"]!.submissionId, second);
    assert.equal(inputs["turn-two"]!.direct, true);
    assert.equal(inputs["turn-two"]!.channel, undefined);
    assert.ok(inputs["turn-two"]!.homePermission);
    assert.equal(inputs["turn-two"]!.guard, undefined);
    // Delivered after the turn answered, as the next user message.
    const transcript = await f.toolResults();
    assert.ok(
      transcript.indexOf("Waiting for your approval.") <
        transcript.indexOf("And once more, please"),
    );
  } finally {
    await f.close();
  }
});

test("only the composer's own Home messages wait behind a run: other submitters and a full queue are refused as busy", async () => {
  const f = await adminHarness({ submit: DIRECT });
  try {
    const hold = gate();
    const answer = async () => {
      await hold.opened;
      return fauxAssistantMessage("Done.");
    };
    f.provider.faux.setResponses([
      answer,
      ...Array.from({ length: FOLLOW_UP_QUEUE_LIMIT }, () =>
        fauxAssistantMessage("Done."),
      ),
    ]);
    await f.runtime.submit(
      "owner",
      f.id,
      "busy-one",
      "Hello",
      undefined,
      DIRECT,
    );
    // Without followUp (Hearth Assist, Code suggestions): refused as before.
    await assert.rejects(
      f.runtime.submit("owner", f.id, "busy-two", "Hi", undefined, DIRECT),
      /session_busy/,
    );
    // A follow-up is only ever the person's own typed message.
    for (const options of [
      { followUp: true },
      { followUp: true, direct: true, channel: "assist" as const },
    ])
      await assert.rejects(
        f.runtime.submit("owner", f.id, "busy-three", "Hi", undefined, options),
        /invalid_request/,
      );
    for (let n = 0; n < FOLLOW_UP_QUEUE_LIMIT; n++)
      await f.runtime.submit(
        "owner",
        f.id,
        `queued-number-${n}`,
        `Queued ${n}`,
        undefined,
        FOLLOW_UP,
      );
    await assert.rejects(
      f.runtime.submit("owner", f.id, "queued-extra", "One more", undefined, {
        ...FOLLOW_UP,
      }),
      /session_busy/,
    );
    hold.open();
    await f.runtime.harness.waitForIdle(ctx);
    const inputs = await records(f);
    assert.equal(Object.keys(inputs).length, 1 + FOLLOW_UP_QUEUE_LIMIT);
    assert.ok(Object.values(inputs).every((i) => i.submissionId > 0));
  } finally {
    await f.close();
  }
});

test("a Code session keeps refusing a message typed while its turn runs: its uncertain-operation pause counts human inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-follow-up-code-"));
  const { faux, models, model } = offline();
  const extension = defineExtension({ name: "synthetic-code" });
  const runtime = await Runtime.open(dir, models, model, [extension], [], {
    home: [],
    workspace: [extension],
  });
  try {
    const code = await runtime.create(
      "owner",
      "Code",
      "code-create",
      "workspace",
    );
    const hold = gate();
    faux.setResponses([
      async () => {
        await hold.opened;
        return fauxAssistantMessage("Done.");
      },
    ]);
    await runtime.submit(
      "owner",
      code,
      "code-input",
      "Inspect",
      undefined,
      DIRECT,
    );
    await assert.rejects(
      runtime.submit(
        "owner",
        code,
        "code-second",
        "Also",
        undefined,
        FOLLOW_UP,
      ),
      /session_busy/,
    );
    hold.open();
    await runtime.harness.waitForIdle(ctx);
    assert.deepEqual(
      Object.keys(
        (await runtime.harness.snapshot(Inputs, code as ConversationId, ctx))!
          .requests,
      ),
      ["code-input"],
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// A fake guard service flagging any text with the synthetic canary.
function canaryGuard() {
  return new InjectionGuard(
    {
      url: "http://10.0.0.5:8090",
      apiKey: "synthetic-guard-key-0002",
      timeoutMs: 500,
    },
    {
      fetcher: (async (_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { texts: string[] };
        return Response.json({
          scanned: true,
          results: body.texts.map((t) =>
            t.includes("ATTRIBUTE_CANARY")
              ? { score: 0.97, flagged: true }
              : { score: 0.01, flagged: false },
          ),
        });
      }) as typeof fetch,
      log: () => {},
    },
  );
}

test("follow-ups typed while a run's tool output is guard-flagged carry the run's mark and wait for a person; the next ordinary turn starts clean", async () => {
  const f = await adminHarness({ trusted: ["owner"], submit: DIRECT });
  try {
    f.ha.actions.useInjectionGuard(canaryGuard());
    await f.mode("full");
    const beforeRead = gate();
    const afterRead = gate();
    f.provider.faux.setResponses([
      async () => {
        await beforeRead.opened;
        return call("ha_search_states", { query: "canary", offset: 0 });
      },
      async () => {
        await afterRead.opened;
        return fauxAssistantMessage("I read the sensors.");
      },
      call("ha_call_service", light),
      fauxAssistantMessage("See the receipt."),
      call("ha_call_service", light),
      fauxAssistantMessage("See the receipt."),
    ]);
    await f.runtime.submit(
      "owner",
      f.id,
      "read-first",
      "Check the sensors",
      undefined,
      DIRECT,
    );
    // Queued before the flagged read: marked together with the run.
    await f.runtime.submit(
      "owner",
      f.id,
      "follow-first",
      "Then turn on the kitchen light",
      undefined,
      FOLLOW_UP,
    );
    beforeRead.open();
    await until(
      async () => (await records(f))["read-first"]?.guard?.result === "flagged",
      "the guard mark",
    );
    assert.equal((await records(f))["follow-first"]?.guard?.result, "flagged");
    // Typed after the mark, while the flagged run still works: marked at
    // admission.
    const b = await f.runtime.submit(
      "owner",
      f.id,
      "follow-second",
      "And the kitchen light again",
      undefined,
      FOLLOW_UP,
    );
    assert.equal((await records(f))["follow-second"]?.guard?.result, "flagged");
    assert.ok(
      !JSON.stringify((await records(f))["follow-second"]).includes("CANARY"),
    );
    afterRead.open();
    await done(f, b);
    const receipts = await f.receipts();
    assert.deepEqual(
      receipts.map((r) => [
        r.status,
        r.authorization?.source,
        r.authorization?.guard,
      ]),
      [
        ["pending", "human", "flagged"],
        ["pending", "human", "flagged"],
      ],
    );
    assert.equal(f.writes.length, 0, "nothing ran without a person");
    // A turn typed after the flagged run ended follows the normal rules.
    const next = await f.run("ha_call_service", unlock, "Unlock the door");
    assert.deepEqual(
      [next?.status, next?.authorization?.source, next?.authorization?.guard],
      ["accepted", "trusted", undefined],
    );
  } finally {
    await f.close();
  }
});

test("HTTP: the composer's input route queues a message typed while a Home turn runs (202), once per request id", async () => {
  const f = await adminHarness({ submit: DIRECT });
  const cfg: Config = {
    mode: "local",
    host: "127.0.0.1",
    port: 8099,
    origin: "http://127.0.0.1:8099",
    password: "synthetic-local-password-0002",
    authorizedUsers: [],
    dataDir: f.dir,
    provider: "offline",
    model: "test",
    haToken: "synthetic-ha-token",
    apiKey: "synthetic-api-key",
    policy: { enabled: false, entities: [], services: [] },
  };
  const app = appServer(cfg, f.runtime, new Actions(f.runtime, f.ha));
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  cfg.origin = `http://127.0.0.1:${address.port}`;
  const authorization = `Basic ${Buffer.from(`hearth:${cfg.password}`).toString("base64")}`;
  try {
    const id = await f.runtime.create("local-admin", "Home", "http-create");
    const boot = await fetch(`${cfg.origin}/api/bootstrap`, {
      headers: { authorization },
    });
    const csrf = (await boot.json()).csrf;
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const send = (requestId: string, content: string) =>
      fetch(`${cfg.origin}/api/sessions/${id}/inputs`, {
        method: "POST",
        headers: {
          authorization,
          cookie,
          origin: cfg.origin,
          "x-hearth-csrf": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestId, content }),
      });
    const hold = gate();
    f.provider.faux.setResponses([
      async () => {
        await hold.opened;
        return fauxAssistantMessage("First.");
      },
      fauxAssistantMessage("Second."),
    ]);
    assert.equal((await send("http-one", "Hello")).status, 202);
    const queued = await send("http-two", "Also this");
    assert.equal(queued.status, 202);
    const { submissionId } = await queued.json();
    assert.equal(
      (await (await send("http-two", "Also this")).json()).submissionId,
      submissionId,
    );
    const conflict = await send("http-two", "Something else");
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, "idempotency_conflict");
    hold.open();
    await done(f, submissionId);
    const inputs = await records(f, id);
    assert.equal(inputs["http-two"]!.direct, true);
    assert.ok(
      inputs["http-two"]!.submissionId > inputs["http-one"]!.submissionId,
    );
  } finally {
    // Closes the actions and the runtime too.
    await app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
