import { open } from "node:fs/promises";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";
import { WorkspaceClient, workspaceExtension } from "../src/workspace.js";
import { offline } from "./fixtures.js";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
const dir = process.argv[3]!;
const client = new WorkspaceClient("/synthetic-unconnected", "a".repeat(64));
client.call = async () => {
  const file = await open(join(dir, "workspace-attempts.txt"), "a");
  await file.write("write attempted\n");
  await file.sync();
  await file.close();
  process.send?.({ stage: "workspace-writing" });
  return new Promise(() => {});
};
const extension = workspaceExtension(client),
  { models, model, faux } = offline();
const runtime = await Runtime.open(dir, models, model, [extension], [], {
  home: [],
  workspace: [extension],
});
const id = await runtime.create(
  "owner",
  "Interrupted coding",
  "workspace-create-1",
  "workspace",
);
faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall("write", { path: "synthetic.txt", content: "synthetic" }),
    { stopReason: "toolUse" },
  ),
]);
await runtime.submit(
  "owner",
  id,
  "workspace-input-1",
  "Write a synthetic file.",
);
