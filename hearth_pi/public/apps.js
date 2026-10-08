// Trusted renderer for HAS/1 household apps. Every string from a spec, Home
// Assistant or household state is untrusted and only ever set as textContent;
// values come from the controller's API response, never from the spec.
import { node } from "./render.js";

const SVG = "http://www.w3.org/2000/svg";
const MAX_DEPTH = 6;
export function timeOf(ms) {
  return Number.isFinite(ms) && ms > 0
    ? new Date(ms).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "unknown time";
}
function button(label, className = "", aria = "") {
  const element = node("button", label, className);
  element.type = "button";
  if (aria) element.setAttribute("aria-label", aria);
  return element;
}
function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}
// "+1 element · −2 elements · entities added: sensor.x" for update cards.
export function diffSummary(diff) {
  if (!diff) return "";
  const parts = [];
  if (diff.added?.length)
    parts.push(`+${plural(diff.added.length, "element")}`);
  if (diff.removed?.length)
    parts.push(`−${plural(diff.removed.length, "element")}`);
  if (diff.changed?.length) parts.push(`${diff.changed.length} changed`);
  if (diff.titleChanged) parts.push("renamed");
  if (diff.entitiesAdded?.length)
    parts.push(`entities added: ${diff.entitiesAdded.join(", ")}`);
  if (diff.entitiesRemoved?.length)
    parts.push(`entities removed: ${diff.entitiesRemoved.join(", ")}`);
  if (diff.watchersAdded?.length)
    parts.push(`watchers added: ${diff.watchersAdded.join(", ")}`);
  if (diff.watchersRemoved?.length)
    parts.push(`watchers removed: ${diff.watchersRemoved.join(", ")}`);
  return parts.join(" · ") || "No visible change";
}
function appCard(item, handlers, compact = false) {
  const card = node("article", "", compact ? "app-card compact" : "app-card");
  const open = button("", "app-card-open", `Open ${item.title}`);
  open.append(node("strong", item.title, "app-card-title"));
  if (item.summary && !compact)
    open.append(node("span", item.summary, "app-card-summary"));
  open.append(
    node(
      "span",
      `v${item.version}${item.pinned ? " · pinned" : ""}`,
      "app-card-meta",
    ),
  );
  open.addEventListener("click", () => handlers.open(item.id));
  card.append(open);
  if (!compact) {
    const pin = button(
      item.pinned ? "Unpin" : "Pin",
      "app-card-pin",
      `${item.pinned ? "Unpin" : "Pin"} ${item.title}`,
    );
    pin.setAttribute("aria-pressed", String(!!item.pinned));
    pin.addEventListener("click", () => handlers.pin(item.id, !item.pinned));
    card.append(pin);
  }
  return card;
}
// The four built-in starting templates (src/app-spec.ts TEMPLATES), offered
// as one-tap drafts when the household has no apps yet. Each only drafts a
// message into the composer; you still review and press Send.
const APP_TEMPLATE_SUGGESTIONS = [
  "Laundry",
  "Bedtime lock-up",
  "3D print monitor",
  "Maintenance checklist",
];
export function renderAppList(container, items, handlers) {
  const fragment = document.createDocumentFragment();
  if (!items.length) {
    const empty = node("div", "", "app-empty");
    empty.append(
      node(
        "p",
        "No apps yet. Pick a starting point below, or describe your own in a chat.",
        "muted",
      ),
    );
    const suggestions = node("div", "", "app-suggestions");
    for (const name of APP_TEMPLATE_SUGGESTIONS) {
      const suggest = button(name, "chip", `Make me a ${name} app`);
      suggest.addEventListener("click", () =>
        handlers.draft(`Make me a ${name} app`),
      );
      suggestions.append(suggest);
    }
    empty.append(suggestions);
    fragment.append(empty);
  }
  for (const item of items) fragment.append(appCard(item, handlers));
  container.replaceChildren(fragment);
}
export function renderPinnedApps(container, items, handlers) {
  const pinned = items.filter((i) => i.pinned);
  const fragment = document.createDocumentFragment();
  if (pinned.length) {
    fragment.append(node("h3", "Pinned apps", "pinned-heading"));
    const row = node("div", "", "pinned-row");
    for (const item of pinned) row.append(appCard(item, handlers, true));
    fragment.append(row);
  }
  container.replaceChildren(fragment);
  container.hidden = !pinned.length;
}
// Compact transcript card for an app_create/app_update tool result.
export function renderAppResult(message, handlers) {
  let result;
  try {
    result = JSON.parse(
      (message.content ?? []).find((b) => b.type === "text")?.text ?? "",
    );
  } catch {
    return null;
  }
  if (!result || result.ok !== true || typeof result.appId !== "string")
    return null;
  const created = message.toolName === "app_create";
  const card = node("article", "", "message app-result");
  card.append(
    node(
      "h3",
      `${created ? "App created" : "App updated"} · v${result.version}`,
    ),
    node("strong", result.title, "app-result-title"),
  );
  if (result.summary) card.append(node("p", result.summary, "muted"));
  if (!created) card.append(node("p", diffSummary(result.diff), "app-diff"));
  else
    card.append(
      node(
        "p",
        `${plural(result.elements ?? 0, "element")} · ${plural(result.entities?.length ?? 0, "entity", "entities")} bound`,
        "app-diff",
      ),
    );
  if (result.warnings?.length)
    card.append(node("p", result.warnings.join(" "), "muted"));
  card.append(
    node(
      "p",
      "Layout by the model. Hearth reads every value when you open it; only you press its controls.",
      "muted app-result-note",
    ),
  );
  const actions = node("div", "", "actions");
  const open = button("Open", "approve", `Open ${result.title}`);
  open.addEventListener("click", () => handlers.open(result.appId));
  const pin = button("Pin", "", `Pin ${result.title}`);
  pin.addEventListener("click", () => handlers.pin(result.appId, true));
  actions.append(open, pin);
  card.append(actions);
  return card;
}
function valueText(value, attribute) {
  if (!value) return { text: "Unavailable", available: false };
  if (!value.available)
    return {
      text:
        value.reason === "not_in_read_scope"
          ? "Unavailable (not in read scope)"
          : "Unavailable",
      available: false,
    };
  const raw = attribute ? value.attributes?.[attribute] : value.state;
  if (raw === undefined || raw === "") return { text: "—", available: true };
  const unit = attribute ? "" : value.attributes?.unit_of_measurement;
  return {
    text: `${raw}${typeof unit === "string" && unit ? ` ${unit}` : ""}`,
    available: true,
  };
}
function asOfLine(value) {
  return node(
    "span",
    value?.available ? `as of ${timeOf(value.observedAt)}` : "",
    "app-asof",
  );
}
function nameFor(props, value) {
  return (
    props.label ||
    (typeof value?.attributes?.friendly_name === "string"
      ? value.attributes.friendly_name
      : "") ||
    props.entity
  );
}
function chart(series) {
  const box = node("div", "", "app-chart");
  for (const line of series) {
    if (line.kind === "numeric") {
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("viewBox", "0 0 300 80");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("class", "app-chart-svg");
      svg.setAttribute(
        "aria-label",
        `${line.entityId} from ${line.min} to ${line.max}${line.unit ? ` ${line.unit}` : ""}`,
      );
      svg.setAttribute("role", "img");
      const span = line.max - line.min || 1;
      const points = line.points
        .map(([, v], i) =>
          v === null || !Number.isFinite(v)
            ? null
            : `${((i / Math.max(1, line.points.length - 1)) * 300).toFixed(1)},${(76 - ((v - line.min) / span) * 72).toFixed(1)}`,
        )
        .filter(Boolean)
        .join(" ");
      const poly = document.createElementNS(SVG, "polyline");
      poly.setAttribute("points", points);
      poly.setAttribute("class", "app-chart-line");
      svg.append(poly);
      box.append(
        svg,
        node(
          "span",
          `${line.entityId} · min ${line.min} · max ${line.max}${line.unit ? ` ${line.unit}` : ""}`,
          "app-asof",
        ),
      );
    } else if (line.kind === "changes") {
      const list = node("ol", "", "app-changes");
      for (const [at, state] of line.changes.slice(-12))
        list.append(node("li", `${timeOf(at)} · ${state}`));
      box.append(node("span", line.entityId, "app-asof"), list);
    } else
      box.append(
        node(
          "p",
          `${line.entityId}: history unavailable${line.reason === "not_in_read_scope" ? " (not in read scope)" : ""}`,
          "muted",
        ),
      );
  }
  return box;
}
// Renders one validated app response. handlers: ask(prompt), state(key, body),
// toggle(elementId), plus optional ui {tabs: Map} to keep the open tab.
export function renderApp(container, data, handlers, ui = { tabs: new Map() }) {
  const spec = data.spec;
  const fragment = document.createDocumentFragment();
  const head = node("div", "", "app-head");
  if (spec.summary) head.append(node("p", spec.summary, "app-summary"));
  head.append(
    node(
      "p",
      `Values read by Hearth from Home Assistant as of ${timeOf(data.observedAt)} · v${data.app.version}`,
      "app-asof",
    ),
  );
  fragment.append(head);
  if (data.needsRepair) {
    const repair = node("div", "", "app-repair");
    repair.append(
      node(
        "p",
        "Needs repair: part of this app is outside Hearth's current scope. Those parts show Unavailable.",
      ),
    );
    for (const error of data.repair ?? [])
      repair.append(node("p", `${error.path}: ${error.message}`, "muted"));
    fragment.append(repair);
  }
  const seen = new Set();
  const render = (id, depth) => {
    const element = spec.elements[id];
    if (!element || seen.has(id) || depth > MAX_DEPTH)
      return node("p", "Unsupported block", "app-unsupported");
    seen.add(id);
    const props = element.props ?? {};
    const kids = () =>
      (element.children ?? []).map((c) => render(c, depth + 1));
    const value = props.entity ? data.values?.[props.entity] : undefined;
    switch (element.type) {
      case "Stack": {
        const box = node("div", "", "app-stack");
        box.append(...kids());
        return box;
      }
      case "Grid": {
        const box = node(
          "div",
          "",
          `app-grid cols-${Math.min(3, Math.max(1, Number(props.columns) || 1))}`,
        );
        box.append(...kids());
        return box;
      }
      case "Card":
      case "Section": {
        const box = node(
          "section",
          "",
          element.type === "Card" ? "app-block app-card-block" : "app-block",
        );
        if (props.title) box.append(node("h3", props.title));
        box.append(...kids());
        return box;
      }
      case "Tabs": {
        const box = node("div", "", "app-tabs");
        const list = node("div", "", "app-tablist");
        list.setAttribute("role", "tablist");
        const panels = kids();
        const current = Math.min(ui.tabs.get(id) ?? 0, panels.length - 1);
        panels.forEach((panel, i) => {
          const tab = button(
            String(props.labels?.[i] ?? `Tab ${i + 1}`),
            "app-tab",
          );
          tab.setAttribute("role", "tab");
          tab.setAttribute("aria-selected", String(i === current));
          tab.addEventListener("click", () => {
            ui.tabs.set(id, i);
            for (const [j, p] of panels.entries()) p.hidden = j !== i;
            for (const t of list.children)
              t.setAttribute("aria-selected", String(t === tab));
          });
          list.append(tab);
          panel.hidden = i !== current;
        });
        box.append(list, ...panels);
        return box;
      }
      case "Text": {
        const tag =
          props.variant === "h1" ? "h2" : props.variant === "h2" ? "h3" : "p";
        return node(tag, props.text, `app-text ${props.variant ?? "body"}`);
      }
      case "EntityValue": {
        const box = node("div", "", "app-value");
        const shown = valueText(value, props.attribute);
        box.append(
          node("span", nameFor(props, value), "app-label"),
          node(
            "strong",
            shown.text,
            shown.available ? "app-big" : "app-big unavailable",
          ),
          asOfLine(value),
        );
        return box;
      }
      case "EntityTile": {
        const box = node("div", "", "app-tile");
        const shown = valueText(value);
        box.append(
          node("span", nameFor(props, value), "app-label"),
          node(
            "strong",
            shown.text,
            shown.available ? "app-state" : "app-state unavailable",
          ),
          node("code", props.entity),
          asOfLine(value),
        );
        return box;
      }
      case "StatusPill": {
        const shown = valueText(value);
        const ok =
          shown.available && (props.okStates ?? []).includes(value.state);
        const pill = node(
          "div",
          "",
          `app-pill ${!shown.available ? "unknown" : ok ? "ok" : "attention"}`,
        );
        pill.append(
          node(
            "span",
            !shown.available ? "?" : ok ? "✓" : "!",
            "app-pill-icon",
          ),
          node("span", `${nameFor(props, value)}: ${shown.text}`),
        );
        pill.setAttribute(
          "aria-label",
          `${nameFor(props, value)}: ${shown.text}, ${!shown.available ? "unknown" : ok ? "OK" : "needs attention"}`,
        );
        return pill;
      }
      case "HistoryChart": {
        const box = node("div", "", "app-block");
        box.append(
          node("h3", props.label || `Last ${props.hours} h`),
          chart(data.history?.[id] ?? []),
        );
        return box;
      }
      case "Checklist": {
        const saved = data.state?.[props.stateKey];
        const checked = new Set(
          saved?.kind === "checklist" ? saved.checked : [],
        );
        const box = node("div", "", "app-block app-checklist");
        const items = props.items ?? [];
        const head = node("div", "", "app-row");
        head.append(
          node("h3", props.title || "Checklist"),
          node(
            "span",
            `${items.filter((i) => checked.has(i)).length} of ${items.length} done`,
            "app-asof",
          ),
        );
        box.append(head);
        for (const item of items) {
          const row = node("label", "", "app-check");
          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = checked.has(item);
          input.addEventListener("change", () =>
            handlers.state(props.stateKey, {
              op: input.checked ? "check" : "uncheck",
              item,
            }),
          );
          row.append(input, node("span", item));
          box.append(row);
        }
        const reset = button(
          "Clear ticks",
          "app-small",
          `Clear ${props.title || "checklist"}`,
        );
        reset.addEventListener("click", () =>
          handlers.state(props.stateKey, { op: "reset" }),
        );
        box.append(reset);
        return box;
      }
      case "Counter": {
        const saved = data.state?.[props.stateKey];
        const min = props.min ?? 0,
          max = props.max ?? 1000;
        const current =
          saved?.kind === "counter"
            ? saved.value
            : Math.min(max, Math.max(min, 0));
        const box = node("div", "", "app-block app-counter");
        const minus = button("−", "app-step", `Decrease ${props.label}`);
        minus.disabled = current <= min;
        minus.addEventListener("click", () =>
          handlers.state(props.stateKey, { op: "decrement" }),
        );
        const plus = button("+", "app-step", `Increase ${props.label}`);
        plus.disabled = current >= max;
        plus.addEventListener("click", () =>
          handlers.state(props.stateKey, { op: "increment" }),
        );
        const row = node("div", "", "app-row");
        row.append(
          node("span", props.label, "app-label"),
          minus,
          node("strong", String(current), "app-count"),
          plus,
        );
        box.append(row);
        return box;
      }
      case "Note": {
        const saved = data.state?.[props.stateKey];
        const box = node("div", "", "app-block app-note");
        const fieldId = `note-${id}`;
        const labelEl = node("label", props.label || "Note");
        labelEl.htmlFor = fieldId;
        const area = document.createElement("textarea");
        area.id = fieldId;
        area.maxLength = props.maxLength ?? 1000;
        area.rows = 3;
        area.value = saved?.kind === "note" ? saved.text : "";
        const save = button("Save note", "app-small");
        save.addEventListener("click", () =>
          handlers.state(props.stateKey, { op: "set", text: area.value }),
        );
        box.append(
          labelEl,
          area,
          save,
          node(
            "span",
            saved?.kind === "note"
              ? `Saved ${timeOf(saved.updated)}`
              : "Not saved yet",
            "app-asof",
          ),
        );
        return box;
      }
      case "AskButton": {
        const box = node("div", "", "app-ask");
        const ask = button(props.label, "app-ask-button");
        ask.addEventListener("click", () => handlers.ask(props.prompt));
        box.append(
          ask,
          node(
            "span",
            "Drafts a message for you to review and send.",
            "app-asof",
          ),
        );
        return box;
      }
      case "ToggleAction": {
        const control = data.controls?.[id] ?? {
          enabled: false,
          reason: "Unavailable",
        };
        const box = node("div", "", "app-block app-toggle");
        const shown = valueText(value);
        const row = node("div", "", "app-row");
        const info = node("div", "", "app-toggle-info");
        info.append(
          node("span", nameFor(props, value), "app-label"),
          node("strong", shown.text, "app-state"),
          asOfLine(value),
        );
        const label =
          control.label ?? (value?.state === "on" ? "Turn off" : "Turn on");
        const press = button(
          label,
          "app-toggle-button",
          `${label} ${nameFor(props, value)}`,
        );
        press.disabled = !control.enabled;
        press.addEventListener("click", () => handlers.toggle(id));
        row.append(info, press);
        box.append(row, node("p", control.reason, "app-asof"));
        return box;
      }
      default:
        return node("p", "Unsupported block", "app-unsupported");
    }
  };
  const tree = node("div", "", "app-tree");
  tree.append(render(spec.root, 1));
  fragment.append(tree);
  container.replaceChildren(fragment);
}
// Version history with Restore (a revert appends a new version).
export function renderAppHistory(container, data, handlers) {
  const fragment = document.createDocumentFragment();
  for (const version of [...(data.versions ?? [])].reverse()) {
    const row = node("div", "", "app-version");
    row.append(
      node(
        "span",
        `v${version.version} · ${version.summary} · ${version.by === "owner" ? "you" : "Hearth"} · ${new Date(version.created).toLocaleString()}`,
      ),
    );
    if (version.version !== data.app.version) {
      const restore = button(
        "Restore",
        "app-small",
        `Restore version ${version.version}`,
      );
      restore.addEventListener("click", () => handlers.revert(version.version));
      row.append(restore);
    } else row.append(node("span", "current", "app-asof"));
    fragment.append(row);
  }
  container.replaceChildren(fragment);
}
