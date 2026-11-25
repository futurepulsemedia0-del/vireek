/**
 * Learn-then-Test (Angelopoulos et al., 2021) for the CONDITIONAL false-resolution rate.
 *
 * Why this exists next to crc.ts. CRC controls the expected loss PER ATTEMPTED CASE:
 *     E[ 1[score >= lambda] * F ] <= alpha.
 * That can be satisfied by allowing only a tiny top slice of cases that ALL fail, which is not what an
 * owner reads into "false-resolution rate" (found by a failing unit test, see crc.test.ts). The number an
 * owner cares about is the rate AMONG the attempts the gate lets through:
 *     P( F = 1 | score >= lambda ) <= alpha.
 * That is a ratio, not a monotone expectation, so CRC's theorem does not apply; LTT does.
 *
 * Procedure. Candidate grid lambda_g (step 5 from lambdaMin up to 100, 100 always included), G points.
 * For each: among the n_g calibration cases with score >= lambda_g, k_g failed.
 * p_g = P( Binomial(n_g, alpha) <= k_g )  -- exact one-sided p-value for H0: rate > alpha.
 * Reject H0_g (declare lambda_g safe) iff p_g <= delta / G (Bonferroni over the grid).
 * With probability >= 1 - delta over the calibration sample, EVERY rejected lambda_g has true conditional
 * rate <= alpha (exchangeability assumed). Conditioning on the scores, the outcomes of the cases above
 * lambda_g are i.i.d. Bernoulli(rate) under exchangeability, which is what makes the p-value exact.
 *
 * Cost: a segment needs roughly ln(delta/G)/ln(1-alpha) allowed cases with no failures before ANY lambda
 * can be declared safe (about 90 for alpha 5%, delta 10%, G 10). Fewer than that => abstain. That is the
 * price of a statement an owner can rely on.
 */
import { crcSelectLambda, type CrcCase } from './crc.ts';
import { binomCdf } from './stats.ts';
import { LAMBDA_NEVER } from './types.ts';

export const LTT_GRID_STEP = 5;

export interface ThresholdResult {
  /** Gate threshold: 101 = never allow. */
  lambda: number;
  n: number;
  /** Failures among cases with score >= lambda. */
  k: number;
  nAllowed: number;
  /** k / nAllowed, descriptive only (NOT the guarantee). */
  conditionalRate: number | null;
  /** Exact binomial p-value at lambda (compare with delta / gridSize). */
  pValue: number | null;
  gridSize: number;
  /** CRC (per attempted case) condition holds at lambda. */
  crcOk: boolean;
  abstain: boolean;
}

export function lttGrid(lambdaMin: number): number[] {
  const lo = Math.min(100, Math.max(0, Math.ceil(lambdaMin)));
  const grid: number[] = [];
  for (let l = lo; l < 100; l += LTT_GRID_STEP) grid.push(l);
  grid.push(100);
  return grid;
}

/**
 * Smallest grid lambda that is (a) LTT-rejected (conditional rate <= alpha with confidence 1 - delta) AND
 * (b) satisfies the CRC condition (expected per-attempt loss <= alpha). Because (b) holds at this lambda and
 * it is at least as large as CRC's own lambda_hat, the CRC guarantee transfers (loss is non-increasing in
 * lambda), and (a) holds because it is in the rejected set. Both statements are therefore valid together.
 */
export function selectThreshold(cases: readonly CrcCase[], alpha: number, delta: number, lambdaMin: number): ThresholdResult {
  if (!(alpha > 0 && alpha < 1)) throw new Error('alpha must be in (0, 1)');
  if (!(delta > 0 && delta < 1)) throw new Error('delta must be in (0, 1)');
  const n = cases.length;
  const grid = lttGrid(lambdaMin);
  const crc = crcSelectLambda(cases, alpha, lambdaMin);
  for (const lambda of grid) {
    const above = cases.filter((c) => Math.round(c.score) >= lambda);
    const nAllowed = above.length;
    if (nAllowed === 0) continue;
    const k = above.reduce((s, c) => s + c.loss, 0);
    const pValue = binomCdf(k, nAllowed, alpha);
    const lttOk = pValue <= delta / grid.length;
    const crcOk = !crc.abstain && lambda >= crc.lambda;
    if (lttOk && crcOk) {
      return { lambda, n, k, nAllowed, conditionalRate: k / nAllowed, pValue, gridSize: grid.length, crcOk, abstain: false };
    }
  }
  return { lambda: LAMBDA_NEVER, n, k: 0, nAllowed: 0, conditionalRate: null, pValue: null, gridSize: grid.length, crcOk: false, abstain: true };
}
