import { readFile } from "node:fs/promises";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { insist, object, text, entityPattern } from "./safety.js";
import { anthropicAuthEnabled } from "./features.js";

export const MAX_ENTITIES = 10000;

export const supportedServices = [
  "light.turn_on",
  "light.turn_off",
  "switch.turn_on",
  "switch.turn_off",
];
export type AccessMode = "scoped" | "admin";
export type Policy = {
  enabled: boolean;
  services: string[];
  entities: string[];
  // Absent means "scoped". Only App configuration (or HEARTH_ACCESS_MODE in
  // local development) sets it; never the UI, a model or a suggestion.
  access?: AccessMode;
  // Admin mode: this add-on's own Supervisor slug and display name, for
  // self-protection (from the container hostname, then /addons/self/info).
  selfSlug?: string;
  selfName?: string;
};
// Optional cheap model that may only escalate a proposed action's risk.
export type JudgeConfig = {
  // "off", "auto", "<provider>/<modelId>" or "endpoint/<modelId>".
  model: string;
  // OpenAI-compatible base URL for "endpoint/<modelId>" (private addresses).
  url: string;
  apiKey: string;
  timeoutMs: number;
  // Reuse one advisory judge session (prompt cache) within this window.
  sessionTtlMs: number;
};
export const JUDGE_MODEL_PATTERN =
  /^(off|auto|[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119})$/;
export type Config = {
  mode: "local" | "ingress";
  host: string;
  port: number;
  origin: string;
  password: string;
  authorizedUsers: string[];
  dataDir: string;
  provider: "offline" | "openai" | "openai-codex" | "anthropic" | "local";
  model: string;
  thinkingLevel?: ModelThinkingLevel;
  anthropicAuthEnabled?: boolean;
  workspaceEnabled?: boolean;
  policy: Policy;
  judge?: JudgeConfig;
  haToken: string;
  apiKey: string;
};
function strings(value: unknown, max: number): string[] {
  insist(
    Array.isArray(value) &&
      value.length <= max &&
      value.every((v) => typeof v === "string" && v.length <= 100),
  );
  return [...new Set(value as string[])];
}
export async function loadConfig(): Promise<Config> {
  const mode = process.env.HEARTH_MODE;
  insist(mode === "local" || mode === "ingress", "explicit_mode_required");
  const options =
    mode === "ingress"
      ? object(JSON.parse(await readFile("/data/options.json", "utf8")), [
          "authorized_user_ids",
          "service_actions_enabled",
          "allowed_services",
          "allowed_entities",
          "public_origin",
          "provider",
          "model",
          "openai_api_key",
          "workspace_enabled",
          "anthropic_auth_enabled",
          "access_mode",
          "risk_judge_model",
          "risk_judge_url",
          "risk_judge_api_key",
          "risk_judge_timeout_ms",
          "risk_judge_session_ttl_ms",
        ])
      : {};
  const port =
    mode === "ingress" ? 8099 : Number(process.env.HEARTH_PORT ?? 8099);
  insist(Number.isInteger(port) && port >= 1024 && port <= 65535);
  const origin = text(
    options.public_origin ??
      process.env.HEARTH_ORIGIN ??
      `http://127.0.0.1:${port}`,
    300,
  );
  const url = new URL(origin);
  insist(
    url.origin === origin &&
      !url.username &&
      !url.password &&
      (mode === "local"
        ? url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        : url.protocol === "https:"),
  );
  const password =
    mode === "local" ? text(process.env.HEARTH_LOCAL_PASSWORD, 200, 24) : "";
  const authorizedUsers = strings(options.authorized_user_ids ?? [], 100);
  const services = strings(
    options.allowed_services ??
      (process.env.HEARTH_ALLOWED_SERVICES ?? "").split(",").filter(Boolean),
    4,
  );
  const entities = strings(
    options.allowed_entities ??
      (process.env.HEARTH_ALLOWED_ENTITIES ?? "").split(",").filter(Boolean),
    MAX_ENTITIES,
  );
  insist(
    services.every((s) => supportedServices.includes(s)) &&
      entities.every((e) => entityPattern.test(e)),
  );
  const access =
    options.access_mode ?? process.env.HEARTH_ACCESS_MODE ?? "scoped";
  insist(access === "scoped" || access === "admin", "invalid_access_mode");
  const configuredEnabled =
    options.service_actions_enabled ?? process.env.HEARTH_ACTIONS === "true";
  insist(typeof configuredEnabled === "boolean");
  // Admin mode: every entity and service is in scope and actions are enabled;
  // every mutation still goes through Home permissions and the risk classifier.
  const enabled = access === "admin" ? true : configuredEnabled;
  const judgeModel = text(
    options.risk_judge_model || process.env.HEARTH_RISK_JUDGE_MODEL || "auto",
    200,
  );
  insist(JUDGE_MODEL_PATTERN.test(judgeModel), "invalid_risk_judge_model");
  const judgeUrl = text(
    options.risk_judge_url ?? process.env.HEARTH_RISK_JUDGE_URL ?? "",
    300,
    0,
  );
  if (judgeUrl) {
    // Syntax only here; private-address resolution is re-checked per call.
    insist(URL.canParse(judgeUrl), "invalid_risk_judge_url");
    const parsed = new URL(judgeUrl);
    insist(
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash,
      "invalid_risk_judge_url",
    );
  }
  const judgeKey = text(
    options.risk_judge_api_key ?? process.env.HEARTH_RISK_JUDGE_API_KEY ?? "",
    500,
    0,
  );
  insist(!judgeKey || /^[A-Za-z0-9._~+/=:-]{1,500}$/.test(judgeKey));
  const judgeTimeout = Number(
    options.risk_judge_timeout_ms ??
      process.env.HEARTH_RISK_JUDGE_TIMEOUT_MS ??
      15000,
  );
  insist(
    Number.isInteger(judgeTimeout) &&
      judgeTimeout >= 1000 &&
      judgeTimeout <= 30000,
    "invalid_risk_judge_timeout",
  );
  const judgeTtl = Number(
    options.risk_judge_session_ttl_ms ??
      process.env.HEARTH_RISK_JUDGE_SESSION_TTL_MS ??
      300000,
  );
  insist(
    Number.isInteger(judgeTtl) && judgeTtl >= 0 && judgeTtl <= 3600000,
    "invalid_risk_judge_session_ttl",
  );
  insist(
    !judgeModel.startsWith("endpoint/") || judgeUrl,
    "risk_judge_url_required",
  );
  const provider = options.provider ?? process.env.HEARTH_PROVIDER ?? "offline";
  insist(
    provider === "offline" ||
      provider === "openai" ||
      provider === "openai-codex" ||
      provider === "anthropic" ||
      provider === "local",
  );
  const anthropicOption = options.anthropic_auth_enabled ?? false;
  insist(typeof anthropicOption === "boolean");
  const anthropicEnabled = anthropicAuthEnabled(anthropicOption);
  insist(
    provider !== "anthropic" || anthropicEnabled,
    "anthropic_auth_disabled",
  );
  const workspaceEnabled = options.workspace_enabled ?? false;
  insist(typeof workspaceEnabled === "boolean");
  if (workspaceEnabled)
    insist(
      mode === "ingress" && authorizedUsers.length === 1,
      "workspace_requires_one_trusted_owner",
    );
  const apiKey = text(
    options.openai_api_key ?? process.env.OPENAI_API_KEY ?? "",
    500,
    0,
  );
  if (provider === "openai") insist(apiKey.length > 0, "provider_key_required");
  // OpenAI Codex's requested new-session default; explicit operator options
  // still own model choice. Existing pi.agent documents are never rewritten.
  const thinkingLevel: ModelThinkingLevel =
    provider === "openai-codex" ? "medium" : "off";
  return {
    mode,
    host: mode === "local" ? "127.0.0.1" : "0.0.0.0",
    port,
    origin,
    password,
    authorizedUsers,
    dataDir:
      mode === "ingress"
        ? "/data"
        : resolve(process.env.HEARTH_DATA_DIR ?? ".local"),
    provider,
    // A local endpoint's model is chosen in the authenticated UI, after the
    // owner tests the server; an option value is only an initial preference.
    model: text(
      options.model ||
        process.env.HEARTH_MODEL ||
        (provider === "offline"
          ? "faux"
          : provider === "openai-codex"
            ? "gpt-6.1-sol"
            : provider === "anthropic"
              ? "claude-sonnet-5"
              : provider === "local"
                ? ""
                : "gpt-4.1-mini"),
      100,
      provider === "local" ? 0 : 1,
    ),
    thinkingLevel,
    anthropicAuthEnabled: anthropicEnabled,
    workspaceEnabled,
    policy:
      access === "admin"
        ? {
            enabled,
            // The supported on/off toggles keep apps and Home World working;
            // admin tools carry every other service as a classified proposal.
            services: [...supportedServices],
            // Filled from live Home Assistant state by HAClient.refreshScope.
            entities: [],
            access,
            selfSlug: selfSlug(process.env.HOSTNAME, mode === "ingress"),
          }
        : { enabled, services, entities },
    judge: {
      model: judgeModel,
      url: judgeUrl,
      apiKey: judgeKey,
      timeoutMs: judgeTimeout,
      sessionTtlMs: judgeTtl,
    },
    haToken: process.env.SUPERVISOR_TOKEN ?? "",
    apiKey,
  };
}

// Supervisor names an add-on container's host after its slug with "_" → "-"
// (e.g. "a0d7b954-hearth-pi" for slug "a0d7b954_hearth_pi"). In an App any
// such hostname is this add-on's own slug, including renamed forks; in local
// development only a Hearth-looking hostname is taken.
export function selfSlug(
  hostname: string | undefined,
  ingress = false,
): string {
  const value = (hostname ?? "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) return "";
  return ingress || value.endsWith("hearth-pi") ? value.replace(/-/g, "_") : "";
}
