import { supabase } from '@/lib/supabase';

/**
 * Customer Switching Shield — dashboard client library.
 * Cases and actions are created only by the switching-shield Edge Function /
 * SECURITY DEFINER SQL; this module reads them and handles human decisions.
 */

export type ShieldSignalType =
  | 'booking_decline' | 'complaint' | 'price_objection' | 'delayed_response' | 'low_satisfaction'
  | 'unresolved_job' | 'repeat_reservice' | 'competitor_mention' | 'missed_appointment';
export type ShieldOfferType =
  | 'priority_appointment' | 'discount' | 'free_inspection' | 'manager_call' | 'membership_offer' | 'warranty_extension';
export type ShieldLevel = 'watch' | 'at_risk' | 'critical';
export type ShieldCaseStatus = 'open' | 'action_pending' | 'saved' | 'lost' | 'dismissed' | 'cleared';
export type ShieldActionStatus = 'proposed' | 'sent' | 'completed' | 'failed' | 'rejected';
export type ShieldOutcome = 'accepted' | 'declined' | 'no_response';

export interface ShieldSignal {
  type: ShieldSignalType;
  points: number;
  count: number;
  detail: string;
  last_at: string | null;
}

export interface ShieldAction {
  id: string;
  case_id: string;
  customer_id: string;
  offer_type: ShieldOfferType;
  channel: 'sms' | 'call_task';
  message: string;
  terms: Record<string, unknown>;
  rationale: string | null;
  status: ShieldActionStatus;
  outcome: ShieldOutcome | null;
  error: string | null;
  executed_at: string | null;
  created_at: string;
}

export interface ShieldCase {
  id: string;
  user_id: string;
  customer_id: string;
  risk_score: number;
  peak_risk_score: number;
  risk_level: ShieldLevel;
  signals: ShieldSignal[];
  signal_count: number;
  customer_value_cents: number;
  status: ShieldCaseStatus;
  narrative: string | null;
  talk_track: string | null;
  plan_generated_at: string | null;
  first_detected_at: string;
  last_scored_at: string;
  closed_at: string | null;
  closed_note: string | null;
  customers: { name: string; phone: string | null; email: string | null } | null;
  switching_shield_actions: ShieldAction[];
}

export interface ShieldSettings {
  user_id: string;
  enabled: boolean;
  watch_threshold: number;
  at_risk_threshold: number;
  critical_threshold: number;
  lookback_days: number;
  case_cooldown_days: number;
  max_discount_percent: number;
  enabled_offers: ShieldOfferType[];
}

export const SIGNAL_LABELS: Record<ShieldSignalType, string> = {
  booking_decline: 'Fewer bookings',
  complaint: 'Complaint',
  price_objection: 'Price objection',
  delayed_response: 'Delayed response',
  low_satisfaction: 'Low satisfaction',
  unresolved_job: 'Unresolved job',
  repeat_reservice: 'Repeat reservice',
  competitor_mention: 'Competitor mention',
  missed_appointment: 'Missed appointment',
};

export const OFFER_LABELS: Record<ShieldOfferType, string> = {
  priority_appointment: 'Priority appointment',
  discount: 'Discount',
  free_inspection: 'Free inspection',
  manager_call: 'Manager call',
  membership_offer: 'Membership offer',
  warranty_extension: 'Warranty extension',
};

export const ALL_OFFERS = Object.keys(OFFER_LABELS) as ShieldOfferType[];

export const LEVEL_LABELS: Record<ShieldLevel, string> = { watch: 'Watch', at_risk: 'At risk', critical: 'Critical' };
export const LEVEL_BADGE: Record<ShieldLevel, string> = {
  watch: 'bg-warning-500/10 text-warning-500',
  at_risk: 'bg-warning-500/20 text-warning-500',
  critical: 'bg-danger/10 text-danger',
};
export const LEVEL_BAR: Record<ShieldLevel, string> = { watch: 'bg-warning-500/60', at_risk: 'bg-warning-500', critical: 'bg-danger' };

export const ACTIVE_STATUSES: ShieldCaseStatus[] = ['open', 'action_pending'];
export const isActiveCase = (c: ShieldCase) => ACTIVE_STATUSES.includes(c.status);

export function formatUsd(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format((cents || 0) / 100);
}

export function daysAgo(iso: string | null): string {
  if (!iso) return '';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}

export async function fetchShieldCases(): Promise<ShieldCase[]> {
  const { data, error } = await supabase
    .from('switching_shield_cases')
    .select('*, customers(name, phone, email), switching_shield_actions(*)')
    .order('risk_score', { ascending: false })
    .limit(300);
  if (error) throw error;
  return ((data ?? []) as unknown as ShieldCase[]).map((c) => ({
    ...c,
    signals: Array.isArray(c.signals) ? c.signals : [],
    switching_shield_actions: [...(c.switching_shield_actions ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)),
  }));
}

async function invokeShield<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke('switching-shield', { body: { action, ...payload } });
  if (error) throw error;
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: string }).error) {
    throw new Error((data as { error: string }).error);
  }
  return data as T;
}

export const scanNow = () => invokeShield<{ ok: boolean; opened?: number; planned?: number; skipped?: string }>('scan_me');
export const regeneratePlan = (caseId: string) => invokeShield<{ ok: boolean }>('plan', { case_id: caseId });
export const executeAction = (actionId: string, message?: string) =>
  invokeShield<{ ok: boolean; reason: string | null }>('execute', { action_id: actionId, message });

async function must(q: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const { error } = await q;
  if (error) throw new Error(error.message);
}

export const closeCase = (id: string, status: 'saved' | 'lost' | 'dismissed', note?: string) =>
  must(supabase.from('switching_shield_cases')
    .update({ status, closed_at: new Date().toISOString(), closed_note: note ?? null }).eq('id', id));

export const rejectAction = (id: string) =>
  must(supabase.from('switching_shield_actions').update({ status: 'rejected' }).eq('id', id).eq('status', 'proposed'));

export const setActionOutcome = (id: string, outcome: ShieldOutcome) =>
  must(supabase.from('switching_shield_actions').update({ outcome }).eq('id', id));

export async function fetchShieldSettings(): Promise<ShieldSettings> {
  const { data, error } = await supabase.from('switching_shield_settings').select('*').maybeSingle();
  if (error) throw error;
  if (data) return data as ShieldSettings;
  const { data: created, error: insErr } = await supabase.from('switching_shield_settings').insert({}).select('*').single();
  if (insErr) throw insErr;
  return created as ShieldSettings;
}

export const saveShieldSettings = (userId: string, patch: Partial<Omit<ShieldSettings, 'user_id'>>) =>
  must(supabase.from('switching_shield_settings').update(patch).eq('user_id', userId));
