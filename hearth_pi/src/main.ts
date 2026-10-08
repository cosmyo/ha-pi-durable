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
import { JudgeSessions, RiskJudgeService, resolveJudge } from "./judge.js";
import {
  BriefingSummaryService,
  resolveBriefingSummaryModel,
} from "./briefing-summary.js";

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
    [
      config.apiKey,
      config.haToken,
      config.password,
      config.judge?.apiKey ?? "",
    ],
    config.anthropicAuthEnabled === true
      ? ["openai-codex", "anthropic"]
      : ["openai-codex"],
  );
  const { models, provider, modelId } = await configuredModels(
    config,
    native,
    secrets,
    subscriptions,
  );
  // Mutable default: a saved local endpoint supplies its chosen model.
  const model = { provider, modelId };
  const local =
    provider === LOCAL_PROVIDER
      ? await LocalEndpoints.open(config.dataDir, native, secrets, model)
      : undefined;
  // A judge on the saved local endpoint while chat uses another provider:
  // register the endpoint's models without touching the chat default.
  if (!local && config.judge?.model.startsWith(`${LOCAL_PROVIDER}/`))
    await LocalEndpoints.open(config.dataDir, native, secrets, {
      modelId: "",
    }).catch(() => undefined);
  const ha = new HAClient(config.haToken, config.policy, fetch, secrets);
  ha.actions.authorizeOwners(
    config.mode === "local" ? ["local-admin"] : config.authorizedUsers,
  );
  // Admin access mode: the read scope is every entity Home Assistant reports.
  if (ha.admin) {
    await ha.identifySelf();
    await ha.refreshScope().catch(() => 0);
    setInterval(() => void ha.refreshScope().catch(() => 0), 300000).unref();
  }
  const judge = config.judge ?? {
    model: "off",
    url: "",
    apiKey: "",
    timeoutMs: 15000,
    sessionTtlMs: 300000,
  };
  ha.actions.useJudge(
    new RiskJudgeService(
      judge.model,
      () =>
        resolveJudge(judge.model, {
          models: native,
          signedIn: (provider) =>
            subscriptions.some(
              (s) => s.provider === provider && s.configured(),
            ),
          endpoint: { url: judge.url, apiKey: judge.apiKey },
        }),
      judge.timeoutMs,
      (value) => ha.sanitize(value),
      new JudgeSessions(judge.sessionTtlMs),
    ),
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
  // The optional briefing summary is a separate, injected, tool-less model
  // call (src/briefing-summary.ts) with its own fixed timeout and output
  // cap; it never touches HA tools, Home permissions or the chat model.
  const briefingSummaryModel = config.briefingSummaryModel ?? "auto";
  const proactive = new Proactive(runtime.harness, ha.reader(), {
    sanitize: (value) => ha.sanitize(value),
    owners: () =>
      config.mode === "local" ? ["local-admin"] : config.authorizedUsers,
    summarizer: new BriefingSummaryService(briefingSummaryModel, () =>
      resolveBriefingSummaryModel(briefingSummaryModel, {
        models: native,
        signedIn: (provider) =>
          subscriptions.some((s) => s.provider === provider && s.configured()),
      }),
    ),
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
