// supabase/functions/_shared/ai-core/causalSimulator.ts
//
// Causal World Simulator — reasoning layer. Turns an owner's proposed
// decision, their own ground-truth metrics, and (when available) a
// k-anonymous cohort of OTHER accounts' measured real outcomes into a
// counterfactual explanation. This file NEVER touches the database and
// NEVER invents a statistic — every number it is allowed to state was
// already computed deterministically and handed to it; when no cohort
// exists it is instructed to say so plainly instead of guessing.

import { askVireekAi } from "./index.ts";

export interface CausalFactor {
  factor: string;
  direction: "positive" | "negative" | "uncertain";
  explanation: string;
}

export interface CausalAnalysisResult {
  predicted_impact_pct: number;
  predicted_confidence: number; // 0-100
  timeframe_days: number;
  causal_factors: CausalFactor[];
  risk_factors: string[];
  counterfactual_narrative: string;
}

export interface CausalAnalysisInput {
  decision_category: string;
  decision_description: string;
  own_metrics: Record<string, unknown>;
  cohort: {
    available: boolean;
    sample_size: number;
    success_rate: number | null;
    avg_impact_pct: number | null;
    median_impact_pct: number | null;
    p25_impact_pct: number | null;
    p75_impact_pct: number | null;
  };
}

const DIRECTIONS = new Set(["positive", "negative", "uncertain"]);

function clampConfidence(n: unknown, cohortAvailable: boolean): number {
  const num = typeof n === "number" ? n : Number(n);
  const safe = Number.isFinite(num) ? num : 40;
  // Without a real cohort this is qualitative AI reasoning only —
  // never let it present itself as more than moderately confident.
  const ceiling = cohortAvailable ? 95 : 60;
  return Math.max(5, Math.min(ceiling, Math.round(safe)));
}

function clampImpact(n: unknown): number {
  const num = typeof n === "number" ? n : Number(n);
  return Number.isFinite(num) ? Math.max(-95, Math.min(300, Math.round(num * 100) / 100)) : 0;
}

function clampTimeframe(n: unknown): number {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return 30;
  return Math.max(14, Math.min(120, Math.round(num)));
}

export async function analyzeCausalScenario(
  input: CausalAnalysisInput,
): Promise<CausalAnalysisResult> {
  const fallback: CausalAnalysisResult = {
    predicted_impact_pct: 0,
    predicted_confidence: 20,
    timeframe_days: 30,
    causal_factors: [],
    risk_factors: ["Not enough data to reason about this decision confidently yet."],
    counterfactual_narrative:
      "There isn't enough ground-truth data yet to simulate this scenario reliably. Try again once more of your own activity has accumulated.",
  };

  try {
    const result = await askVireekAi({
      task: "causal_world_simulator",
      jsonMode: true,
      maxTokens: 1400,
      temperature: 0.35,
      messages: [
        {
          role: "user",
          content: JSON.stringify(
            {
              decision_category: input.decision_category,
              decision_description: input.decision_description,
              own_account_metrics_ground_truth: input.own_metrics,
              anonymous_cohort_ground_truth: input.cohort.available
                ? {
                    distinct_businesses_who_made_this_kind_of_decision: input.cohort.sample_size,
                    pct_where_outcome_was_positive: input.cohort.success_rate,
                    average_measured_impact_pct: input.cohort.avg_impact_pct,
                    median_measured_impact_pct: input.cohort.median_impact_pct,
                    p25_measured_impact_pct: input.cohort.p25_impact_pct,
                    p75_measured_impact_pct: input.cohort.p75_impact_pct,
                  }
                : "no_cohort_data_available_for_this_category_yet",
            },
            null,
            2,
          ),
        },
      ],
    });

    const parsed = JSON.parse(result.text) as Record<string, unknown>;

    const rawFactors = Array.isArray(parsed.causal_factors) ? parsed.causal_factors : [];
    const causal_factors: CausalFactor[] = [];
    for (const item of rawFactors) {
      if (!item || typeof item !== "object") continue;
      const f = item as Record<string, unknown>;
      if (typeof f.factor !== "string" || typeof f.explanation !== "string") continue;
      const direction = typeof f.direction === "string" && DIRECTIONS.has(f.direction)
        ? (f.direction as CausalFactor["direction"])
        : "uncertain";
      causal_factors.push({
        factor: f.factor.slice(0, 120),
        direction,
        explanation: f.explanation.slice(0, 300),
      });
    }

    const risk_factors = (Array.isArray(parsed.risk_factors) ? parsed.risk_factors : [])
      .filter((r): r is string => typeof r === "string")
      .map((r) => r.slice(0, 200))
      .slice(0, 6);

    const counterfactual_narrative =
      typeof parsed.counterfactual_narrative === "string"
        ? parsed.counterfactual_narrative.slice(0, 900)
        : fallback.counterfactual_narrative;

    return {
      predicted_impact_pct: clampImpact(parsed.predicted_impact_pct),
      predicted_confidence: clampConfidence(parsed.predicted_confidence, input.cohort.available),
      timeframe_days: clampTimeframe(parsed.timeframe_days),
      causal_factors: causal_factors.slice(0, 6),
      risk_factors,
      counterfactual_narrative,
    };
  } catch {
    // AI unavailable or malformed output — degrade to an honest "not
    // enough signal" answer rather than surfacing a hallucinated one.
    return fallback;
  }
}
