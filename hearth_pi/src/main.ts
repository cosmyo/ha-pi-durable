import { loadConfig } from "./config.js";
import { dropAppPrivileges } from "./bootstrap.js";
import { configuredModels } from "./models.js";
import { Runtime } from "./runtime.js";
import { HAClient, haExtension, Actions } from "./ha.js";
import { appServer } from "./server.js";

try {
  const config = await loadConfig();
  await dropAppPrivileges(config);
  const { models, provider, modelId } = configuredModels(config);
  const ha = new HAClient(config.haToken, config.policy, fetch, [
    config.apiKey,
    config.password,
  ]);
  const runtime = await Runtime.open(
    config.dataDir,
    models,
    { provider, modelId },
    [haExtension(ha)],
    [config.apiKey, config.haToken, config.password],
  );
  const app = appServer(config, runtime, new Actions(runtime, ha));
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
