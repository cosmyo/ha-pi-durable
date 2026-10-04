import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineTool,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { HAClient } from "./ha.js";
import { digest, entityPattern, insist, object, text } from "./safety.js";

export type CanvasReading = {
  entityId: string;
  state: string;
  attributes: Record<string, string | number | boolean>;
  observedAt: number;
};
export type Canvas = {
  taskId: string;
  title: string;
  committedAt: number;
  source: "home_assistant";
  sections: { title: string; readings: CanvasReading[] }[];
};
export const HomeCanvas = defineDoc<{ current: Canvas | null }>({
  kind: "hearth.home-canvas",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ current: null }),
});
// Receipt and current canvas share one commit. Recovery never reapplies an old view.
const CanvasReceipt = defineDoc<{ layoutHash: string; value: Canvas | null }>({
  kind: "hearth.canvas-receipt",
  version: 1,
  scope: "task",
  initial: () => ({ layoutHash: "", value: null }),
});
function layout(value: unknown, ha: HAClient) {
  const v = object(value, ["title", "sections"]);
  insist(
    Array.isArray(v.sections) &&
      v.sections.length >= 1 &&
      v.sections.length <= 4,
  );
  const ids = new Set<string>();
  const sections = v.sections.map((value: unknown) => {
    const section = object(value, ["title", "entities"]);
    insist(
      Array.isArray(section.entities) &&
        section.entities.length >= 1 &&
        section.entities.length <= 8,
    );
    const entities = section.entities.map((value: unknown) => {
      const id = text(value, 100);
      insist(
        entityPattern.test(id) && ha.policy.entities.includes(id),
        "entity_not_allowed",
        403,
      );
      insist(!ids.has(id), "duplicate_view_entity");
      ids.add(id);
      return id;
    });
    return {
      title: ha.sanitize(text(section.title, 60)).slice(0, 60),
      entities,
    };
  });
  insist(ids.size <= 8, "view_entity_limit");
  return { title: ha.sanitize(text(v.title, 80)).slice(0, 80), sections };
}
async function build(
  ha: HAClient,
  value: unknown,
  api: ToolExecutionApi,
  context: Context,
): Promise<Canvas> {
  // Validate every section/ID before any request or cached-data return.
  const selection = layout(value, ha),
    layoutHash = digest(value);
  const existing = await api.snapshot(CanvasReceipt, api.taskId, context);
  if (existing?.value) {
    insist(existing.layoutHash === layoutHash, "view_task_conflict", 409);
    return existing.value;
  }
  const sections: Canvas["sections"] = [];
  for (const section of selection.sections) {
    const readings: CanvasReading[] = [];
    for (const id of section.entities) {
      const reading = await ha.state(id, context.abortSignal);
      readings.push({ ...reading, observedAt: Date.now() });
    }
    sections.push({ title: section.title, readings });
  }
  // Recheck current scope in the committing callback; no partial view on failure.
  return api.commit(async (tx) => {
    const finalSelection = layout(value, ha);
    const receipt = await tx.doc(CanvasReceipt, api.taskId);
    if (receipt.value) {
      insist(receipt.layoutHash === layoutHash, "view_task_conflict", 409);
      return JSON.parse(JSON.stringify(receipt.value)) as Canvas;
    }
    const canvas: Canvas = {
      taskId: String(api.taskId),
      title: finalSelection.title,
      sections: sections.map((s, i) => ({
        title: finalSelection.sections[i]!.title,
        readings: s.readings.map((r) => ({
          ...r,
          state: ha.sanitize(r.state).slice(0, 200),
          attributes: Object.fromEntries(
            Object.entries(r.attributes).map(([key, value]) => [
              key,
              typeof value === "string"
                ? ha.sanitize(value).slice(0, 200)
                : value,
            ]),
          ),
        })),
      })),
      source: "home_assistant",
      committedAt: Date.now(),
    };
    (await tx.doc(HomeCanvas, api.conversationId)).current = canvas;
    receipt.layoutHash = layoutHash;
    receipt.value = canvas;
    return canvas;
  }, context);
}
export function homeCanvasTool(ha: HAClient) {
  return defineTool({
    name: "ha_build_view",
    description:
      "Build/refresh this Home conversation's durable status canvas. Choose 1-4 named sections with up to 8 distinct exact configured entity IDs total; discover IDs first. The controller reads HA values and timestamps itself, then commits all or nothing. No HTML, URLs, service actions, live monitoring or model-supplied values. Saved readings are historical observations, not physical verification.",
    replay: "safe",
    outputLimits: { maxBytes: 48000 },
    parameters: Type.Object(
      {
        title: Type.String({ minLength: 1, maxLength: 80 }),
        sections: Type.Array(
          Type.Object(
            {
              title: Type.String({ minLength: 1, maxLength: 60 }),
              entities: Type.Array(
                Type.String({ pattern: entityPattern.source, maxLength: 100 }),
                { minItems: 1, maxItems: 8 },
              ),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 4 },
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (args, api, context) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(await build(ha, args, api, context)),
        },
      ],
    }),
  });
}
// Current-scope projection only. Previously committed transcript history remains history.
export function scopedCanvas(
  canvas: Canvas | null,
  entities: readonly string[],
): Canvas | null {
  if (!canvas) return null;
  const sections = canvas.sections
    .map((s) => ({
      title: s.title,
      readings: s.readings.filter((r) => entities.includes(r.entityId)),
    }))
    .filter((s) => s.readings.length);
  return sections.length ? { ...canvas, sections } : null;
}
