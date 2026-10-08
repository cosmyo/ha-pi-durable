import { createModels, type Models } from "@earendil-works/pi-ai/models";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { Config } from "./config.js";
import { redactor } from "./safety.js";
import type { Subscription } from "./subscription.js";

export function supportsThinking(
  models: Models,
  provider: string,
  id: string,
  level: ModelThinkingLevel,
): boolean {
  const model = models.getModel(provider, id);
  if (!model || model.provider !== provider) return false;
  if (level === "off") return model.thinkingLevelMap?.off !== null;
  if (!model.reasoning || model.thinkingLevelMap?.[level] === null)
    return false;
  return level === "xhigh" || level === "max"
    ? typeof model.thinkingLevelMap?.[level] === "string"
    : true;
}

// Shared with the 401 provider-request retry below: both need to recognize
// the same "sign-in expired/rejected" shape, one to classify it for the
// owner and the other to decide whether a credential refresh can help.
const AUTH_FAILURE_PATTERN =
  /\b401\b|unauthori[sz]ed|authentication|expired|invalid[ _-]?(api[ _-]?key|token)|sign[ -]?in|log[ -]?in/i;
// Provider error text is never passed through: it can echo request data or
// credentials. Classify it into a fixed, owner-actionable message instead.
export function providerFailure(raw: string | undefined): string {
  const text = raw ?? "";
  if (AUTH_FAILURE_PATTERN.test(text))
    return "Provider sign-in expired or was rejected. Open the login dialog and sign in again.";
  if (
    /\b429\b|rate[ _-]?limit|quota|usage[ _-]?limit|too many requests/i.test(
      text,
    )
  )
    return "Provider rate or usage limit reached. Try again later.";
  if (
    /\b403\b|forbidden|not (allowed|entitled)|permission|\bplan\b/i.test(text)
  )
    return "Provider refused this account or model. Check your plan and the selected model.";
  if (/model.*(not found|does not exist|unsupported)|\b404\b/i.test(text))
    return "Selected model is unavailable from this provider. Choose another model.";
  return "Provider request failed; check server configuration.";
}

const STOP_TEXT: Record<string, string> = {
  turn_budget: "eight model turns per message reached",
  context_budget: "conversation context too large",
  output_limit: "a single model event was too large",
  unsupported_or_excessive_tools: "too many tool calls in one turn",
  wrapper_error: "unexpected failure",
};
const STOP_CODES = new Set([
  "turn_budget",
  "context_budget",
  "output_limit",
  "unsupported_or_excessive_tools",
]);
// Filter before Pi commits provider events, including error/partial fields.
/**
 * Per-call OAuth credential refresh on a 401, for the subscription providers
 * (keyed by provider id) that support it. A real provider's 401 is always its
 * request's first and only event: the HTTP response is checked before any
 * "start"/content event is emitted (see openai-codex-responses.js,
 * anthropic-messages.js), so peeking the first event below never discards
 * real streamed content on retry.
 */
export type CredentialRefreshers = ReadonlyMap<
  string,
  Pick<Subscription, "forceRefresh">
>;
export function safeModels(
  models: Models,
  secrets: string[],
  refreshers?: CredentialRefreshers,
): Models {
  const redact = redactor(secrets);
  const streamSimple: Models["streamSimple"] = (model, transcript, options) => {
    const stream = createAssistantMessageEventStream();
    const abort = new AbortController();
    void (async () => {
      try {
        const lastUser = transcript.messages.findLastIndex(
          (m) => m.role === "user",
        );
        if (
          transcript.messages
            .slice(lastUser + 1)
            .filter((m) => m.role === "assistant").length >= 8
        )
          throw new Error("turn_budget");
        if (Buffer.byteLength(JSON.stringify(transcript)) > 262144)
          throw new Error("context_budget");
        const signal = options?.signal
          ? AbortSignal.any([options.signal, abort.signal])
          : abort.signal;
        const requestOptions = {
          ...options,
          maxTokens: 2048,
          transport: "sse" as const,
          signal,
        };
        let source = models.streamSimple(model, transcript, requestOptions);
        let iterator = source[Symbol.asyncIterator]();
        let step = await iterator.next();
        // Before any event of this turn (so before any tool call) reaches the
        // caller: a 401 despite a locally valid-looking token refreshes once,
        // at most, and retries this same provider request once. Tool calls are
        // only ever executed from a finalized message downstream, never from
        // this not-yet-forwarded first event, so nothing here can re-run a
        // tool side effect.
        if (
          !step.done &&
          step.value.type === "error" &&
          AUTH_FAILURE_PATTERN.test(step.value.error.errorMessage ?? "") &&
          (await refreshers?.get(model.provider)?.forceRefresh(signal))
        ) {
          source = models.streamSimple(model, transcript, requestOptions);
          iterator = source[Symbol.asyncIterator]();
          step = await iterator.next();
        }
        while (!step.done) {
          const event = step.value;
          const serialized = JSON.stringify(event);
          if (Buffer.byteLength(serialized) > 131072)
            throw new Error("output_limit");
          const safe = JSON.parse(serialized, (_key, val: unknown) =>
            typeof val === "string" ? redact(val) : val,
          ) as AssistantMessageEvent;
          const message =
            safe.type === "done"
              ? safe.message
              : safe.type === "error"
                ? safe.error
                : safe.partial;
          if (
            message.content.filter((block) => block.type === "toolCall")
              .length > 8 ||
            message.stopReason === "deferred"
          )
            throw new Error("unsupported_or_excessive_tools");
          if (safe.type === "error")
            safe.error.errorMessage = providerFailure(safe.error.errorMessage);
          stream.push(safe);
          step = await iterator.next();
        }
      } catch (error) {
        // Only Hearth's own fixed guard codes are named (never provider or
        // tool text): enough to tell a budget stop from a wrapper failure.
        const code =
          error instanceof Error && STOP_CODES.has(error.message)
            ? error.message
            : "wrapper_error";
        const text = `Model request stopped (${STOP_TEXT[code] ?? "unexpected failure"}).`;
        console.error(`hearth: model request stopped: ${code}`);
        stream.push({
          type: "error",
          reason: "error",
          error: fauxAssistantMessage(text, {
            stopReason: "error",
            errorMessage: text,
          }),
        });
      } finally {
        abort.abort();
      }
    })();
    return stream;
  };
  return new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple") return streamSimple;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export async function configuredModels(
  config: Config,
  native: ModelRuntime,
  secrets: string[],
  // Every subscription provider's model call goes through the one wrapped
  // `models` collection below (sessions can select any signed-in OAuth
  // provider's model, not only the configured default), so every entry here
  // gets 401-retry refresh, keyed by provider id.
  subscriptions: readonly Subscription[] = [],
): Promise<{
  models: Models;
  provider: string;
  modelId: string;
}> {
  if (config.provider !== "offline") {
    if (config.provider === "anthropic" && config.anthropicAuthEnabled !== true)
      throw new Error("anthropic_auth_disabled");
    if (config.provider === "openai") {
      if (!config.apiKey.startsWith("sk-"))
        throw new Error("api_key_auth_required");
      await native.setRuntimeApiKey("openai", config.apiKey);
    }
    // Local endpoint models are registered at runtime by LocalEndpoints.
    if (
      config.provider !== "local" &&
      !native.getModel(config.provider, config.model)
    )
      throw new Error("unsupported_model");
    const refreshers: CredentialRefreshers = new Map(
      subscriptions.map((s) => [s.provider, s]),
    );
    return {
      models: safeModels(native, secrets, refreshers),
      provider: config.provider,
      modelId: config.model,
    };
  }
  const models = createModels();
  const faux = fauxProvider({
    models: [{ id: "faux", name: "Offline demonstration" }],
  });
  const respond = () => {
    faux.appendResponses([respond]);
    return fauxAssistantMessage(
      "Offline mode is ready. No inference or HA action was performed. Select ChatGPT/Codex subscription OAuth or an OpenAI API key, and exact entity scope in server options to use the assistant.",
    );
  };
  faux.setResponses([respond]);
  models.setProvider(faux.provider);
  return {
    models: safeModels(models, secrets),
    provider: faux.getModel().provider,
    modelId: faux.getModel().id,
  };
}
