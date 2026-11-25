/**
 * Evidence grading and reporting rules for causal technician effects (pure).
 *
 * Nothing may be labelled above/below peers unless the 95% interval of the (shrunk) effect excludes zero AND the cell
 * has at least MIN_CELL_N set-member decisions AND at least MIN_EFFECTIVE_N effective weighted observations.
 * Grades use the SAME interval the UI shows (posterior SE after shrinkage), never the raw SE.
 */

import { OUTCOME_META, type OutcomeKey } from '../causalDispatch';
import { MIN_CELL_N } from '../stats/inference';

export { MIN_CELL_N };
/** Minimum Kish effective sample size of the inverse-propensity weights (see estimators.ts). */
export const MIN_EFFECTIVE_N = 20;
/** Benjamini–Hochberg level a grade-A cell must also meet (many cells are tested at once). */
export const GRADE_A_FDR = 0.05;
/** A cell is only reportable if its Benjamini–Hochberg q-value is at most this (cells are tested many at a time). */
export const REPORTABLE_FDR = 0.1;

export type EvidenceGrade = 'A' | 'B' | 'C';
export type EffectDirection = 'above_peers' | 'below_peers' | 'inconclusive';

export interface EvidenceInput {
  outcome: OutcomeKey;
  nSet: number;
  ess: number;
  shrunk: number;
  ciLow: number | null;
  ciHigh: number | null;
  fdrQ: number | null;
  /** Unshrunk interval. When given it must ALSO exclude zero in the same direction (shrunk intervals can undercover). */
  rawCiLow?: number | null;
  rawCiHigh?: number | null;
}

export interface Evidence {
  grade: EvidenceGrade;
  reportable: boolean;
  direction: EffectDirection;
  /** true/false only when reportable: is the direction good for the business on this outcome? */
  favourable: boolean | null;
  reasons: string[];
}

export function gradeEffect(i: EvidenceInput): Evidence {
  const reasons: string[] = [];
  const hasCi = i.ciLow !== null && i.ciHigh !== null && Number.isFinite(i.ciLow) && Number.isFinite(i.ciHigh);
  const excludesZero = hasCi && ((i.ciLow as number) > 0 || (i.ciHigh as number) < 0);
  if (i.nSet < MIN_CELL_N) reasons.push(`only ${i.nSet} decisions (need ${MIN_CELL_N})`);
  if (i.ess < MIN_EFFECTIVE_N) reasons.push(`effective sample ${i.ess.toFixed(1)} (need ${MIN_EFFECTIVE_N})`);
  if (!excludesZero) reasons.push('interval includes zero');
  if (i.rawCiLow !== undefined && i.rawCiHigh !== undefined) {
    const rawOk = i.rawCiLow !== null && i.rawCiHigh !== null && ((i.rawCiLow > 0 && i.shrunk > 0) || (i.rawCiHigh < 0 && i.shrunk < 0));
    if (excludesZero && !rawOk) reasons.push('unshrunk interval includes zero');
  }
  if (i.fdrQ === null || i.fdrQ > REPORTABLE_FDR) reasons.push('not significant after multiple-comparison control');
  const reportable = reasons.length === 0;
  if (!reportable) return { grade: 'C', reportable: false, direction: 'inconclusive', favourable: null, reasons };

  const half = ((i.ciHigh as number) - (i.ciLow as number)) / 2;
  const precise = OUTCOME_META[i.outcome].unit === 'proportion' ? half <= 0.15 : half <= 15;
  const strong = i.nSet >= 2 * MIN_CELL_N && i.ess >= 2 * MIN_EFFECTIVE_N && precise && i.fdrQ !== null && i.fdrQ <= GRADE_A_FDR;
  const direction: EffectDirection = i.shrunk > 0 ? 'above_peers' : 'below_peers';
  const favourable = OUTCOME_META[i.outcome].higherIsBetter ? i.shrunk > 0 : i.shrunk < 0;
  return { grade: strong ? 'A' : 'B', reportable: true, direction, favourable, reasons: [] };
}

/** Benjamini–Hochberg adjusted p-values (q-values). null in => null out. Order is preserved. */
export function benjaminiHochberg(p: (number | null)[]): (number | null)[] {
  const idx = p.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => x.v !== null && Number.isFinite(x.v)).sort((a, b) => a.v - b.v);
  const m = idx.length;
  const q: (number | null)[] = p.map(() => null);
  let running = 1;
  for (let r = m; r >= 1; r--) {
    const { v, i } = idx[r - 1];
    running = Math.min(running, (v * m) / r);
    q[i] = Math.min(1, running);
  }
  return q;
}
