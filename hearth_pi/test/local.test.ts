import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { SubmissionId } from "@earendil-works/pi-durable";
import {
  LOCAL_PROVIDER,
  LocalEndpoints,
  checkEndpointUrl,
  privateAddress,
  probeEndpoint,
} from "../src/local.js";
import { Subscription } from "../src/subscription.js";
import { safeModels } from "../src/models.js";
import { Runtime } from "../src/runtime.js";

const resolver = (table: Record<string, string[]>) => async (host: string) => {
  const found = table[host];
  if (!found) throw new Error("ENOTFOUND");
  return found;
};

test("endpoint URLs must be private, plain and are normalized", async () => {
  const dns = resolver({
    "ollama.local": ["192.168.1.20"],
    "a0d7b954-ollama": ["172.30.33.5"],
    "rebind.example": ["192.168.1.9", "203.0.113.7"],
    "public.example": ["203.0.113.7"],
  });
  assert.equal(
    await checkEndpointUrl("http://192.168.1.20:11434/v1/", dns),
    "http://192.168.1.20:11434",
  );
  assert.equal(
    await checkEndpointUrl("http://ollama.local:11434", dns),
    "http://ollama.local:11434",
  );
  assert.equal(
    await checkEndpointUrl("http://a0d7b954-ollama:11434", dns),
    "http://a0d7b954-ollama:11434",
  );
  assert.equal(
    await checkEndpointUrl("https://[fd00::5]:8443/proxy/v1", dns),
    "https://[fd00::5]:8443/proxy",
  );
  for (const bad of [
    "http://203.0.113.7:11434",
    "http://169.254.169.254/latest",
    "http://172.30.32.2/",
    "http://supervisor/core",
    "http://public.example:11434",
    "http://rebind.example:11434",
    "http://user:pass@192.168.1.20:11434",
    "http://192.168.1.20:11434/?x=1",
    "file:///etc/passwd",
    "ftp://192.168.1.20/",
    "not a url",
  ])
    await assert.rejects(checkEndpointUrl(bad, dns), /endpoint|invalid/, bad);
  await assert.rejects(
    checkEndpointUrl("http://missing.example", dns),
    /endpoint_unresolvable/,
  );
  assert.equal(privateAddress("::ffff:10.0.0.1"), true);
  assert.equal(privateAddress("fe80::1"), false);
  assert.equal(privateAddress("8.8.8.8"), false);
});

// Shapes follow the public Ollama/OpenAI-compatible responses.
function ollamaFetch(seen: string[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    seen.push(`${init?.method ?? "GET"} ${path} ${init?.redirect}`);
    switch (path) {
      case "/v1/models":
        return Response.json({
          object: "list",
          data: [
            { id: "qwen3:8b", object: "model", owned_by: "library" },
            { id: "nomic-embed-text:latest", object: "model" },
            { id: "gemma2:2b", object: "model" },
            { id: "<script>", object: "model" },
          ],
        });
      case "/api/tags":
        return Response.json({ models: [] });
      case "/api/show": {
        const model = JSON.parse(String(init?.body)).model;
        return Response.json(
          model === "qwen3:8b"
            ? {
                capabilities: ["completion", "tools", "thinking"],
                model_info: { "qwen3.context_length": 40960 },
              }
            : { capabilities: ["completion"] },
        );
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;
}

test("probe fingerprints Ollama and keeps only safe tool-capable chat models", async () => {
  const seen: string[] = [];
  const found = await probeEndpoint(
    "http://192.168.1.20:11434",
    undefined,
    ollamaFetch(seen),
  );
  assert.equal(found.kind, "ollama");
  assert.deepEqual(found.models, [{ id: "qwen3:8b", contextWindow: 40960 }]);
  assert.equal(found.hidden, 3);
  assert(seen.every((line) => line.endsWith(" error")));
  const lmstudio = await probeEndpoint(
    "http://192.168.1.21:1234",
    "synthetic-local-key",
    (async (url: string | URL, init?: RequestInit) => {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer synthetic-local-key",
      );
      const path = new URL(String(url)).pathname;
      if (path === "/v1/models")
        return Response.json({
          data: [{ id: "qwen2.5-7b-instruct" }, { id: "text-embedding-x" }],
        });
      if (path === "/api/v0/models")
        return Response.json({
          data: [
            {
              id: "qwen2.5-7b-instruct",
              type: "llm",
              max_context_length: 32768,
            },
            { id: "text-embedding-x", type: "embeddings" },
          ],
        });
      return new Response("", { status: 404 });
    }) as typeof fetch,
  );
  assert.equal(lmstudio.kind, "lmstudio");
  assert.deepEqual(lmstudio.models, [
    { id: "qwen2.5-7b-instruct", contextWindow: 32768 },
  ]);
  await assert.rejects(
    probeEndpoint(
      "http://192.168.1.22:8000",
      "bad",
      (async () => new Response("", { status: 401 })) as typeof fetch,
    ),
    /endpoint_auth_failed/,
  );
  await assert.rejects(
    probeEndpoint("http://192.168.1.22:8000", undefined, (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch),
    /endpoint_unreachable/,
  );
});

test("owner-bound test/save registers a real Pi provider, persists privately and reloads offline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-local-"));
  try {
    const { runtime: native, secrets } = await Subscription.open(dir, []);
    const model = { provider: LOCAL_PROVIDER, modelId: "" };
    const local = new LocalEndpoints(
      join(dir, "local-endpoint.json"),
      native,
      secrets,
      model,
      ollamaFetch([]),
      resolver({}),
    );
    await assert.rejects(
      local.test("owner", "http://192.168.1.20:11434", "!rm -rf /"),
      /invalid_endpoint_key/,
    );
    const tested = await local.test(
      "owner",
      "http://192.168.1.20:11434/v1",
      "synthetic-local-key",
    );
    assert.equal(tested.test?.kindName, "Ollama");
    assert.doesNotMatch(JSON.stringify(tested), /synthetic-local-key/);
    assert(!local.status("other").test);
    await assert.rejects(
      local.save("other", tested.test!.id, "qwen3:8b"),
      /endpoint_test_expired/,
    );
    await assert.rejects(
      local.save("owner", tested.test!.id, "gemma2:2b"),
      /unsupported_model/,
    );
    const saved = await local.save("owner", tested.test!.id, "qwen3:8b");
    assert.equal(saved.endpoint?.model, "qwen3:8b");
    assert.equal(saved.endpoint?.authenticated, true);
    assert.doesNotMatch(JSON.stringify(saved), /synthetic-local-key/);
    assert.equal(model.modelId, "qwen3:8b");
    assert(secrets.includes("synthetic-local-key"));
    assert.equal(
      native.getModel(LOCAL_PROVIDER, "qwen3:8b")?.baseUrl,
      "http://192.168.1.20:11434/v1",
    );
    assert.equal(
      (await native.getAuth(LOCAL_PROVIDER))?.auth.apiKey,
      "synthetic-local-key",
    );
    assert.equal((await stat(local.path)).mode & 0o777, 0o600);

    // Restart: reload from disk without contacting the server.
    const reopened = await Subscription.open(dir, []);
    const again = { provider: LOCAL_PROVIDER, modelId: "" };
    const restored = new LocalEndpoints(
      local.path,
      reopened.runtime,
      reopened.secrets,
      again,
      (async () => {
        throw new Error("no network at startup");
      }) as typeof fetch,
      resolver({}),
    );
    await (restored as unknown as { load(): Promise<void> }).load();
    assert.equal(again.modelId, "qwen3:8b");
    assert(reopened.runtime.getModel(LOCAL_PROVIDER, "qwen3:8b"));

    // A saved host that can't be resolved at boot must not block startup.
    const named = new LocalEndpoints(
      join(dir, "named.json"),
      reopened.runtime,
      reopened.secrets,
      { modelId: "" },
      ollamaFetch([]),
      resolver({ "ollama.local": ["192.168.1.20"] }),
    );
    const t = await named.test("owner", "http://ollama.local:11434", undefined);
    await named.save("owner", t.test!.id, "qwen3:8b");
    const late = new LocalEndpoints(
      named.path,
      reopened.runtime,
      reopened.secrets,
      { modelId: "" },
      ollamaFetch([]),
      resolver({}),
    );
    await (late as unknown as { load(): Promise<void> }).load();
    assert.equal(late.configured, false);
    assert.equal(
      late.status("owner").unverified?.url,
      "http://ollama.local:11434",
    );
    await assert.rejects(late.refresh("owner"), /endpoint_unresolvable/);

    await local.remove("owner");
    assert.equal(local.configured, false);
    assert.equal(native.getModel(LOCAL_PROVIDER, "qwen3:8b"), undefined);
    await assert.rejects(stat(local.path), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("durable harness answers through a real local OpenAI-compatible HTTP server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-local-e2e-"));
  const requests: {
    path: string;
    auth?: string;
    body?: Record<string, unknown>;
  }[] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
    });
  const server = createServer(async (req, res) => {
    const raw = await read(req);
    requests.push({
      path: req.url ?? "",
      auth: req.headers.authorization,
      ...(raw ? { body: JSON.parse(raw) } : {}),
    });
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          data: [{ id: "qwen3:8b", owned_by: "vllm", max_model_len: 16384 }],
        }),
      );
    }
    if (req.url === "/v1/chat/completions") {
      res.setHeader("Content-Type", "text/event-stream");
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "qwen3:8b", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "Local model reply" }));
      res.write(chunk({}, "stop"));
      return res.end("data: [DONE]\n\n");
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let runtime: Runtime | undefined;
  try {
    const { runtime: native, secrets } = await Subscription.open(dir, []);
    const model = { provider: LOCAL_PROVIDER, modelId: "" };
    // An unconfigured local provider may open; sessions wait for an endpoint.
    runtime = await Runtime.open(dir, safeModels(native, secrets), model);
    const local = new LocalEndpoints(
      join(dir, "local-endpoint.json"),
      native,
      secrets,
      model,
    );
    const tested = await local.test(
      "owner",
      `http://127.0.0.1:${port}`,
      undefined,
    );
    assert.equal(tested.test?.kind, "vllm");
    await local.save("owner", tested.test!.id, "qwen3:8b");
    assert.deepEqual(
      runtime.modelChoices().map((m) => m.id),
      ["qwen3:8b"],
    );
    const id = await runtime.create("owner", "Local", "create-local-1");
    const submission = await runtime.submit(
      "owner",
      id,
      "request-local-1",
      "Hello",
    );
    const receipt = await runtime.harness.submission(
      submission as SubmissionId,
      ctx,
    );
    assert.equal((await receipt!.wait(ctx)).status, "done");
    assert.match(
      JSON.stringify(await runtime.snapshot("owner", id)),
      /Local model reply/,
    );
    const chat = requests.find((r) => r.path === "/v1/chat/completions")!;
    assert.equal(chat.body?.model, "qwen3:8b");
    assert.equal(chat.body?.store, undefined);
    assert.equal(chat.auth, "Bearer hearth-local-no-key");
  } finally {
    await runtime?.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
