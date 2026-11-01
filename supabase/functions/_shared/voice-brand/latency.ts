// supabase/functions/_shared/voice-brand/latency.ts
//
// Pure helpers to turn a Vapi end-of-call-report into turn-latency samples.
// ASSUMPTION (unverified in this repo): Vapi puts per-turn metrics at
// message.artifact.performanceMetrics.turnLatencies[].turnLatency (ms).
// The parser is defensive: any other shape yields [] and nothing is stored.

import { evaluateTurnLatency, percentile } from "./styleCheck.ts";

const MAX_SANE_MS = 60_000;

function pickArray(message: unknown): unknown[] {
  const m = message as { artifact?: { performanceMetrics?: { turnLatencies?: unknown } }; performanceMetrics?: { turnLatencies?: unknown } } | null;
  const a = m?.artifact?.performanceMetrics?.turnLatencies ?? m?.performanceMetrics?.turnLatencies;
  return Array.isArray(a) ? a : [];
}

export function extractTurnLatencies(message: unknown): number[] {
  const out: number[] = [];
  for (const item of pickArray(message)) {
    const v = typeof item === "number" ? item : (item as { turnLatency?: unknown } | null)?.turnLatency;
    if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_SANE_MS) out.push(Math.round(v));
  }
  return out;
}

export interface LatencySummary {
  turnCount: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  withinBudget: boolean;
}

export function summarizeLatency(samples: number[]): LatencySummary {
  if (!samples.length) return { turnCount: 0, p50: null, p95: null, max: null, withinBudget: true };
  const verdict = evaluateTurnLatency(samples);
  return {
    turnCount: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: Math.max(...samples),
    withinBudget: verdict.passed,
  };
}
