/**
 * Power and feasibility calculator for the Causal Dispatch Network (pure).
 *
 * Question: with THIS tenant's volume, can randomizing among near-equal technicians ever teach us anything useful?
 *
 * Model (normal approximation, deliberately simple and stated):
 *   - Qualifying decisions per week  J_s = jobsPerWeek × (share of decisions whose set has >= 2 members).
 *   - Each qualifying decision is randomized with probability q (the exploration budget); an enrolled decision picks
 *     uniformly inside its set, so over all technicians the exploration picks per technician per week are
 *         e = J_s × q / T       (T = dispatch-enabled technicians; assumes picks spread evenly — optimistic if not).
 *   - Effect of one technician vs the equal-weighted average of its peers, binary outcome with baseline rate f:
 *         Var(θ̂) ≈ DEFF × f(1−f)/(e × cellShare × W) × (1 − 1/k̄),    W = weeks observed.
 *   - MDE = (z_{1−α/2} + z_{power}) × √Var(θ̂).      weeks to reach target m:  W = DEFF f(1−f)(z+z)² (1−1/k̄) / (e·cellShare·m²).
 * The AIPW estimator can do better than this (a good outcome model removes variance) but cannot do much worse, and the
 * simulation harness (scripts/causal/simulate.ts) checks the formula against empirical power.
 *
 * THRESHOLDS BELOW ARE PRODUCT/STATISTICS DEFAULTS THAT REQUIRE HUMAN SIGN-OFF.
 */

import { normalQuantile } from './normal';

export const MEANINGFUL_MDE = 0.1;        // 10 percentage points of first-time fix
export const GO_WEEKS = 26;
export const MARGINAL_WEEKS = 52;
export const MIN_QUALIFYING_SHARE = 0.1;  // same threshold as VIABILITY_THRESHOLD in the indifference-set module

export interface PowerInput {
  technicians: number;
  jobsPerWeek: number;
  /** Set size -> number of decisions, e.g. FeasibilityReport.sizeDistribution. Size 0 is ignored. */
  setSizeDistribution: Record<number, number>;
  /** Exploration budget in percent (0–25). */
  budgetPct: number;
  /** Baseline first-time-fix rate, 0–1 (exclusive). */
  baselineFtf: number;
  targetMde?: number;
  alpha?: number;
  power?: number;
  /** Share of a technician's randomized jobs that fall in the job type of interest (1 = pooled over job types). */
  cellShare?: number;
  /** Design effect from clustering (>= 1). */
  designEffect?: number;
}

export type PowerVerdict = 'go' | 'marginal' | 'no_go' | 'no_data';

export interface PowerResult {
  verdict: PowerVerdict;
  qualifyingShare: number | null;
  meanSetSize: number | null;
  setDecisionsPerWeek: number;
  explorationPicksPerTechPerWeek: number;
  targetMde: number;
  /** Weeks until the target MDE is detectable; null when never (no volume). */
  weeksToTarget: number | null;
  /** Smallest detectable effect (absolute, 0–1) after 26 and 52 weeks. */
  mdeAt26Weeks: number | null;
  mdeAt52Weeks: number | null;
  message: string;
}

export function summarizeSets(dist: Record<number, number>): { withEligible: number; qualifying: number; meanSetSize: number | null } {
  let withEligible = 0;
  let qualifying = 0;
  let sizeSum = 0;
  for (const [k, c] of Object.entries(dist)) {
    const size = Number(k);
    if (!(size >= 1) || !(c > 0)) continue;
    withEligible += c;
    if (size >= 2) { qualifying += c; sizeSum += size * c; }
  }
  return { withEligible, qualifying, meanSetSize: qualifying > 0 ? sizeSum / qualifying : null };
}

export function mdeAfterWeeks(i: PowerInput, weeks: number): number | null {
  const k = commonRate(i);
  if (!k || !(weeks > 0)) return null;
  const z = normalQuantile(1 - (i.alpha ?? 0.05) / 2) + normalQuantile(i.power ?? 0.8);
  return z * Math.sqrt(k.varPerWeek / weeks);
}

function commonRate(i: PowerInput): { varPerWeek: number } | null {
  const { withEligible, qualifying, meanSetSize } = summarizeSets(i.setSizeDistribution);
  const q = Math.min(25, Math.max(0, i.budgetPct)) / 100;
  if (!(i.technicians > 0) || !(i.jobsPerWeek > 0) || withEligible === 0 || qualifying === 0 || meanSetSize === null || q === 0) return null;
  if (!(i.baselineFtf > 0 && i.baselineFtf < 1)) return null;
  const e = (i.jobsPerWeek * (qualifying / withEligible) * q) / i.technicians * (i.cellShare ?? 1);
  if (!(e > 0)) return null;
  const deff = Math.max(1, i.designEffect ?? 1);
  return { varPerWeek: (deff * i.baselineFtf * (1 - i.baselineFtf) * (1 - 1 / meanSetSize)) / e };
}

export function assessFeasibility(i: PowerInput): PowerResult {
  const target = i.targetMde ?? MEANINGFUL_MDE;
  const { withEligible, qualifying, meanSetSize } = summarizeSets(i.setSizeDistribution);
  const qualifyingShare = withEligible > 0 ? qualifying / withEligible : null;
  const q = Math.min(25, Math.max(0, i.budgetPct)) / 100;
  const base = {
    qualifyingShare, meanSetSize, targetMde: target,
    setDecisionsPerWeek: qualifyingShare === null ? 0 : i.jobsPerWeek * qualifyingShare,
    explorationPicksPerTechPerWeek: qualifyingShare === null || !(i.technicians > 0) ? 0 : (i.jobsPerWeek * qualifyingShare * q) / i.technicians,
  };
  const none = (verdict: PowerVerdict, message: string): PowerResult => ({ ...base, verdict, weeksToTarget: null, mdeAt26Weeks: null, mdeAt52Weeks: null, message });

  if (withEligible === 0) return none('no_data', 'No dispatch history to size this yet. Leave randomized dispatch off until the feasibility check has data.');
  if (qualifyingShare !== null && qualifyingShare < MIN_QUALIFYING_SHARE) {
    return none('no_go', `Not enough volume to learn this: only ${(qualifyingShare * 100).toFixed(0)}% of your dispatch decisions have two or more near-equal technicians. We recommend leaving this feature off.`);
  }
  const rate = commonRate(i);
  if (!rate) return none('no_go', 'Not enough volume to learn this with these settings (budget, jobs per week, technicians or baseline rate). We recommend leaving this feature off.');

  const z = normalQuantile(1 - (i.alpha ?? 0.05) / 2) + normalQuantile(i.power ?? 0.8);
  const weeks = (z * z * rate.varPerWeek) / (target * target);
  const r = { ...base, weeksToTarget: weeks, mdeAt26Weeks: mdeAfterWeeks(i, 26), mdeAt52Weeks: mdeAfterWeeks(i, 52) };
  const pp = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(0)} points`);
  if (weeks <= GO_WEEKS) return { ...r, verdict: 'go', message: `At this volume a ${(target * 100).toFixed(0)}-point difference in first-time fix could be detected in about ${Math.ceil(weeks)} weeks.` };
  if (weeks <= MARGINAL_WEEKS) return { ...r, verdict: 'marginal', message: `Slow but possible: about ${Math.ceil(weeks)} weeks to detect a ${(target * 100).toFixed(0)}-point difference. Only differences of ${pp(r.mdeAt26Weeks)} or more would show within 6 months.` };
  return { ...r, verdict: 'no_go', message: `Not enough volume to learn this: detecting a ${(target * 100).toFixed(0)}-point difference would take about ${Math.ceil(weeks)} weeks (after a year only differences of ${pp(r.mdeAt52Weeks)} or more would show). We recommend leaving this feature off.` };
}
