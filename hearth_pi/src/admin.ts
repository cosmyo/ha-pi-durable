// Admin access mode: strict validation of every admin action kind, the
// Supervisor endpoint allowlists and log redaction. Nothing here dispatches;
// HAClient does, and only for actions admitted by the Home permissions broker.
// Supervisor endpoints are reached directly over its own REST API
// (http://supervisor/<path>, Authorization: Bearer $SUPERVISOR_TOKEN) rather
// than through Home Assistant Core: Core's "supervisor/api" WebSocket command
// rejects the add-on's Supervisor-proxied connection with {"code":
// "unauthorized"} because it is not an HA admin user (verified against a real
// Home Assistant 2026.9 / current Supervisor install).
import type { AdminAction, JsonObject, ServiceTarget } from "./documents.js";
import { entityPattern, insist, object, text } from "./safety.js";

export const ADMIN_LIMITS = Object.freeze({
  serviceDataBytes: 8192,
  configBodyBytes: 32768,
  wsPayloadBytes: 4096,
  supervisorBodyBytes: 16384,
  targets: 50,
  depth: 12,
  logBytes: 16384,
  readBytes: 24576,
});

const DOMAIN = /^[a-z][a-z0-9_]{0,63}$/;
const SERVICE = /^[a-z0-9][a-z0-9_]{0,63}$/;
const REGISTRY_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const CONFIG_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SLUG = "[a-z0-9_-]{1,64}";

// Plain JSON only (no prototype tricks), bounded depth and serialized size.
export function jsonObject(value: unknown, maxBytes: number): JsonObject {
  insist(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid_action_shape",
  );
  const check = (v: unknown, depth: number): void => {
    insist(depth <= ADMIN_LIMITS.depth, "action_too_deep");
    if (v === null || typeof v === "boolean" || typeof v === "string") return;
    if (typeof v === "number") return insist(Number.isFinite(v));
    if (Array.isArray(v)) {
      for (const item of v) check(item, depth + 1);
      return;
    }
    insist(
      typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype,
      "invalid_action_shape",
    );
    for (const [key, item] of Object.entries(v as object)) {
      insist(
        key.length <= 100 && !["__proto__", "constructor"].includes(key),
        "invalid_action_shape",
      );
      check(item, depth + 1);
    }
  };
  check(value, 0);
  const serialized = JSON.stringify(value);
  insist(
    Buffer.byteLength(serialized) <= maxBytes &&
      !serialized.includes("\\u0000"),
    "action_too_large",
    413,
  );
  return JSON.parse(serialized) as JsonObject;
}

function ids(value: unknown, pattern: RegExp): string[] | undefined {
  if (value === undefined) return undefined;
  const list = typeof value === "string" ? [value] : value;
  insist(
    Array.isArray(list) &&
      list.length >= 1 &&
      list.length <= ADMIN_LIMITS.targets &&
      list.every((v) => typeof v === "string" && pattern.test(v)),
    "invalid_target",
  );
  return [...new Set(list as string[])].sort();
}

function serviceAction(v: Record<string, unknown>): AdminAction {
  object(v, ["kind", "domain", "service", "target", "data"]);
  const domain = text(v.domain, 64),
    service = text(v.service, 64);
  insist(DOMAIN.test(domain) && SERVICE.test(service), "invalid_service");
  const t = object(v.target ?? {}, ["entity_id", "device_id", "area_id"]);
  const target: ServiceTarget = {};
  const entity = ids(t.entity_id, entityPattern);
  const device = ids(t.device_id, REGISTRY_ID);
  const area = ids(t.area_id, REGISTRY_ID);
  if (entity) target.entity_id = entity;
  if (device) target.device_id = device;
  if (area) target.area_id = area;
  const data = jsonObject(v.data ?? {}, ADMIN_LIMITS.serviceDataBytes);
  // Targets live only in `target`, where the classifier and card show them.
  insist(
    !["entity_id", "device_id", "area_id", "floor_id", "label_id"].some((k) =>
      Object.hasOwn(data, k),
    ),
    "target_in_data",
  );
  return { kind: "service", domain, service, target, data };
}

function configAction(v: Record<string, unknown>): AdminAction {
  object(v, ["kind", "resource", "op", "id", "body"]);
  insist(
    v.resource === "automation" ||
      v.resource === "script" ||
      v.resource === "scene",
    "invalid_config_resource",
  );
  insist(v.op === "upsert" || v.op === "delete", "invalid_config_op");
  const id = text(v.id, 100);
  insist(CONFIG_ID.test(id), "invalid_config_id");
  if (v.op === "delete") {
    insist(v.body === undefined, "invalid_action_shape");
    return { kind: "config", resource: v.resource, op: "delete", id };
  }
  const body = jsonObject(v.body, ADMIN_LIMITS.configBodyBytes);
  insist(Object.keys(body).length > 0, "config_body_required");
  return { kind: "config", resource: v.resource, op: "upsert", id, body };
}

// Admin WebSocket mutations Hearth may propose, each with its exact allowed
// payload keys. Any other type is refused before a frame is written.
const HELPERS = [
  "input_boolean",
  "input_number",
  "input_text",
  "input_select",
  "input_datetime",
  "input_button",
] as const;
const HELPER_FIELDS = [
  "name",
  "icon",
  "initial",
  "min",
  "max",
  "step",
  "mode",
  "unit_of_measurement",
  "options",
  "pattern",
  "has_date",
  "has_time",
];
export const ADMIN_WS_MUTATIONS: Readonly<
  Record<string, { required: string[]; optional: string[] }>
> = Object.freeze({
  "config/entity_registry/update": {
    required: ["entity_id"],
    optional: [
      "name",
      "icon",
      "area_id",
      "disabled_by",
      "hidden_by",
      "new_entity_id",
      "aliases",
      "labels",
    ],
  },
  "config/device_registry/update": {
    required: ["device_id"],
    optional: ["area_id", "name_by_user", "disabled_by", "labels"],
  },
  "config/area_registry/create": {
    required: ["name"],
    optional: ["icon", "floor_id", "aliases", "labels", "picture"],
  },
  "config/area_registry/update": {
    required: ["area_id"],
    optional: ["name", "icon", "floor_id", "aliases", "labels", "picture"],
  },
  "config/area_registry/delete": { required: ["area_id"], optional: [] },
  ...Object.fromEntries(
    HELPERS.flatMap((h) => [
      [`${h}/create`, { required: ["name"], optional: HELPER_FIELDS }],
      [`${h}/update`, { required: [`${h}_id`], optional: HELPER_FIELDS }],
      [`${h}/delete`, { required: [`${h}_id`], optional: [] }],
    ]),
  ),
});

function wsAction(v: Record<string, unknown>): AdminAction {
  object(v, ["kind", "type", "payload"]);
  const type = text(v.type, 80);
  insist(Object.hasOwn(ADMIN_WS_MUTATIONS, type), "ws_type_not_allowed", 403);
  const spec = ADMIN_WS_MUTATIONS[type]!;
  const payload = jsonObject(v.payload ?? {}, ADMIN_LIMITS.wsPayloadBytes);
  insist(
    Object.keys(payload).every(
      (k) => spec.required.includes(k) || spec.optional.includes(k),
    ) && spec.required.every((k) => payload[k] !== undefined),
    "invalid_ws_payload",
  );
  for (const key of ["entity_id", "new_entity_id"])
    if (payload[key] !== undefined)
      insist(
        typeof payload[key] === "string" &&
          entityPattern.test(payload[key] as string),
        "invalid_ws_payload",
      );
  for (const key of ["device_id", "area_id", ...HELPERS.map((h) => `${h}_id`)])
    if (payload[key] !== undefined && payload[key] !== null)
      insist(
        typeof payload[key] === "string" &&
          REGISTRY_ID.test(payload[key] as string),
        "invalid_ws_payload",
      );
  return { kind: "ws", type, payload };
}

// Supervisor REST paths reachable directly over http://supervisor, with the
// add-on token's "manager" Supervisor role (config.yaml hassio_api/
// hassio_role). Reads are tools; mutations are broker proposals. Every path
// here is covered by the "manager" role per Supervisor's own
// api/middleware/security.py ADDONS_ROLE_ACCESS (verified against the
// upstream source); none of Hearth's allowlisted endpoints need "admin".
export const SUPERVISOR_READS: readonly RegExp[] = [
  /^\/addons$/,
  new RegExp(`^/addons/${SLUG}/(info|logs|stats)$`),
  /^\/backups$/,
  new RegExp(`^/backups/${SLUG}/info$`),
  /^\/(core|supervisor)\/(info|logs)$/,
  /^\/(os|host|network|resolution)\/info$/,
  // Background job status for the mutations below that queue a job instead
  // of blocking (see SUPERVISOR_MUTATIONS' `background`).
  /^\/jobs\/info$/,
  /^\/jobs\/[0-9a-fA-F-]{8,64}$/,
  /^\/store$/,
  /^\/store\/addons$/,
];
export const SUPERVISOR_MUTATIONS: readonly {
  method: "POST" | "DELETE";
  path: RegExp;
  // Supervisor's own ceiling for this operation (ha-admin.ts aborts and
  // treats the outcome as unknown past it, never retried).
  timeoutMs: number;
  // Ask Supervisor to queue a job and return immediately instead of holding
  // the HTTP request open for the full ceiling above; only set where
  // Supervisor's endpoint documents a `background` option.
  background?: boolean;
}[] = [
  {
    method: "POST",
    path: new RegExp(`^/addons/${SLUG}/(start|stop|restart|options)$`),
    timeoutMs: 60000,
  },
  {
    method: "POST",
    path: new RegExp(`^/addons/${SLUG}/uninstall$`),
    timeoutMs: 120000,
  },
  {
    // Deprecated by Supervisor in favour of /store/addons/<slug>/update, but
    // still served; kept so existing proposals and docs stay valid.
    method: "POST",
    path: new RegExp(`^/addons/${SLUG}/update$`),
    timeoutMs: 900000,
    background: true,
  },
  {
    method: "POST",
    path: new RegExp(`^/store/addons/${SLUG}/(install|update)$`),
    timeoutMs: 900000,
    background: true,
  },
  {
    method: "POST",
    path: /^\/backups\/new\/(full|partial)$/,
    timeoutMs: 600000,
    background: true,
  },
  {
    method: "POST",
    path: new RegExp(`^/backups/${SLUG}/restore/(full|partial)$`),
    timeoutMs: 600000,
    background: true,
  },
  {
    method: "DELETE",
    path: new RegExp(`^/backups/${SLUG}$`),
    timeoutMs: 30000,
  },
  { method: "POST", path: /^\/core\/restart$/, timeoutMs: 60000 },
  // Core/OS/Supervisor updates have no documented `background` option: they
  // block for the full ceiling.
  { method: "POST", path: /^\/core\/update$/, timeoutMs: 900000 },
  { method: "POST", path: /^\/(supervisor|os)\/update$/, timeoutMs: 900000 },
  { method: "POST", path: /^\/host\/(reboot|shutdown)$/, timeoutMs: 30000 },
];
export function supervisorReadAllowed(path: unknown): string {
  const value = text(path, 120);
  insist(
    SUPERVISOR_READS.some((p) => p.test(value)),
    "supervisor_endpoint_not_allowed",
    403,
  );
  return value;
}
function supervisorAction(v: Record<string, unknown>): AdminAction {
  object(v, ["kind", "method", "path", "body"]);
  insist(v.method === "POST" || v.method === "DELETE", "invalid_method");
  const path = text(v.path, 120);
  insist(
    SUPERVISOR_MUTATIONS.some(
      (m) => m.method === v.method && m.path.test(path),
    ),
    "supervisor_endpoint_not_allowed",
    403,
  );
  if (v.body === undefined)
    return { kind: "supervisor", method: v.method, path };
  const body = jsonObject(v.body, ADMIN_LIMITS.supervisorBodyBytes);
  return { kind: "supervisor", method: v.method, path, body };
}

export function adminAction(value: unknown): AdminAction {
  insist(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid_action_shape",
  );
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "service":
      return serviceAction(v);
    case "config":
      return configAction(v);
    case "ws":
      return wsAction(v);
    case "supervisor":
      return supervisorAction(v);
    default:
      throw insistFail();
  }
}
const insistFail = () => {
  try {
    insist(false, "invalid_action_kind");
  } catch (error) {
    return error;
  }
};

// Logs are untrusted text: strip common credential shapes, then keep the tail.
export function redactLog(value: string, redact: (s: string) => string) {
  const cleaned = redact(value)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
      "[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(
      /\b(password|passwd|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      "$1$2[REDACTED]",
    );
  const bytes = Buffer.from(cleaned, "utf8");
  return bytes.length <= ADMIN_LIMITS.logBytes
    ? { text: cleaned, truncated: false }
    : {
        text: bytes
          .subarray(bytes.length - ADMIN_LIMITS.logBytes)
          .toString("utf8")
          .replace(/^[^\n]*\n/, ""),
        truncated: true,
      };
}

// Bounded JSON for model reads: whole value when small, else a truncated
// serialization marked as such.
export function boundedJson(value: unknown, max = ADMIN_LIMITS.readBytes) {
  const serialized = JSON.stringify(value ?? null);
  return Buffer.byteLength(serialized) <= max
    ? { value, truncated: false }
    : {
        text: Buffer.from(serialized).subarray(0, max).toString("utf8"),
        truncated: true,
      };
}

// Admin mode entity attributes for models: bounded and with credential-like
// keys removed. Nested objects are dropped; arrays of primitives are joined.
const SECRET_KEY =
  /token|password|passwd|secret|key|auth|cookie|session|credential/i;
export function adminAttributes(
  attrs: Record<string, unknown>,
  maxKeys = 40,
  maxChars = 200,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (Object.keys(out).length >= maxKeys) break;
    if (key.length > 64 || SECRET_KEY.test(key)) continue;
    if (
      (key === "entity_picture" ||
        key.endsWith("_picture") ||
        key.endsWith("_url")) &&
      typeof value === "string" &&
      /token|signature|sig=|auth/i.test(value)
    )
      continue;
    if (typeof value === "string") out[key] = value.slice(0, maxChars);
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value))
      out[key] = value;
    else if (
      Array.isArray(value) &&
      value.every(
        (v) =>
          typeof v === "string" ||
          typeof v === "boolean" ||
          (typeof v === "number" && Number.isFinite(v)),
      )
    )
      out[key] = value.slice(0, 50).join(", ").slice(0, maxChars);
  }
  return out;
}

// Supervisor info for models: an explicit SAFE field allowlist per endpoint.
// Add-on options/schema, network secrets, tokens, ingress entry URLs and
// backup protection details never pass. A leaf must be a primitive (or a
// list of primitives): an allowed name cannot smuggle a nested object.
type Shape = readonly (string | readonly [string, Shape])[];
const ADDON_LIST: Shape = [
  "name",
  "slug",
  "description",
  "version",
  "version_latest",
  "update_available",
  "state",
  "repository",
];
const ADDON_INFO: Shape = [
  ...ADDON_LIST,
  "boot",
  "url",
  "ingress",
  "ingress_panel",
  "stage",
  "arch",
  "auto_update",
  "watchdog",
  "build",
  "homeassistant",
];
// A background job queued by a mutation whose `timeoutMs` entry sets
// `background: true` above; let the model check its progress instead of
// holding the original request open.
const JOB: Shape = ["name", "reference", "uuid", "progress", "stage", "done"];
const BACKUP: Shape = [
  "slug",
  "name",
  "date",
  "type",
  "size",
  "location",
  "homeassistant",
  "folders",
  ["content", ["homeassistant", "addons", "folders"]],
  ["addons", ["slug", "name", "version"]],
];
const SUPERVISOR_SHAPES: readonly [RegExp, Shape][] = [
  [/^\/addons$/, [["addons", ADDON_LIST]]],
  [/^\/addons\/[^/]+\/info$/, ADDON_INFO],
  [
    /^\/addons\/[^/]+\/stats$/,
    [
      "cpu_percent",
      "memory_usage",
      "memory_limit",
      "memory_percent",
      "network_rx",
      "network_tx",
      "blk_read",
      "blk_write",
    ],
  ],
  [/^\/backups$/, [["backups", BACKUP]]],
  [/^\/backups\/[^/]+\/info$/, BACKUP],
  [
    /^\/core\/info$/,
    [
      "version",
      "version_latest",
      "update_available",
      "machine",
      "arch",
      "boot",
      "watchdog",
      "state",
    ],
  ],
  [
    /^\/supervisor\/info$/,
    [
      "version",
      "version_latest",
      "update_available",
      "channel",
      "arch",
      "healthy",
      "supported",
      "auto_update",
      [
        "addons",
        [
          "name",
          "slug",
          "state",
          "version",
          "version_latest",
          "update_available",
        ],
      ],
    ],
  ],
  [
    /^\/os\/info$/,
    ["version", "version_latest", "update_available", "board", "boot"],
  ],
  [
    /^\/host\/info$/,
    [
      "hostname",
      "operating_system",
      "kernel",
      "chassis",
      "disk_total",
      "disk_used",
      "disk_free",
      "timezone",
      "features",
    ],
  ],
  [
    /^\/network\/info$/,
    [
      "host_internet",
      "supervisor_internet",
      [
        "interfaces",
        [
          "interface",
          "type",
          "enabled",
          "connected",
          "primary",
          ["ipv4", ["method", "address", "gateway"]],
          ["ipv6", ["method", "address", "gateway"]],
          ["wifi", ["ssid", "signal", "mode"]],
        ],
      ],
    ],
  ],
  [
    /^\/resolution\/info$/,
    [
      "unsupported",
      "unhealthy",
      ["issues", ["type", "context", "reference"]],
      ["suggestions", ["type", "context", "reference"]],
    ],
  ],
  [/^\/jobs\/info$/, ["ignore_conditions", ["jobs", JOB]]],
  [/^\/jobs\/[0-9a-fA-F-]{8,64}$/, JOB],
  [
    /^\/store$/,
    [
      ["repositories", ["slug", "name", "url", "maintainer"]],
      ["addons", [...ADDON_LIST, "installed", "available"]],
    ],
  ],
  [
    /^\/store\/addons$/,
    [["addons", [...ADDON_LIST, "installed", "available"]]],
  ],
];
const primitive = (v: unknown) =>
  v === null ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v)) ||
  typeof v === "string";
function pick(value: unknown, shape: Shape): unknown {
  if (Array.isArray(value))
    return value.slice(0, 200).map((item) => pick(item, shape));
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of shape) {
    if (typeof field === "string") {
      const v = record[field];
      if (!Object.hasOwn(record, field)) continue;
      if (primitive(v))
        out[field] = typeof v === "string" ? v.slice(0, 300) : v;
      else if (Array.isArray(v) && v.every(primitive))
        out[field] = v.slice(0, 100);
    } else if (Object.hasOwn(record, field[0]))
      out[field[0]] = pick(record[field[0]], field[1]);
  }
  return out;
}
export function projectSupervisor(endpoint: string, value: unknown): unknown {
  const shape = SUPERVISOR_SHAPES.find(([path]) => path.test(endpoint))?.[1];
  return shape ? pick(value, shape) : null;
}
