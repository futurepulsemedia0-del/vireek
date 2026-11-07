// Near-tie analysis for dispatch decisions (Phase 0 gate of "natural randomization").
// PURE: no I/O. Reads the audit snapshots that rulesAssign already writes to
// dispatch_decisions.explanation.candidates and answers two questions:
//   1. How often are the top eligible candidates within ε score points of each other?
//   2. Is that volume enough to measure an outcome difference (power)?
// Power maths is NOT re-implemented: it reuses requiredPerArm() from opsExperiments.

import { requiredPerArm, type Alpha } from './opsExperiments';

export interface AuditCandidate {
  technician_id: string;
  eligible: boolean;
  score: number;
}

export interface DecisionLite {
  id: string;
  mode: string;
  technician_id: string | null;
  note: string | null;
  created_at: string;
  explanation: unknown;
}

/** Score resolution written by rulesEngine (round1) — ε below this is meaningless. */
export const SCORE_RESOLUTION = 0.1;
/** Prefix written by rulesAssign when DB gates (time off / capacity / compliance) skipped a candidate. */
export const GATE_SKIP_PREFIX = 'Skipped by system gates';
const FLOAT_SLACK = 1e-9;

export function parseCandidates(explanation: unknown): AuditCandidate[] {
  if (!explanation || typeof explanation !== 'object') return [];
  const raw = (explanation as { candidates?: unknown }).candidates;
  if (!Array.isArray(raw)) return [];
  const out: AuditCandidate[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    if (typeof r.technician_id !== 'string' || typeof r.score !== 'number' || !Number.isFinite(r.score)) continue;
    out.push({ technician_id: r.technician_id, eligible: r.eligible === true, score: r.score });
  }
  return out;
}

/** Number of eligible candidates within ε of the best, capped at k. 0 when nobody is eligible. */
export function tieSize(candidates: AuditCandidate[], eps: number, k: number): number {
  const scores = candidates.filter((c) => c.eligible).map((c) => c.score).sort((a, b) => b - a);
  if (scores.length === 0) return 0;
  let n = 0;
  for (const s of scores) {
    if (scores[0] - s <= eps + FLOAT_SLACK) n += 1; else break;
    if (n >= k) break;
  }
  return n;
}

export interface Proportion { successes: number; n: number; rate: number; ciLow: number; ciHigh: number }

/** Wilson 95% interval — well behaved for small n and rates near 0. */
export function wilson(successes: number, n: number, z = 1.959963984540054): Proportion {
  if (n <= 0) return { successes, n, rate: 0, ciLow: 0, ciHigh: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { successes, n, rate: p, ciLow: Math.max(0, centre - half), ciHigh: Math.min(1, centre + half) };
}

export interface TieStat {
  eps: number;
  /** Auto decisions with ≥1 eligible candidate and no DB-gate skipping (the tie set is verifiable). */
  denominator: number;
  tied: Proportion;
  meanTieSize: number;
  /** Decisions excluded from the numerator because a DB gate changed the candidate set. */
  gateSkipped: number;
}

export interface TieSummary {
  autoDecisions: number;
  withEligible: number;
  unparseable: number;
  windowDays: number;
  stats: TieStat[];
}

export function nearTieStats(decisions: DecisionLite[], epsGrid: number[], k = 3): TieSummary {
  const auto = decisions.filter((d) => d.mode === 'auto' && d.technician_id !== null);
  let unparseable = 0;
  const usable: { cands: AuditCandidate[]; gated: boolean }[] = [];
  for (const d of auto) {
    const cands = parseCandidates(d.explanation);
    if (cands.length === 0) { unparseable += 1; continue; }
    if (!cands.some((c) => c.eligible)) continue;
    usable.push({ cands, gated: (d.note ?? '').startsWith(GATE_SKIP_PREFIX) });
  }
  const times = auto.map((d) => Date.parse(d.created_at)).filter(Number.isFinite);
  const windowDays = times.length ? Math.max(1, Math.ceil((Math.max(...times) - Math.min(...times)) / 86_400_000)) : 0;

  const stats = [...epsGrid].sort((a, b) => a - b).map((eps) => {
    const verifiable = usable.filter((u) => !u.gated);
    let tied = 0;
    let sizeSum = 0;
    for (const u of verifiable) {
      const s = tieSize(u.cands, eps, k);
      if (s >= 2) { tied += 1; sizeSum += s; }
    }
    return {
      eps,
      denominator: verifiable.length,
      tied: wilson(tied, verifiable.length),
      meanTieSize: tied ? sizeSum / tied : 0,
      gateSkipped: usable.length - verifiable.length,
    };
  });
  return { autoDecisions: auto.length, withEligible: usable.length, unparseable, windowDays, stats };
}

export interface PowerRow { mde: number; perArm: number | null; tiedJobsNeeded: number | null; monthsNeeded: number | null }

/**
 * Pooled two-arm contrast among tied jobs (e.g. "tie-break rule A vs B"), binary outcome.
 * Technician-vs-technician contrasts need far more volume and are not planned here.
 */
export function powerPlan(opts: { tiedJobsPerMonth: number; baselineRate: number; mdeGrid: number[]; alpha?: Alpha }): PowerRow[] {
  const alpha = opts.alpha ?? 0.05;
  const baseline = { n: 0, mean: opts.baselineRate, sd: Math.sqrt(opts.baselineRate * (1 - opts.baselineRate)) };
  return opts.mdeGrid.map((mde) => {
    const perArm = requiredPerArm('ftf_rate', 'randomized', baseline, mde, alpha);
    const tiedJobsNeeded = perArm === null ? null : perArm * 2;
    const monthsNeeded = tiedJobsNeeded === null || !(opts.tiedJobsPerMonth > 0) ? null : tiedJobsNeeded / opts.tiedJobsPerMonth;
    return { mde, perArm, tiedJobsNeeded, monthsNeeded };
  });
}

export type GateVerdict = 'PASS' | 'STOP_RARE_TIES' | 'STOP_UNDERPOWERED' | 'INSUFFICIENT_DATA';

export interface GateThresholds {
  minTieRate: number;
  epsMax: number;
  minDecisions: number;
  mde: number;
  maxMonths: number;
}

export const DEFAULT_THRESHOLDS: GateThresholds = { minTieRate: 0.05, epsMax: 2, minDecisions: 200, mde: 0.05, maxMonths: 6 };

export interface GateOutcome { verdict: GateVerdict; epsChosen: number | null; reason: string }

export function evaluateGate(summary: TieSummary, baselineRate: number, t: GateThresholds = DEFAULT_THRESHOLDS): GateOutcome {
  if (summary.withEligible < t.minDecisions || summary.windowDays <= 0) {
    return { verdict: 'INSUFFICIENT_DATA', epsChosen: null, reason: `Only ${summary.withEligible} usable auto decisions (need ≥${t.minDecisions}); the tie rate cannot be estimated reliably.` };
  }
  const candidates = summary.stats.filter((s) => s.eps <= t.epsMax + FLOAT_SLACK);
  const rareOnly = candidates.every((s) => s.tied.rate < t.minTieRate);
  if (rareOnly) {
    const best = candidates[candidates.length - 1];
    return { verdict: 'STOP_RARE_TIES', epsChosen: null, reason: `At ε ≤ ${t.epsMax} points near-ties are ${(best ? best.tied.rate * 100 : 0).toFixed(1)}% of decisions (< ${t.minTieRate * 100}%).` };
  }
  const perMonth = (s: TieStat) => (s.tied.successes / summary.windowDays) * 30.4375;
  for (const s of candidates) {
    if (s.tied.rate < t.minTieRate) continue;
    const row = powerPlan({ tiedJobsPerMonth: perMonth(s), baselineRate, mdeGrid: [t.mde] })[0];
    if (row.monthsNeeded !== null && row.monthsNeeded <= t.maxMonths) {
      return { verdict: 'PASS', epsChosen: s.eps, reason: `ε=${s.eps}: ${(s.tied.rate * 100).toFixed(1)}% near-ties, ~${perMonth(s).toFixed(0)} tied jobs/month; a ${t.mde * 100} pp effect is detectable in ~${row.monthsNeeded.toFixed(1)} months.` };
    }
  }
  return { verdict: 'STOP_UNDERPOWERED', epsChosen: null, reason: `Near-ties are frequent enough, but a ${t.mde * 100} pp difference would take more than ${t.maxMonths} months to detect.` };
}
