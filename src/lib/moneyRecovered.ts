/**
 * Weekly "Money Recovered" statement — client library.
 *
 * Extends the Missed-Revenue Recovery Ledger (revenueRecovery.ts). It never computes its own
 * revenue: figures come from revenue_recovery_events and are attributed by the SAME pure engine
 * the edge function uses (supabase/functions/_shared/money-recovered/engine.ts), so the live
 * preview on screen and the statement that gets emailed cannot disagree.
 */

import { supabase } from '@/lib/supabase';
import {
  computeStatement,
  currentWeekWindow,
  isValidTimeZone,
  previousWeekWindow,
  type Baseline,
  type CallInfo,
  type LedgerEvent,
  type Statement,
  type Window,
} from '../../supabase/functions/_shared/money-recovered/engine';
import { buildStatementPdf } from '../../supabase/functions/_shared/money-recovered/pdf';

export type { Statement, StatementRow, Window } from '../../supabase/functions/_shared/money-recovered/engine';
export {
  CATEGORY_LABELS,
  METHODOLOGY,
  REASON_LABELS,
  attribute,
  categoryOf,
  formatMoney,
  formatPct,
} from '../../supabase/functions/_shared/money-recovered/engine';

// ============================================================
// SETTINGS FORM
// ============================================================

export interface StatementSettingsDraft {
  enabled: boolean;
  send_hour: string;
  timezone: string;
  include_owner: boolean;
  include_co_owners: boolean;
  extra_recipients: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EXTRA_RECIPIENTS = 10;

export const defaultDraft = (timezone = 'America/New_York'): StatementSettingsDraft => ({
  enabled: false,
  send_hour: '8',
  timezone,
  include_owner: true,
  include_co_owners: true,
  extra_recipients: '',
});

/** Splits on commas, semicolons and whitespace; lower-cases; removes duplicates. */
export function parseRecipients(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

export function validateDraft(d: StatementSettingsDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const hour = Number(d.send_hour);
  if (d.send_hour.trim() === '' || !Number.isInteger(hour) || hour < 0 || hour > 23) errors.send_hour = 'Enter a whole hour from 0 to 23.';
  if (!isValidTimeZone(d.timezone)) errors.timezone = 'Choose a valid time zone.';
  const list = parseRecipients(d.extra_recipients);
  if (list.length > MAX_EXTRA_RECIPIENTS) errors.extra_recipients = `Up to ${MAX_EXTRA_RECIPIENTS} extra recipients.`;
  else {
    const bad = list.find((e) => !EMAIL_RE.test(e));
    if (bad) errors.extra_recipients = `"${bad}" is not a valid email address.`;
  }
  if (d.enabled && !d.include_owner && !d.include_co_owners && list.length === 0) {
    errors.extra_recipients = 'Choose at least one recipient.';
  }
  return errors;
}

export function draftToRow(userId: string, d: StatementSettingsDraft) {
  return {
    user_id: userId,
    enabled: d.enabled,
    send_hour: Number(d.send_hour),
    timezone: d.timezone,
    include_owner: d.include_owner,
    include_co_owners: d.include_co_owners,
    extra_recipients: parseRecipients(d.extra_recipients),
  };
}

export function rowToDraft(r: Partial<ReturnType<typeof draftToRow>>): StatementSettingsDraft {
  const base = defaultDraft();
  return {
    enabled: r.enabled ?? base.enabled,
    send_hour: r.send_hour === undefined ? base.send_hour : String(r.send_hour),
    timezone: r.timezone || base.timezone,
    include_owner: r.include_owner ?? base.include_owner,
    include_co_owners: r.include_co_owners ?? base.include_co_owners,
    extra_recipients: (r.extra_recipients ?? []).join(', '),
  };
}

/** "1,250.50" / "$1250" -> cents; null if not a positive amount within sane bounds. */
export function parseDollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return cents > 0 && cents <= 100_000_000_000 ? cents : null;
}

// ============================================================
// QUERIES
// ============================================================

export interface StatementRecord {
  id: string;
  week_start: string;
  week_end: string;
  period_label: string;
  credited_cents: number;
  status: 'ready' | 'sent' | 'partial' | 'failed';
  generated_at: string;
  sent_at: string | null;
  last_error: string | null;
  snapshot: Statement;
}

export const STATUS_LABEL: Record<StatementRecord['status'], string> = {
  ready: 'Ready',
  sent: 'Sent',
  partial: 'Partly sent',
  failed: 'Send failed',
};

export async function fetchSettings(userId: string): Promise<StatementSettingsDraft | null> {
  const { data, error } = await supabase.from('money_recovered_settings').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data ? rowToDraft(data) : null;
}

export async function saveSettings(userId: string, d: StatementSettingsDraft): Promise<void> {
  const { error } = await supabase.from('money_recovered_settings').upsert(draftToRow(userId, d), { onConflict: 'user_id' });
  if (error) throw error;
}

export async function fetchBaseline(): Promise<Baseline | null> {
  const { data, error } = await supabase
    .from('money_recovered_baselines')
    .select('monthly_leak_cents,source,label,captured_at')
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Baseline | null) ?? null;
}

/** Append-only: a new row supersedes the previous baseline, which stays in history. */
export async function addBaseline(userId: string, monthlyLeakCents: number, label: string | null): Promise<void> {
  const { error } = await supabase.from('money_recovered_baselines').insert({
    user_id: userId,
    monthly_leak_cents: monthlyLeakCents,
    source: 'leak_report',
    label: label && label.trim() ? label.trim().slice(0, 120) : null,
  });
  if (error) throw error;
}

export async function fetchStatements(limit = 26): Promise<StatementRecord[]> {
  const { data, error } = await supabase
    .from('money_recovered_statements')
    .select('id,week_start,week_end,period_label,credited_cents,status,generated_at,sent_at,last_error,snapshot')
    .order('week_start', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as StatementRecord[];
}

const EVENT_COLS =
  'id,source_type,call_id,customer_name,occurred_at,estimated_value_cents,status,recovery_method,recovered_amount_cents,follow_up_count,last_follow_up_at,resolved_at';

/**
 * Live, not-yet-sent statement for the week so far (or the last completed week).
 * Same engine as the emailed statement; RLS scopes every query to the account.
 */
export async function loadLiveStatement(
  timezone: string,
  which: 'current' | 'previous' = 'current',
  currency = 'USD',
  now: Date = new Date(),
): Promise<Statement> {
  const tz = isValidTimeZone(timezone) ? timezone : 'UTC';
  const w: Window = which === 'current' ? currentWeekWindow(now, tz) : previousWeekWindow(now, tz);
  const base = () => supabase.from('revenue_recovery_events').select(EVENT_COLS);

  const [resolved, active, occurred] = await Promise.all([
    base().eq('status', 'recovered').gte('resolved_at', w.startUtc).lt('resolved_at', w.endUtc).limit(1000),
    base().in('status', ['open', 'contacted']).limit(2000),
    base().gte('occurred_at', w.startUtc).lt('occurred_at', w.endUtc).limit(1000),
  ]);
  for (const r of [resolved, active, occurred]) if (r.error) throw r.error;

  const events = [
    ...new Map(
      [...(resolved.data ?? []), ...(active.data ?? []), ...(occurred.data ?? [])].map((e) => [(e as LedgerEvent).id, e as LedgerEvent]),
    ).values(),
  ];

  const callIds = [...new Set(events.map((e) => e.call_id).filter((x): x is string => Boolean(x)))];
  const calls: CallInfo[] = [];
  for (let i = 0; i < callIds.length; i += 150) {
    const { data, error } = await supabase.from('calls').select('id,summary,recording_url').in('id', callIds.slice(i, i + 150));
    if (error) throw error;
    for (const c of (data ?? []) as { id: string; summary: string | null; recording_url: string | null }[]) {
      calls.push({ id: c.id, summary: c.summary, has_recording: typeof c.recording_url === 'string' && c.recording_url.startsWith('https://') });
    }
  }

  return computeStatement({ events, calls, baseline: await fetchBaseline(), window: w, now, currency });
}

// ============================================================
// ACTIONS
// ============================================================

export type StatementAction = 'send_test' | 'send_now';

export async function runStatementAction(action: StatementAction, opts: { weekStart?: string; resend?: boolean } = {}) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('money-recovered-run', {
    body: { action, ...opts },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) {
    // supabase-js hides the JSON body on non-2xx; surface it when we can.
    const ctx = (error as { context?: Response }).context;
    const msg = ctx ? await ctx.json().then((j: { error?: string }) => j.error).catch(() => undefined) : undefined;
    throw new Error(msg || error.message || 'Request failed');
  }
  return data as {
    statement: Pick<StatementRecord, 'id' | 'week_start' | 'period_label' | 'credited_cents' | 'status' | 'last_error'>;
    delivery: { test?: boolean; ok?: boolean; error?: string | null; status?: string; sent?: number; total?: number } | null;
  };
}

/** Builds the PDF in the browser from the stored snapshot (identical to the emailed attachment) and downloads it. */
export async function downloadStatementPdf(statement: Statement, companyName: string): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const bytes = buildStatementPdf(jsPDF as never, { companyName, statement, siteUrl: window.location.origin });
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${companyName.replace(/[^\w.-]+/g, '_') || 'Vireek'}_Money_Recovered_${statement.period.start}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
