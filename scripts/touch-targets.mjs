#!/usr/bin/env node
// Touch-target audit for the Hearth Pi web UI (hearth_pi/public).
//
// Serves the real, unmodified UI files from a throw-away loopback server
// backed by synthetic API data, opens every view in headless Chrome with
// touch emulation, and lists each interactive element whose real hit area is
// smaller than 44x44 CSS px. Exits non-zero while any remain.
//
//   node scripts/touch-targets.mjs [--width 390] [--layout standalone]
//        [--scene chat] [--shots DIR] [--list] [--verbose]
//
// Needs `playwright-core` (resolved from PLAYWRIGHT_CORE, hearth_pi/node_modules,
// the repository root or a plain import) and a Chrome or Chromium binary
// (CHROME_PATH, or a standard install location). Nothing here contacts a real
// Home Assistant, model or network; all data is synthetic.
//
// Two things are measured for every interactive element:
//   box  the element's own border box (what DevTools, Lighthouse and a finger
//        on a slightly-off tap all effectively see; it must be 44x44), and
//   hit  the real hit area, probed with `elementFromPoint` along the centre
//        row and column, which includes transparent ::before/::after
//        extensions but loses any part a neighbour overlaps and wins.
// An element fails when its hit area is under 44x44, or when its box is under
// 44x44 and it is not listed in HIT_AREA_EXTENSION below. A checkbox or radio
// inside a <label> is measured as that label.
import http from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "hearth_pi", "public");
const MIN = 44;
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
];
const LAYOUTS = ["standalone", "safe-area", "embedded"];

// ---------------------------------------------------------------- options
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const flag = (name) => args.includes(`--${name}`);
const only = {
  width: option("width"),
  layout: option("layout"),
  scene: option("scene"),
};
const shotsDir = option("shots");
const verbose = flag("verbose");

// Inline text links inside prose may stay small (WCAG 2.5.8 inline
// exception). Hearth's markdown renderer does not emit links, so this list is
// empty; add `{ selector, why }` entries here only with a reason.
const ALLOWLIST = [];

// Elements that are intentionally smaller than 44px (a device dot placed on a
// map cannot be bulky) and reach 44px only through a transparent hit-area
// extension. Their measured hit area must still be at least 44x44.
// Entries are substrings matched against the reported selector.
const HIT_AREA_EXTENSION = [];

// index.html controls no synthetic scene can show, each with the reason.
const NOT_REACHABLE = [];

// -------------------------------------------------------- playwright/chrome
async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    join(root, "hearth_pi", "node_modules", "playwright-core"),
    join(root, "node_modules", "playwright-core"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const entry = createRequire(import.meta.url).resolve(candidate);
      const mod = await import(pathToFileURL(entry).href);
      return mod.chromium ? mod : mod.default;
    } catch {
      /* try the next location */
    }
  }
  try {
    const mod = await import("playwright-core");
    return mod.chromium ? mod : mod.default;
  } catch {
    throw new Error(
      "playwright-core not found. Install it (npm i --no-save playwright-core) or set PLAYWRIGHT_CORE to its directory.",
    );
  }
}
function chromePath() {
  const found = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((p) => p && existsSync(p));
  if (!found)
    throw new Error("No Chrome or Chromium found. Set CHROME_PATH to one.");
  return found;
}

// ------------------------------------------------------------ synthetic data
const NOW = Date.now();
const MIN_MS = 60000;
const HASH = "a".repeat(64);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const text = (value) => [{ type: "text", text: value }];
const lamp = {
  kind: "service",
  domain: "light",
  service: "turn_on",
  target: { entity_id: ["light.example_lamp"] },
  data: { brightness_pct: 40 },
};
const proposal = (id, status, extra = {}) => ({
  id,
  hash: HASH,
  status,
  created: NOW - id * MIN_MS,
  expires: NOW + 10 * MIN_MS,
  action: lamp,
  risk: {
    level: "low",
    rule: "light_basic",
    reasons: ["A single light, reversible."],
  },
  judge: {
    verdict: "agreed",
    model: "example/judge",
    reason: "Matches the request.",
    latencyMs: 320,
  },
  authorization: { source: "human", revision: 3 },
  ...extra,
});
const PROPOSALS = {
  p1: proposal(1, "pending", { notified: true }),
  p2: proposal(2, "pending", {
    risk: { level: "critical", rule: "host_reboot", reasons: ["Host reboot."] },
    confirmation: "REBOOT",
    action: { kind: "supervisor", method: "POST", path: "/host/reboot" },
  }),
  p3: proposal(3, "accepted", {
    undo: { until: NOW + 5 * MIN_MS },
    decidedVia: "push",
  }),
  p4: proposal(4, "unknown"),
  p5: proposal(5, "rejected", {
    resolution: "Rejected by you.",
    origin: { kind: "list", entityId: "todo.example_groceries" },
    action: {
      kind: "todo",
      op: "add",
      summary: "Oat milk",
      entityId: "todo.example_groceries",
    },
  }),
  p6: proposal(6, "accepted", {
    origin: {
      kind: "app",
      appId: "app_laundry",
      elementId: "hall",
      version: 2,
    },
    authorization: { source: "automatic", revision: 3 },
  }),
};
const APP_RESULT = {
  ok: true,
  appId: "app_laundry",
  title: "Laundry",
  summary: "Washer at a glance",
  version: 2,
  elements: 7,
  entities: ["sensor.washer_state"],
  diff: { added: ["chart"] },
  warnings: ["One entity is outside the read scope."],
};
const WORLD_RESULT = {
  ok: true,
  kind: "home_world_proposal",
  rooms: 4,
  decor: 1,
  cols: 16,
  rows: 10,
  note: "Drawn from the attached plan.",
};
const LONG_JSON = JSON.stringify(
  {
    entity_id: "sensor.example_temperature",
    state: "21.4",
    attributes: { friendly_name: "Study temperature", note: "x".repeat(700) },
  },
  null,
  2,
);
const MARKDOWN = [
  "## The study",
  "",
  "The lamp is **on** at 40% and the room reads `21.4 °C`.",
  "",
  "- Lamp: on",
  "- Fan *Breezy*: off",
  "",
  "| Device | State |",
  "| --- | --- |",
  "| Lamp | on |",
  "| Fan | off |",
  "",
  "```",
  "light.example_lamp: on",
  "```",
].join("\n");

function entriesChat() {
  const entry = (id, ...model) => ({ id, model });
  const user = (value) => ({ role: "user", content: text(value) });
  const assistant = (value, extra = {}) => ({
    role: "assistant",
    content: text(value),
    stopReason: "stop",
    ...extra,
  });
  return [
    entry(1, user("Turn on the study lamp and tell me the temperature.")),
    entry(2, {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "c1",
          name: "ha_read_state",
          arguments: { entityId: "sensor.example_temperature" },
        },
        {
          type: "toolCall",
          id: "c2",
          name: "ha_read_state",
          arguments: { entityId: "light.example_lamp" },
        },
      ],
    }),
    entry(3, {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "ha_read_state",
      isError: false,
      content: text(LONG_JSON),
    }),
    entry(4, {
      role: "toolResult",
      toolCallId: "c2",
      toolName: "ha_read_state",
      isError: true,
      content: text("not_in_read_scope"),
    }),
    entry(5, assistant(MARKDOWN)),
    entry(6, {
      role: "user",
      content: [
        { type: "text", text: "Here is my floor plan." },
        { type: "image", image: "6/0" },
      ],
    }),
    entry(7, {
      role: "toolResult",
      toolCallId: "c3",
      toolName: "app_create",
      isError: false,
      content: text(JSON.stringify(APP_RESULT)),
    }),
    entry(8, {
      role: "toolResult",
      toolCallId: "c4",
      toolName: "world_layout_propose",
      isError: false,
      content: text(JSON.stringify(WORLD_RESULT)),
    }),
    entry(
      9,
      assistant("", { stopReason: "error", errorMessage: "provider_error" }),
    ),
    entry(10, assistant("Everything is set. Anything else for the study?")),
  ];
}
const CANVAS = {
  title: "Study at a glance",
  committedAt: NOW - 5 * MIN_MS,
  sections: [
    {
      title: "Study",
      readings: [
        {
          entityId: "light.example_lamp",
          state: "on",
          attributes: { friendly_name: "Study lamp" },
          observedAt: NOW - 5 * MIN_MS,
        },
        {
          entityId: "sensor.example_temperature",
          state: "21.4",
          attributes: {
            friendly_name: "Study temperature",
            unit_of_measurement: "°C",
          },
          observedAt: NOW - 5 * MIN_MS,
        },
      ],
    },
  ],
};
const HOME_PERMISSIONS = {
  effectiveMode: "ask",
  mode: "ask",
  revision: 3,
  policy: "b".repeat(64),
  acknowledgement: "I understand Full access auto-approves supported actions.",
  access: "scoped",
  judge: { setting: "auto", model: "example/judge" },
  enabled: true,
  role: "owner",
  entityScopeCount: 3,
  services: ["light.turn_off", "light.turn_on"],
  blocked: false,
  unresolved: [],
  invalidation: "",
};
const MODELS = {
  items: [
    { id: "example-model-1", name: "Example Model 1", provider: "offline" },
    { id: "example-model-2", name: "Example Model 2", provider: "offline" },
  ],
};
const todayCard = (id, extra = {}) => ({
  id,
  kind: "watcher",
  title: "Washer finished",
  body: "The washer has stopped.",
  created: NOW - 20 * MIN_MS,
  snoozedUntil: 0,
  source: { kind: "app", title: "Laundry", appId: "app_laundry" },
  values: [
    {
      label: "Washer",
      entityId: "sensor.washer_state",
      available: true,
      state: "idle",
      observedAt: NOW - 20 * MIN_MS,
    },
    {
      label: "Power",
      entityId: "sensor.washer_power",
      available: false,
      reason: "not_in_read_scope",
    },
  ],
  ...extra,
});
const SUGGESTIONS = [
  {
    id: "s1",
    hash: HASH,
    kind: "memory",
    created: NOW - 30 * MIN_MS,
    snoozedUntil: 0,
    conversationTitle: "Study lamp",
    status: "open",
    memory: { text: "The study fan is called Breezy.", scope: "private" },
    reason: "You mentioned it twice.",
  },
  {
    id: "s2",
    hash: HASH,
    kind: "app_change",
    created: NOW - 40 * MIN_MS,
    snoozedUntil: 0,
    conversationTitle: "Laundry",
    status: "open",
    currentVersion: 2,
    app: {
      appId: "app_laundry",
      title: "Laundry",
      summary: "Add a power chart",
      baseVersion: 2,
      diff: { added: ["chart"], entitiesAdded: ["sensor.washer_power"] },
      patch: [{ op: "add", path: "/elements/chart", value: { type: "Note" } }],
    },
  },
  {
    id: "s3",
    hash: HASH,
    kind: "app_change",
    created: NOW - 50 * MIN_MS,
    snoozedUntil: 0,
    conversationTitle: "Laundry",
    status: "conflict",
    currentVersion: 3,
    conflict: { code: "version_conflict", currentVersion: 3 },
    app: {
      appId: "app_laundry",
      title: "Laundry",
      summary: "Rename a tile",
      baseVersion: 2,
      diff: { changed: ["washer"] },
      patch: [{ op: "replace", path: "/title", value: "Washer" }],
    },
  },
  {
    id: "s4",
    hash: HASH,
    kind: "code",
    created: NOW - 60 * MIN_MS,
    snoozedUntil: 0,
    conversationTitle: "A private coding workspace",
    status: "open",
    code: {
      title: "Retry list reads",
      problem: "Reading a list failed with a timeout.",
      evidence: { tool: "list_read", errorCode: "timeout", count: 3 },
      proposal: "Add a bounded retry for read-only list reads.",
      securitySensitive: true,
    },
  },
  {
    id: "s5",
    hash: HASH,
    kind: "code",
    created: NOW - 70 * MIN_MS,
    snoozedUntil: 0,
    conversationTitle: "A private coding workspace",
    status: "open",
    code: {
      title: "Shorter summaries",
      problem: "Summaries are longer than needed.",
      evidence: { tool: "summary", errorCode: "too_long", count: 1 },
      proposal: "Trim the summary prompt.",
      securitySensitive: false,
    },
  },
];
const TODAY = {
  cards: [
    todayCard("c1"),
    todayCard("c2", {
      kind: "briefing",
      title: "Morning briefing",
      source: { kind: "briefing", title: "Laundry" },
      repeat: "hourly",
      late: true,
      scheduledFor: NOW - 3 * 3600000,
      summary: {
        text: "All quiet.",
        model: "example/summary",
        latencyMs: 900,
      },
    }),
  ],
  suggestions: { items: SUGGESTIONS, snoozed: 1 },
  lastSeen: NOW - 25 * MIN_MS,
  unread: 2,
  snoozed: 1,
  suppressed: 0,
};
const listControls = {
  add: { enabled: true, reason: "" },
  update: { enabled: true, reason: "" },
  remove: { enabled: true, reason: "" },
};
const LISTS = {
  blocked: false,
  lists: [
    {
      entityId: "todo.example_groceries",
      name: "Groceries",
      openCount: 2,
      doneCount: 1,
      available: true,
      readAt: NOW - MIN_MS,
      controls: listControls,
      items: [
        { uid: "u1", summary: "Oat milk", status: "needs_action" },
        { uid: "u2", summary: "Lemons", status: "needs_action" },
        { uid: "u3", summary: "Bread", status: "completed" },
      ],
    },
    {
      entityId: "todo.example_chores",
      name: "Chores",
      openCount: 0,
      doneCount: 0,
      available: true,
      readAt: NOW - MIN_MS,
      controls: listControls,
      items: [],
    },
  ],
};
const APPS = {
  items: [
    {
      id: "app_laundry",
      title: "Laundry",
      summary: "Washer at a glance",
      version: 2,
      pinned: true,
    },
    {
      id: "app_checklist",
      title: "Maintenance checklist",
      summary: "Seasonal chores",
      version: 1,
      pinned: false,
    },
  ],
};
const APP_DETAIL = {
  app: { id: "app_laundry", title: "Laundry", version: 2, pinned: true },
  observedAt: NOW - MIN_MS,
  needsRepair: true,
  repair: [{ path: "/elements/power", message: "Entity out of scope" }],
  spec: {
    summary: "Washer at a glance",
    root: "main",
    elements: {
      main: {
        type: "Stack",
        children: [
          "grid",
          "pill",
          "chart",
          "tabs",
          "fold",
          "loads",
          "note",
          "ask",
          "hall",
        ],
      },
      grid: {
        type: "Grid",
        props: { columns: 2 },
        children: ["washer", "power"],
      },
      washer: {
        type: "EntityTile",
        props: { entity: "sensor.washer_state", label: "Washer" },
      },
      power: {
        type: "EntityValue",
        props: { entity: "sensor.washer_power", label: "Power" },
      },
      pill: {
        type: "StatusPill",
        props: { entity: "sensor.washer_state", okStates: ["idle"] },
      },
      chart: {
        type: "HistoryChart",
        props: { entities: ["sensor.washer_power"], hours: 6 },
      },
      tabs: {
        type: "Tabs",
        props: { labels: ["Today", "Week"] },
        children: ["t1", "t2"],
      },
      t1: { type: "Text", props: { text: "Today", variant: "h2" } },
      t2: { type: "Text", props: { text: "This week" } },
      fold: {
        type: "Checklist",
        props: {
          stateKey: "fold",
          title: "Folding",
          items: ["Towels", "Shirts"],
        },
      },
      loads: {
        type: "Counter",
        props: { stateKey: "loads", label: "Loads", min: 0, max: 3 },
      },
      note: {
        type: "Note",
        props: { stateKey: "note", label: "Note", maxLength: 50 },
      },
      ask: {
        type: "AskButton",
        props: { label: "Explain the power draw", prompt: "Explain it" },
      },
      hall: {
        type: "ToggleAction",
        props: { entity: "light.example_lamp", label: "Study lamp" },
      },
    },
  },
  values: {
    "sensor.washer_state": {
      available: true,
      state: "idle",
      observedAt: NOW - MIN_MS,
      attributes: {},
    },
    "sensor.washer_power": { available: false, reason: "not_in_read_scope" },
    "light.example_lamp": {
      available: true,
      state: "off",
      observedAt: NOW - MIN_MS,
      attributes: { friendly_name: "Study lamp" },
    },
  },
  history: {
    chart: [
      {
        kind: "numeric",
        entityId: "sensor.washer_power",
        min: 0,
        max: 500,
        unit: "W",
        points: [
          [NOW - 5 * 3600000, 10],
          [NOW - 3 * 3600000, 500],
          [NOW - 3600000, 40],
        ],
      },
    ],
  },
  state: {
    fold: { kind: "checklist", checked: ["Towels"] },
    loads: { kind: "counter", value: 1 },
  },
  controls: {
    hall: { enabled: true, mode: "ask", reason: "Ask: you will review it." },
  },
  versions: [
    { version: 1, summary: "Created", by: "hearth", created: NOW - 86400000 },
    { version: 2, summary: "Added chart", by: "owner", created: NOW - 3600000 },
  ],
};
const MEMORY = {
  items: [
    {
      id: "m_1",
      text: "The study fan is called Breezy.",
      source: { kind: "owner" },
      updated: NOW - 3600000,
      inContext: true,
    },
    {
      id: "m_2",
      text: "Quiet hours start at 22:00.",
      source: { kind: "suggestion" },
      sourceTitle: "Study lamp",
      updated: NOW - 7200000,
      inContext: false,
    },
  ],
  usedBytes: 120,
  trimmed: 1,
  limits: { contextBytes: 4096 },
  household: {
    items: [
      {
        id: "h_1",
        text: "Guests may use the study.",
        mine: true,
        updated: NOW - 3600000,
        inContext: true,
      },
    ],
    usedBytes: 40,
    trimmed: 0,
    revision: 2,
    limits: { contextBytes: 4096 },
  },
};
const PROACTIVE = {
  watchersEnabled: true,
  checkEverySeconds: 60,
  briefings: {
    morning: {
      enabled: true,
      at: "07:30",
      source: { kind: "app", appId: "app_laundry" },
      summary: true,
    },
    evening: { enabled: false, at: "20:00", source: null, summary: false },
  },
  sources: {
    apps: [{ id: "app_laundry", title: "Laundry" }],
    canvases: [{ sessionId: 1, title: "Study at a glance" }],
  },
  watchers: [
    {
      id: "w1",
      title: "Washer finished",
      description: "When the washer goes idle",
      status: "active",
      source: { kind: "owner" },
    },
    {
      id: "w2",
      title: "Door left open",
      description: "Door open for 10 minutes",
      status: "repair",
      repair: "Entity out of scope",
      source: { kind: "app", title: "Laundry", appId: "app_laundry" },
    },
  ],
};
const INSIGHTS = {
  feedback: {
    up: 3,
    down: 1,
    retentionDays: 90,
    reasons: { too_long: 1 },
    models: { "example-model-1": { up: 3, down: 1 } },
    recent: [
      {
        at: NOW - 3600000,
        rating: "down",
        session: "Study lamp",
        reasons: ["too_long"],
      },
    ],
  },
  today: { created: 4, dismissed: 1, snoozed: 1, asked: 1, suppressed: 0 },
};
const PROFILE = {
  displayName: "Breezy fan",
  tone: "warm",
  language: "en",
  defaultModel: null,
  defaultThinking: null,
  revision: 1,
};
const PUSH = {
  available: true,
  enabled: true,
  revision: 1,
  targets: [
    { id: "t1", label: "Example phone", status: "active" },
    { id: "t2", label: "Spare phone", status: "proof" },
  ],
  candidates: [{ id: "k1", label: "Tablet" }],
  candidatesUnavailable: false,
};
const provider = (extra) => ({
  provider: "openai-codex",
  providerName: "ChatGPT / Codex subscription",
  configured: true,
  tokenExpires: NOW + 3600000,
  lastCheck: { at: NOW - 600000, ok: true },
  login: null,
  ...extra,
});
const AUTH = {
  items: [
    provider({}),
    provider({
      provider: "anthropic",
      providerName: "Claude subscription",
      configured: false,
      tokenExpires: 0,
      lastCheck: null,
    }),
  ],
};
const device = (entityId, room, fx, fy) => ({
  entityId,
  room,
  fx,
  fy,
  area: null,
  device: null,
  moved: false,
});
const STRUCTURE = {
  revision: 4,
  customized: true,
  migrated: false,
  grid: { cols: 16, rows: 10 },
  levels: [{ id: "l1", name: "Ground floor", y: 0 }],
  rooms: [
    {
      id: "study",
      name: "Study",
      x: 0,
      y: 1,
      w: 6,
      h: 5,
      floor: "carpet",
      level: "l1",
      area: "Study",
    },
    {
      id: "hall",
      name: "Hall",
      x: 6,
      y: 1,
      w: 4,
      h: 5,
      floor: "wood",
      level: "l1",
      area: "Hall",
    },
    {
      id: "kitchen",
      name: "Kitchen",
      x: 10,
      y: 1,
      w: 6,
      h: 5,
      floor: "tile",
      level: "l1",
      area: "Kitchen",
    },
    {
      id: "decor:garden",
      name: "Garden",
      x: 0,
      y: 6,
      w: 16,
      h: 3,
      floor: "grass",
      level: "l1",
      area: null,
      decor: true,
    },
  ],
  devices: [
    device("light.example_lamp", "study", 0.2, 0.3),
    device("switch.example_fan", "study", 0.8, 0.3),
    device("sensor.example_temperature", "study", 0.5, 0.8),
    device("light.example_hall", "hall", 0.5, 0.5),
    device("light.example_kitchen", "kitchen", 0.3, 0.4),
    device("sensor.example_door", "kitchen", 0.8, 0.5),
  ],
  character: { palette: 0, hat: "beanie" },
  pet: true,
  custom: null,
  draft: null,
};
const world = (name, state, kind, extra = {}) => ({
  name,
  state,
  unit: "",
  kind,
  available: true,
  anomaly: "",
  observedAt: NOW - MIN_MS,
  ...extra,
});
const WORLD_VALUES = {
  observedAt: NOW - MIN_MS,
  night: false,
  nightSource: "clock",
  mode: "ask",
  blocked: false,
  values: {
    "light.example_lamp": world("Study lamp", "on", "light"),
    "switch.example_fan": world("Breezy", "off", "switch"),
    "sensor.example_temperature": world("Study temperature", "21.4", "thermo", {
      unit: "°C",
    }),
    "light.example_hall": world("Hall light", "off", "light"),
    "light.example_kitchen": world("Kitchen light", "on", "light"),
    "sensor.example_door": world("Back door", "on", "door", {
      anomaly: "open_at_night",
    }),
  },
  controls: {
    "light.example_lamp": { enabled: true, mode: "ask", reason: "Ask" },
    "switch.example_fan": { enabled: true, mode: "ask", reason: "Ask" },
    "light.example_hall": { enabled: true, mode: "ask", reason: "Ask" },
    "light.example_kitchen": { enabled: true, mode: "ask", reason: "Ask" },
  },
};

function defaults() {
  return {
    bootstrap: {
      csrf: "synthetic-csrf",
      version: "0.0.0-test",
      provider: "offline",
      defaultThinkingLevel: "medium",
      model: "example-model-1",
      homePermissions: HOME_PERMISSIONS,
      assist: true,
      workspaceEnabled: true,
      role: "owner",
      inferenceReady: true,
    },
    sessions: [
      {
        id: 2,
        title: "A private coding workspace",
        kind: "workspace",
        created: NOW - 86400000,
      },
      { id: 1, title: "Study lamp", kind: "home", created: NOW - 3600000 },
    ],
    snapshot: {
      modelSelection: {
        model: { provider: "offline", modelId: "example-model-1" },
        thinkingLevel: "medium",
        revision: 1,
      },
      homePermissions: HOME_PERMISSIONS,
      homeCanvas: null,
      proposals: {},
      lastInput: null,
      imageInput: true,
      view: { conversation: { id: 1 }, entries: entriesChat(), docs: {} },
    },
    feedback: {
      items: {
        5: { rating: "up", reasons: [] },
        10: { rating: "down", reasons: ["too_long"] },
      },
    },
    models: MODELS,
    apps: APPS,
    app: APP_DETAIL,
    today: TODAY,
    lists: LISTS,
    proactive: PROACTIVE,
    memory: MEMORY,
    profile: PROFILE,
    push: PUSH,
    insights: INSIGHTS,
    assist: { enabled: true, satellites: 2, link: { published: true } },
    auth: AUTH,
    local: {
      endpoint: {
        url: "http://llm.example:11434",
        kindName: "Ollama",
        model: "example-model-1",
        models: ["example-model-1", "example-model-2"],
        authenticated: true,
      },
      test: {
        id: "t",
        url: "http://llm.example:11434",
        kindName: "Ollama",
        models: ["example-model-1", "example-model-2"],
        hidden: 1,
      },
    },
    world: STRUCTURE,
    worldValues: WORLD_VALUES,
    worldDraft: null,
    events: "open",
  };
}

// ------------------------------------------------------------- stub server
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; object-src 'none'; form-action 'self'";
// Stands in for Home Assistant's panel: a 56px toolbar above a framed Hearth.
const HOST_PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>host</title>
<style>html,body{margin:0;height:100%;background:#1c1c1c}body{display:flex;flex-direction:column}header{flex:0 0 56px}iframe{flex:1;border:0;width:100%}</style>
<header></header><iframe id="app" src="/index.html"></iframe>`;

function startServer(data) {
  const json = (res, status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const get = {
    "/api/bootstrap": () => data.bootstrap,
    "/api/sessions": () => ({ items: data.sessions }),
    "/api/models": () => data.models,
    "/api/apps": () => data.apps,
    "/api/today": () => data.today,
    "/api/lists": () => data.lists,
    "/api/proactive": () => data.proactive,
    "/api/memory": () => data.memory,
    "/api/profile": () => data.profile,
    "/api/approval-push": () => data.push,
    "/api/insights": () => data.insights,
    "/api/insights/export": () => ({ items: [{ rating: "up" }] }),
    "/api/assist": () => data.assist,
    "/api/auth/providers": () => data.auth,
    "/api/local/status": () => data.local,
    "/api/home-permissions": () => data.bootstrap.homePermissions,
    "/api/world": () => data.world,
    "/api/world/values": () => data.worldValues,
    "/api/world/draft": () => data.worldDraft,
  };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://stub.invalid").pathname;
    if (path === "/__host.html") {
      res.writeHead(200, { "content-type": MIME[".html"] });
      return res.end(HOST_PAGE);
    }
    if (path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "POST") {
        req.resume();
        // Responses that replace page state must keep their real shape.
        if (path.startsWith("/api/today/"))
          return json(res, 200, { ...data.today, unread: 0 });
        if (path.startsWith("/api/suggestions/"))
          return json(res, 200, { ...data.today, decision: { ok: true } });
        return json(res, 200, { ok: true });
      }
      const session =
        /^\/api\/sessions\/(\d+)\/(snapshot|events|feedback)$/.exec(path);
      if (session) {
        if (session[2] === "events") {
          if (data.events === "fail") return json(res, 500, { error: "down" });
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
          });
          return res.write(": open\n\n");
        }
        if (session[2] === "feedback") return json(res, 200, data.feedback);
        return json(res, 200, data.snapshot);
      }
      if (/^\/api\/sessions\/\d+\/images\//.test(path)) {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
      }
      if (/^\/api\/apps\/[^/]+$/.test(path)) return json(res, 200, data.app);
      if (path in get) return json(res, 200, get[path]());
      return json(res, 404, { error: "not_found" });
    }
    const rel = path === "/" ? "/index.html" : path;
    const file = normalize(join(publicDir, rel));
    if (
      !file.startsWith(publicDir + sep) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "content-security-policy": CSP,
      "cache-control": "no-store",
    });
    res.end(readFileSync(file));
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

// --------------------------------------------------------- in-page measuring
// Runs inside the page (or iframe). Returns undersized targets and the count
// of elements it could measure.
function measureInPage({ min, verbose, extension }) {
  const SELECTOR =
    'button, a, [role="button"], [role="tab"], [role="switch"], [role="menuitem"], input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  const describe = (el) => {
    const label =
      el.getAttribute("aria-label") ||
      (el.textContent || el.value || el.placeholder || "")
        .trim()
        .replace(/\s+/g, " ");
    const own =
      el.tagName.toLowerCase() +
      (el.id ? `#${el.id}` : "") +
      [...el.classList].map((c) => `.${c}`).join("");
    let context = "";
    for (
      let p = el.parentElement;
      p && p !== document.body;
      p = p.parentElement
    ) {
      if (p.id) {
        context = `#${p.id} `;
        break;
      }
    }
    return { selector: `${context}${own}`, label: label.slice(0, 40) };
  };
  const hits = (el, x, y) => {
    const found = document.elementFromPoint(x, y);
    if (!found) return false;
    if (el === found || el.contains(found)) return true;
    // A control inside a <label> is activated by tapping the label.
    const label = el.closest("label");
    return (
      !!label &&
      (label === found || label.contains(found)) &&
      /^(checkbox|radio)$/.test(el.type || "")
    );
  };
  const run = (el, x, y, dx, dy, cap) => {
    let n = 0;
    while (n < cap && hits(el, x + dx * (n + 1), y + dy * (n + 1))) n++;
    return n;
  };
  const failures = [];
  const skipped = [];
  const all = [];
  const ids = [];
  const seen = new Set();
  let measured = 0;
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (el.closest("[hidden], [inert]") || el.type === "file") continue;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    if (
      r.width === 0 ||
      r.height === 0 ||
      getComputedStyle(el).visibility === "hidden"
    )
      continue;
    if (el.closest(".sr-only") && !el.closest("label, button, a")) continue;
    // A point inside the visible rectangle that actually reaches the element.
    let point = null;
    for (const fx of [0.5, 0.25, 0.75, 0.1, 0.9])
      for (const fy of [0.5, 0.25, 0.75, 0.1, 0.9]) {
        const x = Math.floor(r.left + r.width * fx);
        const y = Math.floor(r.top + r.height * fy);
        if (
          !point &&
          x >= 0 &&
          y >= 0 &&
          x < innerWidth &&
          y < innerHeight &&
          hits(el, x, y)
        )
          point = { x, y };
      }
    const info = describe(el);
    if (!point) {
      if (verbose)
        skipped.push({ ...info, why: "not reachable (covered or off-screen)" });
      continue;
    }
    measured++;
    if (el.id) ids.push(el.id);
    const cap = 200;
    const width =
      1 +
      run(el, point.x, point.y, -1, 0, cap) +
      run(el, point.x, point.y, 1, 0, cap);
    const height =
      1 +
      run(el, point.x, point.y, 0, -1, cap) +
      run(el, point.x, point.y, 0, 1, cap);
    // A checkbox/radio is tapped through its label, so the label's box counts.
    const label = /^(checkbox|radio)$/.test(el.type || "")
      ? el.closest("label")
      : null;
    const b = (label ?? el).getBoundingClientRect();
    const boxW = Math.round(b.width * 10) / 10;
    const boxH = Math.round(b.height * 10) / 10;
    const extended = extension.some((entry) => info.selector.includes(entry));
    const boxBad = !extended && (boxW < min - 0.05 || boxH < min - 0.05);
    let hitBad = width < min || height < min;
    if (hitBad && !boxBad) {
      // A full-size box that a sideways scroller (a panned strip, an overflow
      // row) clips is still a full-size target: the owner pans to reach it.
      let l = r.left,
        t = r.top,
        rt = r.right,
        bt = r.bottom;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const style = getComputedStyle(p);
        if (style.overflowX === "visible" && style.overflowY === "visible")
          continue;
        const c = p.getBoundingClientRect();
        l = Math.max(l, c.left);
        t = Math.max(t, c.top);
        rt = Math.min(rt, c.right);
        bt = Math.min(bt, c.bottom);
      }
      // Only sideways clipping is forgiven (a panned strip or a row that
      // scrolls); an overhang clipped on top or bottom is a real bug.
      const clipX = rt - l < r.width - 0.5;
      const clipY = bt - t < r.height - 0.5;
      if (clipX && !clipY) {
        if (verbose)
          skipped.push({
            ...info,
            why: "clipped by a scroller; box is full size",
          });
        hitBad = false;
      }
    }
    if (verbose) all.push({ ...info, width, height, box: `${boxW}x${boxH}` });
    if (boxBad || hitBad)
      failures.push({
        ...info,
        width,
        height,
        box: `${boxW}x${boxH}`,
        why: hitBad ? "hit area" : "box",
      });
  }
  return { failures, skipped, measured, all, ids };
}

// ------------------------------------------------------------------ scenes
// Every scene prepares synthetic data (`data`), then drives the UI (`run`).
// `core` scenes also run in the embedded and safe-area layouts.
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const tap = async (f, selector, index = 0) => {
  const target = f.locator(selector).nth(index);
  await target.waitFor({ state: "visible", timeout: 5000 });
  await target.tap({ timeout: 5000 });
  await sleep(120);
};
const drawer = (f) => tap(f, "#drawer-toggle");
const viaDrawer = async (f, row) => {
  await drawer(f);
  await tap(f, row);
};
const settingsRow = (row) => async (f) => {
  await viaDrawer(f, "#settings-row");
  await tap(f, row);
};
const proposalsSnapshot = (data, proposals) => {
  data.snapshot = { ...data.snapshot, proposals };
};
const SCENES = [
  {
    name: "welcome",
    core: true,
    data: (d) => {
      d.sessions = [];
      d.apps = {
        items: APPS.items.map((a) => ({ ...a, pinned: true })),
      };
    },
  },
  {
    name: "welcome-no-apps",
    data: (d) => {
      d.sessions = [];
      d.apps = { items: [] };
    },
    run: (f) => viaDrawer(f, "#apps-row"),
  },
  {
    name: "chat",
    core: true,
    data: (d) => {
      d.snapshot.homeCanvas = CANVAS;
      d.apps = APPS;
    },
  },
  {
    name: "chat-proposals",
    core: true,
    data: (d) => {
      d.snapshot.view.entries = d.snapshot.view.entries.slice(0, 1);
      proposalsSnapshot(d, PROPOSALS);
    },
  },
  {
    // Exact action cards inline after the tool call that filed them: open
    // pending/unknown cards, a collapsed receipt opened by a tap.
    name: "chat-inline-proposals",
    core: true,
    data: (d) => {
      const inline = Object.fromEntries(
        Object.entries(PROPOSALS).map(([id, p]) => [id, { ...p, id }]),
      );
      d.snapshot.view.entries = [
        ...d.snapshot.view.entries.slice(0, 1),
        {
          id: 2,
          model: [
            {
              role: "assistant",
              stopReason: "toolUse",
              content: Object.keys(inline).map((id) => ({
                type: "toolCall",
                id: `call-${id}`,
                name: "ha_call_service",
                arguments: {},
              })),
            },
          ],
        },
        ...Object.keys(inline).map((id, i) => ({
          id: 3 + i,
          model: [
            {
              role: "toolResult",
              toolCallId: `call-${id}`,
              toolName: "ha_call_service",
              isError: false,
              content: text("{}"),
              details: { proposalId: id },
            },
          ],
        })),
        {
          id: 20,
          model: [
            { role: "assistant", content: text("Done."), stopReason: "stop" },
          ],
        },
      ];
      proposalsSnapshot(d, inline);
    },
    run: (f) => tap(f, "[data-proposal-id='p3'] .proposal-inline-summary"),
  },
  {
    name: "chat-canvas-open",
    data: (d) => {
      d.snapshot.homeCanvas = CANVAS;
    },
    run: (f) => tap(f, "#canvas-toggle"),
  },
  {
    name: "chat-feedback-open",
    data: (d) => {
      d.feedback = { items: {} };
    },
    run: async (f) => {
      await tap(f, ".feedback-thumb[aria-label='Not helpful']", 0);
    },
  },
  {
    name: "chat-activity-open",
    run: async (f) => {
      await tap(f, ".activity-summary");
      await tap(f, ".tool-result-more");
    },
  },
  {
    name: "chat-composer",
    core: true,
    run: async (f) => {
      await f.locator("#attach-input").setInputFiles([
        { name: "plan.png", mimeType: "image/png", buffer: PNG },
        { name: "plan2.png", mimeType: "image/png", buffer: PNG },
      ]);
      await f
        .locator("#attachments .attachment")
        .first()
        .waitFor({ timeout: 5000 });
      await f.locator("#message").fill("Hello");
    },
  },
  {
    name: "chat-busy",
    data: (d) => {
      d.snapshot.view.docs = {
        "pi.live": {
          run: { id: 1 },
          tools: [{ name: "ha_read_state", status: "running" }],
        },
        "pi.inbox": {
          items: [
            {
              id: 2,
              mode: "followUp",
              content: [{ type: "text", text: "Also check the hallway" }],
            },
          ],
        },
      };
    },
    // A follow-up typed while Hearth answers: Stop and Send side by side.
    run: (f) => f.locator("#message").fill("And the porch"),
  },
  {
    name: "chat-retry-saved",
    pre: (page) =>
      page.addInitScript(() => {
        sessionStorage.setItem(
          "hearth:pending:1",
          // A definite refusal: Retry, Discard and Start a new chat.
          JSON.stringify({
            requestId: "r1",
            content: "Unsent message",
            refused: "input_limit_create_session",
          }),
        );
      }),
  },
  {
    name: "chat-reconnecting",
    data: (d) => {
      d.events = "fail";
    },
    run: async (f) => {
      await f
        .locator("#connection .connection-retry")
        .waitFor({ timeout: 8000 });
    },
  },
  {
    name: "chat-scroll-pill",
    run: async (f) => {
      await f.evaluate(() => {
        document.getElementById("scroll-pill").hidden = false;
      });
    },
  },
  {
    name: "chat-workspace",
    run: async (f) => {
      await drawer(f);
      await tap(f, "#sessions .session", 1);
    },
  },
  {
    name: "model-dialog",
    core: true,
    run: async (f) => {
      await tap(f, "#model-chip");
      await f.evaluate(() => {
        document.querySelector("#model-dialog details").open = true;
      });
    },
  },
  { name: "permissions-dialog", run: (f) => tap(f, "#permissions-toggle") },
  {
    name: "permissions-dialog-read-only",
    data: (d) => {
      d.bootstrap.homePermissions = {
        ...HOME_PERMISSIONS,
        effectiveMode: "read-only",
        blocked: true,
        unresolved: [{ sessionId: 1, id: 4, status: "unknown" }],
      };
    },
    run: (f) => tap(f, "#permissions-toggle"),
  },
  { name: "drawer", core: true, run: drawer },
  {
    name: "drawer-menu",
    run: async (f) => {
      await drawer(f);
      await tap(f, ".session-menu-toggle");
    },
  },
  {
    name: "settings",
    core: true,
    run: (f) => viaDrawer(f, "#settings-row"),
  },
  { name: "you", core: true, run: settingsRow("#you-row") },
  { name: "about", run: settingsRow("#settings-about-row") },
  { name: "account", core: true, run: settingsRow("#account") },
  {
    name: "account-device-code",
    data: (d) => {
      d.auth = {
        items: [
          provider({
            configured: false,
            login: {
              id: "l1",
              state: "waiting",
              method: "device_code",
              userCode: "ABCD-1234",
              url: "https://auth.example/device",
            },
          }),
        ],
      };
    },
    run: settingsRow("#account"),
  },
  {
    name: "account-select-method",
    data: (d) => {
      d.auth = {
        items: [
          provider({
            configured: false,
            login: {
              id: "l1",
              state: "waiting",
              prompt: {
                type: "select",
                message: "Choose how to sign in",
                options: [
                  {
                    id: "browser",
                    label: "Browser",
                    description: "Paste a URL",
                  },
                  { id: "device_code", label: "Device code" },
                ],
              },
            },
          }),
        ],
      };
    },
    run: settingsRow("#account"),
  },
  {
    name: "account-manual-code",
    data: (d) => {
      d.auth = {
        items: [
          provider({
            configured: false,
            login: {
              id: "l1",
              state: "waiting",
              url: "https://auth.example/authorize",
              prompt: {
                type: "manual_code",
                message: "Paste the final redirect URL",
              },
            },
          }),
        ],
      };
    },
    run: settingsRow("#account"),
  },
  {
    name: "account-local",
    data: (d) => {
      d.bootstrap.provider = "local";
    },
    run: settingsRow("#account"),
  },
  {
    name: "local-endpoint",
    data: (d) => {
      d.bootstrap.provider = "local";
    },
    run: async (f) => {
      await settingsRow("#account")(f);
      await tap(f, "#open-local");
    },
  },
  { name: "memory", core: true, run: settingsRow("#memory-row") },
  {
    name: "memory-editing",
    run: async (f) => {
      await settingsRow("#memory-row")(f);
      await tap(f, "#memory-body .today-actions button", 0);
    },
  },
  {
    name: "proactive",
    run: async (f) => {
      await settingsRow("#proactive-row")(f);
      await f.evaluate(() => {
        document.getElementById("watcher-add-details").open = true;
      });
    },
  },
  {
    name: "insights",
    run: async (f) => {
      await settingsRow("#settings-insights-row")(f);
      await tap(f, "#insights-export-button");
    },
  },
  {
    name: "today",
    core: true,
    run: async (f) => {
      await viaDrawer(f, "#today-row");
      await f.locator(".list-header").first().waitFor({ timeout: 5000 });
    },
  },
  {
    name: "today-expanded",
    run: async (f) => {
      await viaDrawer(f, "#today-row");
      await tap(f, ".list-header", 0);
      await tap(f, ".list-more", 0);
      await tap(f, ".today-actions button[aria-expanded]", 0);
      await tap(
        f,
        ".suggestion .today-actions button[aria-label='Edit memory suggestion']",
      );
      await f.evaluate(() => {
        for (const d of document.querySelectorAll("#today-list details"))
          d.open = true;
      });
    },
  },
  {
    name: "today-list-rename-and-full",
    run: async (f) => {
      await viaDrawer(f, "#today-row");
      await tap(f, ".list-header", 0);
      await tap(f, ".list-more", 0);
      await tap(f, ".list-menu button", 0);
    },
  },
  {
    name: "today-empty",
    data: (d) => {
      d.today = {
        cards: [],
        suggestions: { items: [], snoozed: 0 },
        lastSeen: NOW,
        unread: 0,
        snoozed: 2,
        suppressed: 1,
      };
      d.lists = { blocked: true, lists: [] };
    },
    run: (f) => viaDrawer(f, "#today-row"),
  },
  { name: "apps", core: true, run: (f) => viaDrawer(f, "#apps-row") },
  {
    name: "app-view",
    core: true,
    run: async (f) => {
      await viaDrawer(f, "#apps-row");
      await tap(f, ".app-card-open", 0);
      await f.locator(".app-tree").waitFor({ timeout: 5000 });
      await f.evaluate(() => {
        document.getElementById("app-more").open = true;
      });
    },
  },
  {
    name: "app-approval",
    run: async (f) => {
      // The same exact-approval card the app and Home World controls open.
      await f.evaluate(async (pending) => {
        const { renderProposals } = await import("./render.js");
        renderProposals(
          document.getElementById("app-approval-card"),
          { p1: pending },
          () => {},
          true,
        );
        document.getElementById("app-approval").showModal();
      }, PROPOSALS.p1);
    },
  },
  {
    name: "world-strip",
    core: true,
    run: async (f) => {
      await f.locator(".amb-chip").first().waitFor({ timeout: 5000 });
      await tap(f, ".amb-chip");
    },
  },
  {
    name: "world-map",
    core: true,
    run: async (f) => {
      await settingsRow("#open-world")(f).catch(async () => {
        await viaDrawer(f, "#settings-row");
        await tap(f, "#open-world");
      });
      await f.locator(".wh-device").first().waitFor({ timeout: 5000 });
    },
  },
  {
    name: "world-edit",
    run: async (f) => {
      await viaDrawer(f, "#settings-row");
      await tap(f, "#open-world");
      await f.locator(".wh-device").first().waitFor({ timeout: 5000 });
      await tap(f, ".wh-tool", 1);
    },
  },
  {
    name: "world-list",
    run: async (f) => {
      await viaDrawer(f, "#settings-row");
      await tap(f, "#open-world");
      await f.locator(".wh-device").first().waitFor({ timeout: 5000 });
      await tap(f, ".wh-tool", 0);
    },
  },
  {
    name: "world-preview",
    data: (d) => {
      const draft = {
        id: "d1",
        rooms: 4,
        decor: 1,
        cols: 16,
        rows: 10,
        note: "From your plan.",
      };
      d.world = { ...STRUCTURE, draft };
      d.worldDraft = { preview: true, draft, ...STRUCTURE, revision: 4 };
    },
    run: async (f) => {
      await viaDrawer(f, "#settings-row");
      await tap(f, "#open-world");
      await f
        .locator(".wh-banner-button:visible")
        .first()
        .waitFor({ timeout: 5000 });
      await tap(f, ".wh-banner-button:visible", 0);
    },
  },
];

// ------------------------------------------------------------------ driver
const key = (f) => `${f.selector}|${f.label}`;
async function runScene({ browser, scene, size, layout }) {
  const data = defaults();
  scene.data?.(data);
  const { server, origin } = await startServer(data);
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark",
  });
  const page = await context.newPage();
  const problems = [];
  page.on("console", (m) => {
    if (/Content Security Policy|violates/i.test(m.text()))
      problems.push(m.text());
  });
  page.on("pageerror", (e) =>
    problems.push(`pageerror: ${verbose ? e.stack : e.message}`),
  );
  page.on("dialog", (d) => void d.dismiss());
  try {
    if (layout === "safe-area") {
      const session = await context.newCDPSession(page);
      await session
        .send("Emulation.setSafeAreaInsetsOverride", {
          insets: { top: 47, bottom: 34, left: 0, right: 0 },
        })
        .catch(() => problems.push("safe-area emulation unavailable"));
    }
    await scene.pre?.(page);
    let f;
    if (layout === "embedded") {
      await page.goto(`${origin}/__host.html`);
      f = await (await page.waitForSelector("#app")).contentFrame();
    } else {
      await page.goto(`${origin}/`);
      f = page.mainFrame();
    }
    await f
      .waitForFunction(
        () =>
          (document.getElementById("connection")?.hidden !== undefined &&
            document.getElementById("model-chip")?.textContent !==
              "Choose a session") ||
          document.getElementById("sessions")?.children.length === 0,
        null,
        { timeout: 8000 },
      )
      .catch(() => {});
    await sleep(500);
    if (
      layout === "embedded" &&
      !(await f.evaluate(() =>
        document.documentElement.classList.contains("embedded"),
      ))
    )
      problems.push("embedded class missing");
    await scene.run?.(f);
    await sleep(250);
    const result = await f.evaluate(measureInPage, {
      min: MIN,
      verbose,
      extension: HIT_AREA_EXTENSION,
    });
    if (shotsDir) {
      mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({
        path: join(shotsDir, `${scene.name}-${layout}-${size.width}.png`),
      });
    }
    return { ...result, problems };
  } catch (error) {
    return {
      failures: [],
      skipped: [],
      measured: 0,
      problems,
      error: `${error.message}`.split("\n")[0],
    };
  } finally {
    await context.close();
    server.close();
  }
}

async function main() {
  const { chromium } = await loadPlaywright();
  if (flag("list")) {
    for (const scene of SCENES)
      console.log(`${scene.core ? "core " : "     "}${scene.name}`);
    return 0;
  }
  const browser = await chromium.launch({ executablePath: chromePath() });
  const jobs = [];
  for (const size of WIDTHS) {
    if (only.width && String(size.width) !== only.width) continue;
    for (const layout of LAYOUTS) {
      if (only.layout && layout !== only.layout) continue;
      for (const scene of SCENES) {
        if (only.scene && scene.name !== only.scene) continue;
        if (layout !== "standalone" && !scene.core && !only.scene) continue;
        jobs.push({ scene, size, layout });
      }
    }
  }
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      results.push({ ...job, ...(await runScene({ browser, ...job })) });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  await browser.close();

  const grouped = new Map();
  let errors = 0;
  let measured = 0;
  for (const r of results) {
    measured += r.measured;
    if (r.error) {
      errors++;
      console.error(
        `scene error: ${r.scene.name} ${r.layout} ${r.size.width}: ${r.error}`,
      );
    }
    for (const p of r.problems) {
      errors++;
      console.error(
        `problem: ${r.scene.name} ${r.layout} ${r.size.width}: ${p}`,
      );
    }
    if (verbose && flag("all"))
      for (const a of r.all)
        console.log(
          `  ${r.scene.name} ${a.selector} "${a.label}" box ${a.box} hit ${a.width}x${a.height}`,
        );
    if (verbose)
      for (const s of r.skipped)
        console.log(
          `  skipped ${r.scene.name}: ${s.selector} "${s.label}" ${s.why}`,
        );
    for (const failure of r.failures) {
      const k = key(failure);
      const entry = grouped.get(k) ?? { failure, views: [] };
      entry.views.push(
        `${r.scene.name}/${r.layout}/${r.size.width}: box ${failure.box}, hit ${failure.width}x${failure.height}`,
      );
      grouped.set(k, entry);
    }
  }
  // Every control in index.html must have been measured in some scene, so a
  // new button cannot slip in without a scene that shows it.
  const reached = new Set(results.flatMap((r) => r.ids ?? []));
  const html = readFileSync(join(publicDir, "index.html"), "utf8");
  const unmeasured = [
    ...html.matchAll(
      /<(?:button|a|input|select|textarea|summary)\b[^>]*?\bid="([^"]+)"[^>]*>/g,
    ),
  ]
    .filter((m) => !/type="file"/.test(m[0]))
    .map((m) => m[1])
    .filter((id) => !reached.has(id) && !NOT_REACHABLE.includes(id));
  const complete =
    !only.scene &&
    !only.width &&
    (!only.layout || only.layout === "standalone");
  if (complete && unmeasured.length) {
    errors++;
    console.error(
      `controls in index.html never measured by any scene: ${unmeasured.join(", ")}`,
    );
  }
  const allowed = (f) => ALLOWLIST.some((a) => f.selector.includes(a.selector));
  const remaining = [...grouped.values()].filter((e) => !allowed(e.failure));
  remaining.sort((a, b) =>
    a.failure.selector.localeCompare(b.failure.selector),
  );
  for (const { failure, views } of remaining) {
    console.log(
      `${failure.selector} "${failure.label}" box ${failure.box}, hit ${failure.width}x${failure.height}`,
    );
    for (const view of verbose ? views : views.slice(0, 3))
      console.log(`    ${view}`);
    if (!verbose && views.length > 3)
      console.log(`    … ${views.length - 3} more views`);
  }
  console.log(
    `\n${jobs.length} scene runs, ${measured} targets measured, ${remaining.length} undersized (< ${MIN}x${MIN}), ${errors} problems.`,
  );
  return remaining.length || errors ? 1 : 0;
}
main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error.message);
    process.exit(2);
  },
);
