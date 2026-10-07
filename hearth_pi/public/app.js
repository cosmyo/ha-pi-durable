import {
  node,
  renderMessages,
  renderProposals,
  renderCanvas,
} from "./render.js";
const $ = (id) => document.getElementById(id);
const base = new URL("./", window.location.href);
// Phones, the HA companion app and short landscape screens use a compact
// layout: secondary panels start collapsed so the conversation keeps the space.
const COMPACT_QUERY = "(max-width: 720px), (max-height: 560px)";
const compact = () => !!window.matchMedia?.(COMPACT_QUERY).matches;
let csrf = "",
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
  applyingModel = false;
const feedback = (value) => {
  $("feedback").textContent = value;
};
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
async function bootstrap() {
  const status = await api("bootstrap");
  csrf = status.csrf;
  $("provider").textContent = status.provider;
  provider = status.provider;
  $("account").textContent =
    provider === "local"
      ? "Local model"
      : provider === "anthropic"
        ? "Anthropic login"
        : "ChatGPT login";
  updatePermissions(status.homePermissions);
  inferenceReady = status.inferenceReady;
  defaultThinkingLevel = status.defaultThinkingLevel ?? "off";
  $("new-workspace").hidden = !status.workspaceEnabled;
  controls();
}
function updatePermissions(value) {
  if (!value) return;
  permissions = value;
  $("home-mode").value = value.effectiveMode;
  $("permissions-mode").textContent = value.blocked
    ? "Paused"
    : value.effectiveMode === "full"
      ? "Full access"
      : value.effectiveMode === "ask"
        ? "Ask"
        : "Read-only";
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
  $("stop").disabled = !selected || !busy;
  $("delete-session").disabled = !selected;
  // Keep the compact header row within phone width; the always-visible
  // aria-label still names the action for assistive tech.
  $("delete-session").textContent = compact() ? "🗑" : "Delete";
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
  $("home-surface").hidden = selectedKind === "workspace";
  $("canvas-toggle").hidden = selectedKind === "workspace";
  $("home-canvas").hidden = !canvasOpen;
  $("home-surface").classList.toggle("collapsed", !canvasOpen);
  $("canvas-toggle").setAttribute("aria-expanded", String(canvasOpen));
  for (const button of document.querySelectorAll(
    ".canvas-question, .home-starters button",
  ))
    button.disabled = $("send").disabled || selectedKind !== "home";
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
$("build-view").addEventListener("click", () =>
  draftQuestion(
    "Discover the exact HA entities you are allowed to read, then use ha_build_view to build a useful status canvas with sensible named sections. Use controller-read facts; do not invent entities/rooms or call services. If the scope is empty, explain that.",
  ),
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
// Compact-layout disclosure panels. Wide layouts always show both panels.
function panelToggle(button, className) {
  $(button).addEventListener("click", () => {
    const open = document.body.classList.toggle(className);
    $(button).setAttribute("aria-expanded", String(open));
  });
}
panelToggle("permissions-toggle", "show-permissions");
panelToggle("model-toggle", "show-model");
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
    if (
      !modelDraftDirty ||
      !modelChoices.some((m) => m.id === $("model-choice").value)
    ) {
      $("model-choice").value = active?.modelId ?? "";
      $("thinking-choice").value = modelSelection.thinkingLevel ?? "off";
      modelDraftDirty = false;
    }
  }
  renderMessages($("messages"), value);
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
async function listSessions() {
  const { items } = await api("sessions");
  const fragment = document.createDocumentFragment();
  for (const session of items.slice().reverse()) {
    const button = node(
      "button",
      `${session.kind === "workspace" ? "⌘ " : "◈ "}${session.title}`,
      "session",
    );
    button.type = "button";
    button.setAttribute("aria-current", String(session.id === selected));
    button.addEventListener("click", () => select(session));
    fragment.append(button);
  }
  $("sessions").replaceChildren(fragment);
  return items;
}
async function select(session) {
  stream?.close();
  selected = session.id;
  selectedKind = session.kind ?? "home";
  modelSelection = null;
  modelDraftDirty = false;
  $("active-model").textContent = "Loading session model…";
  $("model-choice").value = "";
  $("thinking-choice").value = "off";
  actionSignature = "";
  canvasSignature = "";
  renderCanvas($("home-canvas"), null, draftQuestion);
  $("title").textContent = session.title;
  feedback("");
  controls();
  const id = selected;
  try {
    const state = await api(`sessions/${id}/snapshot`);
    if (selected !== id) return;
    snapshot(state);
    stream = new EventSource(new URL(`api/sessions/${id}/events`, base));
    stream.onopen = () => {
      if (selected === id) $("connection").textContent = "Connected";
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
      if (selected === id) $("connection").textContent = "Reconnecting…";
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
  }
}
$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy || sending || pending()) return;
  const content = $("message").value.trim();
  if (!content) return;
  if (/^\/login\b/.test(content)) {
    const command = /^\/login(?:\s+(anthropic|openai-codex))?$/.exec(content);
    const loginProvider =
      provider === "anthropic" ? "anthropic" : "openai-codex";
    if (
      !command ||
      (command[1] && command[1] !== loginProvider) ||
      provider === "local"
    ) {
      feedback(
        "Use /login with the subscription provider selected in App configuration.",
      );
      return;
    }
    $("message").value = "";
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
async function newSession(kind) {
  const title = window.prompt(
    "Session title",
    kind === "workspace" ? "A private coding workspace" : "A thoughtful home",
  );
  if (!title) return;
  try {
    const result = await api("sessions", {
      title,
      kind,
      requestId: crypto.randomUUID(),
    });
    await listSessions();
    await select({ id: result.id, title, kind });
    await listSessions();
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
  busy = false;
  $("title").textContent = "A little warmth. A little more certainty.";
  $("safety").textContent = "Read-only by default";
  $("task-status").textContent = "Choose a session";
  $("usage").textContent = "No model usage yet";
  $("active-model").textContent = "Choose a session";
  $("messages").replaceChildren();
  $("approvals").replaceChildren();
  renderCanvas($("home-canvas"), null, draftQuestion);
  controls();
}
async function deleteSession() {
  if (!selected) return;
  const id = selected,
    title = $("title").textContent;
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
$("delete-session").addEventListener("click", () => {
  void deleteSession();
});
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
          await api("auth/answer", { id: loginId, value: option.id });
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
  try {
    const status = await api("auth/status"),
      login = status.login,
      prompt = login?.prompt;
    loginId = login?.id ?? "";
    const pending = !!login && ["starting", "waiting"].includes(login.state);
    const anthropic = status.provider === "anthropic";
    $("account-title").textContent = status.providerName;
    $("account-details").textContent = anthropic
      ? "Experimental Pi Anthropic OAuth with pi-anthropic-auth 3.4.2 compatibility. Credentials stay in the controller, never the coding workspace. Provider terms apply; third-party usage may incur extra per-token billing. Login does not guarantee included Claude plan usage."
      : "Official Pi OAuth. Credentials stay in the controller, never the coding workspace. Your subscription's limits apply. API-key billing is separate.";
    $("account-config").textContent =
      `Select provider ${status.provider} in App configuration. Signing out removes only this App's credential; it does not revoke your account.`;
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
function openAccount() {
  if (provider === "local") {
    $("local-dialog").showModal();
    void refreshLocal();
    return;
  }
  $("account-dialog").showModal();
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
});
$("account-close").addEventListener("click", () => $("account-dialog").close());
async function startLogin() {
  try {
    await api("auth/login", {});
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
    await api("auth/answer", { id: loginId, value });
    await refreshAccount();
  } catch (error) {
    $("account-status").textContent = error.message;
  }
});
$("login-cancel").addEventListener("click", async () => {
  try {
    await api("auth/cancel", { id: loginId });
    await refreshAccount();
  } catch (e) {
    $("account-status").textContent = e.message;
  }
});
$("login-verify").addEventListener("click", async () => {
  $("login-verify").disabled = true;
  try {
    await api("auth/verify", {});
    await refreshAccount();
  } catch (e) {
    $("account-status").textContent = e.message;
  } finally {
    $("login-verify").disabled = false;
  }
});
$("login-logout").addEventListener("click", async () => {
  if (
    !window.confirm(
      `Remove this App's local ${provider === "anthropic" ? "Anthropic" : "ChatGPT"} credential? This does not revoke your provider account.`,
    )
  )
    return;
  try {
    await api("auth/logout", {});
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
  const modelId = $("model-choice").value;
  const thinkingLevel = $("thinking-choice").value;
  applyingModel = true;
  controls();
  try {
    await api(`sessions/${id}/model`, { modelId, thinkingLevel, revision });
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
// Local endpoints can add or replace models without an App restart.
async function loadModels() {
  modelChoices = (await api("models")).items;
  const choices = document.createDocumentFragment();
  for (const model of modelChoices) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.name} (${model.id})`;
    choices.append(option);
  }
  $("model-choice").replaceChildren(choices);
  controls();
}
try {
  await bootstrap();
  await loadModels();
  const sessions = await listSessions();
  $("connection").textContent = "Connected";
  if (sessions.length) {
    await select(sessions[sessions.length - 1]);
    await listSessions();
  }
} catch {
  $("connection").textContent = "Unavailable";
  feedback(
    "Authentication or server unavailable. Local mode uses username hearth and the configured password. Reload to reconnect.",
  );
}
window.addEventListener("pagehide", () => {
  stream?.close();
  clearInterval(accountTimer);
});
