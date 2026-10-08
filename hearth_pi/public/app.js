import {
  node,
  renderMessages,
  renderProposals,
  renderCanvas,
} from "./render.js";
import {
  renderApp,
  renderAppHistory,
  renderAppList,
  renderAppResult,
  renderPinnedApps,
  timeOf,
} from "./apps.js";
import {
  askPrompt,
  renderFeedback,
  renderInsights,
  renderMemory,
  renderProactiveSettings,
  renderToday,
} from "./today.js";
const $ = (id) => document.getElementById(id);
// Home Assistant shows Ingress panels in an iframe below its own toolbar;
// the CSS ignores phone safe-area insets there (see html.embedded).
try {
  if (window.self !== window.top)
    document.documentElement.classList.add("embedded");
} catch {
  document.documentElement.classList.add("embedded");
}
const base = new URL("./", window.location.href);
// Phones, the HA companion app and short landscape screens use a compact
// layout: the drawer becomes an off-canvas panel instead of a permanent
// sidebar, and secondary panels open as sheets instead of staying inline.
const COMPACT_QUERY = "(max-width: 720px), (max-height: 560px)";
const compact = () => !!window.matchMedia?.(COMPACT_QUERY).matches;
// Short, human labels for OAuth auth providers. Unknown ids fall back to
// their raw provider string so a new provider never renders as blank.
const AUTH_PROVIDER_LABEL = { "openai-codex": "ChatGPT", anthropic: "Claude" };
const THINKING_LABEL = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};
let csrf = "",
  messageSignature = "",
  selected = null,
  stream = null,
  busy = false,
  actionSignature = "",
  canvasSignature = "",
  canvasOpen = !compact(),
  sending = false,
  inferenceReady = true,
  selectedKind = "home",
  homeSafety = "Read-only · actions disabled",
  permissions = null,
  loginId = "",
  provider = "",
  localTestId = "",
  accountTimer = null,
  modelChoices = [],
  defaultThinkingLevel = "off",
  modelSelection = null,
  modelDraftDirty = false,
  applyingModel = false,
  authProviders = [],
  accountStatuses = new Map(),
  activeAuthProvider = "",
  openSessionMenu = "",
  apps = [],
  openAppId = null,
  appData = null,
  appUi = { tabs: new Map() },
  transcriptEmpty = true,
  appResultCount = -1,
  todayData = null,
  todayUi = { editing: null },
  sessionUsesApp = false,
  suggestionResultCount = -1,
  memoryData = null,
  memoryUi = { editing: null, draft: "" },
  feedbackSession = null,
  feedbackItems = {},
  feedbackRows = new Map(),
  feedbackUi = new Map(),
  permissionModeLabel = "Read-only",
  accountSummaryText = "Account";
const feedback = (value) => {
  $("feedback").textContent = value;
};
// The Settings drawer row shows one compact status line combining Home
// permissions and Account, e.g. "Full access \u00b7 ChatGPT \u2713 \u00b7 Claude \u2713".
function paintSettingsSummary() {
  $("settings-summary").textContent =
    `${permissionModeLabel} \u00b7 ${accountSummaryText}`;
}
function setConnection(text) {
  $("connection").textContent = text;
  $("connection").hidden = text === "Connected";
}
async function api(path, payload) {
  const response = await fetch(new URL(`api/${path}`, base), {
    credentials: "same-origin",
    ...(payload === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Hearth-CSRF": csrf,
          },
          body: JSON.stringify(payload),
        }),
  });
  const value = await response.json();
  if (!response.ok) {
    if (value.error === "csrf_rejected") {
      await bootstrap();
      throw new Error(
        "Browser protection refreshed. Retry your saved request explicitly.",
      );
    }
    throw new Error(value.error ?? "Request failed");
  }
  return value;
}
// The default auth provider when none is named explicitly: the OAuth
// provider matching the configured inference provider, else ChatGPT/Codex,
// which is always available.
function defaultAuthProvider() {
  return provider === "anthropic" ? "anthropic" : "openai-codex";
}
// GET /api/auth/providers lists every available OAuth provider in one call.
// Older servers do not have that route yet: fall back to the single default
// provider's existing GET /api/auth/status.
async function loadAuthProviders() {
  try {
    const { items } = await api("auth/providers");
    return items;
  } catch {
    try {
      return [await api("auth/status")];
    } catch {
      return [];
    }
  }
}
async function refreshAccountSummary() {
  const items = await loadAuthProviders();
  authProviders = items.map((i) => i.provider);
  accountStatuses = new Map(items.map((i) => [i.provider, i]));
  if (!authProviders.includes(activeAuthProvider))
    activeAuthProvider = authProviders[0] ?? "";
  accountSummaryText = items.length
    ? items
        .map(
          (i) =>
            `${AUTH_PROVIDER_LABEL[i.provider] ?? i.provider}${i.configured ? " ✓" : ""}`,
        )
        .join(" · ")
    : "Account";
  $("account-summary").textContent = accountSummaryText;
  paintSettingsSummary();
  renderAccountProviders();
}
function renderAccountProviders() {
  const fragment = document.createDocumentFragment();
  if (authProviders.length > 1) {
    for (const id of authProviders) {
      const status = accountStatuses.get(id);
      const card = node("div", "", "account-provider");
      const info = node("div", "", "account-provider-info");
      info.append(
        node("strong", status?.providerName ?? AUTH_PROVIDER_LABEL[id] ?? id),
        node(
          "span",
          status?.configured ? "Connected" : "Not signed in",
          "muted",
        ),
      );
      const manage = node(
        "button",
        id === activeAuthProvider ? "Managing" : "Manage",
      );
      manage.type = "button";
      manage.setAttribute("aria-current", String(id === activeAuthProvider));
      manage.addEventListener("click", () => {
        activeAuthProvider = id;
        renderAccountProviders();
        void refreshAccount();
      });
      card.append(info, manage);
      fragment.append(card);
    }
  }
  $("account-providers").replaceChildren(fragment);
  $("account-providers").hidden = authProviders.length <= 1;
}
async function bootstrap() {
  const status = await api("bootstrap");
  csrf = status.csrf;
  $("provider").textContent = status.provider;
  provider = status.provider;
  $("account-local").hidden = provider !== "local";
  $("about-version").textContent = status.version
    ? `Hearth Pi v${status.version}`
    : "Hearth Pi";
  $("about-provider").textContent = `Inference provider: ${status.provider}`;
  updatePermissions(status.homePermissions);
  inferenceReady = status.inferenceReady;
  defaultThinkingLevel = status.defaultThinkingLevel ?? "off";
  $("new-workspace").hidden = !status.workspaceEnabled;
  if (!activeAuthProvider) activeAuthProvider = defaultAuthProvider();
  await refreshAccountSummary();
  controls();
}
function updatePermissions(value) {
  if (!value) return;
  permissions = value;
  $("home-mode").value = value.effectiveMode;
  const modeLabel = value.blocked
    ? "Paused"
    : value.effectiveMode === "full"
      ? "Full access"
      : value.effectiveMode === "ask"
        ? "Ask"
        : "Read-only";
  $("permissions-mode").textContent = modeLabel;
  $("permissions-mode-row").textContent = modeLabel;
  permissionModeLabel = modeLabel;
  paintSettingsSummary();
  homeSafety = `Home permissions · ${value.effectiveMode === "full" ? "Full access / auto-approve" : value.effectiveMode === "ask" ? "Ask / exact review" : "Read-only"} · ${value.entityScopeCount} configured entities`;
  $("permission-summary").textContent =
    `${homeSafety}. Services: ${value.services.join(", ") || "none"}. ${value.invalidation || ""}${value.blocked ? ` Writes paused installation-wide for an unresolved outcome. Your receipts: ${value.unresolved.map((b) => `session ${b.sessionId}, action ${b.id} (${b.status})`).join("; ") || "another owner's receipt"}. Human reconciliation only; no retry.` : ""}`;
  for (const option of $("home-mode").options)
    option.disabled = !value.enabled && option.value !== "read-only";
}
async function setHomeMode(mode) {
  if (!permissions) return;
  const current = permissions;
  if (
    mode === "full" &&
    !window.confirm(
      `Enable Home Full access / auto-approve? ${current.acknowledgement}\n${current.entityScopeCount} exact configured entities; ${current.services.join(", ")}.\nPolicy: ${current.policy}\nRunning/old inputs are not elevated. Emergency Read-only cannot undo in-flight effects.`,
    )
  )
    return;
  try {
    updatePermissions(
      await api("home-permissions", {
        mode,
        revision: current.revision,
        policy: current.policy,
        ...(mode === "full"
          ? { acknowledgement: current.acknowledgement }
          : {}),
      }),
    );
    actionSignature = "";
    if (selected) snapshot(await api(`sessions/${selected}/snapshot`));
    controls();
    feedback(
      "Home permissions saved. Old actions were invalidated; in-flight effects cannot be undone.",
    );
  } catch (error) {
    feedback(error.message);
    updatePermissions(await api("home-permissions"));
    controls();
  }
}
$("save-home-mode").addEventListener("click", () => {
  void setHomeMode($("home-mode").value);
});
$("emergency-read-only").addEventListener("click", () => {
  void setHomeMode("read-only");
});
function pending() {
  try {
    return JSON.parse(
      sessionStorage.getItem(`hearth:pending:${selected}`) ?? "null",
    );
  } catch {
    return null;
  }
}
function controls() {
  const saved = pending();
  $("retry").hidden = !saved;
  $("safety").textContent =
    selectedKind === "workspace"
      ? "Isolated coding workspace · no HA or network access"
      : homeSafety;
  $("message").disabled = busy || !!saved || sending;
  const loginCommand = /^\/login(?:\s|$)/.test($("message").value.trim());
  $("send").disabled =
    $("message").disabled || ((!selected || !inferenceReady) && !loginCommand);
  $("stop").hidden = !busy;
  $("stop").disabled = !selected || !busy;
  $("send").hidden = busy;
  $("model-choice").disabled =
    !selected ||
    !modelSelection ||
    busy ||
    applyingModel ||
    !!saved ||
    sending ||
    !modelChoices.length;
  $("thinking-choice").disabled = $("model-choice").disabled;
  $("apply-model").disabled =
    $("model-choice").disabled ||
    ($("model-choice").value === modelSelection?.model?.modelId &&
      $("thinking-choice").value === modelSelection?.thinkingLevel);
  $("canvas-toggle").hidden = selectedKind === "workspace";
  // Collapsed means fully hidden, not an empty bordered box: there is
  // nothing useful to show until the chip reopens it.
  $("home-surface").hidden = selectedKind === "workspace" || !canvasOpen;
  $("canvas-toggle").setAttribute("aria-expanded", String(canvasOpen));
  for (const button of document.querySelectorAll(
    ".canvas-question, .home-starters button",
  ))
    button.disabled = $("send").disabled || selectedKind !== "home";
  forwardWorld();
}
// Home World (public/world/): loaded on demand by dynamic import so the chat
// is unaffected if it never loads. app.js owns every request the world makes
// (worldApi, toggleFromWorld) and the full-screen view switch; the world
// receives the snapshot already shown here, read-only.
let world = null,
  worldLoading = null,
  worldSnapshot = null;
const worldApi = {
  load: () => api("world"),
  values: () => api("world/values"),
  save: (body) => api("world/layout", body),
  reset: (body) => api("world/reset", body),
  migrate: (body) => api("world/migrate", body),
};
function worldInput() {
  return {
    snapshot: worldSnapshot,
    kind: selected ? selectedKind : "home",
    canDraft: !$("message").disabled && (!selected || selectedKind === "home"),
  };
}
function forwardWorld() {
  try {
    world?.update(worldInput());
  } catch {
    /* Home World must never break the chat. */
  }
}
function loadWorld() {
  worldLoading ??= (async () => {
    if (!document.querySelector("link[data-world-css]")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = new URL("world/world.css", base).href;
      link.dataset.worldCss = "";
      document.head.append(link);
    }
    const module = await import("./world/world.js");
    world = await module.mountWorld({
      api: worldApi,
      toggle: toggleFromWorld,
      ask: (prompt) => void draftFromApp(prompt, "Home World", "Home World"),
      showView: showWorldView,
      stripHost: $("world-strip"),
    });
    forwardWorld();
    return world;
  })().catch(() => {
    worldLoading = null;
    return null;
  });
  return worldLoading;
}
async function openWorld(options = {}) {
  const loaded = await loadWorld();
  if (loaded) loaded.openFull(options);
  else feedback("Home World could not load. Chat is unaffected.");
}
// The full-screen house replaces the conversation like an open app does.
function showWorldView(element) {
  document.querySelector("#main > .world-view")?.remove();
  if (element) {
    if (openAppId) {
      openAppId = null;
      appData = null;
      $("app-view").hidden = true;
    }
    $("main").append(element);
    if (compact() && document.body.classList.contains("drawer-open"))
      closeDrawer();
  }
  $("topbar").hidden = !!element;
  document.querySelector(".conversation").hidden = !!element;
}
// A world light/switch press goes through the same Home permissions broker
// as app ToggleActions; Ask shows the same exact approval card.
async function toggleFromWorld(entityId, onDecided) {
  try {
    const sessionId = await homeSessionFor("Home World", "Home World");
    const result = await api("world/actions", { entityId, sessionId });
    const p = result.proposal;
    if (p.status === "pending") {
      showActionApproval(sessionId, p, async (message) => onDecided(message));
      return "Review the exact action to continue. It is also listed in the Home World chat.";
    }
    if (p.status === "accepted")
      return `Home Assistant accepted ${p.action.service} for ${p.action.entityId}${result.readBack ? `; it now reads ${result.readBack.state} (as of ${timeOf(result.readBack.observedAt)})` : ""}. Acceptance is not physical verification.`;
    if (p.status === "unknown")
      return `Outcome unknown for ${p.action.service} ${p.action.entityId}. It will not be retried. Check the device, then record what you saw on the action card in the chat.`;
    return `Action ${p.status}. ${p.resolution || ""}`;
  } catch (error) {
    return appMessage(error, "Not sent");
  }
}
function draftQuestion(content) {
  if ($("message").disabled || selectedKind !== "home") return;
  $("message").value = content;
  fitComposer();
  $("message").focus();
  feedback(
    "Question drafted. Review and press Send; no request has been admitted yet.",
  );
}
const BUILD_VIEW_PROMPT =
  "Discover the exact HA entities you are allowed to read, then use ha_build_view to build a useful status canvas with sensible named sections. Use controller-read facts; do not invent entities/rooms or call services. If the scope is empty, explain that.";
$("build-view").addEventListener("click", () =>
  draftQuestion(BUILD_VIEW_PROMPT),
);
$("home-briefing").addEventListener("click", () =>
  draftQuestion(
    "Give me a concise home briefing from fresh reads of exact approved HA entities. Separate observations, uncertainties and a useful next step. Do not call services or start background monitoring.",
  ),
);
$("canvas-toggle").addEventListener("click", () => {
  canvasOpen = !canvasOpen;
  controls();
});
// Floating "New messages" pill: shown only while the user has scrolled up
// and new transcript content arrived without moving them; stick-to-bottom
// (below in snapshot()) still applies whenever they were already at bottom.
function setScrollPill(visible) {
  $("scroll-pill").hidden = !visible;
}
$("scroll-pill").addEventListener("click", () => {
  const area = $("scroll-area");
  area.scrollTop = area.scrollHeight;
  setScrollPill(false);
});
$("scroll-area").addEventListener("scroll", () => {
  const area = $("scroll-area");
  if (area.scrollHeight - area.scrollTop - area.clientHeight < 100)
    setScrollPill(false);
});
// Grow the composer with its content instead of reserving rows up front.
function fitComposer() {
  const box = $("message");
  if (!box.style) return;
  box.style.height = "auto";
  if (box.scrollHeight)
    box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
}
function snapshot(value) {
  const area = $("scroll-area"),
    atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
  updatePermissions(value.homePermissions);
  if (value.modelSelection) {
    if (
      modelDraftDirty &&
      modelSelection &&
      value.modelSelection.revision !== modelSelection.revision
    ) {
      modelDraftDirty = false;
      if (!applyingModel)
        feedback(
          "Model settings changed elsewhere. Your draft was discarded; review the active model before choosing again.",
        );
    }
    modelSelection = value.modelSelection;
    const active = modelSelection.model;
    $("active-model").textContent = active
      ? `Active: ${active.provider} / ${active.modelId} · thinking ${modelSelection.thinkingLevel}`
      : "Active model unavailable; ask the administrator";
    $("model-chip").textContent = active
      ? `${active.modelId} · ${THINKING_LABEL[modelSelection.thinkingLevel] ?? modelSelection.thinkingLevel}`
      : "Model unavailable";
    if (
      !modelDraftDirty ||
      !modelChoices.some((m) => m.id === $("model-choice").value)
    ) {
      $("model-choice").value = active?.modelId ?? "";
      $("thinking-choice").value = modelSelection.thinkingLevel ?? "off";
      modelDraftDirty = false;
    }
  }
  // Re-render the transcript only when it changed: a long conversation on a
  // phone otherwise rebuilds on every live event (jank, lost scroll/selection).
  const entries = value.view.entries ?? [];
  const nextMessageSignature = JSON.stringify([
    selected,
    entries.length,
    entries[entries.length - 1] ?? null,
    value.view.docs["pi.live"] ?? null,
  ]);
  const transcriptChanged = nextMessageSignature !== messageSignature;
  if (transcriptChanged) {
    messageSignature = nextMessageSignature;
    feedbackRows = new Map();
    const toolResults = entries
      .flatMap((e) => e.model ?? [])
      .filter((m) => m.role === "toolResult");
    // A chat that built or changed an app gets the 👎 "may suggest a fix" hint.
    const results = toolResults.filter((m) => APP_TOOL.test(m.toolName)).length;
    sessionUsesApp = results > 0;
    renderMessages($("messages"), value, appResultCard, feedbackFor);
    transcriptEmpty = entries.length === 0;
    renderPinned();
    // A new app_create/app_update result refreshes the Apps list and pins.
    if (results !== appResultCount) {
      if (appResultCount >= 0 && results > appResultCount) void loadApps();
      appResultCount = results;
    }
    // A new suggestion refreshes the Today badge.
    const suggested = toolResults.filter((m) =>
      SUGGEST_TOOL.test(m.toolName),
    ).length;
    if (suggested !== suggestionResultCount) {
      if (suggestionResultCount >= 0 && suggested > suggestionResultCount)
        void loadToday();
      suggestionResultCount = suggested;
    }
  }
  const canvas = selectedKind === "home" ? (value.homeCanvas ?? null) : null;
  const nextCanvasSignature = JSON.stringify(canvas);
  if (nextCanvasSignature !== canvasSignature) {
    canvasSignature = nextCanvasSignature;
    renderCanvas($("home-canvas"), canvas, draftQuestion);
  }
  const signature = JSON.stringify([
    value.proposals,
    permissions?.effectiveMode,
    permissions?.blocked,
  ]);
  if (signature !== actionSignature) {
    actionSignature = signature;
    renderProposals(
      $("approvals"),
      value.proposals,
      decide,
      permissions?.effectiveMode !== "read-only" && !permissions?.blocked,
    );
  }
  busy = !!value.view.docs["pi.live"]?.run;
  worldSnapshot = value;
  $("task-status").textContent = busy
    ? "Durable task in progress"
    : value.lastInput?.status === "unanswered"
      ? `Input stopped · ${value.lastInput.reason}`
      : "Committed · ready";
  const usage = Object.values(value.view.docs["pi.usage"]?.models ?? {}).reduce(
    (n, u) => n + u.totalTokens,
    0,
  );
  $("usage").textContent = usage
    ? `${usage.toLocaleString()} reported tokens · not a bill`
    : "No reported model usage";
  controls();
  if (atBottom) {
    area.scrollTop = area.scrollHeight;
    setScrollPill(false);
  } else if (transcriptChanged) {
    setScrollPill(true);
  }
}
// Compact relative time for the conversation list, Claude-app style.
function relativeTime(ms) {
  const diff = Date.now() - ms;
  const minute = 60000,
    hour = 3600000,
    day = 86400000;
  if (diff < minute) return "now";
  if (diff < hour) return `${Math.floor(diff / minute)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  if (diff < 2 * day) return "Yesterday";
  if (diff < 7 * day) return `${Math.floor(diff / day)}d`;
  return new Date(ms).toLocaleDateString();
}
function closeSessionMenus() {
  openSessionMenu = "";
  for (const menu of document.querySelectorAll(".session-menu"))
    menu.hidden = true;
  for (const toggle of document.querySelectorAll(".session-menu-toggle"))
    toggle.setAttribute("aria-expanded", "false");
}
async function listSessions() {
  const { items } = await api("sessions");
  const fragment = document.createDocumentFragment();
  for (const session of items.slice().reverse()) {
    const row = node("div", "", "session-row");
    const button = node("button", "", "session");
    button.append(
      node(
        "span",
        `${session.kind === "workspace" ? "⌘ " : "◈ "}${session.title}`,
        "session-title",
      ),
    );
    button.type = "button";
    if (Number.isFinite(session.created)) {
      const when = node("span", relativeTime(session.created), "session-time");
      when.title = `Created ${new Date(session.created).toLocaleString()}`;
      button.append(when);
    }
    button.setAttribute("aria-current", String(session.id === selected));
    button.addEventListener("click", () => {
      closeSessionMenus();
      closeApp();
      select(session);
      if (compact()) closeDrawer();
    });
    const menuWrap = node("div", "", "session-menu-wrap");
    const toggle = node("button", "⋯", "session-menu-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-haspopup", "true");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", `More for ${session.title}`);
    const menu = node("div", "", "session-menu");
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    const del = node("button", "Delete");
    del.type = "button";
    del.setAttribute("role", "menuitem");
    del.addEventListener("click", () => {
      closeSessionMenus();
      void deleteSession(session.id, session.title);
    });
    menu.append(del);
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const opening = openSessionMenu !== String(session.id);
      closeSessionMenus();
      if (opening) {
        openSessionMenu = String(session.id);
        menu.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
      }
    });
    menuWrap.append(toggle, menu);
    row.append(button, menuWrap);
    fragment.append(row);
  }
  $("sessions").replaceChildren(fragment);
  return items;
}
document.addEventListener("click", (event) => {
  if (!event.target.closest?.(".session-menu-wrap")) closeSessionMenus();
});
async function select(session) {
  stream?.close();
  selected = session.id;
  selectedKind = session.kind ?? "home";
  modelSelection = null;
  modelDraftDirty = false;
  $("active-model").textContent = "Loading session model…";
  $("model-chip").textContent = "Loading…";
  $("model-choice").value = "";
  $("thinking-choice").value = "off";
  actionSignature = "";
  canvasSignature = "";
  messageSignature = "";
  worldSnapshot = null;
  renderCanvas($("home-canvas"), null, draftQuestion);
  $("title").textContent = session.title;
  feedback("");
  controls();
  const id = selected;
  try {
    void loadFeedback(id);
    const state = await api(`sessions/${id}/snapshot`);
    if (selected !== id) return;
    snapshot(state);
    await listSessions();
    stream = new EventSource(new URL(`api/sessions/${id}/events`, base));
    stream.onopen = () => {
      if (selected === id) setConnection("Connected");
    };
    stream.addEventListener("snapshot", (event) => {
      if (selected === id) {
        try {
          snapshot(JSON.parse(event.data));
        } catch {
          feedback("Invalid snapshot; reconnect this session.");
          stream.close();
        }
      }
    });
    stream.onerror = () => {
      if (selected === id) setConnection("Reconnecting…");
    };
  } catch (error) {
    feedback(error.message);
  }
}
async function sendSaved() {
  const value = pending();
  if (!value || sending) return;
  sending = true;
  controls();
  const id = selected;
  try {
    await api(`sessions/${id}/inputs`, value);
    sessionStorage.removeItem(`hearth:pending:${id}`);
    if (selected === id) {
      $("message").value = "";
      fitComposer();
      feedback("Input durably admitted.");
    }
  } catch (error) {
    feedback(
      `Not acknowledged: ${error.message}. Your original request ID is saved for retry.`,
    );
  } finally {
    sending = false;
    controls();
    // Re-measure now that the textarea is enabled again: some browsers do
    // not reflow a disabled textarea's auto-grow height correctly.
    fitComposer();
  }
}
$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy || sending || pending()) return;
  const content = $("message").value.trim();
  if (!content) return;
  if (/^\/login\b/.test(content)) {
    const command = /^\/login(?:\s+(anthropic|openai-codex))?$/.exec(content);
    const loginProvider = command?.[1] ?? defaultAuthProvider();
    if (!command || !authProviders.includes(loginProvider)) {
      feedback(
        "That subscription provider is not available. Use /login with an available provider.",
      );
      return;
    }
    $("message").value = "";
    activeAuthProvider = loginProvider;
    openAccount();
    void startLogin();
    return;
  }
  if (!selected || !inferenceReady) return;
  try {
    sessionStorage.setItem(
      `hearth:pending:${selected}`,
      JSON.stringify({ requestId: crypto.randomUUID(), content }),
    );
    void sendSaved();
  } catch {
    feedback("Browser session storage unavailable; input was not sent.");
  }
});
$("message").addEventListener("input", () => {
  fitComposer();
  controls();
});
$("retry").addEventListener("click", () => {
  void sendSaved();
});
// Matches the server's own session-title bound (runtime.ts: text(title, 80)).
// Without this, an ordinary long title silently fails new-chat with a raw
// "invalid_request" error instead of creating a session.
const SESSION_TITLE_MAX = 80;
async function newSession(kind) {
  const typed = window.prompt(
    "Session title",
    kind === "workspace" ? "A private coding workspace" : "A thoughtful home",
  );
  const title = typed?.trim().slice(0, SESSION_TITLE_MAX);
  if (!title) return;
  try {
    const result = await api("sessions", {
      title,
      kind,
      requestId: crypto.randomUUID(),
    });
    await listSessions();
    closeApp();
    await select({ id: result.id, title, kind });
    await listSessions();
    if (compact()) closeDrawer();
  } catch (error) {
    feedback(error.message);
  }
}
$("new-session").addEventListener("click", () => {
  void newSession("home");
});
$("new-workspace").addEventListener("click", () => {
  void newSession("workspace");
});
$("new-chat-icon").addEventListener("click", () => {
  void newSession("home");
});
$("stop").addEventListener("click", async () => {
  try {
    await api(`sessions/${selected}/abort`, {});
    feedback(
      "Task stopped. Already dispatched external actions are not undone.",
    );
  } catch (error) {
    feedback(error.message);
  }
});
// Human-readable text for each distinct 409 reason the server refuses a
// delete with, so an open safety concern is never mistaken for a generic error.
const DELETE_REFUSALS = {
  delete_proposal_unresolved:
    "This session has an action awaiting approval or an unresolved outcome. Reject or resolve it first, then delete.",
  delete_task_running:
    "This session has a task in progress. Wait for it to finish, then delete.",
  delete_session_busy:
    "This session has an input that has not been answered yet. Wait for it to settle, then delete.",
  delete_workspace_blocked:
    "This workspace is paused after an uncertain operation and cannot be deleted until a human resolves it.",
};
function showWelcome() {
  selected = null;
  selectedKind = "home";
  modelSelection = null;
  modelDraftDirty = false;
  actionSignature = "";
  canvasSignature = "";
  messageSignature = "";
  busy = false;
  worldSnapshot = null;
  $("title").textContent = "A little warmth. A little more certainty.";
  $("safety").textContent = "Read-only by default";
  $("task-status").textContent = "Choose a session";
  $("usage").textContent = "No model usage yet";
  $("active-model").textContent = "Choose a session";
  $("model-chip").textContent = "Choose a session";
  $("messages").replaceChildren();
  $("approvals").replaceChildren();
  renderCanvas($("home-canvas"), null, draftQuestion);
  transcriptEmpty = true;
  renderPinned();
  controls();
}
async function deleteSession(id, title) {
  if (
    !window.confirm(
      `Delete "${title}"? This cannot be undone through the App. The stored transcript stays in the App's private data store and is not securely erased.`,
    )
  )
    return;
  try {
    await api(`sessions/${id}/delete`, { confirm: true });
    if (selected === id) {
      stream?.close();
      stream = null;
    }
    const items = await listSessions();
    if (selected !== id) return;
    const next = items[items.length - 1];
    if (next) await select(next);
    else showWelcome();
    await listSessions();
    feedback("Session deleted. The stored transcript is not securely erased.");
  } catch (error) {
    feedback(
      DELETE_REFUSALS[error.message] ?? `Not deleted: ${error.message}.`,
    );
  }
}
async function decide(proposal, decision) {
  let note = "";
  if (decision === "resolve") {
    note =
      window.prompt(
        "Record what you checked. This does not retry the action.",
        "",
      ) ?? "";
    if (!note) return;
  }
  const id = selected;
  try {
    feedback("Recording your decision…");
    await api(`sessions/${id}/actions`, {
      id: proposal.id,
      hash: proposal.hash,
      decision,
      ...(note ? { note } : {}),
    });
    if (selected === id) {
      snapshot(await api(`sessions/${id}/snapshot`));
      feedback("Decision recorded. See the authoritative action receipt.");
    }
  } catch (error) {
    feedback(error.message);
  }
}
let loginPromptSignature = "";
const when = (ms) => new Date(ms).toLocaleString();
// Pi offers openai-codex login via "browser" (needs pasting the localhost
// redirect URL) and "device_code" (shows a code, Pi polls, no paste needed).
// Device code is the smoother choice for Home Assistant / phones, so it is
// shown first and recommended here; unknown/other option ids keep Pi's order.
const LOGIN_METHOD_RANK = { device_code: 0, browser: 1 };
const LOGIN_METHOD_NOTE = {
  device_code: "Recommended for Home Assistant and phones",
  browser: "Requires pasting a redirect URL",
};
// Mirrors Pi's interactive /login: show whichever step Pi is waiting on.
function renderLoginPrompt(prompt) {
  const choice = prompt?.type === "select" ? prompt : null,
    signature = JSON.stringify(choice);
  $("login-choice").hidden = !choice;
  if (signature === loginPromptSignature) return;
  loginPromptSignature = signature;
  $("login-prompt").textContent = choice?.message ?? "";
  const options = [...(choice?.options ?? [])].sort(
    (a, b) => (LOGIN_METHOD_RANK[a.id] ?? 99) - (LOGIN_METHOD_RANK[b.id] ?? 99),
  );
  $("login-options").replaceChildren(
    ...options.map((option) => {
      const card = node("div", "", "login-option");
      const button = node("button", option.label);
      button.type = "button";
      if (option.description) button.title = option.description;
      button.addEventListener("click", async () => {
        try {
          await api("auth/answer", {
            id: loginId,
            value: option.id,
            provider: activeAuthProvider,
          });
          await refreshAccount();
        } catch (e) {
          $("account-status").textContent = e.message;
        }
      });
      card.append(button);
      const note = LOGIN_METHOD_NOTE[option.id];
      if (note)
        card.append(
          node(
            "span",
            note,
            option.id === "device_code"
              ? "login-recommended"
              : "login-option-note",
          ),
        );
      return card;
    }),
  );
}
async function refreshAccount() {
  if (!activeAuthProvider) activeAuthProvider = defaultAuthProvider();
  try {
    // GET /api/auth/providers (with its single-provider GET /api/auth/status
    // fallback) is the only source of per-provider status; it is re-fetched
    // here so the polled login prompt/code stay current for activeAuthProvider.
    await refreshAccountSummary();
    const status = accountStatuses.get(activeAuthProvider);
    if (!status) {
      $("account-status").textContent =
        "That subscription provider is not available.";
      return;
    }
    const login = status.login,
      prompt = login?.prompt;
    loginId = login?.id ?? "";
    const pending = !!login && ["starting", "waiting"].includes(login.state);
    const anthropic = status.provider === "anthropic";
    $("account-title").textContent = status.providerName;
    $("account-details").textContent = anthropic
      ? "Experimental Pi Anthropic OAuth with pi-anthropic-auth 3.4.2 compatibility. Credentials stay in the controller, never the coding workspace. Provider terms apply; third-party usage may incur extra per-token billing. Login does not guarantee included Claude plan usage."
      : "Official Pi OAuth. Credentials stay in the controller, never the coding workspace. Your subscription's limits apply. API-key billing is separate.";
    $("account-config").textContent =
      `Select provider ${status.provider} in App configuration to use this login for inference. Signing out removes only this App's credential; it does not revoke your account.`;
    $("login-url").textContent = anthropic
      ? "Continue at Anthropic"
      : "Continue at OpenAI";
    $("login-redirect").placeholder = anthropic
      ? "Paste code#state or final callback URL"
      : "Paste final localhost:1455 redirect URL";
    $("account-status").textContent = status.configured
      ? "Subscription connected."
      : login?.state === "failed"
        ? anthropic
          ? "Login failed. Retry using Copy code login (headless)."
          : login.method === "device_code"
            ? "Device code login failed. It may need to be enabled in your OpenAI account security settings — retry, or use Browser login instead."
            : "Login failed. Retry, or try Device code login instead."
        : login?.state === "cancelled"
          ? "Login cancelled."
          : prompt?.type === "select"
            ? "Choose how to sign in."
            : pending
              ? login?.userCode
                ? `Waiting for approval at ${anthropic ? "Anthropic" : "OpenAI"}… this window updates automatically. Do not share this code.`
                : `Waiting for you to finish at ${anthropic ? "Anthropic" : "OpenAI"}. Do not share the code or redirect URL.`
              : "Not signed in.";
    $("account-token").textContent = status.configured
      ? [
          status.tokenExpires
            ? `Access token valid until ${when(status.tokenExpires)}; Pi refreshes it automatically.`
            : "",
          status.lastCheck
            ? `Last check ${when(status.lastCheck.at)}: ${status.lastCheck.ok ? "OK" : "failed — sign in again"}.`
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "";
    $("login-start").disabled = pending;
    $("login-start").textContent = status.configured
      ? "Sign in again"
      : anthropic
        ? "Sign in with Anthropic"
        : "Sign in with ChatGPT";
    renderLoginPrompt(prompt);
    $("login-url").hidden = !login?.url;
    if (login?.url) $("login-url").href = login.url;
    else $("login-url").removeAttribute("href");
    const hasCode = !!login?.userCode;
    $("login-code").textContent = login?.userCode ?? "";
    $("login-code").hidden = !hasCode;
    $("login-copy-row").hidden = !hasCode;
    $("login-copy-feedback").textContent = "";
    $("login-steps").hidden = !hasCode;
    $("login-step-open").textContent =
      `Open ${anthropic ? "Anthropic" : "OpenAI"}`;
    $("login-answer").hidden = prompt?.type !== "manual_code";
    $("login-redirect-label").textContent =
      prompt?.type === "manual_code"
        ? prompt.message
        : "Final localhost redirect URL";
    $("login-cancel").hidden = !pending;
    $("login-verify").hidden = !status.configured || pending;
    $("login-logout").hidden = !status.configured;
    await bootstrap();
  } catch {
    $("account-status").textContent =
      "Account service unavailable. No login credentials were displayed.";
  }
}
async function refreshLocal(update) {
  try {
    const status = update ?? (await api("local/status")),
      endpoint = status.endpoint,
      test = status.test;
    localTestId = test?.id ?? "";
    $("local-status").textContent = endpoint
      ? `Connected: ${endpoint.kindName} at ${endpoint.url} · default model ${endpoint.model} · ${endpoint.models.length} model(s)${endpoint.authenticated ? " · API key stored" : ""}.`
      : status.unverified
        ? `Saved endpoint ${status.unverified.url} could not be verified at startup. Choose Refresh models to retry, or test a new URL.`
        : "No endpoint saved. Enter your server's URL and test it.";
    $("local-found").hidden = !test;
    if (test) {
      $("local-found-title").textContent =
        `Found ${test.kindName} at ${test.url}`;
      $("local-model").replaceChildren(
        ...test.models.map((id) => {
          const option = node("option", id);
          option.value = id;
          return option;
        }),
      );
      $("local-hidden").textContent = test.hidden
        ? `${test.hidden} model(s) hidden: embeddings, no tool calling or unsafe names.`
        : "";
    }
    $("local-refresh").hidden = !endpoint && !status.unverified;
    $("local-remove").hidden = !endpoint && !status.unverified;
    if (update) await bootstrap();
  } catch (e) {
    $("local-status").textContent = e.message;
  }
}
async function localAction(path, payload) {
  try {
    await refreshLocal(await api(path, payload));
    await loadModels();
  } catch (e) {
    $("local-status").textContent = e.message;
  }
}
$("local-test").addEventListener("submit", async (e) => {
  e.preventDefault();
  const apiKey = $("local-key").value;
  $("local-key").value = "";
  $("local-status").textContent = "Testing…";
  await localAction("local/test", {
    url: $("local-url").value,
    ...(apiKey ? { apiKey } : {}),
  });
});
$("local-save").addEventListener("click", () =>
  localAction("local/save", { id: localTestId, model: $("local-model").value }),
);
$("local-refresh").addEventListener("click", () =>
  localAction("local/refresh", {}),
);
$("local-remove").addEventListener("click", async () => {
  if (
    !window.confirm(
      "Remove the saved local endpoint and its API key from this App? Existing conversations keep their history.",
    )
  )
    return;
  await localAction("local/remove", {});
});
$("local-close").addEventListener("click", () => $("local-dialog").close());
$("local-dialog").addEventListener("close", () => {
  $("local-key").value = "";
});
$("open-local").addEventListener("click", () => {
  $("local-dialog").showModal();
  void refreshLocal();
});
function openAccount() {
  closeSettingsSheet();
  $("account").setAttribute("aria-expanded", "true");
  $("account-dialog").showModal();
  renderAccountProviders();
  void refreshAccount();
  clearInterval(accountTimer);
  accountTimer = setInterval(() => {
    void refreshAccount();
  }, 2000);
}
$("account").addEventListener("click", openAccount);
$("account-dialog").addEventListener("close", () => {
  clearInterval(accountTimer);
  $("login-redirect").value = "";
  $("account").setAttribute("aria-expanded", "false");
});
$("account-close").addEventListener("click", () => $("account-dialog").close());
async function startLogin() {
  try {
    await api("auth/login", { provider: activeAuthProvider });
    await refreshAccount();
  } catch (e) {
    $("account-status").textContent = e.message;
  }
}
$("login-start").addEventListener("click", startLogin);
$("login-copy").addEventListener("click", async () => {
  const code = $("login-code").textContent;
  if (!code) return;
  try {
    if (!navigator.clipboard?.writeText)
      throw new Error("clipboard_unavailable");
    await navigator.clipboard.writeText(code);
    $("login-copy-feedback").textContent = "Copied";
  } catch {
    // No Clipboard API (or it was denied): select the code so the user can
    // copy it with their platform's own shortcut instead.
    const selection = window.getSelection?.();
    if (selection && document.createRange) {
      const range = document.createRange();
      range.selectNodeContents($("login-code"));
      selection.removeAllRanges();
      selection.addRange(range);
    }
    $("login-copy-feedback").textContent =
      "Couldn't copy automatically: the code is selected, copy it manually.";
  }
});
$("login-answer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = $("login-redirect").value;
  $("login-redirect").value = "";
  try {
    await api("auth/answer", {
      id: loginId,
      value,
      provider: activeAuthProvider,
    });
    await refreshAccount();
  } catch (error) {
    $("account-status").textContent = error.message;
  }
});
$("login-cancel").addEventListener("click", async () => {
  try {
    await api("auth/cancel", { id: loginId, provider: activeAuthProvider });
    await refreshAccount();
  } catch (e) {
    $("account-status").textContent = e.message;
  }
});
$("login-verify").addEventListener("click", async () => {
  $("login-verify").disabled = true;
  try {
    await api("auth/verify", { provider: activeAuthProvider });
    await refreshAccount();
  } catch (e) {
    $("account-status").textContent = e.message;
  } finally {
    $("login-verify").disabled = false;
  }
});
$("login-logout").addEventListener("click", async () => {
  const label = AUTH_PROVIDER_LABEL[activeAuthProvider] ?? activeAuthProvider;
  if (
    !window.confirm(
      `Remove this App's local ${label} credential? This does not revoke your provider account.`,
    )
  )
    return;
  try {
    await api("auth/logout", { provider: activeAuthProvider });
    await refreshAccount();
  } catch (e) {
    $("account-status").textContent = e.message;
  }
});
$("model-choice").addEventListener("change", () => {
  modelDraftDirty = true;
  // A newly chosen model starts at the configured thinking default. The server
  // checks its actual registry support; choosing does not apply either field.
  $("thinking-choice").value = defaultThinkingLevel;
  controls();
});
$("thinking-choice").addEventListener("change", () => {
  modelDraftDirty = true;
  controls();
});
$("apply-model").addEventListener("click", async () => {
  if (!selected || !modelSelection || $("apply-model").disabled) return;
  const id = selected;
  const revision = modelSelection.revision;
  const raw = $("model-choice").value;
  // Multi-provider catalogs encode "provider\u0000modelId" to disambiguate
  // ids that collide across providers; the configured inference provider's
  // own models keep a plain modelId value and omit the field (= default).
  const [maybeProvider, maybeModelId] = raw.split("\u0000");
  const modelId = maybeModelId ?? raw;
  const modelProvider = maybeModelId ? maybeProvider : undefined;
  const thinkingLevel = $("thinking-choice").value;
  applyingModel = true;
  controls();
  try {
    await api(`sessions/${id}/model`, {
      ...(modelProvider && modelProvider !== provider
        ? { provider: modelProvider }
        : {}),
      modelId,
      thinkingLevel,
      revision,
    });
    if (selected === id) {
      const updated = await api(`sessions/${id}/snapshot`);
      if (selected !== id) return;
      modelDraftDirty = false;
      snapshot(updated);
      feedback("Model and thinking applied to this session's next input.");
    }
  } catch (error) {
    if (selected === id) {
      feedback(
        `Model not confirmed: ${error.message}. Review the active model before applying again.`,
      );
      try {
        const updated = await api(`sessions/${id}/snapshot`);
        if (selected === id) {
          modelDraftDirty = false;
          snapshot(updated);
        }
      } catch {
        if (selected === id) {
          modelSelection = null;
          $("active-model").textContent =
            "Active model unconfirmed; reconnect this session";
        }
        /* Reconnect explicitly; never retry a mutation. */
      }
    }
  } finally {
    applyingModel = false;
    controls();
  }
});
renderCanvas($("home-canvas"), null, draftQuestion);
// --- Apps: household mini-apps rendered by trusted code from the API ---
const APP_TOOL = /^app_(create|update)$/;
const SUGGEST_TOOL = /^suggest_(memory|app_change)$/;
const APP_ERRORS = {
  home_read_only:
    "Home permissions are Read-only, so this control is disabled. Change it in Home permissions.",
  home_outcome_unresolved:
    "Home writes are paused until an earlier unknown outcome is reconciled in its chat. Nothing was sent.",
  toggle_state_unknown:
    "Hearth only toggles from a known on/off state. Nothing was sent.",
  version_conflict: "This app changed. Values were read again; try once more.",
  app_not_found: "This app no longer exists.",
  rate_limit: "Too many reads in a minute. Wait a moment, then refresh.",
  app_needs_repair:
    "This app needs repair before its controls can be used. Ask Hearth to fix it.",
  version_outside_current_scope:
    "That version uses entities or services outside Hearth's current scope.",
  action_capacity: "Too many actions in flight. Try again shortly.",
};
const appMessage = (error, prefix) =>
  APP_ERRORS[error.message] ?? `${prefix}: ${error.message}`;
const appHandlers = {
  open: (id) => void openApp(id),
  pin: (id, pinned) => void pinApp(id, pinned),
  draft: (prompt) => {
    $("apps-dialog").close();
    void draftFromApp(prompt, "New app");
  },
};
function appResultCard(message) {
  return message.role === "toolResult" && APP_TOOL.test(message.toolName)
    ? renderAppResult(message, appHandlers)
    : null;
}
function appFeedback(value) {
  $("app-feedback").textContent = value;
}
function renderPinned() {
  renderPinnedApps($("pinned-apps"), transcriptEmpty ? apps : [], appHandlers);
}
async function loadApps() {
  try {
    apps = (await api("apps")).items ?? [];
  } catch {
    return;
  }
  renderAppList($("apps-list"), apps, appHandlers);
  $("apps-count").textContent = apps.length ? String(apps.length) : "";
  renderPinned();
}
function showAppView(open) {
  if (open) world?.closeFull();
  $("app-view").hidden = !open;
  $("topbar").hidden = open;
  document.querySelector(".conversation").hidden = open;
}
function closeApp() {
  world?.closeFull();
  if (!openAppId) return;
  openAppId = null;
  appData = null;
  showAppView(false);
}
function openAppsSheet() {
  if (compact() && document.body.classList.contains("drawer-open"))
    closeDrawer();
  $("apps-dialog").showModal();
  $("apps-row").setAttribute("aria-expanded", "true");
  void loadApps();
}
async function openApp(id) {
  if ($("apps-dialog").open) $("apps-dialog").close();
  if (compact() && document.body.classList.contains("drawer-open"))
    closeDrawer();
  if (openAppId !== id) appUi = { tabs: new Map() };
  openAppId = id;
  appData = null;
  $("app-title").textContent = apps.find((a) => a.id === id)?.title ?? "App";
  $("app-body").replaceChildren();
  $("app-history").replaceChildren();
  appFeedback("Reading values from Home Assistant…");
  showAppView(true);
  await refreshApp();
}
function paintApp() {
  renderApp($("app-body"), appData, appViewHandlers, appUi);
  renderAppHistory($("app-history"), appData, appViewHandlers);
  $("app-title").textContent = appData.app.title;
  $("app-pin").textContent = appData.app.pinned ? "Unpin" : "Pin";
}
async function refreshApp(message = "") {
  const id = openAppId;
  if (!id) return;
  try {
    const data = await api(`apps/${id}`);
    if (openAppId !== id) return;
    appData = data;
    paintApp();
    appFeedback(message);
  } catch (error) {
    if (openAppId === id)
      appFeedback(appMessage(error, "Could not read the app"));
  }
}
// Ask/toggle need a Home chat: the current one, or a new one named for the app.
async function homeSessionFor(title, sessionTitle = `App: ${title}`) {
  if (selected && selectedKind === "home") return selected;
  const name = sessionTitle.slice(0, SESSION_TITLE_MAX);
  const result = await api("sessions", {
    title: name,
    kind: "home",
    requestId: crypto.randomUUID(),
  });
  await listSessions();
  await select({ id: result.id, title: name, kind: "home" });
  await listSessions();
  return result.id;
}
async function draftFromApp(prompt, title, sessionTitle) {
  try {
    await homeSessionFor(title, sessionTitle);
    closeApp();
    if ($("message").disabled)
      feedback(
        "This chat is busy, so the app question was not drafted. Try again when it is ready.",
      );
    else draftQuestion(prompt);
  } catch (error) {
    appFeedback(appMessage(error, "Could not open a chat"));
  }
}
async function changeAppState(stateKey, body) {
  const data = appData;
  if (!data) return;
  try {
    const result = await api(`apps/${data.app.id}/state`, {
      stateKey,
      ...body,
    });
    if (appData !== data) return;
    appData = { ...data, state: result.state };
    paintApp();
    appFeedback("Saved.");
  } catch (error) {
    appFeedback(appMessage(error, "Not saved"));
    if (appData === data) paintApp();
  }
}
// The exact approval card for a person-pressed control (app or Home World).
function showActionApproval(sessionId, proposal, after) {
  renderProposals(
    $("app-approval-card"),
    { [proposal.id]: proposal },
    async (p, decision) => {
      if (decision === "resolve") return;
      try {
        await api(`sessions/${sessionId}/actions`, {
          id: p.id,
          hash: p.hash,
          decision,
        });
        $("app-approval").close();
        await after(
          decision === "approve"
            ? "Approved. Values were read again; HA acceptance is not physical verification."
            : "Rejected. Nothing was sent.",
        );
      } catch (error) {
        $("app-approval").close();
        await after(appMessage(error, "Decision not recorded"));
      }
    },
    permissions?.effectiveMode !== "read-only" && !permissions?.blocked,
  );
  $("app-approval").showModal();
}
async function toggleFromApp(elementId) {
  const data = appData;
  if (!data) return;
  try {
    const sessionId = await homeSessionFor(data.app.title);
    appFeedback("Sending to Home permissions…");
    const result = await api(`apps/${data.app.id}/actions`, {
      elementId,
      sessionId,
      version: data.app.version,
    });
    const p = result.proposal;
    if (p.status === "pending") {
      appFeedback("Review the exact action to continue.");
      showActionApproval(sessionId, p, (message) => refreshApp(message));
    } else if (p.status === "accepted")
      await refreshApp(
        `Home Assistant accepted ${p.action.service} for ${p.action.entityId}${result.readBack ? `; it now reads ${result.readBack.state} (as of ${timeOf(result.readBack.observedAt)})` : ""}. Acceptance is not physical verification.`,
      );
    else if (p.status === "unknown")
      await refreshApp(
        `Outcome unknown for ${p.action.service} ${p.action.entityId}. It will not be retried. Check the device, then record what you saw on the action card in the chat.`,
      );
    else await refreshApp(`Action ${p.status}. ${p.resolution || ""}`);
  } catch (error) {
    appFeedback(appMessage(error, "Not sent"));
    if (error.message === "version_conflict") await refreshApp();
  }
}
async function pinApp(id, pinned) {
  try {
    await api(`apps/${id}/pin`, { pinned });
    await loadApps();
    if (openAppId === id && appData) {
      appData.app.pinned = pinned;
      paintApp();
      appFeedback(pinned ? "Pinned to empty chats." : "Unpinned.");
    } else feedback(pinned ? "App pinned." : "App unpinned.");
  } catch (error) {
    (openAppId ? appFeedback : feedback)(appMessage(error, "Not pinned"));
  }
}
const appViewHandlers = {
  ask: (prompt) => void draftFromApp(prompt, appData?.app.title ?? "App"),
  state: (stateKey, body) => void changeAppState(stateKey, body),
  toggle: (elementId) => void toggleFromApp(elementId),
  revert: async (version) => {
    const data = appData;
    if (
      !data ||
      !window.confirm(`Restore version ${version} as a new version?`)
    )
      return;
    try {
      await api(`apps/${data.app.id}/revert`, {
        version,
        baseVersion: data.app.version,
      });
      await loadApps();
      await refreshApp(`Restored v${version} as a new version.`);
    } catch (error) {
      appFeedback(appMessage(error, "Not restored"));
    }
  },
};
$("apps-row").addEventListener("click", openAppsSheet);
$("apps-close").addEventListener("click", () => $("apps-dialog").close());
$("apps-dialog").addEventListener("close", () =>
  $("apps-row").setAttribute("aria-expanded", "false"),
);
$("apps-new").addEventListener("click", () => {
  $("apps-dialog").close();
  void draftFromApp("Make me an app for ", "New app");
});
$("app-back").addEventListener("click", () => {
  closeApp();
  openAppsSheet();
});
$("app-refresh").addEventListener("click", () => {
  appFeedback("Reading values from Home Assistant…");
  void refreshApp("Values read again.");
});
$("app-pin").addEventListener("click", () => {
  if (appData) void pinApp(appData.app.id, !appData.app.pinned);
});
$("app-change").addEventListener("click", () => {
  if (!appData) return;
  const { id, title, version } = appData.app;
  void draftFromApp(
    `Change my app "${title}" (${id}, version ${version}): `,
    title,
  );
});
$("app-delete").addEventListener("click", async () => {
  const data = appData;
  if (
    !data ||
    !window.confirm(
      `Delete the app "${data.app.title}"? Its checklist ticks, counters and notes are removed from your list. Stored history is not securely erased.`,
    )
  )
    return;
  try {
    await api(`apps/${data.app.id}/delete`, { confirm: true });
    closeApp();
    await loadApps();
    feedback("App deleted.");
  } catch (error) {
    appFeedback(appMessage(error, "Not deleted"));
  }
});
$("app-approval-close").addEventListener("click", () =>
  $("app-approval").close(),
);
// Local endpoints can add or replace models without an App restart. When
// more than one provider is present, models group under their provider's
// name so e.g. "gpt-5" (ChatGPT) and "gpt-5" (local) never read as one model.
async function loadModels() {
  modelChoices = (await api("models")).items;
  const providers = [...new Set(modelChoices.map((m) => m.provider))];
  const multi = providers.length > 1;
  const choices = document.createDocumentFragment();
  const groups = new Map();
  for (const model of modelChoices) {
    const option = document.createElement("option");
    option.value = multi ? `${model.provider}\u0000${model.id}` : model.id;
    option.textContent = `${model.name} (${model.id})`;
    if (!multi) {
      choices.append(option);
      continue;
    }
    let group = groups.get(model.provider);
    if (!group) {
      group = document.createElement("optgroup");
      group.label = AUTH_PROVIDER_LABEL[model.provider] ?? model.provider;
      groups.set(model.provider, group);
      choices.append(group);
    }
    group.append(option);
  }
  $("model-choice").replaceChildren(choices);
  controls();
}
// --- Drawer (off-canvas on compact, permanent sidebar on wide screens) ---
function drawerFocusable() {
  return [
    ...$("drawer").querySelectorAll(
      'button:not([hidden]):not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ];
}
function openDrawer() {
  document.body.classList.add("drawer-open");
  $("backdrop").hidden = false;
  $("drawer-toggle").setAttribute("aria-expanded", "true");
  const first = drawerFocusable()[0];
  first?.focus();
}
function closeDrawer() {
  document.body.classList.remove("drawer-open");
  $("backdrop").hidden = true;
  $("drawer-toggle").setAttribute("aria-expanded", "false");
  closeSessionMenus();
  $("drawer-toggle").focus();
}
$("drawer-toggle").addEventListener("click", () => {
  if (document.body.classList.contains("drawer-open")) closeDrawer();
  else openDrawer();
});
$("drawer-close").addEventListener("click", closeDrawer);
$("backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (compact() && document.body.classList.contains("drawer-open"))
    closeDrawer();
});
document.addEventListener("keydown", (event) => {
  if (
    event.key !== "Tab" ||
    !compact() ||
    !document.body.classList.contains("drawer-open")
  )
    return;
  const focusable = drawerFocusable();
  if (!focusable.length) return;
  const first = focusable[0],
    last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
// --- Settings: one drawer-footer row opens a grouped sheet; each list row
// closes it and opens the entry point it has always opened (same dialogs,
// same ids, same logic \u2014 only the launch point moved). ---
function closeSettingsSheet() {
  if ($("settings-dialog").open) $("settings-dialog").close();
}
function openSettings() {
  if (compact() && document.body.classList.contains("drawer-open"))
    closeDrawer();
  $("settings-dialog").showModal();
  $("settings-row").setAttribute("aria-expanded", "true");
}
$("settings-row").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", () =>
  $("settings-dialog").close(),
);
$("settings-dialog").addEventListener("close", () => {
  $("settings-row").setAttribute("aria-expanded", "false");
});
function openAbout() {
  closeSettingsSheet();
  $("about-dialog").showModal();
}
$("settings-about-row").addEventListener("click", openAbout);
$("about-close").addEventListener("click", () => $("about-dialog").close());
$("settings-insights-row").addEventListener("click", () => {
  closeSettingsSheet();
  openInsights();
});
// --- Settings → Memory: owner-approved household facts ---
function memoryFeedback(value) {
  $("memory-feedback").textContent = value;
}
function paintMemory() {
  if (!memoryData) return;
  $("memory-summary").textContent =
    `${memoryData.items.length} item${memoryData.items.length === 1 ? "" : "s"}`;
  renderMemory($("memory-body"), memoryData, memoryUi, memoryHandlers);
}
async function loadMemory() {
  try {
    memoryData = await api("memory");
    paintMemory();
  } catch (error) {
    memoryFeedback(`Could not load: ${error.message}.`);
  }
}
function memoryError(error) {
  return error.message === "invalid_memory_text"
    ? "Use one line of plain text, up to 200 characters."
    : error.message === "memory_full"
      ? "Memory is full. Forget an item first."
      : error.message === "memory_duplicate"
        ? "That is already remembered."
        : error.message;
}
async function memoryAction(path, payload, message) {
  try {
    const result = await api(path, payload);
    memoryData = result;
    memoryUi.editing = null;
    paintMemory();
    memoryFeedback(typeof message === "function" ? message(result) : message);
    return true;
  } catch (error) {
    memoryFeedback(`Not saved: ${memoryError(error)}`);
    return false;
  }
}
const memoryHandlers = {
  add: async (value) => {
    if (
      await memoryAction("memory/add", { text: value }, (result) =>
        result.added
          ? "Remembered. Hearth uses it from the next message."
          : "That is already remembered.",
      )
    ) {
      memoryUi.draft = "";
      paintMemory();
    }
  },
  startEdit: (id) => {
    memoryUi.editing = id;
    paintMemory();
    if (id) document.getElementById(`memory-edit-${id}`)?.focus?.();
  },
  edit: (item, value) =>
    void memoryAction("memory/edit", { id: item.id, text: value }, "Saved."),
  forget: (item) => {
    if (
      !window.confirm(
        "Forget this? Hearth stops receiving it from its next request. Earlier chats and the App's private store keep committed history; it is not securely erased.",
      )
    )
      return;
    void memoryAction("memory/forget", { id: item.id }, "Forgotten.");
  },
};
function openMemory() {
  closeSettingsSheet();
  memoryFeedback("");
  memoryUi.editing = null;
  $("memory-dialog").showModal();
  $("memory-row").setAttribute("aria-expanded", "true");
  void loadMemory();
}
$("memory-row").addEventListener("click", openMemory);
$("memory-close").addEventListener("click", () => $("memory-dialog").close());
$("memory-dialog").addEventListener("close", () =>
  $("memory-row").setAttribute("aria-expanded", "false"),
);
// --- Sheets: Home permissions and Model open as dialogs from several entry points ---
function openPermissions() {
  closeSettingsSheet();
  $("permissions-dialog").showModal();
  $("permissions-toggle").setAttribute("aria-expanded", "true");
  $("permissions-row").setAttribute("aria-expanded", "true");
}
$("permissions-toggle").addEventListener("click", openPermissions);
$("permissions-row").addEventListener("click", openPermissions);
$("permissions-close").addEventListener("click", () =>
  $("permissions-dialog").close(),
);
$("permissions-dialog").addEventListener("close", () => {
  $("permissions-toggle").setAttribute("aria-expanded", "false");
  $("permissions-row").setAttribute("aria-expanded", "false");
});
function openModel() {
  $("model-dialog").showModal();
  $("model-chip").setAttribute("aria-expanded", "true");
}
$("model-chip").addEventListener("click", openModel);
$("model-close").addEventListener("click", () => $("model-dialog").close());
$("open-world").addEventListener("click", () => {
  closeSettingsSheet();
  if (compact()) closeDrawer();
  void openWorld();
});
$("model-dialog").addEventListener("close", () => {
  $("model-chip").setAttribute("aria-expanded", "false");
});
// --- Today inbox, Briefings & watchers, Insights and message feedback ---
// Polled (no extra stream): the controller checks watchers about once a
// minute, so the badge never needs to be fresher than that.
function todayFeedback(value) {
  $("today-feedback").textContent = value;
}
function paintTodayBadge() {
  const unread = todayData?.unread ?? 0;
  $("today-badge").textContent = unread ? String(unread) : "";
  $("today-badge").hidden = !unread;
  $("today-dot").hidden = !unread;
  $("today-row").setAttribute(
    "aria-label",
    unread ? `Today, ${unread} new card${unread === 1 ? "" : "s"}` : "Today",
  );
  $("drawer-toggle").setAttribute(
    "aria-label",
    unread ? `Conversations and Today (${unread} new)` : "Conversations",
  );
}
function paintToday() {
  if (!todayData) return;
  paintTodayBadge();
  if ($("today-dialog").open)
    renderToday($("today-list"), todayData, todayHandlers, todayUi);
}
async function loadToday() {
  try {
    todayData = await api("today");
  } catch {
    return;
  }
  paintToday();
}
async function todayAction(path, payload, message) {
  try {
    const result = await api(path, payload);
    if (result?.cards) todayData = { ...todayData, ...result };
    else await loadToday();
    paintToday();
    todayFeedback(message);
  } catch (error) {
    todayFeedback(
      error.message === "snooze_tonight_passed"
        ? "It is already evening; choose Tomorrow instead."
        : `Not saved: ${error.message}.`,
    );
  }
}
// Owner decisions on suggestions: each is an authenticated, CSRF-checked
// request bound to the suggestion's hash; the response carries fresh Today.
async function suggestionAction(path, payload, message) {
  try {
    const { decision, ...today } = await api(path, payload);
    todayData = today;
    todayUi.editing = null;
    paintToday();
    if (decision?.ok === false && decision.conflict) {
      todayFeedback(
        decision.conflict.code === "version_conflict"
          ? `Not applied: the app changed since this suggestion (now v${decision.conflict.currentVersion}). Nothing was changed.`
          : `Not applied: ${decision.conflict.message} Nothing was changed.`,
      );
      return;
    }
    if (decision?.kind === "app_change" && decision.ok) {
      void loadApps();
      if (openAppId === decision.appId) void openApp(decision.appId);
    }
    todayFeedback(typeof message === "function" ? message(decision) : message);
  } catch (error) {
    todayFeedback(
      error.message === "invalid_memory_text"
        ? "Use one line of plain text, up to 200 characters."
        : error.message === "memory_full"
          ? "Memory is full. Forget an item in Settings → Memory first."
          : error.message === "snooze_tonight_passed"
            ? "It is already evening; choose Tomorrow instead."
            : `Not saved: ${error.message}.`,
    );
  }
}
const suggestionHandlers = {
  accept: (s, text) =>
    void suggestionAction(
      "suggestions/accept",
      { id: s.id, hash: s.hash, ...(text === undefined ? {} : { text }) },
      (decision) =>
        decision?.kind === "memory"
          ? "Saved to memory. Hearth uses it from the next message."
          : `App updated to v${decision?.version}. Revert under Versions if needed.`,
    ),
  edit: (id) => {
    todayUi.editing = id;
    paintToday();
    if (id) document.getElementById(`suggestion-edit-${id}`)?.focus?.();
  },
  reject: (s) =>
    void suggestionAction(
      "suggestions/reject",
      { id: s.id, hash: s.hash },
      "Rejected. Hearth won't suggest this again for 60 days.",
    ),
  snooze: (s, until) =>
    void suggestionAction(
      "suggestions/snooze",
      { id: s.id, until },
      `Snoozed until ${until === "1h" ? "an hour from now" : until === "tonight" ? "19:00" : "tomorrow 08:00"}.`,
    ),
  dismiss: (s) =>
    void suggestionAction("suggestions/dismiss", { id: s.id }, "Dismissed."),
  askAgain: (s) => {
    $("today-dialog").close();
    void draftFromApp(
      `Please suggest this change to my app "${s.app.title}" (${s.app.appId}) again against its current version: ${s.app.summary}`,
      s.app.title,
    );
  },
};
const todayHandlers = {
  suggestion: suggestionHandlers,
  dismiss: (card) =>
    void todayAction("today/dismiss", { id: card.id }, "Dismissed."),
  snooze: (card, until) =>
    void todayAction(
      "today/snooze",
      { id: card.id, until },
      `Snoozed until ${until === "1h" ? "an hour from now" : until === "tonight" ? "19:00" : "tomorrow 08:00"}.`,
    ),
  ask: (card) => {
    $("today-dialog").close();
    void api("today/asked", { id: card.id }).catch(() => {});
    void draftFromApp(askPrompt(card), card.source?.title || card.title);
  },
  openApp: (appId) => {
    $("today-dialog").close();
    void openApp(appId);
  },
  createWatcher: () => {
    $("today-dialog").close();
    void openProactive().then(() => {
      const details = document.getElementById("watcher-add-details");
      if (!details) return;
      details.open = true;
      details.scrollIntoView({ block: "center" });
    });
  },
};
async function openToday() {
  if (compact() && document.body.classList.contains("drawer-open"))
    closeDrawer();
  todayFeedback("");
  $("today-dialog").showModal();
  $("today-row").setAttribute("aria-expanded", "true");
  await loadToday();
  if (!todayData) {
    todayFeedback("Today is unavailable right now.");
    return;
  }
  renderToday($("today-list"), todayData, todayHandlers, todayUi);
  // Opening the inbox marks what is shown as seen; the "New" labels stay
  // until the next refresh so you can still tell which cards were new.
  if (todayData.unread)
    try {
      const seen = await api("today/seen", {});
      todayData = { ...seen };
      paintTodayBadge();
    } catch {
      /* The badge simply stays until the next refresh. */
    }
}
$("today-row").addEventListener("click", () => void openToday());
$("today-close").addEventListener("click", () => $("today-dialog").close());
$("today-dialog").addEventListener("close", () =>
  $("today-row").setAttribute("aria-expanded", "false"),
);
$("today-settings").addEventListener("click", () => {
  $("today-dialog").close();
  void openProactive();
});
function proactiveFeedback(value) {
  $("proactive-feedback").textContent = value;
}
let proactiveSettings = null;
function paintProactive() {
  if (!proactiveSettings) return;
  const on = ["morning", "evening"].filter(
    (slot) => proactiveSettings.briefings[slot].enabled,
  ).length;
  const active = proactiveSettings.watchers.filter(
    (w) => w.status === "active",
  ).length;
  $("proactive-summary").textContent = !proactiveSettings.watchersEnabled
    ? "Paused"
    : on + active
      ? `${on + active} on`
      : "Off";
  if ($("proactive-dialog").open)
    renderProactiveSettings(
      $("proactive-body"),
      proactiveSettings,
      proactiveHandlers,
    );
}
async function loadProactive() {
  try {
    proactiveSettings = await api("proactive");
  } catch (error) {
    proactiveFeedback(`Could not load: ${error.message}.`);
    return;
  }
  paintProactive();
}
async function proactiveAction(path, payload, message) {
  try {
    proactiveSettings = await api(path, payload);
    paintProactive();
    proactiveFeedback(message);
  } catch (error) {
    proactiveFeedback(
      {
        briefing_source_required:
          "Choose where the briefing reads its values from first.",
        invalid_time: "Choose a time.",
        app_not_found: "That app no longer exists.",
        canvas_not_found: "That Home view no longer exists.",
        watcher_limit: "You already have the maximum number of watchers.",
      }[error.message] ?? `Not saved: ${error.message}.`,
    );
  }
}
const WATCHER_ERRORS = {
  entity_not_in_scope: "That entity is not in Hearth's read scope.",
  entity_binding_required:
    "Enter an exact entity ID, like sensor.washer_state.",
  text_length: "Fill in the card title (up to 60 characters).",
  unsafe_text: "Use plain words only.",
  threshold_number: "Enter a number.",
  integer_range: "Minutes must be 1–1440.",
  watcher_time: "Choose a time.",
};
const proactiveHandlers = {
  saveBriefing: (slot, value) =>
    void proactiveAction(
      "proactive/briefing",
      { slot, ...value },
      value.enabled
        ? `${slot === "morning" ? "Morning" : "Evening"} briefing on at ${value.at}. The first one arrives at the next ${value.at}.`
        : "Briefing off.",
    ),
  setEnabled: (enabled) =>
    void proactiveAction(
      "proactive/enabled",
      { enabled },
      enabled ? "Watchers resumed." : "All watchers paused.",
    ),
  removeWatcher: (id) =>
    void proactiveAction("proactive/watchers/remove", { id }, "Removed."),
  openApp: (appId) => {
    $("proactive-dialog").close();
    void openApp(appId);
  },
  addWatcher: async (watcher, errors) => {
    try {
      const response = await fetch(
        new URL("api/proactive/watchers/add", base),
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-Hearth-CSRF": csrf,
          },
          body: JSON.stringify({ watcher }),
        },
      );
      const result = await response.json();
      if (result.ok) {
        proactiveSettings = result.settings;
        paintProactive();
        proactiveFeedback("Watcher added. It starts with the next check.");
        return;
      }
      if (!result.errors) throw new Error(result.error ?? "Request failed");
      errors.textContent = result.errors
        .map((e) => WATCHER_ERRORS[e.code] ?? e.message)
        .filter((v, i, all) => all.indexOf(v) === i)
        .join(" ");
    } catch (error) {
      errors.textContent = `Not added: ${error.message}.`;
    }
  },
};
async function openProactive() {
  closeSettingsSheet();
  if (compact() && document.body.classList.contains("drawer-open"))
    closeDrawer();
  proactiveFeedback("");
  $("proactive-dialog").showModal();
  $("proactive-row").setAttribute("aria-expanded", "true");
  await loadProactive();
}
$("proactive-row").addEventListener("click", () => void openProactive());
$("proactive-close").addEventListener("click", () =>
  $("proactive-dialog").close(),
);
$("proactive-dialog").addEventListener("close", () =>
  $("proactive-row").setAttribute("aria-expanded", "false"),
);
async function loadInsights() {
  try {
    renderInsights($("insights-body"), await api("insights"));
  } catch (error) {
    $("insights-feedback").textContent = `Could not load: ${error.message}.`;
  }
}
function openInsights() {
  $("insights-feedback").textContent = "";
  $("insights-export-box").hidden = true;
  $("insights-dialog").showModal();
  void loadInsights();
}
$("open-insights").addEventListener("click", () => {
  $("proactive-dialog").close();
  openInsights();
});
$("insights-close").addEventListener("click", () =>
  $("insights-dialog").close(),
);
$("insights-export-button").addEventListener("click", async () => {
  try {
    const data = await api("insights/export");
    const textValue = JSON.stringify(data, null, 2);
    $("insights-export").textContent = textValue;
    $("insights-export-box").hidden = false;
    $("insights-export-box").open = true;
    try {
      const url = URL.createObjectURL(
        new Blob([textValue], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "hearth-insights.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch {
      /* The JSON stays visible below for copying. */
    }
    $("insights-feedback").textContent =
      `Exported ${data.items.length} rating${data.items.length === 1 ? "" : "s"}. The JSON is also shown below.`;
  } catch (error) {
    $("insights-feedback").textContent = `Not exported: ${error.message}.`;
  }
});
$("insights-delete").addEventListener("click", async () => {
  if (
    !window.confirm(
      "Delete all your ratings and Today card counts? Like other deletes, Pi Durable keeps committed history in the App's private store; it is not securely erased.",
    )
  )
    return;
  try {
    const result = await api("insights/delete", { confirm: true });
    $("insights-export-box").hidden = true;
    $("insights-export").textContent = "";
    $("insights-feedback").textContent =
      `Deleted ${result.deleted} rating${result.deleted === 1 ? "" : "s"}.`;
    feedbackItems = {};
    for (const id of feedbackRows.keys()) paintFeedbackRow(id);
    await loadInsights();
  } catch (error) {
    $("insights-feedback").textContent = `Not deleted: ${error.message}.`;
  }
});
// 👍/👎 under committed assistant replies, stored locally without text.
function feedbackFor(entry) {
  if (!selected || !Number.isSafeInteger(entry?.id)) return null;
  const row = node("div", "", "feedback-row");
  feedbackRows.set(entry.id, row);
  paintFeedbackRow(entry.id);
  return row;
}
function paintFeedbackRow(entryId) {
  const row = feedbackRows.get(entryId);
  if (!row) return;
  const ui = feedbackUi.get(entryId) ?? { open: false, draft: new Set() };
  feedbackUi.set(entryId, ui);
  const sessionId = selected;
  ui.appHint = sessionUsesApp;
  renderFeedback(row, feedbackItems[String(entryId)], ui, {
    toggle: () => {
      ui.open = !ui.open;
      paintFeedbackRow(entryId);
    },
    reason: (reason) => {
      if (ui.draft.has(reason)) ui.draft.delete(reason);
      else ui.draft.add(reason);
      paintFeedbackRow(entryId);
    },
    rate: async (rating, reasons) => {
      try {
        await api(`sessions/${sessionId}/feedback`, {
          entryId,
          rating,
          ...(rating === "down" ? { reasons } : {}),
        });
        if (selected !== sessionId) return;
        if (rating === "clear") delete feedbackItems[String(entryId)];
        else feedbackItems[String(entryId)] = { rating, reasons };
        ui.open = false;
        ui.draft = new Set();
        paintFeedbackRow(entryId);
      } catch (error) {
        feedback(`Rating not saved: ${error.message}.`);
      }
    },
  });
}
async function loadFeedback(id) {
  feedbackSession = id;
  feedbackItems = {};
  feedbackUi = new Map();
  try {
    const result = await api(`sessions/${id}/feedback`);
    if (feedbackSession !== id || selected !== id) return;
    feedbackItems = result.items ?? {};
    for (const entryId of feedbackRows.keys()) paintFeedbackRow(entryId);
  } catch {
    /* Ratings stay blank; rating again records a fresh one. */
  }
}
// Unref'd so a non-browser host (tests) is never kept alive by the poll.
setInterval(() => void loadToday(), 60000)?.unref?.();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void loadToday();
});
try {
  await bootstrap();
  await loadModels();
  const sessions = await listSessions();
  void loadApps();
  void loadToday();
  void loadProactive();
  void loadWorld();
  setConnection("Connected");
  if (sessions.length) {
    await select(sessions[sessions.length - 1]);
    await listSessions();
  }
} catch {
  setConnection("Unavailable");
  feedback(
    "Authentication or server unavailable. Local mode uses username hearth and the configured password. Reload to reconnect.",
  );
}
window.addEventListener("pagehide", () => {
  stream?.close();
  clearInterval(accountTimer);
});
