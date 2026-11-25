/**
 * Conformal Risk Control (Angelopoulos, Bates, Fisch, Lei, Schuster, "Conformal Risk Control", 2022),
 * specialised to a score threshold on integer scores 0..100.
 *
 * Setup. Calibration cases i = 1..n each have a score s_i and a false-resolution indicator F_i in {0,1}.
 * For a threshold lambda the gate ALLOWS a remote attempt iff score >= lambda, so the per-case loss is
 *     L_i(lambda) = 1[s_i >= lambda] * F_i          (bounded by B = 1, non-increasing in lambda)
 * and lambda = 101 (never allow) has loss 0 for every case.
 *
 * Rule. lambda_hat = smallest lambda in [lambdaMin, 100] with
 *     (k(lambda) + 1) / (n + 1) <= alpha,       k(lambda) = sum_i L_i(lambda)
 * (this is (n/(n+1)) * Rhat_n(lambda) + B/(n+1) with B = 1), and 101 when no lambda qualifies.
 *
 * Guarantee (theorem, NOT a property of this code): if the n calibration cases and one new case are
 * EXCHANGEABLE, then E[ L_new(lambda_hat) ] <= alpha. The expectation is over the calibration sample AND the
 * new case, and the loss is "false resolution per attempted case" (not per allowed case).
 *
 * Assumptions that can fail in production (all are shown in the UI and in docs/rre-certification.md):
 *   1. Exchangeability. Scores depend on a per-account prior that is itself learned from earlier outcomes,
 *      and on LLM output that changes with model/prompt versions. Time trends and seasonality break it.
 *   2. The loss is measured only where failures are detectable (reopen, linked repeat job, inside W).
 *   3. Only cases the old gate already let through are observed, so lambda is never below the largest
 *      decision-time threshold in the data (lambdaMin). The layer can only be stricter than before.
 */
import { LAMBDA_NEVER } from './types.ts';

export interface CrcCase {
  score: number;
  loss: 0 | 1;
}

export interface CrcResult {
  lambda: number;
  n: number;
  k: number;
  nAllowed: number;
  correctedRisk: number | null;
  /** True when lambda === LAMBDA_NEVER (no remote attempt would be allowed). */
  abstain: boolean;
}

const EPS = 1e-12;

/** k(lambda) for lambda in [0, 101]: number of failures with score >= lambda. */
export function failuresAtOrAbove(cases: readonly CrcCase[]): number[] {
  const byScore = new Array<number>(102).fill(0);
  for (const c of cases) if (c.loss === 1) byScore[Math.min(100, Math.max(0, Math.round(c.score)))] += 1;
  const k = new Array<number>(103).fill(0);
  for (let l = 101; l >= 0; l--) k[l] = k[l + 1] + (l <= 100 ? byScore[l] : 0);
  return k;
}

export function crcSelectLambda(cases: readonly CrcCase[], alpha: number, lambdaMin: number): CrcResult {
  if (!(alpha > 0 && alpha < 1)) throw new Error('alpha must be in (0, 1)');
  const n = cases.length;
  const lo = Math.min(100, Math.max(0, Math.ceil(lambdaMin)));
  const k = failuresAtOrAbove(cases);
  for (let lambda = lo; lambda <= 100; lambda++) {
    if (k[lambda] + 1 <= alpha * (n + 1) + EPS) {
      const nAllowed = cases.filter((c) => Math.round(c.score) >= lambda).length;
      return { lambda, n, k: k[lambda], nAllowed, correctedRisk: (k[lambda] + 1) / (n + 1), abstain: false };
    }
  }
  return { lambda: LAMBDA_NEVER, n, k: 0, nAllowed: 0, correctedRisk: null, abstain: true };
}
