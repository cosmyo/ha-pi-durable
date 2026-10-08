// "Set up my Home World" in a Home chat: read the house (world_layout_get)
// and propose a layout (world_layout_propose). A proposal is validated like
// the editor's save plus model-repairable checks (bounds, unknown rooms,
// overlaps, every drawn area placed, decor limit) and stored as the owner's
// one DRAFT. It is never the saved layout: the owner keeps or discards it in
// the Home World preview (WorldStore.keepDraft / discardDraft). These tools
// read only the configured entity scope and never touch Home Assistant
// areas, devices or any configuration.
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ConversationId,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { Catalog } from "./documents.js";
import type { HAClient } from "./ha.js";
import { digest, entityPattern } from "./safety.js";
import {
  decorIdPattern,
  FLOOR_STYLES,
  mergeLayout,
  validateCustom,
  WORLD_GRID,
  WORLD_LIMITS,
  type AutoLayout,
  type WorldCustom,
} from "./world-layout.js";
import {
  buildWorld,
  draftSummary,
  liveDraft,
  WORLD_DRAFT_TTL_MS,
  WorldLayouts,
  type WorldOwnerLayout,
} from "./world.js";

export type ProposalError = { path: string; message: string };
type RoomInput = {
  name: unknown;
  x: unknown;
  y: unknown;
  w: unknown;
  h: unknown;
  floor: unknown;
};
export type ProposalInput = {
  cols?: unknown;
  rooms: Record<string, RoomInput>;
  devices?: Record<string, { room: unknown; fx: unknown; fy: unknown }>;
  keepAuto?: unknown[];
  note?: unknown;
};
const isInt = (v: unknown, lo: number, hi: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;
const fraction = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const overlaps = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const touches = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) =>
  ((a.x + a.w === b.x || b.x + b.w === a.x) &&
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) >= 1) ||
  ((a.y + a.h === b.y || b.y + b.h === a.y) &&
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) >= 1);

// Pure: every problem at once, each with the exact path, so the model can
// repair the whole proposal in one turn.
export function checkProposal(
  input: ProposalInput,
  context: {
    auto: AutoLayout;
    scope: readonly string[];
    base: WorldCustom | null;
    clean: (s: string) => string;
  },
):
  | {
      ok: true;
      custom: WorldCustom;
      warnings: string[];
      merged: ReturnType<typeof mergeLayout>;
    }
  | { ok: false; errors: ProposalError[] } {
  const errors: ProposalError[] = [];
  const fail = (path: string, message: string) => {
    if (errors.length < 40) errors.push({ path, message });
  };
  const cols =
    input.cols === undefined ? WORLD_GRID.cols : (input.cols as number);
  if (!isInt(cols, WORLD_GRID.cols, WORLD_GRID.maxCols))
    fail(
      "cols",
      `Use a whole number from ${WORLD_GRID.cols} to ${WORLD_GRID.maxCols}.`,
    );
  const autoRooms = new Map(context.auto.rooms.map((r) => [r.id, r] as const));
  const rooms = input.rooms ?? {};
  const ids = Object.keys(rooms);
  const decorIds = ids.filter((id) => decorIdPattern.test(id));
  if (decorIds.length > WORLD_LIMITS.decor)
    fail(
      "rooms",
      `At most ${WORLD_LIMITS.decor} decor spaces (balcony, garden…); found ${decorIds.length}.`,
    );
  const width = isInt(cols, WORLD_GRID.cols, WORLD_GRID.maxCols)
    ? cols
    : WORLD_GRID.maxCols;
  for (const id of ids) {
    const path = `rooms.${id}`;
    if (!autoRooms.has(id) && !decorIdPattern.test(id)) {
      fail(
        path,
        /^area:/.test(id)
          ? `No drawn room for ${id}: the area has no devices Hearth can show. Draw it as a decor:<name> space instead, or leave it out.`
          : `Unknown room id. Use one of the area room ids from world_layout_get (${[...autoRooms.keys()].slice(0, 30).join(", ")}) or decor:<a-z0-9_> for spaces without an area.`,
      );
      continue;
    }
    const r = rooms[id]!;
    if (!r || typeof r !== "object") {
      fail(path, "Expected {name, x, y, w, h, floor}.");
      continue;
    }
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name || name.length > 24 || CONTROL.test(name))
      fail(`${path}.name`, "Use 1–24 characters of plain text.");
    if (!isInt(r.w, 2, width))
      fail(`${path}.w`, `Width must be 2–${width} cells.`);
    if (!isInt(r.h, 2, 16)) fail(`${path}.h`, "Height must be 2–16 cells.");
    if (isInt(r.w, 2, width) && !isInt(r.x, 0, width - r.w))
      fail(
        `${path}.x`,
        `x must be 0–${width - r.w} so the room (w ${r.w}) fits ${width} columns.`,
      );
    if (isInt(r.h, 2, 16) && !isInt(r.y, 0, WORLD_GRID.maxRows - r.h))
      fail(`${path}.y`, `y must be 0–${WORLD_GRID.maxRows - r.h}.`);
    if (!(FLOOR_STYLES as readonly unknown[]).includes(r.floor))
      fail(`${path}.floor`, `Use one of ${FLOOR_STYLES.join(", ")}.`);
  }
  const keepAuto = new Set<string>();
  for (const [i, id] of (input.keepAuto ?? []).entries()) {
    if (typeof id !== "string" || !autoRooms.has(id))
      fail(`keepAuto.${i}`, "Not a drawn room id.");
    else keepAuto.add(id);
  }
  for (const room of context.auto.rooms)
    if (!Object.hasOwn(rooms, room.id) && !keepAuto.has(room.id))
      fail(
        `rooms.${room.id}`,
        `Not placed: ${room.id} (${room.name}). Place it (areas that are not physical rooms go in a row below the plan), or list it in keepAuto to keep its automatic position.`,
      );
  // Device places: drawn devices into rooms of this proposal.
  const drawn = new Set(context.auto.devices.map((d) => d.entityId));
  const roomIds = new Set([...autoRooms.keys(), ...decorIds]);
  const devices: WorldCustom["devices"] = {};
  for (const [id, place] of Object.entries(context.base?.devices ?? {}))
    if (drawn.has(id) && roomIds.has(place.room)) devices[id] = { ...place };
  for (const [id, place] of Object.entries(input.devices ?? {})) {
    const path = `devices.${id}`;
    if (!entityPattern.test(id) || !drawn.has(id)) {
      fail(path, "Not a drawn device (see devices in world_layout_get).");
      continue;
    }
    if (
      !place ||
      typeof place.room !== "string" ||
      !roomIds.has(place.room) ||
      !fraction(place.fx) ||
      !fraction(place.fy)
    ) {
      fail(
        path,
        "Use {room: a room id of this proposal, fx: 0–1, fy: 0–1} (fractions of the room's width and height).",
      );
      continue;
    }
    devices[id] = {
      room: place.room,
      fx: place.fx as number,
      fy: place.fy as number,
    };
  }
  if (errors.length) return { ok: false, errors };
  const raw = {
    rooms: Object.fromEntries(
      ids.map((id) => {
        const r = rooms[id]!;
        return [
          id,
          {
            name: (r.name as string).trim(),
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
            floor: r.floor,
          },
        ];
      }),
    ),
    devices,
    character: context.base?.character ?? { palette: 0, hat: "beanie" },
    pet: context.base?.pet ?? true,
    ...(cols !== WORLD_GRID.cols ? { cols } : {}),
  };
  let custom: WorldCustom;
  try {
    custom = validateCustom(raw, context.scope, context.clean);
  } catch {
    return {
      ok: false,
      errors: [{ path: "", message: "The layout did not validate." }],
    };
  }
  const merged = mergeLayout(context.auto, custom, context.scope);
  for (let i = 0; i < merged.rooms.length; i++)
    for (let j = i + 1; j < merged.rooms.length; j++) {
      const a = merged.rooms[i]!,
        b = merged.rooms[j]!;
      if (overlaps(a, b))
        fail(
          `rooms.${a.id}`,
          `Overlaps ${b.id}: ${a.id} is x ${a.x}–${a.x + a.w}, y ${a.y}–${a.y + a.h}; ${b.id} is x ${b.x}–${b.x + b.w}, y ${b.y}–${b.y + b.h}. Rooms may share an edge but not cells.`,
        );
    }
  if (errors.length) return { ok: false, errors };
  const warnings: string[] = [];
  const physical = merged.rooms.filter(
    (r) => !r.decor && r.id !== "unassigned",
  );
  for (const room of physical)
    if (
      physical.length > 1 &&
      !merged.rooms.some((o) => o.id !== room.id && touches(room, o))
    )
      warnings.push(
        `${room.id} shares no wall with another room, so it gets no door.`,
      );
  return { ok: true, custom, warnings: warnings.slice(0, 10), merged };
}

async function homeOwner(api: ToolExecutionApi, context: Context) {
  const session = (await api.snapshot(Catalog, context))?.items.find(
    (s) => s.id === api.conversationId,
  );
  return session && session.kind !== "workspace" ? session.owner : null;
}
const output = (value: Record<string, unknown>, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});
const emptyLayout = (): WorldOwnerLayout => ({
  revision: 0,
  custom: null,
  migrated: false,
  updated: 0,
});

const roomSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 24 }),
    x: Type.Integer({ minimum: 0, maximum: 63 }),
    y: Type.Integer({ minimum: 0, maximum: 63 }),
    w: Type.Integer({ minimum: 1, maximum: 64 }),
    h: Type.Integer({ minimum: 1, maximum: 64 }),
    floor: Type.String({ maxLength: 12 }),
  },
  { additionalProperties: false },
);

export function worldSetupTools(ha: HAClient, now: () => number = Date.now) {
  const scope = () => ha.policy.entities;
  const clean = (s: string) => ha.sanitize(s);
  const read = async (api: ToolExecutionApi, context: Context) => {
    const owner = await homeOwner(api, context);
    if (!owner) return null;
    const projection = await ha.cachedRegistry(now);
    const stored =
      (await api.snapshot(WorldLayouts, context))?.owners[owner] ??
      emptyLayout();
    return { owner, projection, stored, auto: buildWorld(projection, scope()) };
  };
  const get = defineTool({
    name: "world_layout_get",
    description:
      "Read the owner's Home World layout for setting it up: grid, drawn rooms (area room ids, names, x/y/w/h, floor, device counts), the Home Assistant areas in Hearth's read scope, unassigned device count, drawn devices and any pending draft. Read-only; bounded.",
    replay: "safe",
    outputLimits: { maxBytes: 16000 },
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (_args, api, context) => {
      const world = await read(api, context);
      if (!world)
        return output({ ok: false, error: "home_session_required" }, true);
      const { projection, stored, auto } = world;
      const merged = mergeLayout(auto.layout, stored.custom, scope());
      const count = (room: string) =>
        merged.devices.filter((d) => d.room === room).length;
      const draft = liveDraft(stored, now());
      return output({
        ok: true,
        registry: auto.registry,
        revision: stored.revision,
        customized: !!stored.custom,
        grid: merged.grid,
        limits: {
          cols: [WORLD_GRID.cols, WORLD_GRID.maxCols],
          maxRows: WORLD_GRID.maxRows,
          roomMin: 2,
          roomMaxHeight: 16,
          rooms: WORLD_LIMITS.rooms,
          decor: WORLD_LIMITS.decor,
        },
        floorStyles: FLOOR_STYLES,
        rooms: merged.rooms.slice(0, 40).map((r) => ({
          id: r.id,
          name: r.name,
          area: r.area,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
          floor: r.floor,
          level: r.level,
          ...(r.decor ? { decor: true } : {}),
          devices: count(r.id),
        })),
        // In-scope Home Assistant areas; drawn=false means it has no device
        // Hearth shows (only sensors marked diagnostic, …): no room for it.
        areas: (projection?.areas ?? []).slice(0, 60).map((a) => ({
          roomId: `area:${a.id}`,
          name: a.name,
          level: a.level,
          drawn: auto.layout.rooms.some((r) => r.id === `area:${a.id}`),
        })),
        unassignedDevices: count("unassigned"),
        devices: merged.devices.slice(0, WORLD_LIMITS.devices).map((d) => ({
          entityId: d.entityId,
          room: d.room,
          ...(d.device ? { device: d.device } : {}),
        })),
        draft: draft ? draftSummary(draft, auto.layout, scope()) : null,
      });
    },
  });
  const propose = defineTool({
    name: "world_layout_propose",
    description:
      "Propose a Home World layout (for example from the owner's floor plan). Rooms are keyed by area room id from world_layout_get (area:<id>, 'unassigned' for the shed) or decor:<name> for spaces without an area (balcony, garden; at most 8). Every drawn room must be placed or listed in keepAuto; rooms must fit the grid and may share edges but never cells. devices optionally places drawn devices ({room, fx, fy} fractions). Stores the owner's one draft and shows it as a preview with Keep/Discard; it never saves the layout and never changes Home Assistant. Returns errors with exact paths to fix.",
    replay: "safe",
    parameters: Type.Object(
      {
        cols: Type.Optional(
          Type.Integer({
            minimum: WORLD_GRID.cols,
            maximum: WORLD_GRID.maxCols,
          }),
        ),
        rooms: Type.Record(Type.String({ maxLength: 70 }), roomSchema),
        devices: Type.Optional(
          Type.Record(
            Type.String({ maxLength: 100 }),
            Type.Object(
              {
                room: Type.String({ maxLength: 70 }),
                fx: Type.Number({ minimum: 0, maximum: 1 }),
                fy: Type.Number({ minimum: 0, maximum: 1 }),
              },
              { additionalProperties: false },
            ),
          ),
        ),
        keepAuto: Type.Optional(
          Type.Array(Type.String({ maxLength: 70 }), { maxItems: 32 }),
        ),
        note: Type.String({ maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
    execute: async (args, api, context) => {
      const world = await read(api, context);
      if (!world)
        return output({ ok: false, error: "home_session_required" }, true);
      const { owner, stored, auto } = world;
      if (Object.keys(args.rooms).length > WORLD_LIMITS.rooms + 8)
        return output(
          {
            ok: false,
            errors: [{ path: "rooms", message: "Too many rooms." }],
          },
          true,
        );
      const checked = checkProposal(args, {
        auto: auto.layout,
        scope: scope(),
        base: stored.custom,
        clean,
      });
      if (!checked.ok)
        return output(
          {
            ok: false,
            errors: checked.errors,
            hint: "Nothing was stored. Fix every listed path and call world_layout_propose again.",
          },
          true,
        );
      const note = clean(args.note)
        .replace(/[\r\n]+/g, " ")
        .slice(0, 200);
      const created = now();
      const draft = {
        id: `wd_${digest({ task: api.taskId, custom: checked.custom }).slice(0, 20)}`,
        conversationId: api.conversationId as ConversationId as number,
        created,
        expires: created + WORLD_DRAFT_TTL_MS,
        note,
        custom: checked.custom,
      };
      await api.commit(async (tx) => {
        const doc = await tx.doc(WorldLayouts);
        const current = doc.owners[owner] ?? emptyLayout();
        // The saved layout and its revision stay untouched.
        doc.owners[owner] = { ...current, draft };
      }, context);
      const summary = draftSummary(draft, auto.layout, scope());
      const result = {
        ok: true,
        kind: "home_world_proposal",
        draftId: draft.id,
        rooms: summary.rooms,
        decor: summary.decor,
        cols: summary.cols,
        rows: summary.rows,
        note,
        warnings: checked.warnings,
        status:
          "Draft stored as a preview. The owner opens it from the card in this chat and taps Keep or Discard; it is not saved until they keep it. A new proposal replaces it.",
      };
      return { ...output(result), details: result };
    },
  });
  return [get, propose];
}
