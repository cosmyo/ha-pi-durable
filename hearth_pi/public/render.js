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
export function renderMessages(container, snapshot) {
  const fragment = document.createDocumentFragment();
  for (const entry of snapshot.view.entries) {
    for (const message of entry.model ?? []) {
      if (message.role === "system") continue;
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
      article.append(node("h3", role), node("pre", value));
      if (message.stopReason === "error" || message.stopReason === "aborted")
        article.append(
          node(
            "p",
            "Model turn did not complete. No action outcome can be inferred.",
            "error",
          ),
        );
      fragment.append(article);
    }
  }
  const live = snapshot.view.docs["pi.live"] ?? {};
  if (live.generation?.message) {
    const article = node("article", "", "message assistant live");
    article.append(
      node("h3", "Hearth Pi · committed partial"),
      node("pre", messageText(live.generation.message)),
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
export function renderProposals(container, proposals, decide) {
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
        button.disabled = proposal.expires <= Date.now();
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
