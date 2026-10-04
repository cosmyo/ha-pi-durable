import { appendFile, open } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { HAClient, haExtension, Actions } from "../src/ha.js";
import { FULL_ACKNOWLEDGEMENT } from "../src/home-actions.js";
import { Proposals } from "../src/documents.js";
import { offline } from "./fixtures.js";

const [mode, dir] = process.argv.slice(2);
if (!dir) throw new Error("missing_fixture_directory");
const { faux, models, model } = offline();
const transport = (async (url: string | URL | Request, init?: RequestInit) => {
  if (init?.method === "POST") {
    const log = await open(join(dir, "posts.txt"), "a");
    await log.write("attempt\n");
    await log.sync();
    await log.close();
    process.send?.({ stage: "dispatched" });
    return new Promise<Response>(() => {});
  }
  if (String(url).endsWith("services"))
    return Response.json([{ domain: "light", services: { turn_on: {} } }]);
  if (mode === "read" || mode === "auto-before") {
    await appendFile(join(dir, "reads.txt"), "read\n");
    process.send?.({
      stage: mode === "auto-before" ? "validating" : "reading",
    });
    return new Promise<Response>(() => {});
  }
  return Response.json({
    entity_id: "light.example",
    state: "off",
    attributes: {},
  });
}) as typeof fetch;
const ha = new HAClient(
  "synthetic-child-token",
  { enabled: true, services: ["light.turn_on"], entities: ["light.example"] },
  transport,
);
ha.actions.authorizeOwners(["owner"]);
const runtime = await Runtime.open(
  dir,
  models,
  model,
  [haExtension(ha)],
  [],
  undefined,
  ha.actions,
);
if (mode?.startsWith("auto-")) {
  const p = await ha.actions.settings("owner");
  await ha.actions.setMode(
    "owner",
    "full",
    p.revision,
    p.policy,
    FULL_ACKNOWLEDGEMENT,
  );
}
if (mode === "auto-intent") {
  const commit = runtime.harness.commit.bind(runtime.harness);
  runtime.harness.commit = async (...args) => {
    const result = await commit(...args);
    const sessions = await runtime.list("owner");
    for (const session of sessions) {
      const items =
        (
          await runtime.harness.snapshot(
            Proposals,
            session.id as ConversationId,
            ctx,
          )
        )?.items ?? {};
      if (
        Object.values(items).some(
          (p) => p.status === "dispatching" && !p.attemptedAt,
        )
      ) {
        process.send?.({ stage: "intent" });
        return new Promise(() => {});
      }
    }
    return result;
  };
}
const id = await runtime.create("owner", "Crash fixture", "create-crash-1");
if (mode === "model" || mode === "auto-owner-generating")
  faux.setResponses([
    async () => {
      process.send?.({ stage: "generating" });
      return new Promise(() => {});
    },
  ]);
else
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        mode === "read" ? "ha_state_detail" : "ha_propose_service",
        mode === "read"
          ? { entityId: "light.example" }
          : { service: "light.turn_on", entityId: "light.example", data: {} },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Await review"),
  ]);
const submission = await runtime.submit(
  "owner",
  id,
  "request-crash-1",
  "Synthetic crash input",
);
process.send?.({ stage: "admitted", id, submission });
if (mode === "write") {
  await (await runtime.harness.submission(
    submission as SubmissionId,
    ctx,
  ))!.wait(ctx);
  const proposal = Object.values(
    (await runtime.harness.snapshot(Proposals, id as ConversationId, ctx))!
      .items,
  )[0]!;
  await new Actions(runtime, ha).decide(
    "owner",
    id,
    proposal.id,
    proposal.hash,
    "approve",
  );
}
