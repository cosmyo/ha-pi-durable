import { loadConfig } from "./config.js";
import { dropAppPrivileges } from "./bootstrap.js";
import { configuredModels } from "./models.js";
import { Runtime } from "./runtime.js";
import { HAClient, haExtension, Actions } from "./ha.js";
import { appServer } from "./server.js";
import { readFile } from "node:fs/promises";
import { Subscription } from "./subscription.js";
import { WorkspaceClient, workspaceExtension } from "./workspace.js";

try {
  const config = await loadConfig();
  await dropAppPrivileges(config);
  const {
    subscription,
    runtime: native,
    secrets,
  } = await Subscription.open(config.dataDir, [
    config.apiKey,
    config.haToken,
    config.password,
  ]);
  const { models, provider, modelId } = await configuredModels(
    config,
    native,
    secrets,
  );
  const ha = new HAClient(config.haToken, config.policy, fetch, secrets);
  ha.actions.authorizeOwners(
    config.mode === "local" ? ["local-admin"] : config.authorizedUsers,
  );
  const home = [haExtension(ha)];
  const workspace = [];
  if (config.workspaceEnabled) {
    const key = (await readFile("/workspace_link/bridge/key", "utf8")).trim();
    secrets.push(key);
    workspace.push(
      workspaceExtension(
        new WorkspaceClient("/workspace_link/bridge/worker.sock", key),
        secrets,
      ),
    );
  }
  const runtime = await Runtime.open(
    config.dataDir,
    models,
    { provider, modelId },
    [...home, ...workspace],
    secrets,
    { home, workspace },
    ha.actions,
    config.thinkingLevel,
  );
  const app = appServer(config, runtime, new Actions(runtime, ha), {
    subscription,
    secrets,
  });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(config.port, config.host, resolve);
  });
  console.info(
    "Hearth Pi ready. Experimental; server-side authorization enforced.",
  );
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => process.exit(1), 25000);
      deadline.unref();
      void app.close().then(
        () => {
          clearTimeout(deadline);
          process.exit(0);
        },
        () => process.exit(1),
      );
    });
} catch {
  // Raw upstream/config/network errors can contain secrets. Never log them.
  console.error(
    "Hearth Pi could not start. Check mode, credentials, model, scope, options and exclusive data ownership.",
  );
  process.exitCode = 1;
}
