/**
 * Vireek Insights - data access. Thin RPC wrappers only: tiering, consent and
 * k-anonymity are enforced in the database (see the migration header).
 */
import { supabase } from '@/lib/supabase';
import { normalizeCell, type InsightCell, type InsightPeriod } from '@/lib/insights';

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function rows(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function cellsFrom(data: unknown, defaultRegion: string): InsightCell[] {
  return rows(data)
    .map((r) => normalizeCell({ region_key: defaultRegion, ...r }))
    .filter((c): c is InsightCell => c !== null);
}

/** Public: released periods, newest first. */
export async function fetchInsightPeriods(): Promise<InsightPeriod[]> {
  const { data, error } = await supabase.rpc('insights_public_periods');
  if (error) throw error;
  return rows(data).map((r) => ({
    period_label: String(r.period_label ?? ''),
    period_start: String(r.period_start ?? ''),
    period_end: String(r.period_end ?? ''),
    published_at: String(r.published_at ?? ''),
    contributors_rounded: num(r.contributors_rounded),
  }));
}

/** Public: national cells for a period (latest when omitted). */
export async function fetchPublicIndexes(period?: string): Promise<InsightCell[]> {
  const { data, error } = await supabase.rpc('insights_public_indexes', { p_period: period ?? null });
  if (error) throw error;
  return cellsFrom(data, 'all');
}

/** Contributing businesses only (give-to-get): includes state-level cells. */
export async function fetchMemberIndexes(period?: string, trade?: string, region?: string): Promise<InsightCell[]> {
  const { data, error } = await supabase.rpc('insights_member_indexes', {
    p_period: period ?? null,
    p_trade: trade ?? null,
    p_region: region ?? null,
  });
  if (error) throw error;
  return cellsFrom(data, 'all');
}

export interface InsightsSettings {
  contribute: boolean;
  consented_at: string | null;
  withdrawn_at: string | null;
  consent_version: number;
}

export async function fetchInsightsSettings(): Promise<InsightsSettings> {
  const { data, error } = await supabase
    .from('insights_settings')
    .select('contribute, consented_at, withdrawn_at, consent_version')
    .maybeSingle();
  if (error) throw error;
  return {
    contribute: data?.contribute ?? false,
    consented_at: data?.consented_at ?? null,
    withdrawn_at: data?.withdrawn_at ?? null,
    consent_version: data?.consent_version ?? 1,
  };
}

export async function setInsightsContribution(enabled: boolean): Promise<void> {
  const { error } = await supabase.rpc('insights_set_contribution', { p_enabled: enabled });
  if (error) throw error;
}

export interface ConsentLogEntry {
  action: 'granted' | 'withdrawn';
  consent_version: number;
  created_at: string;
}

export async function fetchConsentLog(): Promise<ConsentLogEntry[]> {
  const { data, error } = await supabase
    .from('insights_consent_log')
    .select('action, consent_version, created_at')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw error;
  return rows(data).map((r) => ({
    action: r.action === 'withdrawn' ? 'withdrawn' : 'granted',
    consent_version: num(r.consent_version),
    created_at: String(r.created_at ?? ''),
  }));
}

export interface MyPreview {
  period: string;
  trade: string;
  region: string;
  values: { metric: string; value: number }[];
}

/** What this business would contribute for the last completed quarter (own data only). */
export async function fetchMyPreview(): Promise<MyPreview | null> {
  const { data, error } = await supabase.rpc('insights_my_preview');
  if (error) throw error;
  const list = rows(data);
  if (list.length === 0) return null;
  return {
    period: String(list[0].r_period ?? ''),
    trade: String(list[0].r_trade ?? 'other'),
    region: String(list[0].r_region ?? 'all'),
    values: list.map((r) => ({ metric: String(r.r_metric ?? ''), value: num(r.r_value) })),
  };
}
