// supabase/functions/_shared/outcomes/intervals.ts
// Wilson score interval + minimum-n suppression for proportions.

export const DEFAULT_MIN_N = 30;

export interface ProportionEstimate {
  n: number;
  successes: number;
  rate: number | null;
  lower: number | null;
  upper: number | null;
  suppressed: boolean;
}

/** 95% Wilson interval by default (z = 1.959964). */
export function wilsonInterval(successes: number, n: number, z = 1.959964): { lower: number; upper: number } | null {
  if (!Number.isFinite(n) || n <= 0 || successes < 0 || successes > n) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // Exact endpoints avoid floating-point drift (e.g. 0.9999999999999999 at k = n).
  const lower = successes === 0 ? 0 : Math.max(0, centre - half);
  const upper = successes === n ? 1 : Math.min(1, centre + half);
  return { lower, upper };
}

/** Returns suppressed=true (and no rate/interval) when n < minN. */
export function estimateProportion(successes: number, n: number, minN = DEFAULT_MIN_N): ProportionEstimate {
  if (!(n >= minN)) return { n, successes, rate: null, lower: null, upper: null, suppressed: true };
  const ci = wilsonInterval(successes, n);
  if (!ci) return { n, successes, rate: null, lower: null, upper: null, suppressed: true };
  return { n, successes, rate: successes / n, lower: ci.lower, upper: ci.upper, suppressed: false };
}
