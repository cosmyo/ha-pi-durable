import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
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
            safe.error.errorMessage =
              "Provider request failed; check server configuration.";
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
export function configuredModels(config: Config): {
  models: Models;
  provider: string;
  modelId: string;
} {
  const models = createModels();
  if (config.provider === "openai") {
    if (!config.apiKey.startsWith("sk-"))
      throw new Error("api_key_auth_required");
    process.env.OPENAI_API_KEY = config.apiKey;
    models.setProvider(openaiProvider());
    if (!models.getModel("openai", config.model))
      throw new Error("unsupported_model");
    return {
      models: safeModels(models, [
        config.apiKey,
        config.haToken,
        config.password,
      ]),
      provider: "openai",
      modelId: config.model,
    };
  }
  const faux = fauxProvider({
    models: [{ id: "faux", name: "Offline demonstration" }],
  });
  const respond = () => {
    faux.appendResponses([respond]);
    return fauxAssistantMessage(
      "Offline mode is ready. No inference or HA action was performed. Configure an OpenAI API key and exact entity scope in server options to use the assistant.",
    );
  };
  faux.setResponses([respond]);
  models.setProvider(faux.provider);
  return {
    models: safeModels(models, [config.haToken, config.password]),
    provider: faux.getModel().provider,
    modelId: faux.getModel().id,
  };
}
