// supabase/functions/_shared/ai-core/capacityDemandNarrative.ts
//
// Capacity-Based Demand Control narrative layer. The RULE-BASED decision
// (status: low/optimal/full/no_capacity, action_taken) is already computed
// and logged server-side by run_capacity_demand_control() in
// 20261111000000_capacity_demand_control.sql — this file only explains
// that decision in plain language and proposes concrete next steps. It
// never invents the status or the numbers; it only narrates them.

import { askVireekAi } from "./index.ts";

export interface CapacityDemandInsight {
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

export async function analyzeCapacityDemand(
  status: Record<string, unknown>,
): Promise<CapacityDemandInsight[]> {
  if (!status || Object.keys(status).length === 0) return [];

  try {
    const result = await askVireekAi({
      task: "capacity_demand_narrative",
      jsonMode: true,
      maxTokens: 600,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content: `This business's own capacity-vs-demand status for today, already computed server-side — treat every number as ground truth:\n${JSON.stringify(status, null, 2)}`,
        },
      ],
    });

    const parsed = JSON.parse(result.text);
    const rawList: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { insights?: unknown[] })?.insights)
      ? (parsed as { insights: unknown[] }).insights
      : [];

    const insights: CapacityDemandInsight[] = [];
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
