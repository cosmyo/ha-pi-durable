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
  appResultCount = -1;
const feedback = (value) => {
  $("feedback").textContent = value;
};
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
  $("account-summary").textContent = items.length
    ? items
        .map(
          (i) =>
            `${AUTH_PROVIDER_LABEL[i.provider] ?? i.provider}${i.configured ? " ✓" : ""}`,
        )
        .join(" · ")
    : "Account";
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
// PROTOTYPE Home World hook (public/world/, throwaway exploration): loaded
// on demand by dynamic import so the app is unchanged if it never opens or
// fails to load. It receives the snapshot already shown here, read-only, and
// can only draft questions through draftQuestion.
let worldModule = null,
  worldSnapshot = null;
function worldInput() {
  return {
    snapshot: worldSnapshot,
    busy,
    kind: selected ? selectedKind : "home",
    canDraft: !$("message").disabled && selectedKind === "home",
    draftQuestion,
    buildViewPrompt: BUILD_VIEW_PROMPT,
  };
}
function forwardWorld() {
  try {
    worldModule?.updateWorld(worldInput());
  } catch {
    /* The prototype must never break the chat. */
  }
}
async function openWorld() {
  try {
    worldModule ??= await import("./world/prototype-world.js");
    worldModule.openWorld(worldInput());
  } catch {
    feedback("Home World prototype could not load. Chat is unaffected.");
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
  if (nextMessageSignature !== messageSignature) {
    messageSignature = nextMessageSignature;
    renderMessages($("messages"), value, appResultCard);
    transcriptEmpty = entries.length === 0;
    renderPinned();
    // A new app_create/app_update result refreshes the Apps list and pins.
    const results = entries
      .flatMap((e) => e.model ?? [])
      .filter(
        (m) => m.role === "toolResult" && APP_TOOL.test(m.toolName),
      ).length;
    if (results !== appResultCount) {
      if (appResultCount >= 0 && results > appResultCount) void loadApps();
      appResultCount = results;
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
  if (atBottom) area.scrollTop = area.scrollHeight;
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
  $("app-view").hidden = !open;
  $("topbar").hidden = open;
  document.querySelector(".conversation").hidden = open;
}
function closeApp() {
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
async function homeSessionFor(title) {
  if (selected && selectedKind === "home") return selected;
  const name = `App: ${title}`.slice(0, SESSION_TITLE_MAX);
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
async function draftFromApp(prompt, title) {
  try {
    await homeSessionFor(title);
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
function showAppApproval(sessionId, proposal) {
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
        await refreshApp(
          decision === "approve"
            ? "Approved. Values were read again; HA acceptance is not physical verification."
            : "Rejected. Nothing was sent.",
        );
      } catch (error) {
        $("app-approval").close();
        appFeedback(appMessage(error, "Decision not recorded"));
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
      showAppApproval(sessionId, p);
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
// --- Sheets: Home permissions and Model open as dialogs from several entry points ---
function openPermissions() {
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
  if (compact()) closeDrawer();
  void openWorld();
});
window.addEventListener("hashchange", () => {
  if (/^#world=[ABC]$/.test(window.location.hash)) void openWorld();
});
if (/^#world=[ABC]$/.test(window.location.hash)) void openWorld();
$("model-dialog").addEventListener("close", () => {
  $("model-chip").setAttribute("aria-expanded", "false");
});
try {
  await bootstrap();
  await loadModels();
  const sessions = await listSessions();
  void loadApps();
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
