// Proactive Home: a controller-side scheduler for deterministic watchers and
// briefings, and each owner's "Today" inbox of the cards they create.
//
// Read-only by construction. This module gets a StateReader (exact scoped
// state reads, nothing else) and the durable Harness for its own documents.
// It imports no Home Assistant client, Home permissions broker, app tools or
// conversation runtime, never admits model input and has no field that can
// name a service. test/proactive.test.ts checks this statically.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  defineDoc,
  type CheckpointInfo,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import { AppIndex, AppVersion, versionKey } from "./app-docs.js";
import {
  WATCHER_LIMITS,
  WEEKDAYS,
  boundEntities,
  describeWatcher,
  timePattern,
  validateOwnerWatcher,
  type AppSpec,
  type WatcherSpec,
  type WatcherWhen,
} from "./app-spec.js";
import { Catalog } from "./documents.js";
import { HomeCanvas } from "./canvas.js";
import { Serial, insist, object, text } from "./safety.js";

export type StateReading = {
  state: string;
  attributes: Record<string, string | number | boolean>;
};
// The only Home Assistant capability proactive code receives.
export type StateReader = {
  readonly entities: readonly string[];
  read(entityId: string, signal?: AbortSignal): Promise<StateReading>;
};
export const PROACTIVE_LIMITS = {
  intervalMs: 60000,
  startDelayMs: 15000,
  readsPerTick: 50,
  watchersPerOwner: 40,
  cardsPerOwner: 60,
  cardsPerHour: 20,
  cardAgeMs: 14 * 86400000,
  ledgerAgeMs: 21 * 86400000,
  briefingValues: 12,
  lateAfterMs: 5 * 60000,
} as const;
const checkpointWhen = (_value: unknown, _ops: unknown, info: CheckpointInfo) =>
  info.deltasSinceBase >= 31;

export type BriefingSlot = "morning" | "evening";
export type BriefingSource =
  | { kind: "app"; appId: string }
  | { kind: "canvas"; sessionId: number };
export type BriefingSetting = {
  enabled: boolean;
  at: string;
  source: BriefingSource | null;
};
export type OwnerWatcher = {
  id: string;
  spec: WatcherSpec;
  created: number;
};
type OwnerSettings = {
  watchersEnabled: boolean;
  next: number;
  watchers: OwnerWatcher[];
  briefings: Record<BriefingSlot, BriefingSetting>;
};
// Owner choices: standalone watchers and briefing schedules (default off).
export const ProactiveSettings = defineDoc<{
  owners: Record<string, OwnerSettings>;
}>({
  kind: "hearth.proactive-settings",
  version: 1,
  scope: "session",
  initial: () => ({ owners: {} }),
  checkpointWhen,
});
export type WatchState = {
  // Entity watchers: last observed state and when Hearth first saw it.
  last: string | null;
  since: number;
  // Start of the current episode (condition true), 0 when not holding.
  episode: number;
  fired: number;
  lastFire: number;
  // Schedules and briefings: the newest slot already handled.
  slot: number;
  // Definition fingerprint; a changed definition starts a new episode.
  def: string;
};
// Evaluation state plus the idempotency ledger: a card key is recorded in the
// same commit that adds its card, so a fire is never delivered twice.
export const WatchRuntime = defineDoc<{
  watches: Record<string, WatchState>;
  ledger: Record<string, number>;
}>({
  kind: "hearth.watch-runtime",
  version: 1,
  scope: "session",
  initial: () => ({ watches: {}, ledger: {} }),
  checkpointWhen,
});
export type CardValue = {
  entityId: string;
  label: string;
  state: string;
  unit: string;
  available: boolean;
  reason: "" | "not_in_read_scope" | "read_failed" | "unavailable";
  observedAt: number;
};
export type CardSource =
  | { kind: "app"; appId: string; title: string; watcherId: string }
  | { kind: "owner"; watcherId: string; title: string }
  | {
      kind: "briefing";
      slot: BriefingSlot;
      from: BriefingSource | null;
      title: string;
    };
export type TodayCard = {
  id: string;
  key: string;
  kind: "watcher" | "reminder" | "briefing";
  source: CardSource;
  title: string;
  body: string;
  values: CardValue[];
  created: number;
  scheduledFor: number;
  late: boolean;
  repeat: number;
  snoozedUntil: number;
};
export type TodaySignals = {
  created: number;
  dismissed: number;
  snoozed: number;
  asked: number;
  suppressed: number;
};
type OwnerToday = {
  cards: TodayCard[];
  lastSeen: number;
  recent: number[];
  signals: TodaySignals;
};
export const TodayInbox = defineDoc<{
  next: number;
  owners: Record<string, OwnerToday>;
}>({
  kind: "hearth.today",
  version: 1,
  scope: "session",
  initial: () => ({ next: 1, owners: {} }),
  checkpointWhen,
});

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const UNSETTLED = new Set(["unavailable", "unknown"]);
const blankState = (): WatchState => ({
  last: null,
  since: 0,
  episode: 0,
  fired: 0,
  lastFire: 0,
  slot: 0,
  def: "",
});
const defaultSettings = (): OwnerSettings => ({
  watchersEnabled: true,
  next: 1,
  watchers: [],
  briefings: {
    morning: { enabled: false, at: "07:30", source: null },
    evening: { enabled: false, at: "20:30", source: null },
  },
});
const blankToday = (): OwnerToday => ({
  cards: [],
  lastSeen: 0,
  recent: [],
  signals: { created: 0, dismissed: 0, snoozed: 0, asked: 0, suppressed: 0 },
});
const fingerprint = (value: unknown) => JSON.stringify(value);

// Newest local-time slot at or before now for "HH:MM" on the given days.
export function scheduledSlot(
  at: string,
  days: readonly string[] | undefined,
  now: number,
): number {
  const [hours, minutes] = at.split(":").map(Number) as [number, number];
  const today = new Date(now);
  for (let back = 0; back <= 7; back++) {
    const slot = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - back,
      hours,
      minutes,
    );
    if (slot.getTime() > now) continue;
    if (days && !days.includes(WEEKDAYS[slot.getDay()]!)) continue;
    return slot.getTime();
  }
  return 0;
}

type EntityWhen = Exclude<WatcherWhen, { kind: "schedule" }>;
// Pure evaluation of one entity watcher against one fresh reading.
export function evaluateWatch(
  watcher: WatcherSpec & { when: EntityWhen },
  previous: WatchState | undefined,
  state: string,
  now: number,
): { next: WatchState; fire: null | { episode: number; repeat: number } } {
  const def = fingerprint(watcher);
  const prev =
    previous && previous.def === def
      ? previous
      : {
          ...blankState(),
          last: previous?.last ?? null,
          since: previous?.since ?? 0,
        };
  const last = prev.last;
  const since = last === state && prev.since ? prev.since : now;
  let { episode, fired, lastFire } = prev;
  const when = watcher.when;
  let holds = false;
  let start = false;
  if (when.kind === "transition") {
    holds = when.to !== undefined ? state === when.to : state !== when.from;
    const changed = last !== null && last !== state;
    const fromOk =
      when.from !== undefined ? last === when.from : !UNSETTLED.has(last ?? "");
    start = changed && fromOk && holds;
  } else if (when.kind === "threshold") {
    const n = Number(state);
    holds =
      state.trim() !== "" &&
      Number.isFinite(n) &&
      (when.above === undefined || n > when.above) &&
      (when.below === undefined || n < when.below);
    start = holds && !episode;
  } else {
    holds = state === when.state && now - since >= when.minutes * 60000;
    start = holds && !episode;
  }
  let fire: null | { episode: number; repeat: number } = null;
  if (!holds) {
    episode = 0;
    fired = 0;
  } else if (start) {
    episode = when.kind === "duration" ? since : now;
    fired = 1;
    lastFire = now;
    fire = { episode, repeat: 0 };
  } else if (
    episode &&
    watcher.repeatAfterMinutes &&
    fired <= (watcher.maxRepeats ?? 1) &&
    now - lastFire >= watcher.repeatAfterMinutes * 60000
  ) {
    fire = { episode, repeat: fired };
    fired++;
    lastFire = now;
  }
  return {
    next: { ...prev, last: state, since, episode, fired, lastFire, def },
    fire,
  };
}

async function pool<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift())
        await run(item);
    }),
  );
}

type Job = {
  key: string;
  owner: string;
  watcher: WatcherSpec;
  source: CardSource;
  repair: string;
};
type Reading =
  | {
      ok: true;
      state: string;
      attributes: StateReading["attributes"];
      at: number;
    }
  | { ok: false; reason: CardValue["reason"]; at: number };
type PlannedCard = Omit<TodayCard, "id" | "snoozedUntil"> & { owner: string };
type BriefingTarget = {
  title: string;
  entities: string[];
  labels: Map<string, string>;
} | null;

// Snooze choices shared by Today cards and suggestions: 1h, tonight (19:00
// local today) or tomorrow (08:00 local).
export function snoozeUntil(choice: unknown, now: number) {
  const d = new Date(now);
  if (choice === "1h") return now + 3600000;
  if (choice === "tonight") {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 19, 0);
    insist(t.getTime() > now, "snooze_tonight_passed", 409);
    return t.getTime();
  }
  insist(choice === "tomorrow", "invalid_snooze");
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + 1,
    8,
    0,
  ).getTime();
}
export class Proactive {
  private serial = new Serial();
  private timer?: ReturnType<typeof setInterval>;
  private delay?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private abort = new AbortController();
  private specs = new Map<string, AppSpec | null>();
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly sanitize: (value: string) => string;
  constructor(
    private harness: Harness,
    private reader: StateReader,
    private options: {
      now?: () => number;
      intervalMs?: number;
      startDelayMs?: number;
      sanitize?: (value: string) => string;
      // Authorized owners; watchers of anyone else are not evaluated.
      owners?: () => readonly string[];
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? PROACTIVE_LIMITS.intervalMs;
    this.sanitize = options.sanitize ?? ((v) => v);
  }
  start() {
    if (this.timer || this.delay || this.stopped) return;
    // A slow pass (bounded reads, 10 s timeouts) skips the next timer rather
    // than queueing passes behind it.
    let running = false;
    const run = () => {
      if (running) return;
      running = true;
      void this.tick()
        .catch(() => {})
        .finally(() => {
          running = false;
        });
    };
    this.delay = setTimeout(() => {
      this.delay = undefined;
      if (this.stopped) return;
      run();
      this.timer = setInterval(run, this.intervalMs);
      this.timer.unref();
    }, this.options.startDelayMs ?? PROACTIVE_LIMITS.startDelayMs);
    this.delay.unref();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.delay);
    clearInterval(this.timer);
    this.abort.abort();
    await this.serial.run(async () => {});
  }
  private allowed(owner: string) {
    return !this.options.owners || this.options.owners().includes(owner);
  }
  private async spec(appId: string, version: number) {
    const key = versionKey(appId, version);
    if (!this.specs.has(key)) {
      const spec =
        (await this.harness.snapshot(AppVersion, key, ctx))?.spec ?? null;
      if (this.specs.size > 500) this.specs.clear();
      this.specs.set(key, spec ? copy(spec) : null);
    }
    return this.specs.get(key) ?? null;
  }
  private repairReason(watcher: WatcherSpec, scope: readonly string[] | null) {
    if (watcher.when.kind === "schedule") return "";
    const entity = watcher.when.entity;
    if (!this.reader.entities.includes(entity))
      return `${entity} is outside Hearth's read scope.`;
    if (scope && !scope.includes(entity))
      return `${entity} is not in the app's scope.`;
    return "";
  }
  // Every watcher an owner has, active or not, in a stable order.
  private async jobs(owner: string, settings: OwnerSettings | undefined) {
    const jobs: Job[] = [];
    const apps = ((await this.harness.snapshot(AppIndex, ctx))?.items ?? [])
      .filter((a) => a.owner === owner)
      .sort((a, b) => a.created - b.created);
    for (const app of apps) {
      const spec = await this.spec(app.id, app.version);
      for (const watcher of spec?.watchers ?? [])
        jobs.push({
          key: `app:${owner}:${app.id}:${watcher.id}`,
          owner,
          watcher,
          source: {
            kind: "app",
            appId: app.id,
            title: app.title,
            watcherId: watcher.id,
          },
          repair: this.repairReason(watcher, spec?.scope.entities ?? []),
        });
    }
    for (const own of settings?.watchers ?? [])
      jobs.push({
        key: `own:${owner}:${own.id}`,
        owner,
        watcher: own.spec,
        source: {
          kind: "owner",
          watcherId: own.id,
          title: own.spec.card.title,
        },
        repair: this.repairReason(own.spec, null),
      });
    return jobs.map((job, i) =>
      !job.repair && i >= PROACTIVE_LIMITS.watchersPerOwner
        ? { ...job, repair: "Over the per-owner watcher limit." }
        : job,
    );
  }
  private async briefingEntities(
    owner: string,
    source: BriefingSource | null,
  ): Promise<BriefingTarget> {
    if (!source) return null;
    if (source.kind === "app") {
      const meta = (await this.harness.snapshot(AppIndex, ctx))?.items.find(
        (a) => a.id === source.appId && a.owner === owner,
      );
      if (!meta) return null;
      const spec = await this.spec(meta.id, meta.version);
      if (!spec) return null;
      const labels = new Map<string, string>();
      for (const element of Object.values(spec.elements))
        if (
          typeof element.props.entity === "string" &&
          typeof element.props.label === "string" &&
          !labels.has(element.props.entity)
        )
          labels.set(element.props.entity, element.props.label);
      return {
        title: meta.title,
        entities: boundEntities(spec).slice(0, PROACTIVE_LIMITS.briefingValues),
        labels,
      };
    }
    const session = (await this.harness.snapshot(Catalog, ctx))?.items.find(
      (s) => s.id === source.sessionId && s.owner === owner,
    );
    if (!session || session.kind === "workspace") return null;
    const canvas = (
      await this.harness.snapshot(HomeCanvas, session.id as ConversationId, ctx)
    )?.current;
    if (!canvas) return null;
    return {
      title: canvas.title,
      entities: canvas.sections
        .flatMap((s) => s.readings.map((r) => r.entityId))
        .slice(0, PROACTIVE_LIMITS.briefingValues),
      labels: new Map<string, string>(),
    };
  }
  private value(
    entityId: string,
    reading: Reading | undefined,
    label = "",
  ): CardValue {
    const clean = (v: string) => this.sanitize(v).slice(0, 200);
    if (!reading || !reading.ok)
      return {
        entityId,
        label: clean(label || entityId),
        state: "",
        unit: "",
        available: false,
        reason: reading && !reading.ok ? reading.reason : "read_failed",
        observedAt: reading?.at ?? this.now(),
      };
    const name = reading.attributes.friendly_name;
    const unit = reading.attributes.unit_of_measurement;
    const unavailable = UNSETTLED.has(reading.state);
    return {
      entityId,
      label: clean(label || (typeof name === "string" ? name : "") || entityId),
      state: clean(reading.state),
      unit: typeof unit === "string" ? clean(unit).slice(0, 20) : "",
      available: !unavailable,
      reason: unavailable ? "unavailable" : "",
      observedAt: reading.at,
    };
  }
  // One evaluation pass: bounded scoped reads, pure evaluation, one commit.
  tick(): Promise<{ reads: number; cards: number }> {
    return this.serial.run(async () => {
      if (this.stopped) return { reads: 0, cards: 0 };
      const now = this.now();
      const settings =
        (await this.harness.snapshot(ProactiveSettings, ctx))?.owners ?? {};
      const runtime = copy(
        (await this.harness.snapshot(WatchRuntime, ctx)) ?? {
          watches: {},
          ledger: {},
        },
      );
      const index = (await this.harness.snapshot(AppIndex, ctx))?.items ?? [];
      const owners = [
        ...new Set([...Object.keys(settings), ...index.map((a) => a.owner)]),
      ]
        .filter((o) => this.allowed(o))
        .sort();
      const active: Job[] = [];
      const briefings: {
        key: string;
        owner: string;
        slot: BriefingSlot;
        setting: BriefingSetting;
        due: number;
        target: BriefingTarget;
      }[] = [];
      const keep = new Set<string>();
      const updates = new Map<string, WatchState>();
      for (const owner of owners) {
        const own = settings[owner];
        if (own?.watchersEnabled !== false)
          for (const job of await this.jobs(owner, own))
            if (!job.repair) active.push(job);
        for (const slot of ["morning", "evening"] as const) {
          const setting = own?.briefings[slot];
          if (!setting?.enabled) continue;
          const key = `brief:${owner}:${slot}`;
          keep.add(key);
          const due = scheduledSlot(setting.at, undefined, now);
          const state = runtime.watches[key];
          if (!state)
            updates.set(key, {
              ...blankState(),
              slot: due,
              def: fingerprint({ at: setting.at, source: setting.source }),
            });
          else if (due > state.slot)
            briefings.push({
              key,
              owner,
              slot,
              setting,
              due,
              target: await this.briefingEntities(owner, setting.source),
            });
        }
      }
      // Bounded, deduplicated reads inside the configured read scope only.
      const wanted: string[] = [];
      for (const job of active)
        if (job.watcher.when.kind !== "schedule")
          wanted.push(job.watcher.when.entity);
      for (const b of briefings) wanted.push(...(b.target?.entities ?? []));
      const entities = [...new Set(wanted)]
        .filter((id) => this.reader.entities.includes(id))
        .slice(0, PROACTIVE_LIMITS.readsPerTick);
      const readings = new Map<string, Reading>();
      await pool(entities, 4, async (id) => {
        try {
          const reading = await this.reader.read(id, this.abort.signal);
          readings.set(id, {
            ok: true,
            state: reading.state,
            attributes: reading.attributes,
            at: this.now(),
          });
        } catch {
          readings.set(id, {
            ok: false,
            reason: "read_failed",
            at: this.now(),
          });
        }
      });
      if (this.stopped) return { reads: readings.size, cards: 0 };
      const planned: PlannedCard[] = [];
      for (const job of active) {
        keep.add(job.key);
        const previous = runtime.watches[job.key];
        const when = job.watcher.when;
        const base = {
          owner: job.owner,
          source: job.source,
          title: job.watcher.card.title,
          body: job.watcher.card.body,
        };
        if (when.kind === "schedule") {
          const due = scheduledSlot(when.at, when.days, now);
          const def = fingerprint(job.watcher);
          if (!previous || previous.def !== def) {
            // First sight: earlier slots happened before this watcher existed.
            updates.set(job.key, { ...blankState(), slot: due, def });
            continue;
          }
          if (due > previous.slot) {
            updates.set(job.key, { ...previous, slot: due });
            planned.push({
              ...base,
              key: `${job.key}@${due}`,
              kind: "reminder",
              values: [],
              created: now,
              scheduledFor: due,
              late: now - due > PROACTIVE_LIMITS.lateAfterMs,
              repeat: 0,
            });
          }
          continue;
        }
        const reading = readings.get(when.entity);
        if (!reading?.ok) continue;
        const result = evaluateWatch(
          job.watcher as WatcherSpec & { when: EntityWhen },
          previous,
          reading.state,
          now,
        );
        if (fingerprint(result.next) !== fingerprint(previous))
          updates.set(job.key, result.next);
        if (result.fire)
          planned.push({
            ...base,
            key: `${job.key}#${result.fire.episode}.${result.fire.repeat}`,
            kind: "watcher",
            values: [this.value(when.entity, reading)],
            created: now,
            scheduledFor: 0,
            late: false,
            repeat: result.fire.repeat,
          });
      }
      for (const b of briefings) {
        updates.set(b.key, { ...runtime.watches[b.key]!, slot: b.due });
        const values = (b.target?.entities ?? []).map((id) =>
          this.value(
            id,
            this.reader.entities.includes(id)
              ? readings.get(id)
              : { ok: false, reason: "not_in_read_scope", at: now },
            b.target?.labels.get(id),
          ),
        );
        const missing = values.filter((v) => !v.available).length;
        planned.push({
          owner: b.owner,
          key: `${b.key}@${b.due}`,
          kind: "briefing",
          source: {
            kind: "briefing",
            slot: b.slot,
            from: b.setting.source,
            title: b.target?.title ?? "",
          },
          title: b.slot === "morning" ? "Morning briefing" : "Evening briefing",
          body: b.target
            ? `From ${b.target.title}: ${values.length} reading${values.length === 1 ? "" : "s"}${missing ? `, ${missing} unavailable` : ""}.`
            : "The chosen source no longer exists. Choose another in Briefings & watchers.",
          values,
          created: now,
          scheduledFor: b.due,
          late: now - b.due > PROACTIVE_LIMITS.lateAfterMs,
          repeat: 0,
        });
      }
      const stale = Object.keys(runtime.watches).filter((k) => !keep.has(k));
      if (!updates.size && !planned.length && !stale.length)
        return { reads: readings.size, cards: 0 };
      const delivered = await this.harness.commit(async (tx) => {
        const doc = await tx.doc(WatchRuntime);
        const today = await tx.doc(TodayInbox);
        for (const key of stale) delete doc.watches[key];
        for (const [key, state] of updates) doc.watches[key] = state;
        let count = 0;
        for (const card of planned) {
          if (Object.hasOwn(doc.ledger, card.key)) continue;
          doc.ledger[card.key] = now;
          // Assign, then edit through the document (not the plain object).
          if (!today.owners[card.owner])
            today.owners[card.owner] = blankToday();
          const inbox = today.owners[card.owner]!;
          inbox.recent = inbox.recent.filter((t) => now - t < 3600000);
          if (
            card.kind !== "briefing" &&
            inbox.recent.length >= PROACTIVE_LIMITS.cardsPerHour
          ) {
            inbox.signals.suppressed++;
            continue;
          }
          if (card.kind !== "briefing") inbox.recent.push(now);
          const { owner: _owner, ...rest } = card;
          inbox.cards.push({
            ...rest,
            id: `c_${today.next++}`,
            snoozedUntil: 0,
          });
          inbox.signals.created++;
          count++;
        }
        for (const inbox of Object.values(today.owners)) {
          inbox.cards = inbox.cards
            .filter((c) => now - c.created < PROACTIVE_LIMITS.cardAgeMs)
            .slice(-PROACTIVE_LIMITS.cardsPerOwner);
        }
        for (const [key, at] of Object.entries(doc.ledger))
          if (now - at > PROACTIVE_LIMITS.ledgerAgeMs) delete doc.ledger[key];
        return count;
      }, ctx);
      return { reads: readings.size, cards: delivered };
    });
  }

  // ---- Owner-facing HTTP operations (owner-scoped; no Home writes) ----
  async today(owner: string) {
    const now = this.now();
    const mine = (await this.harness.snapshot(TodayInbox, ctx))?.owners[owner];
    const shown = (c: TodayCard) => Math.max(c.created, c.snoozedUntil);
    const all = copy(mine?.cards ?? []);
    const cards = all
      .filter((c) => c.snoozedUntil <= now)
      .sort((a, b) => shown(b) - shown(a));
    const lastSeen = mine?.lastSeen ?? 0;
    return {
      cards,
      unread: cards.filter((c) => shown(c) > lastSeen).length,
      snoozed: all.filter((c) => c.snoozedUntil > now).length,
      suppressed: mine?.signals.suppressed ?? 0,
      lastSeen,
      now,
      checkEverySeconds: Math.round(this.intervalMs / 1000),
    };
  }
  private async inbox<T>(owner: string, change: (inbox: OwnerToday) => T) {
    return this.harness.commit(async (tx) => {
      const today = await tx.doc(TodayInbox);
      if (!today.owners[owner]) today.owners[owner] = blankToday();
      return change(today.owners[owner]!);
    }, ctx);
  }
  async seen(owner: string, body: unknown) {
    object(body, []);
    const now = this.now();
    await this.inbox(owner, (inbox) => {
      inbox.lastSeen = Math.max(inbox.lastSeen, now);
    });
    return this.today(owner);
  }
  private cardId(body: unknown, keys: string[]) {
    const v = object(body, ["id", ...keys]);
    const id = text(v.id, 20);
    insist(/^c_[1-9][0-9]{0,9}$/.test(id), "card_not_found", 404);
    return { id, v };
  }
  async dismiss(owner: string, body: unknown) {
    const { id } = this.cardId(body, []);
    await this.inbox(owner, (inbox) => {
      const at = inbox.cards.findIndex((c) => c.id === id);
      insist(at >= 0, "card_not_found", 404);
      inbox.cards.splice(at, 1);
      inbox.signals.dismissed++;
    });
    return this.today(owner);
  }
  // 1h, tonight (19:00 local today) or tomorrow (08:00 local).
  snoozeUntil(choice: unknown, now = this.now()) {
    return snoozeUntil(choice, now);
  }
  async snooze(owner: string, body: unknown) {
    const { id, v } = this.cardId(body, ["until"]);
    const until = this.snoozeUntil(v.until);
    await this.inbox(owner, (inbox) => {
      const card = inbox.cards.find((c) => c.id === id);
      insist(card, "card_not_found", 404);
      card.snoozedUntil = until;
      inbox.signals.snoozed++;
    });
    return { ...(await this.today(owner)), snoozedUntil: until };
  }
  // A local counter only: the drafted question itself is never stored.
  async asked(owner: string, body: unknown) {
    const { id } = this.cardId(body, []);
    await this.inbox(owner, (inbox) => {
      insist(
        inbox.cards.some((c) => c.id === id),
        "card_not_found",
        404,
      );
      inbox.signals.asked++;
    });
    return { recorded: true };
  }
  async signals(owner: string): Promise<TodaySignals> {
    return copy(
      (await this.harness.snapshot(TodayInbox, ctx))?.owners[owner]?.signals ??
        blankToday().signals,
    );
  }
  async resetSignals(owner: string) {
    await this.inbox(owner, (inbox) => {
      inbox.signals = blankToday().signals;
    });
  }
  async settings(owner: string) {
    const own =
      (await this.harness.snapshot(ProactiveSettings, ctx))?.owners[owner] ??
      defaultSettings();
    const jobs = await this.jobs(owner, own);
    const apps = ((await this.harness.snapshot(AppIndex, ctx))?.items ?? [])
      .filter((a) => a.owner === owner)
      .map((a) => ({ id: a.id, title: a.title }));
    const canvases: { sessionId: number; title: string }[] = [];
    for (const session of (await this.harness.snapshot(Catalog, ctx))?.items ??
      []) {
      if (session.owner !== owner || session.kind === "workspace") continue;
      const canvas = (
        await this.harness.snapshot(
          HomeCanvas,
          session.id as ConversationId,
          ctx,
        )
      )?.current;
      if (canvas)
        canvases.push({
          sessionId: session.id,
          title: `${canvas.title} (${session.title})`.slice(0, 120),
        });
    }
    return {
      watchersEnabled: own.watchersEnabled,
      briefings: copy(own.briefings),
      watchers: jobs.map((job) => ({
        key: job.key,
        source: job.source,
        id: job.source.kind === "owner" ? job.source.watcherId : job.watcher.id,
        title: job.watcher.card.title,
        description: describeWatcher(job.watcher),
        kind: job.watcher.when.kind,
        status: job.repair ? "needs_repair" : "active",
        repair: job.repair,
      })),
      sources: { apps, canvases },
      readScopeCount: this.reader.entities.length,
      checkEverySeconds: Math.round(this.intervalMs / 1000),
    };
  }
  private async settingsCommit<T>(
    owner: string,
    change: (
      own: OwnerSettings,
      runtime: { watches: Record<string, WatchState> },
    ) => T,
  ) {
    return this.harness.commit(async (tx) => {
      const doc = await tx.doc(ProactiveSettings);
      const runtime = await tx.doc(WatchRuntime);
      if (!doc.owners[owner]) doc.owners[owner] = defaultSettings();
      return change(doc.owners[owner]!, runtime);
    }, ctx);
  }
  async setWatchersEnabled(owner: string, body: unknown) {
    const v = object(body, ["enabled"]);
    insist(typeof v.enabled === "boolean");
    await this.settingsCommit(owner, (own) => {
      own.watchersEnabled = v.enabled as boolean;
    });
    return this.settings(owner);
  }
  async saveBriefing(owner: string, body: unknown) {
    const v = object(body, ["slot", "enabled", "at", "source"]);
    insist(v.slot === "morning" || v.slot === "evening", "invalid_slot");
    insist(typeof v.enabled === "boolean");
    const at = text(v.at, 5);
    insist(timePattern.test(at), "invalid_time");
    let source: BriefingSource | null = null;
    if (v.source !== null && v.source !== undefined) {
      const s = object(v.source, ["kind", "appId", "sessionId"]);
      if (s.kind === "app") {
        insist(s.sessionId === undefined);
        const appId = text(s.appId, 20);
        insist(/^app_[1-9][0-9]{0,8}$/.test(appId), "app_not_found", 404);
        source = { kind: "app", appId };
      } else {
        insist(s.kind === "canvas" && s.appId === undefined);
        insist(
          Number.isSafeInteger(s.sessionId) && Number(s.sessionId) > 0,
          "session_not_found",
          404,
        );
        source = { kind: "canvas", sessionId: s.sessionId as number };
      }
      insist(
        await this.briefingEntities(owner, source),
        source.kind === "app" ? "app_not_found" : "canvas_not_found",
        404,
      );
    }
    insist(!v.enabled || source, "briefing_source_required");
    const slot = v.slot as BriefingSlot;
    const now = this.now();
    await this.settingsCommit(owner, (own, runtime) => {
      own.briefings[slot] = { enabled: v.enabled as boolean, at, source };
      const key = `brief:${owner}:${slot}`;
      // Saving never fires a slot that already passed: the next one is due.
      if (v.enabled)
        runtime.watches[key] = {
          ...blankState(),
          slot: scheduledSlot(at, undefined, now),
          def: fingerprint({ at, source }),
        };
      else delete runtime.watches[key];
    });
    return this.settings(owner);
  }
  async addWatcher(owner: string, body: unknown) {
    const v = object(body, ["watcher"]);
    insist(
      v.watcher !== null &&
        typeof v.watcher === "object" &&
        !Array.isArray(v.watcher),
    );
    // Hearth assigns the id; the committed id replaces this placeholder.
    const result = validateOwnerWatcher(
      { ...v.watcher, id: "pending" },
      {
        readable: this.reader.entities,
        services: [],
        redact: this.sanitize,
      },
    );
    if (!result.ok) return { ok: false as const, errors: result.errors };
    const now = this.now();
    await this.settingsCommit(owner, (own) => {
      insist(
        own.watchers.length < WATCHER_LIMITS.perOwner,
        "watcher_limit",
        429,
      );
      const id = `w_${own.next++}`;
      own.watchers.push({ id, spec: { ...result.watcher, id }, created: now });
    });
    return { ok: true as const, settings: await this.settings(owner) };
  }
  async removeWatcher(owner: string, body: unknown) {
    const v = object(body, ["id"]);
    const id = text(v.id, 20);
    await this.settingsCommit(owner, (own) => {
      const at = own.watchers.findIndex((w) => w.id === id);
      insist(at >= 0, "watcher_not_found", 404);
      own.watchers.splice(at, 1);
    });
    return this.settings(owner);
  }
}
