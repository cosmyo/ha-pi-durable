import { createServer } from "node:net";
import { readFile, chmod, unlink, lstat, access } from "node:fs/promises";
import { constants } from "node:fs";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "@earendil-works/pi-durable";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { equal, insist, object } from "./safety.js";
import { signWork, type WorkRequest, type WorkResult } from "./workspace.js";

export async function verifyWorkerIsolation() {
  insist(
    process.platform === "linux" &&
      process.getuid?.() === 1001 &&
      process.getgid?.() === 1000,
    "isolated_linux_worker_required",
  );
  const status = await readFile("/proc/self/status", "utf8");
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"])
    insist(
      new RegExp(`^${name}:\\s+0+$`, "m").test(status),
      "worker_capabilities_present",
    );
  insist(
    /^NoNewPrivs:\s+1$/m.test(status) && /^Seccomp:\s+2$/m.test(status),
    "worker_confinement_required",
  );
  insist(
    (await readFile("/proc/self/attr/current", "utf8"))
      .trim()
      .startsWith("docker-default (enforce)"),
    "worker_apparmor_required",
  );
  insist(
    Object.keys(networkInterfaces()).every((name) => name === "lo"),
    "worker_network_must_be_none",
  );
  const root = (await readFile("/proc/self/mountinfo", "utf8"))
    .split("\n")
    .find((line) => line.split(" ")[4] === "/");
  insist(
    root?.split(" ")[5]?.split(",").includes("ro"),
    "worker_rootfs_must_be_readonly",
  );
  const workspace = await lstat("/workspace");
  insist(
    workspace.isDirectory() &&
      !workspace.isSymbolicLink() &&
      workspace.uid === 1001 &&
      workspace.gid === 1000 &&
      (workspace.mode & 0o777) === 0o700,
    "private_workspace_ownership_required",
  );
  await access("/workspace", constants.W_OK);
}
export async function serveWorker(
  socketPath: string,
  key: string,
  workspace: string,
) {
  const tools = new Map(
    createCodingTools(workspace).map((tool) => [tool.name, tool]),
  );
  const seen = new Set<string>();
  let active = false;
  await unlink(socketPath).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let data = "",
      received = false;
    const abort = new AbortController();
    socket.setTimeout(130000, () => socket.destroy());
    socket.on("error", () => abort.abort());
    socket.on("close", () => abort.abort());
    socket.on("data", (chunk) => {
      if (received) return socket.destroy();
      data += chunk.toString("utf8");
      if (Buffer.byteLength(data) > 65536) return socket.destroy();
      if (!data.includes("\n")) return;
      received = true;
      void run(data.slice(0, data.indexOf("\n")), abort.signal).then(
        (result) => {
          const frame = JSON.stringify({
            ...result,
            mac: signWork(key, "response", result),
          });
          if (Buffer.byteLength(frame) > 131071) return socket.destroy();
          socket.end(`${frame}\n`);
        },
        () => socket.destroy(),
      );
    });
  });
  async function run(frame: string, signal: AbortSignal): Promise<WorkResult> {
    const { mac, ...raw } = object(JSON.parse(frame), [
      "v",
      "id",
      "tool",
      "args",
      "expires",
      "mac",
    ]);
    const request = raw as WorkRequest;
    insist(
      request.v === 1 &&
        typeof request.id === "string" &&
        /^[a-f0-9-]{36}$/.test(request.id) &&
        typeof mac === "string" &&
        equal(mac, signWork(key, "request", request)) &&
        Number.isFinite(request.expires) &&
        request.expires >= Date.now() &&
        request.expires <= Date.now() + 125000,
      "invalid_worker_request",
    );
    insist(
      !seen.has(request.id) && seen.size < 20000,
      "duplicate_worker_operation",
    );
    const tool = tools.get(request.tool);
    insist(tool, "unknown_workspace_tool");
    const args = validateToolArguments(tool, {
      type: "toolCall",
      id: request.id,
      name: request.tool,
      arguments: request.args as JsonObject,
    });
    if (active)
      return {
        id: request.id,
        isError: true,
        unknown: false,
        content: [{ type: "text", text: "Worker busy; no operation started." }],
      };
    seen.add(request.id);
    active = true;
    try {
      if (request.tool === "bash")
        (args as { timeout?: number }).timeout = Math.min(
          60,
          (args as { timeout?: number }).timeout ?? 60,
        );
      const result = await tool.execute(request.id, args as never, signal);
      const content = result.content
        .filter((b) => b.type === "text")
        .map((b) => ({ type: "text" as const, text: b.text }));
      if (Buffer.byteLength(JSON.stringify(content)) > 120000)
        throw new Error("output_limit");
      return {
        id: request.id,
        content,
        isError: result.isError ?? false,
        // SDK Bash resolves non-zero exits rather than throwing. Partial effects
        // still require reconciliation; never allow model-driven same-turn retry.
        unknown: result.isError ?? false,
      };
    } catch {
      // Shell failure/abort can leave files partially changed. Conservatively stop autonomy.
      return {
        id: request.id,
        isError: true,
        unknown: true,
        content: [
          {
            type: "text",
            text: "Operation stopped or failed; partial file effects are possible. Inspect the workspace before a fresh human request. No automatic repeat.",
          },
        ],
      };
    } finally {
      active = false;
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o660);
  return server;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.umask(0o077);
    await verifyWorkerIsolation();
    const key = (await readFile("/run/hearth-bridge/key", "utf8")).trim();
    insist(/^[a-f0-9]{64}$/.test(key));
    // No inherited provider/HA credentials or resources. Public Pi tool constructors only.
    for (const name of Object.keys(process.env))
      if (!["PATH", "HOME", "LANG"].includes(name)) delete process.env[name];
    await serveWorker("/run/hearth-bridge/worker.sock", key, "/workspace");
    console.info(
      "Hearth workspace worker ready; offline, confined, no HA/provider credentials.",
    );
  } catch {
    console.error("Workspace isolation/startup gate failed.");
    process.exitCode = 1;
  }
}
