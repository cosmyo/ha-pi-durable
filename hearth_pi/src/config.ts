import { readFile } from "node:fs/promises";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { insist, object, text, entityPattern } from "./safety.js";

export const MAX_ENTITIES = 10000;

export const supportedServices = [
  "light.turn_on",
  "light.turn_off",
  "switch.turn_on",
  "switch.turn_off",
];
export type Policy = {
  enabled: boolean;
  services: string[];
  entities: string[];
};
export type Config = {
  mode: "local" | "ingress";
  host: string;
  port: number;
  origin: string;
  password: string;
  authorizedUsers: string[];
  dataDir: string;
  provider: "offline" | "openai" | "openai-codex";
  model: string;
  thinkingLevel?: ModelThinkingLevel;
  workspaceEnabled?: boolean;
  policy: Policy;
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
  const enabled =
    options.service_actions_enabled ?? process.env.HEARTH_ACTIONS === "true";
  insist(typeof enabled === "boolean");
  const provider = options.provider ?? process.env.HEARTH_PROVIDER ?? "offline";
  insist(
    provider === "offline" ||
      provider === "openai" ||
      provider === "openai-codex",
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
    MAX_ENTITIES,
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
    model: text(
      options.model ||
        process.env.HEARTH_MODEL ||
        (provider === "offline"
          ? "faux"
          : provider === "openai-codex"
            ? "gpt-6.1-sol"
            : "gpt-4.1-mini"),
      100,
    ),
    thinkingLevel,
    workspaceEnabled,
    policy: { enabled, services, entities },
    haToken: process.env.SUPERVISOR_TOKEN ?? "",
    apiKey,
  };
}
