import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { HAClient, haExtension, Actions } from "../src/ha.js";
import { Runtime } from "../src/runtime.js";
import {
  Catalog,
  HomePermissions,
  Proposals,
  type JudgeRecord,
} from "../src/documents.js";
import { FULL_ACKNOWLEDGEMENT } from "../src/home-actions.js";
import {
  householdRoles,
  loadConfig,
  type Config,
  type HouseholdRole,
} from "../src/config.js";
import { ROLE_DENIED_TOOLS, roleCapabilities } from "../src/roles.js";
import { sharedMemorySection } from "../src/memory.js";
import { appServer } from "../src/server.js";
import { offline } from "./fixtures.js";

const OWNER = "user-owner-a";
const MEMBER = "user-member-b";
const GUEST = "user-guest-c";
const LAMP = "light.example_lamp";
const action = { service: "light.turn_on", entityId: LAMP, data: {} };
const roles = { [MEMBER]: "member", [GUEST]: "guest" } as const;

async function options(t: TestContext, values: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "hearth-roles-config-"));
  const previous = process.env.HEARTH_MODE;
  t.after(async () => {
    if (previous === undefined) delete process.env.HEARTH_MODE;
    else process.env.HEARTH_MODE = previous;
    await rm(dir, { recursive: true, force: true });
  });
  process.env.HEARTH_MODE = "ingress";
  const file = join(dir, "options.json");
  await writeFile(
    file,
    JSON.stringify({
      public_origin: "https://home.example",
      provider: "offline",
      ...values,
    }),
  );
  return loadConfig(file);
}

test("household role options: default everyone is an owner; every fault code", async (t) => {
  const plain = await options(t, { authorized_user_ids: [OWNER, MEMBER] });
  assert.deepEqual(plain.memberUsers, []);
  assert.deepEqual(plain.guestUsers, []);
  assert.deepEqual(householdRoles(plain), {});
  const set = await options(t, {
    authorized_user_ids: [OWNER, MEMBER, GUEST],
    member_user_ids: [MEMBER],
    guest_user_ids: [GUEST],
  });
  assert.deepEqual(householdRoles(set), roles);
  for (const [values, code] of [
    [{ member_user_ids: ["bad id"] }, "invalid_role_user_ids"],
    [{ guest_user_ids: "x" }, "invalid_role_user_ids"],
    [{ member_user_ids: ["user-outsider"] }, "role_user_not_authorized"],
    [{ member_user_ids: [MEMBER], guest_user_ids: [MEMBER] }, "role_conflict"],
    [
      { member_user_ids: [OWNER, MEMBER], guest_user_ids: [GUEST] },
      "household_owner_required",
    ],
    [
      {
        member_user_ids: [MEMBER],
        workspace_enabled: true,
        workspace_owner_ids: [MEMBER],
      },
      "workspace_owner_not_owner_role",
    ],
  ] as const)
    await assert.rejects(
      options(t, { authorized_user_ids: [OWNER, MEMBER, GUEST], ...values }),
      new RegExp(code),
    );
});

function lampTransport(counter: { gets: number; posts: number }) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      counter.posts++;
      return Response.json([]);
    }
    counter.gets++;
    return String(url).endsWith("services")
      ? Response.json([
          { domain: "light", services: { turn_on: {}, turn_off: {} } },
        ])
      : Response.json({ entity_id: LAMP, state: "off", attributes: {} });
  }) as typeof fetch;
}
async function harness(
  t: TestContext,
  options: {
    roles?: Record<string, "member" | "guest">;
    dir?: string;
    groups?: boolean;
    judge?: Partial<JudgeRecord>;
  } = {},
) {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "hearth-roles-")));
  const counter = { gets: 0, posts: 0 };
  const provider = offline();
  const ha = new HAClient(
    "synthetic-token",
    {
      enabled: true,
      entities: [LAMP],
      services: ["light.turn_on", "light.turn_off"],
    },
    lampTransport(counter),
  );
  ha.actions.authorizeOwners([OWNER, MEMBER, GUEST], options.roles ?? roles);
  if (options.judge)
    ha.actions.useJudge({
      describe: () => ({ setting: "test", model: "test" }),
      evaluate: async () => ({
        model: "test",
        verdict: "escalated",
        reason: "synthetic escalation",
        latencyMs: 1,
        ...options.judge,
      }),
    });
  const home = [haExtension(ha)];
  const homeMember = [haExtension(ha, { role: "member" })];
  const homeGuest = [haExtension(ha, { role: "guest" })];
  const runtime = await Runtime.open(
    dir,
    provider.models,
    provider.model,
    [...home, ...homeMember, ...homeGuest],
    [],
    options.groups === false
      ? { home, workspace: [] }
      : { home, workspace: [], homeMember, homeGuest },
    ha.actions,
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await ha.actions.close();
    await runtime.close();
  };
  t.after(async () => {
    await close();
    if (!options.dir) await rm(dir, { recursive: true, force: true });
  });
  const mode = async (owner: string, value: "read-only" | "ask" | "full") => {
    const p = await ha.actions.settings(owner);
    return ha.actions.setMode(
      owner,
      value,
      p.revision,
      p.policy,
      value === "full" ? FULL_ACKNOWLEDGEMENT : undefined,
    );
  };
  const ask = async (owner: string, session: number, key: string) => {
    provider.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ha_propose_service", action), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Done."),
    ]);
    const sid = await runtime.submit(owner, session, key, "Lamp on");
    await (await runtime.harness.submission(sid as SubmissionId, ctx))!.wait(
      ctx,
    );
    return {
      receipts: Object.values(
        (await runtime.harness.snapshot(
          Proposals,
          session as ConversationId,
          ctx,
        ))!.items,
      ),
      transcript: JSON.stringify(
        (await (await runtime.session(owner, session)).context(ctx)).entries,
      ),
    };
  };
  return { dir, ha, runtime, counter, mode, ask, close };
}

test("members: Ask only, Full refused and downgraded at boot; judge-escalated high refused at proposal and dispatch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-roles-boot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // As an owner, B acknowledges Full; then the App options make B a member.
  const before = await harness(t, { roles: {}, dir });
  await before.mode(MEMBER, "full");
  assert.equal((await before.ha.actions.settings(MEMBER)).mode, "full");
  await before.close();
  const f = await harness(t, { dir });
  const p = await f.ha.actions.settings(MEMBER);
  assert.equal(p.mode, "ask");
  assert.equal(p.role, "member");
  assert.equal(p.grant, null);
  assert.match(p.invalidation, /Member role/);
  await assert.rejects(f.mode(MEMBER, "full"), /role_forbids_full/);
  await f.mode(MEMBER, "read-only");
  await f.mode(MEMBER, "ask");
  // Low from a member: an ordinary pending proposal.
  const session = await f.runtime.create(MEMBER, "Home", "member-home-1");
  const low = await f.ask(MEMBER, session, "member-request-1");
  assert.equal(low.receipts[0]!.status, "pending");
  // Dispatch re-checks: the same receipt rated high cannot run for a member.
  await f.runtime.harness.commit(async (tx) => {
    (await tx.doc(Proposals, session as ConversationId)).items[
      low.receipts[0]!.id
    ]!.risk = { level: "high", rule: "test", reasons: [] };
  }, ctx);
  await assert.rejects(
    f.ha.actions.decide(
      MEMBER,
      session,
      low.receipts[0]!.id,
      low.receipts[0]!.hash,
      "approve",
    ),
    /role_requires_owner/,
  );
  assert.equal(f.counter.posts, 0);
  await f.close();
  // Judge-escalated to high: refused before any proposal exists.
  const g = await harness(t, { judge: { escalateTo: "high" } });
  const s2 = await g.runtime.create(MEMBER, "Home", "member-home-2");
  const escalated = await g.ask(MEMBER, s2, "member-request-2");
  assert.deepEqual(escalated.receipts, []);
  assert.match(escalated.transcript, /role_requires_owner/);
  // The owner is unaffected: same escalation files a pending high proposal.
  const s3 = await g.runtime.create(OWNER, "Home", "owner-home-1");
  const owner = await g.ask(OWNER, s3, "owner-request-1");
  assert.equal(owner.receipts[0]!.risk?.level, "high");
  assert.equal(g.counter.posts, 0);
});

test("guests: read-only before any HA request; no write tools in any group", async (t) => {
  const f = await harness(t);
  const p = await f.ha.actions.settings(GUEST);
  assert.equal(p.effectiveMode, "read-only");
  assert.equal(p.role, "guest");
  await assert.rejects(f.mode(GUEST, "ask"), /role_guest_read_only/);
  const session = await f.runtime.create(GUEST, "Home", "guest-home-1");
  const reads = f.counter.gets;
  await assert.rejects(
    f.ha.actions.press(GUEST, session, action, {
      kind: "world",
      entityId: LAMP,
    }),
    /role_guest_read_only/,
  );
  assert.equal(f.counter.gets, reads);
  // The guest group has no proposal tool at all.
  const asked = await f.ask(GUEST, session, "guest-request-1");
  assert.deepEqual(asked.receipts, []);
  assert.equal(f.counter.posts, 0);
  assert.equal(f.counter.gets, reads);
  const guestTools = haExtension(f.ha, { role: "guest" }).tools!.map(
    (tool) => tool.name,
  );
  for (const name of [
    "ha_propose_service",
    "list_propose",
    "app_create",
    "app_update",
    "suggest_memory",
    "suggest_app_change",
    "world_layout_propose",
    "ha_automation_traces",
  ])
    assert.ok(!guestTools.includes(name), name);
  assert.ok(guestTools.includes("ha_search_states"));
  const memberTools = haExtension(f.ha, { role: "member" }).tools!.map(
    (tool) => tool.name,
  );
  assert.ok(memberTools.includes("ha_propose_service"));
  assert.ok(!memberTools.includes("ha_automation_config"));
  assert.equal(
    haExtension(f.ha).tools!.length,
    haExtension(f.ha, { role: "owner" }).tools!.length,
  );
  assert.equal(ROLE_DENIED_TOOLS.owner.size, 0);
});

test("guests: an owner-group tool in a guest's session re-checks the role and refuses", async (t) => {
  // No guest group configured: the guest's session falls back to the owner
  // group, whose tools still check the session owner's role when they run.
  const f = await harness(t, { groups: false });
  const session = await f.runtime.create(GUEST, "Home", "guest-home-2");
  const asked = await f.ask(GUEST, session, "guest-request-2");
  assert.deepEqual(asked.receipts, []);
  assert.match(asked.transcript, /role_forbids_tool/);
  assert.equal(f.counter.posts, 0);
});

test("guests never receive household memory in prompts", async (t) => {
  const f = await harness(t);
  const guest = await f.runtime.create(GUEST, "Home", "guest-home-3");
  const owner = await f.runtime.create(OWNER, "Home", "owner-home-3");
  await f.runtime.harness.commit(async (tx) => {
    const { SharedMemory } = await import("../src/memory.js");
    (await tx.doc(SharedMemory)).items.push({
      id: "h_1",
      text: "Synthetic household fact",
      created: 1,
      updated: 1,
      createdBy: OWNER,
      updatedBy: OWNER,
      source: { kind: "owner" },
    } as never);
  }, ctx);
  const render = (conversationId: number) =>
    sharedMemorySection((who) => f.ha.actions.role(who) !== "guest").render(
      {
        conversationId,
        read: {
          snapshot: (...args: unknown[]) =>
            (
              f.runtime.harness.snapshot as (
                ...a: unknown[]
              ) => Promise<unknown>
            )(...args),
        },
      } as never,
      ctx,
    );
  assert.equal(await render(guest), undefined);
  assert.match(String(await render(owner)), /Synthetic household fact/);
  // The default config: everyone is an owner and nothing is recorded.
  const sessions = (await f.runtime.harness.snapshot(Catalog, ctx))!.items;
  assert.equal(sessions.length, 2);
});

test("default configuration: every authorized user is an owner, exactly as before", async (t) => {
  const f = await harness(t, { roles: {} });
  for (const who of [OWNER, MEMBER, GUEST]) {
    assert.equal(f.ha.actions.role(who), "owner");
    const p = await f.ha.actions.settings(who);
    assert.equal(p.role, "owner");
    assert.equal(p.effectiveMode, "ask");
  }
  await f.mode(MEMBER, "full");
  const stored = (await f.runtime.harness.snapshot(HomePermissions, ctx))!
    .owners[MEMBER]!;
  assert.equal(stored.role, undefined);
  assert.equal(stored.mode, "full");
  assert.equal(haExtension(f.ha).name, "hearth-ha");
  assert.deepEqual(roleCapabilities("owner"), {
    homeWrites: true,
    fullAccess: true,
    highRiskApproval: true,
    providerSetup: true,
    memoryWrite: true,
    householdMemory: true,
    appEdit: true,
    watchers: true,
    suggestions: true,
    phoneApprovals: true,
  });
});

// HTTP through the real ingress Boundary.
async function server(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "hearth-roles-http-"));
  const { models, model } = offline();
  const counter = { gets: 0, posts: 0 };
  const config: Config = {
    mode: "ingress",
    host: "127.0.0.1",
    port: 8099,
    origin: "https://home.example",
    password: "",
    authorizedUsers: [OWNER, MEMBER, GUEST],
    memberUsers: [MEMBER],
    guestUsers: [GUEST],
    dataDir: dir,
    provider: "offline",
    model: "test",
    policy: { enabled: true, entities: [LAMP], services: ["light.turn_on"] },
    haToken: "synthetic-supervisor-token",
    apiKey: "",
  };
  const ha = new HAClient(
    config.haToken,
    config.policy,
    lampTransport(counter),
  );
  ha.actions.authorizeOwners(config.authorizedUsers, householdRoles(config));
  const runtime = await Runtime.open(
    dir,
    models,
    model,
    [haExtension(ha)],
    [],
    undefined,
    ha.actions,
  );
  const app = appServer(config, runtime, new Actions(runtime, ha));
  app.server.prependListener("connection", (socket: Socket) =>
    Object.defineProperty(socket, "remoteAddress", { value: "172.30.32.2" }),
  );
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  config.origin = base;
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const as = async (who: string) => {
    const identity = { "x-remote-user-id": who };
    const boot = await fetch(`${base}/api/bootstrap`, { headers: identity });
    const bootstrap = await boot.json();
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    return {
      bootstrap,
      get: (path: string) => fetch(`${base}${path}`, { headers: identity }),
      post: (path: string, value: unknown) =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            ...identity,
            cookie,
            origin: base,
            "x-hearth-csrf": bootstrap.csrf,
            "content-type": "application/json",
          },
          body: JSON.stringify(value),
        }),
    };
  };
  return { as, counter };
}

test("HTTP: provider routes are owner-only; guests cannot write memory, apps, watchers or suggestions and get no household memory", async (t) => {
  const { as } = await server(t);
  const owner = await as(OWNER);
  const member = await as(MEMBER);
  const guest = await as(GUEST);
  const expectRole: [typeof owner, HouseholdRole][] = [
    [owner, "owner"],
    [member, "member"],
    [guest, "guest"],
  ];
  for (const [client, role] of expectRole) {
    assert.equal(client.bootstrap.role, role);
    assert.deepEqual(client.bootstrap.capabilities, roleCapabilities(role));
  }
  for (const client of [member, guest])
    for (const [path, value] of [
      ["/api/auth/login", {}],
      ["/api/auth/logout", {}],
      ["/api/local/test", { url: "http://127.0.0.1:1" }],
      ["/api/local/remove", {}],
    ] as const) {
      const response = await client.post(path, value);
      assert.equal(response.status, 403, path);
      assert.deepEqual(await response.json(), {
        error: "role_requires_owner",
      });
    }
  // The owner reaches the provider routes (here: no subscription set up).
  assert.notEqual((await owner.post("/api/auth/login", {})).status, 403);
  // Household memory: owner adds, member sees it, guest neither sees nor
  // writes.
  assert.equal(
    (
      await owner.post("/api/memory/add", {
        text: "Synthetic household fact",
        scope: "household",
      })
    ).status,
    200,
  );
  const memberMemory = await (await member.get("/api/memory")).json();
  assert.equal(memberMemory.household.items.length, 1);
  const guestMemory = await (await guest.get("/api/memory")).json();
  assert.equal(guestMemory.household, undefined);
  assert.doesNotMatch(JSON.stringify(guestMemory), /Synthetic household/);
  for (const [path, value] of [
    ["/api/memory/add", { text: "x", scope: "private" }],
    ["/api/suggestions/reject", { id: "s_1" }],
    ["/api/proactive/enabled", { enabled: true }],
    ["/api/apps/app_1/state", {}],
  ] as const) {
    const response = await guest.post(path, value);
    assert.equal(response.status, 403, path);
    assert.deepEqual(await response.json(), { error: "role_guest_read_only" });
  }
  // A guest still chats and reads.
  assert.equal(
    (
      await guest.post("/api/sessions", {
        title: "Home",
        requestId: "guest-http-1",
      })
    ).status,
    201,
  );
  const guestPermissions = await (
    await guest.get("/api/home-permissions")
  ).json();
  assert.equal(guestPermissions.effectiveMode, "read-only");
  const refused = await guest.post("/api/home-permissions", {
    mode: "ask",
    revision: guestPermissions.revision,
    policy: guestPermissions.policy,
  });
  assert.equal(refused.status, 403);
});

test("roles: Undo follows the same role checks (guest refused before any read)", async (t) => {
  const f = await harness(t);
  const reads = f.counter.gets;
  await assert.rejects(
    f.ha.actions.undo(GUEST, 1, "1", "0".repeat(64)),
    /role_guest_read_only/,
  );
  assert.equal(f.counter.gets, reads);
});
