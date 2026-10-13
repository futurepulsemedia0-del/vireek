// src/lib/executiveReport.ts
// Executive Monthly Report — types, pure helpers and API access.

import { supabase } from '@/lib/supabase';

export interface ExecutiveReportSettingsDraft {
  enabled: boolean;
  send_day: string;
  send_hour: string;
  timezone: string;
  include_owner: boolean;
  include_co_owners: boolean;
  extra_recipients: string; // comma / newline separated
  ai_commentary_enabled: boolean;
  revenue_goal: string;
  jobs_goal: string;
  close_rate_goal_pct: string;
  margin_goal_pct: string;
}

export interface ExecutiveReportRow {
  id: string;
  period_label: string;
  period_start: string;
  status: 'ready' | 'sent' | 'partial' | 'failed';
  commentary_source: 'ai' | 'deterministic';
  pdf_path: string | null;
  generated_at: string;
  sent_at: string | null;
  last_error: string | null;
  metrics: {
    current: { revenue: number; jobsCompleted: number; closeRatePct: number | null; marginPct: number | null };
  } | null;
  commentary: { headline: string } | null;
}

export type ReportAction = 'preview' | 'send_test' | 'send_now';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EXTRA_RECIPIENTS = 10;

export function defaultDraft(timezone?: string): ExecutiveReportSettingsDraft {
  return {
    enabled: true, send_day: '1', send_hour: '8',
    timezone: timezone || 'America/New_York',
    include_owner: true, include_co_owners: true, extra_recipients: '',
    ai_commentary_enabled: true,
    revenue_goal: '', jobs_goal: '', close_rate_goal_pct: '', margin_goal_pct: '',
  };
}

export function parseRecipients(text: string): { valid: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const e = raw.trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    (EMAIL_RE.test(e) ? valid : invalid).push(e);
  }
  return { valid, invalid };
}

const intIn = (v: string, min: number, max: number) => /^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max;
const numIn = (v: string, min: number, max: number) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max;

export function validateDraft(d: ExecutiveReportSettingsDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!intIn(d.send_day, 1, 28)) errors.send_day = 'Choose a day between 1 and 28.';
  if (!intIn(d.send_hour, 0, 23)) errors.send_hour = 'Choose an hour between 0 and 23.';
  if (!d.timezone) errors.timezone = 'Choose a time zone.';
  const { valid, invalid } = parseRecipients(d.extra_recipients);
  if (invalid.length) errors.extra_recipients = `Invalid email: ${invalid[0]}`;
  else if (valid.length > MAX_EXTRA_RECIPIENTS) errors.extra_recipients = `Up to ${MAX_EXTRA_RECIPIENTS} extra recipients.`;
  if (d.revenue_goal.trim() && !numIn(d.revenue_goal, 0, 1_000_000_000)) errors.revenue_goal = 'Enter a positive amount.';
  if (d.jobs_goal.trim() && !intIn(d.jobs_goal, 0, 1_000_000)) errors.jobs_goal = 'Enter a whole number.';
  if (d.close_rate_goal_pct.trim() && !numIn(d.close_rate_goal_pct, 0, 100)) errors.close_rate_goal_pct = 'Enter a percentage from 0 to 100.';
  if (d.margin_goal_pct.trim() && !numIn(d.margin_goal_pct, 0, 100)) errors.margin_goal_pct = 'Enter a percentage from 0 to 100.';
  if (!d.include_owner && !d.include_co_owners && !valid.length) errors.extra_recipients = errors.extra_recipients ?? 'Pick at least one recipient.';
  return errors;
}

const orNull = (v: string) => (v.trim() === '' ? null : Number(v));

export function draftToRow(userId: string, d: ExecutiveReportSettingsDraft) {
  return {
    user_id: userId,
    enabled: d.enabled,
    send_day: Number(d.send_day),
    send_hour: Number(d.send_hour),
    timezone: d.timezone,
    include_owner: d.include_owner,
    include_co_owners: d.include_co_owners,
    extra_recipients: parseRecipients(d.extra_recipients).valid,
    ai_commentary_enabled: d.ai_commentary_enabled,
    revenue_goal: orNull(d.revenue_goal),
    jobs_goal: orNull(d.jobs_goal),
    close_rate_goal_pct: orNull(d.close_rate_goal_pct),
    margin_goal_pct: orNull(d.margin_goal_pct),
  };
}

type SettingsRow = ReturnType<typeof draftToRow>;
export function rowToDraft(r: Partial<SettingsRow>): ExecutiveReportSettingsDraft {
  const s = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
  const base = defaultDraft();
  return {
    enabled: r.enabled ?? base.enabled,
    send_day: s(r.send_day) || base.send_day,
    send_hour: s(r.send_hour) || base.send_hour,
    timezone: r.timezone || base.timezone,
    include_owner: r.include_owner ?? base.include_owner,
    include_co_owners: r.include_co_owners ?? base.include_co_owners,
    extra_recipients: (r.extra_recipients ?? []).join(', '),
    ai_commentary_enabled: r.ai_commentary_enabled ?? base.ai_commentary_enabled,
    revenue_goal: s(r.revenue_goal), jobs_goal: s(r.jobs_goal),
    close_rate_goal_pct: s(r.close_rate_goal_pct), margin_goal_pct: s(r.margin_goal_pct),
  };
}

export const STATUS_LABEL: Record<ExecutiveReportRow['status'], string> = {
  ready: 'Ready', sent: 'Sent', partial: 'Partly sent', failed: 'Send failed',
};

export const formatMoney = (n: number | null | undefined) =>
  n === null || n === undefined ? 'n/a' : `$${Math.round(n).toLocaleString('en-US')}`;
export const formatPct = (n: number | null | undefined) => (n === null || n === undefined ? 'n/a' : `${n}%`);

export function commonTimeZones(browserZone?: string): string[] {
  const base = [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
    'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver', 'America/Mexico_City',
    'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Istanbul', 'Asia/Baku',
    'Asia/Dubai', 'Asia/Tehran', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
  ];
  return browserZone && !base.includes(browserZone) ? [browserZone, ...base] : base;
}

// ---------------------------------------------------------------- API
export async function fetchSettings(userId: string): Promise<ExecutiveReportSettingsDraft | null> {
  const { data, error } = await supabase.from('executive_report_settings').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data ? rowToDraft(data) : null;
}

export async function saveSettings(userId: string, d: ExecutiveReportSettingsDraft): Promise<void> {
  const { error } = await supabase.from('executive_report_settings').upsert(draftToRow(userId, d), { onConflict: 'user_id' });
  if (error) throw error;
}

export async function fetchReports(limit = 12): Promise<ExecutiveReportRow[]> {
  const { data, error } = await supabase
    .from('executive_reports')
    .select('id,period_label,period_start,status,commentary_source,pdf_path,generated_at,sent_at,last_error,metrics,commentary')
    .order('period_start', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ExecutiveReportRow[];
}

export async function runReportAction(action: ReportAction, opts: { period?: string; resend?: boolean } = {}) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('executive-report-run', {
    body: { action, ...opts },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) {
    // supabase-js hides the JSON body on non-2xx; surface it when we can.
    const ctx = (error as { context?: Response }).context;
    const msg = ctx ? await ctx.json().then((j: { error?: string }) => j.error).catch(() => undefined) : undefined;
    throw new Error(msg || error.message || 'Request failed');
  }
  return data as { report: ExecutiveReportRow & { pdf_url: string | null }; delivery: unknown };
}

export async function getPdfUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from('executive-reports').createSignedUrl(path, 300);
  if (error || !data?.signedUrl) throw error ?? new Error('Could not open the PDF');
  return data.signedUrl;
}
