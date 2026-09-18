import { supabase } from '@/lib/supabase';

export interface RegionalDemandSnapshot {
  industry: string;
  region_key: string;
  region_label: string;
  sample_size: number;
  current_week_calls: number;
  prior_week_calls: number;
  call_volume_change_pct: number | null;
  current_week_leads: number;
  emergency_rate_pct: number | null;
  period_end: string | null;
}

export interface LocalityDemand {
  name: string;
  current_week: number;
  prior_week: number;
  change_pct: number | null;
}

export interface MyLocalDemand {
  current_week_calls: number;
  prior_week_calls: number;
  current_week_leads: number;
  top_localities: LocalityDemand[];
}

export interface RegionalInsight {
  title: string;
  description: string;
  recommended_action: string;
  priority: number;
}

/** Best-effort city extraction from a free-text address — never throws,
 *  returns null for anything it can't confidently parse. */
export function parseLocality(address: string | null): string | null {
  if (!address) return null;
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2];
  if (parts.length === 2) return parts[0];
  return null;
}

export async function fetchMyBusinessSegment(): Promise<{ service_area: string | null; primary_industry: string | null }> {
  const { data } = await supabase.from('business_profile').select('service_area, primary_industry').maybeSingle();
  return { service_area: data?.service_area ?? null, primary_industry: data?.primary_industry ?? null };
}

export async function fetchRegionalSnapshot(serviceArea: string, primaryIndustry: string): Promise<RegionalDemandSnapshot | null> {
  const { data } = await supabase
    .from('regional_demand_snapshots')
    .select('*')
    .eq('industry', primaryIndustry)
    .eq('region_key', serviceArea.trim().toLowerCase())
    .maybeSingle();
  return (data as RegionalDemandSnapshot) ?? null;
}

/** Own-data only — no privacy concern, computed entirely client-side like computeMyMetrics() in lib/benchmarks.ts. */
export async function computeMyLocalDemand(): Promise<MyLocalDemand> {
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 86400000).toISOString();
  const fourteenDaysAgo = new Date(now - 14 * 86400000).toISOString();

  const [{ data: callsThisWeek }, { data: callsPriorWeek }, { data: leadsThisWeek }, { data: jobsRecent }] = await Promise.all([
    supabase.from('calls').select('id').gte('call_datetime', sevenDaysAgo),
    supabase.from('calls').select('id').gte('call_datetime', fourteenDaysAgo).lt('call_datetime', sevenDaysAgo),
    supabase.from('leads').select('id').gte('created_at', sevenDaysAgo),
    supabase.from('jobs').select('address, created_at').gte('created_at', fourteenDaysAgo),
  ]);

  const localityBuckets: Record<string, { current_week: number; prior_week: number }> = {};
  for (const j of (jobsRecent ?? []) as { address: string | null; created_at: string }[]) {
    const locality = parseLocality(j.address);
    if (!locality) continue;
    if (!localityBuckets[locality]) localityBuckets[locality] = { current_week: 0, prior_week: 0 };
    if (j.created_at >= sevenDaysAgo) localityBuckets[locality].current_week++;
    else localityBuckets[locality].prior_week++;
  }

  const top_localities: LocalityDemand[] = Object.entries(localityBuckets)
    .map(([name, v]) => ({
      name,
      current_week: v.current_week,
      prior_week: v.prior_week,
      change_pct: v.prior_week > 0 ? Math.round(((v.current_week - v.prior_week) / v.prior_week) * 1000) / 10 : null,
    }))
    .sort((a, b) => b.current_week - a.current_week)
    .slice(0, 6);

  return {
    current_week_calls: callsThisWeek?.length ?? 0,
    prior_week_calls: callsPriorWeek?.length ?? 0,
    current_week_leads: leadsThisWeek?.length ?? 0,
    top_localities,
  };
}

export async function fetchRegionalInsights(myMetrics: MyLocalDemand): Promise<{ insights: RegionalInsight[]; region: RegionalDemandSnapshot | null }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('regional-demand-insight', {
    body: { my_metrics: myMetrics },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) throw error;
  return { insights: data?.insights ?? [], region: data?.region ?? null };
}
