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

// Provider error text is never passed through: it can echo request data or
// credentials. Classify it into a fixed, owner-actionable message instead.
export function providerFailure(raw: string | undefined): string {
  const text = raw ?? "";
  if (
    /\b401\b|unauthori[sz]ed|authentication|expired|invalid[ _-]?(api[ _-]?key|token)|sign[ -]?in|log[ -]?in/i.test(
      text,
    )
  )
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

// Filter before Pi commits provider events, including error/partial fields.
export function safeModels(models: Models, secrets: string[]): Models {
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
            .filter((m) => m.role === "assistant").length >= 8 ||
          Buffer.byteLength(JSON.stringify(transcript)) > 262144
        )
          throw new Error("budget");
        const source = models.streamSimple(model, transcript, {
          ...options,
          maxTokens: 2048,
          transport: "sse",
          signal: options?.signal
            ? AbortSignal.any([options.signal, abort.signal])
            : abort.signal,
        });
        for await (const event of source) {
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
        }
      } catch {
        stream.push({
          type: "error",
          reason: "error",
          error: fauxAssistantMessage(
            "Model request stopped (failure or eight-turn budget).",
            {
              stopReason: "error",
              errorMessage:
                "Model request stopped (failure or eight-turn budget).",
            },
          ),
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
): Promise<{
  models: Models;
  provider: string;
  modelId: string;
}> {
  if (config.provider !== "offline") {
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
    return {
      models: safeModels(native, secrets),
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
