import { readFile } from "node:fs/promises";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { Fault, insist, object, text, entityPattern } from "./safety.js";
import { anthropicAuthEnabled } from "./features.js";

export const MAX_ENTITIES = 10000;

export const supportedServices = [
  "light.turn_on",
  "light.turn_off",
  "switch.turn_on",
  "switch.turn_off",
  // Shared lists (Home Assistant to-do lists); see src/lists.ts.
  "todo.add_item",
  "todo.update_item",
  "todo.remove_item",
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
// Optional prompt-injection guard for tool output (src/injection-guard.ts):
// any HTTP service implementing POST <url>/v1/guard/injection. Empty url: off.
export type InjectionGuardConfig = {
  url: string;
  apiKey: string;
  timeoutMs: number;
};
export const JUDGE_MODEL_PATTERN =
  /^(off|auto|[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119})$/;
export type Config = {
  mode: "local" | "ingress";
  host: string;
  port: number;
  origin: string;
  // Exact browser origins allowed to make mutations and embed the App.
  // `origin` remains the primary/backward-compatible public_origin.
  origins?: string[];
  password: string;
  authorizedUsers: string[];
  dataDir: string;
  provider: "offline" | "openai" | "openai-codex" | "anthropic" | "local";
  model: string;
  thinkingLevel?: ModelThinkingLevel;
  anthropicAuthEnabled?: boolean;
  workspaceEnabled?: boolean;
  // Authorized owners who may use Code (workspace) sessions: the
  // workspace_owner_ids option, else the one authorized owner. loadConfig
  // always sets it when the workspace is enabled; see workspaceOwners().
  workspaceOwners?: string[];
  // Household roles (member_user_ids / guest_user_ids): authorized users
  // listed here are members or guests; every other authorized user is an
  // owner. Absent means everyone is an owner. Never set by the UI.
  memberUsers?: string[];
  guestUsers?: string[];
  // Trusted owners (trusted_user_ids): on Full access, their own direct
  // turns auto-run at every risk level (src/home-actions.ts). Each is an
  // authorized owner, never a member or guest. Absent or empty: nobody.
  trustedUsers?: string[];
  // Phone approvals (src/approval-push.ts): the approval_notifications
  // option, ingress mode only. Absent means off.
  approvalNotifications?: boolean;
  // This add-on's Supervisor slug in either access mode (for the "Open
  // Hearth" notification link); empty when unknown.
  selfSlug?: string;
  // Hearth Assist (src/assist.ts): the assist_enabled option, ingress mode
  // only. Absent means off.
  assistEnabled?: boolean;
  // Admin-set voice satellites (assist_satellites): a Home Assistant device
  // id and the authorized person it speaks for (with an Ask ceiling).
  assistSatellites?: AssistSatellite[];
  // This container's hostname, published to Home Assistant Core through
  // Supervisor discovery so Core can reach the Assist listener.
  hostname?: string;
  policy: Policy;
  judge?: JudgeConfig;
  injectionGuard?: InjectionGuardConfig;
  // "off", "auto" or "<provider>/<modelId>": the optional briefing summary's
  // model (src/briefing-summary.ts). Optional so existing test/local
  // fixtures that build a Config without it keep working; main.ts defaults
  // a missing value to "auto", matching the risk judge's own default.
  briefingSummaryModel?: string;
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
// All listed owners share the one confined worker volume; keep it small.
export const MAX_WORKSPACE_OWNERS = 5;
// Fault codes loadConfig raises for a specific, value-free configuration
// problem. Startup may name these (never the option values); any other
// failure keeps the generic message because raw errors can contain secrets.
export const CONFIG_FAULT_CODES: ReadonlySet<string> = new Set([
  "explicit_mode_required",
  "invalid_public_origin",
  "invalid_public_origins",
  "invalid_access_mode",
  "invalid_risk_judge_model",
  "invalid_risk_judge_url",
  "invalid_risk_judge_timeout",
  "invalid_risk_judge_session_ttl",
  "risk_judge_url_required",
  "invalid_injection_guard_url",
  "invalid_injection_guard_api_key",
  "invalid_injection_guard_timeout",
  "invalid_briefing_summary_model",
  "anthropic_auth_disabled",
  "workspace_requires_one_trusted_owner",
  "workspace_requires_ingress",
  "invalid_workspace_owner_ids",
  "workspace_owner_not_authorized",
  "approval_notifications_requires_ingress",
  "invalid_role_user_ids",
  "role_user_not_authorized",
  "role_conflict",
  "invalid_trusted_user_ids",
  "trusted_user_not_authorized",
  "trusted_user_not_owner_role",
  "household_owner_required",
  "workspace_owner_not_owner_role",
  "provider_key_required",
  "assist_requires_ingress",
  "invalid_assist_satellites",
  "assist_satellite_user_not_authorized",
]);
export const MAX_PUBLIC_ORIGINS = 10;
function publicOrigin(value: unknown, local: boolean): string {
  let origin: string;
  try {
    origin = text(value, 300);
    const url = new URL(origin);
    insist(
      url.origin === origin &&
        !origin.includes("*") &&
        !url.username &&
        !url.password &&
        !url.pathname.slice(1) &&
        !url.search &&
        !url.hash &&
        origin !== "null" &&
        (local
          ? url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
          : url.protocol === "http:" || url.protocol === "https:"),
    );
  } catch {
    throw new Fault(400, "invalid_public_origin");
  }
  return origin;
}
export function publicOrigins(
  primary: unknown,
  alternatives: unknown,
  local: boolean,
): string[] {
  insist(Array.isArray(alternatives), "invalid_public_origins");
  insist(alternatives.length <= MAX_PUBLIC_ORIGINS, "invalid_public_origins");
  const values = [
    publicOrigin(primary, local),
    ...(alternatives as unknown[]).map((value) => publicOrigin(value, false)),
  ];
  insist(new Set(values).size === values.length, "invalid_public_origins");
  return values;
}
// The startup log line for a loadConfig failure: the known Fault code only.
export function configurationDiagnostic(error: unknown): string | undefined {
  return error instanceof Fault && CONFIG_FAULT_CODES.has(error.code)
    ? `invalid configuration: ${error.code}`
    : undefined;
}
export type HouseholdRole = "owner" | "member" | "guest";
export type AssistSatellite = { deviceId: string; userId: string };
export const MAX_ASSIST_SATELLITES = 50;
export const ASSIST_DEVICE_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
// assist_satellites: unique device ids, each mapped to an authorized user.
export function assistSatellites(
  value: unknown,
  authorizedUsers: readonly string[],
): AssistSatellite[] {
  insist(
    Array.isArray(value) && value.length <= MAX_ASSIST_SATELLITES,
    "invalid_assist_satellites",
  );
  const out: AssistSatellite[] = [];
  for (const raw of value as unknown[]) {
    insist(
      raw !== null &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        Object.keys(raw).every((k) => k === "device_id" || k === "user_id"),
      "invalid_assist_satellites",
    );
    const { device_id: deviceId, user_id: userId } = raw as Record<
      string,
      unknown
    >;
    insist(
      typeof deviceId === "string" &&
        ASSIST_DEVICE_PATTERN.test(deviceId) &&
        typeof userId === "string" &&
        /^[a-zA-Z0-9_-]{1,100}$/.test(userId),
      "invalid_assist_satellites",
    );
    insist(
      !out.some((s) => s.deviceId === deviceId),
      "invalid_assist_satellites",
    );
    insist(
      authorizedUsers.includes(userId),
      "assist_satellite_user_not_authorized",
    );
    out.push({ deviceId, userId });
  }
  return out;
}
// Each configured member's and guest's household role; everyone else
// (and local-admin) is an owner.
export function householdRoles(
  config: Pick<Config, "memberUsers" | "guestUsers">,
): Record<string, Exclude<HouseholdRole, "owner">> {
  const roles: Record<string, Exclude<HouseholdRole, "owner">> = {};
  for (const id of config.memberUsers ?? []) roles[id] = "member";
  for (const id of config.guestUsers ?? []) roles[id] = "guest";
  delete roles["local-admin"];
  return roles;
}
// Trusted owners in effect: none in local development (no App options).
export function trustedOwners(config: Pick<Config, "mode" | "trustedUsers">) {
  return config.mode === "local" ? [] : [...(config.trustedUsers ?? [])];
}
// Owners allowed Code (workspace) sessions; empty when the workspace is off.
// A hand-built Config without workspaceOwners keeps the original rule: the
// one authorized owner (or the local-development owner).
export function workspaceOwners(config: Config): string[] {
  if (!config.workspaceEnabled) return [];
  if (config.workspaceOwners) return config.workspaceOwners;
  if (config.mode === "local") return ["local-admin"];
  return config.authorizedUsers.length === 1 ? config.authorizedUsers : [];
}
export async function loadConfig(
  optionsFile = "/data/options.json",
): Promise<Config> {
  const mode = process.env.HEARTH_MODE;
  insist(mode === "local" || mode === "ingress", "explicit_mode_required");
  const options =
    mode === "ingress"
      ? object(JSON.parse(await readFile(optionsFile, "utf8")), [
          "authorized_user_ids",
          "service_actions_enabled",
          "allowed_services",
          "allowed_entities",
          "public_origin",
          "public_origins",
          "provider",
          "model",
          "openai_api_key",
          "workspace_enabled",
          "workspace_owner_ids",
          "anthropic_auth_enabled",
          "access_mode",
          "risk_judge_model",
          "risk_judge_url",
          "risk_judge_api_key",
          "risk_judge_timeout_ms",
          "risk_judge_session_ttl_ms",
          "injection_guard_url",
          "injection_guard_api_key",
          "injection_guard_timeout_ms",
          "briefing_summary_model",
          "approval_notifications",
          "member_user_ids",
          "guest_user_ids",
          "trusted_user_ids",
          "assist_enabled",
          "assist_satellites",
        ])
      : {};
  const port =
    mode === "ingress" ? 8099 : Number(process.env.HEARTH_PORT ?? 8099);
  insist(Number.isInteger(port) && port >= 1024 && port <= 65535);
  const origin =
    options.public_origin ??
    process.env.HEARTH_ORIGIN ??
    `http://127.0.0.1:${port}`;
  const alternativeOrigins =
    mode === "ingress"
      ? (options.public_origins ?? [])
      : (process.env.HEARTH_PUBLIC_ORIGINS ?? "").split(",").filter(Boolean);
  const origins = publicOrigins(origin, alternativeOrigins, mode === "local");
  const password =
    mode === "local" ? text(process.env.HEARTH_LOCAL_PASSWORD, 200, 24) : "";
  const authorizedUsers = strings(options.authorized_user_ids ?? [], 100);
  const services = strings(
    options.allowed_services ??
      (process.env.HEARTH_ALLOWED_SERVICES ?? "").split(",").filter(Boolean),
    supportedServices.length,
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
  const judgeUrl = endpointOption(
    options.risk_judge_url ?? process.env.HEARTH_RISK_JUDGE_URL ?? "",
    "invalid_risk_judge_url",
  );
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
  // Prompt-injection guard for tool output: off unless a URL is set.
  const guardUrl = endpointOption(
    options.injection_guard_url ?? process.env.HEARTH_INJECTION_GUARD_URL ?? "",
    "invalid_injection_guard_url",
  );
  const guardKey =
    options.injection_guard_api_key ??
    process.env.HEARTH_INJECTION_GUARD_API_KEY ??
    "";
  insist(
    typeof guardKey === "string" &&
      (!guardKey || /^[A-Za-z0-9._~+/=:-]{1,500}$/.test(guardKey)),
    "invalid_injection_guard_api_key",
  );
  const guardTimeout = Number(
    options.injection_guard_timeout_ms ??
      process.env.HEARTH_INJECTION_GUARD_TIMEOUT_MS ??
      3000,
  );
  insist(
    Number.isInteger(guardTimeout) &&
      guardTimeout >= 500 &&
      guardTimeout <= 30000,
    "invalid_injection_guard_timeout",
  );
  const briefingSummaryModel = text(
    options.briefing_summary_model ||
      process.env.HEARTH_BRIEFING_SUMMARY_MODEL ||
      "auto",
    200,
  );
  insist(
    JUDGE_MODEL_PATTERN.test(briefingSummaryModel),
    "invalid_briefing_summary_model",
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
  // An empty list (the App option's default) means "not set".
  const workspaceOwnerIds = options.workspace_owner_ids ?? [];
  insist(
    Array.isArray(workspaceOwnerIds) &&
      workspaceOwnerIds.length <= MAX_WORKSPACE_OWNERS &&
      workspaceOwnerIds.every(
        (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id),
      ),
    "invalid_workspace_owner_ids",
  );
  const configuredWorkspaceOwners = [...new Set(workspaceOwnerIds as string[])];
  if (workspaceEnabled && configuredWorkspaceOwners.length) {
    insist(mode === "ingress", "workspace_requires_ingress");
    insist(
      configuredWorkspaceOwners.every((id) => authorizedUsers.includes(id)),
      "workspace_owner_not_authorized",
    );
  } else if (workspaceEnabled)
    insist(
      mode === "ingress" && authorizedUsers.length === 1,
      "workspace_requires_one_trusted_owner",
    );
  const approvalNotifications =
    options.approval_notifications ??
    process.env.HEARTH_APPROVAL_NOTIFICATIONS === "true";
  insist(typeof approvalNotifications === "boolean");
  insist(
    !approvalNotifications || mode === "ingress",
    "approval_notifications_requires_ingress",
  );
  // Household roles: optional lists of authorized users who are members or
  // guests; everyone else stays an owner.
  const roleIds = (value: unknown) => {
    insist(
      Array.isArray(value) &&
        value.length <= 100 &&
        value.every(
          (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id),
        ),
      "invalid_role_user_ids",
    );
    return [...new Set(value as string[])];
  };
  const memberUsers = roleIds(options.member_user_ids ?? []);
  const guestUsers = roleIds(options.guest_user_ids ?? []);
  insist(
    [...memberUsers, ...guestUsers].every((id) => authorizedUsers.includes(id)),
    "role_user_not_authorized",
  );
  insist(!memberUsers.some((id) => guestUsers.includes(id)), "role_conflict");
  insist(
    !authorizedUsers.length ||
      authorizedUsers.some(
        (id) => !memberUsers.includes(id) && !guestUsers.includes(id),
      ),
    "household_owner_required",
  );
  // Trusted owners: an opt-in list (empty by default) of authorized owners
  // whose own direct turns on Full access run at every risk level.
  const trustedValue = options.trusted_user_ids ?? [];
  insist(
    Array.isArray(trustedValue) &&
      trustedValue.length <= 100 &&
      trustedValue.every(
        (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id),
      ),
    "invalid_trusted_user_ids",
  );
  const trustedUsers = [...new Set(trustedValue as string[])];
  insist(
    trustedUsers.every((id) => authorizedUsers.includes(id)),
    "trusted_user_not_authorized",
  );
  insist(
    !trustedUsers.some(
      (id) => memberUsers.includes(id) || guestUsers.includes(id),
    ),
    "trusted_user_not_owner_role",
  );
  // Hearth Assist: off by default; the separate Core listener and the
  // Supervisor discovery exist only in ingress mode.
  const assistEnabled = options.assist_enabled ?? false;
  insist(typeof assistEnabled === "boolean");
  insist(!assistEnabled || mode === "ingress", "assist_requires_ingress");
  const satellites = assistSatellites(
    options.assist_satellites ?? [],
    authorizedUsers,
  );
  // Code sessions belong to owners only.
  const effectiveWorkspaceOwners = workspaceEnabled
    ? configuredWorkspaceOwners.length
      ? configuredWorkspaceOwners
      : authorizedUsers
    : [];
  insist(
    !effectiveWorkspaceOwners.some(
      (id) => memberUsers.includes(id) || guestUsers.includes(id),
    ),
    "workspace_owner_not_owner_role",
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
    origin: origins[0]!,
    origins,
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
    workspaceOwners: effectiveWorkspaceOwners,
    approvalNotifications,
    memberUsers,
    guestUsers,
    trustedUsers,
    assistEnabled,
    assistSatellites: satellites,
    hostname: /^[a-z0-9][a-z0-9-]{0,63}$/.test(process.env.HOSTNAME ?? "")
      ? process.env.HOSTNAME
      : "",
    selfSlug: selfSlug(process.env.HOSTNAME, mode === "ingress"),
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
    injectionGuard: {
      url: guardUrl,
      apiKey: guardKey,
      timeoutMs: guardTimeout,
    },
    briefingSummaryModel,
    haToken: process.env.SUPERVISOR_TOKEN ?? "",
    apiKey,
  };
}

// An optional http(s) service base URL from the App options: syntax only
// here; private-address resolution is re-checked on every call.
function endpointOption(value: unknown, code: string): string {
  const url = text(value, 300, 0);
  if (!url) return url;
  insist(URL.canParse(url), code);
  const parsed = new URL(url);
  insist(
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash,
    code,
  );
  return url;
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
