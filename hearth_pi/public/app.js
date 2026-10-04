import {
  node,
  renderMessages,
  renderProposals,
  renderCanvas,
} from "./render.js";
const $ = (id) => document.getElementById(id);
const base = new URL("./", window.location.href);
let csrf = "",
  selected = null,
  stream = null,
  busy = false,
  actionSignature = "",
  canvasSignature = "",
  canvasOpen = true,
  sending = false,
  inferenceReady = true,
  selectedKind = "home",
  homeSafety = "Read-only · actions disabled",
  permissions = null,
  loginId = "",
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
  $("message").disabled =
    !selected || busy || !!saved || sending || !inferenceReady;
  $("send").disabled = $("message").disabled;
  $("stop").disabled = !selected || !busy;
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
  $("canvas-toggle").setAttribute("aria-expanded", String(canvasOpen));
  for (const button of document.querySelectorAll(
    ".canvas-question, .home-starters button",
  ))
    button.disabled = $("message").disabled || selectedKind !== "home";
}
function draftQuestion(content) {
  if ($("message").disabled || selectedKind !== "home") return;
  $("message").value = content;
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
  if (!selected || busy || sending || pending()) return;
  const content = $("message").value.trim();
  if (!content) return;
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
async function refreshAccount() {
  try {
    const status = await api("auth/status"),
      login = status.login;
    loginId = login?.id ?? "";
    const pending = !!login && ["starting", "waiting"].includes(login.state);
    $("account-status").textContent = status.configured
      ? "Subscription connected."
      : login?.state === "failed"
        ? "Login failed. Retry or use browser login; device-code access may need enabling in your OpenAI account."
        : pending
          ? "Waiting for you to finish at OpenAI. Do not share the code or redirect URL."
          : "Not signed in.";
    $("login-start").disabled = pending;
    $("login-url").hidden = !login?.url;
    if (login?.url) $("login-url").href = login.url;
    else $("login-url").removeAttribute("href");
    $("login-code").textContent = login?.userCode ?? "";
    $("login-answer").hidden = !login?.manual;
    $("login-cancel").hidden = !pending;
    $("login-logout").hidden = !status.configured;
    await bootstrap();
  } catch {
    $("account-status").textContent =
      "Account service unavailable. No login credentials were displayed.";
  }
}
$("account").addEventListener("click", () => {
  $("account-dialog").showModal();
  void refreshAccount();
  clearInterval(accountTimer);
  accountTimer = setInterval(() => {
    void refreshAccount();
  }, 2000);
});
$("account-dialog").addEventListener("close", () => {
  clearInterval(accountTimer);
  $("login-redirect").value = "";
});
$("account-close").addEventListener("click", () => $("account-dialog").close());
$("login-start").addEventListener("click", async () => {
  try {
    await api("auth/login", { method: $("login-method").value });
    await refreshAccount();
  } catch (e) {
    $("account-status").textContent = e.message;
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
$("login-logout").addEventListener("click", async () => {
  if (
    !window.confirm(
      "Remove this App's local ChatGPT credential? This does not revoke your OpenAI account.",
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
try {
  await bootstrap();
  modelChoices = (await api("models")).items;
  const choices = document.createDocumentFragment();
  for (const model of modelChoices) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.name} (${model.id})`;
    choices.append(option);
  }
  $("model-choice").replaceChildren(choices);
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
