// supabase/functions/_shared/economics/routingGate.ts
//
// Quality gate for cheaper-model routing. Input: PAIRED per-case scores (same eval case, baseline vs candidate,
// score in [0,1]). Output: mean quality delta with a seeded bootstrap 95% CI and a pass/fail decision.
// A route may be enabled ONLY when decision.pass === true. Deterministic (seeded PRNG) so results are reproducible.

export interface PairedCase { caseId: string; baseline: number; candidate: number; critical?: boolean }
export interface GateConfig { tolerance: number; minCases: number; bootstrapIters: number; seed: number; confidence: number }
export const DEFAULT_GATE: GateConfig = { tolerance: 0.02, minCases: 30, bootstrapIters: 4000, seed: 1337, confidence: 0.95 };

export interface GateResult {
  n: number;
  meanDelta: number;
  ciLow: number;
  ciHigh: number;
  criticalRegressions: string[];
  pass: boolean;
  reasons: string[];
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function evaluateRoute(cases: readonly PairedCase[], cfg: GateConfig = DEFAULT_GATE): GateResult {
  const valid = cases.filter((c) => Number.isFinite(c.baseline) && Number.isFinite(c.candidate));
  const n = valid.length;
  const reasons: string[] = [];
  const deltas = valid.map((c) => c.candidate - c.baseline);
  const meanDelta = n ? deltas.reduce((a, b) => a + b, 0) / n : 0;
  const criticalRegressions = valid.filter((c) => c.critical && c.candidate < c.baseline).map((c) => c.caseId);

  let ciLow = NaN, ciHigh = NaN;
  if (n > 0) {
    const rnd = mulberry32(cfg.seed);
    const means: number[] = [];
    for (let i = 0; i < cfg.bootstrapIters; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += deltas[Math.floor(rnd() * n)];
      means.push(s / n);
    }
    means.sort((a, b) => a - b);
    const alpha = (1 - cfg.confidence) / 2;
    ciLow = means[Math.floor(alpha * (means.length - 1))];
    ciHigh = means[Math.ceil((1 - alpha) * (means.length - 1))];
  }
  if (n < cfg.minCases) reasons.push(`insufficient_cases(${n}<${cfg.minCases})`);
  if (!(ciLow >= -cfg.tolerance)) reasons.push(`ci_low_below_tolerance(${Number.isNaN(ciLow) ? "nan" : ciLow.toFixed(4)})`);
  if (criticalRegressions.length) reasons.push(`critical_case_regression(${criticalRegressions.length})`);
  return { n, meanDelta, ciLow, ciHigh, criticalRegressions, pass: reasons.length === 0, reasons };
}

/** Cost delta in micro-USD per call (negative = cheaper). Reported beside the quality delta, never instead of it. */
export function costDeltaPct(baselineMicroPerCall: number, candidateMicroPerCall: number): number | null {
  return baselineMicroPerCall > 0 ? ((candidateMicroPerCall - baselineMicroPerCall) / baselineMicroPerCall) * 100 : null;
}
