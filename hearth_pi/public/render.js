export function node(tag, value = "", className = "") {
  const element = document.createElement(tag);
  element.textContent = String(value);
  if (className) element.className = className;
  return element;
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
function assistantBody(message) {
  if (typeof message.content === "string")
    return [renderMarkdown(message.content)];
  const parts = [];
  for (const block of message.content ?? []) {
    if (block.type === "text" && block.text)
      parts.push(renderMarkdown(block.text));
    else if (
      block.type === "toolCall" &&
      /^app_(create|update)$/.test(block.name)
    ) {
      // App specs are long: name the call, keep the exact arguments one tap away.
      const details = node("details", "", "tool-call-details");
      details.append(
        node("summary", `${block.name} · arguments`),
        node("pre", JSON.stringify(block.arguments, null, 2), "tool-call"),
      );
      parts.push(details);
    } else if (block.type === "toolCall")
      parts.push(
        node(
          "pre",
          `${block.name} ${JSON.stringify(block.arguments)}`,
          "tool-call",
        ),
      );
  }
  return parts;
}
// special(message) may return a trusted card (e.g. an app result) that
// replaces the raw rendering of that message.
export function renderMessages(container, snapshot, special = () => null) {
  const fragment = document.createDocumentFragment();
  for (const entry of snapshot.view.entries) {
    for (const message of entry.model ?? []) {
      if (message.role === "system") continue;
      const card = special(message);
      if (card) {
        fragment.append(card);
        continue;
      }
      const value = messageText(message);
      if (!value && !message.errorMessage) continue;
      const role =
        message.role === "toolResult"
          ? "Tool result"
          : message.role === "user"
            ? "You"
            : "Hearth Pi";
      const article = node(
        "article",
        "",
        `message ${message.role === "user" ? "user" : message.role === "toolResult" ? "tool" : "assistant"}`,
      );
      article.append(node("h3", role));
      if (value)
        article.append(
          ...(message.role === "assistant"
            ? assistantBody(message)
            : [node("pre", value)]),
        );
      if (message.stopReason === "error" || message.stopReason === "aborted") {
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
      fragment.append(article);
    }
  }
  const live = snapshot.view.docs["pi.live"] ?? {};
  if (live.generation?.message) {
    const article = node("article", "", "message assistant live");
    article.append(
      node("h3", "Hearth Pi · committed partial"),
      ...assistantBody(live.generation.message),
    );
    fragment.append(article);
  }
  for (const tool of live.tools ?? []) {
    const article = node("article", "", "message tool");
    article.append(
      node("h3", `${tool.name} · ${tool.status}`),
      node("pre", tool.output ?? ""),
    );
    fragment.append(article);
  }
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
