/**
 * Staff customer explorer — data access.
 *
 * Staff NEVER get blanket table access to tenant data. Everything goes through
 * SECURITY DEFINER RPCs that (1) verify profiles.is_staff on the server and
 * (2) write an append-only staff_audit_log row. Scoring + impersonation rules
 * live in supabase/functions/_shared/staff/accountExplorer.ts (pure, shared with
 * the edge function) and are re-exported here.
 */

import { supabase } from '@/lib/supabase';
import {
  computeHealth,
  type AccountSignals,
  type ExplorerRow,
  type HealthResult,
} from '../../supabase/functions/_shared/staff/accountExplorer';

export * from '../../supabase/functions/_shared/staff/accountExplorer';

// ============================================================
// TYPES
// ============================================================

export interface StaffAccount extends ExplorerRow {
  plan: string;
  status: AccountSignals['status'];
  subscriptionStatus: AccountSignals['subscriptionStatus'];
  isStaff: boolean;
  signals: AccountSignals;
}

export interface AccountOverview {
  accounts: StaffAccount[];
  /** True when the account count hit the server cap and the list is incomplete. */
  truncated: boolean;
}

export interface DailyUsage {
  day: string;
  calls: number;
  minutes: number;
}

export interface RecentCall {
  id: string;
  at: string;
  durationSeconds: number | null;
  status: string;
  isEmergency: boolean;
  callerMasked: string;
}

export interface AccountDetail {
  id: string;
  email: string;
  companyName: string | null;
  fullName: string | null;
  plan: string;
  status: string;
  subscriptionStatus: string;
  minutesUsed: number;
  minutesIncluded: number;
  daily: DailyUsage[];
  recentCalls: RecentCall[];
  team: { name: string; role: string }[];
  numbers: string[];
  staffAccess: StaffAuditEntry[];
}

export interface StaffAuditEntry {
  id: string;
  staffEmail: string | null;
  action: string;
  targetAccountId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface ImpersonationGrant {
  sessionId: string;
  expiresAt: string;
  link: string;
}

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  explorer_list: 'Opened the account explorer',
  account_view: 'Viewed an account',
  impersonation_start: 'Signed in as customer',
  impersonation_end: 'Ended customer session',
  impersonation_denied: 'Impersonation denied',
};

// ============================================================
// HELPERS
// ============================================================

type Row = Record<string, unknown>;
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

function toAccount(r: Row, now: Date): StaffAccount {
  const status = (['active', 'suspended', 'canceled'].includes(str(r.status)) ? str(r.status) : 'active') as AccountSignals['status'];
  const sub = (['active', 'past_due', 'suspended'].includes(str(r.subscription_status)) ? str(r.subscription_status) : 'active') as AccountSignals['subscriptionStatus'];
  const signals: AccountSignals = {
    id: str(r.id),
    status,
    subscriptionStatus: sub,
    dunningStage: num(r.dunning_stage),
    onboardingCompleted: r.onboarding_completed === true,
    minutesUsed: num(r.minutes_used),
    minutesIncluded: num(r.minutes_included),
    createdAt: str(r.created_at),
    lastSignInAt: strOrNull(r.last_sign_in_at),
    lastCallAt: strOrNull(r.last_call_at),
    calls30d: num(r.calls_30d),
    callsPrev30d: num(r.calls_prev_30d),
    bookings30d: num(r.bookings_30d),
    teamCount: num(r.team_count),
    numbersCount: num(r.numbers_count),
  };
  const health: HealthResult = computeHealth(signals, now);
  return {
    id: signals.id,
    companyName: strOrNull(r.company_name),
    fullName: strOrNull(r.full_name),
    email: str(r.email),
    plan: str(r.plan, 'unknown'),
    status,
    subscriptionStatus: sub,
    isStaff: r.is_staff === true,
    health,
    calls30d: signals.calls30d,
    createdAt: signals.createdAt,
    lastCallAt: signals.lastCallAt,
    signals,
  };
}

const toAudit = (r: Row): StaffAuditEntry => ({
  id: str(r.id),
  staffEmail: strOrNull(r.staff_email),
  action: str(r.action),
  targetAccountId: strOrNull(r.target_account_id),
  reason: strOrNull(r.reason),
  createdAt: str(r.created_at),
});

// ============================================================
// RPCs
// ============================================================

export const OVERVIEW_LIMIT = 2000;

export async function fetchAccountOverview(): Promise<AccountOverview> {
  const { data, error } = await supabase.rpc('staff_account_overview', { p_limit: OVERVIEW_LIMIT });
  if (error) throw error;
  const now = new Date();
  const accounts = ((data ?? []) as Row[]).map((r) => toAccount(r, now));
  return { accounts, truncated: accounts.length >= OVERVIEW_LIMIT };
}

export async function fetchAccountDetail(accountId: string): Promise<AccountDetail> {
  const { data, error } = await supabase.rpc('staff_account_detail', { p_account: accountId });
  if (error) throw error;
  const d = (data ?? {}) as Row;
  if (!d.id) throw new Error('Account not found.');
  const list = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
  return {
    id: str(d.id),
    email: str(d.email),
    companyName: strOrNull(d.company_name),
    fullName: strOrNull(d.full_name),
    plan: str(d.plan, 'unknown'),
    status: str(d.status),
    subscriptionStatus: str(d.subscription_status),
    minutesUsed: num(d.minutes_used),
    minutesIncluded: num(d.minutes_included),
    daily: list(d.daily).map((x) => ({ day: str(x.day), calls: num(x.calls), minutes: num(x.minutes) })),
    recentCalls: list(d.recent_calls).map((x) => ({
      id: str(x.id),
      at: str(x.call_datetime),
      durationSeconds: x.duration_seconds === null || x.duration_seconds === undefined ? null : num(x.duration_seconds),
      status: str(x.status),
      isEmergency: x.is_emergency === true,
      callerMasked: str(x.caller_masked, 'Unknown'),
    })),
    team: list(d.team).map((x) => ({ name: str(x.name, 'Unnamed'), role: str(x.role) })),
    numbers: list(d.numbers).map((x) => str(x.phone_number)).filter(Boolean),
    staffAccess: list(d.staff_access).map(toAudit),
  };
}

export async function fetchStaffAudit(limit = 100): Promise<StaffAuditEntry[]> {
  const { data, error } = await supabase
    .from('staff_audit_log')
    .select('id, staff_email, action, target_account_id, reason, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Row[]).map(toAudit);
}

// ============================================================
// IMPERSONATION (server-enforced; see staff-impersonate edge function)
// ============================================================

async function invokeImpersonation(body: Record<string, unknown>): Promise<Row> {
  const { data, error } = await supabase.functions.invoke('staff-impersonate', { body });
  if (error) {
    // Surface the server's own message (e.g. rate limit, denied target) instead of a generic one.
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const payload = (await ctx.json()) as { error?: string };
        if (payload?.error) throw new Error(payload.error);
      } catch (inner) {
        if (inner instanceof Error && inner.message) throw inner;
      }
    }
    throw new Error('Could not start the session. Please try again.');
  }
  return (data ?? {}) as Row;
}

export async function startImpersonation(accountId: string, reason: string, ticketRef: string): Promise<ImpersonationGrant> {
  const d = await invokeImpersonation({ action: 'start', accountId, reason, ticketRef: ticketRef.trim() || null });
  if (!d.link || !d.sessionId) throw new Error('The server did not return a sign-in link.');
  return { sessionId: str(d.sessionId), expiresAt: str(d.expiresAt), link: str(d.link) };
}

export async function endImpersonation(sessionId: string): Promise<void> {
  await invokeImpersonation({ action: 'end', sessionId });
}
