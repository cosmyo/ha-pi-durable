import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { SubmissionId } from "@earendil-works/pi-durable";
import type { Runtime } from "../src/runtime.js";
import { HAClient } from "../src/ha.js";
import type { offline } from "./fixtures.js";

// Synthetic HAS/1 app, HA fake and faux-model tool call shared by app tests.
export const SCOPE = [
  "sensor.washer_state",
  "sensor.washer_power",
  "light.hall",
  "sensor.gone",
];
export function laundrySpec(extra: Record<string, unknown> = {}) {
  return {
    specVersion: "has/1",
    title: "Laundry",
    summary: "Washer at a glance",
    scope: {
      entities: ["sensor.washer_state", "sensor.washer_power", "light.hall"],
    },
    root: "main",
    elements: {
      main: {
        type: "Stack",
        children: ["washer", "power", "chart", "fold", "loads", "note", "hall"],
      },
      washer: {
        type: "EntityTile",
        props: { entity: "sensor.washer_state", label: "Washer" },
      },
      power: {
        type: "EntityValue",
        props: { entity: "sensor.washer_power", label: "Power" },
      },
      chart: {
        type: "HistoryChart",
        props: { entities: ["sensor.washer_power"], hours: 6 },
      },
      fold: {
        type: "Checklist",
        props: { stateKey: "fold", items: ["Towels", "Shirts"] },
      },
      loads: {
        type: "Counter",
        props: { stateKey: "loads", label: "Loads", min: 0, max: 3 },
      },
      note: { type: "Note", props: { stateKey: "note", maxLength: 50 } },
      hall: {
        type: "ToggleAction",
        props: { entity: "light.hall", label: "Hall light" },
      },
    },
    ...extra,
  };
}
export function fakeHA(
  options: {
    policy?: { enabled: boolean; entities: string[]; services: string[] };
    post?: () => Promise<Response>;
  } = {},
) {
  const states: Record<string, string> = {
    "sensor.washer_state": "running",
    "sensor.washer_power": "512.5",
    "light.hall": "off",
  };
  const gets: string[] = [];
  const posts: string[] = [];
  const policy = options.policy ?? {
    enabled: true,
    entities: [...SCOPE],
    services: ["light.turn_on", "light.turn_off"],
  };
  const ha = new HAClient("synthetic-supervisor-token", policy, (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const path = String(url).replace("http://supervisor/core/api/", "");
    if (init?.method === "POST") {
      posts.push(path);
      if (options.post) return options.post();
      const entity = JSON.parse(String(init.body)).entity_id;
      states[entity] = path.endsWith("turn_on") ? "on" : "off";
      return Response.json([]);
    }
    gets.push(path);
    if (path === "services")
      return Response.json([
        { domain: "light", services: { turn_on: {}, turn_off: {} } },
      ]);
    if (path.startsWith("history/period/")) {
      const id = decodeURIComponent(/filter_entity_id=([^&]+)/.exec(path)![1]!);
      const now = Date.now();
      return Response.json([
        [
          {
            entity_id: id,
            state: "10",
            last_changed: new Date(now - 5 * 3600000).toISOString(),
          },
          {
            state: "500",
            last_changed: new Date(now - 3600000).toISOString(),
          },
        ],
      ]);
    }
    const id = decodeURIComponent(path.replace("states/", ""));
    if (!(id in states)) return new Response("missing", { status: 404 });
    return Response.json({
      entity_id: id,
      state: states[id],
      attributes: {
        friendly_name: `<img src=x onerror=alert(1)> ${id} synthetic-supervisor-token`,
        unit_of_measurement: id === "sensor.washer_power" ? "W" : undefined,
        secret: "must-not-export",
      },
    });
  }) as typeof fetch);
  ha.actions.authorizeOwners(["owner", "other"]);
  return { ha, states, gets, posts, policy };
}
export async function call(
  runtime: Runtime,
  faux: ReturnType<typeof offline>["faux"],
  owner: string,
  id: number,
  tool: string,
  args: unknown,
  key: string,
) {
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(tool, args as Parameters<typeof fauxToolCall>[1]),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);
  const submission = await runtime.submit(owner, id, key, "Make me an app");
  await (await runtime.harness.submission(
    submission as SubmissionId,
    ctx,
  ))!.wait(ctx);
  const entries = (await (await runtime.session(owner, id)).context(ctx))
    .entries;
  const results = entries.flatMap((e) =>
    ((e as { model?: unknown[] }).model ?? []).filter(
      (m) => (m as { role?: string }).role === "toolResult",
    ),
  ) as { toolName: string; isError: boolean; content: { text: string }[] }[];
  const last = results[results.length - 1]!;
  assert.equal(last.toolName, tool);
  return { ...JSON.parse(last.content[0]!.text), isError: last.isError };
}
