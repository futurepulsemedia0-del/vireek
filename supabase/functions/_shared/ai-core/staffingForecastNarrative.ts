// supabase/functions/_shared/ai-core/staffingForecastNarrative.ts
//
// Narrative layer for the Staffing Forecast. The numbers and recommendations are produced by the
// deterministic engine (_shared/staffing-forecast/engine.ts). This file only explains them in plain
// language — it never invents or changes a number. Mirrors capacityDemandNarrative.ts.

import { askVireekAi } from "./index.ts";

export interface StaffingInsight {
  title: string;
  description: string;
  recommended_action: string;
  priority: number; // 1-5
}

function clampPriority(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 3;
  return Math.max(1, Math.min(5, Math.round(v)));
}

export async function narrateStaffingForecast(summary: Record<string, unknown>): Promise<StaffingInsight[]> {
  if (!summary || Object.keys(summary).length === 0) return [];
  try {
    const result = await askVireekAi({
      task: "staffing_forecast_narrative",
      jsonMode: true,
      maxTokens: 700,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content: `This business's own staffing forecast, already computed server-side — treat every number as ground truth:\n${JSON.stringify(summary, null, 2)}`,
        },
      ],
    });
    const parsed = JSON.parse(result.text);
    const list: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { insights?: unknown[] })?.insights)
      ? (parsed as { insights: unknown[] }).insights
      : [];
    const out: StaffingInsight[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;
      if (typeof d.title !== "string" || typeof d.description !== "string" || typeof d.recommended_action !== "string") continue;
      out.push({
        title: d.title.slice(0, 140),
        description: d.description.slice(0, 400),
        recommended_action: d.recommended_action.slice(0, 300),
        priority: clampPriority(d.priority),
      });
    }
    return out.sort((a, b) => b.priority - a.priority).slice(0, 3);
  } catch {
    return [];
  }
}
