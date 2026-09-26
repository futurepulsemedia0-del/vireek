// supabase/functions/_shared/ai-core/businessScientist.ts
//
// Autonomous Business Scientist — hypothesis drafting only. Turns one
// already-grounded problem (an unactioned row from business_decisions,
// itself computed from real account metrics) into a plain-English,
// falsifiable hypothesis and a proposed intervention. This file NEVER
// touches the database and NEVER decides anything — it only reasons over
// a single problem it's handed and returns one validated, clamped object
// (or null). Simulation, the experiment result, and the rollout decision
// are all deterministic arithmetic in src/lib/businessScientist.ts —
// the model never sees or influences any of that.

import { askVireekAi } from "./index.ts";

export interface ScientistProblem {
  title: string;
  category: string;
  reasoning: string;
  recommended_action: string;
  estimated_impact: number;
}

export interface ScientistHypothesis {
  hypothesis: string;
  proposed_intervention: string;
  predicted_metric: string;
  predicted_direction: "increase" | "decrease";
  predicted_magnitude_pct: number;
  confidence_score: number; // 0-100
}

function clampScore(n: unknown): number {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return 50;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function clampMagnitude(n: unknown): number {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(200, Math.round(num * 10) / 10));
}

/**
 * `problem` must come straight from a `business_decisions` row (see
 * business-scientist-cycle/index.ts) — never raw, unvalidated input.
 */
export async function generateHypothesis(
  problem: ScientistProblem,
): Promise<ScientistHypothesis | null> {
  try {
    const result = await askVireekAi({
      task: "business_scientist_hypothesis",
      jsonMode: true,
      maxTokens: 500,
      temperature: 0.4,
      messages: [
        {
          role: "user",
          content:
            `A problem already identified from this business's own account metrics — treat every fact as ground truth; never contradict it:\n${JSON.stringify(problem, null, 2)}`,
        },
      ],
    });

    const parsed = JSON.parse(result.text) as Record<string, unknown>;

    const direction = parsed.predicted_direction === "increase" || parsed.predicted_direction === "decrease"
      ? (parsed.predicted_direction as "increase" | "decrease")
      : null;

    if (
      !direction ||
      typeof parsed.hypothesis !== "string" ||
      typeof parsed.proposed_intervention !== "string" ||
      typeof parsed.predicted_metric !== "string"
    ) {
      return null;
    }

    return {
      hypothesis: parsed.hypothesis.slice(0, 500),
      proposed_intervention: parsed.proposed_intervention.slice(0, 300),
      predicted_metric: parsed.predicted_metric.slice(0, 120),
      predicted_direction: direction,
      predicted_magnitude_pct: clampMagnitude(parsed.predicted_magnitude_pct),
      confidence_score: clampScore(parsed.confidence_score),
    };
  } catch {
    // AI unavailable or malformed output — degrade to nothing rather than
    // surfacing a broken/hallucinated hypothesis.
    return null;
  }
}
