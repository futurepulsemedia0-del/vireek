import { supabase } from '@/lib/supabase';

/**
 * Offboarding — client library for /dashboard/billing/offboarding, /winback/unsubscribe/:token
 * and /staff/offboarding.
 *
 * All state changes go through SECURITY DEFINER RPCs that resolve the caller with auth.uid():
 * the client never sends a user id. The one direct write is the owner's own full_account
 * deletion request (RLS: owner insert / cancel-while-in-grace), which is the EXISTING erasure
 * pipeline (deletion_requests + data-retention-sweep + legal-hold trigger) — not a new one.
 */

export const CONSENT_VERSION = 'winback-v1';
/** Mirrors deletion_requests.grace_period_days DEFAULT 14 (20261121000000_disaster_recovery_data_governance.sql). */
export const DELETION_GRACE_DAYS = 14;
export const MAX_WINBACK_MESSAGES = 2;

export type CaseStatus = 'scheduled' | 'ended' | 'withdrawn' | 'reactivated';
export type DeletionStatus = 'grace_period' | 'processing' | 'blocked_legal_hold' | 'completed';

export interface OffboardingCase {
  id: string;
  status: CaseStatus;
  reason: string | null;
  accessEndsAt: string | null;
  exportStartedAt: string | null;
  winbackAvailable: boolean;
  winbackOptedIn: boolean;
  winbackMessages: { seq: 1 | 2; status: string; scheduledFor: string | null }[];
  deletion: { id: string; status: DeletionStatus; scheduledFor: string | null } | null;
}

const CASE_STATUSES: CaseStatus[] = ['scheduled', 'ended', 'withdrawn', 'reactivated'];
const DELETION_STATUSES: DeletionStatus[] = ['grace_period', 'processing', 'blocked_legal_hold', 'completed'];

const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown, d = 0) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};

/** Defensive parse of offboarding_my_case(). Returns null when there is nothing to show. */
export function parseCase(raw: unknown): OffboardingCase | null {
  const o = rec(raw);
  if (typeof o.id !== 'string' || !CASE_STATUSES.includes(o.status as CaseStatus)) return null;
  const msgs = Array.isArray(o.winback_messages) ? o.winback_messages : [];
  const del = rec(o.deletion);
  return {
    id: o.id,
    status: o.status as CaseStatus,
    reason: typeof o.reason === 'string' ? o.reason : null,
    accessEndsAt: isoOrNull(o.access_ends_at),
    exportStartedAt: isoOrNull(o.export_started_at),
    winbackAvailable: o.winback_available === true,
    winbackOptedIn: o.winback_opted_in === true,
    winbackMessages: msgs
      .map((m) => rec(m))
      .filter((m) => m.seq === 1 || m.seq === 2)
      .map((m) => ({ seq: m.seq as 1 | 2, status: String(m.status ?? ''), scheduledFor: isoOrNull(m.scheduled_for) })),
    deletion:
      typeof del.id === 'string' && DELETION_STATUSES.includes(del.status as DeletionStatus)
        ? { id: del.id, status: del.status as DeletionStatus, scheduledFor: isoOrNull(del.scheduled_for) }
        : null,
  };
}

// ============================================================
// TIMELINE (pure: tested without a database)
// ============================================================

export type StepKey = 'cancellation' | 'accessEnd' | 'export' | 'deletion';
export type StepState = 'done' | 'current' | 'upcoming' | 'attention';

export interface TimelineStep {
  key: StepKey;
  state: StepState;
  /** i18n variant of the step copy (offboarding.timeline.<key>.<variant>). */
  variant: string;
  date: string | null;
}

/**
 * The timeline only states what the system actually does:
 *  - access ends at the paid-period end (Stripe, recorded server-side);
 *  - export is available while the owner can sign in (self-serve, owner/admin);
 *  - deletion happens only when a deletion request exists (14-day cancellable grace) — otherwise data is kept
 *    under the published retention policy. We never promise an automatic purge date.
 */
export function buildTimeline(c: OffboardingCase, now: Date = new Date()): TimelineStep[] {
  const ends = c.accessEndsAt ? new Date(c.accessEndsAt) : null;
  const accessOver = c.status === 'ended' || c.status === 'reactivated' || (ends !== null && ends.getTime() <= now.getTime());

  const deletion: TimelineStep = (() => {
    const d = c.deletion;
    if (!d) return { key: 'deletion', state: 'upcoming', variant: 'none', date: null };
    if (d.status === 'grace_period') return { key: 'deletion', state: 'current', variant: 'grace', date: d.scheduledFor };
    if (d.status === 'processing') return { key: 'deletion', state: 'current', variant: 'processing', date: null };
    if (d.status === 'blocked_legal_hold') return { key: 'deletion', state: 'attention', variant: 'blocked', date: null };
    return { key: 'deletion', state: 'done', variant: 'completed', date: null };
  })();

  return [
    { key: 'cancellation', state: 'done', variant: 'scheduled', date: null },
    { key: 'accessEnd', state: accessOver ? 'done' : 'current', variant: accessOver ? 'ended' : 'upcoming', date: c.accessEndsAt },
    { key: 'export', state: c.exportStartedAt ? 'done' : accessOver ? 'attention' : 'current', variant: c.exportStartedAt ? 'started' : 'todo', date: c.exportStartedAt },
    deletion,
  ];
}

export function daysFromNow(iso: string | null, now: Date = new Date()): number | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  return Math.ceil((Date.parse(iso) - now.getTime()) / 86_400_000);
}

// ============================================================
// OWNER RPCs
// ============================================================

export async function fetchMyCase(): Promise<OffboardingCase | null> {
  const { data, error } = await supabase.rpc('offboarding_my_case');
  if (error) throw new Error(error.message);
  return parseCase(data);
}

export async function recordExportStarted(): Promise<void> {
  // Best effort: a bookkeeping failure must never block the download itself.
  try {
    await supabase.rpc('offboarding_record_export');
  } catch {
    /* ignore */
  }
}

export async function setWinbackConsent(optIn: boolean): Promise<OffboardingCase | null> {
  const { data, error } = await supabase.rpc('offboarding_set_winback_consent', { p_opt_in: optIn, p_consent_version: CONSENT_VERSION });
  if (error) throw new Error(error.message);
  return parseCase(data);
}

export async function requestAccountDeletion(): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  const uid = u.user?.id;
  if (!uid) throw new Error('not_signed_in');
  const { error } = await supabase.from('deletion_requests').insert({
    user_id: uid,
    requested_by: uid,
    request_type: 'full_account',
    reason: 'offboarding',
    grace_period_days: DELETION_GRACE_DAYS,
    scheduled_for: new Date(Date.now() + DELETION_GRACE_DAYS * 86_400_000).toISOString(),
  });
  if (error) throw new Error(error.message);
}

export async function cancelAccountDeletion(requestId: string): Promise<void> {
  const { error } = await supabase.from('deletion_requests').update({ status: 'cancelled' }).eq('id', requestId);
  if (error) throw new Error(error.message);
}

// ============================================================
// PUBLIC UNSUBSCRIBE
// ============================================================

export interface UnsubscribeLookup {
  company: string | null;
  already: boolean;
}

async function callUnsubscribe(body: { token: string; action: 'lookup' | 'unsubscribe' }): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!base) throw new Error('not_configured');
  const res = await fetch(`${base.replace(/\/$/, '')}/functions/v1/winback-unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(anon ? { apikey: anon } : {}) },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok && data.success === true, status: res.status, data };
}

/** null = the link is not valid. */
export async function lookupUnsubscribe(token: string): Promise<UnsubscribeLookup | null> {
  const r = await callUnsubscribe({ token, action: 'lookup' });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error('lookup_failed');
  return { company: typeof r.data.company === 'string' ? r.data.company : null, already: r.data.already === true };
}

export async function confirmUnsubscribe(token: string): Promise<boolean> {
  const r = await callUnsubscribe({ token, action: 'unsubscribe' });
  if (r.status === 404 || r.status === 400) return false;
  if (!r.ok) throw new Error('unsubscribe_failed');
  return true;
}

// ============================================================
// STAFF
// ============================================================

export interface OffboardingFunnel {
  cases: number;
  ended: number;
  withdrawn: number;
  exported: number;
  optedIn: number;
  unsubscribed: number;
  sent1: number;
  sent2: number;
  failed: number;
  reactivated: number;
  reactivatedAttributed: number;
}

export interface OffboardingSettings {
  winbackEnabled: boolean;
  firstMessageDelayDays: number;
  secondMessageGapDays: number;
  attributionDays: number;
}

export interface OffboardingOverview {
  days: number;
  settings: OffboardingSettings;
  funnel: OffboardingFunnel;
  reasons: { reason: string; cases: number; withdrawn: number; optedIn: number; reactivated: number }[];
}

export function parseOverview(raw: unknown): OffboardingOverview {
  const o = rec(raw);
  const s = rec(o.settings);
  const f = rec(o.funnel);
  return {
    days: num(o.days, 90),
    settings: {
      winbackEnabled: s.winback_enabled === true,
      firstMessageDelayDays: num(s.first_message_delay_days, 7),
      secondMessageGapDays: num(s.second_message_gap_days, 30),
      attributionDays: num(s.attribution_days, 30),
    },
    funnel: {
      cases: num(f.cases),
      ended: num(f.ended),
      withdrawn: num(f.withdrawn),
      exported: num(f.exported),
      optedIn: num(f.opted_in),
      unsubscribed: num(f.unsubscribed),
      sent1: num(f.sent_1),
      sent2: num(f.sent_2),
      failed: num(f.failed),
      reactivated: num(f.reactivated),
      reactivatedAttributed: num(f.reactivated_attributed),
    },
    reasons: (Array.isArray(o.reasons) ? o.reasons : []).map((r) => {
      const x = rec(r);
      return { reason: String(x.reason ?? 'unknown'), cases: num(x.cases), withdrawn: num(x.withdrawn), optedIn: num(x.opted_in), reactivated: num(x.reactivated) };
    }),
  };
}

/** Share as a whole-number percent; 0 when the denominator is 0 (never NaN). */
export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

export async function fetchOffboardingOverview(days = 90): Promise<OffboardingOverview> {
  const { data, error } = await supabase.rpc('staff_offboarding_overview', { p_days: days });
  if (error) throw new Error(error.message);
  return parseOverview(data);
}

export const SETTINGS_LIMITS = { firstDelay: [1, 90], gap: [7, 180], attribution: [1, 90] } as const;

export function validateSettings(s: OffboardingSettings): string | null {
  const inRange = (v: number, [lo, hi]: readonly [number, number] | readonly number[]) => Number.isInteger(v) && v >= (lo as number) && v <= (hi as number);
  if (!inRange(s.firstMessageDelayDays, SETTINGS_LIMITS.firstDelay)) return 'firstDelay';
  if (!inRange(s.secondMessageGapDays, SETTINGS_LIMITS.gap)) return 'gap';
  if (!inRange(s.attributionDays, SETTINGS_LIMITS.attribution)) return 'attribution';
  return null;
}

export async function saveOffboardingSettings(s: OffboardingSettings): Promise<void> {
  const bad = validateSettings(s);
  if (bad) throw new Error(`invalid_${bad}`);
  const { error } = await supabase.rpc('staff_offboarding_update_settings', {
    p_winback_enabled: s.winbackEnabled,
    p_first_delay: s.firstMessageDelayDays,
    p_gap: s.secondMessageGapDays,
    p_attribution: s.attributionDays,
  });
  if (error) throw new Error(error.message);
}
