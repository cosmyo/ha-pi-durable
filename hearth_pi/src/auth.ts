import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.js";
import { equal, insist } from "./safety.js";

export function oneHeader(req: IncomingMessage, name: string): string {
  insist(
    req.rawHeaders.filter(
      (_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === name,
    ).length <= 1,
    "duplicate_header",
    400,
  );
  const value = req.headers[name];
  insist(!Array.isArray(value), "duplicate_header");
  return value ?? "";
}
export class Boundary {
  private secret = randomBytes(32);
  constructor(readonly config: Config) {}
  principal(req: IncomingMessage): string {
    if (this.config.mode === "ingress") {
      const peer = req.socket.remoteAddress?.replace(/^::ffff:/, "");
      insist(peer === "172.30.32.2", "untrusted_ingress_peer", 403);
      const user = oneHeader(req, "x-remote-user-id");
      insist(
        /^[a-zA-Z0-9_-]{1,100}$/.test(user) &&
          this.config.authorizedUsers.includes(user),
        "user_not_authorized",
        403,
      );
      return user;
    }
    insist(
      ["127.0.0.1", "::1"].includes(
        req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "",
      ),
      "not_loopback",
      403,
    );
    // Ingress identity headers can never authenticate local mode.
    const header = oneHeader(req, "authorization");
    const expected = `Basic ${Buffer.from(`hearth:${this.config.password}`).toString("base64")}`;
    insist(
      this.config.password.length >= 24 && equal(header, expected),
      "authentication_required",
      401,
    );
    return "local-admin";
  }
  private browser(req: IncomingMessage): string {
    const cookies = oneHeader(req, "cookie")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("hearth_browser="));
    insist(cookies.length <= 1, "duplicate_cookie");
    const value = cookies[0]?.slice("hearth_browser=".length) ?? "";
    return /^[a-f0-9]{64}$/.test(value) ? value : "";
  }
  private capability(owner: string, browser: string) {
    return createHmac("sha256", this.secret)
      .update(`${owner}:${browser}`)
      .digest("hex");
  }
  bootstrap(req: IncomingMessage, res: ServerResponse, owner: string): string {
    const browser = this.browser(req) || randomBytes(32).toString("hex");
    res.setHeader(
      "Set-Cookie",
      `hearth_browser=${browser}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${this.config.mode === "ingress" ? "; Secure" : ""}`,
    );
    return this.capability(owner, browser);
  }
  mutation(req: IncomingMessage, owner: string) {
    insist(
      oneHeader(req, "origin") === this.config.origin,
      "origin_rejected",
      403,
    );
    const browser = this.browser(req);
    insist(
      browser &&
        equal(oneHeader(req, "x-hearth-csrf"), this.capability(owner, browser)),
      "csrf_rejected",
      403,
    );
  }
}
