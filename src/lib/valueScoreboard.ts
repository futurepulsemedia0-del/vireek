/**
 * Value Scoreboard — client library (data access + settings form helpers).
 *
 * Every number comes from the append-only `value_events` ledger and is computed by the SAME pure engine
 * the monthly email uses (supabase/functions/_shared/value-scoreboard/engine.ts), so the screen and the
 * email cannot disagree. Server counterpart: supabase/migrations/20271121000000_value_scoreboard.sql
 */

import { supabase } from '@/lib/supabase';
import { parseDollarsToCents, parseRecipients, MAX_EXTRA_RECIPIENTS } from '@/lib/moneyRecovered';
import {
  DEFAULT_TREND_MONTHS,
  computeScoreboard,
  isValidTimeZone,
  monthWindowFor,
  planMonthlyCents,
  shiftMonth,
  type ReviewDecision,
  type Scoreboard,
  type Subscription,
  type ValueEvent,
  type ValueReview,
} from '../../supabase/functions/_shared/value-scoreboard/engine';

export {
  TYPE_LABELS,
  computeScoreboard,
  currentMonthWindow,
  evidencePath,
  featureLabel,
  formatHours,
  formatMoney,
  formatMultiple,
  formatShare,
  methodology,
  monthLabel,
  monthOf,
  monthWindowFor,
  shiftMonth,
} from '../../supabase/functions/_shared/value-scoreboard/engine';
export type { Scoreboard, ValueEvent, ReviewDecision } from '../../supabase/functions/_shared/value-scoreboard/engine';

const PAGE = 1000;
const MAX_ROWS = 50_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ============================================================
// SETTINGS FORM
// ============================================================

export interface ValueSettingsDraft {
  avgTicket: string; // dollars, blank = use the business profile's average job value
  closeRate: string; // percent
  minutesPerCall: string;
  subscriptionOverride: string; // dollars per month, blank = list price of the plan
  timezone: string; // blank = automatic
  emailEnabled: boolean;
  sendHour: string;
  extraRecipients: string;
  caseStudyConsent: boolean;
}

export const defaultSettingsDraft = (): ValueSettingsDraft => ({
  avgTicket: '', closeRate: '25', minutesPerCall: '3', subscriptionOverride: '', timezone: '',
  emailEnabled: false, sendHour: '8', extraRecipients: '', caseStudyConsent: false,
});

export interface ValueSettingsRow {
  user_id: string;
  avg_ticket_cents: number | null;
  close_rate_bp: number;
  minutes_per_handled_call: number;
  subscription_cents_override: number | null;
  timezone: string | null;
  monthly_email_enabled: boolean;
  send_hour: number;
  extra_recipients: string[];
  case_study_consent: boolean;
  case_study_consent_at: string | null;
}

const centsToDollars = (c: number) => (c / 100).toFixed(2).replace(/\.00$/, '');

/** "25" / "25.5" / "25%" -> basis points (0–10000); null when invalid. */
export function parsePercentToBp(input: string): number | null {
  const cleaned = input.replace(/[%\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const bp = Math.round(Number(cleaned) * 100);
  return bp >= 0 && bp <= 10000 ? bp : null;
}

export function validateSettings(d: ValueSettingsDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (d.avgTicket.trim() !== '' && parseDollarsToCents(d.avgTicket) === null) errors.avgTicket = 'Enter an amount like 450 or 450.50.';
  if (parsePercentToBp(d.closeRate) === null) errors.closeRate = 'Enter a percentage from 0 to 100.';
  const min = Number(d.minutesPerCall);
  if (d.minutesPerCall.trim() === '' || !Number.isInteger(min) || min < 0 || min > 60) errors.minutesPerCall = 'Enter whole minutes from 0 to 60.';
  if (d.subscriptionOverride.trim() !== '' && parseDollarsToCents(d.subscriptionOverride) === null) errors.subscriptionOverride = 'Enter your monthly cost like 199 or 199.00.';
  if (d.timezone && !isValidTimeZone(d.timezone)) errors.timezone = 'Choose a valid time zone.';
  const hour = Number(d.sendHour);
  if (d.sendHour.trim() === '' || !Number.isInteger(hour) || hour < 0 || hour > 23) errors.sendHour = 'Enter a whole hour from 0 to 23.';
  const list = parseRecipients(d.extraRecipients);
  if (list.length > MAX_EXTRA_RECIPIENTS) errors.extraRecipients = `Up to ${MAX_EXTRA_RECIPIENTS} extra recipients.`;
  else {
    const bad = list.find((e) => !EMAIL_RE.test(e));
    if (bad) errors.extraRecipients = `"${bad}" is not a valid email address.`;
  }
  return errors;
}

export function draftToRow(userId: string, d: ValueSettingsDraft) {
  return {
    user_id: userId,
    avg_ticket_cents: d.avgTicket.trim() === '' ? null : parseDollarsToCents(d.avgTicket),
    close_rate_bp: parsePercentToBp(d.closeRate) ?? 2500,
    minutes_per_handled_call: Number(d.minutesPerCall),
    subscription_cents_override: d.subscriptionOverride.trim() === '' ? null : parseDollarsToCents(d.subscriptionOverride),
    timezone: d.timezone || null,
    monthly_email_enabled: d.emailEnabled,
    send_hour: Number(d.sendHour),
    extra_recipients: parseRecipients(d.extraRecipients),
    case_study_consent: d.caseStudyConsent,
  };
}

export function rowToDraft(r: Partial<ValueSettingsRow>): ValueSettingsDraft {
  const base = defaultSettingsDraft();
  return {
    avgTicket: r.avg_ticket_cents ? centsToDollars(r.avg_ticket_cents) : base.avgTicket,
    closeRate: r.close_rate_bp === undefined ? base.closeRate : String(r.close_rate_bp / 100),
    minutesPerCall: r.minutes_per_handled_call === undefined ? base.minutesPerCall : String(r.minutes_per_handled_call),
    subscriptionOverride: r.subscription_cents_override ? centsToDollars(r.subscription_cents_override) : base.subscriptionOverride,
    timezone: r.timezone ?? base.timezone,
    emailEnabled: r.monthly_email_enabled ?? base.emailEnabled,
    sendHour: r.send_hour === undefined ? base.sendHour : String(r.send_hour),
    extraRecipients: (r.extra_recipients ?? []).join(', '),
    caseStudyConsent: r.case_study_consent ?? base.caseStudyConsent,
  };
}

export async function fetchSettings(ownerId: string): Promise<ValueSettingsRow | null> {
  const { data, error } = await supabase.from('value_settings').select('*').eq('user_id', ownerId).maybeSingle();
  if (error) throw error;
  return (data as ValueSettingsRow | null) ?? null;
}

export async function saveSettings(ownerId: string, d: ValueSettingsDraft): Promise<void> {
  const { error } = await supabase.from('value_settings').upsert(draftToRow(ownerId, d), { onConflict: 'user_id' });
  if (error) throw error;
}

// ============================================================
// SCOREBOARD
// ============================================================

export interface BoardContext {
  ownerId: string;
  month: string; // YYYY-MM
  timezone: string;
  currency: string;
  plan: string | null;
  subscriptionOverrideCents: number | null;
}

/** Same chain the monthly email uses: owner setting -> business profile -> New York. */
export async function resolveTimezone(ownerId: string, settings: ValueSettingsRow | null): Promise<string> {
  if (settings?.timezone && isValidTimeZone(settings.timezone)) return settings.timezone;
  const { data } = await supabase.from('business_profile').select('timezone').eq('user_id', ownerId).limit(1).maybeSingle();
  const tz = (data as { timezone: string | null } | null)?.timezone;
  return tz && isValidTimeZone(tz) ? tz : 'America/New_York';
}

export function subscriptionFor(ctx: Pick<BoardContext, 'plan' | 'currency' | 'subscriptionOverrideCents'>): Subscription | null {
  if (ctx.subscriptionOverrideCents !== null) return { cents: ctx.subscriptionOverrideCents, currency: ctx.currency };
  const list = planMonthlyCents(ctx.plan);
  return list === null ? null : { cents: list, currency: 'USD' };
}

const EVENT_COLUMNS = 'id,source_feature,type,amount,unit,currency,confidence,method_note,evidence_ref,supersedes_ref,occurred_at';

export async function loadScoreboard(ctx: BoardContext): Promise<Scoreboard> {
  const window = monthWindowFor(ctx.month, ctx.timezone);
  if (!window) throw new Error('Invalid month or time zone.');
  const from = monthWindowFor(shiftMonth(ctx.month, -(DEFAULT_TREND_MONTHS - 1)), ctx.timezone)!.startUtc;

  const events: ValueEvent[] = [];
  for (let off = 0; off < MAX_ROWS; off += PAGE) {
    const { data, error } = await supabase.from('value_events').select(EVENT_COLUMNS)
      .eq('user_id', ctx.ownerId).gte('occurred_at', from).lt('occurred_at', window.endUtc)
      .order('occurred_at', { ascending: true }).order('id', { ascending: true }).range(off, off + PAGE - 1);
    if (error) throw error;
    events.push(...((data ?? []) as ValueEvent[]));
    if (!data || data.length < PAGE) break;
  }
  const reviews: ValueReview[] = [];
  for (let off = 0; off < MAX_ROWS; off += PAGE) {
    const { data, error } = await supabase.from('value_event_reviews').select('value_event_id,decision,decided_at')
      .eq('user_id', ctx.ownerId).order('decided_at', { ascending: true }).range(off, off + PAGE - 1);
    if (error) throw error;
    reviews.push(...((data ?? []) as ValueReview[]));
    if (!data || data.length < PAGE) break;
  }
  return computeScoreboard({ events, reviews, window, currency: ctx.currency, subscription: subscriptionFor(ctx) });
}

/** True when the account has never had a value event (used to run the one-time history import). */
export async function hasAnyEvents(ownerId: string): Promise<boolean> {
  const { count, error } = await supabase.from('value_events').select('id', { count: 'exact', head: true }).eq('user_id', ownerId);
  if (error) throw error;
  return (count ?? 0) > 0;
}

/** Imports the last N days from existing calls / jobs / recovery ledger. Idempotent. Returns rows added. */
export async function importHistory(days = 90): Promise<number> {
  const { data, error } = await supabase.rpc('value_backfill_my_account', { p_days: days });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function reviewEvent(ownerId: string, eventId: string, decision: ReviewDecision, note: string): Promise<void> {
  const { error } = await supabase.from('value_event_reviews').insert({
    user_id: ownerId, value_event_id: eventId, decision, note: note.trim() ? note.trim().slice(0, 500) : null,
  });
  if (error) throw error;
}

// ============================================================
// STATEMENTS (monthly email / PDF)
// ============================================================

export interface ValueStatementRecord {
  id: string;
  month_start: string;
  period_label: string;
  currency: string;
  measured_cents: number;
  estimated_cents: number;
  saved_minutes: number;
  status: 'ready' | 'sent' | 'partial' | 'failed';
  sent_at: string | null;
  last_error: string | null;
  snapshot: Scoreboard;
}

export const STATEMENT_STATUS_LABEL: Record<ValueStatementRecord['status'], string> = {
  ready: 'Ready', sent: 'Sent', partial: 'Partly sent', failed: 'Send failed',
};

export async function fetchStatements(ownerId: string, limit = 12): Promise<ValueStatementRecord[]> {
  const { data, error } = await supabase.from('value_statements')
    .select('id,month_start,period_label,currency,measured_cents,estimated_cents,saved_minutes,status,sent_at,last_error,snapshot')
    .eq('user_id', ownerId).order('month_start', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as ValueStatementRecord[];
}

export async function sendSummaryNow(month: string): Promise<{ ok: boolean; sent: number; failed: number }> {
  const { data, error } = await supabase.functions.invoke('value-scoreboard-run', { body: { action: 'send_now', month } });
  if (error) {
    const msg = (data as { error?: string } | null)?.error;
    throw new Error(msg || 'Could not send the summary. Try again shortly.');
  }
  return data as { ok: boolean; sent: number; failed: number };
}

export async function downloadBoardPdf(board: Scoreboard, companyName: string): Promise<void> {
  const [{ jsPDF }, { buildValuePdf }] = await Promise.all([
    import('jspdf'),
    import('../../supabase/functions/_shared/value-scoreboard/pdf'),
  ]);
  const bytes = buildValuePdf(jsPDF as never, { companyName, board, siteUrl: window.location.origin });
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `vireek-results-${board.window.month}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ============================================================
// STAFF (anonymized aggregates + consented case studies)
// ============================================================

export interface StaffAggregateRow { feature: string; value_type: string; conf: string; ccy: string | null; events: number; accounts: number; total: number }
export interface StaffCaseStudyRow { account_id: string; company: string; ccy: string | null; measured_cents: number; estimated_cents: number; saved_minutes: number; consented_at: string }

export async function fetchStaffAggregates(month: string): Promise<StaffAggregateRow[]> {
  const { data, error } = await supabase.rpc('value_staff_aggregates', { p_month: month });
  if (error) throw error;
  return ((data ?? []) as StaffAggregateRow[]).map((r) => ({ ...r, events: Number(r.events), accounts: Number(r.accounts), total: Number(r.total) }));
}

export async function fetchStaffCaseStudies(month: string): Promise<StaffCaseStudyRow[]> {
  const { data, error } = await supabase.rpc('value_staff_case_studies', { p_month: month });
  if (error) throw error;
  return ((data ?? []) as StaffCaseStudyRow[]).map((r) => ({
    ...r, measured_cents: Number(r.measured_cents), estimated_cents: Number(r.estimated_cents), saved_minutes: Number(r.saved_minutes),
  }));
}
