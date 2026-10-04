import { node, renderMessages, renderProposals } from "./render.js";
const $ = (id) => document.getElementById(id);
const base = new URL("./", window.location.href);
let csrf = "",
  selected = null,
  stream = null,
  busy = false,
  actionSignature = "",
  sending = false,
  inferenceReady = true,
  selectedKind = "home",
  homeSafety = "Read-only · actions disabled",
  loginId = "",
  accountTimer = null;
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
  $("provider").textContent = `${status.provider} · ${status.model}`;
  homeSafety = status.safety;
  inferenceReady = status.inferenceReady;
  $("new-workspace").hidden = !status.workspaceEnabled;
  controls();
}
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
}
function snapshot(value) {
  const area = $("scroll-area"),
    atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
  renderMessages($("messages"), value);
  const signature = JSON.stringify(value.proposals);
  if (signature !== actionSignature) {
    actionSignature = signature;
    renderProposals($("approvals"), value.proposals, decide);
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
  actionSignature = "";
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
try {
  await bootstrap();
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
