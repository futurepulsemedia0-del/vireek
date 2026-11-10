/**
 * Pest Ops — Supabase API. Every read is scoped to the ACCOUNT OWNER id (never the signed-in
 * user's own id: for a team member those differ) on top of RLS. Every write goes through a
 * SECURITY DEFINER RPC that re-checks the module gate, permission and tenant ownership.
 */

import { supabase } from '@/lib/supabase';
import type { PestCadence, PlanStatus, CallbackOutcome, RecordFieldKey } from '@/lib/tradePacks/pestOps';

export interface PestPlan {
  id: string;
  agreement_id: string | null;
  customer_id: string | null;
  cadence: PestCadence;
  season_from: number | null;
  season_to: number | null;
  term_start: string;
  term_end: string;
  status: PlanStatus;
  renewal_notice_days: number;
  guarantee_days: number;
  guarantee_same_target: boolean;
  guarantee_max_callbacks: number | null;
  cancel_effective_on: string | null;
  cancel_reason: string | null;
  created_at: string;
  /** Joined from recurring_agreements (display only). */
  agreement: { customer_name: string; address: string; timezone: string; preferred_time: string; start_date: string; title: string } | null;
}

export interface PestCallback {
  id: string;
  original_job_id: string | null;
  callback_job_id: string | null;
  service_date: string;
  requested_on: string;
  covered_until: string;
  request_targets: string[];
  outcome: CallbackOutcome | 'override';
  billable: boolean;
  reason: string | null;
  created_at: string;
}

export interface PestNotice {
  id: string;
  job_id: string | null;
  kind: 'pre_visit' | 'report';
  channel: 'email' | 'sms';
  send_at: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'skipped';
  attempts: number;
  last_error: string | null;
  subject: string;
  created_at: string;
}

export interface PestStockRow {
  id: string;
  product_id: string;
  unit: string;
  on_hand: number;
  reorder_point: number | null;
  product: { name: string; epa_reg_number: string | null } | null;
}

export interface PestMovement {
  id: number;
  product_id: string;
  kind: 'receipt' | 'usage' | 'adjustment' | 'count' | 'void_reversal';
  delta: number;
  unit: string;
  balance_after: number;
  note: string | null;
  created_at: string;
}

export interface PestRegionProfile {
  region_code: string;
  required_fields: RecordFieldKey[];
  retention_years: number;
  counsel_acknowledged_at: string | null;
}

export interface JobOption {
  id: string;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
  customer_id: string | null;
}

const owner = (id: string | null | undefined): string => {
  if (!id) throw new Error('Not signed in.');
  return id;
};

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */

const KNOWN: Array<[RegExp, string | null]> = [
  [/pest_ops_not_enabled/, 'Pest Ops is not enabled for this account.'],
  [/not_permitted/, 'You do not have permission to do this.'],
  [/not_authenticated/, 'Please sign in again.'],
  [/trade_pack_not_enabled/, 'Turn the Pest Control pack on first (Trade Packs).'],
  [/plan_exists/, 'This agreement already has a pest plan.'],
  [/cadence_mismatch/, null],
  [/invalid_term/, null],
  [/term_exceeds_agreement/, null],
  [/invalid_renewal_term/, null],
  [/already_renewed/, 'This plan was already renewed.'],
  [/plan_not_renewable/, 'This plan cannot be renewed in its current state.'],
  [/plan_not_cancellable/, 'This plan cannot be cancelled in its current state.'],
  [/reason_required/, 'Give a reason of 3–500 characters.'],
  [/effective_date_in_past/, 'The effective date cannot be in the past.'],
  [/effective_after_term/, 'Choose a date within the current term.'],
  [/no_service_record/, 'Log the original treatment first, then register the callback.'],
  [/original_is_callback/, 'A callback visit is not itself covered by the guarantee.'],
  [/customer_mismatch/, 'The two jobs belong to different customers.'],
  [/override_reason_required/, 'Give an override reason of at least 5 characters.'],
  [/targets_required/, 'Name 1–12 target pests.'],
  [/recipient_suppressed/, 'This contact opted out of messages.'],
  [/unit_incompatible/, null],
  [/stock_not_tracked/, 'Start tracking stock for this product first.'],
  [/already_tracked/, 'Stock is already tracked for this product.'],
  [/invalid_quantity/, 'Enter a valid quantity.'],
  [/duplicate key|23505/, 'That record already exists.'],
];

export function friendlyPestOpsError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : '';
  if (!raw) return fallback;
  for (const [re, msg] of KNOWN) {
    if (re.test(raw)) {
      if (msg) return msg;
      const i = raw.indexOf(':');
      return i >= 0 ? raw.slice(i + 1).trim() : raw;
    }
  }
  return fallback;
}

/* ------------------------------------------------------------------ */
/* Gate                                                                 */
/* ------------------------------------------------------------------ */

/** Server-side truth for flag AND entitlement. Fails closed. */
export async function fetchPestOpsEnabled(): Promise<boolean> {
  const { data, error } = await supabase.rpc('pest_ops_enabled');
  if (error) return false;
  return data === true;
}

/* ------------------------------------------------------------------ */
/* Plans                                                                */
/* ------------------------------------------------------------------ */

export async function fetchPlans(ownerId: string | null | undefined): Promise<PestPlan[]> {
  const { data, error } = await supabase
    .from('pest_service_plans')
    .select('id, agreement_id, customer_id, cadence, season_from, season_to, term_start, term_end, status, renewal_notice_days, guarantee_days, guarantee_same_target, guarantee_max_callbacks, cancel_effective_on, cancel_reason, created_at, agreement:recurring_agreements(customer_name, address, timezone, preferred_time, start_date, title)')
    .eq('user_id', owner(ownerId))
    .order('term_end', { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data as unknown as PestPlan[]) ?? [];
}

export interface CreatePlanInput {
  agreementId: string;
  cadence: PestCadence;
  seasonFrom: number | null;
  seasonTo: number | null;
  termStart: string;
  termEnd: string;
  renewalNoticeDays: number;
  guaranteeDays: number;
  sameTarget: boolean;
  maxCallbacks: number | null;
}

export async function createPlan(i: CreatePlanInput): Promise<string> {
  const { data, error } = await supabase.rpc('pest_create_plan', {
    p_agreement_id: i.agreementId, p_cadence: i.cadence, p_season_from: i.seasonFrom, p_season_to: i.seasonTo,
    p_term_start: i.termStart, p_term_end: i.termEnd, p_renewal_notice_days: i.renewalNoticeDays,
    p_guarantee_days: i.guaranteeDays, p_guarantee_same_target: i.sameTarget, p_guarantee_max_callbacks: i.maxCallbacks,
  });
  if (error) throw error;
  return (data as { plan_id: string }).plan_id;
}

export async function renewPlan(planId: string, newStart: string, newEnd: string): Promise<void> {
  const { error } = await supabase.rpc('pest_renew_plan', { p_plan_id: planId, p_new_start: newStart, p_new_end: newEnd });
  if (error) throw error;
}

export async function cancelPlan(planId: string, reason: string, effectiveOn: string | null): Promise<{ status: string; jobs_cancelled: number }> {
  const { data, error } = await supabase.rpc('pest_cancel_plan', { p_plan_id: planId, p_reason: reason, p_effective_on: effectiveOn });
  if (error) throw error;
  return data as { status: string; jobs_cancelled: number };
}

/* ------------------------------------------------------------------ */
/* Callbacks                                                            */
/* ------------------------------------------------------------------ */

export async function fetchCallbacks(ownerId: string | null | undefined): Promise<PestCallback[]> {
  const { data, error } = await supabase
    .from('pest_callbacks')
    .select('id, original_job_id, callback_job_id, service_date, requested_on, covered_until, request_targets, outcome, billable, reason, created_at')
    .eq('user_id', owner(ownerId))
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data as PestCallback[]) ?? [];
}

export async function fetchRecentJobs(ownerId: string | null | undefined): Promise<JobOption[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, service_type, address, scheduled_datetime, customer_id')
    .eq('user_id', owner(ownerId))
    .order('scheduled_datetime', { ascending: false, nullsFirst: false })
    .limit(150);
  if (error) throw error;
  return (data as JobOption[]) ?? [];
}

export async function registerCallback(i: { originalJobId: string; callbackJobId: string; requestedOn: string; targets: string[]; timeZone: string; overrideReason?: string }) {
  const { data, error } = await supabase.rpc('pest_register_callback', {
    p_original_job_id: i.originalJobId, p_callback_job_id: i.callbackJobId, p_requested_on: i.requestedOn,
    p_targets: i.targets, p_timezone: i.timeZone, p_override_reason: i.overrideReason?.trim() || null,
  });
  if (error) throw error;
  return data as { id: string; outcome: string; billable: boolean; covered_until: string; reason?: string; existing: boolean };
}

/* ------------------------------------------------------------------ */
/* Notices                                                              */
/* ------------------------------------------------------------------ */

export async function fetchNotices(ownerId: string | null | undefined): Promise<PestNotice[]> {
  const { data, error } = await supabase
    .from('pest_visit_notices')
    .select('id, job_id, kind, channel, send_at, status, attempts, last_error, subject, created_at')
    .eq('user_id', owner(ownerId))
    .order('send_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data as PestNotice[]) ?? [];
}

export async function queueNotice(i: { jobId: string; kind: 'pre_visit' | 'report'; channel: 'email' | 'sms'; sendAt: string; recipient: string; subject: string; body: string }) {
  const { data, error } = await supabase.rpc('pest_queue_notice', {
    p_job_id: i.jobId, p_kind: i.kind, p_channel: i.channel, p_send_at: i.sendAt, p_recipient: i.recipient, p_subject: i.subject, p_body: i.body,
  });
  if (error) throw error;
  return data as { id: string; status: string; created: boolean };
}

export async function cancelNotice(id: string): Promise<void> {
  const { error } = await supabase.rpc('pest_cancel_notice', { p_id: id });
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Stock                                                                */
/* ------------------------------------------------------------------ */

export async function fetchStock(ownerId: string | null | undefined): Promise<PestStockRow[]> {
  const { data, error } = await supabase
    .from('pest_stock')
    .select('id, product_id, unit, on_hand, reorder_point, product:trade_regulated_products(name, epa_reg_number)')
    .eq('user_id', owner(ownerId))
    .limit(500);
  if (error) throw error;
  return ((data as unknown as PestStockRow[]) ?? []).map((r) => ({ ...r, on_hand: Number(r.on_hand), reorder_point: r.reorder_point === null ? null : Number(r.reorder_point) }));
}

export async function fetchMovements(ownerId: string | null | undefined, productId: string): Promise<PestMovement[]> {
  const { data, error } = await supabase
    .from('pest_stock_movements')
    .select('id, product_id, kind, delta, unit, balance_after, note, created_at')
    .eq('user_id', owner(ownerId))
    .eq('product_id', productId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return ((data as PestMovement[]) ?? []).map((m) => ({ ...m, delta: Number(m.delta), balance_after: Number(m.balance_after) }));
}

export async function enableStock(productId: string, opening: number, reorder: number | null): Promise<void> {
  const { error } = await supabase.rpc('pest_stock_enable', { p_product_id: productId, p_opening: opening, p_reorder: reorder });
  if (error) throw error;
}

export async function adjustStock(i: { productId: string; kind: 'receipt' | 'adjustment' | 'count'; quantity: number; unit: string; note?: string }): Promise<boolean> {
  // One key per user action: a double-click or a retry after a timeout cannot apply twice.
  const key = `${crypto.randomUUID()}`;
  const { data, error } = await supabase.rpc('pest_stock_adjust', {
    p_product_id: i.productId, p_kind: i.kind, p_quantity: i.quantity, p_unit: i.unit, p_idempotency_key: key, p_note: i.note?.trim() || null,
  });
  if (error) throw error;
  return (data as { applied: boolean }).applied;
}

export async function reconcileStock(): Promise<number> {
  const { data, error } = await supabase.rpc('pest_stock_reconcile');
  if (error) throw error;
  return (data as { movements_added: number }).movements_added;
}

/* ------------------------------------------------------------------ */
/* Region profile                                                       */
/* ------------------------------------------------------------------ */

export async function fetchRegionProfile(ownerId: string | null | undefined): Promise<PestRegionProfile | null> {
  const { data, error } = await supabase
    .from('pest_region_profiles')
    .select('region_code, required_fields, retention_years, counsel_acknowledged_at')
    .eq('user_id', owner(ownerId))
    .maybeSingle();
  if (error) throw error;
  return (data as PestRegionProfile | null) ?? null;
}

export async function setRegionProfile(i: { region: string; fields: RecordFieldKey[]; retentionYears: number; acknowledge: boolean }): Promise<void> {
  const { error } = await supabase.rpc('pest_set_region_profile', { p_region: i.region, p_fields: i.fields, p_retention: i.retentionYears, p_acknowledge: i.acknowledge });
  if (error) throw error;
}
