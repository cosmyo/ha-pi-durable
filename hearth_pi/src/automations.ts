// Read-only automation troubleshooting for Home conversations. Reads only
// automation entities inside the configured exact read scope: their config
// (REST GET), recent traces (allowlisted WebSocket trace/list + trace/get),
// logbook and history. Entities the config references outside the read scope
// are named, never read. Every returned string is untrusted and scrubbed. There
// is no write path here: the reader only receives a GET function and a
// trace-only WebSocket session.
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { Policy } from "./config.js";
import type { HAWebSocketCall } from "./ha-websocket.js";
import { entityPattern, Fault, insist } from "./safety.js";

export const automationPattern = /^automation\.[a-z0-9_]+$/;
export const runIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
export const AUTOMATION_LIMITS = Object.freeze({
  traces: 5,
  listScan: 200,
  conditions: 12,
  actions: 15,
  steps: 80,
  hours: 24,
  logbookEntities: 10,
  logbookEntries: 60,
  historyEntities: 3,
  historyPoints: 20,
  references: 50,
  configChars: 16000,
  stringChars: 2000,
});
export const OUTSIDE_SCOPE = "outside Hearth's read scope";
const WITHHELD = `withheld: this automation references entities ${OUTSIDE_SCOPE}`;

export type AutomationSources = {
  policy: Policy;
  // GET only; resolves undefined for HTTP 404.
  get(path: string, signal?: AbortSignal): Promise<unknown>;
  traces<T>(
    work: (call: HAWebSocketCall) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  history(
    ids: readonly string[],
    hours: number,
    signal?: AbortSignal,
  ): Promise<{
    start: number;
    end: number;
    series: Record<string, { at: number; state: string }[]>;
  }>;
  redact(value: string): string;
};

// ---- Redaction --------------------------------------------------------------

const secretRef = /^!secret\s+[A-Za-z0-9_.-]{1,100}$/;
const sensitiveKey =
  /pass(word|wd)?|token|secret|api_?key|auth|credential|private_?key|bearer|webhook_id|cookie|^(code|pin)$/i;
// Credential-shaped text the configured-secret redactor cannot know about.
export function scrubText(
  value: string,
  redact: (value: string) => string,
): string {
  if (secretRef.test(value)) return value;
  return redact(value)
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+(?::[^\s/@'"]*)?@/gi,
      "$1[REDACTED]@",
    )
    .replace(
      /([?&;](?:access_token|token|api_?key|key|password|pass|secret|auth|sig|signature|apikey)=)[^&\s"'#]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
      "[REDACTED]",
    )
    .replace(/\bbot\d{5,}:[A-Za-z0-9_-]{20,}/g, "bot[REDACTED]")
    .replace(/(\/api\/webhook\/)[A-Za-z0-9_-]+/gi, "$1[REDACTED]");
}
// Bounded deep copy of untrusted JSON with secrets removed. Values under
// credential-like keys are replaced unless they are a literal `!secret` ref.
export function scrubValue(
  value: unknown,
  redact: (value: string) => string,
  depth = 0,
  key = "",
): unknown {
  if (sensitiveKey.test(key) && value !== null && value !== undefined)
    return typeof value === "string" && secretRef.test(value)
      ? value
      : "[REDACTED]";
  if (typeof value === "string")
    return scrubText(value, redact).slice(0, AUTOMATION_LIMITS.stringChars);
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean" || value === null) return value;
  if (depth >= 16) return "[nested too deeply]";
  if (Array.isArray(value))
    return value
      .slice(0, 200)
      .map((item) => scrubValue(item, redact, depth + 1, key));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 200))
      out[scrubText(k, redact).slice(0, 100)] = scrubValue(
        v,
        redact,
        depth + 1,
        k,
      );
    return out;
  }
  return null;
}

// ---- Entity references ------------------------------------------------------

const entityKeys = new Set(["entity_id", "entity", "zone"]);
const templateRefs = [
  /\b(?:states|is_state|state_attr|is_state_attr|has_value|state_translated)\(\s*['"]([a-z_]+\.[a-z0-9_]+)['"]/g,
  /\bstates\.([a-z_]+\.[a-z0-9_]+)/g,
];
// Templates that can read entities Hearth cannot attribute by name.
const opaqueTemplate =
  /\bexpand\(|\bstates\s*\||\bstates\s*\[|_entities\(|\bstates\s*\)|\bstates\s*\}\}/;
export type AutomationReferences = {
  readable: string[];
  outsideReadScope: string[];
  deviceReferences: number;
  opaqueTemplates: boolean;
};
export function automationReferences(
  config: unknown,
  scope: readonly string[],
): AutomationReferences {
  const found = new Set<string>();
  let devices = 0,
    opaque = false;
  const walk = (value: unknown, key: string, depth: number) => {
    if (depth > 16) return;
    if (typeof value === "string") {
      if (key === "device_id") devices++;
      if (entityKeys.has(key))
        for (const part of value.split(","))
          if (entityPattern.test(part.trim())) found.add(part.trim());
      if (value.includes("{{") || value.includes("{%")) {
        if (opaqueTemplate.test(value)) opaque = true;
        for (const pattern of templateRefs)
          for (const match of value.matchAll(pattern))
            if (entityPattern.test(match[1]!)) found.add(match[1]!);
      }
    } else if (Array.isArray(value))
      for (const item of value.slice(0, 200)) walk(item, key, depth + 1);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value).slice(0, 200))
        walk(v, k, depth + 1);
  };
  walk(config, "", 0);
  const allowed = new Set(scope);
  const all = [...found].sort();
  return {
    readable: all
      .filter((id) => allowed.has(id))
      .slice(0, AUTOMATION_LIMITS.references),
    outsideReadScope: all
      .filter((id) => !allowed.has(id))
      .slice(0, AUTOMATION_LIMITS.references),
    deviceReferences: devices,
    opaqueTemplates: opaque,
  };
}
const fullyReadable = (refs: AutomationReferences) =>
  !refs.outsideReadScope.length &&
  !refs.deviceReferences &&
  !refs.opaqueTemplates;

// ---- Trace summaries --------------------------------------------------------

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const iso = (value: unknown): string | undefined => {
  const ms =
    typeof value === "number" && Number.isFinite(value)
      ? value < 1e12
        ? value * 1000
        : value
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};
type Step = {
  path: string;
  at?: string;
  result: Record<string, unknown>;
  error?: unknown;
  variables: Record<string, unknown>;
};
function traceSteps(trace: Record<string, unknown>): Step[] {
  const steps: Step[] = [];
  for (const [path, list] of Object.entries(record(trace.trace)).slice(
    0,
    500,
  )) {
    if (!Array.isArray(list)) continue;
    for (const raw of list.slice(0, 20)) {
      const item = record(raw);
      steps.push({
        path: String(item.path ?? path).slice(0, 120),
        at: iso(item.timestamp),
        result: record(item.result),
        error: item.error,
        variables: record(item.changed_variables),
      });
    }
  }
  return steps.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

class Summarizer {
  constructor(
    private readonly scope: ReadonlySet<string>,
    private readonly redact: (value: string) => string,
    private readonly showStates: boolean,
  ) {}
  text(value: unknown, max = 300): string | undefined {
    if (value === undefined || value === null) return undefined;
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return scrubText(s ?? "", this.redact).slice(0, max);
  }
  scalar(value: unknown) {
    return typeof value === "number" || typeof value === "boolean"
      ? value
      : this.text(value, 200);
  }
  trigger(variables: Record<string, unknown>) {
    const t = record(variables.trigger);
    if (!Object.keys(t).length) return undefined;
    const entity = typeof t.entity_id === "string" ? t.entity_id : undefined;
    const readable = entity !== undefined && this.scope.has(entity);
    const out: Record<string, unknown> = {
      platform: this.text(t.platform ?? t.trigger, 40),
      id: this.text(t.id, 80),
      alias: this.text(t.alias, 120),
      description: this.text(t.description, 200),
      entityId: entity && entityPattern.test(entity) ? entity : undefined,
    };
    if (entity && readable) {
      out.from = this.text(record(t.from_state).state, 120);
      out.to = this.text(record(t.to_state).state, 120);
    } else if (entity) out.states = `${entity} is ${OUTSIDE_SCOPE}; not read`;
    if (t.for !== undefined && t.for !== null) out.for = this.text(t.for, 60);
    if (t.above !== undefined) out.above = this.scalar(t.above);
    if (t.below !== undefined) out.below = this.scalar(t.below);
    return out;
  }
  step(step: Step) {
    const r = step.result;
    const out: Record<string, unknown> = { path: step.path, at: step.at };
    if (typeof r.result === "boolean") out.passed = r.result;
    for (const [from, to] of [
      ["wanted_state", "wanted"],
      ["wanted_state_above", "wantedAbove"],
      ["wanted_state_below", "wantedBelow"],
    ] as const)
      if (r[from] !== undefined) out[to] = this.scalar(r[from]);
    if (r.state !== undefined)
      out.observed = this.showStates ? this.scalar(r.state) : WITHHELD;
    if (r.choice !== undefined) out.choice = this.scalar(r.choice);
    if (typeof r.if === "boolean") out.if = r.if;
    if (r.delay !== undefined) out.delay = this.scalar(r.delay);
    if (typeof r.done === "boolean") out.done = r.done;
    if (r.enabled === false) out.disabled = true;
    const wait = record(r.wait);
    if (Object.keys(wait).length)
      out.wait = {
        completed: typeof wait.completed === "boolean" ? wait.completed : null,
        remaining: this.scalar(wait.remaining),
      };
    const params = record(r.params);
    if (typeof params.domain === "string" && typeof params.service === "string")
      out.service = this.text(`${params.domain}.${params.service}`, 80);
    const target = record(params.target).entity_id;
    const targets = (Array.isArray(target) ? target : [target]).filter(
      (id): id is string => typeof id === "string" && entityPattern.test(id),
    );
    if (targets.length) out.targets = targets.slice(0, 20);
    const data = record(params.service_data);
    if (Object.keys(data).length)
      out.data = this.showStates
        ? scrubValue(data, this.redact, 12)
        : { keys: Object.keys(data).slice(0, 20), values: WITHHELD };
    if (step.error !== undefined && step.error !== null)
      out.error = this.text(step.error);
    return out;
  }
  run(trace: Record<string, unknown>, detail: boolean) {
    const steps = traceSteps(trace);
    const stamp = record(trace.timestamp);
    const triggerStep = steps.find((s) => s.path.startsWith("trigger"));
    const base: Record<string, unknown> = {
      runId: this.text(trace.run_id, 64),
      start: iso(stamp.start),
      finish: iso(stamp.finish),
      state: this.text(trace.state, 40),
      execution: this.text(trace.script_execution, 40),
      trigger: this.text(trace.trigger, 200),
      triggeredBy: triggerStep ? this.trigger(triggerStep.variables) : null,
      lastStep: this.text(trace.last_step, 120),
      error: this.text(trace.error),
    };
    const isCondition = (s: Step) => s.path.startsWith("condition");
    const isAction = (s: Step) =>
      s.path.startsWith("action") || s.path.startsWith("sequence");
    if (detail) {
      base.steps = steps
        .slice(0, AUTOMATION_LIMITS.steps)
        .map((s) => this.step(s));
      base.stepsOmitted = Math.max(0, steps.length - AUTOMATION_LIMITS.steps);
      return base;
    }
    const conditions = steps.filter(isCondition);
    const actions = steps.filter(isAction);
    base.conditions = conditions
      .slice(0, AUTOMATION_LIMITS.conditions)
      .map((s) => this.step(s));
    base.actions = actions
      .slice(0, AUTOMATION_LIMITS.actions)
      .map((s) => this.step(s));
    base.stepsOmitted =
      Math.max(0, conditions.length - AUTOMATION_LIMITS.conditions) +
      Math.max(0, actions.length - AUTOMATION_LIMITS.actions);
    return base;
  }
}

// ---- Reader -----------------------------------------------------------------

type AutomationEntity = {
  entityId: string;
  name?: string;
  state: string;
  lastTriggered?: string;
  mode?: string;
  automationId: string | null;
};
const NO_ID =
  "This automation has no `id`, so Home Assistant offers neither its config editor entry nor traces. Adding an `id:` (any unique text) to its YAML makes it inspectable.";

export class AutomationReader {
  constructor(private readonly src: AutomationSources) {}
  private scope() {
    return new Set(this.src.policy.entities);
  }
  private async entity(
    entityId: string,
    signal?: AbortSignal,
  ): Promise<AutomationEntity> {
    insist(
      automationPattern.test(entityId) &&
        this.src.policy.entities.includes(entityId),
      "entity_not_allowed",
      403,
    );
    const raw = record(
      await this.src.get(`states/${encodeURIComponent(entityId)}`, signal),
    );
    insist(
      raw.entity_id === entityId && typeof raw.state === "string",
      "ha_read_failed",
      502,
    );
    const attrs = record(raw.attributes);
    const id =
      typeof attrs.id === "string" || typeof attrs.id === "number"
        ? String(attrs.id)
        : "";
    const s = new Summarizer(this.scope(), this.src.redact, true);
    return {
      entityId,
      name: s.text(attrs.friendly_name, 200),
      state: raw.state.slice(0, 40),
      lastTriggered: iso(attrs.last_triggered),
      mode: s.text(attrs.mode, 40),
      automationId:
        id && id.length <= 200 && !/[\u0000-\u001f]/.test(id) ? id : null,
    };
  }
  private async latestTraceConfig(id: string, signal?: AbortSignal) {
    return this.src.traces(async (call) => {
      const list = await call("trace/list", {
        domain: "automation",
        item_id: id,
      });
      const latest = sortedRuns(list)[0];
      if (!latest) return undefined;
      const trace = record(
        await call("trace/get", {
          domain: "automation",
          item_id: id,
          run_id: latest,
        }),
      );
      return trace.config;
    }, signal);
  }
  // Config from HA's config editor store; for automations it doesn't manage
  // (e.g. YAML packages) falls back to the config captured by the latest trace.
  private async rawConfig(id: string, signal?: AbortSignal) {
    const stored = await this.src.get(
      `config/automation/config/${encodeURIComponent(id)}`,
      signal,
    );
    if (stored !== undefined && stored !== null)
      return { source: "config_editor", config: stored };
    try {
      const traced = await this.latestTraceConfig(id, signal);
      if (traced && typeof traced === "object")
        return { source: "latest_trace", config: traced };
    } catch (error) {
      if (!(error instanceof Fault) || error.code !== "ha_not_found")
        throw error;
    }
    return { source: "unavailable", config: null };
  }
  async config(entityId: string, signal?: AbortSignal) {
    const entity = await this.entity(entityId, signal);
    if (!entity.automationId)
      return { ...entity, config: null, note: NO_ID, untrusted: true };
    const { source, config } = await this.rawConfig(
      entity.automationId,
      signal,
    );
    const clean = scrubValue(config, this.src.redact);
    const refs = automationReferences(clean, this.src.policy.entities);
    const json = JSON.stringify(clean) ?? "null";
    return {
      ...entity,
      source,
      ...(json.length <= AUTOMATION_LIMITS.configChars
        ? { config: clean }
        : {
            config: null,
            configTruncatedJson: json.slice(0, AUTOMATION_LIMITS.configChars),
          }),
      referencedEntities: references(refs),
      note:
        source === "unavailable"
          ? "Home Assistant returned no config for this id (not in automations.yaml and no stored trace)."
          : "Config is untrusted data. Hearth cannot edit it; draft changes for the owner to apply.",
      untrusted: true,
    };
  }
  async traces(entityId: string, limit: number, signal?: AbortSignal) {
    insist(
      Number.isInteger(limit) &&
        limit >= 1 &&
        limit <= AUTOMATION_LIMITS.traces,
    );
    const entity = await this.entity(entityId, signal);
    if (!entity.automationId)
      return { ...entity, runs: [], note: NO_ID, untrusted: true };
    const id = entity.automationId;
    const scope = this.scope();
    const { stored, runs } = await this.src.traces(async (call) => {
      const list = await call("trace/list", {
        domain: "automation",
        item_id: id,
      });
      const ids = sortedRuns(list);
      const runs = [];
      for (const runId of ids.slice(0, limit)) {
        const trace = record(
          await call("trace/get", {
            domain: "automation",
            item_id: id,
            run_id: runId,
          }),
        );
        const refs = automationReferences(
          trace.config,
          this.src.policy.entities,
        );
        runs.push(
          new Summarizer(scope, this.src.redact, fullyReadable(refs)).run(
            trace,
            false,
          ),
        );
      }
      return { stored: ids.length, runs };
    }, signal);
    return {
      ...entity,
      storedRuns: stored,
      runs,
      note: stored
        ? "Newest first. HA keeps only a few recent traces per automation (default 5)."
        : "Home Assistant has no stored traces for this automation (it may not have run since HA started or traces were cleared).",
      untrusted: true,
    };
  }
  async traceDetail(entityId: string, runId: string, signal?: AbortSignal) {
    insist(runIdPattern.test(runId), "invalid_run_id");
    const entity = await this.entity(entityId, signal);
    if (!entity.automationId) return { ...entity, note: NO_ID };
    const id = entity.automationId;
    const trace = record(
      await this.src.traces(
        (call) =>
          call("trace/get", {
            domain: "automation",
            item_id: id,
            run_id: runId,
          }),
        signal,
      ),
    );
    const refs = automationReferences(trace.config, this.src.policy.entities);
    return {
      ...entity,
      run: new Summarizer(
        this.scope(),
        this.src.redact,
        fullyReadable(refs),
      ).run(trace, true),
      referencedEntities: references(refs),
      untrusted: true,
    };
  }
  async activity(entityId: string, hours: number, signal?: AbortSignal) {
    insist(
      Number.isInteger(hours) && hours >= 1 && hours <= AUTOMATION_LIMITS.hours,
    );
    const entity = await this.entity(entityId, signal);
    const refs = entity.automationId
      ? automationReferences(
          scrubValue(
            (await this.rawConfig(entity.automationId, signal)).config,
            this.src.redact,
          ),
          this.src.policy.entities,
        )
      : automationReferences(null, []);
    const others = refs.readable.filter((id) => id !== entityId);
    const logIds = [entityId, ...others].slice(
      0,
      AUTOMATION_LIMITS.logbookEntities,
    );
    const end = Date.now(),
      start = end - hours * 3600000;
    const raw = await this.src.get(
      `logbook/${encodeURIComponent(new Date(start).toISOString())}?entity=${logIds.map(encodeURIComponent).join(",")}&end_time=${encodeURIComponent(new Date(end).toISOString())}`,
      signal,
    );
    insist(raw === undefined || Array.isArray(raw), "ha_read_failed", 502);
    const wanted = new Set(logIds);
    const s = new Summarizer(this.scope(), this.src.redact, true);
    const logbook = ((raw as unknown[] | undefined) ?? [])
      .map(record)
      .filter((e) => typeof e.entity_id === "string" && wanted.has(e.entity_id))
      .slice(-AUTOMATION_LIMITS.logbookEntries)
      .map((e) => {
        const context =
          typeof e.context_entity_id === "string" &&
          wanted.has(e.context_entity_id)
            ? e.context_entity_id
            : undefined;
        return {
          at: iso(e.when),
          entityId: e.entity_id,
          name: s.text(e.name, 120),
          state: s.text(e.state, 120),
          message: s.text(e.message, 200),
          source: s.text(e.source, 200),
          contextEntityId: context,
          contextEvent: s.text(e.context_event_type, 60),
          contextService:
            typeof e.context_domain === "string" &&
            typeof e.context_service === "string"
              ? s.text(`${e.context_domain}.${e.context_service}`, 80)
              : undefined,
        };
      });
    const historyIds = others
      .filter((id) => !id.startsWith("automation."))
      .slice(0, AUTOMATION_LIMITS.historyEntities);
    const history: Record<string, { at: string; state: string }[]> = {};
    if (historyIds.length) {
      const read = await this.src.history(historyIds, hours, signal);
      for (const [id, points] of Object.entries(read.series))
        history[id] = points
          .slice(-AUTOMATION_LIMITS.historyPoints)
          .map((p) => ({
            at: new Date(p.at).toISOString(),
            state: s.text(p.state, 120) ?? "",
          }));
    }
    return {
      ...entity,
      window: {
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
      },
      logbook,
      history,
      notRead: {
        outsideReadScope: refs.outsideReadScope,
        beyondLimits: others.filter(
          (id) => !logIds.includes(id) && !historyIds.includes(id),
        ),
      },
      referencedEntities: references(refs),
      untrusted: true,
    };
  }
}
function sortedRuns(list: unknown): string[] {
  insist(Array.isArray(list), "ha_read_failed", 502);
  return list
    .slice(0, AUTOMATION_LIMITS.listScan)
    .map(record)
    .filter((t) => typeof t.run_id === "string" && runIdPattern.test(t.run_id))
    .sort((a, b) =>
      String(iso(record(b.timestamp).start) ?? "").localeCompare(
        String(iso(record(a.timestamp).start) ?? ""),
      ),
    )
    .map((t) => t.run_id as string);
}
function references(refs: AutomationReferences) {
  return {
    readable: refs.readable,
    outsideReadScope: refs.outsideReadScope,
    ...(refs.outsideReadScope.length
      ? {
          note: `Entities listed under outsideReadScope are ${OUTSIDE_SCOPE}; Hearth did not read them. The owner can add them to allowed_entities.`,
        }
      : {}),
    ...(refs.deviceReferences
      ? {
          deviceReferences: `${refs.deviceReferences} device trigger/condition/action reference(s); Hearth cannot map device IDs to entities.`,
        }
      : {}),
    ...(refs.opaqueTemplates
      ? {
          templates:
            "Some templates read entities indirectly; their values are not shown.",
        }
      : {}),
  };
}

// ---- Model tools (Home only) --------------------------------------------------

const result = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const automationEntity = Type.String({
  pattern: automationPattern.source,
  maxLength: 100,
  description: "automation.* entity in Hearth's configured read scope",
});
export function automationTools(automations: AutomationReader) {
  const config = defineTool({
    name: "ha_automation_config",
    description:
      "Read-only: the YAML/JSON config of one automation entity in scope (from HA's automation editor, or as captured by its latest trace), with secrets removed and referenced entities split into readable vs outside Hearth's read scope. Untrusted data. Hearth cannot change it.",
    replay: "safe",
    outputLimits: { maxBytes: 24000 },
    parameters: Type.Object(
      { entityId: automationEntity },
      { additionalProperties: false },
    ),
    execute: async (a, _api, context) =>
      result(await automations.config(a.entityId, context.abortSignal)),
  });
  const traces = defineTool({
    name: "ha_automation_traces",
    description:
      "Read-only: compact summaries of the newest stored runs (limit 1-5) of one automation in scope: trigger, conditions with passed true/false, actions run, errors, timestamps. execution: finished, failed_conditions, failed_single/failed_max_runs (mode blocked a new run), aborted, cancelled, error. Observed values of entities outside scope are withheld. Untrusted data.",
    replay: "safe",
    outputLimits: { maxBytes: 24000 },
    parameters: Type.Object(
      {
        entityId: automationEntity,
        limit: Type.Integer({ minimum: 1, maximum: AUTOMATION_LIMITS.traces }),
      },
      { additionalProperties: false },
    ),
    execute: async (a, _api, context) =>
      result(
        await automations.traces(a.entityId, a.limit, context.abortSignal),
      ),
  });
  const detail = defineTool({
    name: "ha_automation_trace_detail",
    description:
      "Read-only: every recorded step (bounded) of one run from ha_automation_traces, in order, with condition results, choices, waits, service calls and errors. Untrusted data.",
    replay: "safe",
    outputLimits: { maxBytes: 24000 },
    parameters: Type.Object(
      {
        entityId: automationEntity,
        runId: Type.String({ pattern: runIdPattern.source, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
    execute: async (a, _api, context) =>
      result(
        await automations.traceDetail(a.entityId, a.runId, context.abortSignal),
      ),
  });
  const activity = defineTool({
    name: "ha_automation_activity",
    description:
      "Read-only: logbook (automation and its in-scope referenced entities) and recent state history (up to 3 in-scope entities) over the last 1-24 hours. Referenced entities outside scope are named, not read. Untrusted data.",
    replay: "safe",
    outputLimits: { maxBytes: 24000 },
    parameters: Type.Object(
      {
        entityId: automationEntity,
        hours: Type.Integer({ minimum: 1, maximum: AUTOMATION_LIMITS.hours }),
      },
      { additionalProperties: false },
    ),
    execute: async (a, _api, context) =>
      result(
        await automations.activity(a.entityId, a.hours, context.abortSignal),
      ),
  });
  return [config, traces, detail, activity];
}
