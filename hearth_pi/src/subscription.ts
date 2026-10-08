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
import { anthropicAuthEnabled } from "./features.js";

export type SubscriptionProvider = "openai-codex" | "anthropic";
/** OAuth login providers in display order; ChatGPT/Codex is always first. */
export const subscriptionProviders: readonly SubscriptionProvider[] = [
  "openai-codex",
  "anthropic",
];
export const isSubscriptionProvider = (
  value: unknown,
): value is SubscriptionProvider =>
  subscriptionProviders.some((provider) => provider === value);
const credentialFiles: Record<SubscriptionProvider, string> = {
  "openai-codex": "chatgpt-oauth.json",
  anthropic: "anthropic-oauth.json",
};
const providers = {
  "openai-codex": {
    name: "ChatGPT / Codex",
    origin: "https://auth.openai.com",
    redirect: { origin: "http://localhost:1455", path: "/auth/callback" },
    methods: ["browser", "device_code"],
  },
  anthropic: {
    name: "Anthropic / Claude (experimental)",
    origin: "https://claude.ai",
    redirect: { origin: "http://localhost:53692", path: "/callback" },
    methods: ["browser", "copy_code"],
  },
} as const;
// One controller/store owner; never mounted into the workspace container.
export class PrivateCredentials implements CredentialStore {
  private serial = new Serial();
  readonly secrets: string[];
  /** Non-secret expiry of the stored token, for status display only. */
  expires: number | undefined;
  constructor(
    readonly path: string,
    seeds: string[] = [],
    readonly provider: SubscriptionProvider = "openai-codex",
    // Optional shared redaction list, so every provider's seeds and refreshed
    // tokens land in the one list the server and model wrapper redact with.
    secrets: string[] = [],
  ) {
    this.secrets = secrets;
    for (const s of seeds)
      if (s && !this.secrets.includes(s)) this.secrets.push(s);
  }
  private validate(
    value: Credential,
  ): asserts value is Extract<Credential, { type: "oauth" }> {
    insist(
      value.type === "oauth" &&
        typeof value.access === "string" &&
        value.access.length > 0 &&
        value.access.length <= 12000 &&
        typeof value.refresh === "string" &&
        value.refresh.length > 0 &&
        value.refresh.length <= 12000 &&
        Number.isFinite(value.expires) &&
        value.expires > 0,
      "invalid_credentials",
    );
  }
  private remember(value: Credential | undefined) {
    if (value?.type === "oauth")
      for (const s of [value.access, value.refresh])
        if (s && !this.secrets.includes(s)) this.secrets.push(s);
  }
  async read(id: string): Promise<Credential | undefined> {
    if (id !== this.provider) return undefined;
    const stat = await lstat(this.path).catch((e) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (!stat) {
      this.expires = undefined;
      return undefined;
    }
    insist(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        (stat.mode & 0o077) === 0 &&
        stat.size <= 32768,
      "unsafe_credentials",
    );
    const value = JSON.parse(await readFile(this.path, "utf8")) as Credential;
    this.validate(value);
    this.remember(value);
    this.expires = value.expires;
    return value;
  }
  async list() {
    return (await this.read(this.provider))
      ? [{ providerId: this.provider, type: "oauth" as const }]
      : [];
  }
  async modify(
    id: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ) {
    insist(id === this.provider, "unsupported_credentials");
    return this.serial.run(async () => {
      const current = await this.read(id),
        next = await fn(current);
      if (!next) return current;
      insist(next.type === "oauth", "oauth_required");
      this.validate(next);
      this.remember(next);
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      await rename(temp, this.path);
      await chmod(this.path, 0o600);
      this.expires = next.expires;
      return next;
    });
  }
  async delete(id: string) {
    insist(id === this.provider, "unsupported_credentials");
    await this.serial.run(async () => {
      const { unlink } = await import("node:fs/promises");
      await unlink(this.path).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      this.expires = undefined;
    });
  }
}

// One Pi credential store over the per-provider private files: each provider
// id is delegated to its own PrivateCredentials (own file, own serial lock),
// so Pi's refresh-under-lock stays per provider. Unknown ids are refused.
export class ProviderCredentials implements CredentialStore {
  constructor(readonly stores: readonly PrivateCredentials[]) {}
  private store(id: string) {
    return this.stores.find((store) => store.provider === id);
  }
  async read(id: string) {
    return this.store(id)?.read(id);
  }
  async list() {
    return (await Promise.all(this.stores.map((store) => store.list()))).flat();
  }
  modify(
    id: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ) {
    const store = this.store(id);
    insist(store, "unsupported_credentials");
    return store.modify(id, fn);
  }
  async delete(id: string) {
    const store = this.store(id);
    insist(store, "unsupported_credentials");
    await store.delete(id);
  }
}

// The pending Pi auth prompt, relayed to the authenticated owner like Pi's
// interactive /login dialog. Only static Pi prompt text and option ids leave
// the controller; tokens, raw progress and provider errors never do.
type Prompt =
  | {
      type: "select";
      message: string;
      options: { id: string; label: string; description?: string }[];
    }
  | { type: "manual_code"; message: string };
type Login = {
  id: string;
  owner: string;
  abort: AbortController;
  expires: number;
  state: "starting" | "waiting" | "connected" | "cancelled" | "failed";
  url: string;
  userCode: string;
  method?: string;
  expectedState?: string;
  prompt?: Prompt;
  answer?: (value: string) => void;
  done: Promise<void>;
  timer: NodeJS.Timeout;
};
type Check = { at: number; ok: boolean };
const short = (value: string | undefined, max = 200) =>
  (value ?? "").slice(0, max);
// `getProvider` is optional so the many Subscription test fakes (which only
// implement the original login/logout/hasConfiguredAuth/getAuth surface)
// stay valid; only forceRefresh() below needs it, and only in production.
type SubscriptionRuntime = Pick<
  ModelRuntime,
  "login" | "logout" | "hasConfiguredAuth" | "getAuth"
> & { getProvider?: ModelRuntime["getProvider"] };
// Likewise `modify` is optional: only the real PrivateCredentials store
// passed in production supports it, so forceRefresh() is a no-op elsewhere.
type SubscriptionCredential = {
  expires: number | undefined;
  modify?: PrivateCredentials["modify"];
};
export class Subscription {
  private login?: Login;
  private check?: Check;
  private operation = new Serial();
  /** In-flight forced refresh, shared by every concurrent caller (single-flight per credential). */
  private forcedRefresh?: Promise<boolean>;
  constructor(
    readonly runtime: SubscriptionRuntime,
    private readonly credential: SubscriptionCredential = {
      expires: undefined,
    },
    readonly provider: SubscriptionProvider = "openai-codex",
    readonly enabled: boolean = provider !== "anthropic" ||
      anthropicAuthEnabled(),
  ) {}
  /**
   * Force an OAuth token refresh regardless of its recorded expiry, for a 401
   * the provider returned despite a locally valid-looking token (clock drift,
   * early revocation). Concurrent callers share one in-flight refresh. The
   * rotated token is persisted atomically by the existing credential store
   * under its own write lock; this never logs or returns the token. Returns
   * false when there is nothing to refresh, refresh is unsupported here (no
   * provider/store wired, e.g. in narrow test fakes), or the refresh itself
   * failed (e.g. a revoked refresh token) — callers then fall back to the
   * existing sign-in-again failure.
   */
  forceRefresh(signal?: AbortSignal): Promise<boolean> {
    if (this.forcedRefresh) return this.forcedRefresh;
    const attempt = this.runForceRefresh(signal).finally(() => {
      if (this.forcedRefresh === attempt) this.forcedRefresh = undefined;
    });
    this.forcedRefresh = attempt;
    return attempt;
  }
  private async runForceRefresh(signal?: AbortSignal): Promise<boolean> {
    if (!this.enabled) return false;
    const oauth = this.runtime.getProvider?.(this.provider)?.auth.oauth;
    const modify = this.credential.modify?.bind(this.credential);
    if (!oauth || !modify) return false;
    let attempted = false;
    try {
      await modify(this.provider, async (current) => {
        if (current?.type !== "oauth") return undefined; // signed out meanwhile
        attempted = true;
        const refreshSignal = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000);
        return await oauth.refresh(current, refreshSignal);
      });
    } catch {
      return false;
    }
    return attempted;
  }
  static async open(
    dataDir: string,
    seeds: string[],
    provider: SubscriptionProvider = "openai-codex",
    enabled: boolean = provider !== "anthropic" || anthropicAuthEnabled(),
  ) {
    insist(provider !== "anthropic" || enabled, "anthropic_auth_disabled", 403);
    const { subscriptions, runtime, secrets } =
      await Subscription.openProviders(dataDir, seeds, [provider]);
    return { subscription: subscriptions[0]!, runtime, secrets };
  }
  /**
   * Open one Pi ModelRuntime over the given providers' private credential
   * files and one Subscription per provider sharing it. The caller passes
   * "anthropic" only when its feature flag is enabled; providers left out
   * have no credential store at all, so their files are never read.
   */
  static async openProviders(
    dataDir: string,
    seeds: string[],
    enabled: readonly SubscriptionProvider[],
  ) {
    const list = subscriptionProviders.filter((p) => enabled.includes(p));
    insist(list.length > 0, "subscription_unavailable");
    const secrets: string[] = [];
    const stores = list.map(
      (provider) =>
        new PrivateCredentials(
          join(dataDir, credentialFiles[provider]),
          seeds,
          provider,
          secrets,
        ),
    );
    // Explicit storage; no ~/.pi discovery, project resources, custom endpoints or catalog fetch.
    const runtime = await ModelRuntime.create({
      credentials: new ProviderCredentials(stores),
      modelsPath: null,
      modelsStorePath: join(dataDir, "pi-model-cache.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    if (list.includes("anthropic")) {
      const { registerAnthropicOAuth } = await import("./anthropic.js");
      await registerAnthropicOAuth(runtime);
    }
    // Static providers: initialize auth metadata only. No remote catalogs, token exchange or model requests.
    await runtime.refresh({ providers: list, allowNetwork: false });
    for (const store of stores) await store.read(store.provider);
    return {
      subscriptions: stores.map(
        (store) => new Subscription(runtime, store, store.provider, true),
      ),
      runtime,
      secrets,
    };
  }
  /** Signed in: enabled and Pi reports configured auth for this provider. */
  configured() {
    return this.enabled && this.runtime.hasConfiguredAuth(this.provider);
  }
  status(owner: string) {
    const login = this.login?.owner === owner ? this.login : undefined;
    const configured = this.configured();
    return {
      configured,
      subscription: true,
      provider: this.provider,
      providerName: providers[this.provider].name,
      ...(configured && this.credential.expires
        ? { tokenExpires: this.credential.expires }
        : {}),
      ...(configured && this.check ? { lastCheck: this.check } : {}),
      ...(login
        ? {
            login: {
              id: login.id,
              state: login.state,
              expires: login.expires,
              url: login.url,
              userCode: login.userCode,
              // The chosen method id (e.g. "device_code"), not raw provider text,
              // so the UI can tailor its failure hint without any provider error leaking.
              ...(login.method ? { method: login.method } : {}),
              // Compatibility with the 0.2.0 browser fallback field.
              manual: login.prompt?.type === "manual_code",
              ...(login.prompt ? { prompt: login.prompt } : {}),
            },
          }
        : {}),
    };
  }
  /**
   * Start Pi's own provider login, as Pi's interactive /login does. With no
   * method the owner answers Pi's method selection in the UI; a method given
   * up front answers that selection immediately.
   */
  start(owner: string, method?: unknown) {
    insist(this.enabled, "anthropic_auth_disabled", 403);
    insist(
      method === undefined ||
        providers[this.provider].methods.some((m) => m === method),
      "invalid_login_method",
    );
    return this.operation.run(async () => {
      const official = providers[this.provider];
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
        done: Promise.resolve(),
        timer: undefined!,
      };
      this.login = login;
      login.timer = setTimeout(() => login.abort.abort(), 15 * 60000);
      login.timer.unref();
      const interaction: AuthInteraction = {
        signal: login.abort.signal,
        prompt: async (prompt) => {
          insist(
            prompt.type === "select" || prompt.type === "manual_code",
            "unexpected_auth_prompt",
          );
          if (prompt.type === "select" && method !== undefined) {
            insist(prompt.options.some((o) => o.id === method));
            login.method = method as string;
            return method as string;
          }
          insist(
            prompt.type === "select" ||
              method === undefined ||
              method === "browser" ||
              method === "copy_code",
            "unexpected_auth_prompt",
          );
          login.prompt =
            prompt.type === "select"
              ? {
                  type: "select",
                  message: short(prompt.message),
                  options: prompt.options.slice(0, 8).map((o) => ({
                    id: short(o.id, 64),
                    label: short(o.label),
                    ...(o.description
                      ? { description: short(o.description) }
                      : {}),
                  })),
                }
              : { type: "manual_code", message: short(prompt.message) };
          login.state = "waiting";
          return new Promise<string>((resolve, reject) => {
            const signal = prompt.signal
              ? AbortSignal.any([prompt.signal, login.abort.signal])
              : login.abort.signal;
            const cancel = () => {
              login.answer = undefined;
              login.prompt = undefined;
              reject(new Error("login_cancelled"));
            };
            signal.addEventListener("abort", cancel, { once: true });
            login.answer = (value) => {
              signal.removeEventListener("abort", cancel);
              login.answer = undefined;
              login.prompt = undefined;
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
              url.origin === official.origin && !url.username && !url.password,
              "unexpected_login_origin",
            );
            if (this.provider === "anthropic") {
              insist(
                url.pathname === "/oauth/authorize" &&
                  url.searchParams.get("state"),
                "unexpected_login_url",
              );
              login.expectedState = url.searchParams.get("state")!;
            }
            login.url = url.href;
            login.userCode =
              event.type === "device_code" ? short(event.userCode, 64) : "";
            login.state = "waiting";
          }
          // Never forward raw provider progress/error messages, credentials or token responses.
        },
      };
      login.done = this.runtime
        .login(this.provider, "oauth", interaction)
        .then(
          () => {
            login.state = "connected";
            this.check = { at: Date.now(), ok: true };
          },
          () => {
            login.state = login.abort.signal.aborted ? "cancelled" : "failed";
          },
        )
        .finally(() => {
          clearTimeout(login.timer);
          login.url = "";
          login.userCode = "";
          login.prompt = undefined;
          login.answer = undefined;
          login.expectedState = undefined;
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
        login.prompt &&
        !login.abort.signal.aborted &&
        login.expires > Date.now(),
      "login_not_pending",
      409,
    );
    const entered = text(value, 4096);
    if (login.prompt.type === "select") {
      insist(
        login.prompt.options.some((o) => o.id === entered),
        "invalid_login_method",
      );
      login.method = entered;
    } else if (
      this.provider === "anthropic" &&
      login.method === "copy_code" &&
      !entered.includes("://")
    ) {
      // Require the complete code#state, not a bare code. Bind to this login's
      // native Pi PKCE transaction before forwarding to the token exchange.
      const match = /^([A-Za-z0-9._~-]{1,2048})#([A-Za-z0-9_-]{1,256})$/.exec(
        entered,
      );
      insist(
        match && login.expectedState && match[2] === login.expectedState,
        "authorization_code_state_required",
      );
    } else {
      const official = providers[this.provider];
      insist(URL.canParse(entered), "redirect_url_required");
      const url = new URL(entered);
      const redirect =
        this.provider === "anthropic" && login.method === "copy_code"
          ? {
              origin: "https://platform.claude.com",
              path: "/oauth/code/callback",
            }
          : official.redirect;
      // Browser fallback must include state; Pi also checks its PKCE transaction.
      insist(
        url.origin === redirect.origin &&
          url.pathname === redirect.path &&
          !url.username &&
          !url.password &&
          !url.hash &&
          url.searchParams.getAll("code").length === 1 &&
          url.searchParams.getAll("state").length === 1 &&
          url.searchParams.get("code") &&
          url.searchParams.get("state") &&
          (this.provider !== "anthropic" ||
            (login.expectedState &&
              url.searchParams.get("state") === login.expectedState)),
        "redirect_url_required",
      );
    }
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
  /**
   * Ask Pi to resolve request auth exactly as a model call would: it refreshes
   * the token under the credential lock when it is close to expiry. The
   * derived token is discarded; only success and the expiry are reported.
   */
  verify(owner: string) {
    insist(this.enabled, "anthropic_auth_disabled", 403);
    return this.operation.run(async () => {
      insist(
        this.runtime.hasConfiguredAuth(this.provider),
        "subscription_login_required",
        409,
      );
      const signal = AbortSignal.timeout(30000);
      const ok = await this.runtime
        .getAuth(this.provider, { signal })
        .then((auth) => !!auth?.auth.apiKey)
        .catch(() => false);
      this.check = { at: Date.now(), ok };
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
      await this.runtime.logout(this.provider);
      this.login = undefined;
      this.check = undefined;
      return this.status(owner);
    });
  }
  async close() {
    this.login?.abort.abort();
    await this.login?.done;
  }
}
