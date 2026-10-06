/**
 * Demand OS — client data layer.
 *
 * Market -> Google / Meta / LSA -> Campaign -> Lead -> Booking -> Job -> Revenue -> Gross Profit
 * -> guard-railed budget reallocation. Everything heavy (sync, attribution joins, allocation,
 * conversion upload) runs server-side; this file only reads, displays and triggers it.
 * Money is integer cents everywhere.
 */

import { supabase } from '@/lib/supabase';

export type AdPlatform = 'google_ads' | 'meta_ads' | 'google_lsa';
export type DemandOsMode = 'off' | 'recommend' | 'autopilot';

export const PLATFORM_LABEL: Record<AdPlatform, string> = {
  google_ads: 'Google Ads',
  meta_ads: 'Meta Ads',
  google_lsa: 'Google LSA',
};

export interface AdAccount {
  id: string;
  platform: AdPlatform;
  external_account_id: string;
  display_name: string | null;
  currency: string;
  status: 'active' | 'needs_reauth' | 'error';
  last_synced_at: string | null;
  last_error: string | null;
}

export interface AdCampaign {
  id: string;
  account_id: string;
  platform: AdPlatform;
  external_id: string;
  name: string;
  status: 'enabled' | 'paused' | 'removed' | 'unknown';
  daily_budget_cents: number | null;
  budget_editable: boolean;
  market_label: string | null;
  last_budget_change_at: string | null;
}

export interface EconomicsRow {
  campaign_id: string;
  spend_cents: number;
  clicks: number;
  impressions: number;
  leads: number;
  jobs_booked: number;
  jobs_won: number;
  revenue_cents: number;
  gross_profit_cents: number;
  pipeline_cents: number;
}

export interface BudgetRecommendation {
  id: string;
  campaign_id: string;
  status: 'pending' | 'applied' | 'rejected' | 'expired' | 'failed' | 'reverted';
  direction: 'increase' | 'decrease';
  current_budget_cents: number;
  proposed_budget_cents: number;
  applyable: boolean;
  reason: string;
  evidence: { estNetDailyProfitDeltaCents?: number; confidence?: number; roiShrunk?: number; portfolioRoi?: number };
  error: string | null;
  created_at: string;
  decided_by: string | null;
}

export interface DemandOsSettings {
  user_id?: string;
  mode: DemandOsMode;
  max_shift_pct: number;
  cooldown_days: number;
  min_spend_cents: number;
  min_jobs: number;
  maturation_days: number;
  lookback_days: number;
  allow_growth: boolean;
  total_daily_cap_cents: number | null;
  conversion_value_basis: 'gross_profit' | 'revenue';
  conversion_delay_days: number;
  google_conversion_action_id: string | null;
  meta_pixel_id: string | null;
}

export const DEFAULT_SETTINGS: DemandOsSettings = {
  mode: 'recommend',
  max_shift_pct: 15,
  cooldown_days: 7,
  min_spend_cents: 30000,
  min_jobs: 5,
  maturation_days: 14,
  lookback_days: 60,
  allow_growth: false,
  total_daily_cap_cents: null,
  conversion_value_basis: 'gross_profit',
  conversion_delay_days: 3,
  google_conversion_action_id: null,
  meta_pixel_id: null,
};

export interface CampaignPerformance extends EconomicsRow {
  campaign: AdCampaign;
  /** gross profit per $1 of ad spend; null when nothing was spent */
  profitPerDollar: number | null;
  costPerLeadCents: number | null;
  costPerWonJobCents: number | null;
  netProfitCents: number; // gross profit - ad spend
}

export interface Portfolio {
  spendCents: number;
  leads: number;
  jobsBooked: number;
  jobsWon: number;
  revenueCents: number;
  grossProfitCents: number;
  pipelineCents: number;
  netProfitCents: number;
  profitPerDollar: number | null;
  costPerWonJobCents: number | null;
}

// ============================================================
// PURE HELPERS
// ============================================================

export function formatCents(cents: number | null | undefined, opts: { compact?: boolean } = {}): string {
  const v = (cents ?? 0) / 100;
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: opts.compact && Math.abs(v) >= 1000 ? 0 : 2,
    minimumFractionDigits: opts.compact && Math.abs(v) >= 1000 ? 0 : 0,
  });
}

export function dateISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The lead cohort the economics describe: matured leads only, so open jobs don't read as losses. */
export function cohortRange(s: Pick<DemandOsSettings, 'maturation_days' | 'lookback_days'>): { start: string; end: string } {
  const end = new Date(Date.now() - s.maturation_days * 86_400_000);
  const start = new Date(end.getTime() - s.lookback_days * 86_400_000);
  return { start: dateISO(start), end: dateISO(end) };
}

export function buildPerformance(economics: EconomicsRow[], campaigns: AdCampaign[]): CampaignPerformance[] {
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const out: CampaignPerformance[] = [];
  for (const e of economics) {
    const campaign = byId.get(e.campaign_id);
    if (!campaign) continue;
    if (campaign.status === 'removed') continue;
    // Hide campaigns with no activity at all in the window.
    if (e.spend_cents === 0 && e.leads === 0 && e.jobs_booked === 0) continue;
    out.push({
      ...e,
      campaign,
      profitPerDollar: e.spend_cents > 0 ? e.gross_profit_cents / e.spend_cents : null,
      costPerLeadCents: e.spend_cents > 0 && e.leads > 0 ? Math.round(e.spend_cents / e.leads) : null,
      costPerWonJobCents: e.spend_cents > 0 && e.jobs_won > 0 ? Math.round(e.spend_cents / e.jobs_won) : null,
      netProfitCents: e.gross_profit_cents - e.spend_cents,
    });
  }
  return out.sort((a, b) => b.netProfitCents - a.netProfitCents);
}

export function buildPortfolio(rows: CampaignPerformance[]): Portfolio {
  const sum = (f: (r: CampaignPerformance) => number) => rows.reduce((a, r) => a + f(r), 0);
  const spendCents = sum((r) => r.spend_cents);
  const jobsWon = sum((r) => r.jobs_won);
  const grossProfitCents = sum((r) => r.gross_profit_cents);
  return {
    spendCents,
    leads: sum((r) => r.leads),
    jobsBooked: sum((r) => r.jobs_booked),
    jobsWon,
    revenueCents: sum((r) => r.revenue_cents),
    grossProfitCents,
    pipelineCents: sum((r) => r.pipeline_cents),
    netProfitCents: grossProfitCents - spendCents,
    profitPerDollar: spendCents > 0 ? grossProfitCents / spendCents : null,
    costPerWonJobCents: spendCents > 0 && jobsWon > 0 ? Math.round(spendCents / jobsWon) : null,
  };
}

/** "Campaign A wins on leads, Campaign B wins on profit" — the insight owners actually need. */
export function leadsVsProfitInsight(rows: CampaignPerformance[]): { byLeads: CampaignPerformance; byProfit: CampaignPerformance } | null {
  const eligible = rows.filter((r) => r.spend_cents > 0);
  if (eligible.length < 2) return null;
  const byLeads = [...eligible].sort((a, b) => b.leads - a.leads)[0];
  const byProfit = [...eligible].sort((a, b) => b.netProfitCents - a.netProfitCents)[0];
  if (byLeads.campaign.id === byProfit.campaign.id) return null;
  return { byLeads, byProfit };
}

export function marketRollup(rows: CampaignPerformance[]): { market: string; portfolio: Portfolio }[] {
  const groups = new Map<string, CampaignPerformance[]>();
  for (const r of rows) {
    const key = r.campaign.market_label?.trim() || 'Unassigned';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()]
    .map(([market, rs]) => ({ market, portfolio: buildPortfolio(rs) }))
    .sort((a, b) => b.portfolio.netProfitCents - a.portfolio.netProfitCents);
}

// ============================================================
// DATA ACCESS
// ============================================================

async function ownerId(): Promise<string> {
  const { data, error } = await supabase.rpc('get_account_owner_id');
  if (error || !data) throw error ?? new Error('No account');
  return data as string;
}

async function rows<T>(table: string, build?: (q: any) => any): Promise<T[]> {
  const base = supabase.from(table).select('*');
  const { data, error } = await (build ? build(base) : base);
  if (error) throw error;
  return (data as T[]) ?? [];
}

export const fetchAccounts = () => rows<AdAccount>('ad_accounts', (q) => q.order('created_at'));
export const fetchCampaigns = () => rows<AdCampaign>('ad_campaigns', (q) => q.order('name'));
export const fetchRecommendations = () =>
  rows<BudgetRecommendation>('ad_budget_recommendations', (q) => q.order('created_at', { ascending: false }).limit(60));

export async function fetchEconomics(start: string, end: string): Promise<EconomicsRow[]> {
  const { data, error } = await supabase.rpc('demand_os_my_economics', { p_start: start, p_end: end });
  if (error) throw error;
  return ((data as EconomicsRow[]) ?? []).map((r) => ({
    ...r,
    spend_cents: Number(r.spend_cents),
    clicks: Number(r.clicks),
    impressions: Number(r.impressions),
    leads: Number(r.leads),
    jobs_booked: Number(r.jobs_booked),
    jobs_won: Number(r.jobs_won),
    revenue_cents: Number(r.revenue_cents),
    gross_profit_cents: Number(r.gross_profit_cents),
    pipeline_cents: Number(r.pipeline_cents),
  }));
}

export async function fetchSettings(): Promise<DemandOsSettings> {
  const { data, error } = await supabase.from('demand_os_settings').select('*').maybeSingle();
  if (error) throw error;
  return { ...DEFAULT_SETTINGS, ...((data as Partial<DemandOsSettings> | null) ?? {}) };
}

export async function saveSettings(s: DemandOsSettings): Promise<void> {
  const { user_id: _ignored, ...rest } = s;
  void _ignored;
  const { error } = await supabase.from('demand_os_settings').upsert({ ...rest, user_id: await ownerId() }, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function fetchConversionCounts(): Promise<Record<'pending' | 'sent' | 'failed' | 'skipped', number>> {
  const counts = { pending: 0, sent: 0, failed: 0, skipped: 0 };
  const { data, error } = await supabase.from('ad_conversion_events').select('status').limit(10000);
  if (error) throw error;
  for (const r of (data as { status: keyof typeof counts }[]) ?? []) if (r.status in counts) counts[r.status] += 1;
  return counts;
}

export async function setCampaignMarket(campaignId: string, label: string): Promise<void> {
  const { error } = await supabase.rpc('demand_os_set_market', { p_campaign_id: campaignId, p_label: label });
  if (error) throw error;
}

export async function logLsaSpend(campaignId: string, start: string, end: string, dollars: number): Promise<void> {
  const { error } = await supabase.rpc('demand_os_log_lsa_spend', {
    p_campaign_id: campaignId,
    p_start: start,
    p_end: end,
    p_total_cents: Math.round(dollars * 100),
  });
  if (error) throw error;
}

export async function disconnectAccount(accountId: string): Promise<void> {
  const { error } = await supabase.from('ad_accounts').delete().eq('id', accountId);
  if (error) throw error;
}

// ---------- edge function calls ----------
async function invoke<T>(fn: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    // Surface the server's message when it sent one (e.g. 409 "budget changed since proposed").
    const ctx = (error as { context?: Response }).context;
    const msg = ctx ? await ctx.json().then((j: { error?: string }) => j.error).catch(() => undefined) : undefined;
    throw new Error(msg ?? error.message);
  }
  return data as T;
}

export async function startConnect(platform: 'google' | 'meta'): Promise<void> {
  const { url } = await invoke<{ url: string }>('ads-oauth-start', { platform });
  window.location.assign(url);
}
export const syncNow = () => invoke<{ synced: number; failed: number; leadsLinked: number }>('ads-sync');
export const runOptimizer = () => invoke<{ proposed: number }>('ads-optimizer', { action: 'run' });
export const decideRecommendation = (id: string, action: 'approve' | 'reject' | 'revert') =>
  invoke<{ ok: boolean }>('ads-optimizer', { action, recommendation_id: id });
export const sendConversions = (dryRun: boolean) =>
  invoke<{ queued: number; sent: number; failed: number; skipped: number }>('ads-conversions', { dry_run: dryRun });

// ---------- tracking helpers shown in the UI ----------
export const TRACKING_TEMPLATES = {
  google: 'utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={adgroupid}&utm_term={keyword}',
  meta: 'utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.id}}&utm_content={{adset.id}}',
};
