/**
 * Homeowner payment protection — state machine, money helpers and server wrappers.
 *
 * The transition table below MUST equal the seed in
 * supabase/migrations/20290312000100_homeowner_payment_protection.sql (paymentProtection.test.ts compares them).
 * The database enforces it (pp_apply_transition); this copy drives the UI and is unit-tested.
 * Design and licensing gate: docs/payments/homeowner-payment-protection.md
 */

import { supabase } from '@/lib/supabase';

export const PP_FLAG = 'homeowner_payment_protection';

export type HoldState =
  | 'draft' | 'awaiting_authorization' | 'held' | 'completion_claimed' | 'disputed'
  | 'capturing' | 'voiding' | 'released' | 'voided' | 'expired' | 'failed' | 'needs_review';

export type ActorKind = 'contractor' | 'homeowner' | 'system' | 'staff';

export type HoldEvent =
  | 'send_request' | 'cancel' | 'authorized' | 'authorization_failed' | 'expire' | 'claim_completion'
  | 'request_void' | 'open_dispute' | 'homeowner_confirm' | 'auto_release' | 'resolve_release'
  | 'resolve_void' | 'capture_succeeded' | 'capture_failed' | 'void_succeeded' | 'void_failed'
  | 'resolve_capture' | 'resolve_expired';

export interface Transition { from: HoldState; event: HoldEvent; to: HoldState; actor: ActorKind }

export const TRANSITIONS: readonly Transition[] = [
  { from: 'draft', event: 'send_request', to: 'awaiting_authorization', actor: 'contractor' },
  { from: 'draft', event: 'cancel', to: 'voided', actor: 'contractor' },
  { from: 'awaiting_authorization', event: 'authorized', to: 'held', actor: 'homeowner' },
  { from: 'awaiting_authorization', event: 'authorized', to: 'held', actor: 'system' },
  { from: 'awaiting_authorization', event: 'authorization_failed', to: 'failed', actor: 'system' },
  { from: 'awaiting_authorization', event: 'cancel', to: 'voided', actor: 'contractor' },
  { from: 'awaiting_authorization', event: 'expire', to: 'expired', actor: 'system' },
  { from: 'held', event: 'claim_completion', to: 'completion_claimed', actor: 'contractor' },
  { from: 'held', event: 'request_void', to: 'voiding', actor: 'contractor' },
  { from: 'held', event: 'open_dispute', to: 'disputed', actor: 'homeowner' },
  { from: 'held', event: 'expire', to: 'expired', actor: 'system' },
  { from: 'completion_claimed', event: 'homeowner_confirm', to: 'capturing', actor: 'homeowner' },
  { from: 'completion_claimed', event: 'auto_release', to: 'capturing', actor: 'system' },
  { from: 'completion_claimed', event: 'open_dispute', to: 'disputed', actor: 'homeowner' },
  { from: 'completion_claimed', event: 'request_void', to: 'voiding', actor: 'contractor' },
  { from: 'completion_claimed', event: 'expire', to: 'expired', actor: 'system' },
  { from: 'disputed', event: 'resolve_release', to: 'capturing', actor: 'staff' },
  { from: 'disputed', event: 'resolve_void', to: 'voiding', actor: 'staff' },
  { from: 'disputed', event: 'expire', to: 'expired', actor: 'system' },
  { from: 'capturing', event: 'capture_succeeded', to: 'released', actor: 'system' },
  { from: 'capturing', event: 'capture_failed', to: 'needs_review', actor: 'system' },
  { from: 'voiding', event: 'void_succeeded', to: 'voided', actor: 'system' },
  { from: 'voiding', event: 'void_failed', to: 'needs_review', actor: 'system' },
  { from: 'needs_review', event: 'resolve_capture', to: 'capturing', actor: 'staff' },
  { from: 'needs_review', event: 'resolve_void', to: 'voiding', actor: 'staff' },
  { from: 'needs_review', event: 'resolve_expired', to: 'expired', actor: 'staff' },
];

export const ALL_STATES: readonly HoldState[] = [
  'draft', 'awaiting_authorization', 'held', 'completion_claimed', 'disputed', 'capturing',
  'voiding', 'released', 'voided', 'expired', 'failed', 'needs_review',
];
export const TERMINAL_STATES: readonly HoldState[] = ['released', 'voided', 'expired', 'failed'];

export const isTerminal = (s: HoldState): boolean => TERMINAL_STATES.includes(s);

/** Next state, or null when the transition is not allowed. Never throws. */
export function nextState(from: HoldState, event: HoldEvent, actor: ActorKind): HoldState | null {
  return TRANSITIONS.find((t) => t.from === from && t.event === event && t.actor === actor)?.to ?? null;
}

/** Events an actor may fire from a state (drives which buttons render). */
export function allowedEvents(from: HoldState, actor: ActorKind): HoldEvent[] {
  return TRANSITIONS.filter((t) => t.from === from && t.actor === actor).map((t) => t.event);
}

/** Whether funds are currently reserved on the homeowner's card. */
export function isFundsReserved(s: HoldState): boolean {
  return s === 'held' || s === 'completion_claimed' || s === 'disputed' || s === 'capturing' || s === 'voiding' || s === 'needs_review';
}

/** Whether the homeowner can still dispute (before capture begins). */
export function canHomeownerDispute(s: HoldState): boolean {
  return nextState(s, 'open_dispute', 'homeowner') !== null;
}

/**
 * Mirrors pp_claim_completion: release is the earlier of (claimedAt + autoReleaseHours) and
 * (captureBefore - marginHours). Returns null when it would fall within one hour of `now` (pp_window_too_short).
 */
export function computeReleaseDueAt(
  now: Date, autoReleaseHours: number, captureBefore: Date | null, marginHours: number,
): Date | null {
  const byPolicy = now.getTime() + autoReleaseHours * 3_600_000;
  const byCard = captureBefore ? captureBefore.getTime() - marginHours * 3_600_000 : Number.POSITIVE_INFINITY;
  const due = Math.min(byPolicy, byCard);
  return due <= now.getTime() + 3_600_000 ? null : new Date(due);
}

/** Partial release must leave something on each side (mirrors pp_partial_amount_invalid). */
export function isValidPartialAmount(amountCents: number, totalCents: number): boolean {
  return Number.isInteger(amountCents) && amountCents >= 1 && amountCents < totalCents;
}

export function formatMoney(cents: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

// ---------------------------------------------------------------- server wrappers

export interface HoldRow {
  id: string; job_id: string; customer_id: string | null; amount_cents: number; currency: string;
  hold_mode: 'auth_hold'; state: HoldState; capture_before: string | null; capture_amount_cents: number | null;
  amount_captured_cents: number; claimed_at: string | null; release_due_at: string | null;
  token_expires_at: string | null; version: number; created_at: string; updated_at: string;
}

export interface HoldDetail {
  hold: Pick<HoldRow, 'id' | 'job_id' | 'amount_cents' | 'currency' | 'state' | 'capture_before' | 'capture_amount_cents'
    | 'amount_captured_cents' | 'claimed_at' | 'release_due_at' | 'created_at'>;
  events: Array<{ at: string; event: string; from: HoldState | null; to: HoldState; actor: ActorKind }>;
  dispute: null | {
    id: string; reason_code: string; statement: string; status: 'open' | 'resolved'; resolution: string | null;
    resolved_amount_cents: number | null; resolution_note: string | null; created_at: string; evidence_sha256: string;
    evidence: Record<string, unknown>; notes: Array<{ author: string; body: string; at: string }>;
  };
}

export type ProtectionAction = 'create' | 'send_request' | 'claim_completion' | 'void' | 'respond' | 'staff_resolve';

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('payment-protection', { body });
  if (error) throw error;
  if (data && typeof data === 'object' && 'error' in data) throw new Error(String((data as { error: unknown }).error));
  return data as T;
}

export async function listHolds(): Promise<HoldRow[]> {
  const { data, error } = await supabase
    .from('payment_protection_holds')
    .select('id, job_id, customer_id, amount_cents, currency, hold_mode, state, capture_before, capture_amount_cents, amount_captured_cents, claimed_at, release_due_at, token_expires_at, version, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as HoldRow[];
}

export async function fetchHoldDetail(holdId: string): Promise<HoldDetail | null> {
  const { data, error } = await supabase.rpc('pp_get_hold_detail', { p_hold: holdId });
  if (error) throw error;
  return (data as HoldDetail | null) ?? null;
}

export const createHold = (jobId: string, amountCents: number, currency = 'usd') =>
  invoke<{ hold_id: string }>({ action: 'create', job_id: jobId, amount_cents: amountCents, currency });
/** Returns the one-time homeowner link. It is shown once and never stored in plain text. */
export const sendRequest = (holdId: string) => invoke<{ url: string; expires_at: string }>({ action: 'send_request', hold_id: holdId });
export const claimCompletion = (holdId: string) => invoke<{ state: HoldState }>({ action: 'claim_completion', hold_id: holdId });
export const voidHold = (holdId: string) => invoke<{ state: HoldState }>({ action: 'void', hold_id: holdId });
export const respondToDispute = (holdId: string, body: string) => invoke<{ ok: true }>({ action: 'respond', hold_id: holdId, body });
export const staffResolveDispute = (
  holdId: string, resolution: 'release_full' | 'release_partial' | 'void', note: string, amountCents?: number,
) => invoke<{ state: HoldState }>({ action: 'staff_resolve', hold_id: holdId, resolution, note, amount_cents: amountCents });

// ---------------------------------------------------------------- staff + homeowner wrappers
export interface PpControls {
  enabled: boolean; licensing_confirmed_ref: string | null; licensing_confirmed_at: string | null; max_amount_cents: number;
  auto_release_hours: number | null; min_completion_evidence: number; expiry_margin_hours: number; killed_at: string | null; kill_reason: string | null;
}
export async function staffGetControls(): Promise<PpControls | null> {
  const { data, error } = await supabase.rpc('staff_pp_get_controls');
  if (error) throw error;
  return (data as PpControls | null) ?? null;
}
export async function staffUpdateControls(patch: Record<string, unknown>, reason: string): Promise<void> {
  const { error } = await supabase.rpc('staff_pp_update_controls', { p_patch: patch, p_reason: reason });
  if (error) throw error;
}
export async function staffKill(reason: string, release = false): Promise<void> {
  const { error } = await supabase.rpc('staff_pp_kill', { p_reason: reason, p_release: release });
  if (error) throw error;
}
export interface OpenDisputeRow { dispute_id: string; hold_id: string; reason_code: string; created_at: string; amount_cents: number; currency: string; capture_before: string | null; state: HoldState }
export async function staffListDisputes(): Promise<OpenDisputeRow[]> {
  const { data, error } = await supabase.rpc('staff_pp_list_disputes', { p_limit: 50 });
  if (error) throw error;
  return (data as OpenDisputeRow[] | null) ?? [];
}

export interface HomeownerView {
  id: string; state: HoldState; amount_cents: number; currency: string; capture_before: string | null; release_due_at: string | null;
  claimed_at: string | null; business_name: string; service_type: string | null; dispute_open: boolean;
}
export async function homeownerCall<T>(token: string, action: 'view' | 'authorize' | 'sync' | 'confirm' | 'dispute', extra: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>({ token, action, ...extra });
}
