// supabase/functions/_shared/ai-core/businessDecisions.ts
//
// Autonomous Business Decision Engine — advisory layer. Turns already
// -computed, ground-truth account metrics into prioritized, categorized
// decisions via the shared Vireek AI router. This file NEVER touches the
// database and NEVER executes anything itself — it only reasons over
// numbers it's handed and returns a validated, clamped list. Any real
// autonomous execution (e.g. surge mode) is decided by deterministic
// rules elsewhere, never by raw model output.

import { askVireekAi } from "./index.ts";

export interface BusinessDecision {
  category: "pricing" | "dispatch" | "staffing" | "marketing" | "collections" | "retention" | "operations";
  title: string;
  reasoning: string;
  recommended_action: string;
  confidence_score: number; // 0-100
  estimated_impact: number; // dollars, 0 if not quantifiable
}

const VALID_CATEGORIES = new Set([
  "pricing", "dispatch", "staffing", "marketing", "collections", "retention", "operations",
]);

function clampScore(n: unknown): number {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return 50;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function clampImpact(n: unknown): number {
  const num = typeof n === "number" ? n : Number(n);
  return Number.isFinite(num) ? Math.max(0, Math.round(num * 100) / 100) : 0;
}

/**
 * `metrics` must be a plain JSON-serializable object of already-computed
 * facts (see business-decision-engine/index.ts) — never raw rows.
 */
export async function analyzeBusinessDecisions(
  metrics: Record<string, unknown>,
): Promise<BusinessDecision[]> {
  if (!metrics || Object.keys(metrics).length === 0) return [];

  try {
    const result = await askVireekAi({
      task: "business_decision_engine",
      jsonMode: true,
      maxTokens: 1100,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content:
            `Account metrics computed directly from the database — treat every number as ground truth; never recompute, round differently, or contradict them:\n${JSON.stringify(metrics, null, 2)}`,
        },
      ],
    });

    const parsed = JSON.parse(result.text);
    const rawList: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { decisions?: unknown[] })?.decisions)
      ? (parsed as { decisions: unknown[] }).decisions
      : [];

    const decisions: BusinessDecision[] = [];
    for (const item of rawList) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;
      const category = typeof d.category === "string" && VALID_CATEGORIES.has(d.category)
        ? (d.category as BusinessDecision["category"])
        : null;
      if (!category || typeof d.title !== "string" || typeof d.reasoning !== "string" || typeof d.recommended_action !== "string") {
        continue;
      }
      decisions.push({
        category,
        title: d.title.slice(0, 140),
        reasoning: d.reasoning.slice(0, 600),
        recommended_action: d.recommended_action.slice(0, 300),
        confidence_score: clampScore(d.confidence_score),
        estimated_impact: clampImpact(d.estimated_impact),
      });
    }

    return decisions.sort((a, b) => b.confidence_score - a.confidence_score).slice(0, 5);
  } catch {
    // AI unavailable or malformed output — degrade to nothing rather
    // than surfacing a broken/hallucinated decision.
    return [];
  }
}
