import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { HAClient, haExtension } from "../src/ha.js";
import { Runtime } from "../src/runtime.js";
import { Catalog, Inputs, Proposals } from "../src/documents.js";
import {
  FULL_ACKNOWLEDGEMENT,
  policyFingerprint,
} from "../src/home-actions.js";
import { offline } from "./fixtures.js";

const action = {
  service: "light.turn_on",
  entityId: "light.example",
  data: { brightness: 42 },
};
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(
  options: {
    enabled?: boolean;
    get?: (path: string, signal?: AbortSignal) => Promise<Response>;
    post?: (signal?: AbortSignal) => Promise<Response>;
    duplicate?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "hearth-permissions-"));
  const provider = offline();
  let posts = 0;
  const ha = new HAClient(
    "synthetic-token",
    {
      enabled: options.enabled ?? true,
      entities: ["light.example"],
      services: ["light.turn_on"],
    },
    (async (url, init) => {
      if (init?.method === "POST") {
        posts++;
        return options.post
          ? options.post(init.signal ?? undefined)
          : Response.json([]);
      }
      if (options.get)
        return options.get(String(url), init?.signal ?? undefined);
      return String(url).endsWith("services")
        ? Response.json([{ domain: "light", services: { turn_on: {} } }])
        : Response.json({
            entity_id: "light.example",
            state: "off",
            attributes: {},
          });
    }) as typeof fetch,
  );
  ha.actions.authorizeOwners(["owner", "other"]);
  let extension = haExtension(ha);
  if (options.duplicate)
    extension = {
      ...extension,
      tools: extension.tools!.map((tool) =>
        tool.name !== "ha_propose_service"
          ? tool
          : {
              ...tool,
              execute: async (a, api, context) => {
                const first = await tool.execute(a, api, context);
                assert.deepEqual(await tool.execute(a, api, context), first);
                return first;
              },
            },
      ),
    };
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [extension],
    [],
    undefined,
    ha.actions,
  );
  const id = await runtime.create("owner", "Home", "create-home-1");
  const mode = async (value: "read-only" | "ask" | "full", owner = "owner") => {
    const p = await ha.actions.settings(owner);
    return ha.actions.setMode(
      owner,
      value,
      p.revision,
      p.policy,
      value === "full" ? FULL_ACKNOWLEDGEMENT : undefined,
    );
  };
  const submit = async (
    key = "request-home-1",
    sessionId = id,
    owner = "owner",
  ) => {
    provider.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ha_propose_service", action), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        "See authoritative receipt; no physical verification.",
      ),
    ]);
    const sid = await runtime.submit(
      owner,
      sessionId,
      key,
      "Request supported action",
    );
    return {
      sid,
      wait: async () =>
        (await runtime.harness.submission(sid as SubmissionId, ctx))!.wait(ctx),
    };
  };
  const receipts = async (sessionId = id) =>
    Object.values(
      (await runtime.harness.snapshot(
        Proposals,
        sessionId as ConversationId,
        ctx,
      ))!.items,
    );
  return {
    dir,
    ha,
    runtime,
    id,
    provider,
    mode,
    submit,
    receipts,
    posts: () => posts,
    close: async () => {
      await ha.actions.close();
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("Home defaults: disabled Read-only; enabled Ask; acknowledged Full is exact one-shot with task/input/idempotency receipts", async () => {
  const disabled = await fixture({ enabled: false });
  try {
    assert.equal(
      (await disabled.ha.actions.settings("owner")).effectiveMode,
      "read-only",
    );
    await assert.rejects(disabled.mode("full"), /actions_disabled/);
    await (await disabled.submit()).wait();
    assert.equal(disabled.posts(), 0);
    assert.deepEqual(await disabled.receipts(), []);
  } finally {
    await disabled.close();
  }
  const f = await fixture({ duplicate: true });
  try {
    const p = await f.ha.actions.settings("owner");
    assert.equal(p.effectiveMode, "ask");
    await assert.rejects(
      f.ha.actions.setMode("owner", "full", p.revision, p.policy, undefined),
      /acknowledgement_required/,
    );
    await assert.rejects(
      f.ha.actions.setMode(
        "owner",
        "full",
        p.revision + 1,
        p.policy,
        FULL_ACKNOWLEDGEMENT,
      ),
      /permissions_stale/,
    );
    await f.mode("full");
    const submitted = await f.submit();
    assert.equal((await submitted.wait()).status, "done");
    assert.equal(
      await f.runtime.submit(
        "owner",
        f.id,
        "request-home-1",
        "Request supported action",
      ),
      submitted.sid,
    );
    const receipt = (await f.receipts())[0]!;
    assert.equal(f.posts(), 1);
    assert.equal(receipt.status, "accepted");
    assert.equal(receipt.authorization?.source, "automatic");
    assert(receipt.attemptedAt);
    assert.equal(receipt.policy, policyFingerprint(f.ha));
    const input = (await f.runtime.harness.snapshot(
      Inputs,
      f.id as ConversationId,
      ctx,
    ))!.requests["request-home-1"]!;
    assert.equal(input.homePermission?.mode, "full");
    assert.equal(
      input.homePermission?.revision,
      receipt.authorization?.revision,
    );
    await assert.rejects(
      f.ha.actions.decide(
        "other",
        f.id,
        receipt.id,
        receipt.hash,
        "resolve",
        "Checked",
      ),
      /session_not_found/,
    );
  } finally {
    await f.close();
  }
});

test("Home Ask manual decisions use the shared one-shot path; Read-only invalidates pending and Full never executes old Ask proposals", async () => {
  const f = await fixture();
  try {
    await (await f.submit()).wait();
    const old = (await f.receipts())[0]!;
    assert.equal(old.status, "pending");
    assert.equal(f.posts(), 0);
    await f.mode("full");
    assert.equal((await f.receipts())[0]!.status, "rejected");
    assert.equal(f.posts(), 0);
    await assert.rejects(
      f.ha.actions.decide("owner", f.id, old.id, old.hash, "approve"),
      /already_decided/,
    );
    await f.mode("ask");
    await (await f.submit("request-home-2")).wait();
    const manual = (await f.receipts()).at(-1)!;
    const outcomes = await Promise.allSettled([
      f.ha.actions.decide("owner", f.id, manual.id, manual.hash, "approve"),
      f.ha.actions.decide("owner", f.id, manual.id, manual.hash, "approve"),
    ]);
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    assert.equal(f.posts(), 1);
    await (await f.submit("request-home-3")).wait();
    const readonly = (await f.receipts()).at(-1)!;
    await f.mode("read-only");
    await assert.rejects(
      f.ha.actions.decide("owner", f.id, readonly.id, readonly.hash, "approve"),
      /already_decided/,
    );
    await (await f.submit("request-home-4")).wait();
    assert.equal(f.posts(), 1);
    assert.match(
      JSON.stringify(await f.runtime.snapshot("owner", f.id)),
      /home_read_only/,
    );
    // Even a legacy pending receipt restored without new authorization cannot bypass RO.
    await f.runtime.harness.commit(async (tx) => {
      const p = (await tx.doc(Proposals, f.id as ConversationId)).items[
        readonly.id
      ]!;
      p.status = "pending";
      delete p.authorization;
    }, ctx);
    await assert.rejects(
      f.ha.actions.decide("owner", f.id, readonly.id, readonly.hash, "approve"),
      /home_read_only/,
    );
    assert.equal(f.posts(), 1);
  } finally {
    await f.close();
  }
});

test("canonical exact policy changes invalidate Full persistently, including change-back and reopen; explicit Read-only persists", async () => {
  const f = await fixture();
  try {
    const fingerprint = policyFingerprint(f.ha);
    f.ha.policy.entities.push("light.example");
    assert.equal(policyFingerprint(f.ha), fingerprint);
    await f.mode("full");
    f.ha.policy.entities.push("light.new_exact");
    const invalid = await f.ha.actions.settings("owner");
    assert.equal(invalid.mode, "ask");
    assert.equal(invalid.grant, null);
    f.ha.policy.entities = ["light.example"];
    assert.equal((await f.ha.actions.settings("owner")).mode, "ask");
    await (await f.submit()).wait();
    assert.equal(f.posts(), 0);
    await f.mode("read-only");
    f.ha.policy.services = [];
    assert.equal(
      (await f.ha.actions.settings("owner")).effectiveMode,
      "read-only",
    );
    await f.ha.actions.close();
    await f.runtime.close();
    const { models, model } = offline();
    const ha = new HAClient("synthetic-token", {
      enabled: true,
      entities: ["light.example"],
      services: ["light.turn_on"],
    });
    ha.actions.authorizeOwners(["owner"]);
    const reopened = await Runtime.open(
      f.dir,
      models,
      model,
      [haExtension(ha)],
      [],
      undefined,
      ha.actions,
    );
    try {
      assert.equal((await ha.actions.settings("owner")).mode, "read-only");
    } finally {
      await ha.actions.close();
      await reopened.close();
    }
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("running or legacy Home inputs cannot acquire Full; owner and session kind never confer grants", async () => {
  const f = await fixture();
  try {
    const waiting = latch(),
      release = latch();
    f.provider.faux.setResponses([
      async () => {
        waiting.resolve();
        await release.promise;
        return fauxAssistantMessage(
          fauxToolCall("ha_propose_service", action),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("Cannot elevate running input"),
    ]);
    const sid = await f.runtime.submit(
      "owner",
      f.id,
      "request-old-input",
      "Start in Ask",
    );
    await waiting.promise;
    await f.mode("full");
    release.resolve();
    await (await f.runtime.harness.submission(sid as SubmissionId, ctx))!.wait(
      ctx,
    );
    assert.equal(f.posts(), 0);
    assert.match(
      JSON.stringify(await f.runtime.snapshot("owner", f.id)),
      /input_permission_not_elevated/,
    );
    const other = await f.runtime.create("other", "Other", "create-other-1");
    await (await f.submit("request-other-1", other, "other")).wait();
    assert.equal((await f.receipts(other))[0]!.status, "pending");
    assert.equal(f.posts(), 0);
    // Simulate a legacy admitted input with no binding during an in-progress Full input.
    f.provider.faux.setResponses([
      async () => {
        await f.runtime.harness.commit(async (tx) => {
          delete (await tx.doc(Inputs, f.id as ConversationId)).requests[
            "request-legacy-1"
          ]!.homePermission;
        }, ctx);
        return fauxAssistantMessage(
          fauxToolCall("ha_propose_service", action),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("Legacy input not elevated"),
    ]);
    const legacy = await f.runtime.submit(
      "owner",
      f.id,
      "request-legacy-1",
      "Legacy",
    );
    await (await f.runtime.harness.submission(
      legacy as SubmissionId,
      ctx,
    ))!.wait(ctx);
    assert.equal(f.posts(), 0);
    await f.runtime.harness.commit(async (tx) => {
      (await tx.doc(Catalog)).items.find((s) => s.id === f.id)!.kind =
        "workspace";
    }, ctx);
    await (await f.submit("request-kind-1")).wait();
    assert.equal(f.posts(), 0);
    assert.match(
      JSON.stringify(await f.runtime.snapshot("owner", f.id)),
      /home_session_required/,
    );
  } finally {
    await f.close();
  }
});

for (const change of ["read-only", "full"] as const)
  test(`Home revocation/revision ${change} during slow live validation commits promptly and makes zero POSTs`, async () => {
    const waiting = latch(),
      release = latch();
    const f = await fixture({
      get: async (path) => {
        if (path.endsWith("services"))
          return Response.json([
            { domain: "light", services: { turn_on: {} } },
          ]);
        waiting.resolve();
        await release.promise;
        return Response.json({
          entity_id: "light.example",
          state: "off",
          attributes: {},
        });
      },
    });
    try {
      await f.mode("full");
      const submitted = await f.submit();
      await waiting.promise;
      const saved = await Promise.race([
        f.mode(change),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("revocation_waited_for_HA")),
            1000,
          ).unref(),
        ),
      ]);
      assert.equal(saved.mode, change);
      release.resolve();
      await submitted.wait();
      assert.equal(f.posts(), 0);
    } finally {
      release.resolve();
      await f.close();
    }
  });

test("Home Read-only wins between durable intent and attempt; revocation never waits for POST and cannot undo attempted effects", async () => {
  const started = latch();
  const f = await fixture({
    post: async (signal) => {
      started.resolve();
      return new Promise<Response>((_, reject) =>
        signal!.addEventListener(
          "abort",
          () => reject(new Error("cancelled after attempt")),
          { once: true },
        ),
      );
    },
  });
  try {
    await f.mode("full");
    const submitted = await f.submit();
    await started.promise;
    await f.mode("read-only");
    await submitted.wait();
    assert.equal(f.posts(), 1);
    assert.equal((await f.receipts())[0]!.status, "unknown");
    assert.equal((await f.ha.actions.settings("owner")).blocked, true);
  } finally {
    await f.close();
  }
  const g = await fixture();
  try {
    const p = await g.mode("full");
    const commit = g.runtime.harness.commit.bind(g.runtime.harness);
    let revocation: Promise<unknown> | undefined;
    g.runtime.harness.commit = async (...args) => {
      const result = await commit(...args);
      const receipt = (await g.receipts())[0];
      if (
        receipt?.status === "dispatching" &&
        !receipt.attemptedAt &&
        !revocation
      )
        revocation = g.ha.actions.setMode(
          "owner",
          "read-only",
          p.revision,
          p.policy,
          undefined,
        );
      return result;
    };
    await (await g.submit()).wait();
    await revocation;
    assert.equal(g.posts(), 0);
    assert.equal((await g.receipts())[0]!.status, "rejected");
  } finally {
    await g.close();
  }
});

test("Home unknown barrier survives fresh conversations, owners, mode toggles, duplicates and restart; only specific human reconciliation clears it", async () => {
  const f = await fixture({
    post: async () => {
      throw new Error("uncertain");
    },
  });
  try {
    await f.mode("full");
    await (await f.submit()).wait();
    const unknown = (await f.receipts())[0]!;
    assert.equal(unknown.status, "unknown");
    await f.mode("read-only");
    await f.mode("full");
    const other = await f.runtime.create("other", "Other", "create-barrier-1");
    await f.mode("full", "other");
    await (await f.submit("request-barrier-1", other, "other")).wait();
    assert.equal(f.posts(), 1);
    assert.match(
      JSON.stringify(await f.runtime.snapshot("other", other)),
      /home_outcome_unresolved/,
    );
    const own = await f.runtime.create("owner", "New home", "create-barrier-2");
    await (await f.submit("request-barrier-2", own)).wait();
    assert.equal(f.posts(), 1);
    await f.ha.actions.close();
    await f.runtime.close();
    const provider = offline();
    let reopenedPosts = 0;
    const ha = new HAClient(
      "synthetic-token",
      {
        enabled: true,
        entities: ["light.example"],
        services: ["light.turn_on"],
      },
      (async (url, init) => {
        if (init?.method === "POST") {
          reopenedPosts++;
          return Response.json([]);
        }
        return String(url).endsWith("services")
          ? Response.json([{ domain: "light", services: { turn_on: {} } }])
          : Response.json({
              entity_id: "light.example",
              state: "off",
              attributes: {},
            });
      }) as typeof fetch,
    );
    ha.actions.authorizeOwners(["owner", "other"]);
    const runtime = await Runtime.open(
      f.dir,
      provider.models,
      provider.model,
      [haExtension(ha)],
      [],
      undefined,
      ha.actions,
    );
    try {
      assert.equal(reopenedPosts, 0);
      assert.equal((await ha.actions.settings("owner")).blocked, true);
      assert.equal(
        await runtime.submit(
          "owner",
          f.id,
          "request-home-1",
          "Request supported action",
        ),
        (await runtime.harness.snapshot(Inputs, f.id as ConversationId, ctx))!
          .requests["request-home-1"]!.submissionId,
      );
      provider.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("ha_propose_service", action), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Await human reconciliation"),
      ]);
      const blocked = await runtime.submit(
        "owner",
        own,
        "request-after-restart",
        "Try supported action",
      );
      await (await runtime.harness.submission(
        blocked as SubmissionId,
        ctx,
      ))!.wait(ctx);
      assert.equal(reopenedPosts, 0);
      await assert.rejects(
        ha.actions.decide(
          "other",
          f.id,
          unknown.id,
          unknown.hash,
          "resolve",
          "Checked",
        ),
        /session_not_found/,
      );
      await ha.actions.decide(
        "owner",
        f.id,
        unknown.id,
        unknown.hash,
        "resolve",
        "Observed independently; do not retry old action.",
      );
      assert.equal((await ha.actions.settings("owner")).blocked, false);
      provider.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("ha_propose_service", action), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("New receipt"),
      ]);
      const fresh = await runtime.submit(
        "owner",
        own,
        "request-after-resolve",
        "New explicit action request",
      );
      await (await runtime.harness.submission(
        fresh as SubmissionId,
        ctx,
      ))!.wait(ctx);
      assert.equal(reopenedPosts, 1);
    } finally {
      await ha.actions.close();
      await runtime.close();
    }
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
