// Admin access mode: setting up new devices and integrations through Home
// Assistant config flows. Strict validation of the `flow` action kind,
// bounded and redacted projections of Home Assistant's flow replies and flow
// lists, and the controller's record of flows Hearth itself started. Nothing
// here sends anything; AdminOps (ha-admin.ts) does, only for actions the Home
// permissions broker admitted.
//
// Home Assistant endpoints (homeassistant/components/config/
// config_entries.py and homeassistant/helpers/data_entry_flow.py):
//   POST   /api/config/config_entries/flow            {handler}  start
//   POST   /api/config/config_entries/flow/<flow_id>  user_input step
//   DELETE /api/config/config_entries/flow/<flow_id>             abort
//   GET    /api/config/config_entries/flow_handlers   handler domains
//   WS     config_entries/flow/progress  flows in progress that Home
//          Assistant started itself (discovery), never user-started ones
//   WS     config_entries/get            config entries (no entry data)
// Home Assistant frontend paths (src/panels/config/integrations/
// ha-config-integrations-dashboard.ts, My link "config_flow_start"):
//   /config/integrations/dashboard                  Discovered devices
//   /config/integrations/dashboard/add?domain=<d>   start <d> in HA's dialog
//   /config/integrations/integration/<d>            one integration's page
import type {
  FlowAction,
  FlowField,
  FlowResultSummary,
  FlowScalar,
  FlowSource,
  Proposal,
} from "./documents.js";
import { insist, object, text } from "./safety.js";

export const FLOW_LIMITS = Object.freeze({
  inputKeys: 20,
  valueChars: 256,
  inputBytes: 4096,
  fields: 30,
  options: 20,
  menuOptions: 20,
  errors: 20,
  titleChars: 100,
  timeoutMs: 60000,
  responseBytes: 262144,
});
// Integration domains: lowercase, digits and underscores ("17track" too).
export const FLOW_HANDLER = /^[a-z0-9][a-z0-9_]{0,63}$/;
// Home Assistant flow ids are ULIDs; accept plain alphanumerics only.
export const FLOW_ID = /^[A-Za-z0-9]{8,64}$/;
// config_entries/flow/progress lists every flow whose source is not
// "user", which also includes flows that are not discoveries: re-entering
// credentials (reauth), changing an existing entry (reconfigure), YAML
// import and internal (system) flows. ha_integrations_read still lists them
// with their source, but Hearth never steps or cancels them (nor a flow
// whose source Home Assistant did not report): the owner continues them in
// Home Assistant's own UI.
export const NOT_DISCOVERED_SOURCES: ReadonlySet<string> = new Set([
  "reauth",
  "reconfigure",
  "import",
  "system",
  "user",
]);
export function discoveredSource(source: string | null): boolean {
  return source !== null && !NOT_DISCOVERED_SOURCES.has(source);
}
const FIELD_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
// Field names that look like they carry a secret. Such a field is never
// filled through Hearth: the owner enters it in Home Assistant's own UI.
// Over-matching (for example "country_code") only sends the owner there.
export const SECRET_FIELD =
  /pass|token|key|pin|code|secret|pair|psk|otp|credential|cert/i;
// Values that look like credentials whatever the field is called.
const CREDENTIAL_VALUE =
  /\b(Bearer|Basic)\s+\S{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9_-]{8,}|-----BEGIN/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Flat scalars only: no nested objects or lists, no secret-looking field
// names, no credential-shaped values, bounded.
export function flowInput(value: unknown): Record<string, FlowScalar> {
  insist(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    "invalid_flow_input",
  );
  const entries = Object.entries(value as Record<string, unknown>);
  insist(entries.length <= FLOW_LIMITS.inputKeys, "flow_input_too_large", 413);
  const out: Record<string, FlowScalar> = {};
  for (const [key, item] of entries) {
    insist(
      FIELD_NAME.test(key) && !FORBIDDEN_KEYS.has(key),
      "invalid_flow_input",
    );
    insist(!SECRET_FIELD.test(key), "flow_secret_field", 400);
    if (typeof item === "string") {
      insist(
        item.length <= FLOW_LIMITS.valueChars && !CONTROL.test(item),
        "invalid_flow_input",
      );
      insist(!CREDENTIAL_VALUE.test(item), "flow_secret_value", 400);
    } else
      insist(
        item === null ||
          typeof item === "boolean" ||
          (typeof item === "number" && Number.isFinite(item)),
        "invalid_flow_input",
      );
    out[key] = item as FlowScalar;
  }
  insist(
    Buffer.byteLength(JSON.stringify(out)) <= FLOW_LIMITS.inputBytes,
    "flow_input_too_large",
    413,
  );
  return out;
}

export function flowAction(v: Record<string, unknown>): FlowAction {
  insist(
    v.op === "init" || v.op === "step" || v.op === "abort",
    "invalid_flow_op",
  );
  const handler = text(v.handler, 64);
  insist(FLOW_HANDLER.test(handler), "invalid_flow_handler");
  if (v.op === "init") {
    object(v, ["kind", "op", "handler"]);
    return { kind: "flow", op: "init", handler };
  }
  const flowId = text(v.flowId, 64);
  insist(FLOW_ID.test(flowId), "invalid_flow_id");
  let source: FlowSource | undefined;
  if (v.source !== undefined) {
    insist(v.source === "discovered" || v.source === "hearth");
    source = v.source;
  }
  if (v.op === "abort") {
    object(v, ["kind", "op", "handler", "flowId", "source"]);
    return {
      kind: "flow",
      op: "abort",
      handler,
      flowId,
      ...(source ? { source } : {}),
    };
  }
  object(v, [
    "kind",
    "op",
    "handler",
    "flowId",
    "stepId",
    "source",
    "userInput",
  ]);
  let stepId: string | undefined;
  if (v.stepId !== undefined) {
    stepId = text(v.stepId, 64);
    insist(TOKEN.test(stepId), "invalid_flow_step");
  }
  return {
    kind: "flow",
    op: "step",
    handler,
    flowId,
    ...(stepId ? { stepId } : {}),
    ...(source ? { source } : {}),
    userInput: flowInput(v.userInput ?? {}),
  };
}

// Where the owner continues in Home Assistant's own UI: the Discovered list
// for a flow Home Assistant found, otherwise its own "add integration"
// dialog for the handler (Hearth's flow is then cancelled, not continued).
export function flowLink(handler: string, source: FlowSource): string {
  return source === "discovered"
    ? "/config/integrations/dashboard"
    : `/config/integrations/dashboard/add?domain=${handler}`;
}
export const FLOW_LINK =
  /^\/config\/integrations\/(dashboard|dashboard\/add\?domain=[a-z0-9][a-z0-9_]{0,63}|integration\/[a-z0-9][a-z0-9_]{0,63})$/;

const FLOW_TYPES: readonly FlowResultSummary["type"][] = [
  "form",
  "create_entry",
  "abort",
  "external",
  "external_done",
  "progress",
  "progress_done",
  "menu",
];
const token = (value: unknown) =>
  typeof value === "string" && TOKEN.test(value) ? value : undefined;
const shortText = (
  value: unknown,
  redact: (s: string) => string,
  max: number,
) =>
  typeof value === "string"
    ? redact(value)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, max)
    : undefined;
// A field's type: probatio/voluptuous "type", or "selector:<kind>".
function fieldType(field: Record<string, unknown>): string {
  const plain = token(field.type);
  if (plain) return plain;
  const selector = field.selector;
  if (selector && typeof selector === "object" && !Array.isArray(selector)) {
    const kind = token(Object.keys(selector)[0]);
    if (kind) return `selector:${kind}`;
  }
  return "unknown";
}
function passwordSelector(field: Record<string, unknown>) {
  const selector = field.selector as Record<string, unknown> | undefined;
  const textSelector = selector?.text as Record<string, unknown> | undefined;
  return (
    !!textSelector &&
    typeof textSelector === "object" &&
    textSelector.type === "password"
  );
}
function fieldOptions(
  field: Record<string, unknown>,
  redact: (s: string) => string,
): string[] | undefined {
  const selector = field.selector as Record<string, unknown> | undefined;
  const select = selector?.select as Record<string, unknown> | undefined;
  const raw = Array.isArray(field.options)
    ? field.options
    : select && Array.isArray(select.options)
      ? select.options
      : undefined;
  if (!raw) return undefined;
  const values = raw
    .map((o: unknown) =>
      Array.isArray(o)
        ? o[0]
        : o && typeof o === "object"
          ? (o as Record<string, unknown>).value
          : o,
    )
    .map((o) => shortText(o, redact, 80))
    .filter((o): o is string => !!o)
    .slice(0, FLOW_LIMITS.options);
  return values.length ? values : undefined;
}
// Home Assistant's reply to a flow action, reduced to what the next step
// needs: never field values, defaults, descriptions, placeholders or URLs
// (an external step's sign-in URL and a description's codes stay in Home
// Assistant). Untrusted text is redacted and capped.
export function flowSummary(
  raw: unknown,
  redact: (s: string) => string,
  action: FlowAction,
): FlowResultSummary {
  const r =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const source: FlowSource =
    action.op === "init" ? "hearth" : (action.source ?? "hearth");
  const type = FLOW_TYPES.includes(r.type as FlowResultSummary["type"])
    ? (r.type as FlowResultSummary["type"])
    : "unknown";
  const out: FlowResultSummary = { type };
  const flowId =
    typeof r.flow_id === "string" && FLOW_ID.test(r.flow_id)
      ? r.flow_id
      : undefined;
  const handler =
    typeof r.handler === "string" && FLOW_HANDLER.test(r.handler)
      ? r.handler
      : undefined;
  if (flowId) out.flowId = flowId;
  if (handler) out.handler = handler;
  const stepId = token(r.step_id);
  if (stepId) out.stepId = stepId;
  if (Array.isArray(r.data_schema)) {
    const fields: FlowField[] = [];
    for (const item of r.data_schema.slice(0, FLOW_LIMITS.fields)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const f = item as Record<string, unknown>;
      if (typeof f.name !== "string" || !FIELD_NAME.test(f.name)) continue;
      const secret = SECRET_FIELD.test(f.name) || passwordSelector(f);
      const options = secret ? undefined : fieldOptions(f, redact);
      fields.push({
        name: f.name,
        type: fieldType(f),
        required: f.required === true,
        ...(secret ? { secret: true as const } : {}),
        ...(options ? { options } : {}),
      });
    }
    if (fields.length) out.fields = fields;
  }
  const menu = Array.isArray(r.menu_options)
    ? r.menu_options
    : r.menu_options && typeof r.menu_options === "object"
      ? Object.keys(r.menu_options)
      : [];
  const menuOptions = menu
    .map(token)
    .filter((o): o is string => !!o)
    .slice(0, FLOW_LIMITS.menuOptions);
  if (menuOptions.length) out.menuOptions = menuOptions;
  if (r.errors && typeof r.errors === "object" && !Array.isArray(r.errors)) {
    const errors: Record<string, string> = {};
    for (const [key, value] of Object.entries(r.errors).slice(
      0,
      FLOW_LIMITS.errors,
    )) {
      const code = token(value);
      if (TOKEN.test(key) && code) errors[key] = code;
    }
    if (Object.keys(errors).length) out.errors = errors;
  }
  const reason = token(r.reason);
  if (reason) out.reason = reason;
  if (type === "create_entry") {
    const result = r.result as Record<string, unknown> | undefined;
    const entryId =
      result && typeof result === "object" ? token(result.entry_id) : undefined;
    if (entryId) out.entryId = entryId;
    const title = shortText(r.title, redact, FLOW_LIMITS.titleChars);
    if (title) out.title = title;
  }
  const domain = handler ?? action.handler;
  if (type === "create_entry")
    out.continueIn = `/config/integrations/integration/${domain}`;
  else if (type === "external" || out.fields?.some((f) => f.secret))
    out.continueIn = flowLink(domain, source);
  // The browser links only these fixed paths (render.js has the same rule).
  if (out.continueIn && !FLOW_LINK.test(out.continueIn)) delete out.continueIn;
  return out;
}

// The flows Hearth itself started or moved on in this conversation, from
// its own accepted receipts (Home Assistant's replies, never a model's
// claims): the handler, the current step, the secret fields Home Assistant
// asked for and whether the flow ended. Home Assistant does not list
// user-started flows anywhere read-only, so this is the only record for
// them. A discovered flow is adopted from Hearth's own accepted step on it
// (its handler was checked against Home Assistant's list then), so the
// password fields of its next step are known too; it is still only ever
// stepped while Home Assistant lists it.
export type KnownFlow = {
  handler: string;
  source: FlowSource;
  stepId?: string;
  secretFields: string[];
  finished: boolean;
};
export function knownFlows(
  items: Readonly<Record<string, Proposal>>,
): Map<string, KnownFlow> {
  const flows = new Map<string, KnownFlow>();
  const done = Object.values(items)
    .filter(
      (p) =>
        "kind" in p.action &&
        p.action.kind === "flow" &&
        p.status === "accepted" &&
        p.flowResult,
    )
    .sort((a, b) => (a.attemptedAt ?? 0) - (b.attemptedAt ?? 0));
  for (const p of done) {
    const action = p.action as FlowAction;
    const result = p.flowResult!;
    const flowId = action.op === "init" ? result.flowId : action.flowId;
    if (!flowId) continue;
    const previous = flows.get(flowId);
    // A flow id is only ever adopted from Home Assistant's reply to Hearth's
    // own start, or from Hearth's own accepted action on a flow the
    // controller found in Home Assistant's discovered list; a later step
    // must agree on the handler.
    if (action.op !== "init" && !previous && action.source !== "discovered")
      continue;
    const handler = previous?.handler ?? result.handler ?? action.handler;
    const source: FlowSource =
      previous?.source ??
      (action.op !== "init" && action.source === "discovered"
        ? "discovered"
        : "hearth");
    flows.set(flowId, {
      handler,
      source,
      ...(result.stepId ? { stepId: result.stepId } : {}),
      secretFields: (result.fields ?? [])
        .filter((f) => f.secret)
        .map((f) => f.name),
      finished:
        action.op === "abort" ||
        result.type === "create_entry" ||
        result.type === "abort",
    });
  }
  return flows;
}

// The dispatch re-check, inside the commit that marks a flow step or cancel
// as dispatching: no other action on the same flow is being sent, and a
// flow Hearth started is still open at the step the proposal was made for
// in Hearth's own receipts (Home Assistant lists user-started flows nowhere
// read-only; a discovered flow is re-read from Home Assistant instead). An
// earlier approved step or cancel moves the flow on, so a stale pending one
// is refused rather than sent to whatever step is current.
export function assertFlowCurrent(
  items: Readonly<Record<string, Proposal>>,
  item: Proposal,
) {
  const action = item.action;
  if (!("kind" in action) || action.kind !== "flow" || action.op === "init")
    return;
  insist(
    !Object.values(items).some(
      (p) =>
        p.id !== item.id &&
        p.status === "dispatching" &&
        "kind" in p.action &&
        p.action.kind === "flow" &&
        p.action.op !== "init" &&
        p.action.flowId === action.flowId,
    ),
    "flow_changed",
    409,
  );
  if (action.source !== "hearth") return;
  const known = knownFlows(items).get(action.flowId);
  insist(
    known &&
      known.source === "hearth" &&
      !known.finished &&
      known.handler === action.handler &&
      (action.op === "abort" || known.stepId === action.stepId),
    "flow_changed",
    409,
  );
}

// Read projections for ha_integrations_read.
export function projectFlowProgress(
  raw: unknown,
  redact: (s: string) => string,
) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const f = item as Record<string, unknown>;
    if (
      typeof f.flow_id !== "string" ||
      !FLOW_ID.test(f.flow_id) ||
      typeof f.handler !== "string" ||
      !FLOW_HANDLER.test(f.handler)
    )
      return [];
    const context =
      f.context && typeof f.context === "object"
        ? (f.context as Record<string, unknown>)
        : {};
    const placeholders =
      context.title_placeholders &&
      typeof context.title_placeholders === "object"
        ? (context.title_placeholders as Record<string, unknown>)
        : {};
    return [
      {
        flowId: f.flow_id,
        handler: f.handler,
        stepId: token(f.step_id) ?? null,
        source: token(context.source) ?? null,
        name: shortText(placeholders.name, redact, 80) ?? null,
      },
    ];
  });
}
export function projectConfigEntries(
  raw: unknown,
  redact: (s: string) => string,
) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 2000).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const e = item as Record<string, unknown>;
    const domain =
      typeof e.domain === "string" && FLOW_HANDLER.test(e.domain)
        ? e.domain
        : undefined;
    const entryId = token(e.entry_id);
    if (!domain || !entryId) return [];
    return [
      {
        entryId,
        domain,
        title: shortText(e.title, redact, FLOW_LIMITS.titleChars) ?? null,
        state: token(e.state) ?? null,
        source: token(e.source) ?? null,
        disabledBy: token(e.disabled_by) ?? null,
      },
    ];
  });
}
