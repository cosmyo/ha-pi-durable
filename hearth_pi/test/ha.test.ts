import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.js";
import { HAClient, haExtension, Actions } from "../src/ha.js";
import { Proposals } from "../src/documents.js";
import { safeModels } from "../src/models.js";
import { offline } from "./fixtures.js";

test("HA output redacts refreshed OAuth canaries added after client construction", async () => {
  const secrets: string[] = [];
  const refreshed = "synthetic-refreshed-oauth-access-canary";
  const ha = new HAClient(
    "synthetic-ha-token",
    { enabled: false, entities: ["light.example"], services: [] },
    (async () =>
      Response.json({
        entity_id: "light.example",
        state: "off",
        attributes: { friendly_name: refreshed },
      })) as typeof fetch,
    secrets,
  );
  secrets.push(refreshed);
  const result = JSON.stringify(await ha.state("light.example"));
  assert.doesNotMatch(result, /synthetic-refreshed-oauth/);
  assert.match(result, /REDACTED/);
});

test("real HA tool paginates beyond 500 without widening exact read scope or enabling actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-large-scope-"));
  const { faux, models, model } = offline();
  const entities = Array.from(
    { length: 876 },
    (_, i) => `sensor.example_${String(i).padStart(4, "0")}`,
  );
  let reads = 0;
  const ha = new HAClient(
    "synthetic-ha-token",
    { enabled: false, services: [], entities },
    (async (_url, init) => {
      assert.equal(init?.method, "GET");
      reads++;
      return Response.json(
        [...entities, "sensor.private"].map((entity_id) => ({
          entity_id,
          state: "on",
          attributes: {},
        })),
      );
    }) as typeof fetch,
  );
  const runtime = await Runtime.open(dir, models, model, [haExtension(ha)]);
  try {
    const id = await runtime.create(
      "owner",
      "Large scoped home",
      "create-large",
    );
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("ha_search_states", { query: "", offset: 520 }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Read-only discovery completed."),
    ]);
    const sid = await runtime.submit("owner", id, "request-large", "Next page");
    assert.equal(
      (
        await (await runtime.harness.submission(
          sid as SubmissionId,
          ctx,
        ))!.wait(ctx)
      ).status,
      "done",
    );
    assert.equal(reads, 1, "The real tool schema must admit a page past 500");
    const snapshot = JSON.stringify(await runtime.snapshot("owner", id));
    assert.match(snapshot, /sensor.example_0520/);
    assert.match(snapshot, /sensor.example_0539/);
    assert.doesNotMatch(snapshot, /sensor.private/);
    const last = await ha.search("", 860);
    assert.equal(last.items.length, 16);
    assert.equal(last.nextOffset, null);
    await assert.rejects(ha.state("sensor.private"), /entity_not_allowed/);
    assert.throws(
      () =>
        ha.action({
          service: "switch.turn_on",
          entityId: entities[0],
          data: {},
        }),
      /service_not_allowed/,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

export function fakeHA(
  post: () => Promise<Response> = async () => Response.json([]),
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") return post();
    const path = String(url);
    if (path.endsWith("services"))
      return Response.json([{ domain: "light", services: { turn_on: {} } }]);
    const state = {
      entity_id: "light.example",
      state: "off",
      attributes: {
        friendly_name: "synthetic-ha-token<script>",
        secret: "synthetic-ha-token",
        brightness: 50,
      },
    };
    return Response.json(
      path.endsWith("states")
        ? [state, { ...state, entity_id: "light.private" }]
        : state,
    );
  }) as typeof fetch;
}
export const policy = {
  enabled: true,
  services: ["light.turn_on"],
  entities: ["light.example"],
};

test("real HA extension proposes only; exact owner/hash/one-use approval; redacted scoped reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-ha-"));
  const { faux, models, model } = offline();
  let posts = 0;
  const ha = new HAClient(
    "synthetic-ha-token",
    policy,
    fakeHA(async () => {
      posts++;
      await new Promise((r) => setTimeout(r, 10));
      return Response.json([]);
    }),
  );
  ha.actions.authorizeOwners(["owner"]);
  const runtime = await Runtime.open(
    dir,
    safeModels(models, ["synthetic-ha-token"]),
    model,
    [haExtension(ha)],
    [],
    undefined,
    ha.actions,
  );
  try {
    const id = await runtime.create("owner", "Actions", "create-ha-1");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("ha_propose_service", {
          service: "light.turn_on",
          entityId: "light.example",
          data: { brightness: 70 },
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Review the action card."),
    ]);
    const sid = await runtime.submit(
      "owner",
      id,
      "request-ha-1",
      "Propose a light action",
    );
    assert.equal(
      (
        await (await runtime.harness.submission(
          sid as SubmissionId,
          ctx,
        ))!.wait(ctx)
      ).status,
      "done",
    );
    const proposal = Object.values(
      (await runtime.harness.snapshot(Proposals, id as ConversationId, ctx))!
        .items,
    )[0]!;
    assert.equal(posts, 0);
    assert.equal(proposal.status, "pending");
    const actions = new Actions(runtime, ha);
    await assert.rejects(
      actions.decide("other", id, proposal.id, proposal.hash, "approve"),
      /session_not_found/,
    );
    await assert.rejects(
      actions.decide("owner", id, proposal.id, "tampered", "approve"),
      /proposal_not_found/,
    );
    const outcomes = await Promise.allSettled([
      actions.decide("owner", id, proposal.id, proposal.hash, "approve"),
      actions.decide("owner", id, proposal.id, proposal.hash, "approve"),
    ]);
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    assert.equal(posts, 1);
    assert.equal(
      (await runtime.harness.snapshot(Proposals, id as ConversationId, ctx))!
        .items[proposal.id]!.status,
      "accepted",
    );
    const read = JSON.stringify(await ha.search("", 0));
    assert.match(read, /REDACTED/);
    assert.doesNotMatch(read, /synthetic-ha-token|light.private/);
    assert.doesNotMatch(
      JSON.stringify(await ha.state("light.example")),
      /secret/,
    );
    await assert.rejects(ha.state("light.private"), /entity_not_allowed/);
    assert.throws(
      () =>
        ha.action({
          service: "script.turn_on",
          entityId: "light.example",
          data: {},
        }),
      /service_not_allowed/,
    );
    assert.throws(
      () =>
        ha.action({
          service: "light.turn_on",
          entityId: "light.example",
          data: { entity_id: "light.private" },
        }),
      /invalid_request/,
    );
    assert.throws(
      () =>
        ha.action({
          service: "light.turn_on",
          entityId: "light.example",
          data: '{"brightness":2}',
        }),
      /invalid_request/,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("dispatch timeout remains unknown; disabled and stale approvals fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-unknown-"));
  const { faux, models, model } = offline();
  let posts = 0;
  const ha = new HAClient(
    "synthetic-token",
    policy,
    fakeHA(async () => {
      posts++;
      throw new Error("synthetic-token");
    }),
  );
  ha.actions.authorizeOwners(["owner"]);
  const runtime = await Runtime.open(
    dir,
    models,
    model,
    [haExtension(ha)],
    ["synthetic-token"],
    undefined,
    ha.actions,
  );
  try {
    const id = await runtime.create("owner", "Review", "create-ha-2");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("ha_propose_service", {
          service: "light.turn_on",
          entityId: "light.example",
          data: {},
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Ready"),
    ]);
    const sid = await runtime.submit("owner", id, "request-ha-2", "Propose");
    await (await runtime.harness.submission(sid as SubmissionId, ctx))!.wait(
      ctx,
    );
    let p = Object.values(
      (await runtime.harness.snapshot(Proposals, id as ConversationId, ctx))!
        .items,
    )[0]!;
    const actions = new Actions(runtime, ha);
    ha.policy.enabled = false;
    await assert.rejects(
      actions.decide("owner", id, p.id, p.hash, "approve"),
      /home_read_only/,
    );
    ha.policy.enabled = true;
    await assert.rejects(
      actions.decide("owner", id, p.id, p.hash, "approve"),
      /action_permission_stale/,
    );
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("ha_propose_service", {
          service: "light.turn_on",
          entityId: "light.example",
          data: {},
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("New review after policy change"),
    ]);
    const fresh = await runtime.submit(
      "owner",
      id,
      "request-ha-fresh",
      "Request a new proposal",
    );
    await (await runtime.harness.submission(fresh as SubmissionId, ctx))!.wait(
      ctx,
    );
    p = Object.values(
      (await runtime.harness.snapshot(Proposals, id as ConversationId, ctx))!
        .items,
    ).sort((a, b) => b.created - a.created)[0]!;
    await runtime.harness.commit(async (tx) => {
      (await tx.doc(Proposals, id as ConversationId)).items[p.id]!.expires = 1;
    }, ctx);
    await assert.rejects(
      actions.decide("owner", id, p.id, p.hash, "approve"),
      /proposal_expired/,
    );
    await runtime.harness.commit(async (tx) => {
      (await tx.doc(Proposals, id as ConversationId)).items[p.id]!.expires =
        Date.now() + 10000;
    }, ctx);
    await actions.decide("owner", id, p.id, p.hash, "approve");
    assert.equal(posts, 1);
    assert.equal(
      (await runtime.harness.snapshot(Proposals, id as ConversationId, ctx))!
        .items[p.id]!.status,
      "unknown",
    );
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
      "Human observed synthetic-token; no retry.",
    );
    assert.equal(posts, 1);
    const resolved = (await runtime.harness.snapshot(
      Proposals,
      id as ConversationId,
      ctx,
    ))!.items[p.id]!;
    assert.doesNotMatch(resolved.resolution, /synthetic-token/);
    assert.match(resolved.resolution, /REDACTED/);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
