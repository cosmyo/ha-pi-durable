import { node, renderMessages, renderProposals } from "./render.js";
const $ = (id) => document.getElementById(id);
const base = new URL("./", window.location.href);
let csrf = "",
  selected = null,
  stream = null,
  busy = false,
  actionSignature = "",
  sending = false;
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
  $("safety").textContent = status.safety;
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
  $("message").disabled = !selected || busy || !!saved || sending;
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
    const button = node("button", session.title, "session");
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
$("new-session").addEventListener("click", async () => {
  const title = window.prompt("Session title", "A thoughtful home");
  if (!title) return;
  try {
    const result = await api("sessions", {
      title,
      requestId: crypto.randomUUID(),
    });
    await listSessions();
    await select({ id: result.id, title });
    await listSessions();
  } catch (error) {
    feedback(error.message);
  }
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
window.addEventListener("pagehide", () => stream?.close());
