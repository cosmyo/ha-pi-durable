import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { SubmissionId } from "@earendil-works/pi-durable";
import {
  configurationDiagnostic,
  loadConfig,
  workspaceOwners,
  type Config,
} from "../src/config.js";
import { Fault } from "../src/safety.js";
import { Runtime } from "../src/runtime.js";
import { HAClient, Actions } from "../src/ha.js";
import { appServer } from "../src/server.js";
import { WorkspaceClient, workspaceExtension } from "../src/workspace.js";
import { offline } from "./fixtures.js";

const OWNER_A = "synthetic-owner-a";
const OWNER_B = "synthetic-owner-b";
const OUTSIDER = "synthetic-outsider";

// Ingress options are read from a file; HEARTH_MODE selects ingress.
async function ingressConfig(
  t: TestContext,
  options: Record<string, unknown>,
): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), "hearth-ws-owners-config-"));
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
      ...options,
    }),
  );
  return loadConfig(file);
}

test("workspace_owner_ids: empty keeps the one-owner rule; a set list must be a small subset of authorized owners", async (t) => {
  // Existing single-owner installation: unchanged, that owner owns Code.
  const single = await ingressConfig(t, {
    authorized_user_ids: [OWNER_A],
    workspace_enabled: true,
  });
  assert.deepEqual(single.workspaceOwners, [OWNER_A]);
  assert.deepEqual(workspaceOwners(single), [OWNER_A]);
  assert.deepEqual(
    (
      await ingressConfig(t, {
        authorized_user_ids: [OWNER_A],
        workspace_enabled: true,
        workspace_owner_ids: [],
      })
    ).workspaceOwners,
    [OWNER_A],
  );
  // A second owner without workspace_owner_ids still refuses to start.
  await assert.rejects(
    ingressConfig(t, {
      authorized_user_ids: [OWNER_A, OWNER_B],
      workspace_enabled: true,
    }),
    /workspace_requires_one_trusted_owner/,
  );
  // Two owners, one named workspace owner.
  const named = await ingressConfig(t, {
    authorized_user_ids: [OWNER_A, OWNER_B],
    workspace_enabled: true,
    workspace_owner_ids: [OWNER_A],
  });
  assert.deepEqual(named.workspaceOwners, [OWNER_A]);
  assert.deepEqual(
    (
      await ingressConfig(t, {
        authorized_user_ids: [OWNER_A, OWNER_B],
        workspace_enabled: true,
        workspace_owner_ids: [OWNER_B, OWNER_A, OWNER_B],
      })
    ).workspaceOwners,
    [OWNER_B, OWNER_A],
  );
  // Not a subset of authorized_user_ids.
  await assert.rejects(
    ingressConfig(t, {
      authorized_user_ids: [OWNER_A, OWNER_B],
      workspace_enabled: true,
      workspace_owner_ids: [OWNER_A, OUTSIDER],
    }),
    /workspace_owner_not_authorized/,
  );
  // Malformed: too many, empty, non-string, not a list.
  const many = Array.from({ length: 6 }, (_, i) => `synthetic-owner-${i}`);
  for (const value of [many, [""], [42], OWNER_A, ["bad id"]])
    await assert.rejects(
      ingressConfig(t, {
        authorized_user_ids: many,
        workspace_enabled: true,
        workspace_owner_ids: value,
      }),
      /invalid_workspace_owner_ids/,
    );
  // Workspace off: no owners, and a stale list does not block startup.
  const off = await ingressConfig(t, {
    authorized_user_ids: [OWNER_A, OWNER_B],
    workspace_enabled: false,
    workspace_owner_ids: [OUTSIDER],
  });
  assert.deepEqual(off.workspaceOwners, []);
  assert.deepEqual(workspaceOwners(off), []);
});

test("startup diagnostics name only a known configuration Fault code, never option values", async (t) => {
  const secretLookingId = "synthetic-owner-canary-value";
  const failure = await ingressConfig(t, {
    authorized_user_ids: [OWNER_A, secretLookingId],
    workspace_enabled: true,
  }).catch((error: unknown) => error);
  const message = configurationDiagnostic(failure);
  assert.equal(
    message,
    "invalid configuration: workspace_requires_one_trusted_owner",
  );
  assert.doesNotMatch(message!, /canary|synthetic-owner-a/);
  const subset = await ingressConfig(t, {
    authorized_user_ids: [OWNER_A],
    workspace_enabled: true,
    workspace_owner_ids: [secretLookingId],
  }).catch((error: unknown) => error);
  assert.equal(
    configurationDiagnostic(subset),
    "invalid configuration: workspace_owner_not_authorized",
  );
  // Anything else keeps the generic startup message (no specific reason).
  assert.equal(
    configurationDiagnostic(new Fault(400, "invalid_request")),
    undefined,
  );
  assert.equal(
    configurationDiagnostic(new Fault(400, "sk-synthetic")),
    undefined,
  );
  assert.equal(
    configurationDiagnostic(new Error("invalid_workspace_owner_ids sk-x")),
    undefined,
  );
  assert.equal(
    configurationDiagnostic("workspace_requires_ingress"),
    undefined,
  );
});

// main.ts end to end: the known code is printed, a generic failure is not.
function startMain(env: Record<string, string>) {
  return new Promise<string>((resolve) => {
    execFile(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/main.ts", import.meta.url)),
      ],
      { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 20000 },
      (_error, stdout, stderr) => resolve(`${stdout}${stderr}`),
    );
  });
}
test("startup prints the configuration Fault code but keeps other failures generic", async () => {
  const missingMode = await startMain({});
  assert.match(
    missingMode,
    /Hearth Pi could not start: invalid configuration: explicit_mode_required\./,
  );
  const canary = "synthetic-short-canary";
  const generic = await startMain({
    HEARTH_MODE: "local",
    HEARTH_LOCAL_PASSWORD: canary,
  });
  assert.match(generic, /Hearth Pi could not start\. Check mode/);
  assert.doesNotMatch(generic, /invalid configuration|canary/);
});

// A real HTTP server whose sockets look like the Supervisor Ingress peer, so
// the genuine ingress Boundary authenticates X-Remote-User-Id.
async function ingressServer(
  t: TestContext,
  cfg: Config,
  setup?: (runtime: Runtime) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "hearth-ws-owners-http-"));
  const { models, model } = offline();
  const client = new WorkspaceClient(
    "/synthetic-not-connected",
    "a".repeat(64),
  );
  const extension = workspaceExtension(client);
  const runtime = await Runtime.open(dir, models, model, [extension], [], {
    home: [],
    workspace: [extension],
  });
  await setup?.(runtime);
  const config = { ...cfg, dataDir: dir };
  const ha = new HAClient(config.haToken, config.policy);
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
  const as = async (owner: string) => {
    const identity = { "x-remote-user-id": owner };
    const boot = await fetch(`${base}/api/bootstrap`, { headers: identity });
    assert.equal(boot.status, 200);
    const bootstrap = await boot.json();
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const get = (path: string) =>
      fetch(`${base}${path}`, { headers: identity });
    const post = (path: string, value: unknown) =>
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
      });
    return { bootstrap, get, post };
  };
  return { runtime, as };
}

const ingress: Config = {
  mode: "ingress",
  host: "127.0.0.1",
  port: 8099,
  origin: "https://home.example",
  password: "",
  authorizedUsers: [OWNER_A, OWNER_B],
  dataDir: "",
  provider: "offline",
  model: "test",
  workspaceEnabled: true,
  workspaceOwners: [OWNER_A],
  policy: { enabled: false, entities: [], services: [] },
  haToken: "synthetic-supervisor-token",
  apiKey: "synthetic-provider-key",
};

test("HTTP: only workspace owners create, see and use Code sessions; other owners get 403 workspace_not_allowed", async (t) => {
  let earlier = 0;
  const { runtime, as } = await ingressServer(t, ingress, async (runtime) => {
    // Created before owner B was left out of workspace_owner_ids.
    earlier = await runtime.create(
      OWNER_B,
      "Earlier code",
      "earlier-1",
      "workspace",
    );
  });
  const a = await as(OWNER_A);
  const b = await as(OWNER_B);
  assert.equal(a.bootstrap.workspaceEnabled, true);
  assert.equal(b.bootstrap.workspaceEnabled, false);

  const refused = await b.post("/api/sessions", {
    title: "Code",
    requestId: "owner-b-code-1",
    kind: "workspace",
  });
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "workspace_not_allowed" });
  // The same refusal reaches every runtime path (e.g. Draft in Code session).
  await assert.rejects(
    runtime.create(OWNER_B, "Code", "owner-b-code-2", "workspace"),
    /workspace_not_allowed/,
  );
  const home = await b.post("/api/sessions", {
    title: "Home",
    requestId: "owner-b-home-1",
  });
  assert.equal(home.status, 201);
  const homeId = (await home.json()).id;

  // Owner B's earlier Code session is hidden and refused, not deleted.
  const bList = (await (await b.get("/api/sessions")).json()).items;
  assert.deepEqual(
    bList.map((s: { id: number; kind?: string }) => [s.id, s.kind]),
    [[homeId, "home"]],
  );
  for (const path of [
    `/api/sessions/${earlier}/snapshot`,
    `/api/sessions/${earlier}/events`,
    `/api/sessions/${earlier}/feedback`,
  ]) {
    const response = await b.get(path);
    assert.equal(response.status, 403, path);
    assert.deepEqual(await response.json(), { error: "workspace_not_allowed" });
  }
  for (const [operation, value] of [
    ["inputs", { requestId: "owner-b-input-1", content: "Edit files." }],
    ["abort", {}],
    ["delete", { confirm: true }],
  ] as const) {
    const response = await b.post(
      `/api/sessions/${earlier}/${operation}`,
      value,
    );
    assert.equal(response.status, 403, operation);
    assert.deepEqual(await response.json(), { error: "workspace_not_allowed" });
  }
  assert.equal((await b.get(`/api/sessions/${homeId}/snapshot`)).status, 200);

  // The workspace owner still works end to end.
  const created = await a.post("/api/sessions", {
    title: "Code",
    requestId: "owner-a-code-1",
    kind: "workspace",
  });
  assert.equal(created.status, 201);
  const codeId = (await created.json()).id;
  const aList = (await (await a.get("/api/sessions")).json()).items;
  assert.deepEqual(
    aList.map((s: { id: number; kind?: string }) => [s.id, s.kind]),
    [[codeId, "workspace"]],
  );
  assert.equal((await a.get(`/api/sessions/${codeId}/snapshot`)).status, 200);
  // Sessions stay owner-scoped: neither owner reaches the other's.
  assert.equal((await a.get(`/api/sessions/${earlier}/snapshot`)).status, 404);
  assert.equal((await b.get(`/api/sessions/${codeId}/snapshot`)).status, 404);
});

test("HTTP: an existing single-owner installation without workspace_owner_ids keeps Code for that owner", async (t) => {
  const { as } = await ingressServer(t, {
    ...ingress,
    authorizedUsers: [OWNER_A],
    workspaceOwners: undefined,
  });
  const a = await as(OWNER_A);
  assert.equal(a.bootstrap.workspaceEnabled, true);
  const created = await a.post("/api/sessions", {
    title: "Code",
    requestId: "single-owner-code-1",
    kind: "workspace",
  });
  assert.equal(created.status, 201);
  const id = (await created.json()).id;
  assert.equal((await a.get(`/api/sessions/${id}/snapshot`)).status, 200);
  assert.deepEqual(
    (await (await a.get("/api/sessions")).json()).items.map(
      (s: { kind?: string }) => s.kind,
    ),
    ["workspace"],
  );
});

test("workspace extension never sends a non-owner's Code session to the worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-ws-owners-tool-"));
  const { models, model, faux } = offline();
  let calls = 0;
  const client = new WorkspaceClient(
    "/synthetic-not-connected",
    "a".repeat(64),
  );
  client.call = async () => {
    calls++;
    return {
      id: "synthetic",
      isError: false,
      unknown: false,
      content: [{ type: "text", text: "Wrote synthetic file" }],
    };
  };
  const extension = workspaceExtension(client, [], new Set([OWNER_A]));
  // No server policy on this runtime: e.g. work resumed at startup.
  const runtime = await Runtime.open(dir, models, model, [extension], [], {
    home: [],
    workspace: [extension],
  });
  const run = async (owner: string, key: string) => {
    const id = await runtime.create(
      owner,
      "Code",
      `${key}-create`,
      "workspace",
    );
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", { path: "a.txt", content: "synthetic" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Done."),
    ]);
    const submission = await runtime.submit(
      owner,
      id,
      `${key}-input`,
      "Write.",
    );
    await (await runtime.harness.submission(
      submission as SubmissionId,
      ctx,
    ))!.wait(ctx);
    return JSON.stringify(
      (await (await runtime.session(owner, id)).context(ctx)).entries,
    );
  };
  try {
    const refused = await run(OWNER_B, "tool-owner-b");
    assert.equal(calls, 0);
    assert.match(refused, /workspace_not_allowed/);
    const allowed = await run(OWNER_A, "tool-owner-a");
    assert.equal(calls, 1);
    assert.match(allowed, /Wrote synthetic file/);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
