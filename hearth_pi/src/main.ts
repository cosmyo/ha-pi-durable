import { loadConfig } from "./config.js";
import { dropAppPrivileges } from "./bootstrap.js";
import { configuredModels } from "./models.js";
import { Runtime } from "./runtime.js";
import { HAClient, haExtension, Actions } from "./ha.js";
import { appServer } from "./server.js";
import { readFile } from "node:fs/promises";
import { Subscription } from "./subscription.js";
import { LocalEndpoints, LOCAL_PROVIDER } from "./local.js";
import { WorkspaceClient, workspaceExtension } from "./workspace.js";
import { Proactive } from "./proactive.js";

try {
  const config = await loadConfig();
  await dropAppPrivileges(config);
  // ChatGPT/Codex login is always offered; Anthropic only behind its flag.
  // One Pi ModelRuntime serves both, each with its own private credential file.
  const {
    subscriptions,
    runtime: native,
    secrets,
  } = await Subscription.openProviders(
    config.dataDir,
    [config.apiKey, config.haToken, config.password],
    config.anthropicAuthEnabled === true
      ? ["openai-codex", "anthropic"]
      : ["openai-codex"],
  );
  const { models, provider, modelId } = await configuredModels(
    config,
    native,
    secrets,
  );
  // Mutable default: a saved local endpoint supplies its chosen model.
  const model = { provider, modelId };
  const local =
    provider === LOCAL_PROVIDER
      ? await LocalEndpoints.open(config.dataDir, native, secrets, model)
      : undefined;
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
    model,
    [...home, ...workspace],
    secrets,
    { home, workspace },
    ha.actions,
    config.thinkingLevel,
  );
  // Signed-in OAuth providers' models become selectable per session. The
  // offline demonstration keeps its faux-only registry (no real inference).
  if (config.provider !== "offline")
    runtime.oauthProviders = () =>
      subscriptions.map((s) => ({
        provider: s.provider,
        signedIn: s.configured(),
      }));
  // Watchers and briefings read scoped state and create Today cards only.
  const proactive = new Proactive(runtime.harness, ha.reader(), {
    sanitize: (value) => ha.sanitize(value),
    owners: () =>
      config.mode === "local" ? ["local-admin"] : config.authorizedUsers,
  });
  const app = appServer(config, runtime, new Actions(runtime, ha), {
    subscriptions,
    local,
    secrets,
    proactive,
  });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(config.port, config.host, resolve);
  });
  proactive.start();
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
