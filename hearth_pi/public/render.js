export function node(tag, value = "", className = "") {
  const element = document.createElement(tag);
  element.textContent = String(value);
  if (className) element.className = className;
  return element;
}
function button(label, className = "", aria = "") {
  const element = node("button", label, className);
  element.type = "button";
  if (aria) element.setAttribute("aria-label", aria);
  return element;
}
function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
export function messageText(message) {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "toolCall")
        return `${block.name}\n${JSON.stringify(block.arguments, null, 2)}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
// Minimal markdown for assistant prose, built from DOM nodes only (never an
// HTML string): headings, paragraphs, bullet/numbered lists, fenced code,
// inline code, bold and italic. Everything else stays literal text. Links
// and images are deliberately not supported.
function inline(parent, text) {
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last)
      parent.append(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith("`")) parent.append(node("code", token.slice(1, -1)));
    else if (token.startsWith("**") || token.startsWith("__"))
      parent.append(node("strong", token.slice(2, -2)));
    else parent.append(node("em", token.slice(1, -1)));
    last = match.index + token.length;
  }
  if (last < text.length)
    parent.append(document.createTextNode(text.slice(last)));
}
export function renderMarkdown(text) {
  const root = node("div", "", "md");
  const lines = String(text).split("\n");
  let paragraph = [],
    list = null;
  const flush = () => {
    if (paragraph.length) {
      const p = node("p");
      paragraph.forEach((line, i) => {
        if (i) p.append(node("br"));
        inline(p, line);
      });
      root.append(p);
      paragraph = [];
    }
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      flush();
      const body = [];
      for (i++; i < lines.length && !/^```/.test(lines[i].trim()); i++)
        body.push(lines[i]);
      root.append(node("pre", body.join("\n"), "md-code"));
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const h = node(`h${Math.min(heading[1].length + 3, 6)}`, "", "md-h");
      inline(h, heading[2]);
      root.append(h);
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      if (paragraph.length) flush();
      const kind = item[1] ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== kind) {
        list = node(kind);
        root.append(list);
      }
      const li = node("li");
      inline(li, item[3]);
      list.append(li);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      const li = list.lastElementChild;
      li.append(node("br"));
      inline(li, line.trim());
      continue;
    }
    list = null;
    paragraph.push(line);
  }
  flush();
  return root;
}
// Friendly, calm labels for known tools so a transcript reads like "Searched
// home · read 3 devices" instead of raw tool names and JSON. Unknown tools
// fall back to their raw name (fallbackMeta) so nothing is ever hidden.
const TOOL_META = {
  ha_search_states: {
    icon: "🔍",
    label: "Searched home",
    phrase: (n) => (n > 1 ? `Searched home ×${n}` : "Searched home"),
    args: (a) =>
      a?.query
        ? `Query “${truncate(a.query, 60)}”`
        : "Browsed allowed entities",
  },
  ha_state_detail: {
    icon: "📟",
    label: "Read a device",
    phrase: (n) => (n > 1 ? `Read ${n} devices` : "Read a device"),
    args: (a) => (a?.entityId ? `Entity ${a.entityId}` : ""),
  },
  ha_discover_services: {
    icon: "🧰",
    label: "Checked available actions",
    phrase: () => "Checked available actions",
    args: () => "",
  },
  ha_propose_service: {
    icon: "⚡",
    label: "Proposed an action",
    phrase: (n) => (n > 1 ? `Proposed ${n} actions` : "Proposed an action"),
    args: (a) => [a?.service, a?.entityId].filter(Boolean).join(" · "),
  },
  suggest_memory: {
    icon: "💡",
    label: "Suggested a memory",
    phrase: (n) => (n > 1 ? `Suggested ${n} memories` : "Suggested a memory"),
    args: (a) => (a?.text ? `“${truncate(a.text, 80)}” · review in Today` : ""),
  },
  suggest_app_change: {
    icon: "💡",
    label: "Suggested an app change",
    phrase: (n) =>
      n > 1 ? `Suggested ${n} app changes` : "Suggested an app change",
    args: (a) =>
      a?.summary ? `${truncate(a.summary, 80)} · review in Today` : "",
  },
  ha_automation_config: {
    icon: "🤖",
    label: "Read an automation",
    phrase: (n) => (n > 1 ? `Read ${n} automations` : "Read an automation"),
    args: (a) => (a?.entityId ? `Automation ${a.entityId}` : ""),
  },
  ha_automation_traces: {
    icon: "🧭",
    label: "Checked recent runs",
    phrase: (n) => (n > 1 ? `Checked runs ×${n}` : "Checked recent runs"),
    args: (a) =>
      a?.entityId
        ? `Automation ${a.entityId}${a.limit ? ` · last ${a.limit}` : ""}`
        : "",
  },
  ha_automation_trace_detail: {
    icon: "🔬",
    label: "Read one run step by step",
    phrase: (n) =>
      n > 1 ? `Read ${n} runs step by step` : "Read one run step by step",
    args: (a) =>
      [a?.entityId, a?.runId ? `run ${truncate(a.runId, 12)}` : ""]
        .filter(Boolean)
        .join(" · "),
  },
  ha_automation_activity: {
    icon: "📜",
    label: "Checked logbook and history",
    phrase: () => "Checked logbook and history",
    args: (a) =>
      a?.entityId
        ? `Automation ${a.entityId}${a.hours ? ` · last ${a.hours} h` : ""}`
        : "",
  },
  ha_build_view: {
    icon: "🧩",
    label: "Built a home view",
    phrase: () => "Built a home view",
    args: (a) => (a?.title ? `“${truncate(a.title, 60)}”` : ""),
  },
  app_create: {
    icon: "🧱",
    label: "Created an app",
    phrase: (n) => (n > 1 ? `Created ${n} apps` : "Created an app"),
    args: (a) =>
      typeof a?.spec?.title === "string"
        ? `“${truncate(a.spec.title, 60)}”`
        : "",
  },
  app_update: {
    icon: "🛠️",
    label: "Updated an app",
    phrase: (n) => (n > 1 ? `Updated apps ×${n}` : "Updated an app"),
    args: (a) => (a?.appId ? `App ${a.appId}` : ""),
  },
  app_get: {
    icon: "📄",
    label: "Read an app",
    phrase: (n) => (n > 1 ? `Read ${n} apps` : "Read an app"),
    args: (a) => (a?.appId ? `App ${a.appId}` : ""),
  },
  app_list: {
    icon: "📋",
    label: "Listed apps",
    phrase: () => "Listed apps",
    args: () => "",
  },
  catalog_describe: {
    icon: "📚",
    label: "Looked up the app catalog",
    phrase: () => "Looked up the app catalog",
    args: () => "",
  },
  read: {
    icon: "📖",
    label: "Read a file",
    phrase: (n) => (n > 1 ? `Read ${n} files` : "Read a file"),
    args: (a) => a?.path ?? "",
  },
  write: {
    icon: "✏️",
    label: "Wrote a file",
    phrase: (n) => (n > 1 ? `Wrote ${n} files` : "Wrote a file"),
    args: (a) => a?.path ?? "",
  },
  edit: {
    icon: "✏️",
    label: "Edited a file",
    phrase: (n) => (n > 1 ? `Edited ${n} files` : "Edited a file"),
    args: (a) => a?.path ?? "",
  },
  bash: {
    icon: "💻",
    label: "Ran a command",
    phrase: (n) => (n > 1 ? `Ran ${n} commands` : "Ran a command"),
    args: (a) => (a?.command ? truncate(String(a.command), 80) : ""),
  },
  powershell: {
    icon: "💻",
    label: "Ran a command",
    phrase: (n) => (n > 1 ? `Ran ${n} commands` : "Ran a command"),
    args: (a) => (a?.command ? truncate(String(a.command), 80) : ""),
  },
  grep: {
    icon: "🔎",
    label: "Searched files",
    phrase: (n) => (n > 1 ? `Searched files ×${n}` : "Searched files"),
    args: (a) => a?.pattern ?? "",
  },
  find: {
    icon: "🔎",
    label: "Found files",
    phrase: (n) => (n > 1 ? `Found files ×${n}` : "Found files"),
    args: (a) => a?.pattern ?? "",
  },
  ls: {
    icon: "📁",
    label: "Listed files",
    phrase: (n) => (n > 1 ? `Listed files ×${n}` : "Listed files"),
    args: (a) => a?.path ?? "",
  },
};
function fallbackMeta(name) {
  const label = name || "Tool";
  return {
    icon: "🔧",
    label,
    phrase: (n) => (n > 1 ? `${label} ×${n}` : label),
    args: (a) =>
      a && Object.keys(a).length ? truncate(JSON.stringify(a), 80) : "",
  };
}
const toolMeta = (name) => TOOL_META[name] ?? fallbackMeta(name);
function toolResultText(message) {
  return (message?.content ?? [])
    .map((b) =>
      b.type === "text" ? b.text : b.type === "image" ? "[image omitted]" : "",
    )
    .filter(Boolean)
    .join("\n");
}
function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
const RESULT_PREVIEW_LIMIT = 600;
// Pretty, truncated, monospace tool result with an explicit "Show more" to
// reveal the rest; nothing is ever written as HTML.
function buildResultBlock(message) {
  const raw = toolResultText(message);
  const pretty = raw ? prettyJson(raw) : "(no output)";
  const wrap = node("div", "", "tool-result");
  const truncated = pretty.length > RESULT_PREVIEW_LIMIT;
  const pre = node(
    "pre",
    truncated ? `${pretty.slice(0, RESULT_PREVIEW_LIMIT)}…` : pretty,
    "tool-result-pre",
  );
  wrap.append(pre);
  if (truncated) {
    const more = button("Show more", "tool-result-more");
    more.addEventListener("click", () => {
      pre.textContent = pretty;
      more.remove();
    });
    wrap.append(more);
  }
  return wrap;
}
function buildCallRow(call) {
  const meta = toolMeta(call.name);
  const isError = !!call.result?.isError;
  const row = node(
    "div",
    "",
    `activity-call${isError ? " activity-call-error" : ""}`,
  );
  row.append(node("div", `${meta.icon} ${meta.label}`, "activity-call-head"));
  const argSummary = truncate(meta.args(call.arguments) || "", 160);
  if (argSummary)
    row.append(node("p", argSummary, "activity-call-args tool-call"));
  if (call.result) {
    if (isError)
      row.append(
        node("p", "⚠️ This step reported an error.", "activity-call-warning"),
      );
    row.append(buildResultBlock(call.result));
  } else {
    row.append(node("p", "No result recorded for this step.", "muted"));
  }
  return row;
}
// One collapsed line per group of first-occurrence tool names, e.g.
// "🔍 Searched home · read 3 devices · built a home view".
function headerSummary(calls) {
  const order = [];
  const counts = new Map();
  for (const call of calls) {
    if (!counts.has(call.name)) order.push(call.name);
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  }
  const parts = order.map((name) => toolMeta(name).phrase(counts.get(name)));
  return `${toolMeta(order[0]).icon} ${parts.join(" · ")}`;
}
// Group one assistant turn's tool calls and their results into one compact,
// collapsed-by-default activity row. Errors stay visible in the summary line
// even while collapsed.
function buildActivity(calls, extraClass = "") {
  const hasError = calls.some((call) => call.result?.isError);
  const article = node(
    "article",
    "",
    `message activity${hasError ? " activity-error" : ""}${extraClass ? ` ${extraClass}` : ""}`,
  );
  const details = node("details", "", "activity-details");
  const summary = node("summary", "", "activity-summary");
  summary.append(node("span", headerSummary(calls), "activity-summary-text"));
  if (hasError)
    summary.append(node("span", "⚠️ issue", "activity-summary-warning"));
  details.append(summary);
  const body = node("div", "", "activity-body");
  for (const call of calls) body.append(buildCallRow(call));
  details.append(body);
  article.append(details);
  return article;
}
// Single animated "Working…" line for the tool round currently running,
// expandable to see every step. Respects prefers-reduced-motion in CSS.
function buildLiveActivity(tools) {
  if (!tools.length) return null;
  const active =
    tools.find((t) => t.status === "running") ??
    tools.find((t) => t.status === "pending") ??
    tools[tools.length - 1];
  const meta = toolMeta(active.name);
  const article = node("article", "", "message activity activity-live live");
  const details = node("details", "", "activity-details");
  const summary = node("summary", "", "activity-summary activity-live-line");
  summary.append(node("span", "Working", "activity-live-text"));
  const dots = node("span", "", "activity-live-dots");
  dots.append(node("span", ".", "activity-live-dot"));
  dots.append(node("span", ".", "activity-live-dot"));
  dots.append(node("span", ".", "activity-live-dot"));
  summary.append(dots);
  summary.append(
    node("span", `${meta.icon} ${meta.label}`, "activity-live-step"),
  );
  details.append(summary);
  const body = node("div", "", "activity-body");
  for (const tool of tools) {
    const row = node("div", "", "activity-call");
    row.append(
      node(
        "div",
        `${toolMeta(tool.name).icon} ${toolMeta(tool.name).label} · ${tool.status}`,
        "activity-call-head",
      ),
    );
    if (tool.output)
      row.append(node("pre", truncate(tool.output, 600), "tool-result-pre"));
    body.append(row);
  }
  details.append(body);
  article.append(details);
  return article;
}
function blocksOf(message) {
  if (typeof message.content === "string")
    return message.content ? [{ type: "text", text: message.content }] : [];
  return message.content ?? [];
}
async function copyAssistantText(text, copyButton) {
  const original = copyButton.textContent;
  const finish = (label) => {
    copyButton.textContent = label;
    setTimeout(() => {
      copyButton.textContent = original;
    }, 1500);
  };
  const legacyFallback = () => {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select?.();
      const ok = document.execCommand?.("copy");
      area.remove();
      finish(ok ? "Copied" : "Copy failed");
    } catch {
      finish("Copy failed");
    }
  };
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      finish("Copied");
    } catch {
      legacyFallback();
    }
  } else {
    legacyFallback();
  }
}
// Claude-style plain assistant text: no heavy card, a small label and a copy
// button instead of a bordered panel.
function buildAssistantText(text, extraClass = "") {
  const article = node(
    "article",
    "",
    `message assistant${extraClass ? ` ${extraClass}` : ""}`,
  );
  const head = node("div", "", "message-head");
  head.append(node("span", "Hearth", "message-label"));
  const copy = button("Copy", "message-copy", "Copy this reply");
  copy.addEventListener("click", () => void copyAssistantText(text, copy));
  head.append(copy);
  article.append(head, renderMarkdown(text));
  return article;
}
function appendTurnError(article, message) {
  article.append(
    node(
      "p",
      "Model turn did not complete. No action outcome can be inferred.",
      "error",
    ),
  );
  // Controller-fixed reason (never raw provider text); rendered as text.
  if (message.errorMessage)
    article.append(node("p", message.errorMessage, "muted"));
}
// special(message) may return a trusted card (e.g. an app result) that
// replaces the raw rendering of that message.
// decorate(entry, message) may return an element appended to a committed
// assistant reply (feedback controls).
export function renderMessages(
  container,
  snapshot,
  special = () => null,
  decorate = () => null,
) {
  const fragment = document.createDocumentFragment();
  // Open tool-call group for the turn in progress: filled by assistant
  // toolCall blocks, then matched with their toolResult by call id.
  let pending = null;
  const flushPending = () => {
    if (pending && pending.calls.length)
      fragment.append(buildActivity(pending.calls));
    pending = null;
  };
  const openPending = () => (pending ??= { calls: [] });
  for (const entry of snapshot.view.entries) {
    for (const message of entry.model ?? []) {
      if (message.role === "system") continue;
      const card = special(message);
      if (card) {
        flushPending();
        fragment.append(card);
        continue;
      }
      if (message.role === "toolResult") {
        const target = pending?.calls.find(
          (call) => call.id && call.id === message.toolCallId,
        );
        if (target) target.result = message;
        else
          openPending().calls.push({
            id: message.toolCallId,
            name: message.toolName,
            arguments: undefined,
            result: message,
          });
        continue;
      }
      if (message.role === "assistant") {
        let reply = null;
        for (const block of blocksOf(message)) {
          if (block.type === "text" && block.text) {
            flushPending();
            reply = buildAssistantText(block.text);
            fragment.append(reply);
          } else if (block.type === "toolCall") {
            openPending().calls.push({
              id: block.id,
              name: block.name,
              arguments: block.arguments,
              result: null,
            });
          }
        }
        if (
          message.stopReason === "error" ||
          message.stopReason === "aborted"
        ) {
          flushPending();
          const article = node("article", "", "message assistant");
          appendTurnError(article, message);
          fragment.append(article);
        } else if (reply) {
          const extra = decorate(entry, message);
          if (extra) reply.append(extra);
        }
        continue;
      }
      // user message (or any other future role): render as plain text.
      flushPending();
      const value = messageText(message);
      if (!value && !message.errorMessage) continue;
      const article = node("article", "", "message user");
      article.append(node("h3", "You"), node("pre", value));
      fragment.append(article);
    }
  }
  flushPending();
  const live = snapshot.view.docs["pi.live"] ?? {};
  if (live.generation?.message) {
    const blocks = blocksOf(live.generation.message);
    const text = blocks
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n");
    if (text) fragment.append(buildAssistantText(text, "live"));
    const toolBlocks = blocks.filter((b) => b.type === "toolCall");
    if (toolBlocks.length)
      fragment.append(
        buildActivity(
          toolBlocks.map((b) => ({
            id: b.id,
            name: b.name,
            arguments: b.arguments,
            result: null,
          })),
          "live",
        ),
      );
  }
  const liveTools = buildLiveActivity(live.tools ?? []);
  if (liveTools) fragment.append(liveTools);
  container.replaceChildren(fragment);
}
export function renderCanvas(container, canvas, ask) {
  const fragment = document.createDocumentFragment();
  if (!canvas) {
    const welcome = node("div", "", "canvas-empty");
    welcome.append(
      node("h3", "Let Hearth build your home view."),
      node(
        "p",
        "Ask for a useful status view. Hearth chooses a layout; the controller reads exact approved HA entities and saves the result through Pi Durable. No fixtures or device actions.",
      ),
    );
    fragment.append(welcome);
  } else {
    const heading = node("div", "", "canvas-heading");
    const summary = node("div");
    summary.append(
      node("h3", canvas.title),
      node(
        "p",
        `Saved ${new Date(canvas.committedAt).toLocaleString()} · HA observations, not continuously live`,
        "muted",
      ),
    );
    const refresh = node("button", "Ask Hearth to refresh", "canvas-question");
    refresh.type = "button";
    refresh.addEventListener("click", () =>
      ask(
        "Refresh the saved Home canvas using ha_build_view and the same exact entity IDs. Read fresh states; do not call services. If an ID is no longer allowed, explain that instead of guessing.",
      ),
    );
    heading.append(summary, refresh);
    fragment.append(heading);
    for (const section of canvas.sections.slice(0, 4)) {
      const area = node("section", "", "canvas-section");
      area.append(node("h4", section.title));
      const cards = node("div", "", "canvas-grid");
      for (const reading of section.readings.slice(0, 8)) {
        const card = node("article", "", "canvas-card");
        card.append(
          node("h5", reading.attributes.friendly_name ?? reading.entityId),
          node(
            "strong",
            `${reading.state}${reading.attributes.unit_of_measurement ? ` ${reading.attributes.unit_of_measurement}` : ""}`,
            "canvas-value",
          ),
          node("code", reading.entityId),
          node(
            "p",
            `HA read ${new Date(reading.observedAt).toLocaleString()} · saved observation`,
            "muted",
          ),
        );
        const explain = node("button", "Ask about this", "canvas-question");
        explain.type = "button";
        explain.addEventListener("click", () =>
          ask(
            `Read ${reading.entityId} now and explain its state. Compare only with observed earlier evidence in this session; do not infer physical effects or call services.`,
          ),
        );
        card.append(explain);
        cards.append(card);
      }
      area.append(cards);
      fragment.append(area);
    }
  }
  container.replaceChildren(fragment);
}
export function renderProposals(
  container,
  proposals,
  decide,
  canApprove = true,
) {
  const fragment = document.createDocumentFragment();
  for (const proposal of Object.values(proposals).sort(
    (a, b) => b.created - a.created,
  )) {
    const card = node("article", "", "action-card");
    card.append(
      node("h3", `${proposal.action.service} · ${proposal.status}`),
      node("p", proposal.action.entityId),
      node("pre", JSON.stringify(proposal.action.data, null, 2)),
    );
    if (proposal.origin?.kind === "app")
      card.append(
        node(
          "p",
          `Requested by you from app ${proposal.origin.appId} (control ${proposal.origin.elementId}, v${proposal.origin.version})`,
        ),
      );
    if (proposal.authorization)
      card.append(
        node(
          "p",
          `${proposal.authorization.source === "automatic" ? "Full access / automatic" : "Human review"} · Home permission revision ${proposal.authorization.revision}`,
        ),
      );
    const fingerprint = node("details");
    fingerprint.append(
      node("summary", "Exact immutable fingerprint"),
      node("code", proposal.hash),
    );
    card.append(fingerprint);
    card.append(
      node(
        "p",
        "HA acceptance is a service receipt, not physical-device verification.",
        "muted",
      ),
    );
    if (proposal.status === "pending") {
      card.append(
        node(
          "p",
          `Review expires ${new Date(proposal.expires).toLocaleTimeString()}`,
        ),
      );
      const buttons = node("div", "", "actions");
      for (const [decision, label] of [
        ["approve", "Approve exact action"],
        ["reject", "Reject"],
      ]) {
        const button = node(
          "button",
          label,
          decision === "approve" ? "approve" : "",
        );
        button.type = "button";
        button.disabled =
          proposal.expires <= Date.now() ||
          (decision === "approve" && !canApprove);
        button.addEventListener("click", () => decide(proposal, decision));
        buttons.append(button);
      }
      card.append(buttons);
    }
    if (proposal.status === "unknown") {
      card.append(
        node(
          "p",
          "Outcome unknown. It will not be retried. Check the device yourself.",
          "error",
        ),
      );
      const button = node("button", "Record human reconciliation");
      button.type = "button";
      button.addEventListener("click", () => decide(proposal, "resolve"));
      card.append(button);
    }
    if (proposal.resolution) card.append(node("p", proposal.resolution));
    fragment.append(card);
  }
  container.replaceChildren(fragment);
}
