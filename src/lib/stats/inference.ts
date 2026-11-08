/**
 * Shared, dependency-free statistical primitives.
 * Extracted from src/lib/opsExperiments.ts so ops and growth experiments use ONE implementation.
 * opsExperiments.ts re-exports these names, so existing imports keep working unchanged.
 */

export interface Sample {
  n: number;
  mean: number;
  variance: number;
}

export interface SrmResult {
  nTreatment: number;
  nControl: number;
  p: number;
  failed: boolean;
}

/** Minimum observations per cell before an effect is reported as anything but "collecting". */
export const MIN_CELL_N = 30;
/** Binary outcomes need at least this many events and non-events per cell for the normal approximation. */
export const MIN_BINARY_EVENTS = 5;
export const SRM_ALPHA = 0.001;

// Abramowitz & Stegun 7.1.26 (max absolute error 1.5e-7).
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-a * a);
  return sign * y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Two-sided p-value for a standard-normal statistic. */
export function twoSidedP(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  return Math.min(1, Math.max(0, 1 - erf(x)));
}

export function summarize(values: number[]): Sample {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, variance: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (n === 1) return { n, mean, variance: 0 };
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  return { n, mean, variance };
}

/** Sample-ratio-mismatch test on ENROLLED units (not on observed outcomes). `treatmentShare` is a percentage (0-100). */
export function srmCheck(nTreatment: number, nControl: number, treatmentShare: number): SrmResult {
  const total = nTreatment + nControl;
  const share = treatmentShare / 100;
  const expT = total * share;
  const expC = total * (1 - share);
  if (total === 0 || expT === 0 || expC === 0) return { nTreatment, nControl, p: 1, failed: false };
  const chi2 = (nTreatment - expT) ** 2 / expT + (nControl - expC) ** 2 / expC;
  const p = twoSidedP(Math.sqrt(chi2));
  return { nTreatment, nControl, p, failed: total >= 20 && p < SRM_ALPHA };
}
