// supabase/functions/_shared/ai-core/callbackRootCauseAnalysis.ts
//
// Callback root-cause narrative layer. The "is this a callback" detection
// is already ground truth server-side (jobs.is_rework / rework_of_job_id,
// 20260923000000_rework_intelligence.sql) — this file never re-detects
// that. It only reasons, from facts fetched under RLS by the calling edge
// function, about WHY the callback happened and what to do about it.
// Never invents facts not present in the given context.

import { askVireekAi } from "./index.ts";

export type RootCauseCategory =
  | "misdiagnosis"
  | "incomplete_repair"
  | "defective_part"
  | "wrong_part_installed"
  | "installation_error"
  | "missed_related_issue"
  | "customer_misuse"
  | "pre_existing_unrelated"
  | "unknown";

const VALID_CATEGORIES: RootCauseCategory[] = [
  "misdiagnosis",
  "incomplete_repair",
  "defective_part",
  "wrong_part_installed",
  "installation_error",
  "missed_related_issue",
  "customer_misuse",
  "pre_existing_unrelated",
  "unknown",
];

export interface CallbackRootCauseContext {
  callback_job: { service_type: string | null; diagnosis: string | null };
  original_job: { service_type: string | null; diagnosis: string | null };
  technician_name: string | null;
  equipment: { type: string | null; make: string | null; model: string | null }[];
  parts_installed_on_original_visit: { name: string | null; part_number: string | null; category: string | null }[];
}

export interface CallbackRootCauseResult {
  root_cause_category: RootCauseCategory;
  confidence: number;
  ai_summary: string;
  recommended_prevention_action: string;
}

function clampConfidence(n: unknown): number {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return 0.3;
  return Math.round(Math.max(0, Math.min(1, num)) * 100) / 100;
}

export async function analyzeCallbackRootCause(
  ctx: CallbackRootCauseContext,
): Promise<CallbackRootCauseResult | null> {
  try {
    const result = await askVireekAi({
      task: "callback_root_cause",
      jsonMode: true,
      maxTokens: 500,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: `Callback pairing already confirmed server-side (jobs.is_rework). Analyze this ONE pairing — every field below is ground truth, fetched under RLS:\n${JSON.stringify(ctx, null, 2)}`,
        },
      ],
    });

    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    const category = VALID_CATEGORIES.includes(parsed.root_cause_category as RootCauseCategory)
      ? (parsed.root_cause_category as RootCauseCategory)
      : "unknown";

    if (typeof parsed.ai_summary !== "string" || typeof parsed.recommended_prevention_action !== "string") {
      return null;
    }

    return {
      root_cause_category: category,
      confidence: clampConfidence(parsed.confidence),
      ai_summary: parsed.ai_summary.slice(0, 600),
      recommended_prevention_action: parsed.recommended_prevention_action.slice(0, 400),
    };
  } catch {
    return null;
  }
}
