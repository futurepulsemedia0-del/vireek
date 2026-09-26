// supabase/functions/_shared/ai-core/identityLearner.ts
//
// Continual Identity Learner — narration layer ONLY. Every number this
// file is given (baseline_value, recent_value, sample counts) was
// already computed deterministically from real logged decisions in
// identity-signal-scan/index.ts. This file never decides THAT a drift
// happened — it only turns an already-detected drift into a plain-
// language explanation for the business owner, grounded in the exact
// observation notes it's handed.

import { askVireekAi } from "./index.ts";

export type IdentityDimension =
  | "growth_vs_stability"
  | "risk_tolerance"
  | "price_position"
  | "automation_trust"
  | "speed_vs_quality";

const DIMENSION_LABELS: Record<IdentityDimension, { low: string; high: string }> = {
  growth_vs_stability: { low: "stability-focused", high: "growth-focused" },
  risk_tolerance: { low: "risk-averse", high: "risk-seeking" },
  price_position: { low: "value/discount-positioned", high: "premium-positioned" },
  automation_trust: { low: "hands-on / low automation trust", high: "delegates heavily to automation" },
  speed_vs_quality: { low: "quality-first / deliberate", high: "speed-first / fast-moving" },
};

export interface DriftNarrationInput {
  dimension: IdentityDimension;
  baseline_value: number; // -100..100, older window
  recent_value: number; // -100..100, newer window
  baseline_samples: number;
  recent_samples: number;
  example_notes: string[]; // real, deterministic notes behind the recent signals
}

export interface DriftNarrationResult {
  title: string;
  summary: string;
}

export async function narrateIdentityDrift(input: DriftNarrationInput): Promise<DriftNarrationResult> {
  const labels = DIMENSION_LABELS[input.dimension];
  const fallback: DriftNarrationResult = {
    title: `Shift detected: ${input.dimension.replace(/_/g, " ")}`,
    summary: `Your recent decisions (${input.recent_samples} observed) lean more ${input.recent_value >= 0 ? labels.high : labels.low} than your established baseline (${input.baseline_samples} observed), a shift of ${Math.abs(Math.round(input.recent_value - input.baseline_value))} points.`,
  };

  try {
    const result = await askVireekAi({
      task: "continual_identity_learner",
      jsonMode: true,
      maxTokens: 500,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            dimension: input.dimension,
            low_end_meaning: labels.low,
            high_end_meaning: labels.high,
            baseline_value: input.baseline_value,
            recent_value: input.recent_value,
            baseline_sample_count: input.baseline_samples,
            recent_sample_count: input.recent_samples,
            real_examples_behind_the_recent_signal: input.example_notes,
          }, null, 2),
        },
      ],
    });

    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    const title = typeof parsed.title === "string" ? parsed.title.slice(0, 100) : fallback.title;
    const summary = typeof parsed.summary === "string" ? parsed.summary.slice(0, 500) : fallback.summary;
    return { title, summary };
  } catch {
    return fallback;
  }
}
