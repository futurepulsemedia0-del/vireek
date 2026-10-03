/**
 * VIREEK Service Data Exchange — client library.
 *
 * Every read/write goes through three RPCs defined in
 * supabase/migrations/20270215000000_service_data_exchange.sql:
 *   sde_get_overview(), sde_set_consent(), sde_get_intelligence().
 * There is no cross-tenant table access from the client — the aggregate
 * table has RLS enabled with no policies and revoked privileges.
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type SdeDomain = 'failure' | 'equipment' | 'pricing' | 'labor' | 'parts' | 'outcomes';

export type SdeProduct =
  | 'failure_intelligence'
  | 'oem_intelligence'
  | 'pricing_intelligence'
  | 'labor_intelligence'
  | 'parts_intelligence'
  | 'benchmark_intelligence'
  | 'demand_intelligence';

export type SdeConsentStatus = 'none' | 'granted' | 'revoked';

export interface SdeDomainState {
  domain: SdeDomain;
  status: SdeConsentStatus;
  granted_at: string | null;
  records_contributed: number;
  cohorts_contributed: number;
}

export interface SdeProductState {
  product: SdeProduct;
  domain: SdeDomain;
  unlocked: boolean;
  available_cells: number;
}

export interface SdeOverview {
  terms_version: string;
  can_manage: boolean;
  last_refreshed_at: string | null;
  network_contributors: number | null;
  domains: SdeDomainState[];
  products: SdeProductState[];
}

export interface SdeCell {
  dimension: Record<string, string>;
  metric: string;
  unit: string;
  contributor_count: number;
  sample_size: number;
  avg_value: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  computed_at: string;
}

export interface SdeConsentEvent {
  id: string;
  domain: SdeDomain;
  action: 'granted' | 'revoked';
  terms_version: string;
  created_at: string;
}

// ============================================================
// CATALOG (copy shown to the contractor — keep it truthful)
// ============================================================

export interface SdeDomainInfo {
  label: string;
  /** What is read from the account to compute its contribution. */
  uses: string;
  /** What is never read or shared for this domain. */
  never: string;
  product: SdeProduct[];
}

export const SDE_DOMAIN_INFO: Record<SdeDomain, SdeDomainInfo> = {
  failure: {
    label: 'Failure data',
    uses: 'Equipment type, make, and the unit’s age on the day of each repair visit.',
    never: 'Customer names, addresses, serial numbers, job notes, or photos.',
    product: ['failure_intelligence'],
  },
  equipment: {
    label: 'Equipment data',
    uses: 'Equipment type and make, plus how many service calls and reworks each make generates per unit.',
    never: 'Which customer or site a unit belongs to, serial numbers, or install addresses.',
    product: ['oem_intelligence'],
  },
  pricing: {
    label: 'Pricing',
    uses: 'Your median paid ticket per service type (needs at least 3 paid jobs).',
    never: 'Individual invoices, customer names, discounts, or your price book.',
    product: ['pricing_intelligence'],
  },
  labor: {
    label: 'Technician performance',
    uses: 'Your median on-site time and first-time-fix rate per service type, as company totals.',
    never: 'Any individual technician’s name, pay rate, or personal scorecard.',
    product: ['labor_intelligence'],
  },
  parts: {
    label: 'Parts',
    uses: 'How often a named part is needed for a service type.',
    never: 'Part costs, vendors, stock levels, or which jobs used them.',
    product: ['parts_intelligence'],
  },
  outcomes: {
    label: 'Outcomes',
    uses: 'Company-level conversion, response time, ticket size, call quality, and job-volume momentum.',
    never: 'Individual leads, calls, recordings, or customer details.',
    product: ['benchmark_intelligence', 'demand_intelligence'],
  },
};

export const SDE_DOMAIN_ORDER: SdeDomain[] = ['failure', 'equipment', 'pricing', 'labor', 'parts', 'outcomes'];

export interface SdeProductInfo {
  label: string;
  blurb: string;
  domain: SdeDomain;
}

export const SDE_PRODUCT_INFO: Record<SdeProduct, SdeProductInfo> = {
  failure_intelligence: {
    label: 'Failure intelligence',
    blurb: 'At what age equipment typically fails, by type and make, across the network.',
    domain: 'failure',
  },
  oem_intelligence: {
    label: 'OEM intelligence',
    blurb: 'Which manufacturers generate the most service calls and reworks per installed unit.',
    domain: 'equipment',
  },
  pricing_intelligence: {
    label: 'Pricing intelligence',
    blurb: 'What similar businesses actually collect per service type.',
    domain: 'pricing',
  },
  labor_intelligence: {
    label: 'Labor intelligence',
    blurb: 'Typical on-site time and first-time-fix rates per service type.',
    domain: 'labor',
  },
  parts_intelligence: {
    label: 'Parts intelligence',
    blurb: 'Which parts you should expect to need for a given service type.',
    domain: 'parts',
  },
  benchmark_intelligence: {
    label: 'Benchmarks',
    blurb: 'Distribution of core business metrics across your trade.',
    domain: 'outcomes',
  },
  demand_intelligence: {
    label: 'Demand intelligence',
    blurb: 'Which services are accelerating or cooling across the network (100 = normal pace).',
    domain: 'outcomes',
  },
};

export const SDE_PRODUCT_ORDER: SdeProduct[] = [
  'failure_intelligence',
  'oem_intelligence',
  'pricing_intelligence',
  'labor_intelligence',
  'parts_intelligence',
  'benchmark_intelligence',
  'demand_intelligence',
];

const METRIC_LABELS: Record<string, string> = {
  age_at_failure_years: 'Age at failure',
  service_calls_per_unit: 'Service calls per unit',
  rework_rate_pct: 'Rework rate',
  median_paid_ticket_cents: 'Median paid ticket',
  median_job_minutes: 'Median on-site time',
  first_time_fix_rate_pct: 'First-time-fix rate',
  attach_rate_pct: 'Part needed on',
  demand_momentum_index: 'Demand momentum',
  lead_conversion_rate: 'Lead conversion',
  quote_acceptance_rate: 'Quote acceptance',
  missed_call_rate: 'Missed-call rate',
  avg_call_score: 'AI call score',
  avg_lead_response_hours: 'Lead-to-quote time',
  avg_ticket_cents: 'Average paid ticket',
};

// ============================================================
// FORMATTING
// ============================================================

export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric.replace(/_/g, ' ');
}

export function formatSdeValue(value: number | null, unit: string): string {
  if (value === null || Number.isNaN(value)) return '—';
  switch (unit) {
    case 'percent':
      return `${value.toFixed(value < 10 ? 1 : 0)}%`;
    case 'cents':
      return `$${Math.round(value / 100).toLocaleString('en-US')}`;
    case 'years':
      return `${value.toFixed(1)} yrs`;
    case 'minutes':
      return value >= 90 ? `${(value / 60).toFixed(1)} hrs` : `${Math.round(value)} min`;
    case 'hours':
      return value < 1 ? `${Math.round(value * 60)} min` : `${value.toFixed(1)} hrs`;
    case 'ratio':
      return value.toFixed(2);
    case 'index':
      return String(Math.round(value));
    case 'score':
      return value.toFixed(0);
    default:
      return String(value);
  }
}

function titleCase(s: string): string {
  return s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** "hvac · furnace · carrier" style label from the cohort dimension. */
export function describeDimension(dimension: Record<string, string>): string {
  const order = ['industry', 'service_type', 'equipment_type', 'make', 'part'];
  const parts: string[] = [];
  for (const key of order) {
    const v = dimension[key];
    if (v) parts.push(titleCase(v));
  }
  for (const [key, v] of Object.entries(dimension)) {
    if (!order.includes(key) && v) parts.push(titleCase(String(v)));
  }
  return parts.join(' · ') || 'All';
}

// ============================================================
// RPC WRAPPERS
// ============================================================

export async function fetchSdeOverview(): Promise<SdeOverview | null> {
  const { data, error } = await supabase.rpc('sde_get_overview');
  if (error) throw error;
  return (data as SdeOverview | null) ?? null;
}

export async function setSdeConsent(domain: SdeDomain, granted: boolean): Promise<void> {
  const { error } = await supabase.rpc('sde_set_consent', { p_domain: domain, p_granted: granted });
  if (error) throw error;
}

export async function fetchSdeIntelligence(
  product: SdeProduct,
  options: { search?: string; myTradeOnly?: boolean; limit?: number } = {},
): Promise<SdeCell[]> {
  const { data, error } = await supabase.rpc('sde_get_intelligence', {
    p_product: product,
    p_search: options.search?.trim() ? options.search.trim() : null,
    p_my_trade_only: options.myTradeOnly ?? false,
    p_limit: options.limit ?? 200,
  });
  if (error) throw error;
  return ((data as SdeCell[] | null) ?? []).map((row) => ({
    ...row,
    // NUMERIC columns can arrive as strings depending on the client.
    avg_value: row.avg_value === null ? null : Number(row.avg_value),
    p25: row.p25 === null ? null : Number(row.p25),
    p50: row.p50 === null ? null : Number(row.p50),
    p75: row.p75 === null ? null : Number(row.p75),
  }));
}

export async function fetchSdeConsentEvents(limit = 20): Promise<SdeConsentEvent[]> {
  const { data, error } = await supabase
    .from('sde_consent_events')
    .select('id, domain, action, terms_version, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as SdeConsentEvent[] | null) ?? [];
}
