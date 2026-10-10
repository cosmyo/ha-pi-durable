// Synthetic Home Assistant with one shared to-do list (todo.example_groceries)
// and one light, over a fake REST transport and a fake read-only socket.
import { HAClient } from "../src/ha.js";
import type { Policy } from "../src/config.js";
import type { SocketFactory, SocketLike } from "../src/ha-websocket.js";

export const TOKEN = "synthetic-supervisor-token";
export const GROCERIES = "todo.example_groceries";
export type FakeItem = {
  uid: string;
  summary: string;
  status: string;
  due?: string;
  description?: string;
};
export type FakeList = { name: string; features: number; items: FakeItem[] };
export function fakeListHA(
  options: {
    policy?: Policy;
    // Replaces the POST behaviour (e.g. a transport failure).
    post?: (path: string, body: Record<string, unknown>) => Promise<Response>;
    lists?: Record<string, FakeList>;
    owners?: string[];
  } = {},
) {
  const lists: Record<string, FakeList> = options.lists ?? {
    [GROCERIES]: {
      name: "Groceries",
      features: 1 | 2 | 4,
      items: [
        { uid: "u1", summary: "Oat milk", status: "needs_action" },
        { uid: "u2", summary: "Bread", status: "completed" },
      ],
    },
  };
  const lights: Record<string, string> = { "light.example": "off" };
  const gets: string[] = [];
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const frames: Record<string, unknown>[] = [];
  let next = 100;
  const policy: Policy = options.policy ?? {
    enabled: true,
    entities: [GROCERIES, "light.example"],
    services: [
      "todo.add_item",
      "todo.update_item",
      "todo.remove_item",
      "light.turn_on",
      "light.turn_off",
    ],
  };
  const state = (id: string) =>
    id in lists
      ? {
          entity_id: id,
          state: String(
            lists[id]!.items.filter((i) => i.status === "needs_action").length,
          ),
          attributes: {
            friendly_name: lists[id]!.name,
            supported_features: lists[id]!.features,
          },
        }
      : id in lights
        ? { entity_id: id, state: lights[id], attributes: {} }
        : null;
  const apply = (path: string, body: Record<string, unknown>) => {
    const list = lists[String(body.entity_id)];
    if (path.startsWith("services/light/")) {
      lights[String(body.entity_id)] = path.endsWith("turn_on") ? "on" : "off";
      return;
    }
    if (!list) return;
    if (path === "services/todo/add_item")
      list.items.push({
        uid: `u${next++}`,
        summary: String(body.item),
        status: "needs_action",
      });
    if (path === "services/todo/update_item") {
      const item = list.items.find((i) => i.uid === body.item);
      if (item && typeof body.status === "string") item.status = body.status;
      if (item && typeof body.rename === "string") item.summary = body.rename;
    }
    if (path === "services/todo/remove_item")
      list.items = list.items.filter(
        (i) => !(body.item as string[]).includes(i.uid),
      );
  };
  const transport = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const path = String(url).replace("http://supervisor/core/api/", "");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path, body });
      if (options.post) return options.post(path, body);
      apply(path, body);
      return Response.json([]);
    }
    gets.push(path);
    if (path === "services")
      return Response.json([
        { domain: "light", services: { turn_on: {}, turn_off: {} } },
        {
          domain: "todo",
          services: { add_item: {}, update_item: {}, remove_item: {} },
        },
      ]);
    if (path === "states")
      return Response.json(
        [...Object.keys(lists), ...Object.keys(lights)].map(state),
      );
    const value = state(decodeURIComponent(path.replace("states/", "")));
    return value
      ? Response.json(value)
      : new Response("missing", { status: 404 });
  }) as typeof fetch;
  const socket: SocketFactory = () => {
    const s: SocketLike = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data) {
        const m = JSON.parse(data) as Record<string, unknown>;
        frames.push(m);
        setImmediate(() => {
          if (m.type === "auth")
            return emit({
              type: m.access_token === TOKEN ? "auth_ok" : "auth_invalid",
            });
          const list =
            m.type === "todo/item/list" ? lists[String(m.entity_id)] : null;
          emit(
            list
              ? {
                  id: m.id,
                  type: "result",
                  success: true,
                  result: { items: JSON.parse(JSON.stringify(list.items)) },
                }
              : {
                  id: m.id,
                  type: "result",
                  success: false,
                  error: { code: "not_found", message: "Entity not found" },
                },
          );
        });
      },
      close() {},
    };
    const emit = (value: unknown) =>
      s.onmessage?.({ data: JSON.stringify(value) });
    setImmediate(() => emit({ type: "auth_required" }));
    return s;
  };
  const ha = new HAClient(TOKEN, policy, transport, [], socket);
  ha.actions.authorizeOwners(options.owners ?? ["owner", "other"]);
  return { ha, lists, lights, gets, posts, frames, policy };
}
