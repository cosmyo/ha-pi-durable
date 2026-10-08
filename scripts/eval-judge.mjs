#!/usr/bin/env node
// Evaluates a risk-judge adapter against the 60 synthetic cases in
// hearth_pi/eval/judge-cases.json, through Hearth Pi's own judge module
// (never a reimplementation of its prompt/parsing), and writes a Markdown
// report. See hearth_pi/eval/README.md and hearth_pi/DOCS.md "Run the risk
// judge on your Home Assistant host".
//
// Usage:
//   node scripts/eval-judge.mjs --endpoint-url http://local-hearth-judge:8080 \
//     --endpoint-model qwen3-1.7b-q4_0 [--endpoint-api-key KEY] [--cloud]
//
// This script re-executes itself once with tsx's ESM loader so it can
// import Hearth Pi's TypeScript source directly; no separate build step or
// `tsx` invocation is required by the caller.
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(here, "..");

if (!process.env.__HEARTH_EVAL_TSX) {
  const tsxLoader = join(
    repoRoot,
    "hearth_pi/node_modules/tsx/dist/esm/index.mjs",
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      tsxLoader,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    {
      stdio: "inherit",
      cwd: repoRoot,
      env: { ...process.env, __HEARTH_EVAL_TSX: "1" },
    },
  );
  process.exit(result.status ?? 1);
}

function parseArgs(argv) {
  const args = {
    cases: "hearth_pi/eval/judge-cases.json",
    out: "hearth_pi/eval/report.md",
    endpointModel: "judge",
    timeoutMs: 15000,
    cloud: false,
    cloudDataDir: "hearth_pi/.local",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case "--cases":
        args.cases = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--endpoint-url":
        args.endpointUrl = next();
        break;
      case "--endpoint-model":
        args.endpointModel = next();
        break;
      case "--endpoint-api-key":
        args.endpointApiKey = next();
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(next());
        break;
      case "--cloud":
        args.cloud = true;
        break;
      case "--cloud-data-dir":
        args.cloudDataDir = next();
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/eval-judge.mjs [options]",
      "",
      "  --cases <path>            Case file (default hearth_pi/eval/judge-cases.json)",
      "  --out <path>              Markdown report path (default hearth_pi/eval/report.md)",
      "  --endpoint-url <url>      Private OpenAI-compatible judge server, e.g. a hearth_judge add-on",
      "  --endpoint-model <id>     Model id to send (default: judge)",
      "  --endpoint-api-key <key>  Optional bearer key for the endpoint",
      "  --timeout-ms <n>          Per-case timeout (default 15000)",
      "  --cloud                   Also try Hearth Pi's own signed-in cloud judge (skips gracefully if none)",
      "  --cloud-data-dir <path>   Local credential directory for --cloud (default hearth_pi/.local)",
      "",
      "At least one of --endpoint-url or --cloud is required.",
    ].join("\n"),
  );
}

async function runSection({ label, adapter, cases, timeoutMs }) {
  const { runCase, scoreOutcome, summarize, renderSection } = await import(
    "./eval-judge-lib.mjs"
  );
  const scored = [];
  for (const judgeCase of cases) {
    const outcome = await runCase(adapter, judgeCase, { timeoutMs });
    scored.push(scoreOutcome(judgeCase, outcome));
  }
  const summary = summarize(scored);
  console.log(
    `${label}: accuracy ${summary.accuracy === null ? "n/a" : (summary.accuracy * 100).toFixed(1) + "%"}, ` +
      `false-agree ${summary.falseAgreeRate === null ? "n/a" : (summary.falseAgreeRate * 100).toFixed(1) + "%"}, ` +
      `escalation recall ${summary.escalationRecall === null ? "n/a" : (summary.escalationRecall * 100).toFixed(1) + "%"}, ` +
      `p50 ${Math.round(summary.latency.p50)} ms, p95 ${Math.round(summary.latency.p95)} ms, ` +
      `parse failures ${summary.parseFailures}/${summary.total}`,
  );
  return renderSection(label, summary, scored);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.endpointUrl && !args.cloud)) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }
  const { loadCases } = await import("./eval-judge-lib.mjs");
  const casesPath = resolvePath(repoRoot, args.cases);
  const cases = await loadCases(casesPath);
  const sections = [];

  if (args.endpointUrl) {
    const { EndpointJudge } = await import("../hearth_pi/src/judge.js");
    const adapter = new EndpointJudge(
      args.endpointUrl,
      args.endpointApiKey ?? "",
      args.endpointModel,
    );
    sections.push(
      await runSection({
        label: `Endpoint judge (${adapter.id} @ ${args.endpointUrl})`,
        adapter,
        cases,
        timeoutMs: args.timeoutMs,
      }),
    );
  }

  if (args.cloud) {
    try {
      const { Subscription } = await import("../hearth_pi/src/subscription.js");
      const { resolveJudge } = await import("../hearth_pi/src/judge.js");
      const { anthropicAuthEnabled } = await import(
        "../hearth_pi/src/features.js"
      );
      const enabled = anthropicAuthEnabled()
        ? ["openai-codex", "anthropic"]
        : ["openai-codex"];
      const dataDir = resolvePath(repoRoot, args.cloudDataDir);
      const { subscriptions, runtime } = await Subscription.openProviders(
        dataDir,
        [],
        enabled,
      );
      const resolution = resolveJudge("auto", {
        models: runtime,
        signedIn: (provider) =>
          subscriptions.some((s) => s.provider === provider && s.configured()),
      });
      if (!resolution.adapter) {
        console.log(
          `Cloud judge skipped: ${resolution.warning ?? "no signed-in subscription found in " + dataDir}`,
        );
      } else {
        sections.push(
          await runSection({
            label: `Cloud judge (${resolution.model}, signed in locally)`,
            adapter: resolution.adapter,
            cases,
            timeoutMs: args.timeoutMs,
          }),
        );
      }
    } catch (err) {
      console.log(
        `Cloud judge skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (sections.length === 0) {
    console.error("No judge produced results; nothing to report.");
    process.exit(1);
  }

  const { renderReport } = await import("./eval-judge-lib.mjs");
  const report = renderReport(sections, {
    casesPath: args.cases,
    generatedAt: new Date().toISOString(),
  });
  const outPath = resolvePath(repoRoot, args.out);
  await writeFile(outPath, report, "utf8");
  console.log(`Report written to ${args.out}`);
}

await main();
