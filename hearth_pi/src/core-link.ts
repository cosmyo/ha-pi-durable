// Hearth Assist's link to Home Assistant Core: one 32-byte secret in
// /data/core-link.key (mode 0600), handed to Core only through Supervisor
// discovery (`hearth_pi`: host, port, api, token), the way other add-ons hand
// Core their credentials. Only Core can read discovery messages. The secret
// lives in Hearth's /data, in Core's stored config entry and in backups; it
// is never logged, shown in the browser or put in a prompt, and an owner can
// rotate it from Settings (the new value is published again).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Serial } from "./safety.js";

export const CORE_LINK_PORT = 8098;
export const CORE_LINK_SERVICE = "hearth_pi";
export const CORE_LINK_API = 1;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const sha = (value: string) => createHash("sha256").update(value).digest();
const newToken = () => randomBytes(32).toString("base64url");

export type CoreLinkOptions = {
  supervisorToken: string;
  // This container's hostname on the Supervisor network (Core's view).
  host: string;
  port?: number;
  transport?: typeof fetch;
  // The live redaction list: the link secret is added (and kept after a
  // rotation, so an old value is still redacted).
  secrets?: string[];
  log?: (line: string) => void;
};
export type CoreLinkStatus = {
  published: boolean;
  publishedAt: number;
  rotatedAt: number;
};

export class CoreLink {
  private writes = new Serial();
  private state: CoreLinkStatus = {
    published: false,
    publishedAt: 0,
    rotatedAt: 0,
  };
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private constructor(
    private file: string,
    private token: string,
    private options: CoreLinkOptions,
  ) {
    options.secrets?.push(token);
  }
  static async open(dataDir: string, options: CoreLinkOptions) {
    const file = join(dataDir, "core-link.key");
    let token = "";
    try {
      token = (await readFile(file, "utf8")).trim();
    } catch {
      token = "";
    }
    if (TOKEN_PATTERN.test(token)) await chmod(file, 0o600);
    else {
      token = newToken();
      await CoreLink.save(file, token);
    }
    return new CoreLink(file, token, options);
  }
  private static async save(file: string, token: string) {
    const temporary = `${file}.tmp`;
    await writeFile(temporary, token, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  }
  // Exactly "Bearer <secret>", compared in constant time over digests.
  verify(header: string): boolean {
    return timingSafeEqual(sha(header), sha(`Bearer ${this.token}`));
  }
  status(): CoreLinkStatus {
    return { ...this.state };
  }
  private log(line: string) {
    (this.options.log ?? ((value) => console.info(value)))(line);
  }
  // Publish (or update) the discovery message. Supervisor keeps one message
  // per add-on and service and pushes a changed config to Core again.
  async publish(): Promise<boolean> {
    const transport = this.options.transport ?? fetch;
    let ok = false;
    if (this.options.host && this.options.supervisorToken)
      try {
        const response = await transport("http://supervisor/discovery", {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.options.supervisorToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            service: CORE_LINK_SERVICE,
            config: {
              host: this.options.host,
              port: this.options.port ?? CORE_LINK_PORT,
              api: CORE_LINK_API,
              token: this.token,
            },
          }),
          signal: AbortSignal.timeout(10000),
        });
        ok = response.ok;
        await response.body?.cancel();
      } catch {
        ok = false;
      }
    this.state.published = ok;
    if (ok) this.state.publishedAt = Date.now();
    // Never the request body, the secret or an upstream error.
    this.log(
      ok
        ? "Hearth Assist: Core link published through Supervisor discovery."
        : "Hearth Assist: could not publish the Core link through Supervisor discovery; retrying.",
    );
    return ok;
  }
  // Startup: publish, retrying a few times while Supervisor or Core starts.
  start(attempts = 10, delayMs = 60000) {
    const attempt = async (left: number) => {
      if (this.stopped) return;
      if ((await this.writes.run(() => this.publish())) || left <= 1) return;
      this.retry = setTimeout(() => void attempt(left - 1), delayMs);
      this.retry.unref?.();
    };
    void attempt(attempts);
  }
  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
  }
  // A new secret replaces the old one at once (the old one stops working)
  // and is published again so Core's config entry follows.
  async rotate(): Promise<CoreLinkStatus> {
    await this.writes.run(async () => {
      const token = newToken();
      await CoreLink.save(this.file, token);
      this.options.secrets?.push(token);
      this.token = token;
      this.state.rotatedAt = Date.now();
      await this.publish();
    });
    return this.status();
  }
}
