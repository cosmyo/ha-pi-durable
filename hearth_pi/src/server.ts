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
import type { Subscription } from "./subscription.js";

async function body(req: IncomingMessage): Promise<unknown> {
  insist(
    req.headers["content-type"] === "application/json",
    "json_required",
    415,
  );
  insist(!req.headers["content-encoding"], "encoding_rejected", 415);
  insist(
    Number(req.headers["content-length"] ?? 0) <= 8192,
    "body_too_large",
    413,
  );
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(
      () => reject(new Fault(408, "body_timeout")),
      5000,
    );
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8192) {
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
  options: { subscription?: Subscription; secrets?: string[] } = {},
) {
  const boundary = new Boundary(config),
    redact = redactor(
      options.secrets ?? [config.apiKey, config.haToken, config.password],
    );
  const streams = new Set<ServerResponse>();
  const perOwner = new Map<string, number>();
  const rates = new Map<string, { count: number; until: number }>();
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
  server.requestTimeout = 15000;
  server.keepAliveTimeout = 5000;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self' ${config.origin}; form-action 'self'`,
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
          provider: config.provider,
          defaultThinkingLevel: runtime.defaultThinkingLevel,
          model:
            config.provider === "offline"
              ? "Offline demonstration"
              : config.model,
          safety: "Home permissions · scoped light/switch controls only",
          entityScopeCount: new Set(config.policy.entities).size,
          homePermissions: await actions.engine.settings(owner),
          experimental: true,
          workspaceEnabled: config.workspaceEnabled ?? false,
          inferenceReady:
            config.provider !== "openai-codex" ||
            !!options.subscription?.status(owner).configured,
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
        const subscription = options.subscription;
        insist(subscription, "subscription_unavailable", 503);
        if (req.method === "GET" && path === "/api/auth/status")
          return json(res, 200, subscription.status(owner));
        if (req.method === "POST" && path === "/api/auth/login") {
          const v = object(await body(req), ["method"]);
          return json(res, 202, await subscription.start(owner, v.method));
        }
        if (req.method === "POST" && path === "/api/auth/answer") {
          const v = object(await body(req), ["id", "value"]);
          return json(res, 200, subscription.answer(owner, v.id, v.value));
        }
        if (req.method === "POST" && path === "/api/auth/cancel") {
          const v = object(await body(req), ["id"]);
          return json(res, 200, await subscription.cancel(owner, v.id));
        }
        if (req.method === "POST" && path === "/api/auth/logout") {
          object(await body(req), []);
          return json(res, 200, await subscription.logout(owner));
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
        insist(
          kind === "home" || (kind === "workspace" && config.workspaceEnabled),
          "workspace_not_enabled",
          403,
        );
        return json(res, 201, {
          id: await runtime.create(owner, v.title, v.requestId, kind),
        });
      }
      const route =
        /^\/api\/sessions\/([1-9][0-9]{0,12})(?:\/(snapshot|events|inputs|abort|actions|model))?$/.exec(
          path,
        );
      if (route) {
        const id = Number(route[1]);
        const operation = route[2];
        const conversation = await runtime.session(owner, id);
        if (req.method === "GET" && operation === "snapshot")
          return json(
            res,
            200,
            await runtime.snapshot(owner, id, config.policy.entities),
          );
        if (req.method === "GET" && operation === "events") {
          insist(
            streams.size < 20 && (perOwner.get(owner) ?? 0) < 2,
            "stream_limit",
            429,
          );
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
          streams.add(res);
          perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
          let ended = false;
          let sending = false;
          let dirty = false;
          const stop = () => {
            if (ended) return;
            ended = true;
            streams.delete(res);
            perOwner.set(owner, Math.max(0, (perOwner.get(owner) ?? 1) - 1));
            clearInterval(heartbeat);
            void watch.stop();
            void proposals.stop();
            void canvas.stop();
            void permissions.stop();
          };
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
                if (
                  Buffer.byteLength(payload) > 4194304 ||
                  !res.write(`event: snapshot\ndata: ${payload}\n\n`)
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
          const heartbeat = setInterval(() => {
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
            ),
          );
        }
        if (req.method === "POST" && operation === "inputs") {
          insist(
            config.provider !== "openai-codex" ||
              options.subscription?.status(owner).configured,
            "subscription_login_required",
            403,
          );
          const v = object(await body(req), ["requestId", "content"]);
          return json(res, 202, {
            submissionId: await runtime.submit(
              owner,
              id,
              v.requestId,
              v.content,
            ),
          });
        }
        if (req.method === "POST" && operation === "abort") {
          object(await body(req), []);
          await conversation.abort(ctx);
          return json(res, 200, { stopped: true });
        }
        if (req.method === "POST" && operation === "actions") {
          const v = object(await body(req), ["id", "hash", "decision", "note"]);
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
          await actions.decide(owner, id, actionId, hash, v.decision, note);
          return json(res, 200, { recorded: true });
        }
      }
      if (req.method === "GET") {
        const files: Record<string, [string, string]> = {
          "/": ["index.html", "text/html; charset=utf-8"],
          "/app.js": ["app.js", "text/javascript"],
          "/render.js": ["render.js", "text/javascript"],
          "/app.css": ["app.css", "text/css"],
          "/icon.svg": ["icon.svg", "image/svg+xml"],
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
      await options.subscription?.close();
      await actions.close();
      await runtime.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
