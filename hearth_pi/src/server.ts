import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { HomePermissions, Proposals } from "./documents.js";
import { HomeCanvas } from "./canvas.js";
import { Boundary } from "./auth.js";
import type { Config } from "./config.js";
import type { Runtime } from "./runtime.js";
import type { Actions } from "./ha.js";
import { Fault, insist, object, text, redactor } from "./safety.js";
import {
  isSubscriptionProvider,
  subscriptionProviders,
  type Subscription,
} from "./subscription.js";
import type { LocalEndpoints } from "./local.js";
import { AppStore } from "./apps.js";
import { Proactive } from "./proactive.js";
import { FeedbackStore } from "./feedback.js";
import { MemoryStore } from "./memory.js";
import { ListStore } from "./lists.js";
import { ProfileStore } from "./profile.js";
import { SuggestionStore } from "./suggestions.js";
import { WorldStore } from "./world.js";

// Cached once per process: the package version shown read-only in the
// Settings \u2192 About sheet. Never written to, never user-controlled.
let appVersionPromise: Promise<string> | undefined;
function appVersion(): Promise<string> {
  appVersionPromise ??= readFile(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8",
  )
    .then((raw) => {
      const value: unknown = JSON.parse(raw);
      const version =
        value && typeof value === "object" && "version" in value
          ? (value as { version: unknown }).version
          : undefined;
      return typeof version === "string" ? version : "unknown";
    })
    .catch(() => "unknown");
  return appVersionPromise;
}

async function body(
  req: IncomingMessage,
  limit = 8192,
  timeoutMs = 5000,
): Promise<unknown> {
  insist(
    req.headers["content-type"] === "application/json",
    "json_required",
    415,
  );
  insist(!req.headers["content-encoding"], "encoding_rejected", 415);
  insist(
    Number(req.headers["content-length"] ?? 0) <= limit,
    "body_too_large",
    413,
  );
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(
      () => reject(new Fault(408, "body_timeout")),
      timeoutMs,
    );
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) {
        chunks.length = 0;
        clearTimeout(timer);
        reject(new Fault(413, "body_too_large"));
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Fault(400, "invalid_json"));
      }
    });
    req.on("error", () => {
      clearTimeout(timer);
      reject(new Fault(400, "invalid_request"));
    });
  });
}
export function appServer(
  config: Config,
  runtime: Runtime,
  actions: Actions,
  options: {
    subscriptions?: readonly Subscription[];
    local?: LocalEndpoints;
    secrets?: string[];
    // Started by main.ts; tests may pass their own (or none: not started).
    proactive?: Proactive;
  } = {},
) {
  const boundary = new Boundary(config),
    redact = redactor(
      options.secrets ?? [config.apiKey, config.haToken, config.password],
    );
  // Available OAuth providers, ChatGPT/Codex first. Anthropic additionally
  // needs its (re-checked) feature flag; a provider without a Subscription is absent.
  const authProviders = () =>
    subscriptionProviders.flatMap((provider) => {
      const subscription = options.subscriptions?.find(
        (s) => s.provider === provider && s.enabled,
      );
      return subscription &&
        (provider !== "anthropic" || config.anthropicAuthEnabled === true)
        ? [subscription]
        : [];
    });
  const defaultAuthProvider = isSubscriptionProvider(config.provider)
    ? config.provider
    : "openai-codex";
  const subscriptionFor = (provider: unknown) => {
    insist(options.subscriptions?.length, "subscription_unavailable", 503);
    const name = provider === undefined ? defaultAuthProvider : provider;
    const subscription = authProviders().find((s) => s.provider === name);
    insist(subscription, "provider_unavailable", 403);
    return subscription;
  };
  const signedIn = (provider: string) =>
    authProviders().some((s) => s.provider === provider && s.configured());
  const configuredReady = () =>
    isSubscriptionProvider(config.provider)
      ? signedIn(config.provider)
      : config.provider === "local"
        ? !!options.local?.configured
        : true;
  const ready = () =>
    configuredReady() || authProviders().some((s) => s.configured());
  const apps = new AppStore(runtime, actions.engine.ha);
  const proactive =
    options.proactive ??
    new Proactive(runtime.harness, actions.engine.ha.reader(), {
      sanitize: (value) => actions.engine.ha.sanitize(value),
    });
  const feedback = new FeedbackStore(runtime);
  const memory = new MemoryStore(runtime);
  const lists = new ListStore(runtime, actions.engine.ha);
  const profile = new ProfileStore(runtime);
  const suggestions = new SuggestionStore(runtime, actions.engine.ha);
  // Today = watcher/briefing cards plus the owner's open suggestions; new
  // suggestions count toward the same unread badge.
  const todayView = async (
    owner: string,
    base?: Awaited<ReturnType<Proactive["today"]>>,
  ) => {
    const today = base ?? (await proactive.today(owner));
    const open = await suggestions.list(owner);
    const unseen = open.items.filter(
      (s) =>
        s.status === "pending" &&
        Math.max(s.created, s.snoozedUntil) > today.lastSeen,
    ).length;
    return { ...today, unread: today.unread + unseen, suggestions: open };
  };
  const world = new WorldStore(runtime, actions.engine.ha);
  const streams = new Set<ServerResponse>();
  const sessionStreams = new Map<number, Set<() => void>>();
  // Oldest-first per-owner stream stoppers; a new stream over the limit
  // evicts stream [0] (the oldest) instead of being refused, so a prior
  // chat's EventSource left open by a slow-closing proxy cannot starve a
  // newly opened one.
  const perOwnerStreams = new Map<string, Array<() => void>>();
  const OWNER_STREAM_LIMIT = 4;
  const rates = new Map<string, { count: number; until: number }>();
  let largeBodies = 0;
  const stringify = (data: unknown) =>
    JSON.stringify(data, (_key, val: unknown) =>
      typeof val === "string" ? redact(val) : val,
    );
  function json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(stringify(value));
  }
  const server = createServer({ maxHeaderSize: 16384 }, (req, res) => {
    void handle(req, res);
  });
  server.maxConnections = 100;
  server.headersTimeout = 10000;
  // Long enough for a message with attached images on a slow phone link;
  // other bodies keep their own 5-second read deadline.
  server.requestTimeout = 60000;
  server.keepAliveTimeout = 5000;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; object-src 'none'; frame-ancestors 'self' ${config.origin}; form-action 'self'`,
    );
    try {
      insist(!runtime.closing, "closing", 503);
      const owner = boundary.principal(req);
      const url = new URL(req.url ?? "/", "http://app.invalid");
      insist(
        url.origin === "http://app.invalid" && !url.search && !url.hash,
        "invalid_url",
      );
      const path = url.pathname;
      if (req.method === "POST") {
        boundary.mutation(req, owner);
        const now = Date.now();
        for (const [key, rate] of rates)
          if (rate.until < now) rates.delete(key);
        const rate = rates.get(owner) ?? { count: 0, until: now + 60000 };
        rate.count++;
        rates.set(owner, rate);
        insist(rate.count <= 60 && rates.size <= 100, "rate_limit", 429);
      } else insist(req.method === "GET", "method_not_allowed", 405);
      if (req.method === "GET" && path === "/api/bootstrap")
        return json(res, 200, {
          csrf: boundary.bootstrap(req, res, owner),
          version: await appVersion(),
          provider: config.provider,
          anthropicAuthEnabled: config.anthropicAuthEnabled === true,
          defaultThinkingLevel: runtime.defaultThinkingLevel,
          model:
            config.provider === "offline"
              ? "Offline demonstration"
              : config.provider === "local"
                ? (options.local?.model ?? "Local endpoint not configured")
                : config.model,
          safety:
            config.policy.access === "admin"
              ? "Home permissions · Admin access · every change is a risk-classified proposal"
              : config.policy.services.some((s) => s.startsWith("todo."))
                ? "Home permissions · scoped light/switch controls and to-do lists only"
                : "Home permissions · scoped light/switch controls only",
          access: config.policy.access === "admin" ? "admin" : "scoped",
          riskJudge: actions.engine.judge.describe(),
          entityScopeCount: new Set(config.policy.entities).size,
          homePermissions: await actions.engine.settings(owner),
          experimental: true,
          workspaceEnabled: config.workspaceEnabled ?? false,
          authProviders: authProviders().map((s) => s.provider),
          inferenceReady: ready(),
        });
      if (path === "/api/home-permissions") {
        if (req.method === "GET")
          return json(res, 200, await actions.engine.settings(owner));
        const v = object(await body(req), [
          "mode",
          "revision",
          "policy",
          "acknowledgement",
        ]);
        return json(
          res,
          200,
          await actions.engine.setMode(
            owner,
            v.mode,
            v.revision,
            v.policy,
            v.acknowledgement,
          ),
        );
      }
      if (path.startsWith("/api/auth/")) {
        if (req.method === "GET" && path === "/api/auth/status")
          return json(res, 200, subscriptionFor(undefined).status(owner));
        if (req.method === "GET" && path === "/api/auth/providers") {
          insist(
            options.subscriptions?.length,
            "subscription_unavailable",
            503,
          );
          return json(res, 200, {
            items: authProviders().map((s) => s.status(owner)),
          });
        }
        if (req.method === "POST" && path === "/api/auth/login") {
          const v = object(await body(req), ["method", "provider"]);
          return json(
            res,
            202,
            await subscriptionFor(v.provider).start(owner, v.method),
          );
        }
        if (req.method === "POST" && path === "/api/auth/answer") {
          const v = object(await body(req), ["id", "value", "provider"]);
          return json(
            res,
            200,
            subscriptionFor(v.provider).answer(owner, v.id, v.value),
          );
        }
        if (req.method === "POST" && path === "/api/auth/cancel") {
          const v = object(await body(req), ["id", "provider"]);
          return json(
            res,
            200,
            await subscriptionFor(v.provider).cancel(owner, v.id),
          );
        }
        if (req.method === "POST" && path === "/api/auth/verify") {
          const v = object(await body(req), ["provider"]);
          return json(
            res,
            200,
            await subscriptionFor(v.provider).verify(owner),
          );
        }
        if (req.method === "POST" && path === "/api/auth/logout") {
          const v = object(await body(req), ["provider"]);
          return json(
            res,
            200,
            await subscriptionFor(v.provider).logout(owner),
          );
        }
        throw new Fault(404, "not_found");
      }
      if (path.startsWith("/api/local/")) {
        const local = options.local;
        insist(local, "local_provider_not_selected", 409);
        if (req.method === "GET" && path === "/api/local/status")
          return json(res, 200, local.status(owner));
        if (req.method === "POST" && path === "/api/local/test") {
          const v = object(await body(req), ["url", "apiKey"]);
          return json(res, 200, await local.test(owner, v.url, v.apiKey));
        }
        if (req.method === "POST" && path === "/api/local/save") {
          const v = object(await body(req), ["id", "model"]);
          return json(res, 200, await local.save(owner, v.id, v.model));
        }
        if (req.method === "POST" && path === "/api/local/refresh") {
          object(await body(req), []);
          return json(res, 200, await local.refresh(owner));
        }
        if (req.method === "POST" && path === "/api/local/remove") {
          object(await body(req), []);
          return json(res, 200, await local.remove(owner));
        }
        throw new Fault(404, "not_found");
      }
      if (req.method === "GET" && path === "/api/models")
        return json(res, 200, { items: runtime.modelChoices() });
      if (req.method === "GET" && path === "/api/sessions")
        return json(res, 200, { items: await runtime.list(owner) });
      if (req.method === "POST" && path === "/api/sessions") {
        const v = object(await body(req), ["title", "requestId", "kind"]);
        const kind = v.kind ?? "home";
        // A session commits its model at creation; wait for a real local one.
        insist(
          config.provider !== "local" || options.local?.configured,
          "local_endpoint_required",
          403,
        );
        insist(
          kind === "home" || (kind === "workspace" && config.workspaceEnabled),
          "workspace_not_enabled",
          403,
        );
        return json(res, 201, {
          id: await runtime.create(owner, v.title, v.requestId, kind),
        });
      }
      if (req.method === "GET" && path === "/api/today")
        return json(res, 200, await todayView(owner));
      const todayRoute = /^\/api\/today\/(seen|dismiss|snooze|asked)$/.exec(
        path,
      );
      if (todayRoute && req.method === "POST") {
        const v = await body(req);
        const operation = todayRoute[1];
        if (operation === "asked")
          return json(res, 200, await proactive.asked(owner, v));
        const result =
          operation === "seen"
            ? await proactive.seen(owner, v)
            : operation === "dismiss"
              ? await proactive.dismiss(owner, v)
              : await proactive.snooze(owner, v);
        return json(res, 200, {
          ...(await todayView(owner, result)),
          ...("snoozedUntil" in result
            ? { snoozedUntil: result.snoozedUntil }
            : {}),
        });
      }
      const suggestionRoute =
        /^\/api\/suggestions\/(accept|reject|snooze|dismiss|draft)$/.exec(path);
      if (suggestionRoute && req.method === "POST") {
        const v = await body(req);
        const operation = suggestionRoute[1];
        const decision =
          operation === "accept"
            ? await suggestions.accept(owner, v)
            : operation === "reject"
              ? await suggestions.reject(owner, v)
              : operation === "snooze"
                ? await suggestions.snooze(owner, v)
                : operation === "draft"
                  ? await suggestions.draft(owner, v)
                  : await suggestions.dismiss(owner, v);
        return json(res, 200, { decision, ...(await todayView(owner)) });
      }
      if (path === "/api/profile") {
        if (req.method === "GET")
          return json(res, 200, await profile.get(owner));
        return json(res, 200, await profile.put(owner, await body(req)));
      }
      if (req.method === "GET" && path === "/api/memory")
        return json(res, 200, await memory.list(owner));
      const memoryRoute = /^\/api\/memory\/(add|edit|forget|share)$/.exec(path);
      if (memoryRoute && req.method === "POST") {
        const v = await body(req);
        const operation = memoryRoute[1];
        return json(
          res,
          200,
          operation === "add"
            ? await memory.add(owner, v)
            : operation === "edit"
              ? await memory.edit(owner, v)
              : operation === "share"
                ? await memory.share(owner, v)
                : await memory.forget(owner, v),
        );
      }
      // Shared lists (HA to-do lists) in Today: live reads, and presses that
      // become exact Home permissions proposals in one of the owner's chats.
      if (req.method === "GET" && path === "/api/lists")
        return json(res, 200, await lists.lists(owner));
      if (req.method === "POST" && path === "/api/lists/actions")
        return json(res, 200, await lists.press(owner, await body(req)));
      if (req.method === "GET" && path === "/api/proactive")
        return json(res, 200, await proactive.settings(owner));
      const proactiveRoute =
        /^\/api\/proactive\/(briefing|enabled|watchers\/add|watchers\/remove)$/.exec(
          path,
        );
      if (proactiveRoute && req.method === "POST") {
        const v = await body(req);
        const operation = proactiveRoute[1];
        if (operation === "watchers/add") {
          const result = await proactive.addWatcher(owner, v);
          return json(res, result.ok ? 200 : 400, result);
        }
        return json(
          res,
          200,
          operation === "briefing"
            ? await proactive.saveBriefing(owner, v)
            : operation === "enabled"
              ? await proactive.setWatchersEnabled(owner, v)
              : await proactive.removeWatcher(owner, v),
        );
      }
      if (req.method === "GET" && path === "/api/insights")
        return json(res, 200, {
          feedback: await feedback.insights(owner),
          today: await proactive.signals(owner),
        });
      if (req.method === "GET" && path === "/api/insights/export")
        return json(res, 200, {
          ...(await feedback.exportAll(owner)),
          today: await proactive.signals(owner),
        });
      if (req.method === "POST" && path === "/api/insights/delete") {
        const result = await feedback.deleteAll(owner, await body(req));
        await proactive.resetSignals(owner);
        return json(res, 200, result);
      }
      if (req.method === "GET" && path === "/api/world")
        return json(res, 200, await world.get(owner));
      if (req.method === "GET" && path === "/api/world/values")
        return json(res, 200, await world.values(owner));
      // Hearth's pending layout proposal: preview, then Keep or Discard.
      if (req.method === "GET" && path === "/api/world/draft")
        return json(res, 200, await world.draft(owner));
      if (req.method === "POST" && path === "/api/world/draft/keep")
        return json(res, 200, await world.keepDraft(owner, await body(req)));
      if (req.method === "POST" && path === "/api/world/draft/discard")
        return json(res, 200, await world.discardDraft(owner, await body(req)));
      const worldRoute = /^\/api\/world\/(layout|reset|migrate|actions)$/.exec(
        path,
      );
      if (worldRoute && req.method === "POST") {
        const operation = worldRoute[1];
        // A full customization (24 rooms, 64 device places) needs more room
        // than the default 8 KB body; still bounded and strictly validated.
        if (operation === "layout")
          return json(
            res,
            200,
            await world.save(owner, await body(req, 32768)),
          );
        if (operation === "migrate")
          return json(
            res,
            200,
            await world.migrate(owner, await body(req, 32768)),
          );
        if (operation === "reset")
          return json(res, 200, await world.reset(owner, await body(req)));
        return json(res, 200, await world.press(owner, await body(req)));
      }
      if (req.method === "GET" && path === "/api/apps")
        return json(res, 200, await apps.list(owner));
      const appRoute =
        /^\/api\/apps\/(app_[1-9][0-9]{0,8})(?:\/(state|pin|revert|delete|actions))?$/.exec(
          path,
        );
      if (appRoute) {
        const [, appId, operation] = appRoute;
        if (req.method === "GET" && !operation)
          return json(res, 200, await apps.get(owner, appId));
        if (req.method === "POST" && operation === "state")
          return json(
            res,
            200,
            await apps.setState(owner, appId, await body(req)),
          );
        if (req.method === "POST" && operation === "pin")
          return json(res, 200, await apps.pin(owner, appId, await body(req)));
        if (req.method === "POST" && operation === "revert")
          return json(
            res,
            200,
            await apps.revert(owner, appId, await body(req)),
          );
        if (req.method === "POST" && operation === "delete")
          return json(
            res,
            200,
            await apps.remove(owner, appId, await body(req)),
          );
        if (req.method === "POST" && operation === "actions")
          return json(
            res,
            200,
            await apps.press(owner, appId, await body(req)),
          );
        throw new Fault(404, "not_found");
      }
      const route =
        /^\/api\/sessions\/([1-9][0-9]{0,12})(?:\/(snapshot|events|inputs|abort|actions|model|delete|feedback|images\/([1-9][0-9]{0,12})\/([0-9])))?$/.exec(
          path,
        );
      if (route) {
        const id = Number(route[1]);
        const operation = route[2];
        const conversation = await runtime.session(owner, id);
        // An attached image of this owner's session, by transcript entry and
        // position. Bytes were validated on admission and are re-identified.
        if (req.method === "GET" && route[3] && route[4]) {
          const image = await runtime.image(
            owner,
            id,
            Number(route[3]),
            Number(route[4]),
          );
          res.writeHead(200, {
            "Content-Type": image.mimeType,
            "Content-Length": image.bytes.length,
            "Content-Disposition": "inline",
            // Transcript entries are immutable; private to this browser.
            "Cache-Control": "private, max-age=86400",
          });
          return res.end(image.bytes);
        }
        if (req.method === "POST" && operation === "delete") {
          const v = object(await body(req), ["confirm"]);
          insist(v.confirm === true, "confirmation_required");
          await runtime.delete(owner, id);
          for (const stop of sessionStreams.get(id) ?? []) stop();
          sessionStreams.delete(id);
          return json(res, 200, { deleted: true });
        }
        if (operation === "feedback")
          return json(
            res,
            200,
            req.method === "GET"
              ? await feedback.list(owner, id)
              : await feedback.record(owner, id, await body(req)),
          );
        if (req.method === "GET" && operation === "snapshot")
          return json(
            res,
            200,
            await runtime.snapshot(owner, id, config.policy.entities),
          );
        if (req.method === "GET" && operation === "events") {
          insist(streams.size < 20, "stream_limit", 429);
          const watch = await conversation.watch(ctx);
          const proposals = await runtime.harness.watchDoc(
            Proposals,
            conversation.id,
            ctx,
          );
          await actions.engine.settings(owner);
          const permissions = await runtime.harness.watchDoc(
            HomePermissions,
            ctx,
          );
          const canvas = await runtime.harness.watchDoc(
            HomeCanvas,
            conversation.id,
            ctx,
          );
          if (!proposals || !canvas || !permissions) {
            await watch.stop();
            await proposals?.stop();
            await canvas?.stop();
            await permissions?.stop();
            throw new Fault(404, "session_not_found");
          }
          if (res.destroyed) {
            await watch.stop();
            await proposals.stop();
            await canvas.stop();
            await permissions.stop();
            return;
          }
          const ownerStreams = perOwnerStreams.get(owner) ?? [];
          while (ownerStreams.length >= OWNER_STREAM_LIMIT) {
            const evict = ownerStreams.shift();
            evict?.();
          }
          perOwnerStreams.set(owner, ownerStreams);
          streams.add(res);
          let ended = false;
          let sending = false;
          let dirty = false;
          const stop = () => {
            if (ended) return;
            ended = true;
            streams.delete(res);
            sessionStreams.get(id)?.delete(stop);
            const owned = perOwnerStreams.get(owner);
            if (owned) {
              const at = owned.indexOf(stop);
              if (at !== -1) owned.splice(at, 1);
            }
            clearInterval(heartbeat);
            if (!res.writableEnded) res.end();
            void watch.stop();
            void proposals.stop();
            void canvas.stop();
            void permissions.stop();
          };
          ownerStreams.push(stop);
          const forSession = sessionStreams.get(id) ?? new Set();
          forSession.add(stop);
          sessionStreams.set(id, forSession);
          // One asynchronous snapshot at a time; coalesce change notifications.
          const send = async () => {
            if (ended) return;
            if (sending) {
              dirty = true;
              return;
            }
            sending = true;
            try {
              do {
                dirty = false;
                const payload = stringify(
                  await runtime.snapshot(owner, id, config.policy.entities),
                );
                if (ended) break;
                if (Buffer.byteLength(payload) > 4194304) {
                  res.end();
                  stop();
                  break;
                }
                // A slow reader gets one bounded wait for drain; changes made
                // meanwhile coalesce into the next snapshot.
                if (
                  !res.write(`event: snapshot\ndata: ${payload}\n\n`) &&
                  !(await drained())
                ) {
                  res.end();
                  stop();
                  break;
                }
              } while (dirty && !ended);
            } catch {
              res.end();
              stop();
            } finally {
              sending = false;
            }
          };
          let draining = false;
          const drained = () =>
            new Promise<boolean>((resolve) => {
              draining = true;
              const done = (value: boolean) => {
                draining = false;
                clearTimeout(timer);
                res.off("drain", onDrain);
                res.off("close", onClose);
                resolve(value && !ended);
              };
              const onDrain = () => done(true);
              const onClose = () => done(false);
              const timer = setTimeout(() => done(false), 15000);
              res.on("drain", onDrain);
              res.on("close", onClose);
            });
          const heartbeat = setInterval(() => {
            if (draining) return;
            if (!res.write(": connected\n\n")) {
              res.end();
              stop();
            }
          }, 15000);
          heartbeat.unref();
          res.on("close", stop);
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          await send();
          watch.start(send);
          proposals.start(send);
          canvas.start(send);
          permissions.start(send);
          return;
        }
        if (req.method === "POST" && operation === "model") {
          const v = object(await body(req), [
            "provider",
            "modelId",
            "thinkingLevel",
            "revision",
          ]);
          return json(
            res,
            200,
            await runtime.selectModel(
              owner,
              id,
              v.modelId,
              v.thinkingLevel,
              v.revision,
              v.provider,
            ),
          );
        }
        if (req.method === "POST" && operation === "inputs") {
          // Attached images make this the one large body: base64 of at most
          // 10 MB of images, read within 55 seconds on a slow phone link.
          // Few such bodies are buffered at once.
          insist(largeBodies < 4, "capacity", 429);
          largeBodies++;
          let raw: unknown;
          try {
            raw = await body(req, 14 * 1024 * 1024, 55000);
          } finally {
            largeBodies--;
          }
          const v = object(raw, ["requestId", "content", "images"]);
          const content = text(
            v.content,
            16000,
            v.images === undefined ? 1 : 0,
          );
          if (/^\/login\b/.test(content.trim())) {
            const command = /^\/login(?:\s+(anthropic|openai-codex))?$/.exec(
              content.trim(),
            );
            insist(command, "invalid_login_command");
            return json(res, 202, {
              auth: await subscriptionFor(command[1]).start(owner),
            });
          }
          // The session's committed provider decides readiness; a session on a
          // non-OAuth model (e.g. not yet switched) uses the configured provider.
          const committed = await runtime.sessionProvider(owner, id);
          const provider = isSubscriptionProvider(committed)
            ? committed
            : config.provider;
          insist(
            !isSubscriptionProvider(provider) || signedIn(provider),
            "subscription_login_required",
            403,
          );
          insist(
            provider !== "local" || options.local?.configured,
            "local_endpoint_required",
            403,
          );
          return json(res, 202, {
            submissionId: await runtime.submit(
              owner,
              id,
              v.requestId,
              v.content,
              v.images,
            ),
          });
        }
        if (req.method === "POST" && operation === "abort") {
          object(await body(req), []);
          await conversation.abort(ctx);
          return json(res, 200, { stopped: true });
        }
        if (req.method === "POST" && operation === "actions") {
          const v = object(await body(req), [
            "id",
            "hash",
            "decision",
            "note",
            "confirm",
          ]);
          const actionId = text(v.id, 20);
          insist(/^[1-9][0-9]*$/.test(actionId));
          const hash = text(v.hash, 64);
          insist(/^[a-f0-9]{64}$/.test(hash));
          insist(
            v.decision === "approve" ||
              v.decision === "reject" ||
              v.decision === "resolve",
          );
          const note = v.note === undefined ? "" : text(v.note, 300, 0);
          const confirm =
            v.confirm === undefined ? "" : text(v.confirm, 100, 0);
          await actions.decide(
            owner,
            id,
            actionId,
            hash,
            v.decision,
            note,
            confirm,
          );
          return json(res, 200, { recorded: true });
        }
      }
      if (req.method === "GET") {
        const files: Record<string, [string, string]> = {
          "/": ["index.html", "text/html; charset=utf-8"],
          "/app.js": ["app.js", "text/javascript"],
          "/render.js": ["render.js", "text/javascript"],
          "/apps.js": ["apps.js", "text/javascript"],
          "/today.js": ["today.js", "text/javascript"],
          "/app.css": ["app.css", "text/css"],
          "/icon.svg": ["icon.svg", "image/svg+xml"],
          // Home World modules, loaded on demand: exact files only.
          "/world/world.js": ["world/world.js", "text/javascript"],
          "/world/house.js": ["world/house.js", "text/javascript"],
          "/world/strip.js": ["world/strip.js", "text/javascript"],
          "/world/world.css": ["world/world.css", "text/css"],
        };
        const file = files[path];
        if (file) {
          res.writeHead(200, { "Content-Type": file[1] });
          return res.end(
            await readFile(
              fileURLToPath(new URL(`../public/${file[0]}`, import.meta.url)),
            ),
          );
        }
      }
      throw new Fault(404, "not_found");
    } catch (error) {
      if (res.headersSent) return res.end();
      const fault =
        error instanceof Fault ? error : new Fault(500, "request_failed");
      if (fault.status === 401)
        res.setHeader(
          "WWW-Authenticate",
          'Basic realm="Hearth Pi", charset="UTF-8"',
        );
      json(res, fault.status, { error: fault.code });
    }
  }
  return {
    server,
    async close() {
      runtime.closing = true;
      for (const res of streams) res.end();
      server.closeIdleConnections();
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      for (const subscription of options.subscriptions ?? [])
        await subscription.close();
      await proactive.stop();
      await actions.close();
      await runtime.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
