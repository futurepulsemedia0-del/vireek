// supabase/functions/_shared/ai-core/trustBank.ts
//
// Customer Trust Bank — intervention layer. Takes already-computed trust
// erosion alerts (get_trust_erosion_alerts, real events only) and asks the
// shared Vireek AI router for a short, specific, personal intervention per
// customer. This file NEVER touches the database and can only write copy
// about a customer it was actually handed — every returned id is validated
// against the real alert list.

import { askVireekAi } from "./index.ts";

export interface TrustErosionAlert {
  customer_id: string;
  customer_name: string;
  trust_score: number;
  recent_30d_delta: number;
  event_count_30d: number;
  top_reason: string | null;
}

export interface TrustIntervention {
  customer_id: string;
  headline: string;
  intervention: string;
}

export async function suggestTrustInterventions(alerts: TrustErosionAlert[]): Promise<TrustIntervention[]> {
  if (alerts.length === 0) return [];

  try {
    const slim = alerts.map(({ customer_id, customer_name, trust_score, recent_30d_delta, event_count_30d, top_reason }) => ({
      customer_id, customer_name, trust_score, recent_30d_delta, event_count_30d, top_reason,
    }));

    const result = await askVireekAi({
      task: "trust_bank_intervention",
      jsonMode: true,
      maxTokens: 900,
      temperature: 0.3,
      messages: [
        { role: "user", content: `Trust erosion alerts computed directly from the database — treat every number as ground truth:\n${JSON.stringify(slim, null, 2)}` },
      ],
    });

    const parsed = JSON.parse(result.text);
    const rawList: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { interventions?: unknown[] })?.interventions)
      ? (parsed as { interventions: unknown[] }).interventions
      : [];

    const validIds = new Set(alerts.map((a) => a.customer_id));
    const seen = new Set<string>();
    const out: TrustIntervention[] = [];

    for (const item of rawList) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;
      if (typeof d.customer_id !== "string" || !validIds.has(d.customer_id) || seen.has(d.customer_id)) continue;
      if (typeof d.headline !== "string" || typeof d.intervention !== "string") continue;
      seen.add(d.customer_id);
      out.push({ customer_id: d.customer_id, headline: d.headline.slice(0, 140), intervention: d.intervention.slice(0, 300) });
    }
    return out;
  } catch {
    return [];
  }
}
