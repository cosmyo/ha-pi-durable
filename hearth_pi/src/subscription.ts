import { chmod, lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  AuthInteraction,
  Credential,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { Serial, insist, text } from "./safety.js";

const provider = "openai-codex";
// One controller/store owner; never mounted into the workspace container.
export class PrivateCredentials implements CredentialStore {
  private serial = new Serial();
  readonly secrets: string[];
  constructor(
    readonly path: string,
    seeds: string[] = [],
  ) {
    this.secrets = seeds.filter(Boolean);
  }
  private remember(value: Credential | undefined) {
    if (value?.type === "oauth")
      for (const s of [value.access, value.refresh])
        if (s && !this.secrets.includes(s)) this.secrets.push(s);
  }
  async read(id: string): Promise<Credential | undefined> {
    if (id !== provider) return undefined;
    const stat = await lstat(this.path).catch((e) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (!stat) return undefined;
    insist(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        (stat.mode & 0o077) === 0 &&
        stat.size <= 32768,
      "unsafe_credentials",
    );
    const value = JSON.parse(await readFile(this.path, "utf8")) as Credential;
    insist(
      value.type === "oauth" &&
        typeof value.access === "string" &&
        typeof value.refresh === "string" &&
        Number.isFinite(value.expires),
      "invalid_credentials",
    );
    this.remember(value);
    return value;
  }
  async list() {
    return (await this.read(provider))
      ? [{ providerId: provider, type: "oauth" as const }]
      : [];
  }
  async modify(
    id: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ) {
    insist(id === provider, "unsupported_credentials");
    return this.serial.run(async () => {
      const current = await this.read(id),
        next = await fn(current);
      if (!next) return current;
      insist(next.type === "oauth", "oauth_required");
      this.remember(next);
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      await rename(temp, this.path);
      await chmod(this.path, 0o600);
      return next;
    });
  }
  async delete(id: string) {
    insist(id === provider);
    await this.serial.run(async () => {
      const { unlink } = await import("node:fs/promises");
      await unlink(this.path).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    });
  }
}

type Login = {
  id: string;
  owner: string;
  abort: AbortController;
  expires: number;
  state: "starting" | "waiting" | "connected" | "cancelled" | "failed";
  url: string;
  userCode: string;
  manual: boolean;
  answer?: (value: string) => void;
  done: Promise<void>;
  timer: NodeJS.Timeout;
};
export class Subscription {
  private login?: Login;
  private operation = new Serial();
  constructor(
    readonly runtime: Pick<
      ModelRuntime,
      "login" | "logout" | "hasConfiguredAuth"
    >,
  ) {}
  static async open(dataDir: string, seeds: string[]) {
    const credentials = new PrivateCredentials(
      join(dataDir, "chatgpt-oauth.json"),
      seeds,
    );
    // Explicit storage; no ~/.pi discovery, project resources, custom endpoints or catalog fetch.
    const runtime = await ModelRuntime.create({
      credentials,
      authPath: credentials.path,
      modelsPath: null,
      modelsStorePath: join(dataDir, "pi-model-cache.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    // Static provider: initialize auth metadata only. No remote catalogs, token exchange or model requests.
    await runtime.refresh({ providers: [provider], allowNetwork: false });
    return {
      subscription: new Subscription(runtime),
      runtime,
      secrets: credentials.secrets,
    };
  }
  status(owner: string) {
    const login = this.login?.owner === owner ? this.login : undefined;
    return {
      configured: this.runtime.hasConfiguredAuth(provider),
      subscription: true,
      ...(login
        ? {
            login: {
              id: login.id,
              state: login.state,
              expires: login.expires,
              url: login.url,
              userCode: login.userCode,
              manual: login.manual,
            },
          }
        : {}),
    };
  }
  start(owner: string, method: unknown) {
    insist(
      method === "device_code" || method === "browser",
      "invalid_login_method",
    );
    return this.operation.run(async () => {
      insist(
        !this.login ||
          ["connected", "failed", "cancelled"].includes(this.login.state),
        "login_in_progress",
        409,
      );
      const login: Login = {
        id: randomUUID(),
        owner,
        abort: new AbortController(),
        expires: Date.now() + 15 * 60000,
        state: "starting",
        url: "",
        userCode: "",
        manual: false,
        done: Promise.resolve(),
        timer: undefined!,
      };
      this.login = login;
      login.timer = setTimeout(() => login.abort.abort(), 15 * 60000);
      login.timer.unref();
      const interaction: AuthInteraction = {
        signal: login.abort.signal,
        prompt: async (prompt) => {
          if (prompt.type === "select") {
            insist(prompt.options.some((o) => o.id === method));
            return method;
          }
          insist(
            method === "browser" && prompt.type === "manual_code",
            "unexpected_auth_prompt",
          );
          login.manual = true;
          login.state = "waiting";
          return new Promise<string>((resolve, reject) => {
            const signal = prompt.signal
              ? AbortSignal.any([prompt.signal, login.abort.signal])
              : login.abort.signal;
            const cancel = () => {
              login.answer = undefined;
              reject(new Error("login_cancelled"));
            };
            signal.addEventListener("abort", cancel, { once: true });
            login.answer = (value) => {
              signal.removeEventListener("abort", cancel);
              login.answer = undefined;
              login.manual = false;
              resolve(value);
            };
            if (signal.aborted) cancel();
          });
        },
        notify: (event) => {
          if (event.type === "auth_url" || event.type === "device_code") {
            const url = new URL(
              event.type === "auth_url" ? event.url : event.verificationUri,
            );
            insist(
              url.origin === "https://auth.openai.com",
              "unexpected_login_origin",
            );
            login.url = url.href;
            login.userCode = event.type === "device_code" ? event.userCode : "";
            login.state = "waiting";
          }
          // Never forward raw provider progress/error messages, credentials or token responses.
        },
      };
      login.done = this.runtime
        .login(provider, "oauth", interaction)
        .then(
          () => {
            login.state = "connected";
          },
          () => {
            login.state = login.abort.signal.aborted ? "cancelled" : "failed";
          },
        )
        .finally(() => {
          clearTimeout(login.timer);
          login.url = "";
          login.userCode = "";
          login.manual = false;
          login.answer = undefined;
        });
      return this.status(owner);
    });
  }
  answer(owner: string, id: unknown, value: unknown) {
    const login = this.login;
    insist(
      login?.owner === owner &&
        login.id === id &&
        login.answer &&
        !login.abort.signal.aborted &&
        login.expires > Date.now(),
      "login_not_pending",
      409,
    );
    const entered = text(value, 4096);
    const url = new URL(entered);
    // Browser fallback must include state, which the official Pi flow validates against its PKCE transaction.
    insist(
      url.origin === "http://localhost:1455" &&
        url.pathname === "/auth/callback" &&
        url.searchParams.get("code") &&
        url.searchParams.get("state"),
      "redirect_url_required",
    );
    login.answer(entered);
    return { accepted: true };
  }
  cancel(owner: string, id: unknown) {
    return this.operation.run(async () => {
      insist(
        this.login?.owner === owner && this.login.id === id,
        "login_not_found",
        404,
      );
      this.login.abort.abort();
      await this.login.done;
      return this.status(owner);
    });
  }
  logout(owner: string) {
    return this.operation.run(async () => {
      if (
        this.login &&
        !["connected", "failed", "cancelled"].includes(this.login.state)
      )
        insist(this.login.owner === owner, "login_in_progress", 409);
      this.login?.abort.abort();
      await this.login?.done;
      await this.runtime.logout(provider);
      this.login = undefined;
      return this.status(owner);
    });
  }
  async close() {
    this.login?.abort.abort();
    await this.login?.done;
  }
}
