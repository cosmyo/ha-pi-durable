import { createJiti } from "jiti";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ApiStreamSimpleFunction } from "@earendil-works/pi-ai/compat";

// The pinned MIT package publishes TypeScript, not a compiled entrypoint.
// Load ONLY its transport helper, never its extension factory, personal/project
// configuration or account diagnostics. No global loader/resource discovery.
export async function anthropicOAuthTransport(): Promise<ApiStreamSimpleFunction> {
  const loader = createJiti(import.meta.url, {
    fsCache: false,
    moduleCache: false,
    debug: false,
    sourceMaps: false,
    tryNative: false,
    tsconfigPaths: false,
    alias: {},
    nativeModules: [],
    transformModules: [],
    virtualModules: {
      // Logging is unconditionally off, even if an operator enables upstream
      // debug in the environment. Do not log model/prompt/tool metadata.
      "./debug": {
        debugLog: () => {},
        isToolUseOnlyDebugEnabled: () => false,
      },
    },
  });
  const helper = await loader.import<{
    createAnthropicOAuthStreamSimple: (
      delegate: ReturnType<typeof anthropicMessagesApi>["streamSimple"],
    ) => ApiStreamSimpleFunction;
  }>("@gotgenes/pi-anthropic-auth/src/oauth-transport.ts");
  return helper.createAnthropicOAuthStreamSimple(
    anthropicMessagesApi().streamSimple,
  );
}

export async function registerAnthropicOAuth(runtime: ModelRuntime) {
  // Omit oauth/models to preserve Pi's native login, locked refresh and catalog.
  runtime.registerProvider("anthropic", {
    api: "anthropic-messages",
    streamSimple: await anthropicOAuthTransport(),
  });
}
