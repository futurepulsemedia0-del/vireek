// supabase/functions/_shared/ai-core/regionalDemandNarrative.ts
//
// Regional Demand Intelligence narrative layer. Combines the caller's
// OWN already-computed local demand numbers (their own data, computed
// client-side) with the anonymized regional snapshot row they're
// entitled to see (sample_size >= 5, enforced by RLS before this ever
// runs) into 1-3 grounded, explainable insights.

import { askVireekAi } from "./index.ts";

export interface RegionalDemandInsight {
  title: string;
  description: string;
  recommended_action: string;
  priority: number; // 1-5
}

function clampPriority(n: unknown): number {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return 3;
  return Math.max(1, Math.min(5, Math.round(num)));
}

export async function analyzeRegionalDemand(
  metrics: Record<string, unknown>,
): Promise<RegionalDemandInsight[]> {
  if (!metrics || Object.keys(metrics).length === 0) return [];

  try {
    const result = await askVireekAi({
      task: "regional_demand_narrative",
      jsonMode: true,
      maxTokens: 700,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content: `Data comparing this business's own local demand to the anonymized aggregate of similar businesses in the same self-reported service area — treat every number as ground truth:\n${JSON.stringify(metrics, null, 2)}`,
        },
      ],
    });

    const parsed = JSON.parse(result.text);
    const rawList: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { insights?: unknown[] })?.insights)
      ? (parsed as { insights: unknown[] }).insights
      : [];

    const insights: RegionalDemandInsight[] = [];
    for (const item of rawList) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;
      if (typeof d.title !== "string" || typeof d.description !== "string" || typeof d.recommended_action !== "string") continue;
      insights.push({
        title: d.title.slice(0, 140),
        description: d.description.slice(0, 400),
        recommended_action: d.recommended_action.slice(0, 300),
        priority: clampPriority(d.priority),
      });
    }
    return insights.sort((a, b) => b.priority - a.priority).slice(0, 3);
  } catch {
    return [];
  }
}
