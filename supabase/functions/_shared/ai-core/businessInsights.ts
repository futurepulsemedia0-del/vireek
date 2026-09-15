// supabase/functions/_shared/ai-core/businessInsights.ts
//
// Real AI Insights: turns already-computed, ground-truth account metrics
// (missed-call rate, stalled pipeline, usage %, unsent invoices, etc.)
// into prioritized, narrative business insights via the shared Vireek AI
// router — instead of the old fixed if/else template strings.
//
// Deliberately split from the caller: this file never touches the
// database or does the arithmetic itself. It only reasons over numbers
// it's handed, so the model can never hallucinate a statistic — it can
// only misinterpret real ones, which is why every returned insight is
// still validated/clamped below before it ever reaches storage.

import { askVireekAi } from "./index.ts";

export interface BusinessInsight {
  insight_type: "pattern" | "suggestion" | "alert";
  title: string;
  description: string;
  recommended_action: string | null;
  priority: number; // 1 (minor) – 5 (urgent)
}

const VALID_TYPE = new Set(["pattern", "suggestion", "alert"]);

function clampPriority(n: unknown): number {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return 3;
  return Math.max(1, Math.min(5, Math.round(num)));
}

/**
 * `metrics` should be a plain JSON-serializable object of already-computed
 * facts (see generate-insights/index.ts for what it sends) — never raw
 * transcripts or unbounded data, so token cost stays small and predictable.
 */
export async function analyzeBusinessInsights(
  metrics: Record<string, unknown>,
): Promise<BusinessInsight[]> {
  if (!metrics || Object.keys(metrics).length === 0) return [];

  try {
    const result = await askVireekAi({
      task: "business_insights",
      jsonMode: true,
      maxTokens: 900,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content:
            `Account metrics for the last 30 days, computed directly from the database — treat every number here as ground truth; never recompute, round differently, or contradict them:\n${JSON.stringify(metrics, null, 2)}`,
        },
      ],
    });

    const parsed = JSON.parse(result.text);
    const rawList: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { insights?: unknown[] })?.insights)
        ? (parsed as { insights: unknown[] }).insights
        : [];

    return rawList
      .filter((i): i is Record<string, unknown> => {
        return (
          typeof i === "object" &&
          i !== null &&
          typeof (i as Record<string, unknown>).title === "string" &&
          typeof (i as Record<string, unknown>).description === "string"
        );
      })
      .slice(0, 4)
      .map((i) => ({
        insight_type: VALID_TYPE.has(i.insight_type as string)
          ? (i.insight_type as BusinessInsight["insight_type"])
          : "suggestion",
        title: String(i.title).slice(0, 200),
        description: String(i.description).slice(0, 800),
        recommended_action:
          typeof i.recommended_action === "string" ? i.recommended_action.slice(0, 400) : null,
        priority: clampPriority(i.priority),
      }))
      .sort((a, b) => b.priority - a.priority);
  } catch (err) {
    console.error("analyzeBusinessInsights failed:", err);
    return []; // caller falls back to its own rule-based insights
  }
}
