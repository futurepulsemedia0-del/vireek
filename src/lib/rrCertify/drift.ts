/**
 * Drift monitor. Seeded-test friendly and fully deterministic (no clock, no randomness).
 *
 * What is monitored: among ATTEMPTS THE GATE ALLOWS (shadow: would allow), how often a false resolution
 * shows up. Reference: the Clopper-Pearson upper bound (95%) on that same rate in the calibration data.
 *
 * ALARM RULE (one-sided exact binomial tests over several recent windows, Bonferroni-corrected)
 *   For each window size w in `windows` (default 30, 60, 100, 200) that is already filled, take the w most
 *   recent concluded allowed attempts; k_w = false resolutions seen so far among them. Cases whose window
 *   W is still open contribute only a failure they ALREADY showed; since final failures >= failures seen
 *   so far, using the smaller number can only make the test more conservative, so the early warning stays
 *   valid.
 *   Alarm iff for some filled w:  P( Binomial(w, rho_ref) >= k_w ) <= alarmP / (number of windows).
 *   History: the first version used one window of 100 and detected a x3 shift within 100 cases in only
 *   63.2% of simulated seeds (docs/_audit/rre-certify-report.md). Several window sizes react faster to an
 *   abrupt shift; the simulation was rerun and both results are reported.
 *   If calibration data allow no reference (too few allowed cases), the monitor is 'insufficient' and
 *   the system must not run live (gate treats a missing reference as no snapshot validity, see index.ts).
 *
 * Limits, stated plainly:
 *   - alarmP is per evaluation, not per year. Evaluating repeatedly raises the chance of at least one
 *     false alarm. A false alarm only costs savings (everything dispatches), a missed alarm costs trust.
 *   - After an alarm there is NO automatic re-arm. A new snapshot plus an explicit owner acknowledgement
 *     is required (rr_certify_ack_drift).
 *   - Slow drift that stays under rho_ref is not detected; this guards against shifts, not against a
 *     calibration that was already optimistic.
 */
import { binomUpperTail, clopperPearsonUpper } from './stats.ts';
import type { CalibrationSnapshot } from './types.ts';

export interface DriftConfig {
  /** Window sizes (most recent allowed attempts). Ascending. */
  windows: number[];
  /** Calibration must have allowed at least this many cases for a reference rate to exist. */
  minReferenceCases: number;
  alarmP: number;
  referenceConfidence: number;
}
export const DEFAULT_DRIFT_CONFIG: DriftConfig = { windows: [30, 60, 100, 200], minReferenceCases: 20, alarmP: 0.01, referenceConfidence: 0.95 };

/** One concluded attempt the gate allowed (or, in shadow mode, would have allowed). Newest first. */
export interface DriftObservation {
  caseId: string;
  /** A false resolution has been seen (final if the window closed, otherwise "so far"). */
  failureSeen: boolean;
}

export type DriftStatus = 'ok' | 'alarm' | 'insufficient';

export interface DriftState {
  status: DriftStatus;
  /** Window that produced the smallest p-value (0 when no window is filled yet). */
  m: number;
  k: number;
  referenceRate: number | null;
  pValue: number | null;
  rule: string;
}

export function driftReference(snapshot: CalibrationSnapshot, cfg: DriftConfig = DEFAULT_DRIFT_CONFIG): number | null {
  if (snapshot.allowedN < cfg.minReferenceCases) return null;
  return clopperPearsonUpper(snapshot.allowedK, snapshot.allowedN, cfg.referenceConfidence);
}

export function evaluateDrift(
  observations: readonly DriftObservation[],
  referenceRate: number | null,
  cfg: DriftConfig = DEFAULT_DRIFT_CONFIG,
): DriftState {
  const rule = `alarm if, for a filled window w in [${cfg.windows.join(', ')}], P(Bin(w, reference) >= k) <= ${cfg.alarmP}/${cfg.windows.length}`;
  const filled = cfg.windows.filter((w) => observations.length >= w);
  if (referenceRate === null || filled.length === 0) {
    const m = Math.min(observations.length, cfg.windows[cfg.windows.length - 1]);
    return { status: 'insufficient', m, k: observations.slice(0, m).filter((o) => o.failureSeen).length, referenceRate, pValue: null, rule };
  }
  let best = { w: 0, k: 0, p: 2 };
  for (const w of filled) {
    const k = observations.slice(0, w).filter((o) => o.failureSeen).length;
    const p = binomUpperTail(k, w, referenceRate);
    if (p < best.p) best = { w, k, p };
  }
  return { status: best.p <= cfg.alarmP / cfg.windows.length ? 'alarm' : 'ok', m: best.w, k: best.k, referenceRate, pValue: best.p, rule };
}
