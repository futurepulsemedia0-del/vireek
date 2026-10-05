// supabase/functions/_shared/ai-core/fieldScientist.ts
//
// AI Field Scientist — candidate-cause drafting ONLY. The model receives one
// statistically-validated finding (computed deterministically client-side in
// src/lib/fieldScientist.ts) and proposes (a) plausible causal mechanisms and
// (b) a job-level intervention that could be randomised to test each one.
// It NEVER touches the database and NEVER sees or decides a p-value, a sample
// size, an arm assignment or a verdict.

import { askVireekAi } from "./index.ts";

export interface FieldFinding {
  statement: string;
  segment_dimension: string;
  segment_label: string;
  direction: "worse" | "better";
  outcome_metric: string;
  segment_rate_pct: number;
  comparison_rate_pct: number;
  segment_jobs: number;
  adjusted_for_service_mix: boolean;
  drilldown: Array<{ dimension: string; key: string; segment_rate_pct: number; others_rate_pct: number; n: number }>;
  available_data: string[];
}

export interface CandidateCause {
  id: string;
  label: string;
  mechanism: string;
  intervention: string;
  priority: number; // 0-100
}

const clip = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function generateCandidateCauses(finding: FieldFinding): Promise<CandidateCause[] | null> {
  try {
    const result = await askVireekAi({
      task: "field_scientist_causes",
      jsonMode: true,
      maxTokens: 800,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content: `A statistically validated finding from this business's own job data — treat every number as ground truth and never contradict it:\n${JSON.stringify(finding, null, 2)}`,
        },
      ],
    });

    const parsed = JSON.parse(result.text) as { causes?: unknown };
    if (!Array.isArray(parsed.causes)) return null;

    const causes: CandidateCause[] = [];
    for (const raw of parsed.causes.slice(0, 5)) {
      const c = raw as Record<string, unknown>;
      const label = clip(c.label, 80);
      const mechanism = clip(c.mechanism, 280);
      const intervention = clip(c.intervention, 280);
      if (!label || !mechanism || !intervention) continue;
      const p = typeof c.priority === "number" ? c.priority : Number(c.priority);
      causes.push({
        id: `c${causes.length + 1}`,
        label,
        mechanism,
        intervention,
        priority: Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : 50,
      });
    }
    if (causes.length < 2) return null;
    return causes.sort((a, b) => b.priority - a.priority).map((c, i) => ({ ...c, id: `c${i + 1}` }));
  } catch {
    // AI unavailable or malformed output: degrade to nothing, never a made-up cause.
    return null;
  }
}
