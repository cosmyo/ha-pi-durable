import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { chmod, lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Fault, Serial, insist, text } from "./safety.js";

export const LOCAL_PROVIDER = "local";
// Literal placeholder for key-less servers. Pi interpolates `$NAME` and runs
// `!command` keys, so neither this nor an owner key may start with them.
const NO_KEY = "hearth-local-no-key";
const KEY = /^[A-Za-z0-9._~+/=:-]{1,500}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;
const MAX_BODY = 1 << 20;
const MAX_MODELS = 100;
const FALLBACK_CONTEXT = 32768;

export type ServerKind =
  | "ollama"
  | "lmstudio"
  | "llama.cpp"
  | "vllm"
  | "openai-compatible";
export const kindNames: Record<ServerKind, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  "llama.cpp": "llama.cpp",
  vllm: "vLLM",
  "openai-compatible": "OpenAI-compatible",
};
export type LocalModel = { id: string; contextWindow: number };
export type Endpoint = {
  url: string;
  kind: ServerKind;
  apiKey?: string;
  models: LocalModel[];
  model: string;
  savedAt: number;
};
type Probe = {
  id: string;
  owner: string;
  expires: number;
  url: string;
  kind: ServerKind;
  apiKey?: string;
  models: LocalModel[];
  hidden: number;
};
type Fetch = typeof fetch;
type Resolve = (host: string) => Promise<string[]>;
const systemResolve: Resolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function ipv4(address: string) {
  const p = address.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0)
    ? p
    : undefined;
}
// Loopback and RFC 1918/4193 only. Link-local (169.254/16, fe80::/10) is
// excluded: it hosts cloud metadata services. 172.30.32.2 is HA Supervisor.
export function privateAddress(address: string): boolean {
  if (address.startsWith("::ffff:")) address = address.slice(7);
  const v4 = ipv4(address);
  if (v4) {
    const [a = -1, b = -1] = v4;
    if (address === "172.30.32.2") return false;
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = address.toLowerCase();
  return v6 === "::1" || /^f[cd][0-9a-f]{2}:/.test(v6);
}

/**
 * Normalize an owner-entered server URL and require that every address it
 * resolves to is private. DNS can change after this check; this is an
 * operator guard against mistakes, not a defence against hostile DNS.
 */
export async function checkEndpointUrl(
  value: unknown,
  resolve: Resolve = systemResolve,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(text(value, 300).trim());
  } catch (e) {
    if (e instanceof Fault) throw e;
    throw new Fault(400, "invalid_endpoint_url");
  }
  insist(
    (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "invalid_endpoint_url",
  );
  const host = url.hostname.replace(/^\[|\]$/g, "");
  insist(host.toLowerCase() !== "supervisor", "endpoint_not_private");
  const addresses = isIP(host)
    ? [host]
    : await resolve(host).catch(() => {
        throw new Fault(400, "endpoint_unresolvable");
      });
  insist(
    addresses.length > 0 && addresses.every(privateAddress),
    "endpoint_not_private",
  );
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${url.origin}${path}`;
}

async function getJson(
  fetcher: Fetch,
  url: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const response = await fetcher(url, {
    method: init.method ?? "GET",
    redirect: "error",
    signal,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (response.status === 401 || response.status === 403)
    throw new Fault(400, "endpoint_auth_failed");
  if (!response.ok) throw new Error("unavailable");
  const body = await response.text();
  insist(body.length <= MAX_BODY, "endpoint_response_too_large");
  return JSON.parse(body);
}
const optional = (p: Promise<unknown>) => p.catch(() => undefined);
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const positive = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;

/**
 * Identify the server and list chat models, in the spirit of Pi's
 * `/login llama.cpp` (which validates by listing models). Server responses
 * are untrusted: ids are pattern-checked, counts and sizes are bounded.
 */
export async function probeEndpoint(
  base: string,
  apiKey: string | undefined,
  fetcher: Fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(15000),
): Promise<{ kind: ServerKind; models: LocalModel[]; hidden: number }> {
  const get = (path: string, init?: { method?: string; body?: unknown }) =>
    getJson(fetcher, `${base}${path}`, apiKey, signal, init);
  let listed: unknown;
  try {
    listed = await get("/v1/models");
  } catch (e) {
    if (e instanceof Fault) throw e;
    throw new Fault(400, "endpoint_unreachable");
  }
  const data = record(listed).data;
  insist(Array.isArray(data), "not_openai_compatible");
  const entries = data.map(record);
  // Fingerprints use only public metadata endpoints; the most specific wins.
  const [tags, lmstudio, props] = await Promise.all([
    optional(get("/api/tags")),
    optional(get("/api/v0/models")),
    optional(get("/props")),
  ]);
  const kind: ServerKind = Array.isArray(record(tags).models)
    ? "ollama"
    : Array.isArray(record(lmstudio).data)
      ? "lmstudio"
      : record(props).default_generation_settings
        ? "llama.cpp"
        : entries.some((m) => m.owned_by === "vllm")
          ? "vllm"
          : "openai-compatible";
  const lmInfo = new Map(
    (kind === "lmstudio" ? (record(lmstudio).data as unknown[]) : []).map(
      (m) => [record(m).id, record(m)],
    ),
  );
  let hidden = 0;
  const models: LocalModel[] = [];
  for (const entry of entries.slice(0, MAX_MODELS)) {
    const id = entry.id;
    if (typeof id !== "string" || !MODEL.test(id)) {
      hidden++;
      continue;
    }
    const lm = lmInfo.get(id);
    // Embedding-only models cannot chat or call tools.
    if (lm?.type === "embeddings" || /(^|[-_/:.])embed/i.test(id)) {
      hidden++;
      continue;
    }
    let contextWindow =
      positive(entry.max_model_len) ??
      positive(lm?.max_context_length) ??
      positive(record(record(props).default_generation_settings).n_ctx);
    if (kind === "ollama") {
      const show = record(
        await optional(
          get("/api/show", { method: "POST", body: { model: id } }),
        ),
      );
      // Home mode needs tool calling; Ollama reports it explicitly.
      const caps = show.capabilities;
      if (Array.isArray(caps) && !caps.includes("tools")) {
        hidden++;
        continue;
      }
      for (const [k, v] of Object.entries(record(show.model_info)))
        if (k.endsWith(".context_length")) contextWindow ??= positive(v);
    }
    models.push({ id, contextWindow: contextWindow ?? FALLBACK_CONTEXT });
  }
  hidden += Math.max(0, entries.length - MAX_MODELS);
  return { kind, models, hidden };
}

function piProvider(endpoint: Endpoint) {
  return {
    name: `Local ${kindNames[endpoint.kind]}`,
    baseUrl: `${endpoint.url}/v1`,
    api: "openai-completions" as const,
    apiKey: NO_KEY,
    models: endpoint.models.map((m) => ({
      id: m.id,
      name: m.id,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false,
      contextWindow: m.contextWindow,
      maxTokens: Math.min(m.contextWindow, 8192),
      // Same conservative request shape as Pi's built-in llama.cpp provider.
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens" as const,
      },
    })),
  };
}

type Native = Pick<
  ModelRuntime,
  "registerProvider" | "unregisterProvider" | "setRuntimeApiKey"
> &
  Partial<Pick<ModelRuntime, "removeRuntimeApiKey">>;
/**
 * Owner-confirmed local OpenAI-compatible endpoint. One controller owns the
 * private file; the optional key never leaves it except as a request header.
 */
export class LocalEndpoints {
  private endpoint?: Endpoint;
  // Saved but not activated: its address could not be re-verified at boot
  // (e.g. a same-host server App not resolvable yet). Refresh retries it.
  private unverified?: Endpoint;
  private probe?: Probe;
  private serial = new Serial();
  constructor(
    readonly path: string,
    readonly native: Native,
    readonly secrets: string[],
    readonly defaultModel: { modelId: string },
    readonly fetcher: Fetch = fetch,
    readonly resolve: Resolve = systemResolve,
  ) {}
  static async open(
    dataDir: string,
    native: Native,
    secrets: string[],
    defaultModel: { modelId: string },
  ) {
    const local = new LocalEndpoints(
      join(dataDir, "local-endpoint.json"),
      native,
      secrets,
      defaultModel,
    );
    await local.load();
    return local;
  }
  get configured() {
    return !!this.endpoint;
  }
  get model() {
    return this.endpoint?.model;
  }
  private async load() {
    const stat = await lstat(this.path).catch((e) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (!stat) return;
    insist(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        (stat.mode & 0o077) === 0 &&
        stat.size <= 65536,
      "unsafe_local_endpoint",
    );
    const saved = JSON.parse(await readFile(this.path, "utf8")) as Endpoint;
    insist(
      typeof saved.url === "string" &&
        saved.kind in kindNames &&
        Array.isArray(saved.models) &&
        saved.models.length <= MAX_MODELS &&
        saved.models.every(
          (m) => MODEL.test(m.id) && positive(m.contextWindow),
        ) &&
        saved.models.some((m) => m.id === saved.model) &&
        (saved.apiKey === undefined || KEY.test(saved.apiKey)),
      "invalid_local_endpoint",
    );
    // Startup re-checks the address policy but never contacts the server.
    try {
      saved.url = await checkEndpointUrl(saved.url, this.resolve);
    } catch {
      this.unverified = saved;
      return;
    }
    await this.activate(saved);
  }
  private async activate(endpoint: Endpoint) {
    if (endpoint.apiKey && !this.secrets.includes(endpoint.apiKey))
      this.secrets.push(endpoint.apiKey);
    this.native.registerProvider(LOCAL_PROVIDER, piProvider(endpoint));
    if (endpoint.apiKey)
      await this.native.setRuntimeApiKey(LOCAL_PROVIDER, endpoint.apiKey);
    else await this.native.removeRuntimeApiKey?.(LOCAL_PROVIDER);
    this.endpoint = endpoint;
    this.defaultModel.modelId = endpoint.model;
  }
  private async persist(endpoint: Endpoint) {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(endpoint), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, this.path);
    await chmod(this.path, 0o600);
  }
  status(owner: string) {
    const e = this.endpoint,
      p = this.probe?.owner === owner ? this.probe : undefined;
    return {
      provider: LOCAL_PROVIDER,
      configured: !!e,
      ...(!e && this.unverified
        ? {
            unverified: {
              url: this.unverified.url,
              kind: this.unverified.kind,
            },
          }
        : {}),
      ...(e
        ? {
            endpoint: {
              url: e.url,
              kind: e.kind,
              kindName: kindNames[e.kind],
              model: e.model,
              models: e.models.map((m) => m.id),
              authenticated: !!e.apiKey,
              savedAt: e.savedAt,
            },
          }
        : {}),
      ...(p && p.expires > Date.now()
        ? {
            test: {
              id: p.id,
              url: p.url,
              kind: p.kind,
              kindName: kindNames[p.kind],
              models: p.models.map((m) => m.id),
              hidden: p.hidden,
              authenticated: !!p.apiKey,
            },
          }
        : {}),
    };
  }
  /** Step 1: test an owner-entered URL and remember the result briefly. */
  test(owner: string, url: unknown, apiKey: unknown) {
    return this.serial.run(async () => {
      const base = await checkEndpointUrl(url, this.resolve);
      insist(
        apiKey === undefined ||
          (typeof apiKey === "string" && apiKey.length <= 500),
      );
      const key = (apiKey as string | undefined)?.trim() || undefined;
      insist(!key || KEY.test(key), "invalid_endpoint_key");
      const found = await probeEndpoint(base, key, this.fetcher);
      insist(found.models.length > 0, "no_tool_capable_models");
      this.probe = {
        id: randomUUID(),
        owner,
        expires: Date.now() + 10 * 60000,
        url: base,
        apiKey: key,
        ...found,
      };
      return this.status(owner);
    });
  }
  /** Step 2: save the tested endpoint with the chosen default model. */
  save(owner: string, id: unknown, model: unknown) {
    return this.serial.run(async () => {
      const p = this.probe;
      insist(
        p?.owner === owner && p.id === id && p.expires > Date.now(),
        "endpoint_test_expired",
        409,
      );
      insist(
        p.models.some((m) => m.id === model),
        "unsupported_model",
      );
      const endpoint: Endpoint = {
        url: p.url,
        kind: p.kind,
        ...(p.apiKey ? { apiKey: p.apiKey } : {}),
        models: p.models,
        model: model as string,
        savedAt: Date.now(),
      };
      await this.persist(endpoint);
      await this.activate(endpoint);
      this.probe = undefined;
      return this.status(owner);
    });
  }
  /** Re-list models from the saved endpoint; keeps the default when present. */
  refresh(owner: string) {
    return this.serial.run(async () => {
      const e = this.endpoint ?? this.unverified;
      insist(e, "local_endpoint_required", 409);
      const url = await checkEndpointUrl(e.url, this.resolve);
      const found = await probeEndpoint(url, e.apiKey, this.fetcher);
      insist(found.models.length > 0, "no_tool_capable_models");
      const next: Endpoint = {
        ...e,
        kind: found.kind,
        models: found.models,
        model: found.models.some((m) => m.id === e.model)
          ? e.model
          : found.models[0]!.id,
        savedAt: Date.now(),
      };
      await this.persist(next);
      await this.activate(next);
      return this.status(owner);
    });
  }
  remove(owner: string) {
    return this.serial.run(async () => {
      const { unlink } = await import("node:fs/promises");
      await unlink(this.path).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      this.native.unregisterProvider(LOCAL_PROVIDER);
      await this.native.removeRuntimeApiKey?.(LOCAL_PROVIDER);
      this.endpoint = undefined;
      this.unverified = undefined;
      this.probe = undefined;
      return this.status(owner);
    });
  }
}
