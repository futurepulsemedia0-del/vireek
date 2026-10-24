// src/lib/phonePayments.ts
// Client helpers for PCI-safe pay-by-phone. The browser never sees, sends or stores card data:
// it starts/cancels a secure session and reads masked results + the audit trail.
import { supabase } from '@/lib/supabase';

export type PhonePaymentStatus =
  | 'requested' | 'recording_paused' | 'capturing' | 'tokenized' | 'charging'
  | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface PhonePaymentSession {
  id: string;
  job_id: string | null;
  vapi_call_id: string;
  channel: 'ai_agent' | 'staff';
  status: PhonePaymentStatus;
  amount_cents: number;
  failure_code: string | null;
  card_brand: string | null;
  card_last4: string | null;
  recording_paused_at: string | null;
  recording_resumed_at: string | null;
  capture_started_at: string | null;
  capture_ended_at: string | null;
  created_at: string;
}

export interface PhonePaymentAuditEvent {
  id: number;
  seq: number;
  event_type: string;
  actor_type: 'ai_agent' | 'staff' | 'system' | 'provider';
  metadata: Record<string, string | number | boolean | null>;
  event_hash: string;
  created_at: string;
}

export const ACTIVE_STATUSES: PhonePaymentStatus[] = ['requested', 'recording_paused', 'capturing', 'tokenized', 'charging'];
export const isActive = (s: PhonePaymentStatus) => ACTIVE_STATUSES.includes(s);

export const STATUS_LABELS: Record<PhonePaymentStatus, string> = {
  requested: 'Starting', recording_paused: 'Recording paused', capturing: 'Caller entering card on keypad',
  tokenized: 'Card verified', charging: 'Charging', succeeded: 'Paid', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired',
};

export const STATUS_STYLES: Record<PhonePaymentStatus, string> = {
  requested: 'bg-accent/10 text-accent', recording_paused: 'bg-accent/10 text-accent', capturing: 'bg-accent/10 text-accent',
  tokenized: 'bg-accent/10 text-accent', charging: 'bg-accent/10 text-accent', succeeded: 'bg-success-500/15 text-success-500',
  failed: 'bg-danger/10 text-danger', cancelled: 'bg-bg-tertiary text-text-secondary', expired: 'bg-warning-500/15 text-warning-500',
};

export const EVENT_LABELS: Record<string, string> = {
  session_requested: 'Secure payment requested', recording_pause_requested: 'Recording pause requested', recording_paused: 'Call recording paused',
  recording_pause_failed: 'Recording could not be paused — capture blocked', capture_redirect_sent: 'Caller moved to secure keypad line',
  capture_redirect_failed: 'Could not move caller to secure line', capture_started: 'Keypad capture started', capture_progress: 'Caller entered a field',
  capture_completed: 'Card captured and tokenized by provider', capture_failed: 'Capture did not complete', tokenized: 'Token received',
  charge_attempted: 'Charge attempted', charge_succeeded: 'Charge succeeded', charge_failed: 'Charge failed', recording_resumed: 'Call recording resumed',
  recording_resume_failed: 'Recording could not be resumed', session_cancelled: 'Cancelled', session_expired: 'Session expired',
  spoken_card_data_detected: 'Card number spoken aloud — redacted', fallback_payment_link: 'Fell back to secure payment link', callback_rejected: 'Provider callback rejected',
};

export const money = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
export const cardLabel = (brand: string | null, last4: string | null) => (last4 ? `${brand ?? 'card'} •••• ${last4}` : '—');

export class PhonePaymentError extends Error {
  code?: string;
  constructor(message: string, code?: string) { super(message); this.name = 'PhonePaymentError'; this.code = code; }
}

async function control(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data: s } = await supabase.auth.getSession();
  const token = s.session?.access_token;
  const { data, error } = await supabase.functions.invoke('phone-payment-control', { body, headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (error) {
    const ctx = (error as { context?: unknown }).context;
    if (ctx instanceof Response) {
      try {
        const b = (await ctx.clone().json()) as { error?: string; code?: string };
        throw new PhonePaymentError(b.error ?? 'The secure payment could not be started.', b.code);
      } catch (e) { if (e instanceof PhonePaymentError) throw e; }
    }
    throw new PhonePaymentError('Could not reach the server. Check your connection and try again.');
  }
  return (data ?? {}) as Record<string, unknown>;
}

export async function startPhonePayment(vapiCallId: string, jobId: string): Promise<{ sessionId: string; amountCents: number }> {
  const r = await control({ action: 'start', vapi_call_id: vapiCallId, job_id: jobId });
  if (!r.ok || typeof r.session_id !== 'string') throw new PhonePaymentError(String(r.error ?? 'The secure payment did not start.'));
  return { sessionId: r.session_id, amountCents: Number(r.amount_cents ?? 0) };
}

export async function cancelPhonePayment(sessionId: string): Promise<void> {
  await control({ action: 'cancel', session_id: sessionId });
}

const SESSION_COLS = 'id, job_id, vapi_call_id, channel, status, amount_cents, failure_code, card_brand, card_last4, recording_paused_at, recording_resumed_at, capture_started_at, capture_ended_at, created_at';

export async function fetchSession(id: string): Promise<PhonePaymentSession | null> {
  const { data, error } = await supabase.from('phone_payment_sessions').select(SESSION_COLS).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as PhonePaymentSession | null) ?? null;
}

export async function fetchSessions(limit = 100): Promise<PhonePaymentSession[]> {
  const { data, error } = await supabase.from('phone_payment_sessions').select(SESSION_COLS).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as PhonePaymentSession[];
}

export async function fetchAudit(sessionId: string): Promise<PhonePaymentAuditEvent[]> {
  const { data, error } = await supabase.from('phone_payment_audit_events')
    .select('id, seq, event_type, actor_type, metadata, event_hash, created_at').eq('session_id', sessionId).order('seq');
  if (error) throw error;
  return (data ?? []) as PhonePaymentAuditEvent[];
}

export async function verifyChain(sessionId: string): Promise<{ valid: boolean; events: number; firstBadSeq: number | null }> {
  const { data, error } = await supabase.rpc('verify_phone_payment_audit_chain', { p_session_id: sessionId });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) throw error ?? new Error('Verification unavailable');
  return { valid: row.valid === true, events: Number(row.events ?? 0), firstBadSeq: row.first_bad_seq ?? null };
}

export const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;

/** Compliance export: one row per audit event. Contains no card data by construction. */
export function auditToCsv(session: PhonePaymentSession, events: PhonePaymentAuditEvent[]): string {
  const head = ['session_id', 'seq', 'timestamp_utc', 'event', 'actor', 'details', 'event_hash'];
  const rows = events.map((e) => [
    session.id, e.seq, e.created_at, e.event_type, e.actor_type,
    Object.entries(e.metadata).map(([k, v]) => `${k}=${v}`).join('; '), e.event_hash,
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}
