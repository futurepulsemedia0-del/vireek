// supabase/functions/_shared/ai-core/businessDriftNarrative.ts
//
// Business Drift Detector — narrative layer. Every flagged signal below
// is already a computed, ground-truth number (recent vs baseline). This
// file only explains WHY the combination matters and what to do about
// it — never invents a metric, never flags something itself.

import { askVireekAi } from "./index.ts";

export interface DriftMetricInput {
  metric: string;
  recent: number;
  baseline: number;
  pct_change: number;
  unit: string;
}

export interface DriftInsight {
  metric: string;
  severity: "info" | "warning" | "critical";
  headline: string;
  message: string;
  recommended_action: string;
}

const VALID_SEVERITY = new Set(["info", "warning", "critical"]);

export async function narrateBusinessDrift(
  flaggedMetrics: DriftMetricInput[],
): Promise<DriftInsight[]> {
  if (flaggedMetrics.length === 0) return [];

  try {
    const result = await askVireekAi({
      task: "business_drift_narrative",
      jsonMode: true,
      maxTokens: 1200,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content: `Signals that drifted in the wrong direction over the last 30 days vs the prior 90-day baseline — already computed, ground truth, never recompute:\n${JSON.stringify(flaggedMetrics, null, 2)}`,
        },
      ],
    });

    const parsed = JSON.parse(result.text);
    const rawList: unknown[] = Array.isArray(parsed) ? parsed : [];
    const validMetrics = new Set(flaggedMetrics.map((m) => m.metric));

    const insights: DriftInsight[] = [];
    for (const item of rawList) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;
      if (typeof d.metric !== "string" || !validMetrics.has(d.metric)) continue;
      if (!VALID_SEVERITY.has(String(d.severity))) continue;
      if (typeof d.headline !== "string" || typeof d.message !== "string" || typeof d.recommended_action !== "string") continue;
      insights.push({
        metric: d.metric,
        severity: d.severity as DriftInsight["severity"],
        headline: d.headline.slice(0, 120),
        message: d.message.slice(0, 400),
        recommended_action: d.recommended_action.slice(0, 300),
      });
    }
    return insights;
  } catch {
    return [];
  }
}
