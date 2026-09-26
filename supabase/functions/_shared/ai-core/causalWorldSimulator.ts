// supabase/functions/_shared/ai-core/causalWorldSimulator.ts
//
// Business Digital Twin / Causal World Simulator — advisory layer.
// Baseline + projected numbers are computed server-side in the edge
// function BEFORE this runs; this only turns those numbers into a
// grounded narrative. Same contract as causalShockAnalysis.ts: never
// invents a number, degrades confidence gracefully with no cohort data.

import { askVireekAi } from "./index.ts";

export interface CausalFactor {
  factor: string;
  direction: "positive" | "negative" | "uncertain";
  explanation: string;
}

export interface WorldSimulationResult {
  predicted_impact_pct: number;
  predicted_confidence: number;
  timeframe_days: number;
  causal_factors: CausalFactor[];
  risk_factors: string[];
  counterfactual_narrative: string;
}

const VALID_DIRECTIONS = new Set(["positive", "negative", "uncertain"]);

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

export async function analyzeWorldSimulation(
  decisionLabel: string,
  baseline: Record<string, unknown>,
  projected: Record<string, unknown>,
  cohort: Record<string, unknown> | null,
): Promise<WorldSimulationResult> {
  const fallback: WorldSimulationResult = {
    predicted_impact_pct: 0,
    predicted_confidence: 0,
    timeframe_days: 30,
    causal_factors: [],
    risk_factors: [],
    counterfactual_narrative: "Not enough data to generate a prediction right now.",
  };

  try {
    const result = await askVireekAi({
      task: "causal_world_simulator",
      jsonMode: true,
      maxTokens: 900,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content:
            `Decision being considered: "${decisionLabel.slice(0, 300)}"\n\n` +
            `This business's own ground-truth account metrics (baseline, before the decision):\n${JSON.stringify(baseline, null, 2)}\n\n` +
            `Deterministically projected metrics (after the decision, computed server-side — treat as ground truth, never recompute or contradict):\n${JSON.stringify(projected, null, 2)}\n\n` +
            (cohort
              ? `Anonymized real-outcome statistics from other businesses who made a similar decision:\n${JSON.stringify(cohort, null, 2)}`
              : `No cohort data is available for this decision type yet.`),
        },
      ],
    });

    const parsed = JSON.parse(result.text) as Record<string, unknown>;

    const causal_factors: CausalFactor[] = (Array.isArray(parsed.causal_factors) ? parsed.causal_factors : [])
      .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
      .filter((f) => typeof f.factor === "string" && VALID_DIRECTIONS.has(String(f.direction)) && typeof f.explanation === "string")
      .slice(0, 6)
      .map((f) => ({
        factor: (f.factor as string).slice(0, 80),
        direction: f.direction as CausalFactor["direction"],
        explanation: (f.explanation as string).slice(0, 300),
      }));

    const risk_factors: string[] = (Array.isArray(parsed.risk_factors) ? parsed.risk_factors : [])
      .filter((r): r is string => typeof r === "string")
      .slice(0, 6)
      .map((r) => r.slice(0, 200));

    return {
      predicted_impact_pct: clamp(Number(parsed.predicted_impact_pct), -100, 500),
      predicted_confidence: clamp(Math.round(Number(parsed.predicted_confidence)), 0, 100),
      timeframe_days: clamp(Math.round(Number(parsed.timeframe_days) || 30), 14, 120),
      causal_factors,
      risk_factors,
      counterfactual_narrative:
        typeof parsed.counterfactual_narrative === "string"
          ? parsed.counterfactual_narrative.slice(0, 700)
          : fallback.counterfactual_narrative,
    };
  } catch {
    return fallback;
  }
}
