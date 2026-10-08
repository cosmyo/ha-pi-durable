// Ambient declarations for eval-judge-lib.mjs, used only so
// hearth_pi/test/eval-judge.test.ts can typecheck against it without pulling
// this repo-root scripts/ directory into hearth_pi's own tsc rootDir/build.
// The implementation (and its tests, run by node:test under tsx) is the
// source of truth; this file is intentionally loose where the runtime
// already validates shape (e.g. judge-cases.json contents).
import type { JudgeAdapter, JudgeVerdict } from "../hearth_pi/src/judge.js";
import type { RiskLevel } from "../hearth_pi/src/documents.js";

export type JudgeCase = {
  id: string;
  category: "aligned" | "misaligned" | "injection" | "escalation";
  ownerRequest: string;
  action: unknown;
  deterministicLevel: RiskLevel;
  expected: { aligned: boolean; minEscalation?: RiskLevel };
};

export type RunOutcome = {
  id: string;
  latencyMs: number;
  verdict: JudgeVerdict | null;
  errorCode: string | null;
};

export type ScoredOutcome = {
  id: string;
  category: JudgeCase["category"];
  latencyMs: number;
  errorCode: string | null;
  parseFailed: boolean;
  unavailable: boolean;
  alignedMatch: boolean;
  falseAgree: boolean;
  needsEscalation: boolean;
  escalationMet: boolean;
};

export type Summary = {
  total: number;
  accuracy: number | null;
  falseAgreeRate: number | null;
  falseAgreeCount: number;
  falseAgreeTotal: number;
  escalationRecall: number | null;
  escalationTotal: number;
  parseFailures: number;
  unavailable: number;
  byCategory: Record<string, { total: number; accuracy: number | null }>;
  latency: { p50: number; p95: number; mean: number };
};

export function loadCases(path: string): Promise<JudgeCase[]>;
export function runCase(
  adapter: JudgeAdapter,
  judgeCase: JudgeCase,
  options?: { timeoutMs?: number },
): Promise<RunOutcome>;
export function scoreOutcome(
  judgeCase: JudgeCase,
  outcome: RunOutcome,
): ScoredOutcome;
export function summarize(scored: ScoredOutcome[]): Summary;
export function renderSection(
  title: string,
  summary: Summary,
  scored: ScoredOutcome[],
): string;
export function renderReport(
  sections: string[],
  meta?: { casesPath?: string; generatedAt?: string },
): string;
