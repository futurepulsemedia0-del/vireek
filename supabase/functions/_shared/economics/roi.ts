// supabase/functions/_shared/economics/roi.ts
//
// Conservative, auditable customer ROI. Pure and import-free.
// Rules (each exclusion is counted and reported, never silently dropped):
//  - outcome recorded BEFORE the action that supposedly caused it  -> excluded (no credit for the past)
//  - confidence below `minConfidence`                              -> excluded (unattributable)
//  - negative values are kept (they reduce value)
//  - low  = sum(value x confidence); high = sum(value)  over INCLUDED outcomes (range, not a point estimate)
//  - fewer than `minOutcomes` included outcomes, or no known plan cost -> "not_enough_data" (no number)

export interface AttributedOutcome {
  id: string; // traceable input id (e.g. agent_action_outcomes.id)
  actionAt: string; // ISO
  outcomeAt: string; // ISO
  valueCents: number; // signed integer cents
  confidence: number; // 0..1
  rule: string; // attribution rule name, shown to the customer
}
export interface RoiConfig { minOutcomes: number; minConfidence: number }
export const DEFAULT_ROI: RoiConfig = { minOutcomes: 5, minConfidence: 0.6 };

export type RoiResult =
  | { status: "not_enough_data"; reason: string; included: number; excluded: Record<string, number> }
  | {
      status: "ok"; included: number; excluded: Record<string, number>;
      valueCentsLow: number; valueCentsHigh: number; planCostCents: number;
      roiLow: number; roiHigh: number; inputIds: string[]; rules: string[];
    };

export function computeRoi(outcomes: readonly AttributedOutcome[], planCostCents: number | null, cfg: RoiConfig = DEFAULT_ROI): RoiResult {
  const excluded: Record<string, number> = { preceded_action: 0, low_confidence: 0, invalid: 0 };
  const kept: AttributedOutcome[] = [];
  for (const o of outcomes) {
    const a = Date.parse(o.actionAt), b = Date.parse(o.outcomeAt);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isInteger(o.valueCents) || !(o.confidence >= 0 && o.confidence <= 1)) { excluded.invalid++; continue; }
    if (b < a) { excluded.preceded_action++; continue; }
    if (o.confidence < cfg.minConfidence) { excluded.low_confidence++; continue; }
    kept.push(o);
  }
  if (planCostCents === null || !(planCostCents > 0)) return { status: "not_enough_data", reason: "plan_cost_unknown", included: kept.length, excluded };
  if (kept.length < cfg.minOutcomes) return { status: "not_enough_data", reason: `outcomes(${kept.length})<${cfg.minOutcomes}`, included: kept.length, excluded };
  const high = kept.reduce((s, o) => s + o.valueCents, 0);
  const low = Math.round(kept.reduce((s, o) => s + o.valueCents * o.confidence, 0));
  return {
    status: "ok", included: kept.length, excluded,
    valueCentsLow: low, valueCentsHigh: high, planCostCents,
    roiLow: (low - planCostCents) / planCostCents, roiHigh: (high - planCostCents) / planCostCents,
    inputIds: kept.map((o) => o.id), rules: [...new Set(kept.map((o) => o.rule))].sort(),
  };
}
