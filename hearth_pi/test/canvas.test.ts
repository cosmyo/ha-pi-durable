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
import {
  defineExtension,
  type ConversationId,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.js";
import { HAClient, haExtension } from "../src/ha.js";
import { HomeCanvas, homeCanvasTool } from "../src/canvas.js";
import { offline } from "./fixtures.js";

const selection = {
  title: "Office",
  sections: [
    {
      title: "Air and lighting",
      entities: ["sensor.office_temperature", "light.office_lamp"],
    },
  ],
};
function transport(
  calls: string[],
  fail: () => boolean = () => false,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    const id = decodeURIComponent(String(url).split("/").pop()!);
    calls.push(id);
    if (fail() && id === "light.office_lamp")
      return new Response("no", { status: 503 });
    return Response.json({
      entity_id: id,
      state: id.startsWith("sensor.") ? "21" : "off",
      attributes: {
        friendly_name: `synthetic-token <script>${id}</script>`,
        unit_of_measurement: id.startsWith("sensor.") ? "°C" : "",
        secret: "must-not-export",
      },
    });
  }) as typeof fetch;
}
async function turn(
  runtime: Runtime,
  faux: ReturnType<typeof offline>["faux"],
  id: number,
  args: unknown,
  key: string,
) {
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("ha_build_view", args as Parameters<typeof fauxToolCall>[1]),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Read the saved observations and their times."),
  ]);
  const submission = await runtime.submit(
    "owner",
    id,
    key,
    "Build my home view",
  );
  await (await runtime.harness.submission(
    submission as SubmissionId,
    ctx,
  ))!.wait(ctx);
}

test("native Pi Durable tool builds grounded atomic Home canvas, hydrates on reopen, scopes snapshots and deduplicates input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-canvas-"));
  const provider = offline(),
    calls: string[] = [],
    secrets: string[] = [];
  const ha = new HAClient(
    "synthetic-token",
    { enabled: false, entities: selection.sections[0]!.entities, services: [] },
    transport(calls),
    secrets,
  );
  const extensions = [haExtension(ha)];
  let runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    extensions,
  );
  try {
    const id = await runtime.create("owner", "My office", "canvas-create-1");
    await turn(runtime, provider.faux, id, selection, "canvas-input-1");
    assert.deepEqual(calls, selection.sections[0]!.entities);
    const canvas = (await runtime.snapshot("owner", id, ha.policy.entities))
      .homeCanvas!;
    assert.equal(canvas.title, "Office");
    assert.equal(canvas.source, "home_assistant");
    assert.equal(canvas.sections[0]!.readings[0]!.state, "21");
    assert.equal(canvas.sections[0]!.readings[1]!.state, "off");
    assert(canvas.committedAt >= canvas.sections[0]!.readings[1]!.observedAt);
    assert.match(JSON.stringify(canvas), /REDACTED/);
    assert.doesNotMatch(
      JSON.stringify(canvas),
      /synthetic-token|must-not-export/,
    );
    assert.equal((await runtime.snapshot("owner", id)).homeCanvas, null); // absent explicit scope denies projection
    const reduced = (await runtime.snapshot("owner", id, ["light.office_lamp"]))
      .homeCanvas!;
    assert.equal(reduced.sections[0]!.readings.length, 1);
    assert.doesNotMatch(JSON.stringify(reduced), /sensor.office_temperature/);
    assert.equal((await runtime.snapshot("owner", id, [])).homeCanvas, null);
    await assert.rejects(
      runtime.snapshot("other", id, ha.policy.entities),
      /session_not_found/,
    );
    const storedInput = await runtime.submit(
      "owner",
      id,
      "canvas-input-1",
      "Build my home view",
    );
    assert(storedInput > 0);
    assert.equal(calls.length, 2);
    await runtime.close();
    runtime = await Runtime.open(
      dir,
      provider.models,
      provider.model,
      extensions,
    );
    assert.deepEqual(
      (await runtime.snapshot("owner", id, ha.policy.entities)).homeCanvas,
      canvas,
    );
    assert.equal(calls.length, 2); // reopen is hydration, not polling or silent refresh
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unauthorized/duplicate/oversized/model-value layouts make zero reads and cannot replace the prior canvas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-canvas-deny-"));
  const provider = offline(),
    calls: string[] = [];
  const ha = new HAClient(
    "synthetic-token",
    {
      enabled: false,
      entities: [
        ...selection.sections[0]!.entities,
        ...Array.from({ length: 9 }, (_, i) => `sensor.example_${i}`),
      ],
      services: [],
    },
    transport(calls),
  );
  const runtime = await Runtime.open(dir, provider.models, provider.model, [
    haExtension(ha),
  ]);
  try {
    const id = await runtime.create("owner", "Scope", "canvas-create-2");
    await turn(runtime, provider.faux, id, selection, "canvas-valid-2");
    const original = (await runtime.snapshot("owner", id, ha.policy.entities))
      .homeCanvas;
    const invalid = [
      {
        title: "Denied",
        sections: [
          {
            title: "Mixed",
            entities: ["sensor.office_temperature", "sensor.private"],
          },
        ],
      },
      {
        title: "Duplicate",
        sections: [
          {
            title: "Mixed",
            entities: ["light.office_lamp", "light.office_lamp"],
          },
        ],
      },
      {
        title: "Too many",
        sections: [
          {
            title: "One",
            entities: Array.from(
              { length: 8 },
              (_, i) => `sensor.example_${i}`,
            ),
          },
          { title: "Two", entities: ["sensor.example_8"] },
        ],
      },
      {
        title: "Model value",
        sections: [
          { title: "One", entities: ["light.office_lamp"], state: "on" },
        ],
      },
      { title: "HTML", sections: [], html: "<script>" },
    ];
    for (const [i, args] of invalid.entries()) {
      calls.length = 0;
      await turn(runtime, provider.faux, id, args, `canvas-invalid-${i}`);
      assert.equal(calls.length, 0);
      assert.deepEqual(
        (await runtime.snapshot("owner", id, ha.policy.entities)).homeCanvas,
        original,
      );
    }
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("partial HA read failure leaves previous durable view unchanged; explicit refresh makes new GETs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-canvas-partial-"));
  const provider = offline(),
    calls: string[] = [];
  let fail = false;
  const ha = new HAClient(
    "synthetic-token",
    { enabled: false, entities: selection.sections[0]!.entities, services: [] },
    transport(calls, () => fail),
  );
  const runtime = await Runtime.open(dir, provider.models, provider.model, [
    haExtension(ha),
  ]);
  try {
    const id = await runtime.create("owner", "Atomic", "canvas-create-3");
    await turn(runtime, provider.faux, id, selection, "canvas-valid-3");
    const original = (await runtime.snapshot("owner", id, ha.policy.entities))
      .homeCanvas;
    fail = true;
    await turn(
      runtime,
      provider.faux,
      id,
      { ...selection, title: "Must not publish" },
      "canvas-failure-3",
    );
    assert.deepEqual(
      (await runtime.snapshot("owner", id, ha.policy.entities)).homeCanvas,
      original,
    );
    fail = false;
    await turn(
      runtime,
      provider.faux,
      id,
      { ...selection, title: "Fresh view" },
      "canvas-refresh-3",
    );
    const refreshed = (await runtime.snapshot("owner", id, ha.policy.entities))
      .homeCanvas!;
    assert.equal(refreshed.title, "Fresh view");
    assert.notEqual(refreshed.taskId, original!.taskId);
    assert.equal(calls.length, 6);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("newly known secrets are sanitized at canvas commit and scope revocation during reads aborts publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-canvas-final-check-"));
  const provider = offline(),
    secrets: string[] = [];
  const canary = "synthetic-future-oauth-canary";
  let revoke = false;
  const policy = {
    enabled: false,
    entities: [...selection.sections[0]!.entities],
    services: [],
  };
  const ha = new HAClient(
    "synthetic-token",
    policy,
    (async (url) => {
      const entityId = decodeURIComponent(String(url).split("/").pop()!);
      if (entityId === "light.office_lamp") {
        secrets.push(canary);
        if (revoke) policy.entities = [];
      }
      return Response.json({
        entity_id: entityId,
        state: "off",
        attributes: { friendly_name: canary },
      });
    }) as typeof fetch,
    secrets,
  );
  const runtime = await Runtime.open(dir, provider.models, provider.model, [
    haExtension(ha),
  ]);
  try {
    const id = await runtime.create(
      "owner",
      "Final check",
      "canvas-final-create",
    );
    await turn(
      runtime,
      provider.faux,
      id,
      { ...selection, title: canary },
      "canvas-final-secret",
    );
    const original = (await runtime.harness.snapshot(
      HomeCanvas,
      id as ConversationId,
      ctx,
    ))!.current;
    assert(original);
    assert.doesNotMatch(
      JSON.stringify(original),
      /synthetic-future-oauth-canary/,
    );
    assert.match(original.title, /REDACTED/);
    revoke = true;
    await turn(
      runtime,
      provider.faux,
      id,
      { ...selection, title: "Must not publish revoked reads" },
      "canvas-final-revoke",
    );
    assert.deepEqual(
      (await runtime.harness.snapshot(HomeCanvas, id as ConversationId, ctx))!
        .current,
      original,
    );
    assert.equal(
      (await runtime.snapshot("owner", id, policy.entities)).homeCanvas,
      null,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("task-scoped receipt prevents duplicate execution reads or reapplication, and Home tool is absent from Code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-canvas-receipt-"));
  const provider = offline(),
    calls: string[] = [];
  const ha = new HAClient(
    "synthetic-token",
    { enabled: false, entities: selection.sections[0]!.entities, services: [] },
    transport(calls),
  );
  const base = haExtension(ha),
    tool = homeCanvasTool(ha);
  const home = defineExtension({
    ...base,
    tools: base.tools!.map((t) =>
      t.name !== tool.name
        ? t
        : {
            ...tool,
            execute: async (args, api, context) => {
              const first = await tool.execute(
                args as typeof selection,
                api,
                context,
              );
              const content = first.content?.[0];
              assert(content?.type === "text");
              const replacement = JSON.parse(content.text);
              replacement.title = "A newer committed canvas";
              await api.commit(async (tx) => {
                (await tx.doc(HomeCanvas, api.conversationId)).current =
                  replacement;
              }, context);
              const again = await tool.execute(
                args as typeof selection,
                api,
                context,
              );
              assert.deepEqual(again, first);
              assert.equal(
                (await api.snapshot(HomeCanvas, api.conversationId, context))!
                  .current!.title,
                "A newer committed canvas",
              );
              return again;
            },
          },
    ),
  });
  const code = defineExtension({
    name: "synthetic-confined-code-metadata",
    tools: [],
  });
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [home, code],
    [],
    { home: [home], workspace: [code] },
  );
  try {
    const id = await runtime.create("owner", "Receipt", "canvas-create-4");
    await turn(runtime, provider.faux, id, selection, "canvas-receipt-4");
    assert.equal(calls.length, 2);
    const codeId = await runtime.create(
      "owner",
      "Code",
      "canvas-code-4",
      "workspace",
    );
    const agent = await (await runtime.session("owner", codeId)).agent(ctx);
    assert(!agent.tools.some((t) => t.name === "ha_build_view"));
    await turn(runtime, provider.faux, codeId, selection, "canvas-no-code-4");
    assert.equal(calls.length, 2);
    assert.equal(
      (await runtime.snapshot("owner", codeId, ha.policy.entities)).homeCanvas,
      null,
    );
    assert.equal(
      (await runtime.harness.snapshot(
        HomeCanvas,
        codeId as ConversationId,
        ctx,
      ))!.current,
      null,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
