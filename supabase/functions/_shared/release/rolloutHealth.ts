// Canary health evaluation. Pure and dependency-free (Deno + Vitest).
// Designed to avoid noisy rollbacks (confidence bounds, minimum samples, consecutive breaches) while rolling
// back IMMEDIATELY on a confident drop in call-answer rate, because a bad release can drop customers' calls.

export interface CohortStats { requests: number; errors: number; p95_ms: number; offered: number; answered: number }
export interface HealthSummary { canary: CohortStats; baseline: CohortStats }

export interface Slo {
  minRequests?: number;        // default 200: below this the canary has too little data
  maxErrorRate?: number;       // default 0.02 (absolute ceiling for the canary)
  maxErrorDelta?: number;      // default 0.01 (canary may exceed baseline by at most this)
  maxP95Ms?: number | null;    // default null (no absolute latency ceiling)
  maxP95Ratio?: number;        // default 1.5 (canary p95 <= ratio x baseline p95)
  minAnswerRate?: number | null; // default 0.9 (null disables)
  maxAnswerDrop?: number;      // default 0.05 below baseline
  minOffered?: number;         // default 30 calls before answer-rate is judged
  breachesToRollback?: number; // default 2 consecutive breaching ticks
  minSoakMinutes?: number;     // default 10 minutes at a stage before "promote"
}

export type Severity = 'ok' | 'insufficient' | 'breach' | 'critical';
export interface Evaluation { severity: Severity; reasons: string[] }
export type Decision = 'promote' | 'hold' | 'rollback';
export interface Action { decision: Decision; nextBreachCount: number; reasons: string[] }

const Z95 = 1.96;
const Z99 = 2.33;

export function wilson(successes: number, n: number, z = Z95): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const p = successes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denom = 1 + z2 / n;
  return { lower: Math.max(0, (centre - margin) / denom), upper: Math.min(1, (centre + margin) / denom) };
}

/** One-sided two-proportion z statistic for "a is higher than b". 0 when undefined. */
export function zHigher(x1: number, n1: number, x2: number, n2: number): number {
  if (n1 <= 0 || n2 <= 0) return 0;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  return se === 0 ? 0 : (p1 - p2) / se;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function evaluateHealth(s: HealthSummary, slo: Slo = {}): Evaluation {
  const minRequests = slo.minRequests ?? 200;
  const maxErrorRate = slo.maxErrorRate ?? 0.02;
  const maxErrorDelta = slo.maxErrorDelta ?? 0.01;
  const maxP95Ratio = slo.maxP95Ratio ?? 1.5;
  const minAnswerRate = slo.minAnswerRate === undefined ? 0.9 : slo.minAnswerRate;
  const maxAnswerDrop = slo.maxAnswerDrop ?? 0.05;
  const minOffered = slo.minOffered ?? 30;
  const c = s.canary;
  const b = s.baseline;

  const critical: string[] = [];
  const breach: string[] = [];

  // Call-answer rate: judged on its own sample size, and always critical.
  if (c.offered >= minOffered) {
    const rate = c.answered / c.offered;
    if (minAnswerRate !== null && wilson(c.answered, c.offered).upper < minAnswerRate) {
      critical.push(`call-answer rate ${pct(rate)} is confidently below the ${pct(minAnswerRate)} floor`);
    }
    if (b.offered >= minOffered) {
      const baseRate = b.answered / b.offered;
      const z = zHigher(b.answered, b.offered, c.answered, c.offered); // baseline answers more than canary
      if (rate < baseRate - maxAnswerDrop && z >= Z99) {
        critical.push(`call-answer rate ${pct(rate)} dropped more than ${pct(maxAnswerDrop)} below baseline ${pct(baseRate)}`);
      }
    }
  }

  const enough = c.requests >= minRequests;
  if (enough) {
    const rate = c.errors / c.requests;
    if (wilson(c.errors, c.requests).lower > maxErrorRate) {
      breach.push(`error rate ${pct(rate)} is confidently above the ${pct(maxErrorRate)} ceiling`);
    }
    if (b.requests > 0) {
      const baseRate = b.errors / b.requests;
      if (rate - baseRate > maxErrorDelta && zHigher(c.errors, c.requests, b.errors, b.requests) >= Z99) {
        breach.push(`error rate ${pct(rate)} is significantly above baseline ${pct(baseRate)}`);
      }
    }
    if (slo.maxP95Ms != null && c.p95_ms > slo.maxP95Ms) breach.push(`p95 ${c.p95_ms}ms exceeds ${slo.maxP95Ms}ms`);
    if (b.p95_ms > 0 && c.p95_ms > b.p95_ms * maxP95Ratio) breach.push(`p95 ${c.p95_ms}ms is over ${maxP95Ratio}x baseline ${b.p95_ms}ms`);
  }

  if (critical.length > 0) return { severity: 'critical', reasons: [...critical, ...breach] };
  if (!enough) return { severity: 'insufficient', reasons: [`only ${c.requests} canary requests (need ${minRequests})`] };
  if (breach.length > 0) return { severity: 'breach', reasons: breach };
  return { severity: 'ok', reasons: [] };
}

export function decideAction(args: { evaluation: Evaluation; breachCount: number; soakMinutes: number; slo?: Slo }): Action {
  const { evaluation: e, breachCount, soakMinutes } = args;
  const slo = args.slo ?? {};
  const breachesToRollback = Math.max(1, slo.breachesToRollback ?? 2);
  const minSoak = slo.minSoakMinutes ?? 10;

  if (e.severity === 'critical') return { decision: 'rollback', nextBreachCount: breachCount + 1, reasons: e.reasons };
  if (e.severity === 'breach') {
    const next = breachCount + 1;
    return next >= breachesToRollback
      ? { decision: 'rollback', nextBreachCount: next, reasons: e.reasons }
      : { decision: 'hold', nextBreachCount: next, reasons: [`breach ${next}/${breachesToRollback}`, ...e.reasons] };
  }
  if (e.severity === 'insufficient') return { decision: 'hold', nextBreachCount: breachCount, reasons: e.reasons };
  if (soakMinutes < minSoak) return { decision: 'hold', nextBreachCount: 0, reasons: [`soaking: ${Math.floor(soakMinutes)}/${minSoak} min`] };
  return { decision: 'promote', nextBreachCount: 0, reasons: [] };
}
