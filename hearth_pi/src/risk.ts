// Deterministic action risk classifier. Every proposed mutation is classified
// here before dispatch; the optional model judge (judge.ts) may only escalate
// the result. This classifier must be a safe floor on its own: whenever it
// cannot see what an action would do, it rates HIGH (or critical), never
// lower. Rules are ordered: the first matching rule names the decision.
// See DOCS.md "Admin access mode" for the published table.
import type {
  Action,
  AdminAction,
  RiskAssessment,
  RiskLevel,
  ServiceTarget,
} from "./documents.js";

export const RISK_LEVELS: readonly RiskLevel[] = [
  "low",
  "medium",
  "high",
  "critical",
];
export const riskRank = (level: RiskLevel) => RISK_LEVELS.indexOf(level);
export const maxRisk = (a: RiskLevel, b: RiskLevel): RiskLevel =>
  riskRank(a) >= riskRank(b) ? a : b;

// Live facts about one targeted entity, read by the controller (never by a
// model). `null` means the entity is missing or could not be read.
export type EntityFacts = {
  name: string;
  deviceClass: string;
  // Update entities: their title (e.g. "Home Assistant Core").
  title: string;
  // Scenes/groups: member entity ids (attributes.entity_id), if readable.
  members: string[] | null;
};
export type RiskContext = {
  // This add-on's own Supervisor slug and display name, if known.
  selfSlug?: string;
  selfName?: string;
  // Facts for the targeted entities (and scene members). Absent means no live
  // read happened: every rule that needs facts then fails closed.
  entities?: Readonly<Record<string, EntityFacts | null>>;
};

const assess = (
  level: RiskLevel,
  rule: string,
  ...reasons: string[]
): RiskAssessment => ({ level, rule, reasons });

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
// Text that identifies Hearth itself: "hearth pi"/"hearth_pi"/"hearth-pi" in
// any case, the running add-on's slug, or its display name.
export function isSelfText(value: string, context: RiskContext): boolean {
  const text = value.toLowerCase();
  if (/hearth[\s_-]?pi/.test(text)) return true;
  if (context.selfSlug && text.includes(context.selfSlug.toLowerCase()))
    return true;
  const name = context.selfName ? slugify(context.selfName) : "";
  return name.length >= 4 && slugify(text).includes(name);
}
// Hearth's own add-on: the slug ends in "_hearth_pi" in any repository, is the
// running add-on's slug, or is Supervisor's "self" alias.
export function isSelfSlug(slug: string, context: RiskContext): boolean {
  const value = slug.toLowerCase();
  return (
    value === "self" ||
    value === "hearth_pi" ||
    value.endsWith("_hearth_pi") ||
    (!!context.selfSlug && value === context.selfSlug.toLowerCase())
  );
}
const mentionsSelf = (value: unknown, context: RiskContext) =>
  isSelfText(JSON.stringify(value ?? null), context);

const LOW_DOMAINS = new Set(["light", "switch", "fan", "media_player"]);
const MEDIUM_DOMAINS = new Set([
  "climate",
  "water_heater",
  "humidifier",
  "vacuum",
  "lawn_mower",
  "notify",
  "persistent_notification",
  "tts",
  "number",
  "select",
  "button",
  "timer",
  "counter",
  "input_boolean",
  "input_number",
  "input_text",
  "input_select",
  "input_datetime",
  "input_button",
]);
const OPENING_CLASSES = new Set(["garage", "gate", "door"]);
const OPENING_NAME = /garage|gate|door/i;
const SYSTEM_UPDATE_ID =
  /^update\.home_assistant_(core|operating_system|supervisor)_update$/;
const SYSTEM_UPDATE_TITLE =
  /home assistant (core|operating system|os|supervisor)/i;

// Scene members: rate by their domains. Only comfort devices stay low.
function memberLevel(
  members: string[] | null | undefined,
  context: RiskContext,
): { level: RiskLevel; reason: string } {
  if (!members || members.length === 0)
    return { level: "high", reason: "Scene members could not be read." };
  if (members.some((m) => isSelfText(m, context)))
    return { level: "critical", reason: "Scene includes Hearth's own entity." };
  let level: RiskLevel = "low";
  const risky: string[] = [];
  for (const id of members) {
    const domain = typeof id === "string" ? id.split(".")[0]! : "";
    if (LOW_DOMAINS.has(domain)) continue;
    if (MEDIUM_DOMAINS.has(domain)) level = maxRisk(level, "medium");
    else {
      level = "high";
      risky.push(String(id));
    }
  }
  return {
    level,
    reason:
      level === "high"
        ? `Scene includes ${risky.slice(0, 5).join(", ")}${risky.length > 5 ? "…" : ""}.`
        : `Scene members: ${members.length} ${level === "low" ? "comfort" : "household"} devices.`,
  };
}
// Entity ids named as keys of a scene's `entities` (scene.apply/create/config).
function sceneEntities(value: unknown): string[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  return keys.length ? keys : null;
}

function classifyService(
  domain: string,
  service: string,
  target: ServiceTarget,
  data: Record<string, unknown>,
  context: RiskContext,
): RiskAssessment {
  const name = `${domain}.${service}`;
  const entities = target.entity_id ?? [];
  const indirect = !!(target.device_id?.length || target.area_id?.length);
  const facts = (id: string) => context.entities?.[id];
  // Self-protection applies to every domain: any target that is Hearth's own
  // entity (its update entity, add-on switch, sensors ...).
  for (const id of entities) {
    const f = facts(id);
    if (
      isSelfText(id, context) ||
      (f && (isSelfText(f.name, context) || isSelfText(f.title, context)))
    )
      return assess(
        "critical",
        "self_protection",
        `Targets Hearth's own entity ${id}.`,
      );
  }
  if (
    ["hassio", "update", "homeassistant"].includes(domain) &&
    mentionsSelf(data, context)
  )
    return assess(
      "critical",
      "self_protection",
      "Targets Hearth's own add-on.",
    );
  if (domain === "hassio") {
    if (["host_reboot", "host_shutdown"].includes(service))
      return assess("critical", "host_power", `${name} reboots or powers off.`);
    if (service.startsWith("restore_"))
      return assess("critical", "backup_restore", `${name} restores a backup.`);
    if (service.startsWith("backup_"))
      return assess("medium", "backup_create", `${name} creates a backup.`);
    if (["addon_start", "addon_restart"].includes(service))
      return assess("medium", "addon_start", `${name} (re)starts an add-on.`);
    return assess("high", "supervisor_service", `${name} controls Supervisor.`);
  }
  if (domain === "update") {
    const system = entities.filter((id) => {
      const f = facts(id);
      return (
        SYSTEM_UPDATE_ID.test(id) || (f && SYSTEM_UPDATE_TITLE.test(f.title))
      );
    });
    if (system.length)
      return assess(
        "critical",
        "system_update",
        `${name} on ${system.join(", ")} changes Home Assistant itself.`,
      );
    if (!["install", "skip", "clear_skipped"].includes(service))
      return assess(
        "high",
        "unknown_service",
        `${name} is not in the known table.`,
      );
    if (indirect || entities.length === 0 || entities.some((id) => !facts(id)))
      return assess(
        "critical",
        "update_unverified",
        "Update targets could not be checked; they may include Core, OS or Supervisor.",
      );
    if (service === "install")
      return assess("high", "update_install", "Installs new software.");
    return assess("medium", "update_skip", `${name} changes an update notice.`);
  }
  if (domain === "homeassistant") {
    if (["restart", "stop"].includes(service))
      return assess("high", "core_restart", `${name} interrupts the home.`);
    if (service === "update_entity")
      return assess("low", "refresh_entity", "Only refreshes a reading.");
    if (service.startsWith("reload"))
      return assess(
        "medium",
        "config_reload",
        `${name} reloads configuration.`,
      );
    return assess(
      "high",
      "generic_homeassistant",
      `${name} can target any domain.`,
    );
  }
  if (domain === "lock")
    return assess("high", "lock", "Locks control physical access.");
  if (domain === "alarm_control_panel")
    return assess("high", "alarm", "Alarm arming/disarming affects security.");
  if (domain === "siren") return assess("high", "siren", "Sirens are loud.");
  if (domain === "camera") {
    if (
      ["turn_off", "disable_motion_detection"].includes(service) ||
      service.startsWith("disable")
    )
      return assess("high", "camera_disable", "Disables surveillance.");
    return assess("medium", "camera", `${name} changes a camera.`);
  }
  if (domain === "cover") {
    if (indirect || entities.length === 0)
      return assess(
        "high",
        "cover_indirect",
        "Device/area cover targets cannot be checked for doors, garage doors or gates.",
      );
    const unreadable = entities.filter((id) => !facts(id));
    if (unreadable.length)
      return assess(
        "high",
        "cover_unverified",
        `Cover targets missing or unreadable: ${unreadable.slice(0, 5).join(", ")}.`,
      );
    const opening = entities.filter((id) => {
      const f = facts(id)!;
      return (
        OPENING_CLASSES.has(f.deviceClass) ||
        OPENING_NAME.test(id) ||
        OPENING_NAME.test(f.name)
      );
    });
    if (opening.length)
      return assess(
        "high",
        "garage_gate_cover",
        `Moves a door, garage door or gate: ${opening.join(", ")}.`,
      );
    return assess("medium", "cover", "Moves blinds, shades or similar.");
  }
  if (domain === "script" || name === "automation.trigger")
    return assess(
      "high",
      "runs_actions",
      `${name} runs actions whose effects are not shown here.`,
    );
  if (domain === "automation")
    return assess(
      "medium",
      "automation_control",
      `${name} changes an automation.`,
    );
  if (domain === "scene") {
    if (service === "turn_on") {
      if (indirect || entities.length === 0)
        return assess(
          "high",
          "scene_unverified",
          "Device/area scene targets cannot be checked.",
        );
      let level: RiskLevel = "low";
      const reasons: string[] = [];
      for (const id of entities) {
        const f = facts(id);
        const member = memberLevel(f ? f.members : null, context);
        level = maxRisk(level, member.level);
        reasons.push(`${id}: ${member.reason}`);
      }
      return assess(
        level,
        level === "low" ? "scene_on" : "scene_members",
        ...reasons,
      );
    }
    if (service === "apply" || service === "create") {
      const member = memberLevel(
        sceneEntities(data.entities) ??
          (Array.isArray(data.snapshot_entities)
            ? (data.snapshot_entities as string[])
            : null),
        context,
      );
      return assess(
        maxRisk("medium", member.level),
        member.level === "high" || member.level === "critical"
          ? "scene_members"
          : "scene_config",
        member.reason,
      );
    }
    return assess("medium", "scene_config", `${name} changes scenes.`);
  }
  if (LOW_DOMAINS.has(domain))
    return assess(
      "low",
      "comfort_device",
      `${name} is a reversible comfort control.`,
    );
  if (MEDIUM_DOMAINS.has(domain))
    return assess(
      "medium",
      "household_device",
      `${name} changes household state.`,
    );
  return assess(
    "high",
    "unknown_service",
    `${name} is not in the known table; unknown services ask.`,
  );
}

// Every domain.service-shaped token anywhere in a config body, matched
// case-insensitively over the whole serialized text — including templates,
// device actions and keys the scanner does not otherwise understand. Bodies
// are capped at 32 KB by validation, so the scan is complete, not sampled.
function referencedTokens(body: unknown): string[] {
  const text = JSON.stringify(body ?? null).toLowerCase();
  return [...new Set(text.match(/[a-z_][a-z0-9_]*\.[a-z0-9_]+/g) ?? [])];
}

function classifyConfig(
  action: Extract<AdminAction, { kind: "config" }>,
  context: RiskContext,
): RiskAssessment {
  if (mentionsSelf(action.body, context) || isSelfText(action.id, context))
    return assess(
      "critical",
      "self_protection",
      "Configuration refers to Hearth's own add-on.",
    );
  if (action.op === "delete")
    return assess(
      "high",
      "config_delete",
      `Deletes ${action.resource} ${action.id}; not reversible from Hearth.`,
    );
  // Floor: a stored automation/script can later run any action without a
  // person, so writing one is at least high regardless of what a scan finds.
  let result =
    action.resource === "scene"
      ? (() => {
          const member = memberLevel(
            sceneEntities(action.body?.entities),
            context,
          );
          return member.level === "high" || member.level === "critical"
            ? assess(member.level, "scene_config_members", member.reason)
            : assess("medium", "config_write", `Writes scene ${action.id}.`);
        })()
      : assess(
          "high",
          "config_runs_actions",
          `Writes ${action.resource} ${action.id}, which can later run actions without approval.`,
        );
  // Critical services anywhere in the body (templates, odd casing included).
  for (const token of referencedTokens(action.body)) {
    const [domain = "", service = ""] = token.split(".");
    if (!["hassio", "update", "homeassistant"].includes(domain)) continue;
    const inner = classifyService(domain, service, {}, {}, context);
    if (inner.level === "critical" && result.level !== "critical")
      result = assess(
        "critical",
        `config_calls_${inner.rule}`,
        `Configuration refers to ${token}: ${inner.reasons.join(" ")}`,
      );
  }
  return result;
}

const WS_HELPER =
  /^(input_boolean|input_number|input_text|input_select|input_datetime|input_button)\/(create|update|delete)$/;
const SENSITIVE_ENTITY_DOMAINS = new Set([
  "cover",
  "lock",
  "alarm_control_panel",
  "siren",
  "camera",
]);

function classifyAdmin(
  action: AdminAction,
  context: RiskContext,
): RiskAssessment {
  switch (action.kind) {
    case "service":
      return classifyService(
        action.domain,
        action.service,
        action.target,
        action.data,
        context,
      );
    case "config":
      return classifyConfig(action, context);
    case "ws": {
      if (mentionsSelf(action.payload, context))
        return assess(
          "critical",
          "self_protection",
          "Changes Hearth's own registry entry.",
        );
      if (WS_HELPER.test(action.type))
        return assess(
          "medium",
          "helper_config",
          `${action.type} changes a helper.`,
        );
      if (action.type === "config/entity_registry/update") {
        const id = String(action.payload.entity_id ?? "");
        const renamed = [
          "new_entity_id",
          "name",
          "disabled_by",
          "hidden_by",
        ].filter((k) => action.payload[k] !== undefined);
        // Renaming/hiding a door, lock or alarm can defeat name-based checks.
        if (SENSITIVE_ENTITY_DOMAINS.has(id.split(".")[0]!) && renamed.length)
          return assess(
            "high",
            "sensitive_registry_rename",
            `Changes ${renamed.join(", ")} of ${id}.`,
          );
      }
      if (action.type.startsWith("config/"))
        return assess(
          "medium",
          "registry_write",
          `${action.type} changes a registry.`,
        );
      return assess(
        "high",
        "unknown_ws",
        `${action.type} is not in the known table.`,
      );
    }
    case "supervisor":
      return classifySupervisor(action.method, action.path, context);
  }
}

function classifySupervisor(
  method: string,
  path: string,
  context: RiskContext,
): RiskAssessment {
  const route = `${method} ${path}`;
  const addon = /^\/(?:store\/)?addons\/([^/]+)\/([a-z]+)$/.exec(path);
  if (addon && isSelfSlug(addon[1]!, context))
    return assess(
      "critical",
      "self_protection",
      "Changes, stops or removes Hearth's own add-on.",
    );
  if (/^\/host\/(reboot|shutdown)$/.test(path))
    return assess(
      "critical",
      "host_power",
      `${route} reboots or powers off the host.`,
    );
  if (/^\/backups\/[^/]+\/restore\/(full|partial)$/.test(path))
    return assess(
      "critical",
      "backup_restore",
      "Restoring replaces current data.",
    );
  if (method === "DELETE" && /^\/backups\/[^/]+$/.test(path))
    return assess(
      "critical",
      "backup_remove",
      "Deleting a backup is irreversible.",
    );
  if (/^\/(core|os|supervisor)\/update$/.test(path))
    return assess("critical", "system_update", `${route} updates the system.`);
  if (addon) {
    const op = addon[2]!;
    if (op === "uninstall")
      return assess(
        "critical",
        "addon_uninstall",
        "Uninstalls an add-on and its data.",
      );
    if (op === "start" || op === "restart")
      return assess("medium", "addon_start", `${route} (re)starts an add-on.`);
    if (op === "stop")
      return assess("high", "addon_stop", "Stops a running add-on.");
    if (op === "install")
      return assess("high", "addon_install", "Installs new software.");
    if (op === "update")
      return assess("high", "addon_update", "Updates an add-on.");
    if (op === "options")
      return assess(
        "high",
        "addon_options",
        "Changes an add-on's configuration.",
      );
  }
  if (/^\/backups\/new\/(full|partial)$/.test(path))
    return assess("medium", "backup_create", "Creates a backup.");
  if (path === "/core/restart")
    return assess("high", "core_restart", "Restarts Home Assistant Core.");
  return assess(
    "high",
    "unknown_supervisor",
    `${route} is not in the known table.`,
  );
}

export function classifyAction(
  action: Action,
  context: RiskContext = {},
): RiskAssessment {
  if ("kind" in action) return classifyAdmin(action, context);
  const [domain = "", service = ""] = action.service.split(".");
  return classifyService(
    domain,
    service,
    { entity_id: [action.entityId] },
    action.data,
    context,
  );
}

// Entity ids whose live facts the classifier uses for this action.
export function riskTargets(action: Action): string[] {
  if (!("kind" in action) || action.kind !== "service") return [];
  return action.target.entity_id ?? [];
}

// The exact word a critical approval must repeat: the add-on/backup slug when
// one is named, otherwise a fixed verb.
export function confirmationWord(action: Action): string {
  if ("kind" in action && action.kind === "supervisor") {
    const host = /^\/host\/(reboot|shutdown)$/.exec(action.path);
    if (host) return host[1]!.toUpperCase();
    const slug =
      /^\/(?:store\/)?(?:addons|backups)\/([a-z0-9_-]+)(?:\/|$)/.exec(
        action.path,
      );
    if (slug && slug[1] !== "new") return slug[1]!;
    if (/\/update$/.test(action.path)) return "UPDATE";
  }
  if ("kind" in action && action.kind === "config") return action.id;
  if (
    "kind" in action &&
    action.kind === "service" &&
    action.domain === "update"
  )
    return "UPDATE";
  return "CONFIRM";
}
