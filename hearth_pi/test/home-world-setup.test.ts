// "Set up my Home World with Hearth": image attachments in Home chats,
// bundled skills, the world_layout_get / world_layout_propose tools, the
// per-owner draft (preview, keep, discard, expiry, restart) and the HTTP
// routes, through the real Pi Durable harness with the offline faux provider,
// a fake Home Assistant API and a fake registry WebSocket. All data is
// synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.js";
import { Actions, HAClient, haExtension } from "../src/ha.js";
import { appServer } from "../src/server.js";
import { Inputs } from "../src/documents.js";
import {
  HA_WEBSOCKET_URL,
  type SocketFactory,
  type SocketLike,
} from "../src/ha-websocket.js";
import {
  IMAGE_LIMITS,
  imageSize,
  parseImages,
  sniffImage,
  withoutImageData,
} from "../src/images.js";
import {
  bundledSkills,
  loadSkills,
  parseSkill,
  SKILLS_DIR,
} from "../src/skills.js";
import { checkProposal } from "../src/world-setup.js";
import { WORLD_DRAFT_TTL_MS, WorldStore, buildWorld } from "../src/world.js";
import { projectRegistry, type WorldCustom } from "../src/world-layout.js";
import { offline } from "./fixtures.js";

const TOKEN = "synthetic-supervisor-token";
const SCOPE = [
  "light.study_lamp",
  "light.bedroom_lamp",
  "switch.kitchen_kettle",
  "light.living_ceiling",
  "media_player.living_tv",
  "binary_sensor.hall_door",
  "sensor.bath_humidity",
  "sensor.router_uptime",
  "sensor.loose_battery",
];
const REGISTRY = {
  areas: [
    { area_id: "study", name: "Study", floor_id: null },
    { area_id: "bedroom", name: "Bedroom" },
    { area_id: "kitchen", name: "Kitchen" },
    { area_id: "living", name: "Living" },
    { area_id: "hall", name: "Hall" },
    { area_id: "bath", name: "Bath" },
    { area_id: "network", name: "Network" },
    { area_id: "private_cellar", name: "Private cellar" },
  ],
  devices: [],
  entities: [
    { entity_id: "light.study_lamp", area_id: "study" },
    { entity_id: "light.bedroom_lamp", area_id: "bedroom" },
    { entity_id: "switch.kitchen_kettle", area_id: "kitchen" },
    { entity_id: "light.living_ceiling", area_id: "living" },
    { entity_id: "media_player.living_tv", area_id: "living" },
    { entity_id: "binary_sensor.hall_door", area_id: "hall" },
    { entity_id: "sensor.bath_humidity", area_id: "bath" },
    { entity_id: "sensor.router_uptime", area_id: "network" },
    { entity_id: "sensor.loose_battery" },
    // Out of scope: never projected.
    { entity_id: "sensor.cellar_secret", area_id: "private_cellar" },
  ],
};
// The skill's worked example (synthetic two-row apartment with a balcony).
const APARTMENT = {
  cols: 28,
  rooms: {
    "area:bedroom": {
      name: "Bedroom",
      x: 0,
      y: 0,
      w: 9,
      h: 7,
      floor: "carpet",
    },
    "area:bath": { name: "Bath", x: 9, y: 0, w: 5, h: 7, floor: "tile" },
    "area:kitchen": { name: "Kitchen", x: 14, y: 0, w: 7, h: 7, floor: "tile" },
    "area:study": { name: "Study", x: 21, y: 0, w: 7, h: 7, floor: "carpet" },
    "area:hall": { name: "Hall", x: 0, y: 7, w: 8, h: 7, floor: "stone" },
    "area:living": { name: "Living", x: 8, y: 7, w: 20, h: 7, floor: "wood" },
    "decor:balcony": {
      name: "Balcony",
      x: 12,
      y: 14,
      w: 12,
      h: 3,
      floor: "grass",
    },
    "area:network": {
      name: "Network",
      x: 0,
      y: 18,
      w: 5,
      h: 3,
      floor: "stone",
    },
    unassigned: { name: "Unassigned", x: 5, y: 18, w: 5, h: 3, floor: "stone" },
  },
  note: "From your plan: 6 rooms, balcony along the living room.",
};

function registrySocket(registry = REGISTRY): SocketFactory {
  return (url) => {
    assert.equal(url, HA_WEBSOCKET_URL);
    const socket: SocketLike = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data) {
        const m = JSON.parse(data) as Record<string, unknown>;
        setImmediate(() => {
          if (m.type === "auth")
            return emit({
              type: m.access_token === TOKEN ? "auth_ok" : "auth_invalid",
            });
          const result =
            m.type === "config/area_registry/list"
              ? registry.areas
              : m.type === "config/device_registry/list"
                ? registry.devices
                : m.type === "config/entity_registry/list"
                  ? registry.entities
                  : null;
          emit({ id: m.id, type: "result", success: result !== null, result });
        });
      },
      close() {},
    };
    const emit = (value: unknown) =>
      socket.onmessage?.({ data: JSON.stringify(value) });
    setImmediate(() => emit({ type: "auth_required" }));
    return socket;
  };
}
function fakeHA(scope = SCOPE) {
  const policy = { enabled: false, entities: [...scope], services: [] };
  const ha = new HAClient(
    TOKEN,
    policy,
    (async () => new Response("missing", { status: 404 })) as typeof fetch,
    [],
    registrySocket(),
  );
  ha.actions.authorizeOwners(["local-admin", "owner", "other"]);
  return ha;
}

// Synthetic image bytes: valid headers, tiny bodies.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
function png(width: number, height: number) {
  const bytes = Buffer.from(PNG_1X1);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
function jpeg(width: number, height: number) {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}
function webp(width: number, height: number) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "latin1");
  bytes.write("VP8X", 12, "latin1");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}
const heic = () =>
  Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from("ftypheic", "latin1"),
    Buffer.alloc(16),
  ]);
const attach = (bytes: Buffer, mimeType: string) => ({
  mimeType,
  data: bytes.toString("base64"),
});

async function openRuntime(
  dir: string,
  ha: HAClient,
  provider = offline(),
  clock = { now: Date.now() },
) {
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [haExtension(ha, { now: () => clock.now })],
    [],
    undefined,
    ha.actions,
  );
  return { runtime, provider };
}
async function settle(runtime: Runtime, submission: number) {
  return (await runtime.harness.submission(
    submission as SubmissionId,
    ctx,
  ))!.wait(ctx);
}
type ToolResult = {
  role: "toolResult";
  toolName: string;
  isError: boolean;
  content: { type: string; text: string }[];
  details?: Record<string, unknown>;
};
async function toolResults(runtime: Runtime, owner: string, id: number) {
  const entries = (await (await runtime.session(owner, id)).context(ctx))
    .entries;
  return entries.flatMap((e) =>
    ((e as { model?: unknown[] }).model ?? []).filter(
      (m) => (m as { role?: string }).role === "toolResult",
    ),
  ) as ToolResult[];
}
// One owner turn in which the faux model calls one tool, then answers.
async function callTool(
  runtime: Runtime,
  faux: ReturnType<typeof offline>["faux"],
  owner: string,
  id: number,
  tool: string,
  args: unknown,
  key: string,
): Promise<Record<string, unknown> & { isError: boolean }> {
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(tool, args as Parameters<typeof fauxToolCall>[1]),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);
  await settle(runtime, await runtime.submit(owner, id, key, "Go"));
  const results = await toolResults(runtime, owner, id);
  const last = results[results.length - 1]!;
  assert.equal(last.toolName, tool);
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(last.content[0]!.text);
  } catch {
    value = { raw: last.content[0]?.text ?? "" };
  }
  return { ...value, isError: last.isError, details: last.details };
}
const lastUser = (messages: readonly Message[]) =>
  [...messages].reverse().find((m) => m.role === "user")!;
const imagesIn = (message: Message) =>
  Array.isArray(message.content)
    ? message.content.filter((b) => b.type === "image")
    : [];

test("image validation: magic bytes decide the type; size, count, dimensions and HEIC are refused", () => {
  assert.equal(sniffImage(png(10, 10)), "image/png");
  assert.equal(sniffImage(jpeg(10, 10)), "image/jpeg");
  assert.equal(sniffImage(webp(10, 10)), "image/webp");
  assert.equal(sniffImage(heic()), "heic");
  assert.equal(sniffImage(Buffer.from("<svg onload=alert(1)>")), null);
  assert.deepEqual(imageSize(png(640, 480), "image/png"), {
    width: 640,
    height: 480,
  });
  assert.deepEqual(imageSize(jpeg(2048, 1536), "image/jpeg"), {
    width: 2048,
    height: 1536,
  });
  assert.deepEqual(imageSize(webp(1200, 800), "image/webp"), {
    width: 1200,
    height: 800,
  });
  const ok = parseImages([
    attach(png(800, 600), "image/png"),
    attach(jpeg(800, 600), "image/jpeg"),
    attach(webp(800, 600), "image/webp"),
  ]);
  assert.deepEqual(
    ok.map((i) => i.mimeType),
    ["image/png", "image/jpeg", "image/webp"],
  );
  assert.deepEqual(parseImages(undefined), []);
  const refused: [unknown, RegExp][] = [
    [[attach(png(8, 8), "image/jpeg")], /image_type_mismatch/],
    [[attach(heic(), "image/heic")], /image_heic_unsupported/],
    [
      [attach(Buffer.from("GIF89a-----"), "image/gif")],
      /image_type_unsupported/,
    ],
    [
      [attach(Buffer.from("<svg></svg>"), "image/svg+xml")],
      /image_type_unsupported/,
    ],
    [[attach(png(5000, 10), "image/png")], /image_dimensions/],
    [[attach(png(0, 10), "image/png")], /invalid_image/],
    [
      Array(IMAGE_LIMITS.perMessage + 1).fill(attach(png(8, 8), "image/png")),
      /image_count/,
    ],
    [[{ mimeType: "image/png", data: "not base64!" }], /invalid_image/],
    [[{ mimeType: "image/png", data: "abc" }], /invalid_image/],
    [
      [{ mimeType: "image/png", data: "A".repeat(6 * 1024 * 1024) }],
      /image_too_large/,
    ],
    [[{ ...attach(png(8, 8), "image/png"), name: "x.png" }], /invalid_request/],
    ["not a list", /invalid_images/],
  ];
  for (const [value, error] of refused)
    assert.throws(() => parseImages(value), error);
  // Per-image byte cap after decoding.
  const big = Buffer.concat([png(100, 100), Buffer.alloc(IMAGE_LIMITS.bytes)]);
  assert.throws(
    () => parseImages([attach(big, "image/png")]),
    /image_too_large/,
  );
  // Snapshots never carry image bytes: entries get a reference instead.
  const view = withoutImageData({
    entries: [
      {
        id: 7,
        model: [
          {
            role: "user",
            content: [
              { type: "text", text: "plan" },
              { type: "image", mimeType: "image/png", data: "AAAA" },
            ],
          },
        ],
      },
    ],
    docs: {
      "pi.inbox": {
        items: [
          { content: [{ type: "image", mimeType: "image/png", data: "BBBB" }] },
        ],
      },
    },
  });
  assert(!JSON.stringify(view).includes("AAAA"));
  assert(!JSON.stringify(view).includes("BBBB"));
  assert.equal(
    (view.entries[0]!.model![0] as { content: { image?: string }[] })
      .content[1]!.image,
    "7/0",
  );
});

test("images reach the model as ImageContent, survive restart and are only served to their owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-images-"));
  const ha = fakeHA();
  let { runtime, provider } = await openRuntime(dir, ha);
  try {
    const id = await runtime.create("owner", "Plan", "plan-session-0001");
    let seen: Message | undefined;
    provider.faux.setResponses([
      (context) => {
        seen = lastUser(context.messages);
        return fauxAssistantMessage("I see a plan.");
      },
    ]);
    const plan = jpeg(1600, 1200);
    await settle(
      runtime,
      await runtime.submit("owner", id, "plan-input-0001", "Here is my plan", [
        attach(plan, "image/jpeg"),
      ]),
    );
    assert(seen);
    assert.deepEqual(imagesIn(seen!), [
      { type: "image", mimeType: "image/jpeg", data: plan.toString("base64") },
    ]);
    // Snapshot: a reference, no bytes; the image route returns the bytes.
    const snapshot = await runtime.snapshot("owner", id);
    assert.equal(snapshot.imageInput, true);
    const text = JSON.stringify(snapshot);
    assert(!text.includes(plan.toString("base64")));
    const ref = /"image":"(\d+)\/(\d+)"/.exec(text);
    assert(ref, "image reference in snapshot");
    const served = await runtime.image(
      "owner",
      id,
      Number(ref[1]),
      Number(ref[2]),
    );
    assert.equal(served.mimeType, "image/jpeg");
    assert(served.bytes.equals(plan));
    // Another owner can't see the session or its images.
    await assert.rejects(
      runtime.image("other", id, Number(ref[1]), 0),
      /session_not_found/,
    );
    await assert.rejects(
      runtime.image("owner", id, Number(ref[1]), 1),
      /image_not_found/,
    );
    // The inputs document drops the bytes once the message is placed.
    const inputs = await runtime.harness.snapshot(
      Inputs,
      id as ConversationId,
      ctx,
    );
    assert.equal(inputs?.requests["plan-input-0001"]?.images, undefined);
    // Idempotent retry with the same images; different images conflict.
    assert.equal(
      await runtime.submit("owner", id, "plan-input-0001", "Here is my plan", [
        attach(plan, "image/jpeg"),
      ]),
      (await runtime.harness.snapshot(Inputs, id as ConversationId, ctx))!
        .requests["plan-input-0001"]!.submissionId,
    );
    await assert.rejects(
      runtime.submit("owner", id, "plan-input-0001", "Here is my plan", [
        attach(png(8, 8), "image/png"),
      ]),
      /idempotency_conflict/,
    );

    // Restart: the image is still in the transcript, served, and sent again.
    await runtime.close();
    ({ runtime, provider } = await openRuntime(dir, fakeHA(), provider));
    const again = await runtime.image("owner", id, Number(ref[1]), 0);
    assert(again.bytes.equals(plan));
    let history: readonly Message[] = [];
    provider.faux.setResponses([
      (context) => {
        history = context.messages;
        return fauxAssistantMessage("Still there.");
      },
    ]);
    await settle(
      runtime,
      await runtime.submit("owner", id, "plan-input-0002", "And now?"),
    );
    assert.equal(history.flatMap(imagesIn).length, 1);

    // An input admitted with images but not yet placed (crash between the
    // two commits) is placed with its images on startup.
    await (await runtime.harness.conversation(
      id as ConversationId,
      ctx,
    ))!.commit(async (tx) => {
      (await tx.doc(Inputs, id as ConversationId)).requests["plan-input-0003"] =
        {
          hash: "synthetic",
          content: "Second plan",
          images: [
            { mimeType: "image/png", data: png(20, 20).toString("base64") },
          ],
          submissionId: 0,
          admitted: Date.now(),
        };
    }, ctx);
    await runtime.close();
    let drained: Message | undefined;
    provider.faux.setResponses([
      (context) => {
        drained = lastUser(context.messages);
        return fauxAssistantMessage("Got the second plan.");
      },
    ]);
    ({ runtime, provider } = await openRuntime(dir, fakeHA(), provider));
    await runtime.harness.waitForIdle(ctx);
    assert.equal(imagesIn(drained!).length, 1);
    assert.equal(
      (await runtime.harness.snapshot(Inputs, id as ConversationId, ctx))!
        .requests["plan-input-0003"]!.images,
      undefined,
    );
    // Conversation image budget.
    const many = Array(IMAGE_LIMITS.perMessage).fill(
      attach(png(8, 8), "image/png"),
    );
    provider.faux.setResponses(
      Array(4).fill(fauxAssistantMessage("ok")) as ReturnType<
        typeof fauxAssistantMessage
      >[],
    );
    let refused = false;
    for (let i = 0; i < 4 && !refused; i++)
      try {
        await settle(
          runtime,
          await runtime.submit("owner", id, `plan-many-000${i}`, "more", many),
        );
      } catch (error) {
        assert.match(String(error), /image_limit_create_session/);
        refused = true;
      }
    assert(refused, "conversation image limit");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a model without image input is refused clearly instead of dropping the image", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-noimage-"));
  const faux = fauxProvider({ models: [{ id: "text-only", input: ["text"] }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const provider = {
    faux,
    models,
    model: { provider: faux.getModel().provider, modelId: "text-only" },
  };
  const ha = fakeHA();
  const { runtime } = await openRuntime(dir, ha, provider);
  try {
    const id = await runtime.create("owner", "Plan", "noimage-session-01");
    await assert.rejects(
      runtime.submit("owner", id, "noimage-input-0001", "plan", [
        attach(png(8, 8), "image/png"),
      ]),
      /model_no_image_input/,
    );
    assert.equal((await runtime.snapshot("owner", id)).imageInput, false);
    // Nothing was admitted.
    assert.deepEqual(
      (await runtime.harness.snapshot(Inputs, id as ConversationId, ctx))
        ?.requests,
      {},
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bundled skills: listed in the Home prompt, loaded by name, fixed set, strict files", async () => {
  const skills = bundledSkills();
  assert(skills.some((s) => s.name === "home-world-setup"));
  const dir = await mkdtemp(join(tmpdir(), "hearth-skills-"));
  const ha = fakeHA();
  const { runtime, provider } = await openRuntime(dir, ha);
  try {
    const id = await runtime.create("owner", "Skills", "skills-session-01");
    let prompt = "";
    provider.faux.setResponses([
      (context) => {
        prompt = getCurrentSystemPrompt(context.messages);
        return fauxAssistantMessage("Hi.");
      },
    ]);
    await settle(
      runtime,
      await runtime.submit("owner", id, "skills-input-01", "Hi"),
    );
    assert.match(prompt, /<hearth_skills>/);
    assert.match(prompt, /- home-world-setup: Set up or redraw/);
    // Only names and descriptions, never the skill text.
    assert(!prompt.includes("## Grid math"));
    const loaded = await callTool(
      runtime,
      provider.faux,
      "owner",
      id,
      "hearth_skill",
      { name: "home-world-setup" },
      "skills-input-02",
    );
    assert.equal(loaded.ok, true);
    assert.match(String(loaded.instructions), /## Grid math/);
    const unknown = await callTool(
      runtime,
      provider.faux,
      "owner",
      id,
      "hearth_skill",
      { name: "nope" },
      "skills-input-03",
    );
    assert.equal(unknown.isError, true);
    assert.equal(unknown.error, "unknown_skill");
    assert.deepEqual(unknown.available, ["home-world-setup"]);
    for (const [i, name] of [
      "../../etc/passwd",
      "home-world-setup/../x",
      "/abs",
      ".hidden",
    ].entries()) {
      const traversal = await callTool(
        runtime,
        provider.faux,
        "owner",
        id,
        "hearth_skill",
        { name },
        `skills-trav-0${i}`,
      );
      assert.equal(traversal.isError, true, name);
      assert.notEqual(traversal.ok, true);
    }
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
  // Loader: strict frontmatter, name equals directory, size bound.
  const root = await mkdtemp(join(tmpdir(), "hearth-skill-files-"));
  try {
    await mkdir(join(root, "good-one"));
    await writeFile(
      join(root, "good-one", "SKILL.md"),
      "---\nname: good-one\ndescription: A synthetic skill.\n---\n\nStep one.\n",
    );
    await mkdir(join(root, "Not_Valid"));
    await writeFile(join(root, "Not_Valid", "SKILL.md"), "ignored");
    assert.deepEqual(
      loadSkills(root).map((s) => s.name),
      ["good-one"],
    );
    await mkdir(join(root, "mismatch"));
    await writeFile(
      join(root, "mismatch", "SKILL.md"),
      "---\nname: other\ndescription: x\n---\nbody\n",
    );
    assert.throws(() => loadSkills(root), /name must match/);
    await rm(join(root, "mismatch"), { recursive: true });
    await mkdir(join(root, "huge"));
    await writeFile(
      join(root, "huge", "SKILL.md"),
      `---\nname: huge\ndescription: x\n---\n${"a".repeat(30000)}`,
    );
    assert.throws(() => loadSkills(root), /larger than/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  for (const raw of [
    "no frontmatter",
    "---\nname: a\n---\nbody",
    "---\nname: a\ndescription: x\nextra: y\n---\nbody",
    "---\nname: a\ndescription: x\n---\n   ",
  ])
    assert.throws(() => parseSkill("a", raw));
});

test("repository hygiene: bundled skills hold no URLs or addresses beyond example domains", async () => {
  const names = await readdir(SKILLS_DIR);
  assert(names.length >= 1);
  for (const name of names) {
    const text = await readFile(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
    for (const url of text.match(/[a-z][a-z0-9+.-]*:\/\/[^\s)"'`]+/gi) ?? [])
      assert.match(
        new URL(url).hostname,
        /(^|\.)example(\.(com|org|net))?$/,
        url,
      );
    assert.doesNotMatch(text, /\b\d{1,3}(\.\d{1,3}){3}\b/, `${name}: IPv4`);
    assert.doesNotMatch(
      text,
      /\b[0-9a-f]{1,4}(:[0-9a-f]{1,4}){4,7}\b/i,
      `${name}: IPv6`,
    );
    assert.doesNotMatch(text, /\b(sk-|eyJ)[A-Za-z0-9_-]{8,}/, `${name}: token`);
    // Synthetic examples only: entity ids follow the example naming.
    for (const id of text.match(/\b[a-z_]+\.[a-z0-9_]+\b/g) ?? [])
      if (
        /^(light|switch|sensor|binary_sensor|climate|media_player)\./.test(id)
      )
        assert.match(id, /example|study|bedroom|kitchen|living|hall|bath/, id);
  }
});

const clean = (s: string) => s;
function apartmentAuto(scope = SCOPE) {
  return buildWorld(projectRegistry(REGISTRY, scope, clean), scope).layout;
}

test("world_layout_propose validation: bounds, cols, unknown ids, overlaps, missing rooms, decor limit", () => {
  const auto = apartmentAuto();
  const base = { auto, scope: SCOPE, base: null, clean };
  const ok = checkProposal(structuredClone(APARTMENT), base);
  assert(ok.ok, JSON.stringify(!ok.ok && ok.errors));
  assert.equal(ok.custom.cols, 28);
  assert(ok.custom.rooms["decor:balcony"]);
  // Nothing overlaps and every drawn area is placed.
  assert.equal(ok.merged.rooms.length, 9);
  const errorsOf = (
    change: (p: typeof APARTMENT & Record<string, unknown>) => void,
  ) => {
    const proposal = structuredClone(APARTMENT) as typeof APARTMENT &
      Record<string, unknown>;
    change(proposal);
    const result = checkProposal(proposal, base);
    assert(!result.ok, "expected errors");
    return result.errors;
  };
  const rooms = (p: typeof APARTMENT) =>
    p.rooms as Record<string, Record<string, unknown>>;
  assert.match(JSON.stringify(errorsOf((p) => (p.cols = 41))), /"path":"cols"/);
  assert.match(
    JSON.stringify(errorsOf((p) => (p.cols = 16))),
    /rooms.area:living.x|rooms.area:study.x/,
  );
  assert.match(
    JSON.stringify(errorsOf((p) => (rooms(p)["area:living"]!.y = 5))),
    /Overlaps/,
  );
  assert.match(
    JSON.stringify(
      errorsOf(
        (p) => (rooms(p)["area:ghost"] = { ...rooms(p)["area:study"]! }),
      ),
    ),
    /rooms.area:ghost/,
  );
  // Out-of-scope areas never get a room.
  assert.match(
    JSON.stringify(
      errorsOf(
        (p) =>
          (rooms(p)["area:private_cellar"] = {
            ...rooms(p)["area:study"]!,
            y: 30,
          }),
      ),
    ),
    /no devices Hearth can show/,
  );
  assert.match(
    JSON.stringify(errorsOf((p) => delete rooms(p)["area:hall"])),
    /Not placed: area:hall/,
  );
  // keepAuto leaves a room at its automatic position (then it overlaps).
  const kept = checkProposal(
    {
      ...structuredClone(APARTMENT),
      keepAuto: ["area:hall"],
      rooms: Object.fromEntries(
        Object.entries(structuredClone(APARTMENT).rooms).filter(
          ([k]) => k !== "area:hall",
        ),
      ),
    },
    base,
  );
  assert(!kept.ok && JSON.stringify(kept.errors).includes("Overlaps"));
  assert.match(
    JSON.stringify(
      errorsOf((p) => {
        for (let i = 0; i < 9; i++)
          rooms(p)[`decor:pot_${i}`] = {
            name: "Pot",
            x: i * 3,
            y: 40,
            w: 2,
            h: 2,
            floor: "grass",
          };
      }),
    ),
    /At most 8 decor/,
  );
  assert.match(
    JSON.stringify(errorsOf((p) => (rooms(p)["area:bath"]!.h = 17))),
    /rooms.area:bath.h/,
  );
  assert.match(
    JSON.stringify(errorsOf((p) => (rooms(p)["area:bath"]!.floor = "lava"))),
    /rooms.area:bath.floor/,
  );
  assert.match(
    JSON.stringify(
      errorsOf((p) => (rooms(p)["area:bath"]!.name = "x".repeat(25))),
    ),
    /rooms.area:bath.name/,
  );
  assert.match(
    JSON.stringify(
      errorsOf(
        (p) =>
          (p.devices = {
            "sensor.cellar_secret": { room: "area:bath", fx: 0.5, fy: 0.5 },
          }),
      ),
    ),
    /devices.sensor.cellar_secret/,
  );
  // A device placed by the owner, into a room of the proposal.
  const placed = checkProposal(
    {
      ...structuredClone(APARTMENT),
      devices: {
        "light.living_ceiling": { room: "decor:balcony", fx: 0.5, fy: 0.5 },
      },
    },
    base,
  );
  assert(placed.ok);
  assert.equal(
    placed.merged.devices.find((d) => d.entityId === "light.living_ceiling")!
      .room,
    "decor:balcony",
  );
  // A room without any shared wall is warned about.
  const lonely = checkProposal(
    {
      ...structuredClone(APARTMENT),
      rooms: {
        ...structuredClone(APARTMENT).rooms,
        "area:study": {
          name: "Study",
          x: 21,
          y: 30,
          w: 7,
          h: 7,
          floor: "carpet",
        },
      },
    },
    base,
  );
  assert(lonely.ok && lonely.warnings.some((w) => w.includes("area:study")));
});

async function setupServer(clock = { now: Date.now() }, dir?: string) {
  dir ??= await mkdtemp(join(tmpdir(), "hearth-setup-"));
  const provider = offline();
  const ha = fakeHA();
  const cfg = {
    mode: "local" as const,
    host: "127.0.0.1",
    port: 8099,
    origin: "http://127.0.0.1:8099",
    password: "synthetic-local-password-0001",
    authorizedUsers: [],
    dataDir: dir,
    provider: "offline" as const,
    model: "test",
    policy: ha.policy,
    haToken: TOKEN,
    apiKey: "synthetic-provider-key",
  };
  const { runtime } = await openRuntime(dir, ha, provider, clock);
  const app = appServer(cfg, runtime, new Actions(runtime, ha));
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  cfg.origin = base;
  const authorization = `Basic ${Buffer.from(`hearth:${cfg.password}`).toString("base64")}`;
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { authorization } });
  const boot = await get("/api/bootstrap");
  const csrf = (await boot.json()).csrf;
  const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
  const post = (
    path: string,
    value: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization,
        cookie,
        origin: base,
        "x-hearth-csrf": csrf,
        "content-type": "application/json",
        ...extra,
      },
      body: typeof value === "string" ? value : JSON.stringify(value),
    });
  return {
    dir,
    runtime,
    provider,
    ha,
    get,
    post,
    base,
    async close(keep = false) {
      await app.close();
      if (!keep) await rm(dir!, { recursive: true, force: true });
    },
  };
}

test("image upload over HTTP: auth, CSRF, validation, and the owner-checked image route", async () => {
  const s = await setupServer();
  try {
    const { id } = await (
      await s.post("/api/sessions", {
        title: "Plan",
        requestId: "http-plan-session",
      })
    ).json();
    const body = {
      requestId: "http-plan-input-01",
      content: "My floor plan",
      images: [attach(png(1024, 768), "image/png")],
    };
    assert.equal(
      (
        await fetch(`${s.base}/api/sessions/${id}/inputs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await s.post(`/api/sessions/${id}/inputs`, body, {
          "x-hearth-csrf": "",
        })
      ).status,
      403,
    );
    for (const [images, status, error] of [
      [[attach(heic(), "image/heic")], 415, "image_heic_unsupported"],
      [[attach(png(8, 8), "image/webp")], 415, "image_type_mismatch"],
      [Array(5).fill(attach(png(8, 8), "image/png")), 413, "image_count"],
    ] as const) {
      const response = await s.post(`/api/sessions/${id}/inputs`, {
        ...body,
        requestId: `http-bad-${error}`.slice(0, 40),
        images,
      });
      assert.equal(response.status, status, error);
      assert.equal((await response.json()).error, error);
    }
    // Oversized body is refused before it is read.
    const huge = await s.post(`/api/sessions/${id}/inputs`, {
      ...body,
      requestId: "http-huge-input-1",
      images: [{ mimeType: "image/png", data: "A".repeat(15 * 1024 * 1024) }],
    });
    assert.equal(huge.status, 413);
    s.provider.faux.setResponses([
      fauxAssistantMessage("Thanks for the plan."),
    ]);
    const accepted = await s.post(`/api/sessions/${id}/inputs`, body);
    assert.equal(accepted.status, 202);
    await settle(s.runtime, (await accepted.json()).submissionId);
    const snapshot = await (await s.get(`/api/sessions/${id}/snapshot`)).json();
    const ref = /"image":"(\d+)\/(\d+)"/.exec(JSON.stringify(snapshot));
    assert(ref);
    assert.equal(snapshot.imageInput, true);
    const path = `/api/sessions/${id}/images/${ref[1]}/${ref[2]}`;
    assert.equal((await fetch(`${s.base}${path}`)).status, 401);
    const image = await s.get(path);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      image.headers.get("content-security-policy")!,
      /img-src 'self' blob:/,
    );
    assert(Buffer.from(await image.arrayBuffer()).equals(png(1024, 768)));
    assert.equal(
      (await s.get(`/api/sessions/${id}/images/${ref[1]}/3`)).status,
      404,
    );
    assert.equal(
      (await s.get(`/api/sessions/${id}/images/999999/0`)).status,
      404,
    );
    assert.equal(
      (await s.get(`/api/sessions/${Number(id) + 50}/images/${ref[1]}/0`))
        .status,
      404,
    );
    assert.equal(
      (await s.get(`/api/sessions/${id}/images/${ref[1]}/0?x=1`)).status,
      400,
    );
  } finally {
    await s.close();
  }
});

// Per-user customization P1 pre-flight check: image attachments must be
// owner/session-isolated at both the HTTP route (runtime.session(owner, id)
// re-checks ownership before any image is served) and storage (an image's
// bytes live only inside its own conversation's durable transcript, read
// through conversation.context() scoped to that one conversation id —
// never a shared bucket a differently owned route could reach).
test("image attachments are isolated per owner and session: another owner's authenticated HTTP request never reaches them, by id or by guessing another session's image", async () => {
  const s = await setupServer();
  try {
    // "other" owner's image, created directly (this server's local HTTP auth
    // always resolves to one owner, "local-admin"; cross-owner access is
    // exercised the same way memory-http.test.ts and apps tests do: a second
    // owner's data is real, created through the runtime, and the HTTP
    // boundary is what is being proven, not a second login).
    const otherId = await s.runtime.create(
      "other-owner",
      "Other owner's plan",
      "isolation-create-0001",
    );
    s.provider.faux.setResponses([
      fauxAssistantMessage("Thanks for the plan."),
    ]);
    const otherSubmission = await s.runtime.submit(
      "other-owner",
      otherId,
      "isolation-input-0001",
      "My floor plan",
      [attach(png(1024, 768), "image/png")],
    );
    await settle(s.runtime, otherSubmission);
    const otherSnapshot = await s.runtime.snapshot("other-owner", otherId);
    const otherRef = /"image":"(\d+)\/(\d+)"/.exec(
      JSON.stringify(otherSnapshot),
    );
    assert(otherRef, "the other owner's message carries an image reference");

    // local-admin's own session, for a same-shaped same-owner control case.
    const { id: ownId } = await (
      await s.post("/api/sessions", {
        title: "My own plan",
        requestId: "isolation-own-0001",
      })
    ).json();

    // The HTTP-authenticated owner (local-admin) can never fetch the other
    // owner's image: not at the other owner's own session id, and not by
    // pairing the other owner's session id with local-admin's own session's
    // route shape — every combination 404s like the image never existed.
    assert.equal(
      (
        await s.get(
          `/api/sessions/${otherId}/images/${otherRef[1]}/${otherRef[2]}`,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await s.get(
          `/api/sessions/${ownId}/images/${otherRef[1]}/${otherRef[2]}`,
        )
      ).status,
      404,
    );

    // Direct runtime.image() (what the route calls) is owner-checked the
    // same way: session(owner, id) re-reads ownership before any bytes are
    // ever read from that conversation's own transcript.
    await assert.rejects(
      s.runtime.image(
        "local-admin",
        otherId,
        Number(otherRef[1]),
        Number(otherRef[2]),
      ),
      /session_not_found/,
    );
    // The true owner can still read it: proves the 404s above are an
    // isolation boundary, not a broken route.
    const own = await s.runtime.image(
      "other-owner",
      otherId,
      Number(otherRef[1]),
      Number(otherRef[2]),
    );
    assert(own.bytes.equals(png(1024, 768)));
  } finally {
    await s.close();
  }
});

test("Hearth sets up the Home World: image → skill → read → propose → preview → keep", async () => {
  const clock = { now: Date.now() };
  const s = await setupServer(clock);
  let closed = false;
  try {
    const { id } = await (
      await s.post("/api/sessions", {
        title: "Home view",
        requestId: "setup-session-001",
      })
    ).json();
    let sawImage = false;
    let getResult: Record<string, unknown> = {};
    s.provider.faux.setResponses([
      (context) => {
        sawImage = imagesIn(lastUser(context.messages)).length === 1;
        return fauxAssistantMessage(
          fauxToolCall("hearth_skill", { name: "home-world-setup" }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage(fauxToolCall("world_layout_get", {}), {
        stopReason: "toolUse",
      }),
      (context) => {
        const last = context.messages[context.messages.length - 1]!;
        getResult = JSON.parse(
          (last.content as { type: string; text: string }[])[0]!.text,
        );
        return fauxAssistantMessage(
          fauxToolCall("world_layout_propose", APARTMENT as never),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage(
        "Open the preview from the card to Keep or Discard it.",
      ),
    ]);
    const accepted = await s.post(`/api/sessions/${id}/inputs`, {
      requestId: "setup-input-0001",
      content: "Set up my home view. Here is my floor plan.",
      images: [attach(jpeg(2048, 1024), "image/jpeg")],
    });
    assert.equal(accepted.status, 202);
    await settle(s.runtime, (await accepted.json()).submissionId);
    assert(sawImage, "model received the plan image");
    // world_layout_get: bounded, scope-respecting.
    assert.equal(getResult.ok, true);
    const getText = JSON.stringify(getResult);
    assert(getText.length < 16000);
    assert(!getText.includes("cellar"));
    assert(!getText.includes(TOKEN));
    assert.equal(getResult.unassignedDevices, 1);
    assert.deepEqual(
      (getResult.areas as { roomId: string }[]).map((a) => a.roomId).sort(),
      [
        "area:bath",
        "area:bedroom",
        "area:hall",
        "area:kitchen",
        "area:living",
        "area:network",
        "area:study",
      ],
    );
    const results = await toolResults(s.runtime, "local-admin", id);
    const proposal = results.find(
      (r) => r.toolName === "world_layout_propose",
    )!;
    assert.equal(proposal.isError, false);
    assert.equal(proposal.details?.kind, "home_world_proposal");
    assert.equal(proposal.details?.cols, 28);
    assert.equal(proposal.details?.decor, 1);
    const draftId = proposal.details?.draftId as string;
    // The saved layout is untouched; GET /api/world names the draft.
    const world = await (await s.get("/api/world")).json();
    assert.equal(world.customized, false);
    assert.equal(world.revision, 0);
    assert.equal(world.grid.cols, 16);
    assert.equal(world.draft.id, draftId);
    assert.equal(world.draft.conversationId, id);
    // Preview: the merged draft structure.
    const preview = await (await s.get("/api/world/draft")).json();
    assert.equal(preview.preview, true);
    assert.equal(preview.grid.cols, 28);
    assert(
      preview.rooms.some(
        (r: { id: string; decor?: boolean }) =>
          r.id === "decor:balcony" && r.decor,
      ),
    );
    // Keep: CSRF, exact draft id, revision checked.
    assert.equal(
      (
        await s.post(
          "/api/world/draft/keep",
          { baseRevision: 0, draftId },
          { "x-hearth-csrf": "" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await s.post("/api/world/draft/keep", {
          baseRevision: 0,
          draftId: "wd_other",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await s.post("/api/world/draft/keep", {
          baseRevision: 0,
          draftId,
          extra: 1,
        })
      ).status,
      400,
    );
    // Someone saved meanwhile: keeping on the old revision conflicts.
    const saved = await s.post("/api/world/layout", {
      baseRevision: 0,
      layout: {
        rooms: {},
        devices: {},
        character: { palette: 1, hat: "cap" },
        pet: false,
      },
    });
    assert.equal(saved.status, 200);
    const conflict = await s.post("/api/world/draft/keep", {
      baseRevision: 0,
      draftId,
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, "world_layout_conflict");
    // Restart before keeping: the draft survives.
    await s.close(true);
    closed = true;
    const t = await setupServer(clock, s.dir);
    try {
      const kept = await t.post("/api/world/draft/keep", {
        baseRevision: 1,
        draftId,
      });
      assert.equal(kept.status, 200);
      const after = await kept.json();
      assert.equal(after.revision, 2);
      assert.equal(after.customized, true);
      assert.equal(after.draft, null);
      assert.equal(after.grid.cols, 28);
      assert.equal(after.custom.cols, 28);
      assert(after.custom.rooms["decor:balcony"]);
      assert.equal(
        after.rooms.find((r: { id: string }) => r.id === "area:living").w,
        20,
      );
      assert.equal((await t.get("/api/world/draft")).status, 404);
      // Reset to auto still works afterwards.
      const reset = await t.post("/api/world/reset", { baseRevision: 2 });
      assert.equal(reset.status, 200);
      assert.equal((await reset.json()).grid.cols, 16);
    } finally {
      await t.close();
    }
  } finally {
    if (!closed) await s.close();
  }
});

test("drafts are per owner, replaced by a new proposal, discarded and expire", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-drafts-"));
  const clock = { now: Date.now() };
  const ha = fakeHA();
  const { runtime, provider } = await openRuntime(dir, ha, offline(), clock);
  try {
    const store = new WorldStore(runtime, ha, () => clock.now);
    const id = await runtime.create("owner", "Home", "drafts-session-01");
    const first = await callTool(
      runtime,
      provider.faux,
      "owner",
      id,
      "world_layout_propose",
      APARTMENT,
      "drafts-input-01",
    );
    assert.equal(first.ok, true);
    assert.equal((await store.get("owner")).draft?.id, first.draftId);
    // Other owners see neither the draft nor a preview.
    assert.equal((await store.get("other")).draft, null);
    await assert.rejects(store.draft("other"), /world_draft_not_found/);
    await assert.rejects(
      store.keepDraft("other", { baseRevision: 0, draftId: first.draftId }),
      /world_draft_not_found/,
    );
    await assert.rejects(
      store.discardDraft("other", { draftId: first.draftId }),
      /world_draft_not_found/,
    );
    // An invalid proposal stores nothing and keeps the earlier draft.
    const bad = await callTool(
      runtime,
      provider.faux,
      "owner",
      id,
      "world_layout_propose",
      {
        ...APARTMENT,
        rooms: {
          ...APARTMENT.rooms,
          "area:hall": { ...APARTMENT.rooms["area:hall"], x: 3 },
        },
      },
      "drafts-input-02",
    );
    assert.equal(bad.isError, true);
    assert.match(JSON.stringify(bad.errors), /Overlaps/);
    assert.equal((await store.get("owner")).draft?.id, first.draftId);
    // Out-of-range cols never reach the tool (schema).
    const wide = await callTool(
      runtime,
      provider.faux,
      "owner",
      id,
      "world_layout_propose",
      { ...APARTMENT, cols: 64 },
      "drafts-input-03",
    );
    assert.equal(wide.isError, true);
    // A new proposal replaces the draft ("the balcony runs along the whole living room").
    const second = await callTool(
      runtime,
      provider.faux,
      "owner",
      id,
      "world_layout_propose",
      {
        ...APARTMENT,
        rooms: {
          ...APARTMENT.rooms,
          "decor:balcony": { ...APARTMENT.rooms["decor:balcony"], x: 8, w: 20 },
        },
      },
      "drafts-input-04",
    );
    assert.equal(second.ok, true);
    assert.notEqual(second.draftId, first.draftId);
    assert.equal((await store.get("owner")).draft?.id, second.draftId);
    await assert.rejects(
      store.keepDraft("owner", { baseRevision: 0, draftId: first.draftId }),
      /world_draft_not_found/,
    );
    // Discard leaves the saved layout and its revision alone.
    const discarded = await store.discardDraft("owner", {
      draftId: second.draftId,
    });
    assert.equal(discarded.draft, null);
    assert.equal(discarded.revision, 0);
    assert.equal(discarded.customized, false);
    // Expiry: a week later the draft is gone.
    const third = await callTool(
      runtime,
      provider.faux,
      "owner",
      id,
      "world_layout_propose",
      APARTMENT,
      "drafts-input-05",
    );
    clock.now += WORLD_DRAFT_TTL_MS + 1000;
    assert.equal((await store.get("owner")).draft, null);
    await assert.rejects(store.draft("owner"), /world_draft_not_found/);
    await assert.rejects(
      store.keepDraft("owner", { baseRevision: 0, draftId: third.draftId }),
      /world_draft_not_found/,
    );
    // world_layout_get reports the pending draft and is bounded.
    const fourth = await callTool(
      runtime,
      provider.faux,
      "owner",
      id,
      "world_layout_propose",
      APARTMENT,
      "drafts-input-06",
    );
    const got = await callTool(
      runtime,
      provider.faux,
      "owner",
      id,
      "world_layout_get",
      {},
      "drafts-input-07",
    );
    assert.equal((got.draft as { id: string }).id, fourth.draftId);
    assert.equal(got.revision, 0);
    // Keeping keeps the owner's character and pet from their saved layout.
    const saved = await store.save("owner", {
      baseRevision: 0,
      layout: {
        rooms: {},
        devices: {},
        character: { palette: 2, hat: "crown" },
        pet: false,
      },
    });
    const fifth = await callTool(
      runtime,
      provider.faux,
      "owner",
      id,
      "world_layout_propose",
      APARTMENT,
      "drafts-input-08",
    );
    const kept = await store.keepDraft("owner", {
      baseRevision: saved.revision,
      draftId: fifth.draftId,
    });
    assert.deepEqual(kept.character, { palette: 2, hat: "crown" });
    assert.equal(kept.pet, false);
    assert.equal((kept.custom as WorldCustom).cols, 28);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
