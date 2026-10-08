// Trusted renderers for the Today inbox, Briefings & watchers settings,
// Insights and message feedback. Card text, entity values and labels are
// untrusted and only ever set as textContent; every value shown comes from
// the controller's reads, with its as-of time.
import { node } from "./render.js";

export const FEEDBACK_REASON_LABELS = {
  wrong_value: "Wrong value",
  wrong_device: "Wrong device",
  did_not_do_it: "Didn't do it",
  too_long: "Too long",
  not_useful: "Not useful",
  privacy: "Creepy / privacy",
};
function button(label, className = "", aria = "") {
  const element = node("button", label, className);
  element.type = "button";
  if (aria) element.setAttribute("aria-label", aria);
  return element;
}
function clock(ms) {
  return Number.isFinite(ms) && ms > 0
    ? new Date(ms).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "unknown time";
}
function day(ms) {
  const date = new Date(ms);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return clock(ms);
  return `${date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${clock(ms)}`;
}
const UNAVAILABLE = {
  not_in_read_scope: "Unavailable (not in read scope)",
  read_failed: "Unavailable (read failed)",
  unavailable: "Unavailable",
};
export function valueLine(value) {
  return value.available
    ? `${value.state}${value.unit ? ` ${value.unit}` : ""}`
    : (UNAVAILABLE[value.reason] ?? "Unavailable");
}
export function sourceLabel(source) {
  if (source?.kind === "app") return `${source.title} · app watcher`;
  if (source?.kind === "owner") return "Your watcher";
  if (source?.kind === "briefing")
    return source.title ? `Briefing · ${source.title}` : "Briefing";
  return "Hearth";
}
// Draft text for "Ask about this": a question the person reviews and sends.
export function askPrompt(card) {
  const values = (card.values ?? [])
    .map(
      (v) =>
        `${v.label} (${v.entityId}): ${valueLine(v)}${v.available ? ` as of ${clock(v.observedAt)}` : ""}`,
    )
    .join("; ");
  return `About my Today card "${card.title}" from ${sourceLabel(card.source)} at ${clock(card.created)}${values ? ` — ${values}` : ""}. Read these entities again now and explain what this means. Do not call services.`;
}
function cardElement(card, data, handlers) {
  const unread = Math.max(card.created, card.snoozedUntil) > data.lastSeen;
  const article = node(
    "article",
    "",
    `today-card${unread ? " unread" : ""}${card.kind === "briefing" ? " briefing" : ""}`,
  );
  const meta = node("p", "", "today-meta");
  meta.append(node("span", sourceLabel(card.source), "today-source"));
  const when = [clock(card.created)];
  if (card.late) when.push(`late · was due ${day(card.scheduledFor)}`);
  if (card.repeat) when.push(`reminder ${card.repeat}`);
  meta.append(node("span", when.join(" · "), "today-time"));
  if (unread) meta.append(node("span", "New", "today-new"));
  article.append(meta, node("h3", card.title, "today-title"));
  if (card.body) article.append(node("p", card.body, "today-body"));
  if (card.values?.length) {
    // One as-of line when every value was read in the same pass.
    const times = card.values
      .filter((v) => v.available)
      .map((v) => v.observedAt);
    const together =
      times.length > 0 && Math.max(...times) - Math.min(...times) < 60000;
    const list = node("ul", "", "today-values");
    for (const value of card.values) {
      const row = node("li", "", value.available ? "" : "unavailable");
      row.append(
        node("span", value.label, "today-label"),
        node("strong", valueLine(value), "today-value"),
      );
      if (!value.available)
        row.append(node("span", value.entityId, "app-asof"));
      else if (!together)
        row.append(
          node("span", `as of ${clock(value.observedAt)}`, "app-asof"),
        );
      list.append(row);
    }
    article.append(list);
    if (together)
      article.append(
        node(
          "p",
          `Read by Hearth from Home Assistant at ${clock(times[0])}`,
          "app-asof today-asof",
        ),
      );
  }
  const actions = node("div", "", "today-actions");
  const dismiss = button("Dismiss", "", `Dismiss ${card.title}`);
  dismiss.addEventListener("click", () => handlers.dismiss(card));
  const snooze = button("Snooze", "", `Snooze ${card.title}`);
  snooze.setAttribute("aria-expanded", "false");
  const ask = button("Ask about this", "", `Ask about ${card.title}`);
  ask.addEventListener("click", () => handlers.ask(card));
  actions.append(dismiss, snooze);
  const appId =
    card.source?.kind === "app"
      ? card.source.appId
      : card.source?.kind === "briefing" && card.source.from?.kind === "app"
        ? card.source.from.appId
        : "";
  if (appId) {
    const open = button("Open app", "", `Open app for ${card.title}`);
    open.addEventListener("click", () => handlers.openApp(appId));
    actions.append(open);
  }
  actions.append(ask);
  const choices = node("div", "", "today-snooze");
  choices.hidden = true;
  const evening = new Date();
  evening.setHours(19, 0, 0, 0);
  for (const [until, label] of [
    ["1h", "1 hour"],
    ["tonight", "Tonight 19:00"],
    ["tomorrow", "Tomorrow 08:00"],
  ]) {
    if (until === "tonight" && evening.getTime() <= Date.now()) continue;
    const choice = button(label, "chip", `Snooze until ${label}`);
    choice.addEventListener("click", () => handlers.snooze(card, until));
    choices.append(choice);
  }
  snooze.addEventListener("click", () => {
    choices.hidden = !choices.hidden;
    snooze.setAttribute("aria-expanded", String(!choices.hidden));
  });
  article.append(actions, choices);
  return article;
}
export function renderToday(container, data, handlers) {
  const fragment = document.createDocumentFragment();
  if (!data.cards.length) {
    const empty = node("div", "", "today-empty");
    empty.append(
      node(
        "p",
        "Nothing new. Cards from your watchers and briefings appear here.",
      ),
      node(
        "p",
        data.snoozed
          ? `${data.snoozed} snoozed card${data.snoozed === 1 ? "" : "s"} will come back later.`
          : "Turn on a briefing or add a watcher in Briefings & watchers.",
        "muted",
      ),
    );
    fragment.append(empty);
  }
  for (const card of data.cards)
    fragment.append(cardElement(card, data, handlers));
  if (data.cards.length && data.snoozed)
    fragment.append(
      node("p", `${data.snoozed} more snoozed.`, "muted today-footnote"),
    );
  if (data.suppressed)
    fragment.append(
      node(
        "p",
        `${data.suppressed} alert${data.suppressed === 1 ? " was" : "s were"} held back by the hourly limit.`,
        "muted today-footnote",
      ),
    );
  container.replaceChildren(fragment);
}

// ---- Briefings & watchers settings ----
function field(labelText, control, id) {
  const wrap = node("div", "", "pro-field");
  const label = node("label", labelText);
  label.htmlFor = id;
  control.id = id;
  wrap.append(label, control);
  return wrap;
}
function select(options, value) {
  const element = document.createElement("select");
  for (const [v, text] of options) {
    const option = node("option", text);
    option.value = v;
    // Selecting the option (rather than assigning select.value) also works
    // before the element is attached.
    option.selected = v === value;
    element.append(option);
  }
  return element;
}
function sourceKey(source) {
  return !source
    ? ""
    : source.kind === "app"
      ? `app:${source.appId}`
      : `canvas:${source.sessionId}`;
}
export function parseSourceKey(value) {
  const [kind, id] = String(value).split(":");
  if (kind === "app" && id) return { kind: "app", appId: id };
  if (kind === "canvas" && Number(id) > 0)
    return { kind: "canvas", sessionId: Number(id) };
  return null;
}
function briefingForm(slot, setting, sources, handlers) {
  const box = node("fieldset", "", "pro-briefing");
  box.append(
    node(
      "legend",
      slot === "morning" ? "Morning briefing" : "Evening briefing",
    ),
  );
  const toggleRow = node("label", "", "pro-check");
  const on = document.createElement("input");
  on.type = "checkbox";
  on.checked = !!setting.enabled;
  on.id = `briefing-${slot}-on`;
  toggleRow.htmlFor = on.id;
  toggleRow.append(on, node("span", "On"));
  const time = document.createElement("input");
  time.type = "time";
  time.value = setting.at;
  const options = [["", "Choose a source"]];
  for (const app of sources.apps)
    options.push([`app:${app.id}`, `App: ${app.title}`]);
  for (const canvas of sources.canvases)
    options.push([`canvas:${canvas.sessionId}`, `Home view: ${canvas.title}`]);
  const source = select(options, sourceKey(setting.source));
  const save = button("Save", "", `Save ${slot} briefing`);
  save.addEventListener("click", () =>
    handlers.saveBriefing(slot, {
      enabled: on.checked,
      at: time.value,
      source: parseSourceKey(source.value),
    }),
  );
  const top = node("div", "", "pro-row");
  top.append(toggleRow, field("Time", time, `briefing-${slot}-time`));
  box.append(
    top,
    field("Read values from", source, `briefing-${slot}-source`),
    save,
  );
  return box;
}
const KIND_CHOICES = [
  ["to", "Changes to a state"],
  ["above", "Goes above a number"],
  ["below", "Goes below a number"],
  ["duration", "Stays in a state for…"],
  ["schedule", "Reminder at a time"],
];
const DAY_CHOICES = {
  every: undefined,
  weekdays: ["mon", "tue", "wed", "thu", "fri"],
  weekends: ["sun", "sat"],
};
// Builds the owner watcher payload from the add form; the server validates.
export function watcherFromForm(values) {
  const card = { title: values.title.trim() };
  if (values.note.trim()) card.body = values.note.trim();
  const entity = values.entity.trim();
  switch (values.kind) {
    case "to":
      return {
        when: { kind: "transition", entity, to: values.value.trim() },
        card,
      };
    case "above":
    case "below":
      return {
        when: {
          kind: "threshold",
          entity,
          [values.kind]: Number(values.value),
        },
        card,
      };
    case "duration":
      return {
        when: {
          kind: "duration",
          entity,
          state: values.value.trim(),
          minutes: Number(values.minutes),
        },
        card,
      };
    default: {
      const days = DAY_CHOICES[values.days];
      return {
        when: { kind: "schedule", at: values.at, ...(days ? { days } : {}) },
        card,
      };
    }
  }
}
function addWatcherForm(handlers) {
  const details = node("details", "", "pro-add");
  details.append(node("summary", "Add a watcher"));
  const kind = select(KIND_CHOICES, "to");
  const entity = document.createElement("input");
  entity.placeholder = "sensor.washer_state";
  entity.autocomplete = "off";
  entity.spellcheck = false;
  entity.maxLength = 100;
  const value = document.createElement("input");
  value.maxLength = 60;
  value.autocomplete = "off";
  const minutes = document.createElement("input");
  minutes.type = "number";
  minutes.min = "1";
  minutes.max = "1440";
  minutes.value = "30";
  const at = document.createElement("input");
  at.type = "time";
  at.value = "08:00";
  const days = select(
    [
      ["every", "Every day"],
      ["weekdays", "Weekdays"],
      ["weekends", "Weekends"],
    ],
    "every",
  );
  const title = document.createElement("input");
  title.maxLength = 60;
  title.placeholder = "Card title, e.g. Washer finished";
  const note = document.createElement("input");
  note.maxLength = 200;
  note.placeholder = "Optional note";
  const fields = {
    entity: field("Entity ID", entity, "watch-entity"),
    value: field("State or number", value, "watch-value"),
    minutes: field("Minutes", minutes, "watch-minutes"),
    at: field("Time", at, "watch-at"),
    days: field("Days", days, "watch-days"),
  };
  const show = () => {
    const k = kind.value;
    fields.entity.hidden = k === "schedule";
    fields.value.hidden = k === "schedule";
    fields.minutes.hidden = k !== "duration";
    fields.at.hidden = k !== "schedule";
    fields.days.hidden = k !== "schedule";
    value.inputMode = k === "above" || k === "below" ? "decimal" : "text";
  };
  kind.addEventListener("change", show);
  show();
  const errors = node("p", "", "pro-errors");
  errors.setAttribute("role", "status");
  const add = button("Add watcher", "approve");
  add.addEventListener("click", () =>
    handlers.addWatcher(
      watcherFromForm({
        kind: kind.value,
        entity: entity.value,
        value: value.value,
        minutes: minutes.value,
        at: at.value,
        days: days.value,
        title: title.value,
        note: note.value,
      }),
      errors,
    ),
  );
  details.append(
    field("When", kind, "watch-kind"),
    fields.entity,
    fields.value,
    fields.minutes,
    fields.at,
    fields.days,
    field("Card title", title, "watch-title"),
    field("Note", note, "watch-note"),
    add,
    errors,
  );
  return details;
}
export function renderProactiveSettings(container, settings, handlers) {
  const fragment = document.createDocumentFragment();
  const briefings = node("section", "", "pro-section");
  briefings.append(
    node("h3", "Briefings"),
    node(
      "p",
      "Off until you turn one on. At its time Hearth reads the chosen app or Home view and adds a card to Today. Missing entities show Unavailable, never a guess.",
      "muted",
    ),
  );
  for (const slot of ["morning", "evening"])
    briefings.append(
      briefingForm(slot, settings.briefings[slot], settings.sources, handlers),
    );
  if (!settings.sources.apps.length && !settings.sources.canvases.length)
    briefings.append(
      node(
        "p",
        "No sources yet: ask Hearth for an app or a Home view first.",
        "muted",
      ),
    );
  const watchers = node("section", "", "pro-section");
  const head = node("div", "", "pro-head");
  head.append(node("h3", "Watchers"));
  const toggle = button(
    settings.watchersEnabled ? "Pause all" : "Resume",
    "",
    settings.watchersEnabled ? "Pause all watchers" : "Resume watchers",
  );
  toggle.setAttribute("aria-pressed", String(!settings.watchersEnabled));
  toggle.addEventListener("click", () =>
    handlers.setEnabled(!settings.watchersEnabled),
  );
  head.append(toggle);
  watchers.append(
    head,
    node(
      "p",
      settings.watchersEnabled
        ? `Running · checked about every ${Math.round(settings.checkEverySeconds / 60) || 1} min. Apps Hearth builds can add watchers too.`
        : "Paused: no watcher reads Home Assistant or creates cards.",
      "muted",
    ),
  );
  const list = node("ul", "", "pro-watchers");
  if (!settings.watchers.length)
    list.append(node("li", "No watchers yet.", "muted"));
  for (const w of settings.watchers) {
    const row = node("li", "", w.status === "active" ? "" : "needs-repair");
    const info = node("div", "", "pro-watch-info");
    info.append(
      node("strong", w.title),
      node("span", w.description, "pro-watch-desc"),
      node(
        "span",
        `${w.source.kind === "app" ? `From app ${w.source.title}` : "Yours"}${w.status === "active" ? "" : ` · Needs repair: ${w.repair}`}`,
        "app-asof",
      ),
    );
    row.append(info);
    if (w.source.kind === "owner") {
      const remove = button("Remove", "", `Remove watcher ${w.title}`);
      remove.addEventListener("click", () => handlers.removeWatcher(w.id));
      row.append(remove);
    } else {
      const open = button("Open app", "", `Open app ${w.source.title}`);
      open.addEventListener("click", () => handlers.openApp(w.source.appId));
      row.append(open);
    }
    list.append(row);
  }
  watchers.append(list, addWatcherForm(handlers));
  fragment.append(briefings, watchers);
  container.replaceChildren(fragment);
}

// ---- Insights ----
export function renderInsights(container, data) {
  const fragment = document.createDocumentFragment();
  const f = data.feedback;
  const totals = node("div", "", "insight-totals");
  totals.append(
    node("strong", `👍 ${f.up}`, "insight-big"),
    node("strong", `👎 ${f.down}`, "insight-big"),
  );
  fragment.append(
    totals,
    node("p", `Last ${f.retentionDays} days of your ratings.`, "muted"),
  );
  const reasons = node("ul", "", "insight-list");
  for (const [reason, count] of Object.entries(f.reasons))
    if (count)
      reasons.append(
        node("li", `${FEEDBACK_REASON_LABELS[reason] ?? reason}: ${count}`),
      );
  if (reasons.children.length)
    fragment.append(node("h3", "👎 reasons"), reasons);
  const models = node("ul", "", "insight-list");
  for (const [model, n] of Object.entries(f.models))
    models.append(node("li", `${model}: 👍 ${n.up} · 👎 ${n.down}`));
  if (models.children.length) fragment.append(node("h3", "By model"), models);
  const t = data.today;
  fragment.append(
    node("h3", "Today cards"),
    node(
      "p",
      `${t.created} created · ${t.dismissed} dismissed · ${t.snoozed} snoozed · ${t.asked} asked about${t.suppressed ? ` · ${t.suppressed} held back` : ""}`,
      "muted",
    ),
  );
  if (f.recent.length) {
    const recent = node("ul", "", "insight-list");
    for (const r of f.recent)
      recent.append(
        node(
          "li",
          `${day(r.at)} · ${r.rating === "up" ? "👍" : "👎"} · ${r.session}${r.reasons.length ? ` · ${r.reasons.map((x) => FEEDBACK_REASON_LABELS[x] ?? x).join(", ")}` : ""}`,
        ),
      );
    fragment.append(node("h3", "Recent ratings"), recent);
  } else
    fragment.append(
      node("p", "No ratings yet. Use 👍 / 👎 under Hearth's replies.", "muted"),
    );
  container.replaceChildren(fragment);
}

// ---- 👍/👎 under an assistant message ----
// state: {rating, reasons} or undefined; ui: {open: bool, draft: Set}.
export function renderFeedback(container, state, ui, handlers) {
  const fragment = document.createDocumentFragment();
  const row = node("div", "", "feedback-buttons");
  const up = button("👍", "feedback-thumb", "Helpful");
  up.setAttribute("aria-pressed", String(state?.rating === "up" && !ui.open));
  up.addEventListener("click", () =>
    handlers.rate(state?.rating === "up" ? "clear" : "up", []),
  );
  const down = button("👎", "feedback-thumb", "Not helpful");
  down.setAttribute(
    "aria-pressed",
    String(state?.rating === "down" || ui.open),
  );
  down.setAttribute("aria-expanded", String(ui.open));
  down.addEventListener("click", () => {
    if (state?.rating === "down" && !ui.open) handlers.rate("clear", []);
    else handlers.toggle();
  });
  row.append(up, down);
  if (state?.rating && !ui.open)
    row.append(
      node(
        "span",
        state.rating === "down" && state.reasons.length
          ? `Saved · ${state.reasons.map((r) => FEEDBACK_REASON_LABELS[r] ?? r).join(", ")}`
          : "Saved on this device",
        "feedback-saved",
      ),
    );
  fragment.append(row);
  if (ui.open) {
    const chips = node("div", "", "feedback-chips");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "What went wrong?");
    for (const [reason, label] of Object.entries(FEEDBACK_REASON_LABELS)) {
      const chip = button(label, "chip");
      chip.setAttribute("aria-pressed", String(ui.draft.has(reason)));
      chip.addEventListener("click", () => handlers.reason(reason));
      chips.append(chip);
    }
    const save = button("Save 👎", "approve");
    save.addEventListener("click", () => handlers.rate("down", [...ui.draft]));
    chips.append(save);
    fragment.append(chips);
  }
  container.replaceChildren(fragment);
}
