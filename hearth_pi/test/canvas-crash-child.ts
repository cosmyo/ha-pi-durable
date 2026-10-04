// Offline crash seam: genuine Harness/tool/api.commit, never a live HA endpoint.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineExtension } from "@earendil-works/pi-durable";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { HAClient, haExtension } from "../src/ha.js";
import { homeCanvasTool } from "../src/canvas.js";
import { offline } from "./fixtures.js";
const [mode, dir] = process.argv.slice(2);
const provider = offline();
const ha = new HAClient(
  "synthetic-canvas-crash-token",
  { enabled: false, entities: ["light.example"], services: [] },
  (async () => {
    if (mode === "canvas-before") {
      process.send?.({ stage: "canvas-reading" });
      await new Promise(() => {});
    }
    return Response.json({
      entity_id: "light.example",
      state: "off",
      attributes: {},
    });
  }) as typeof fetch,
);
const tool = homeCanvasTool(ha),
  base = haExtension(ha);
const home = defineExtension({
  ...base,
  tools: base.tools!.map((t) =>
    t.name !== tool.name
      ? t
      : {
          ...tool,
          execute: async (args, api, context) => {
            const output = await tool.execute(
              args as {
                title: string;
                sections: { title: string; entities: string[] }[];
              },
              api,
              context,
            );
            if (mode === "canvas-after") {
              process.send?.({ stage: "canvas-committed" });
              await new Promise(() => {});
            }
            return output;
          },
        },
  ),
});
const runtime = await Runtime.open(dir!, provider.models, provider.model, [
  home,
]);
const id = await runtime.create("owner", "Canvas crash", "canvas-crash-create");
provider.faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall("ha_build_view", {
      title: "Saved view",
      sections: [{ title: "Example", entities: ["light.example"] }],
    }),
    { stopReason: "toolUse" },
  ),
]);
await runtime.submit(
  "owner",
  id,
  "canvas-crash-request",
  "Synthetic canvas input",
);
await runtime.harness.waitForIdle(ctx);
