/**
 * Lead marketplaces (Angi, HomeAdvisor, Thumbtack, Nextdoor, Google LSA):
 * config, cost-per-booked-job report and recent ingestion events.
 *
 * All aggregation (booked jobs, cost per booked job, response-time percentiles)
 * happens in Postgres via `lead_marketplace_cost_report` so the numbers are
 * auditable in one place (see the migration header for exact definitions).
 * Everything here is thin fetch + pure formatting helpers.
 */

import { supabase } from '@/lib/supabase';

export type MarketplaceProvider = 'angi' | 'homeadvisor' | 'thumbtack' | 'nextdoor' | 'google_lsa';

export const SLA_SECONDS = 60;

export const MARKETPLACES: { id: MarketplaceProvider; label: string; aliasTag: string }[] = [
  { id: 'angi', label: 'Angi', aliasTag: 'angi' },
  { id: 'homeadvisor', label: 'HomeAdvisor', aliasTag: 'homeadvisor' },
  { id: 'thumbtack', label: 'Thumbtack', aliasTag: 'thumbtack' },
  { id: 'nextdoor', label: 'Nextdoor', aliasTag: 'nextdoor' },
  { id: 'google_lsa', label: 'Google Local Services', aliasTag: 'lsa' },
];

export function providerLabel(id: string): string {
  return MARKETPLACES.find((m) => m.id === id)?.label ?? id;
}

export interface CostReportRow {
  provider: MarketplaceProvider;
  leads: number;
  leads_unknown_cost: number;
  spend_cents: number;
  booked_leads: number;
  booked_jobs: number;
  revenue_cents: number;
  cost_per_lead_cents: number | null;
  cost_per_booked_job_cents: number | null;
  booking_rate: number | null;
  responded_leads: number;
  within_sla_leads: number;
  median_response_seconds: number | null;
  p95_response_seconds: number | null;
}

export interface SourceConfig {
  id: string;
  provider: MarketplaceProvider;
  enabled: boolean;
  auto_respond_enabled: boolean;
  default_cost_cents: number | null;
  booking_url: string | null;
  timezone: string;
  sms_quiet_hours: boolean;
  webhook_token: string;
}

export interface MarketplaceEvent {
  id: string;
  provider: MarketplaceProvider;
  received_via: 'webhook' | 'email';
  status: 'received' | 'lead_created' | 'parse_failed' | 'error';
  parse_error: string | null;
  cost_cents: number | null;
  cost_source: 'parsed' | 'default' | null;
  received_at: string;
  auto_respond_status: string;
  auto_respond_channel: string | null;
  auto_respond_ai: boolean;
  response_ms: number | null;
}

// ------------------------------------------------------------------
// Pure helpers (unit-tested)
// ------------------------------------------------------------------

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 === 0 ? 0 : 2 });
}

export function formatSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined) return '—';
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function percent(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

export function buildWebhookUrl(supabaseUrl: string | undefined, token: string): string {
  const base = (supabaseUrl ?? '').replace(/\/+$/, '');
  return `${base}/functions/v1/lead-marketplace-ingest?token=${token}`;
}

export function buildEmailAlias(inboundToken: string | null | undefined, domain: string | undefined, provider: MarketplaceProvider): string | null {
  if (!inboundToken || !domain) return null;
  const tag = MARKETPLACES.find((m) => m.id === provider)?.aliasTag ?? provider;
  return `${inboundToken}+${tag}@${domain}`;
}

export function generateToken(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** "$45", "45.50" -> cents; empty -> null; invalid -> undefined (caller shows an error). */
export function dollarsToCents(input: string): number | null | undefined {
  const s = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  return Math.round(Number(s) * 100);
}

export interface ReportTotals {
  leads: number;
  leadsUnknownCost: number;
  spendCents: number;
  bookedLeads: number;
  bookedJobs: number;
  revenueCents: number;
  costPerLeadCents: number | null;
  costPerBookedJobCents: number | null;
  bookingRatePct: number | null;
  respondedLeads: number;
  withinSlaPct: number | null;
}

export function summarizeReport(rows: CostReportRow[]): ReportTotals {
  const sum = (f: (r: CostReportRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const leads = sum((r) => r.leads);
  const spendCents = sum((r) => r.spend_cents);
  const bookedLeads = sum((r) => r.booked_leads);
  const responded = sum((r) => r.responded_leads);
  return {
    leads,
    leadsUnknownCost: sum((r) => r.leads_unknown_cost),
    spendCents,
    bookedLeads,
    bookedJobs: sum((r) => r.booked_jobs),
    revenueCents: sum((r) => r.revenue_cents),
    costPerLeadCents: leads > 0 ? Math.round(spendCents / leads) : null,
    costPerBookedJobCents: bookedLeads > 0 ? Math.round(spendCents / bookedLeads) : null,
    bookingRatePct: percent(bookedLeads, leads),
    respondedLeads: responded,
    withinSlaPct: percent(sum((r) => r.within_sla_leads), responded),
  };
}

// ------------------------------------------------------------------
// Fetch
// ------------------------------------------------------------------

function num(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}
function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export async function fetchCostReport(from: Date, to: Date): Promise<CostReportRow[]> {
  const { data, error } = await supabase.rpc('lead_marketplace_cost_report', { p_from: from.toISOString(), p_to: to.toISOString() });
  if (error) throw error;
  return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
    provider: r.provider as MarketplaceProvider,
    leads: num(r.leads),
    leads_unknown_cost: num(r.leads_unknown_cost),
    spend_cents: num(r.spend_cents),
    booked_leads: num(r.booked_leads),
    booked_jobs: num(r.booked_jobs),
    revenue_cents: num(r.revenue_cents),
    cost_per_lead_cents: numOrNull(r.cost_per_lead_cents),
    cost_per_booked_job_cents: numOrNull(r.cost_per_booked_job_cents),
    booking_rate: numOrNull(r.booking_rate),
    responded_leads: num(r.responded_leads),
    within_sla_leads: num(r.within_sla_leads),
    median_response_seconds: numOrNull(r.median_response_seconds),
    p95_response_seconds: numOrNull(r.p95_response_seconds),
  }));
}

export async function fetchSources(): Promise<SourceConfig[]> {
  const { data, error } = await supabase.from('lead_marketplace_sources').select('*');
  if (error) throw error;
  return (data as SourceConfig[] | null) ?? [];
}

export async function upsertSource(
  userId: string,
  provider: MarketplaceProvider,
  patch: Partial<Omit<SourceConfig, 'id' | 'provider' | 'webhook_token'>> & { webhook_token?: string },
): Promise<SourceConfig> {
  const { data, error } = await supabase
    .from('lead_marketplace_sources')
    .upsert({ user_id: userId, provider, ...patch }, { onConflict: 'user_id,provider' })
    .select('*')
    .single();
  if (error) throw error;
  return data as SourceConfig;
}

export async function fetchRecentEvents(limit = 25): Promise<MarketplaceEvent[]> {
  const { data, error } = await supabase
    .from('lead_marketplace_events')
    .select('id,provider,received_via,status,parse_error,cost_cents,cost_source,received_at,auto_respond_status,auto_respond_channel,auto_respond_ai,response_ms')
    .order('received_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as MarketplaceEvent[] | null) ?? [];
}
