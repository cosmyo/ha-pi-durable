// Hearth App Spec v1 ("has/1"): a flat element map with id references, a fixed
// component catalog and controller-bound values. One definition (COMPONENTS)
// drives validation, catalog_describe and the tool description, so the model's
// instructions cannot drift from what the validator accepts.
import { entityPattern } from "./safety.js";

export const SPEC_VERSION = "has/1";
export const LIMITS = {
  elements: 80,
  depth: 6,
  tabs: 8,
  children: 24,
  scopeEntities: 24,
  specBytes: 32768,
  title: 60,
  summary: 200,
  text: 600,
  label: 60,
  items: 30,
  itemText: 80,
  okStates: 8,
  charts: 2,
  chartEntities: 3,
  hours: 48,
  note: 4000,
  patchOps: 40,
  errors: 25,
} as const;
export const idPattern = /^[a-z][a-z0-9_]{0,39}$/;

type Prop =
  | { type: "text"; max: number; required?: true; multiline?: true }
  | { type: "entity"; required?: true; domains?: readonly string[] }
  | { type: "entities"; min: number; max: number; required?: true }
  | { type: "integer"; min: number; max: number; required?: true }
  | { type: "enum"; values: readonly string[]; required?: true }
  | { type: "stateKey"; required?: true }
  | {
      type: "textList";
      min: number;
      max: number;
      itemMax: number;
      required?: true;
    };
type Component = {
  description: string;
  // display: read-only; local: writes app-local state; draft: drafts an
  // editable chat message; home: a Home action routed through Home permissions.
  safety: "display" | "local" | "draft" | "home";
  children: { min: number; max: number } | null;
  props: Record<string, Prop & { doc: string }>;
};
const label = { type: "text", max: LIMITS.label, doc: "short label" } as const;
const entity = {
  type: "entity",
  required: true,
  doc: "exact entity ID from scope.entities; the controller reads its value",
} as const;
export const COMPONENTS: Record<string, Component> = {
  Stack: {
    description: "Vertical list of children.",
    safety: "display",
    children: { min: 1, max: LIMITS.children },
    props: {},
  },
  Grid: {
    description: "Grid of children; 1-3 columns (phones show 2 at most).",
    safety: "display",
    children: { min: 1, max: LIMITS.children },
    props: {
      columns: {
        type: "integer",
        min: 1,
        max: 3,
        required: true,
        doc: "1, 2 or 3",
      },
    },
  },
  Tabs: {
    description: "Tabbed panels; labels[i] names children[i].",
    safety: "display",
    children: { min: 1, max: LIMITS.tabs },
    props: {
      labels: {
        type: "textList",
        min: 1,
        max: LIMITS.tabs,
        itemMax: 24,
        required: true,
        doc: "one label per child, same order",
      },
    },
  },
  Card: {
    description: "Bordered group with an optional title.",
    safety: "display",
    children: { min: 0, max: LIMITS.children },
    props: { title: { ...label, doc: "optional heading" } },
  },
  Section: {
    description: "Unbordered group with an optional title.",
    safety: "display",
    children: { min: 0, max: LIMITS.children },
    props: { title: { ...label, doc: "optional heading" } },
  },
  Text: {
    description: "Plain text written by you (no HTML, links or markdown).",
    safety: "display",
    children: null,
    props: {
      text: {
        type: "text",
        max: LIMITS.text,
        required: true,
        multiline: true,
        doc: "plain text",
      },
      variant: {
        type: "enum",
        values: ["h1", "h2", "body", "caption"],
        doc: "default body",
      },
    },
  },
  EntityValue: {
    description: "One controller-read value with its unit and as-of time.",
    safety: "display",
    children: null,
    props: {
      entity,
      label,
      attribute: {
        type: "enum",
        values: ["brightness"],
        doc: "show this attribute instead of the state",
      },
    },
  },
  EntityTile: {
    description: "Compact tile: name, controller-read state, entity ID.",
    safety: "display",
    children: null,
    props: { entity, label },
  },
  StatusPill: {
    description:
      "Pill that is OK when the controller-read state is one of okStates, otherwise attention.",
    safety: "display",
    children: null,
    props: {
      entity,
      label,
      okStates: {
        type: "textList",
        min: 1,
        max: LIMITS.okStates,
        itemMax: 40,
        required: true,
        doc: 'HA states that count as OK, e.g. ["off","closed","locked"]',
      },
    },
  },
  HistoryChart: {
    description:
      "Controller-read, downsampled history line (numeric) or recent changes (text states). At most 2 per app.",
    safety: "display",
    children: null,
    props: {
      entities: {
        type: "entities",
        min: 1,
        max: LIMITS.chartEntities,
        required: true,
        doc: "1-3 entity IDs from scope.entities",
      },
      hours: {
        type: "integer",
        min: 1,
        max: LIMITS.hours,
        required: true,
        doc: "1-48",
      },
      label,
    },
  },
  Checklist: {
    description:
      "Tickable list. Ticks are stored per app by Hearth, separately from the spec.",
    safety: "local",
    children: null,
    props: {
      stateKey: {
        type: "stateKey",
        required: true,
        doc: "unique storage key in this app",
      },
      title: label,
      items: {
        type: "textList",
        min: 1,
        max: LIMITS.items,
        itemMax: LIMITS.itemText,
        required: true,
        doc: "item texts (unique)",
      },
    },
  },
  Counter: {
    description: "Number the household adjusts with − / + buttons.",
    safety: "local",
    children: null,
    props: {
      stateKey: { type: "stateKey", required: true, doc: "unique storage key" },
      label: { ...label, required: true },
      step: { type: "integer", min: 1, max: 100, doc: "default 1" },
      min: { type: "integer", min: -100000, max: 100000, doc: "default 0" },
      max: {
        type: "integer",
        min: -100000,
        max: 100000,
        doc: "default 1000",
      },
    },
  },
  Note: {
    description: "Free-text note the household edits and saves.",
    safety: "local",
    children: null,
    props: {
      stateKey: { type: "stateKey", required: true, doc: "unique storage key" },
      label,
      maxLength: {
        type: "integer",
        min: 1,
        max: LIMITS.note,
        doc: "default 1000",
      },
    },
  },
  AskButton: {
    description:
      "Drafts an editable message into the chat composer. It never sends; the person presses Send.",
    safety: "draft",
    children: null,
    props: {
      label: { ...label, required: true },
      prompt: {
        type: "text",
        max: LIMITS.text,
        required: true,
        multiline: true,
        doc: "draft message text",
      },
    },
  },
  ToggleAction: {
    description:
      "Turns one light/switch on or off when a person taps it, through Home permissions (Read-only disabled, Ask exact approval, Full only within configured scope). Requires both <domain>.turn_on and <domain>.turn_off in the configured services.",
    safety: "home",
    children: null,
    props: {
      entity: {
        ...entity,
        domains: ["light", "switch"],
        doc: "light.* or switch.* entity from scope.entities",
      },
      label,
    },
  },
};
// Keys that would smuggle a model-written value into an entity-bound component.
const LITERAL_KEYS = [
  "value",
  "state",
  "reading",
  "unit",
  "attributes",
  "friendlyName",
  "friendly_name",
  "lastChanged",
  "observedAt",
  "data",
  "points",
  "series",
];
const UNSAFE_TEXT = [
  { pattern: /<[a-z!/?]/i, what: "HTML/markup" },
  {
    pattern: /\b(?:javascript|vbscript|data|file)\s*:/i,
    what: "a script/data URL",
  },
  { pattern: /\bon[a-z]{3,}\s*=/i, what: "an event-handler attribute" },
  {
    pattern: /\{\{|\$\{|\$state|\$cond|\$template/,
    what: "a template/expression",
  },
];

export type SpecElement = {
  type: string;
  props: Record<string, string | number | string[]>;
  children: string[];
};
export type AppSpec = {
  specVersion: typeof SPEC_VERSION;
  title: string;
  summary: string;
  icon: string;
  scope: { entities: string[] };
  root: string;
  elements: Record<string, SpecElement>;
  // Deterministic, controller-evaluated watchers; absent when there are none.
  watchers?: WatcherSpec[];
};
// Watchers only ever create Today cards. They have no action field and no
// way to name a service: the schema below is the whole vocabulary.
export const WATCHER_LIMITS = {
  perApp: 6,
  perOwner: 20,
  stateText: 60,
  cardTitle: 60,
  cardBody: 200,
  minutes: 1440,
  repeatMinutes: 5,
  repeats: 5,
  threshold: 1e9,
} as const;
// Index matches Date.getDay().
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const timePattern = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
export type WatcherWhen =
  | { kind: "transition"; entity: string; from?: string; to?: string }
  | { kind: "threshold"; entity: string; above?: number; below?: number }
  | { kind: "duration"; entity: string; state: string; minutes: number }
  | { kind: "schedule"; at: string; days?: string[] };
export type WatcherSpec = {
  id: string;
  when: WatcherWhen;
  card: { title: string; body: string };
  repeatAfterMinutes?: number;
  maxRepeats?: number;
};
export type SpecError = {
  path: string;
  code: string;
  message: string;
  hint?: string;
};
export type ValidationContext = {
  // Hearth's configured exact read scope.
  readable: readonly string[];
  // Hearth's configured exact service scope.
  services: readonly string[];
  // Admin access mode: entity domains a ToggleAction may control, each sent
  // as a risk-classified service action through Home permissions.
  adminControls?: readonly string[];
  // Removes configured secrets from stored text.
  redact?: (value: string) => string;
};
export type Validation =
  | { ok: true; spec: AppSpec; warnings: string[] }
  | { ok: false; errors: SpecError[]; warnings: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pointer = (...parts: (string | number)[]) =>
  parts
    .map((p) => `/${String(p).replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("");

type Fail = (
  path: string,
  code: string,
  message: string,
  hint?: string,
) => void;
type PlainCheck = (
  value: unknown,
  path: string,
  max: number,
  options?: { min?: number; multiline?: boolean },
) => string | undefined;
// Plain-text check shared by elements, watcher cards and owner watchers.
function plainChecker(
  fail: Fail,
  redact: (value: string) => string,
): PlainCheck {
  return (value, path, max, options = {}) => {
    if (typeof value !== "string") {
      fail(path, "expected_text", "Expected a string.");
      return undefined;
    }
    if (value.length < (options.min ?? 0) || value.length > max) {
      fail(
        path,
        "text_length",
        `Text must be ${options.min ?? 0}-${max} characters; got ${value.length}.`,
        "Shorten it.",
      );
      return undefined;
    }
    // Controls other than newlines (multiline) are never needed in plain text.
    // eslint-disable-next-line no-control-regex
    const controls = options.multiline
      ? /[\u0000-\u0009\u000b-\u001f\u007f]/
      : /[\u0000-\u001f\u007f]/;
    if (controls.test(value)) {
      fail(path, "control_characters", "Text contains control characters.");
      return undefined;
    }
    for (const rule of UNSAFE_TEXT)
      if (rule.pattern.test(value)) {
        fail(
          path,
          "unsafe_text",
          `Text looks like ${rule.what}; HAS/1 text is plain and never executed.`,
          "Use plain words only; values come from entity bindings.",
        );
        return undefined;
      }
    return redact(value);
  };
}

const WHEN_KEYS: Record<WatcherWhen["kind"], string[]> = {
  transition: ["kind", "entity", "from", "to"],
  threshold: ["kind", "entity", "above", "below"],
  duration: ["kind", "entity", "state", "minutes"],
  schedule: ["kind", "at", "days"],
};
// Validates one watcher. watchable(id) returns "" when the entity may be
// watched, otherwise the reason it may not.
function checkWatcher(
  raw: unknown,
  base: string,
  report: Fail,
  redact: (value: string) => string,
  watchable: (entityId: string) => string,
): WatcherSpec | undefined {
  let failures = 0;
  const fail: Fail = (...args) => {
    failures++;
    report(...args);
  };
  const plain = plainChecker(fail, redact);
  if (!isRecord(raw)) {
    fail(
      base,
      "watcher_not_object",
      "Each watcher is {id, when, card, repeatAfterMinutes?, maxRepeats?}.",
    );
    return undefined;
  }
  for (const key of Object.keys(raw))
    if (
      !["id", "when", "card", "repeatAfterMinutes", "maxRepeats"].includes(key)
    )
      fail(
        `${base}${pointer(key)}`,
        "unknown_key",
        `Unknown watcher key "${key}".`,
        "Watchers have only id, when, card, repeatAfterMinutes and maxRepeats; they never run actions.",
      );
  const id = raw.id;
  if (typeof id !== "string" || !idPattern.test(id))
    fail(
      `${base}/id`,
      "invalid_id",
      `Watcher id must match ${idPattern.source}.`,
    );
  const integer = (value: unknown, at: string, min: number, max: number) => {
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < min ||
      (value as number) > max
    ) {
      fail(at, "integer_range", `Must be an integer ${min}-${max}.`);
      return undefined;
    }
    return value as number;
  };
  let when: WatcherWhen | undefined;
  const rawWhen = raw.when;
  if (!isRecord(rawWhen))
    fail(
      `${base}/when`,
      "watcher_when",
      "when must be an object, e.g. {kind:'transition', entity, from?, to?}.",
    );
  else {
    // The HAS/1 example form {entity, from?, to?} is a transition.
    const kind =
      rawWhen.kind ??
      (Object.keys(rawWhen).every((k) => ["entity", "from", "to"].includes(k))
        ? "transition"
        : undefined);
    if (typeof kind !== "string" || !Object.hasOwn(WHEN_KEYS, kind))
      fail(
        `${base}/when/kind`,
        "watcher_kind",
        "when.kind must be transition, threshold, duration or schedule.",
      );
    else {
      const k = kind as WatcherWhen["kind"];
      for (const key of Object.keys(rawWhen))
        if (!WHEN_KEYS[k].includes(key))
          fail(
            `${base}/when${pointer(key)}`,
            "unknown_key",
            `A ${k} watcher has no "${key}".`,
            `Allowed: ${WHEN_KEYS[k].join(", ")}.`,
          );
      const entity = () => {
        const v = rawWhen.entity;
        const at = `${base}/when/entity`;
        if (typeof v !== "string" || !entityPattern.test(v)) {
          fail(
            at,
            "entity_binding_required",
            "Watch an exact entity ID string.",
          );
          return undefined;
        }
        const reason = watchable(v);
        if (reason) {
          fail(
            at,
            "entity_not_in_scope",
            reason,
            "Use only discovered, allowed entity IDs.",
          );
          return undefined;
        }
        return v;
      };
      const state = (key: string) =>
        rawWhen[key] === undefined
          ? undefined
          : plain(
              rawWhen[key],
              `${base}/when/${key}`,
              WATCHER_LIMITS.stateText,
              {
                min: 1,
              },
            );
      const number = (key: string) => {
        const v = rawWhen[key];
        if (v === undefined) return undefined;
        if (
          typeof v !== "number" ||
          !Number.isFinite(v) ||
          Math.abs(v) > WATCHER_LIMITS.threshold
        ) {
          fail(
            `${base}/when/${key}`,
            "threshold_number",
            `${key} must be a finite number.`,
          );
          return undefined;
        }
        return v;
      };
      if (k === "transition") {
        const e = entity(),
          from = state("from"),
          to = state("to");
        if (rawWhen.from === undefined && rawWhen.to === undefined)
          fail(
            `${base}/when`,
            "watcher_transition",
            "A transition needs to and/or from.",
          );
        else if (from !== undefined && from === to)
          fail(
            `${base}/when/to`,
            "watcher_transition",
            "from and to must differ.",
          );
        if (e)
          when = {
            kind: k,
            entity: e,
            ...(from !== undefined ? { from } : {}),
            ...(to !== undefined ? { to } : {}),
          };
      } else if (k === "threshold") {
        const e = entity(),
          above = number("above"),
          below = number("below");
        if (rawWhen.above === undefined && rawWhen.below === undefined)
          fail(
            `${base}/when`,
            "watcher_threshold",
            "A threshold needs above and/or below.",
          );
        else if (above !== undefined && below !== undefined && above >= below)
          fail(
            `${base}/when/below`,
            "watcher_threshold",
            "above must be less than below.",
          );
        if (e)
          when = {
            kind: k,
            entity: e,
            ...(above !== undefined ? { above } : {}),
            ...(below !== undefined ? { below } : {}),
          };
      } else if (k === "duration") {
        const e = entity(),
          s = state("state"),
          minutes = integer(
            rawWhen.minutes,
            `${base}/when/minutes`,
            1,
            WATCHER_LIMITS.minutes,
          );
        if (rawWhen.state === undefined)
          fail(
            `${base}/when/state`,
            "missing_prop",
            "A duration watcher needs state.",
          );
        if (e && s !== undefined && minutes !== undefined)
          when = { kind: k, entity: e, state: s, minutes };
      } else {
        const at = rawWhen.at;
        if (typeof at !== "string" || !timePattern.test(at))
          fail(
            `${base}/when/at`,
            "watcher_time",
            'at must be a 24-hour local time like "07:30".',
          );
        let days: string[] | undefined;
        if (rawWhen.days !== undefined) {
          const list = rawWhen.days;
          if (
            !Array.isArray(list) ||
            list.length < 1 ||
            list.length > 7 ||
            !list.every((d) => typeof d === "string" && WEEKDAYS.includes(d)) ||
            new Set(list).size !== list.length
          )
            fail(
              `${base}/when/days`,
              "watcher_days",
              `days must list distinct days from ${WEEKDAYS.join(", ")}.`,
            );
          else days = WEEKDAYS.filter((d) => list.includes(d));
        }
        if (typeof at === "string" && timePattern.test(at))
          when = { kind: k, at, ...(days ? { days } : {}) };
      }
    }
  }
  let card: WatcherSpec["card"] | undefined;
  if (!isRecord(raw.card))
    fail(`${base}/card`, "watcher_card", "card must be {title, body?}.");
  else {
    for (const key of Object.keys(raw.card))
      if (key !== "title" && key !== "body")
        fail(
          `${base}/card${pointer(key)}`,
          "unknown_key",
          `Unknown card key "${key}".`,
        );
    const title = plain(
      raw.card.title,
      `${base}/card/title`,
      WATCHER_LIMITS.cardTitle,
      {
        min: 1,
      },
    );
    const body =
      raw.card.body === undefined
        ? ""
        : plain(raw.card.body, `${base}/card/body`, WATCHER_LIMITS.cardBody);
    if (title !== undefined && body !== undefined) card = { title, body };
  }
  const repeat =
    raw.repeatAfterMinutes === undefined
      ? undefined
      : integer(
          raw.repeatAfterMinutes,
          `${base}/repeatAfterMinutes`,
          WATCHER_LIMITS.repeatMinutes,
          WATCHER_LIMITS.minutes,
        );
  const maxRepeats =
    raw.maxRepeats === undefined
      ? undefined
      : integer(
          raw.maxRepeats,
          `${base}/maxRepeats`,
          1,
          WATCHER_LIMITS.repeats,
        );
  if (when?.kind === "schedule" && raw.repeatAfterMinutes !== undefined)
    fail(
      `${base}/repeatAfterMinutes`,
      "watcher_repeat",
      "Schedules repeat by their days; repeatAfterMinutes is for entity watchers.",
    );
  if (raw.maxRepeats !== undefined && raw.repeatAfterMinutes === undefined)
    fail(
      `${base}/maxRepeats`,
      "watcher_repeat",
      "maxRepeats needs repeatAfterMinutes.",
    );
  if (failures || !when || !card || typeof id !== "string") return undefined;
  return {
    id,
    when,
    card,
    ...(repeat !== undefined ? { repeatAfterMinutes: repeat } : {}),
    ...(maxRepeats !== undefined ? { maxRepeats } : {}),
  };
}
// A standalone watcher created by the owner: entities must be inside
// Hearth's configured read scope.
export function validateOwnerWatcher(
  input: unknown,
  context: ValidationContext,
): { ok: true; watcher: WatcherSpec } | { ok: false; errors: SpecError[] } {
  const errors: SpecError[] = [];
  const watcher = checkWatcher(
    input,
    "",
    (path, code, message, hint) => {
      if (errors.length < LIMITS.errors)
        errors.push({ path, code, message, ...(hint ? { hint } : {}) });
    },
    context.redact ?? ((v) => v),
    (id) =>
      context.readable.includes(id)
        ? ""
        : `${id} is outside Hearth's configured read scope.`,
  );
  return watcher ? { ok: true, watcher } : { ok: false, errors };
}
// Plain-language description of a validated watcher for people.
export function describeWatcher(w: WatcherSpec): string {
  const when = w.when;
  const repeat = w.repeatAfterMinutes
    ? `; repeats every ${w.repeatAfterMinutes} min up to ${w.maxRepeats ?? 1}×`
    : "";
  switch (when.kind) {
    case "transition":
      return `${when.entity} ${when.from !== undefined ? `changes from ${when.from}` : "changes"}${when.to !== undefined ? ` to ${when.to}` : ""}${repeat}`;
    case "threshold":
      return `${when.entity} ${[
        when.above !== undefined ? `above ${when.above}` : "",
        when.below !== undefined ? `below ${when.below}` : "",
      ]
        .filter(Boolean)
        .join(" and ")}${repeat}`;
    case "duration":
      return `${when.entity} stays ${when.state} for ${when.minutes} min${repeat}`;
    case "schedule":
      return `Every ${when.days ? when.days.join(", ") : "day"} at ${when.at}`;
  }
}

export function validateSpec(
  input: unknown,
  context: ValidationContext,
): Validation {
  const errors: SpecError[] = [];
  const warnings: string[] = [];
  const fail = (path: string, code: string, message: string, hint?: string) => {
    if (errors.length < LIMITS.errors)
      errors.push({ path, code, message, ...(hint ? { hint } : {}) });
  };
  const done = (): Validation => ({ ok: false, errors, warnings });
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input) ?? "");
  } catch {
    fail("", "not_json", "Spec must be plain JSON.");
    return done();
  }
  if (bytes > LIMITS.specBytes) {
    fail(
      "",
      "spec_too_large",
      `Spec is ${bytes} bytes; the limit is ${LIMITS.specBytes}.`,
      "Use fewer elements or shorter texts.",
    );
    return done();
  }
  if (!isRecord(input)) {
    fail("", "not_object", "Spec must be a JSON object.");
    return done();
  }
  const plain = plainChecker(fail, context.redact ?? ((v: string) => v));
  for (const key of Object.keys(input)) {
    if (key === "id") {
      warnings.push("Ignored top-level id: Hearth assigns the appId.");
      continue;
    }
    if (key === "visibleWhen")
      fail(
        pointer(key),
        "unsupported_feature",
        `${key} is not supported in this Hearth version.`,
        `Remove ${key}.`,
      );
    else if (
      ![
        "specVersion",
        "title",
        "summary",
        "icon",
        "scope",
        "root",
        "elements",
        "watchers",
      ].includes(key)
    )
      fail(
        pointer(key),
        "unknown_key",
        `Unknown top-level key "${key}".`,
        "Allowed: specVersion, title, summary, icon, scope, root, elements, watchers.",
      );
  }
  if (input.specVersion !== SPEC_VERSION)
    fail(
      "/specVersion",
      "spec_version",
      `specVersion must be "${SPEC_VERSION}".`,
    );
  const title = plain(input.title, "/title", LIMITS.title, { min: 1 });
  const summary =
    input.summary === undefined
      ? ""
      : plain(input.summary, "/summary", LIMITS.summary);
  let icon = "";
  if (input.icon !== undefined && input.icon !== "") {
    if (
      typeof input.icon === "string" &&
      /^mdi:[a-z0-9-]{1,60}$/.test(input.icon)
    )
      icon = input.icon;
    else
      fail(
        "/icon",
        "invalid_icon",
        'icon must look like "mdi:washing-machine".',
      );
  }
  // Scope: a declared allowlist inside Hearth's configured read scope.
  const scope: string[] = [];
  if (!isRecord(input.scope))
    fail("/scope", "scope_required", 'scope must be {"entities": [...]}.');
  else {
    for (const key of Object.keys(input.scope))
      if (key !== "entities")
        fail(
          pointer("scope", key),
          "unknown_key",
          `Unknown scope key "${key}".`,
        );
    const list = input.scope.entities;
    if (!Array.isArray(list) || list.length > LIMITS.scopeEntities)
      fail(
        "/scope/entities",
        "scope_entities",
        `scope.entities must be an array of at most ${LIMITS.scopeEntities} entity IDs.`,
      );
    else
      list.forEach((id, i) => {
        const path = pointer("scope", "entities", i);
        if (typeof id !== "string" || !entityPattern.test(id))
          fail(
            path,
            "invalid_entity_id",
            "Expected an entity ID like sensor.washer_power.",
          );
        else if (!context.readable.includes(id))
          fail(
            path,
            "entity_not_readable",
            `${id} is outside Hearth's configured read scope.`,
            "Use ha_search_states to discover allowed IDs; never guess.",
          );
        else if (scope.includes(id))
          fail(path, "duplicate_entity", `${id} is listed twice.`);
        else scope.push(id);
      });
  }
  const used = new Set<string>();
  const stateKeys = new Map<string, string>();
  const elements: Record<string, SpecElement> = {};
  let charts = 0;
  if (!isRecord(input.elements))
    fail(
      "/elements",
      "elements_required",
      "elements must be an object keyed by element id.",
    );
  else {
    const ids = Object.keys(input.elements);
    if (ids.length < 1 || ids.length > LIMITS.elements)
      fail(
        "/elements",
        "element_count",
        `Use 1-${LIMITS.elements} elements; got ${ids.length}.`,
      );
    for (const id of ids.slice(0, LIMITS.elements)) {
      const base = pointer("elements", id);
      if (!idPattern.test(id)) {
        fail(
          base,
          "invalid_id",
          `Element id "${id}" must match ${idPattern.source}.`,
        );
        continue;
      }
      const raw = input.elements[id];
      if (!isRecord(raw)) {
        fail(base, "element_not_object", "Each element must be an object.");
        continue;
      }
      for (const key of Object.keys(raw))
        if (!["type", "props", "children"].includes(key))
          fail(
            pointer("elements", id, key),
            "unknown_key",
            `Unknown element key "${key}".`,
            "Elements have only type, props and children.",
          );
      const type = raw.type;
      const component =
        typeof type === "string" && Object.hasOwn(COMPONENTS, type)
          ? COMPONENTS[type]!
          : undefined;
      if (!component) {
        fail(
          pointer("elements", id, "type"),
          "unknown_component",
          `Unknown component type ${JSON.stringify(type)}.`,
          `Use one of: ${Object.keys(COMPONENTS).join(", ")}.`,
        );
        continue;
      }
      const props: SpecElement["props"] = {};
      const rawProps = raw.props === undefined ? {} : raw.props;
      if (!isRecord(rawProps)) {
        fail(
          pointer("elements", id, "props"),
          "props_not_object",
          "props must be an object.",
        );
        continue;
      }
      const entityBound = Object.values(component.props).some(
        (p) => p.type === "entity" || p.type === "entities",
      );
      for (const key of Object.keys(rawProps)) {
        if (Object.hasOwn(component.props, key)) continue;
        if (entityBound && LITERAL_KEYS.includes(key))
          fail(
            pointer("elements", id, "props", key),
            "literal_value_forbidden",
            `${type} values come from the controller; "${key}" cannot be written in the spec.`,
            `Remove "${key}"; bind the entity instead.`,
          );
        else
          fail(
            pointer("elements", id, "props", key),
            "unknown_prop",
            `${type} has no prop "${key}".`,
            `Allowed props: ${Object.keys(component.props).join(", ") || "none"}.`,
          );
      }
      for (const [name, prop] of Object.entries(component.props)) {
        const path = pointer("elements", id, "props", name);
        const value = rawProps[name];
        if (value === undefined) {
          if (prop.required)
            fail(
              path,
              "missing_prop",
              `${type} requires "${name}" (${prop.doc}).`,
            );
          continue;
        }
        const bindEntity = (v: unknown, at: string): string | undefined => {
          if (typeof v !== "string" || !entityPattern.test(v)) {
            fail(
              at,
              "entity_binding_required",
              "Entity-bound props take an exact entity ID string, never a value.",
              'Example: "sensor.washer_power".',
            );
            return undefined;
          }
          if (!scope.includes(v)) {
            fail(
              at,
              "entity_not_in_scope",
              `${v} is not listed in scope.entities${context.readable.includes(v) ? "" : " and is outside Hearth's read scope"}.`,
              context.readable.includes(v)
                ? "Add it to scope.entities."
                : "Use only discovered, allowed entity IDs.",
            );
            return undefined;
          }
          used.add(v);
          return v;
        };
        switch (prop.type) {
          case "text": {
            const t = plain(value, path, prop.max, {
              min: prop.required ? 1 : 0,
              ...(prop.multiline ? { multiline: true } : {}),
            });
            if (t !== undefined) props[name] = t;
            break;
          }
          case "integer":
            if (
              !Number.isSafeInteger(value) ||
              (value as number) < prop.min ||
              (value as number) > prop.max
            )
              fail(
                path,
                "integer_range",
                `"${name}" must be an integer ${prop.min}-${prop.max}.`,
              );
            else props[name] = value as number;
            break;
          case "enum":
            if (typeof value !== "string" || !prop.values.includes(value))
              fail(
                path,
                "enum",
                `"${name}" must be one of ${prop.values.join(", ")}.`,
              );
            else props[name] = value;
            break;
          case "stateKey":
            if (typeof value !== "string" || !idPattern.test(value))
              fail(
                path,
                "invalid_state_key",
                `stateKey must match ${idPattern.source}.`,
              );
            else if (stateKeys.has(value))
              fail(
                path,
                "duplicate_state_key",
                `stateKey "${value}" is already used by element "${stateKeys.get(value)}".`,
                "Each Checklist/Counter/Note needs its own stateKey.",
              );
            else {
              stateKeys.set(value, id);
              props[name] = value;
            }
            break;
          case "textList": {
            if (
              !Array.isArray(value) ||
              value.length < prop.min ||
              value.length > prop.max
            ) {
              fail(
                path,
                "list_length",
                `"${name}" must be an array of ${prop.min}-${prop.max} strings.`,
              );
              break;
            }
            const list: string[] = [];
            value.forEach((item, i) => {
              const t = plain(
                item,
                pointer("elements", id, "props", name, i),
                prop.itemMax,
                { min: 1 },
              );
              if (t === undefined) return;
              if (list.includes(t))
                fail(
                  pointer("elements", id, "props", name, i),
                  "duplicate_item",
                  `"${t}" is listed twice.`,
                );
              else list.push(t);
            });
            props[name] = list;
            break;
          }
          case "entity": {
            const v = bindEntity(value, path);
            if (v === undefined) break;
            const domains =
              component.safety === "home" && context.adminControls
                ? context.adminControls
                : prop.domains;
            if (domains && !domains.includes(v.split(".")[0]!)) {
              fail(
                path,
                "entity_domain",
                `${type} only supports ${domains.join("/")} entities.`,
              );
              break;
            }
            if (component.safety === "home" && !context.adminControls) {
              const domain = v.split(".")[0]!;
              const missing = [
                `${domain}.turn_on`,
                `${domain}.turn_off`,
              ].filter((s) => !context.services.includes(s));
              if (missing.length) {
                fail(
                  path,
                  "action_not_in_scope",
                  `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not in Hearth's configured service scope, so ${v} cannot be toggled.`,
                  "Remove the ToggleAction or show the entity read-only (EntityTile/StatusPill).",
                );
                break;
              }
            }
            props[name] = v;
            break;
          }
          case "entities": {
            if (
              !Array.isArray(value) ||
              value.length < prop.min ||
              value.length > prop.max
            ) {
              fail(
                path,
                "list_length",
                `"${name}" must list ${prop.min}-${prop.max} entity IDs.`,
              );
              break;
            }
            const list: string[] = [];
            value.forEach((v, i) => {
              const bound = bindEntity(
                v,
                pointer("elements", id, "props", name, i),
              );
              if (bound === undefined) return;
              if (list.includes(bound))
                fail(
                  pointer("elements", id, "props", name, i),
                  "duplicate_entity",
                  `${bound} is listed twice.`,
                );
              else list.push(bound);
            });
            props[name] = list;
            break;
          }
        }
      }
      if (type === "Counter") {
        const min = (props.min as number | undefined) ?? 0;
        const max = (props.max as number | undefined) ?? 1000;
        if (min >= max)
          fail(
            pointer("elements", id, "props", "max"),
            "counter_range",
            "Counter max must be greater than min.",
          );
      }
      if (type === "HistoryChart" && ++charts > LIMITS.charts)
        fail(
          base,
          "chart_limit",
          `At most ${LIMITS.charts} HistoryChart elements per app.`,
        );
      const children: string[] = [];
      // Leaves may carry an empty children array (the normalized stored form).
      if (
        raw.children !== undefined &&
        !(
          !component.children &&
          Array.isArray(raw.children) &&
          raw.children.length === 0
        )
      ) {
        if (!component.children)
          fail(
            pointer("elements", id, "children"),
            "children_not_allowed",
            `${type} cannot have children.`,
            "Put it inside a Stack, Grid, Card or Section instead.",
          );
        else if (!Array.isArray(raw.children))
          fail(
            pointer("elements", id, "children"),
            "children_not_array",
            "children must be an array of element ids.",
          );
        else
          raw.children.forEach((child, i) => {
            if (typeof child !== "string")
              fail(
                pointer("elements", id, "children", i),
                "child_not_id",
                "Children are element id strings.",
              );
            else children.push(child);
          });
      }
      if (component.children) {
        const { min, max } = component.children;
        if (children.length < min || children.length > max)
          fail(
            pointer("elements", id, "children"),
            "children_count",
            `${type} needs ${min}-${max} children; got ${children.length}.`,
          );
      }
      if (
        type === "Tabs" &&
        Array.isArray(props.labels) &&
        props.labels.length !== children.length
      )
        fail(
          pointer("elements", id, "props", "labels"),
          "tab_labels",
          `Tabs has ${children.length} children but ${props.labels.length} labels.`,
          "Give exactly one label per child.",
        );
      elements[id] = { type: type as string, props, children };
    }
  }
  // Graph: one tree from root, no cycles, shared children, orphans or deep nesting.
  const root = input.root;
  if (typeof root !== "string" || !Object.hasOwn(elements, root)) {
    if (!errors.some((e) => e.path.startsWith("/elements")))
      fail(
        "/root",
        "root_missing",
        `root must name an element id; ${JSON.stringify(root)} is not in elements.`,
      );
  } else {
    const parent = new Map<string, string>();
    const visiting = new Set<string>();
    const walk = (id: string, depth: number) => {
      if (depth > LIMITS.depth) {
        fail(
          pointer("elements", id),
          "depth_limit",
          `Nesting is deeper than ${LIMITS.depth} levels.`,
          "Flatten the layout.",
        );
        return;
      }
      visiting.add(id);
      elements[id]!.children.forEach((child, i) => {
        const path = pointer("elements", id, "children", i);
        if (!Object.hasOwn(elements, child)) {
          if (isRecord(input.elements) && Object.hasOwn(input.elements, child))
            return;
          fail(
            path,
            "missing_child",
            `Child "${child}" is not defined in elements.`,
          );
        } else if (visiting.has(child) || child === root)
          fail(
            path,
            "cycle",
            `Child "${child}" creates a cycle.`,
            "Each element may appear once in the tree.",
          );
        else if (parent.has(child))
          fail(
            path,
            "shared_child",
            `"${child}" is already a child of "${parent.get(child)}".`,
            "Give each element exactly one parent; duplicate it with a new id if needed.",
          );
        else {
          parent.set(child, id);
          walk(child, depth + 1);
        }
      });
      visiting.delete(id);
    };
    walk(root, 1);
    for (const id of Object.keys(elements))
      if (id !== root && !parent.has(id))
        fail(
          pointer("elements", id),
          "orphan",
          `Element "${id}" is not reachable from root "${root}".`,
          "Reference it from a parent's children or delete it.",
        );
  }
  const watchers: WatcherSpec[] = [];
  if (input.watchers !== undefined) {
    if (
      !Array.isArray(input.watchers) ||
      input.watchers.length > WATCHER_LIMITS.perApp
    )
      fail(
        "/watchers",
        "watchers_length",
        `watchers must be an array of at most ${WATCHER_LIMITS.perApp}.`,
      );
    else
      input.watchers.forEach((raw, i) => {
        const watcher = checkWatcher(
          raw,
          pointer("watchers", i),
          fail,
          context.redact ?? ((v) => v),
          (id) =>
            scope.includes(id)
              ? ""
              : `${id} is not listed in scope.entities${context.readable.includes(id) ? "" : " and is outside Hearth's read scope"}.`,
        );
        if (!watcher) return;
        if (watchers.some((w) => w.id === watcher.id))
          fail(
            pointer("watchers", i, "id"),
            "duplicate_watcher",
            `Watcher id "${watcher.id}" is used twice.`,
          );
        else {
          watchers.push(watcher);
          if (watcher.when.kind !== "schedule") used.add(watcher.when.entity);
        }
      });
  }
  for (const id of scope)
    if (!used.has(id))
      warnings.push(`${id} is in scope.entities but no element uses it.`);
  for (const [id, element] of Object.entries(elements))
    if (element.type === "Grid" && element.props.columns === 3)
      warnings.push(`Grid "${id}" uses 3 columns; phones show 2.`);
  if (errors.length || title === undefined || summary === undefined)
    return done();
  return {
    ok: true,
    warnings,
    spec: {
      specVersion: SPEC_VERSION,
      title,
      summary,
      icon,
      scope: { entities: scope },
      root: root as string,
      elements,
      ...(watchers.length ? { watchers } : {}),
    },
  };
}

// Bindings the controller reads for a validated spec.
export function boundEntities(spec: AppSpec): string[] {
  const ids = new Set<string>();
  for (const element of Object.values(spec.elements))
    for (const [name, value] of Object.entries(element.props)) {
      const prop = COMPONENTS[element.type]?.props[name];
      if (prop?.type === "entity") ids.add(value as string);
      if (prop?.type === "entities")
        for (const v of value as string[]) ids.add(v);
    }
  return [...ids].sort();
}

// RFC 6902 subset (add / remove / replace) applied to a detached copy.
export type PatchOp = { op: string; path: string; value?: unknown };
const FORBIDDEN_SEGMENTS = ["__proto__", "prototype", "constructor"];
export function applyPatch(
  document: unknown,
  ops: unknown,
): { ok: true; value: unknown } | { ok: false; errors: SpecError[] } {
  const errors: SpecError[] = [];
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > LIMITS.patchOps)
    return {
      ok: false,
      errors: [
        {
          path: "/patch",
          code: "patch_length",
          message: `patch must have 1-${LIMITS.patchOps} operations.`,
        },
      ],
    };
  const doc = JSON.parse(JSON.stringify(document)) as unknown;
  let root = doc;
  for (const [i, raw] of ops.entries()) {
    const at = `/patch/${i}`;
    const error = (message: string, hint?: string) => {
      errors.push({
        path: at,
        code: "patch_failed",
        message,
        ...(hint ? { hint } : {}),
      });
    };
    if (
      !isRecord(raw) ||
      Object.keys(raw).some((k) => !["op", "path", "value"].includes(k))
    ) {
      error("Each operation is {op, path, value?}.");
      break;
    }
    const { op, path } = raw;
    if (op !== "add" && op !== "remove" && op !== "replace") {
      error(
        `Unsupported op ${JSON.stringify(op)}.`,
        "Use add, remove or replace.",
      );
      break;
    }
    if (
      typeof path !== "string" ||
      (path !== "" && !path.startsWith("/")) ||
      path.length > 300
    ) {
      error(
        "path must be a JSON Pointer such as /elements/washer/props/label.",
      );
      break;
    }
    if ((op === "add" || op === "replace") && !Object.hasOwn(raw, "value")) {
      error(`${op} needs a value.`);
      break;
    }
    const segments =
      path === ""
        ? []
        : path
            .slice(1)
            .split("/")
            .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (segments.some((s) => FORBIDDEN_SEGMENTS.includes(s))) {
      error("Forbidden path segment.");
      break;
    }
    if (!segments.length) {
      if (op === "remove") {
        error("Cannot remove the whole spec.");
        break;
      }
      root = JSON.parse(JSON.stringify(raw.value));
      continue;
    }
    let target: unknown = root;
    for (const segment of segments.slice(0, -1)) {
      if (
        Array.isArray(target) &&
        /^(0|[1-9][0-9]*)$/.test(segment) &&
        Number(segment) < target.length
      )
        target = target[Number(segment)];
      else if (isRecord(target) && Object.hasOwn(target, segment))
        target = target[segment];
      else {
        target = undefined;
        break;
      }
    }
    const last = segments[segments.length - 1]!;
    const value =
      raw.value === undefined
        ? undefined
        : JSON.parse(JSON.stringify(raw.value));
    if (Array.isArray(target)) {
      const index =
        last === "-" && op === "add"
          ? target.length
          : /^(0|[1-9][0-9]*)$/.test(last)
            ? Number(last)
            : -1;
      const bound = op === "add" ? target.length : target.length - 1;
      if (index < 0 || index > bound) {
        error(`Array index "${last}" is out of range at ${path}.`);
        break;
      }
      if (op === "add") target.splice(index, 0, value);
      else if (op === "remove") target.splice(index, 1);
      else target[index] = value;
    } else if (isRecord(target)) {
      if (op !== "add" && !Object.hasOwn(target, last)) {
        error(
          `Nothing to ${op} at ${path}.`,
          "Read the current spec with app_get first.",
        );
        break;
      }
      if (op === "remove") delete target[last];
      else target[last] = value;
    } else {
      error(`Parent of ${path} does not exist.`);
      break;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: root };
}

export type SpecDiff = {
  added: string[];
  removed: string[];
  changed: string[];
  entitiesAdded: string[];
  entitiesRemoved: string[];
  titleChanged: boolean;
  watchersAdded: string[];
  watchersRemoved: string[];
};
export function diffSpecs(before: AppSpec | null, after: AppSpec): SpecDiff {
  const a = before?.elements ?? {};
  const b = after.elements;
  const oldScope = before?.scope.entities ?? [];
  return {
    added: Object.keys(b).filter((id) => !Object.hasOwn(a, id)),
    removed: Object.keys(a).filter((id) => !Object.hasOwn(b, id)),
    changed: Object.keys(b).filter(
      (id) =>
        Object.hasOwn(a, id) && JSON.stringify(a[id]) !== JSON.stringify(b[id]),
    ),
    entitiesAdded: after.scope.entities.filter((e) => !oldScope.includes(e)),
    entitiesRemoved: oldScope.filter((e) => !after.scope.entities.includes(e)),
    titleChanged: !!before && before.title !== after.title,
    watchersAdded: (after.watchers ?? [])
      .map((w) => w.id)
      .filter((id) => !(before?.watchers ?? []).some((w) => w.id === id)),
    watchersRemoved: (before?.watchers ?? [])
      .map((w) => w.id)
      .filter((id) => !(after.watchers ?? []).some((w) => w.id === id)),
  };
}

// Built-in starting points. Entity IDs are placeholders: replace them with
// discovered, allowed IDs (and drop parts the home cannot support).
export const TEMPLATES: { name: string; use: string; spec: AppSpec }[] = [
  {
    name: "Bedtime lock-up",
    use: "Doors/windows/locks status before bed plus an approved light switch-off.",
    spec: {
      specVersion: SPEC_VERSION,
      title: "Bedtime lock-up",
      summary: "Is the house closed and dark for the night?",
      icon: "mdi:weather-night",
      scope: {
        entities: [
          "binary_sensor.front_door",
          "binary_sensor.back_window",
          "lock.front_door",
          "light.downstairs",
        ],
      },
      root: "main",
      elements: {
        main: {
          type: "Stack",
          props: {},
          children: ["checks", "lights", "routine"],
        },
        checks: {
          type: "Card",
          props: { title: "Doors and windows" },
          children: ["door", "window", "lock"],
        },
        door: {
          type: "StatusPill",
          props: {
            entity: "binary_sensor.front_door",
            label: "Front door",
            okStates: ["off"],
          },
          children: [],
        },
        window: {
          type: "StatusPill",
          props: {
            entity: "binary_sensor.back_window",
            label: "Back window",
            okStates: ["off"],
          },
          children: [],
        },
        lock: {
          type: "StatusPill",
          props: {
            entity: "lock.front_door",
            label: "Front lock",
            okStates: ["locked"],
          },
          children: [],
        },
        lights: {
          type: "Card",
          props: { title: "Lights" },
          children: ["downstairs", "off"],
        },
        downstairs: {
          type: "EntityTile",
          props: { entity: "light.downstairs", label: "Downstairs" },
          children: [],
        },
        off: {
          type: "ToggleAction",
          props: { entity: "light.downstairs", label: "Downstairs light" },
          children: [],
        },
        routine: {
          type: "Checklist",
          props: {
            stateKey: "bedtime",
            title: "Routine",
            items: ["Back door locked", "Oven off", "Phone charging"],
          },
          children: [],
        },
      },
    },
  },
  {
    name: "Laundry",
    use: "Washer/dryer state, power history and a folding checklist.",
    spec: {
      specVersion: SPEC_VERSION,
      title: "Laundry",
      summary: "Washer and dryer at a glance, plus the folding list.",
      icon: "mdi:washing-machine",
      scope: {
        entities: [
          "sensor.washer_state",
          "sensor.dryer_state",
          "sensor.washer_power",
        ],
      },
      root: "main",
      elements: {
        main: {
          type: "Stack",
          props: {},
          children: ["machines", "power", "fold", "ask"],
        },
        machines: {
          type: "Grid",
          props: { columns: 2 },
          children: ["washer", "dryer"],
        },
        washer: {
          type: "EntityTile",
          props: { entity: "sensor.washer_state", label: "Washer" },
          children: [],
        },
        dryer: {
          type: "EntityTile",
          props: { entity: "sensor.dryer_state", label: "Dryer" },
          children: [],
        },
        power: {
          type: "HistoryChart",
          props: {
            entities: ["sensor.washer_power"],
            hours: 6,
            label: "Washer power",
          },
          children: [],
        },
        fold: {
          type: "Checklist",
          props: {
            stateKey: "fold",
            title: "Folding",
            items: ["Towels", "Bed linen", "Kids' clothes"],
          },
          children: [],
        },
        ask: {
          type: "AskButton",
          props: {
            label: "When will it finish?",
            prompt:
              "Read the washer state and power now and estimate when the cycle finishes. Say what you observed.",
          },
          children: [],
        },
      },
      watchers: [
        {
          id: "washer_done",
          when: {
            kind: "transition",
            entity: "sensor.washer_state",
            from: "running",
            to: "idle",
          },
          card: {
            title: "Washer finished",
            body: "Move the laundry to the dryer.",
          },
          repeatAfterMinutes: 30,
          maxRepeats: 2,
        },
      ],
    },
  },
  {
    name: "3D print monitor",
    use: "Printer progress, temperatures and a failure question.",
    spec: {
      specVersion: SPEC_VERSION,
      title: "3D print",
      summary: "Progress, temperatures and status of the current print.",
      icon: "mdi:printer-3d",
      scope: {
        entities: [
          "sensor.printer_progress",
          "sensor.printer_state",
          "sensor.printer_nozzle_temperature",
          "sensor.printer_bed_temperature",
        ],
      },
      root: "main",
      elements: {
        main: {
          type: "Stack",
          props: {},
          children: ["status", "temps", "nozzle", "notes", "ask"],
        },
        status: {
          type: "Grid",
          props: { columns: 2 },
          children: ["progress", "state"],
        },
        progress: {
          type: "EntityValue",
          props: { entity: "sensor.printer_progress", label: "Progress" },
          children: [],
        },
        state: {
          type: "StatusPill",
          props: {
            entity: "sensor.printer_state",
            label: "Printer",
            okStates: ["printing", "idle", "finished"],
          },
          children: [],
        },
        temps: {
          type: "Grid",
          props: { columns: 2 },
          children: ["nozzle_now", "bed_now"],
        },
        nozzle_now: {
          type: "EntityValue",
          props: {
            entity: "sensor.printer_nozzle_temperature",
            label: "Nozzle",
          },
          children: [],
        },
        bed_now: {
          type: "EntityValue",
          props: { entity: "sensor.printer_bed_temperature", label: "Bed" },
          children: [],
        },
        nozzle: {
          type: "HistoryChart",
          props: {
            entities: ["sensor.printer_nozzle_temperature"],
            hours: 3,
            label: "Nozzle temperature",
          },
          children: [],
        },
        notes: {
          type: "Note",
          props: {
            stateKey: "print_notes",
            label: "Print notes",
            maxLength: 1000,
          },
          children: [],
        },
        ask: {
          type: "AskButton",
          props: {
            label: "Why might it fail?",
            prompt:
              "Read the printer state and temperatures now. If anything looks wrong, explain likely causes; do not call services.",
          },
          children: [],
        },
      },
    },
  },
  {
    name: "Maintenance checklist",
    use: "Recurring household maintenance with counters and a log note.",
    spec: {
      specVersion: SPEC_VERSION,
      title: "Maintenance",
      summary: "Household upkeep checklist and log.",
      icon: "mdi:tools",
      scope: { entities: ["sensor.smoke_alarm_battery"] },
      root: "main",
      elements: {
        main: {
          type: "Tabs",
          props: { labels: ["To do", "Log"] },
          children: ["todo", "log"],
        },
        todo: { type: "Stack", props: {}, children: ["tasks", "battery"] },
        tasks: {
          type: "Checklist",
          props: {
            stateKey: "tasks",
            title: "This season",
            items: [
              "Replace HVAC filter",
              "Test smoke alarms",
              "Descale kettle",
              "Clean dryer vent",
            ],
          },
          children: [],
        },
        battery: {
          type: "EntityValue",
          props: {
            entity: "sensor.smoke_alarm_battery",
            label: "Smoke alarm battery",
          },
          children: [],
        },
        log: { type: "Stack", props: {}, children: ["filters", "note"] },
        filters: {
          type: "Counter",
          props: {
            stateKey: "filters",
            label: "Filters left in stock",
            step: 1,
            min: 0,
            max: 50,
          },
          children: [],
        },
        note: {
          type: "Note",
          props: { stateKey: "log", label: "Log", maxLength: 2000 },
          children: [],
        },
      },
    },
  },
];

export function describeCatalog() {
  return {
    specVersion: SPEC_VERSION,
    shape:
      '{"specVersion":"has/1","title":string,"summary"?:string,"icon"?:"mdi:name","scope":{"entities":[exact IDs]},"root":elementId,"elements":{id:{"type":Component,"props":{...},"children"?:[ids]}}}',
    rules: [
      "Flat element map; children reference ids. One tree from root: no cycles, no shared children, no orphans.",
      `Limits: ${LIMITS.elements} elements, depth ${LIMITS.depth}, ${LIMITS.tabs} tabs, ${LIMITS.scopeEntities} scope entities, ${LIMITS.charts} charts, ${LIMITS.specBytes} bytes. Ids match ${idPattern.source}.`,
      "Every entity prop must be an exact ID listed in scope.entities, and scope.entities must be inside Hearth's configured read scope. Discover IDs with ha_search_states; never guess.",
      "You never write values. The controller reads HA state and shows an as-of time; literal value/state/unit props are rejected.",
      "Text is plain (no HTML, links, markdown, templates or expressions).",
      "ToggleAction only for light/switch entities whose turn_on and turn_off are both configured services. A person taps it; Home permissions decide (Read-only disabled, Ask exact approval, Full within scope). You cannot press it.",
      "You cannot tick checklists, change counters/notes or press buttons; only people interact with apps.",
      "Update with app_update(appId, baseVersion, patch) using JSON Patch add/remove/replace on the spec. A stale baseVersion returns the current version; re-read with app_get and retry.",
      `Optional "watchers" (at most ${WATCHER_LIMITS.perApp}): Hearth's controller evaluates them about once a minute and only creates a card in the owner's Today inbox. They never call services, press controls or message you. Watched entities must be in scope.entities.`,
    ],
    watchers: {
      shape:
        '{"id":id,"when":When,"card":{"title":text,"body"?:text},"repeatAfterMinutes"?:5-1440,"maxRepeats"?:1-5}',
      when: [
        '{"kind":"transition","entity":id,"from"?:state,"to"?:state} — the state changes (e.g. running → idle). Changes out of unavailable/unknown are ignored unless "from" names them.',
        '{"kind":"threshold","entity":id,"above"?:number,"below"?:number} — a numeric state crosses into the range.',
        '{"kind":"duration","entity":id,"state":state,"minutes":1-1440} — stays in a state that long (as observed by Hearth).',
        '{"kind":"schedule","at":"HH:MM","days"?:["mon",...]} — a reminder at a local time; a time missed while Hearth was off is delivered once, marked late.',
      ],
      notes:
        "repeatAfterMinutes/maxRepeats repeat an entity watcher's card while its condition still holds. Card text is plain; the controller adds the entity's read value and time.",
    },
    components: Object.entries(COMPONENTS).map(([type, c]) => ({
      type,
      description: c.description,
      safety: c.safety,
      children: c.children ? `${c.children.min}-${c.children.max}` : "none",
      props: Object.fromEntries(
        Object.entries(c.props).map(([name, p]) => [
          name,
          `${p.type}${p.required ? " (required)" : ""}: ${p.doc}`,
        ]),
      ),
    })),
    templates: TEMPLATES.map((t) => ({
      name: t.name,
      use: t.use,
      note: "Placeholder entity IDs: replace with discovered allowed IDs and drop unsupported parts.",
      spec: t.spec,
    })),
  };
}

// One line per component for tool descriptions, generated from COMPONENTS.
export function catalogSummary(): string {
  return Object.entries(COMPONENTS)
    .map(
      ([type, c]) =>
        `${type}(${Object.entries(c.props)
          .map(([n, p]) => `${n}${p.required ? "" : "?"}`)
          .join(",")})${c.children ? "[children]" : ""}`,
    )
    .join("; ");
}
