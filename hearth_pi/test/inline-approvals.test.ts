// Inline approval cards, server side: every model proposal tool result
// carries the controller-set `details.proposalId` of the proposal it filed,
// through the injection guard wrapper, into the transcript the browser gets.
// Real durable harness, offline faux provider, synthetic HA fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";
import { haExtension, type HAClient } from "../src/ha.js";
import {
  InjectionGuard,
  GUARD_WARNING_PREFIX,
} from "../src/injection-guard.js";
import { offline } from "./fixtures.js";
import { call } from "./app-fixtures.js";
import { GROCERIES, fakeListHA } from "./list-fixtures.js";
import { adminHarness } from "./admin-fixtures.js";

type ToolResult = {
  role: "toolResult";
  toolName: string;
  content: { type: string; text?: string }[];
  details?: { proposalId?: unknown };
};
// The tool results the browser's snapshot carries (what render.js links).
async function snapshotResults(runtime: Runtime, owner: string, id: number) {
  const snapshot = (await runtime.snapshot(owner, id)) as unknown as {
    view: { entries: { model?: { role?: string }[] }[] };
    proposals: Record<string, { id: string }>;
  };
  return {
    proposals: snapshot.proposals,
    results: snapshot.view.entries.flatMap((e) =>
      (e.model ?? []).filter((m) => m.role === "toolResult"),
    ) as ToolResult[],
  };
}
async function scopedHarness(ha: HAClient) {
  const dir = await mkdtemp(join(tmpdir(), "hearth-inline-"));
  const provider = offline();
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(ha)],
    [],
    undefined,
    ha.actions,
  );
  return {
    runtime,
    provider,
    close: async () => {
      await ha.actions.close();
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
// A fake guard that flags every text it is asked about.
function flaggingGuard() {
  return new InjectionGuard(
    {
      url: "http://10.0.0.5:8090",
      apiKey: "synthetic-guard-key",
      timeoutMs: 500,
    },
    {
      fetcher: (async (_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { texts: string[] };
        return Response.json({
          scanned: true,
          results: body.texts.map(() => ({ score: 0.97, flagged: true })),
        });
      }) as typeof fetch,
      log: () => {},
    },
  );
}

test("scoped ha_propose_service and list_propose results carry details.proposalId of the proposal they filed", async () => {
  const f = fakeListHA();
  const h = await scopedHarness(f.ha);
  try {
    const id = await h.runtime.create("owner", "Home", "inline-scoped-1");
    const light = await call(
      h.runtime,
      h.provider.faux,
      "owner",
      id,
      "ha_propose_service",
      { service: "light.turn_on", entityId: "light.example", data: {} },
      "inline-scoped-2",
    );
    const list = await call(
      h.runtime,
      h.provider.faux,
      "owner",
      id,
      "list_propose",
      { entityId: GROCERIES, op: "add", summary: "Apples" },
      "inline-scoped-3",
    );
    assert.equal(light.status, "pending");
    assert.equal(list.status, "pending");
    const { proposals, results } = await snapshotResults(
      h.runtime,
      "owner",
      id,
    );
    assert.deepEqual(
      results.map((r) => [r.toolName, r.details]),
      [
        ["ha_propose_service", { proposalId: light.id }],
        ["list_propose", { proposalId: list.id }],
      ],
    );
    // The id names a committed proposal, and the model still reads the
    // receipt as text, unchanged.
    for (const r of results) {
      const pid = String(r.details?.proposalId);
      assert.equal(proposals[pid]?.id, pid);
      assert.equal(JSON.parse(r.content[0]!.text!).id, pid);
    }
  } finally {
    await h.close();
  }
});

test("admin proposal tools carry details.proposalId, also when the injection guard flags the result and prepends its warning", async () => {
  const f = await adminHarness();
  try {
    const plain = await f.run("ha_call_service", {
      domain: "light",
      service: "turn_on",
      target: { entity_id: ["light.kitchen"] },
      data: {},
    });
    f.ha.actions.useInjectionGuard(flaggingGuard());
    const flagged = await f.run("ha_config_propose", {
      resource: "automation",
      op: "delete",
      id: "porch_lights",
    });
    assert.notEqual(flagged!.id, plain!.id);
    // The guard scanned and flagged this very result (after the proposal
    // was filed): the warning goes in front, the details stay.
    const { results } = await snapshotResults(f.runtime, "owner", f.id);
    const byTool = new Map(results.map((r) => [r.toolName, r]));
    assert.deepEqual(byTool.get("ha_call_service")?.details, {
      proposalId: plain!.id,
    });
    const guarded = byTool.get("ha_config_propose")!;
    assert.deepEqual(guarded.details, { proposalId: flagged!.id });
    assert.ok(guarded.content[0]!.text!.startsWith(GUARD_WARNING_PREFIX));
    assert.equal(JSON.parse(guarded.content[1]!.text!).id, flagged!.id);
  } finally {
    await f.close();
  }
});
