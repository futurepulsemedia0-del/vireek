// supabase/functions/_shared/ai-core/opportunityCostRanking.ts
//
// Opportunity Cost Ledger — ranking layer. Same contract as
// nextBestActions.ts: takes already-computed candidate entries (deterministic
// $ figures, never touched by AI), and only selects, ranks, and writes a
// short human explanation over what's given. Never invents a number,
// entry, technician, or customer.

import { askVireekAi } from "./index.ts";

export interface OpportunityCostCandidate {
  id: string;
  entry_type: string;
  headline: string;
  estimated_cost_cents: number;
  detail: Record<string, unknown>;
}

export interface RankedOpportunityCost {
  entry_id: string;
  narrative: string;
  recommended_action: string;
  priority_score: number;
}

function clampScore(n: unknown): number {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return 50;
  return Math.max(0, Math.min(100, Math.round(num)));
}

export async function rankOpportunityCosts(
  candidates: OpportunityCostCandidate[],
): Promise<RankedOpportunityCost[]> {
  if (candidates.length === 0) return [];

  try {
    const result = await askVireekAi({
      task: "opportunity_cost_ranking",
      jsonMode: true,
      maxTokens: 1200,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content: `Candidate opportunity-cost entries, already computed from real account data — treat every number as ground truth:\n${JSON.stringify(candidates, null, 2)}`,
        },
      ],
    });

    const parsed = JSON.parse(result.text);
    const rawList: unknown[] = Array.isArray(parsed) ? parsed : [];
    const validIds = new Set(candidates.map((c) => c.id));

    const ranked: RankedOpportunityCost[] = [];
    for (const item of rawList) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      if (typeof r.entry_id !== "string" || !validIds.has(r.entry_id)) continue;
      if (typeof r.narrative !== "string" || typeof r.recommended_action !== "string") continue;
      ranked.push({
        entry_id: r.entry_id,
        narrative: r.narrative.slice(0, 400),
        recommended_action: r.recommended_action.slice(0, 300),
        priority_score: clampScore(r.priority_score),
      });
    }
    return ranked.sort((a, b) => b.priority_score - a.priority_score);
  } catch {
    return [];
  }
}
