// Minimal, bounded, read-only Home Assistant WebSocket client used only for
// automation traces, which HA exposes over WebSocket and not REST. It can send
// exactly the allowlisted message types below; anything else is refused before
// a frame is written. One short-lived connection per troubleshooting read.
import { Fault, insist } from "./safety.js";

export const HA_WEBSOCKET_URL = "ws://supervisor/core/websocket";
// "auth" is only sent by the handshake; commands may use the trace types.
export const HA_WEBSOCKET_TYPES = Object.freeze([
  "auth",
  "trace/list",
  "trace/get",
] as const);
export type HAWebSocketCommand = "trace/list" | "trace/get";

// The subset of the WHATWG WebSocket used here; tests inject a fake.
export type SocketLike = {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
};
export type SocketFactory = (url: string) => SocketLike;
export const defaultSocket: SocketFactory = (url) =>
  new WebSocket(url) as unknown as SocketLike;

export type HAWebSocketLimits = {
  timeoutMs: number;
  messageBytes: number;
  totalBytes: number;
  commands: number;
};
export const HA_WEBSOCKET_LIMITS: HAWebSocketLimits = Object.freeze({
  timeoutMs: 10000,
  messageBytes: 1048576,
  totalBytes: 4194304,
  commands: 8,
});

export type HAWebSocketCall = (
  type: HAWebSocketCommand,
  payload: Record<string, string>,
) => Promise<unknown>;

// The single write path to the socket. Refuses every non-allowlisted type.
export function sendAllowed(
  socket: Pick<SocketLike, "send">,
  message: { type: string } & Record<string, unknown>,
): void {
  insist(
    (HA_WEBSOCKET_TYPES as readonly string[]).includes(message.type),
    "ws_type_not_allowed",
    403,
  );
  socket.send(JSON.stringify(message));
}

// Opens one authenticated connection, runs `work` with an allowlisted call
// function, then closes. The whole session shares one deadline; each frame and
// the session total are size-capped; text is redacted before parsing.
export async function haWebSocketSession<T>(
  factory: SocketFactory,
  token: string,
  redact: (value: string) => string,
  work: (call: HAWebSocketCall) => Promise<T>,
  signal?: AbortSignal,
  limits: HAWebSocketLimits = HA_WEBSOCKET_LIMITS,
): Promise<T> {
  insist(token, "ha_unconfigured", 503);
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  if (abort.aborted) throw new Fault(502, "ha_read_failed");
  const inbox: Record<string, unknown>[] = [];
  let waiter: (() => void) | null = null;
  let failure: Fault | null = null;
  let total = 0;
  const wake = () => {
    const w = waiter;
    waiter = null;
    w?.();
  };
  const fail = (code: string) => {
    failure ??= new Fault(502, code);
    wake();
  };
  let socket: SocketLike;
  try {
    socket = factory(HA_WEBSOCKET_URL);
  } catch {
    throw new Fault(502, "ha_read_failed");
  }
  const onAbort = () => fail("ha_read_failed");
  abort.addEventListener("abort", onAbort, { once: true });
  socket.onerror = () => fail("ha_read_failed");
  socket.onclose = () => fail("ha_read_failed");
  socket.onmessage = (event) => {
    if (failure) return;
    if (typeof event.data !== "string") return fail("ha_read_failed");
    const bytes = Buffer.byteLength(event.data);
    total += bytes;
    if (bytes > limits.messageBytes || total > limits.totalBytes)
      return fail("ha_response_limit");
    let parsed: unknown;
    try {
      parsed = JSON.parse(redact(event.data));
    } catch {
      return fail("ha_read_failed");
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed])
      if (item && typeof item === "object" && !Array.isArray(item))
        inbox.push(item as Record<string, unknown>);
    wake();
  };
  const next = async (
    match: (m: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> => {
    for (;;) {
      if (failure) throw failure;
      const index = inbox.findIndex(match);
      if (index >= 0) return inbox.splice(index, 1)[0]!;
      inbox.length = 0; // unrelated frames are dropped, never buffered
      await new Promise<void>((resolve) => (waiter = resolve));
    }
  };
  try {
    const greeting = await next((m) => typeof m.type === "string");
    insist(greeting.type === "auth_required", "ha_read_failed", 502);
    sendAllowed(socket, { type: "auth", access_token: token });
    const auth = await next((m) => typeof m.type === "string");
    insist(auth.type === "auth_ok", "ha_auth_failed", 502);
    let id = 0;
    const call: HAWebSocketCall = async (type, payload) => {
      insist(type !== ("auth" as string), "ws_type_not_allowed", 403);
      insist(id < limits.commands, "ha_request_limit", 502);
      const mine = ++id;
      sendAllowed(socket, { ...payload, id: mine, type });
      const reply = await next((m) => m.id === mine && m.type === "result");
      if (reply.success !== true) {
        const code = (reply.error as { code?: unknown } | undefined)?.code;
        throw new Fault(
          code === "not_found" ? 404 : 502,
          code === "not_found" ? "ha_not_found" : "ha_read_failed",
        );
      }
      return reply.result;
    };
    return await work(call);
  } catch (error) {
    // Raw socket/upstream errors may carry details; expose only a code.
    throw error instanceof Fault ? error : new Fault(502, "ha_read_failed");
  } finally {
    abort.removeEventListener("abort", onAbort);
    socket.onmessage = socket.onerror = socket.onclose = null;
    try {
      socket.close();
    } catch {
      // already closed
    }
  }
}
