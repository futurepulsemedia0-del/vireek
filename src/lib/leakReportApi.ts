/**
 * Leak Report - data access. Every query is scoped by account owner and protected by RLS
 * (see 20271111000000_leak_report.sql). Calls / jobs / business_profile use user_id = owner.
 */

import { supabase } from '@/lib/supabase';
import { computeStats, fetchLedger } from '@/lib/revenueRecovery';
import { generateToken, sha256Hex } from '@/lib/speedToLead';
import {
  DEFAULT_CLOSE_RATE_BPS,
  WINDOW_DAYS,
  computeLeakReport,
  mergeObservations,
  normalizePhoneKey,
  parseCallLogCsv,
  reportPhase,
  type BusinessHours,
  type CallObservation,
  type LeakReport,
  type ReportPhase,
} from '../../supabase/functions/_shared/leak-report/core';

interface PgError {
  code?: string;
  message: string;
}

function toError(error: PgError, fallback: string): Error {
  if (error.code === '42501') return new Error("You don't have permission to change the Leak Report.");
  if (error.code === '22023') return new Error('One of the values is not valid (check the time zone and start date).');
  if (error.code === '23514') return new Error('One of the values is outside the allowed range.');
  return new Error(fallback);
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  } catch {
    return 'America/New_York';
  }
}

export interface LeakSettings {
  enabled: boolean;
  started_at: string | null;
  window_days: number;
  timezone: string;
  avg_ticket_cents: number | null;
  close_rate_bps: number;
}

export const DEFAULT_LEAK_SETTINGS: LeakSettings = {
  enabled: false,
  started_at: null,
  window_days: WINDOW_DAYS,
  timezone: browserTimeZone(),
  avg_ticket_cents: null,
  close_rate_bps: DEFAULT_CLOSE_RATE_BPS,
};

export type TicketSource = 'override' | 'jobs' | 'profile' | 'none';

export interface LeakData {
  settings: LeakSettings;
  phase: ReportPhase;
  report: LeakReport;
  windowStart: string | null;
  windowEnd: string | null;
  dayNumber: number;
  ticketSource: TicketSource;
  ticketJobCount: number;
}

const SETTINGS_COLUMNS = 'enabled, started_at, window_days, timezone, avg_ticket_cents, close_rate_bps';
const SOURCE_COLUMNS = 'id, name, kind, token_hint, enabled, last_event_at, created_at';
const EVENT_COLUMNS = 'id, started_at, direction, answered, is_voicemail, ring_seconds, duration_seconds, phone_key';
const MIN_JOBS_FOR_TICKET = 5;

// ---------------------------------------------------------------- settings

export async function fetchLeakSettings(accountOwnerId: string): Promise<LeakSettings> {
  const { data, error } = await supabase
    .from('leak_report_settings')
    .select(SETTINGS_COLUMNS)
    .eq('account_owner_id', accountOwnerId)
    .maybeSingle();
  if (error) throw toError(error, 'Could not load the Leak Report settings.');
  if (!data) return { ...DEFAULT_LEAK_SETTINGS };
  return { ...DEFAULT_LEAK_SETTINGS, ...(data as unknown as LeakSettings) };
}

export async function saveLeakSettings(accountOwnerId: string, patch: Partial<LeakSettings>): Promise<LeakSettings> {
  const { data, error } = await supabase
    .from('leak_report_settings')
    .upsert({ account_owner_id: accountOwnerId, ...patch }, { onConflict: 'account_owner_id' })
    .select(SETTINGS_COLUMNS)
    .single();
  if (error) throw toError(error, 'Could not save the Leak Report settings.');
  return { ...DEFAULT_LEAK_SETTINGS, ...(data as unknown as LeakSettings) };
}

export async function startLeakReport(
  accountOwnerId: string,
  input: { timezone: string; avg_ticket_cents: number | null; close_rate_bps: number },
): Promise<LeakSettings> {
  return saveLeakSettings(accountOwnerId, { ...input, enabled: true, started_at: new Date().toISOString() });
}

// ---------------------------------------------------------------- sources

export interface LeakSource {
  id: string;
  name: string;
  kind: 'call_tracking' | 'forwarded_copy';
  token_hint: string;
  enabled: boolean;
  last_event_at: string | null;
  created_at: string;
}

export const SOURCE_KIND_LABELS: Record<LeakSource['kind'], string> = {
  call_tracking: 'Call-tracking provider',
  forwarded_copy: 'Forwarded copies (Zapier / email / SMS)',
};

export function ingestEndpointUrl(): string {
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
  return `${base.replace(/\/$/, '')}/functions/v1/leak-report-ingest`;
}

export async function fetchSources(accountOwnerId: string): Promise<LeakSource[]> {
  const { data, error } = await supabase
    .from('leak_report_sources')
    .select(SOURCE_COLUMNS)
    .eq('account_owner_id', accountOwnerId)
    .order('created_at', { ascending: false });
  if (error) throw toError(error, 'Could not load the connections.');
  return (data as unknown as LeakSource[]) ?? [];
}

export async function createSource(
  accountOwnerId: string,
  input: { name: string; kind: LeakSource['kind'] },
): Promise<{ source: LeakSource; token: string }> {
  const token = generateToken();
  const { data, error } = await supabase
    .from('leak_report_sources')
    .insert({
      account_owner_id: accountOwnerId,
      name: input.name.trim(),
      kind: input.kind,
      token_hash: await sha256Hex(token),
      token_hint: token.slice(-4),
    })
    .select(SOURCE_COLUMNS)
    .single();
  if (error) throw toError(error, 'Could not create the connection.');
  return { source: data as unknown as LeakSource, token };
}

export async function setSourceEnabled(id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from('leak_report_sources').update({ enabled }).eq('id', id);
  if (error) throw toError(error, 'Could not update the connection.');
}

export async function deleteSource(id: string): Promise<void> {
  const { error } = await supabase.from('leak_report_sources').delete().eq('id', id);
  if (error) throw toError(error, 'Could not delete the connection.');
}

// ---------------------------------------------------------------- events + report

interface EventRow {
  id: string;
  started_at: string;
  direction: 'inbound' | 'outbound';
  answered: boolean;
  is_voicemail: boolean;
  ring_seconds: number | null;
  duration_seconds: number | null;
  phone_key: string | null;
}

async function fetchEvents(accountOwnerId: string, fromIso: string, toIso: string): Promise<CallObservation[]> {
  const out: CallObservation[] = [];
  const PAGE = 1000;
  for (let from = 0; from < 10_000; from += PAGE) {
    const { data, error } = await supabase
      .from('leak_report_call_events')
      .select(EVENT_COLUMNS)
      .eq('account_owner_id', accountOwnerId)
      .gte('started_at', fromIso)
      .lte('started_at', toIso)
      .order('started_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw toError(error, 'Could not load call data.');
    const rows = (data as unknown as EventRow[]) ?? [];
    for (const r of rows) {
      out.push({
        id: r.id,
        startedAt: r.started_at,
        direction: r.direction,
        answered: r.answered,
        isVoicemail: r.is_voicemail,
        ringSeconds: r.ring_seconds,
        durationSeconds: r.duration_seconds,
        phoneKey: r.phone_key,
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

async function fetchVireekCalls(accountOwnerId: string, fromIso: string, toIso: string): Promise<CallObservation[]> {
  const { data, error } = await supabase
    .from('calls')
    .select('id, call_datetime, status, is_voicemail, caller_phone')
    .eq('user_id', accountOwnerId)
    .gte('call_datetime', fromIso)
    .lte('call_datetime', toIso)
    .limit(5000);
  if (error) throw toError(error, 'Could not load call history.');
  const rows = (data as unknown as { id: string; call_datetime: string; status: string; is_voicemail: boolean | null; caller_phone: string | null }[]) ?? [];
  return rows
    .filter((c) => c.status !== 'spam')
    .map((c) => ({
      id: `v:${c.id}`,
      startedAt: c.call_datetime,
      direction: 'inbound' as const,
      answered: c.status !== 'missed' && !c.is_voicemail,
      isVoicemail: Boolean(c.is_voicemail),
      ringSeconds: null,
      durationSeconds: null,
      phoneKey: normalizePhoneKey(c.caller_phone),
    }));
}

async function fetchTicketInputs(accountOwnerId: string): Promise<{
  hours: BusinessHours;
  profileTicketCents: number | null;
  jobTicketCents: number | null;
  jobCount: number;
}> {
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const [bp, jobs] = await Promise.all([
    supabase.from('business_profile').select('business_hours, avg_job_value').eq('user_id', accountOwnerId).maybeSingle(),
    supabase
      .from('jobs')
      .select('invoice_amount')
      .eq('user_id', accountOwnerId)
      .gt('invoice_amount', 0)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(500),
  ]);
  if (bp.error) throw toError(bp.error, 'Could not load the business profile.');
  const bpRow = bp.data as unknown as { business_hours: BusinessHours; avg_job_value: number | null } | null;
  const avgValue = Number(bpRow?.avg_job_value ?? 0);
  const amounts = ((jobs.data as unknown as { invoice_amount: number | null }[]) ?? [])
    .map((j) => Number(j.invoice_amount ?? 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  return {
    hours: bpRow?.business_hours ?? null,
    profileTicketCents: avgValue > 0 ? Math.round(avgValue * 100) : null,
    jobTicketCents: amounts.length >= MIN_JOBS_FOR_TICKET ? Math.round((amounts.reduce((a, b) => a + b, 0) / amounts.length) * 100) : null,
    jobCount: amounts.length,
  };
}

export async function fetchLeakData(accountOwnerId: string): Promise<LeakData> {
  const settings = await fetchLeakSettings(accountOwnerId);
  const now = Date.now();
  const startMs = settings.started_at ? Date.parse(settings.started_at) : now;
  const endMs = Math.min(now, startMs + settings.window_days * 86_400_000);
  const windowStart = new Date(startMs);
  const windowEnd = new Date(endMs);

  const [observed, vireek, inputs] =
    settings.enabled && settings.started_at
      ? await Promise.all([
          fetchEvents(accountOwnerId, windowStart.toISOString(), new Date(now).toISOString()),
          fetchVireekCalls(accountOwnerId, windowStart.toISOString(), windowEnd.toISOString()),
          fetchTicketInputs(accountOwnerId),
        ])
      : [[] as CallObservation[], [] as CallObservation[], await fetchTicketInputs(accountOwnerId)];

  let ticketSource: TicketSource = 'none';
  let ticket: number | null = null;
  if (settings.avg_ticket_cents) { ticket = settings.avg_ticket_cents; ticketSource = 'override'; }
  else if (inputs.jobTicketCents) { ticket = inputs.jobTicketCents; ticketSource = 'jobs'; }
  else if (inputs.profileTicketCents) { ticket = inputs.profileTicketCents; ticketSource = 'profile'; }

  const report = computeLeakReport({
    events: mergeObservations(observed, vireek),
    windowStart,
    windowEnd,
    timeZone: settings.timezone,
    businessHours: inputs.hours,
    avgTicketCents: ticket,
    closeRateBps: settings.close_rate_bps,
    nowMs: now,
  });

  const phase = reportPhase(settings.enabled, settings.started_at, report.inboundTotal, settings.window_days, now);
  const dayNumber = settings.started_at ? Math.min(settings.window_days, Math.floor((now - startMs) / 86_400_000) + 1) : 0;

  return {
    settings,
    phase,
    report,
    windowStart: settings.started_at ? windowStart.toISOString() : null,
    windowEnd: settings.started_at ? windowEnd.toISOString() : null,
    dayNumber,
    ticketSource,
    ticketJobCount: inputs.jobCount,
  };
}

// ---------------------------------------------------------------- CSV import / delete

export async function importCallLog(
  accountOwnerId: string,
  text: string,
): Promise<{ processed: number; rejected: number; total: number }> {
  const parsed = parseCallLogCsv(text);
  if (parsed.events.length === 0) return { processed: 0, rejected: parsed.rejected, total: parsed.total };

  const rows = parsed.events.map((e) => ({
    account_owner_id: accountOwnerId,
    source_id: null,
    dedupe_key: e.dedupeKey.slice(0, 200),
    direction: e.direction,
    started_at: e.startedAt,
    answered: e.answered,
    is_voicemail: e.isVoicemail,
    ring_seconds: e.ringSeconds,
    duration_seconds: e.durationSeconds,
    phone_key: e.phoneKey,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase
      .from('leak_report_call_events')
      .upsert(rows.slice(i, i + 500), { onConflict: 'account_owner_id,dedupe_key', ignoreDuplicates: true });
    if (error) throw toError(error, 'Could not import the call log.');
  }

  // Instant report: pull the window start back to the earliest imported call (max 29 days).
  const earliest = Math.min(...parsed.events.map((e) => Date.parse(e.startedAt)));
  const floor = Date.now() - 29 * 86_400_000;
  const settings = await fetchLeakSettings(accountOwnerId);
  const target = Math.max(earliest, floor);
  if (!settings.started_at || target < Date.parse(settings.started_at)) {
    await saveLeakSettings(accountOwnerId, { started_at: new Date(target).toISOString() });
  }
  return { processed: parsed.events.length, rejected: parsed.rejected, total: parsed.total };
}

export async function deleteAllLeakEvents(accountOwnerId: string): Promise<void> {
  const { error } = await supabase.from('leak_report_call_events').delete().eq('account_owner_id', accountOwnerId);
  if (error) throw toError(error, 'Could not delete the collected call data.');
}

// ---------------------------------------------------------------- Recovery Ledger (reuse)

export async function fetchLedgerSummary(): Promise<{ openCount: number; openValueCents: number } | null> {
  try {
    const stats = computeStats(await fetchLedger({ status: 'active' }));
    return { openCount: stats.openCount, openValueCents: stats.openValueCents };
  } catch {
    return null; // non-critical: the report works without it
  }
}
