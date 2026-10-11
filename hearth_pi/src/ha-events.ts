// Long-lived Home Assistant event subscriber for Phone approvals
// (src/approval-push.ts). Separate from the short-lived read client in
// ha-websocket.ts on purpose: it can send exactly `auth`, one
// `subscribe_events` for the single event type below, and `ping`; every
// other frame is refused before it is written. It never calls a service.
// Reconnecting is a read, so it reconnects with backoff (1 s → 60 s); a tap
// that happens while it is disconnected is lost and its proposal simply
// stays pending until it expires.
import {
  HA_WEBSOCKET_URL,
  sendAllowed,
  type SocketFactory,
  type SocketLike,
} from "./ha-websocket.js";

export const HA_EVENT_TYPE = "mobile_app_notification_action";
export const HA_EVENT_SOCKET_TYPES = Object.freeze([
  "auth",
  "subscribe_events",
  "ping",
] as const);
// One notification action event is small; anything larger is dropped.
export const HA_EVENT_FRAME_BYTES = 65536;

// The fields Phone approvals reads from one bus event; everything else in
// the frame is discarded before the handler sees it.
export type NotificationActionEvent = {
  eventType: unknown;
  origin: unknown;
  action: unknown;
  userId: unknown;
};

export type HAEventOptions = {
  minBackoffMs?: number;
  maxBackoffMs?: number;
  pingMs?: number;
  // A connection that does not finish auth + subscribe in time is dropped.
  handshakeMs?: number;
};

export class HAEventSubscriber {
  private socket: SocketLike | null = null;
  private running = false;
  private backoff: number;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private subscribed = false;
  private awaitingPong = false;
  // Visible for tests and diagnostics: completed subscriptions.
  connections = 0;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly pingMs: number;
  private readonly handshakeMs: number;
  constructor(
    private factory: SocketFactory,
    private token: string,
    private redact: (value: string) => string,
    private onEvent: (event: NotificationActionEvent) => void,
    options: HAEventOptions = {},
  ) {
    this.minBackoff = options.minBackoffMs ?? 1000;
    this.maxBackoff = options.maxBackoffMs ?? 60000;
    this.pingMs = options.pingMs ?? 30000;
    this.handshakeMs = options.handshakeMs ?? 10000;
    this.backoff = this.minBackoff;
  }
  get active() {
    return this.running;
  }
  get connected() {
    return this.subscribed;
  }
  start() {
    if (this.running || !this.token) return;
    this.running = true;
    this.connect();
  }
  stop() {
    this.running = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.drop();
  }
  private later(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }
  private drop() {
    const socket = this.socket;
    this.socket = null;
    this.subscribed = false;
    this.awaitingPong = false;
    if (!socket) return;
    socket.onmessage = socket.onerror = socket.onclose = socket.onopen = null;
    try {
      socket.close();
    } catch {
      // already closed
    }
  }
  private retry() {
    this.drop();
    if (!this.running) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    this.later(() => this.running && this.connect(), wait);
  }
  private send(message: { type: string } & Record<string, unknown>) {
    const socket = this.socket;
    if (!socket) return;
    sendAllowed(socket, message, HA_EVENT_SOCKET_TYPES);
  }
  private connect() {
    let socket: SocketLike;
    try {
      socket = this.factory(HA_WEBSOCKET_URL);
    } catch {
      return this.retry();
    }
    this.socket = socket;
    let stage: "greeting" | "auth" | "subscribe" | "live" = "greeting";
    let id = 0;
    let subscription = 0;
    let pingId = 0;
    const handshake = this.later(() => {
      if (this.socket === socket && stage !== "live") this.retry();
    }, this.handshakeMs);
    const fail = () => {
      if (this.socket === socket) this.retry();
    };
    socket.onerror = fail;
    socket.onclose = fail;
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      if (
        typeof event.data !== "string" ||
        Buffer.byteLength(event.data) > HA_EVENT_FRAME_BYTES
      )
        return fail();
      let parsed: unknown;
      try {
        parsed = JSON.parse(this.redact(event.data));
      } catch {
        return fail();
      }
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (this.socket !== socket) return;
        if (!item || typeof item !== "object") continue;
        const m = item as Record<string, unknown>;
        try {
          if (stage === "greeting") {
            if (m.type !== "auth_required") return fail();
            stage = "auth";
            this.send({ type: "auth", access_token: this.token });
          } else if (stage === "auth") {
            if (m.type !== "auth_ok") return fail();
            stage = "subscribe";
            subscription = ++id;
            this.send({
              id: subscription,
              type: "subscribe_events",
              event_type: HA_EVENT_TYPE,
            });
          } else if (stage === "subscribe") {
            if (m.id !== subscription || m.type !== "result") continue;
            if (m.success !== true) return fail();
            stage = "live";
            clearTimeout(handshake);
            this.timers.delete(handshake);
            this.subscribed = true;
            this.connections++;
            this.backoff = this.minBackoff;
            const ping = () => {
              if (this.socket !== socket) return;
              if (this.awaitingPong) return fail();
              this.awaitingPong = true;
              pingId = ++id;
              this.send({ id: pingId, type: "ping" });
              this.later(ping, this.pingMs);
            };
            this.later(ping, this.pingMs);
          } else if (m.type === "pong" && m.id === pingId) {
            this.awaitingPong = false;
          } else if (m.type === "event" && m.id === subscription) {
            const e =
              m.event && typeof m.event === "object"
                ? (m.event as Record<string, unknown>)
                : {};
            const data =
              e.data && typeof e.data === "object"
                ? (e.data as Record<string, unknown>)
                : {};
            const context =
              e.context && typeof e.context === "object"
                ? (e.context as Record<string, unknown>)
                : {};
            try {
              this.onEvent({
                eventType: e.event_type,
                origin: e.origin,
                action: data.action,
                userId: context.user_id,
              });
            } catch {
              // A handler failure never stops the subscription.
            }
          }
        } catch {
          return fail();
        }
      }
    };
  }
}
