// supabase/functions/_shared/outcomes/calibration.ts
// Prediction calibration math: Brier score, reliability bins, ECE, skill, drift,
// and the demotion rule. SQL (predictor_calibration_v) uses the same bin
// definition: 10 equal-width bins on [0,1], p = 1 falls in the last bin.

export interface Prediction { p: number; y: 0 | 1 | boolean }

export interface Bin { index: number; lo: number; hi: number; n: number; meanP: number | null; meanY: number | null }

export const DEFAULT_MIN_N = 50;
export const DEFAULT_MAX_ECE = 0.15;
export const DEFAULT_DRIFT_ECE_DELTA = 0.1;

const yv = (y: Prediction["y"]) => (y === true || y === 1 ? 1 : 0);

export function validPredictions(preds: Prediction[]): Prediction[] {
  return preds.filter((x) => Number.isFinite(x.p) && x.p >= 0 && x.p <= 1);
}

export function brierScore(preds: Prediction[]): number | null {
  const v = validPredictions(preds);
  if (v.length === 0) return null;
  return v.reduce((s, x) => s + (x.p - yv(x.y)) ** 2, 0) / v.length;
}

export function reliabilityBins(preds: Prediction[], nBins = 10): Bin[] {
  const v = validPredictions(preds);
  const bins: Array<{ n: number; sp: number; sy: number }> = Array.from({ length: nBins }, () => ({ n: 0, sp: 0, sy: 0 }));
  for (const x of v) {
    const i = Math.min(nBins - 1, Math.floor(x.p * nBins));
    bins[i].n++; bins[i].sp += x.p; bins[i].sy += yv(x.y);
  }
  return bins.map((b, i) => ({
    index: i, lo: i / nBins, hi: (i + 1) / nBins, n: b.n,
    meanP: b.n ? b.sp / b.n : null, meanY: b.n ? b.sy / b.n : null,
  }));
}

export function expectedCalibrationError(bins: Bin[]): number | null {
  const total = bins.reduce((s, b) => s + b.n, 0);
  if (total === 0) return null;
  return bins.reduce((s, b) => (b.n ? s + (b.n / total) * Math.abs((b.meanP as number) - (b.meanY as number)) : s), 0);
}

/** 1 - Brier / Brier(base rate). < 0 means worse than always predicting the base rate. */
export function brierSkillScore(preds: Prediction[]): number | null {
  const v = validPredictions(preds);
  const b = brierScore(v);
  if (b === null) return null;
  const base = v.reduce((s, x) => s + yv(x.y), 0) / v.length;
  const ref = base * (1 - base);
  if (ref === 0) return null;
  return 1 - b / ref;
}

export type PredictorStatus = "insufficient_data" | "ok" | "demote";

export interface PredictorAssessment {
  n: number; brier: number | null; ece: number | null; skill: number | null;
  status: PredictorStatus; /** multiplier applied to the predictor's influence on decisions */ weight: number;
}

export function assessPredictor(preds: Prediction[], opts: { minN?: number; maxEce?: number } = {}): PredictorAssessment {
  const minN = opts.minN ?? DEFAULT_MIN_N;
  const maxEce = opts.maxEce ?? DEFAULT_MAX_ECE;
  const v = validPredictions(preds);
  const n = v.length;
  const brier = brierScore(v);
  const ece = expectedCalibrationError(reliabilityBins(v));
  const skill = brierSkillScore(v);
  // Low data never demotes and never earns trust beyond the default weight.
  if (n < minN) return { n, brier, ece, skill, status: "insufficient_data", weight: 1 };
  const bad = (ece !== null && ece > maxEce) || (skill !== null && skill < 0);
  return { n, brier, ece, skill, status: bad ? "demote" : "ok", weight: bad ? 0 : 1 };
}

export interface DriftResult { drifted: boolean; eceDelta: number | null; brierDelta: number | null }

export function calibrationDrift(prior: Prediction[], recent: Prediction[], opts: { minN?: number; eceDelta?: number } = {}): DriftResult {
  const minN = opts.minN ?? DEFAULT_MIN_N;
  const thr = opts.eceDelta ?? DEFAULT_DRIFT_ECE_DELTA;
  const p = validPredictions(prior), r = validPredictions(recent);
  if (p.length < minN || r.length < minN) return { drifted: false, eceDelta: null, brierDelta: null };
  const e0 = expectedCalibrationError(reliabilityBins(p)) as number;
  const e1 = expectedCalibrationError(reliabilityBins(r)) as number;
  const b0 = brierScore(p) as number, b1 = brierScore(r) as number;
  return { drifted: e1 - e0 > thr, eceDelta: e1 - e0, brierDelta: b1 - b0 };
}
