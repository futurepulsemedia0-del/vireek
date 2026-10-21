import { supabase } from '@/lib/supabase';

export type RenewalStage = 'upcoming_60' | 'upcoming_30' | 'upcoming_7' | 'due' | 'past_due' | 'renewed' | 'lapsed' | 'cancelled';
export type PipelineStage = 'upcoming_60' | 'upcoming_30' | 'upcoming_7' | 'due' | 'past_due';

export interface RenewalCycle {
  id: string;
  membership_id: string;
  period_end: string;
  stage: RenewalStage;
  amount_cents: number;
  previous_amount_cents: number;
  payment_route: 'card_on_file' | 'pay_link';
  quote_token: string;
  quote_status: 'sent' | 'accepted' | 'declined';
  charge_attempts: number;
  last_charge_error: string | null;
  outcome: 'renewed' | 'lapsed' | 'cancelled' | null;
  memberships: {
    customer_name: string;
    customer_email: string | null;
    customer_phone: string | null;
    auto_renew: boolean;
    status: string;
    card_brand: string | null;
    card_last4: string | null;
  } | null;
  membership_plans: { name: string; billing_interval: 'monthly' | 'yearly' } | null;
}

export interface RenewalKpis {
  window_days: number;
  renewed: number;
  lapsed: number;
  cancelled: number;
  /** Percent 0-100, or null when no renewal has been decided in the window. */
  renewal_rate: number | null;
  open_cycles: number;
  open_cycles_cents: number;
  at_risk_cents: number;
  active_members: number;
  auto_charge_ready: number;
  winback_recovered_cents: number;
  winback_open_cents: number;
}

export const PIPELINE_STAGES: { id: PipelineStage; label: string; hint: string }[] = [
  { id: 'upcoming_60', label: '31–60 days', hint: 'Renewal quote sent' },
  { id: 'upcoming_30', label: '8–30 days', hint: 'Reminder sent' },
  { id: 'upcoming_7', label: 'Next 7 days', hint: 'Final notice' },
  { id: 'due', label: 'Due now', hint: 'Charging / invoiced' },
  { id: 'past_due', label: 'Past due', hint: 'Retrying, grace period' },
];

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Defensive parse of the get_membership_renewal_kpis JSON. Never throws; unknown shapes become zeros. */
export function parseRenewalKpis(raw: unknown): RenewalKpis {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rate = typeof r.renewal_rate === 'number' && Number.isFinite(r.renewal_rate) ? Math.min(100, Math.max(0, r.renewal_rate)) : null;
  return {
    window_days: num(r.window_days) || 90,
    renewed: num(r.renewed),
    lapsed: num(r.lapsed),
    cancelled: num(r.cancelled),
    renewal_rate: rate,
    open_cycles: num(r.open_cycles),
    open_cycles_cents: num(r.open_cycles_cents),
    at_risk_cents: num(r.at_risk_cents),
    active_members: num(r.active_members),
    auto_charge_ready: num(r.auto_charge_ready),
    winback_recovered_cents: num(r.winback_recovered_cents),
    winback_open_cents: num(r.winback_open_cents),
  };
}

export function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${Number.isInteger(rate) ? rate : rate.toFixed(1)}%`;
}

export function formatUsd(cents: number): string {
  const d = cents / 100;
  return d.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(d) ? 0 : 2, maximumFractionDigits: 2 });
}

/** Share of active members who will be charged automatically (0-100). */
export function autoChargeCoverage(k: Pick<RenewalKpis, 'active_members' | 'auto_charge_ready'>): number | null {
  return k.active_members > 0 ? Math.round((k.auto_charge_ready / k.active_members) * 100) : null;
}

export function groupPipeline(cycles: RenewalCycle[]): Record<PipelineStage, RenewalCycle[]> {
  const out: Record<PipelineStage, RenewalCycle[]> = { upcoming_60: [], upcoming_30: [], upcoming_7: [], due: [], past_due: [] };
  for (const c of cycles) {
    if (c.outcome === null && c.stage in out) out[c.stage as PipelineStage].push(c);
  }
  for (const k of Object.keys(out) as PipelineStage[]) out[k].sort((a, b) => a.period_end.localeCompare(b.period_end));
  return out;
}

export function daysLeftLabel(periodEnd: string, now: Date = new Date()): string {
  const days = Math.ceil((new Date(periodEnd).getTime() - now.getTime()) / 86_400_000);
  if (days > 1) return `in ${days} days`;
  if (days === 1) return 'tomorrow';
  if (days === 0) return 'today';
  return `${Math.abs(days)} day${days === -1 ? '' : 's'} ago`;
}

export type RenewalRisk = { level: 'ok' | 'watch' | 'risk'; reason: string };

/** One honest line on why a renewal might not happen — shown on every pipeline row. */
export function renewalRisk(c: RenewalCycle): RenewalRisk {
  if (c.quote_status === 'declined' || c.memberships?.auto_renew === false) return { level: 'risk', reason: 'Turned off renewal' };
  if (c.stage === 'past_due') return { level: 'risk', reason: c.last_charge_error ? `Card failed: ${c.last_charge_error}` : 'Payment failed' };
  if (c.last_charge_error === 'authentication_required') return { level: 'watch', reason: 'Bank needs the customer to confirm' };
  if (c.payment_route === 'pay_link') return { level: 'watch', reason: 'No card on file — will be invoiced' };
  return { level: 'ok', reason: c.memberships?.card_last4 ? `Auto-charge ${c.memberships.card_brand ?? 'card'} •••• ${c.memberships.card_last4}` : 'Auto-charge' };
}

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isValidRenewalToken = (t: string) => TOKEN_RE.test(t);

export async function fetchRenewalKpis(windowDays = 90): Promise<RenewalKpis> {
  const { data, error } = await supabase.rpc('get_membership_renewal_kpis', { p_window_days: windowDays });
  if (error) throw new Error(error.message);
  return parseRenewalKpis(data);
}

export async function fetchOpenRenewalCycles(): Promise<RenewalCycle[]> {
  const { data, error } = await supabase
    .from('membership_renewal_cycles')
    .select(
      'id, membership_id, period_end, stage, amount_cents, previous_amount_cents, payment_route, quote_token, quote_status, charge_attempts, last_charge_error, outcome, memberships:membership_id(customer_name, customer_email, customer_phone, auto_renew, status, card_brand, card_last4), membership_plans:plan_id(name, billing_interval)',
    )
    .is('outcome', null)
    .order('period_end', { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as RenewalCycle[];
}

export function renewalLink(origin: string, quoteToken: string): string {
  return `${origin.replace(/\/$/, '')}/renew/${quoteToken}`;
}

// ---- public (token-gated) renewal quote ----

export interface PublicRenewal {
  business_name: string | null;
  plan_name: string | null;
  customer_first_name: string;
  billing_interval: 'monthly' | 'yearly' | null;
  benefits: string[];
  period_end: string;
  amount_cents: number;
  previous_amount_cents: number;
  quote_status: 'sent' | 'accepted' | 'declined';
  outcome: 'renewed' | 'lapsed' | 'cancelled' | null;
  auto_renew: boolean;
  card_brand: string | null;
  card_last4: string | null;
  pay_token: string | null;
}

export async function fetchPublicRenewal(token: string): Promise<PublicRenewal | null> {
  if (!isValidRenewalToken(token)) return null;
  const { data, error } = await supabase.rpc('get_membership_renewal_for_token', { p_token: token });
  if (error) throw new Error('Could not load this renewal.');
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  return {
    ...(d as unknown as PublicRenewal),
    benefits: Array.isArray(d.benefits) ? d.benefits.filter((b): b is string => typeof b === 'string' && b.trim() !== '') : [],
  };
}

export type RenewalResponse = 'accepted' | 'declined' | 'closed' | 'not_found' | 'invalid_action';

export async function respondToRenewal(token: string, action: 'accept' | 'decline'): Promise<RenewalResponse> {
  const { data, error } = await supabase.rpc('respond_to_membership_renewal', { p_token: token, p_action: action });
  if (error) throw new Error('Could not save your response. Please try again.');
  return data as RenewalResponse;
}
