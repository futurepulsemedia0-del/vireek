// supabase/functions/_shared/ai-core/jobAutopsyAnalysis.ts
//
// Job Autopsy narrative layer. Every fact in JobAutopsyContext is already
// computed server-side (job_autopsy_candidates view) — this file never
// re-detects or recomputes cost/schedule facts. It only reasons about WHY
// a completed job's actual cost diverged from what the Price Book says it
// should have cost, and what to do about it next time.

import { askVireekAi } from "./index.ts";

export type JobAutopsyCategory =
  | "extra_travel"
  | "misdiagnosis"
  | "missing_part"
  | "customer_delay"
  | "technician_rework"
  | "scope_change"
  | "other";

const VALID_CATEGORIES: JobAutopsyCategory[] = [
  "extra_travel", "misdiagnosis", "missing_part", "customer_delay",
  "technician_rework", "scope_change", "other",
];

export interface JobAutopsyRootCause {
  category: JobAutopsyCategory;
  pct: number;
  evidence: string;
}

export interface JobAutopsyContext {
  service_type: string | null;
  technician_diagnosis: string | null;
  expected_cost_cents: number;
  actual_cost_cents: number;
  variance_cents: number;
  variance_pct: number | null;
  duration_minutes: number;
  reschedule_count: number;
  schedule_shift_hours: number;
  parts_backordered_count: number;
  is_rework: boolean;
}

export interface JobAutopsyResult {
  root_causes: JobAutopsyRootCause[];
  ai_summary: string;
  counterfactual_summary: string;
  recommended_prevention_action: string;
  estimated_recoverable_pct: number;
  confidence: "low" | "medium" | "high";
}

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return fallback;
  return Math.round(Math.max(min, Math.min(max, num)));
}

/** Rescales pct values so they sum to exactly 100, preserving relative weight. */
function normalizeRootCauses(raw: unknown): JobAutopsyRootCause[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const cleaned = raw
    .slice(0, 4)
    .map((r) => {
      const item = r as Record<string, unknown>;
      const category = VALID_CATEGORIES.includes(item.category as JobAutopsyCategory)
        ? (item.category as JobAutopsyCategory)
        : "other";
      const pct = clampInt(item.pct, 1, 100, 1);
      const evidence = typeof item.evidence === "string" ? item.evidence.slice(0, 200) : "";
      return { category, pct, evidence };
    })
    .filter((r) => r.pct > 0);

  if (cleaned.length === 0) return [];

  const total = cleaned.reduce((sum, r) => sum + r.pct, 0);
  if (total === 100) return cleaned;

  const scaled = cleaned.map((r) => ({ ...r, pct: Math.round((r.pct / total) * 100) }));
  const scaledTotal = scaled.reduce((sum, r) => sum + r.pct, 0);
  scaled[0].pct += 100 - scaledTotal; // fold rounding drift into the largest driver
  return scaled;
}

export async function analyzeJobAutopsy(
  ctx: JobAutopsyContext,
): Promise<JobAutopsyResult | null> {
  try {
    const result = await askVireekAi({
      task: "job_autopsy",
      jsonMode: true,
      maxTokens: 650,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: `Every fact below is ground truth, already computed server-side from this one completed job:\n${JSON.stringify(ctx, null, 2)}`,
        },
      ],
    });

    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    const root_causes = normalizeRootCauses(parsed.root_causes);

    if (
      root_causes.length === 0 ||
      typeof parsed.ai_summary !== "string" ||
      typeof parsed.counterfactual_summary !== "string" ||
      typeof parsed.recommended_prevention_action !== "string"
    ) {
      return null;
    }

    const confidence = ["low", "medium", "high"].includes(parsed.confidence as string)
      ? (parsed.confidence as "low" | "medium" | "high")
      : "low";

    return {
      root_causes,
      ai_summary: parsed.ai_summary.slice(0, 600),
      counterfactual_summary: parsed.counterfactual_summary.slice(0, 400),
      recommended_prevention_action: parsed.recommended_prevention_action.slice(0, 400),
      estimated_recoverable_pct: clampInt(parsed.estimated_recoverable_pct, 0, 100, 0),
      confidence,
    };
  } catch {
    return null;
  }
}
