// supabase/functions/_shared/ai-core/nextBestActions.ts
//
// Proactive Customer Care / Next Best Action Engine — advisory ranking
// layer. Turns already-computed, ground-truth candidate rows (an estimate
// at risk, a customer at risk of churn, an overdue invoice, an open
// capacity day) into a short, prioritized, human-written action list via
// the shared Vireek AI router. This file NEVER touches the database and
// can only select/rank/re-word candidates it's handed — it validates every
// returned id against the real candidate list, so it can't hallucinate a
// new one.

import { askVireekAi } from "./index.ts";

export type NextBestActionCategory = "estimate_risk" | "invoice_risk" | "churn_risk" | "capacity_gap";

export interface NextBestActionCandidate {
  id: string;
  category: NextBestActionCategory;
  entity_type: "quote" | "customer" | "invoice" | null;
  entity_id: string | null;
  entity_label: string;
  amount_label: string | null;
  detail: string;
  cta_href: string;
}

export interface RankedNextBestAction {
  candidate_id: string;
  title: string;
  reasoning: string;
  recommended_action: string;
  priority_score: number;
}

function clampScore(n: unknown): number {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return 50;
  return Math.max(0, Math.min(100, Math.round(num)));
}

/**
 * `candidates` must already be real, deterministic rows (see
 * next-best-actions/index.ts) — never raw/unvalidated data.
 */
export async function rankNextBestActions(
  candidates: NextBestActionCandidate[],
): Promise<RankedNextBestAction[]> {
  if (candidates.length === 0) return [];

  try {
    const slim = candidates.map(({ id, category, entity_label, amount_label, detail }) => ({
      id, category, entity_label, amount_label, detail,
    }));

    const result = await askVireekAi({
      task: "next_best_action_engine",
      jsonMode: true,
      maxTokens: 1200,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content: `Candidates computed directly from the database — treat every id/amount/fact as ground truth; never invent a new one:\n${JSON.stringify(slim, null, 2)}`,
        },
      ],
    });

    const parsed = JSON.parse(result.text);
    const rawList: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { actions?: unknown[] })?.actions)
      ? (parsed as { actions: unknown[] }).actions
      : [];

    const validIds = new Set(candidates.map((c) => c.id));
    const seen = new Set<string>();
    const out: RankedNextBestAction[] = [];

    for (const item of rawList) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;
      if (typeof d.candidate_id !== "string" || !validIds.has(d.candidate_id) || seen.has(d.candidate_id)) continue;
      if (typeof d.title !== "string" || typeof d.reasoning !== "string" || typeof d.recommended_action !== "string") continue;

      seen.add(d.candidate_id);
      out.push({
        candidate_id: d.candidate_id,
        title: d.title.slice(0, 140),
        reasoning: d.reasoning.slice(0, 400),
        recommended_action: d.recommended_action.slice(0, 260),
        priority_score: clampScore(d.priority_score),
      });
    }

    return out.sort((a, b) => b.priority_score - a.priority_score).slice(0, 8);
  } catch {
    // AI unavailable or malformed output — degrade to nothing rather than
    // surfacing a broken/hallucinated action.
    return [];
  }
}
