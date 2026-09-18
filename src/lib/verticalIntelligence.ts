// src/lib/verticalIntelligence.ts
//
// Read-side of the Proprietary Vertical AI / Data Pipeline — see
// supabase/migrations/20261001000000_vertical_ai_data_pipeline.sql and
// supabase/functions/vertical-ai-pipeline/index.ts for how these rows get
// written. Everything this fetches is already anonymized and aggregated
// (k-anonymity >= 5 distinct tenants per row) before it ever reaches the
// client, so this file does no additional privacy filtering — it only
// shapes and limits what's shown.

import { supabase } from '@/lib/supabase';

export type VerticalSignalType = 'objection' | 'intent' | 'upsell_opportunity';

export interface VerticalIntelligenceSignal {
  id: string;
  industry: string;
  signal_type: VerticalSignalType;
  signal_key: string;
  period_start: string;
  period_end: string;
  tenant_count: number;
  occurrence_count: number;
  resolution_rate: number | null;
  booking_rate: number | null;
  avg_call_score: number | null;
  computed_at: string;
}

export interface VerticalIntelligenceReport {
  industry: string;
  topObjections: VerticalIntelligenceSignal[];
  topIntents: VerticalIntelligenceSignal[];
  topUpsells: VerticalIntelligenceSignal[];
}

const TOP_N = 5;

/**
 * Looks up this tenant's own `business_profile.primary_industry`, then
 * fetches the latest mined signals for that industry. Returns null when
 * the tenant has no industry set, or when nothing for that industry has
 * cleared the platform's k-anonymity floor yet (e.g. a brand-new industry
 * with fewer than 5 contributing tenants) — callers should treat null as
 * "nothing to show" rather than an error.
 */
export async function fetchVerticalIntelligence(userId: string): Promise<VerticalIntelligenceReport | null> {
  if (!userId) return null;

  const { data: businessProfile } = await supabase
    .from('business_profile')
    .select('primary_industry')
    .eq('user_id', userId)
    .maybeSingle();

  const industry = businessProfile?.primary_industry;
  if (!industry) return null;

  const { data: signals, error } = await supabase
    .from('vertical_intelligence_signals')
    .select('*')
    .eq('industry', industry)
    .order('occurrence_count', { ascending: false });

  if (error || !signals || signals.length === 0) return null;

  const rows = signals as VerticalIntelligenceSignal[];
  const byType = (type: VerticalSignalType) => rows.filter((s) => s.signal_type === type).slice(0, TOP_N);

  return {
    industry,
    topObjections: byType('objection'),
    topIntents: byType('intent'),
    topUpsells: byType('upsell_opportunity'),
  };
}

/** "no heat emergency" -> "No heat emergency" */
export function capitalizeSignal(key: string): string {
  return key.length > 0 ? key[0].toUpperCase() + key.slice(1) : key;
}
