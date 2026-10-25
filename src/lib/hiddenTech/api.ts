// src/lib/hiddenTech/api.ts
//
// Data layer for Hidden Technician. Everything runs under the signed-in manager's RLS:
// reads come straight from jobs / team_members / telematics_job_visits / capacity_waitlist_entries,
// writes go ONLY through the ht_* RPCs (which re-check ownership). No edge function is needed.

import { supabase } from '../supabase';
import { browserTimeZone, localDay, zonedToUtc } from '../hoursAudit';
import { analyzeLeaks, defaultHtSettings, sanitizeHtSettings, type HtJob, type HtSettings, type LeakCause, type LeakResult } from './leakEngine';
import {
  FIX_ASSUMPTIONS, measureBaselineDelta, measureFillGap, suggestFixes,
  type FixKind, type FixStatus, type MeasureMethod, type WaitlistEntry,
} from './fixes';

const DAY = 86_400_000;
const PAGE = 1000;
const MAX_PAGES = 20;

export interface FixRecord {
  id: string;
  fingerprint: string;
  kind: FixKind;
  cause: LeakCause;
  technicianId: string | null;
  waitlistEntryId: string | null;
  targetDay: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  status: FixStatus;
  estimatedHours: number;
  baselineHoursPerDay: number | null;
  recoveredHours: number | null;
  measureMethod: MeasureMethod | null;
  title: string;
  detail: Record<string, string | number>;
  approvedAt: string | null;
  measuredAt: string | null;
  createdAt: string;
}

export interface Snapshot {
  settings: HtSettings;
  actual: LeakResult; // last 28 days of work that really happened
  forecast: LeakResult; // upcoming scheduled days (gaps that can still be filled)
  fixes: FixRecord[];
  waitlistCount: number;
  recovered: { hours: number; cost: number }; // MEASURED only, fixes touched this month
  unassignedJobs: number;
  generatedAt: string;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v: unknown) => (typeof v === 'string' ? v : null);

// ------------------------------------------------------------------ settings

export async function loadSettings(ownerId: string): Promise<HtSettings> {
  const { data, error } = await supabase.from('ht_settings').select('*').eq('user_id', ownerId).maybeSingle();
  if (error) throw new Error(error.message);
  const base = defaultHtSettings(browserTimeZone());
  if (!data) return base;
  return sanitizeHtSettings({
    timeZone: str(data.time_zone) ?? base.timeZone, hourlyCost: num(data.hourly_cost, base.hourlyCost),
    paidHoursPerDay: num(data.paid_hours_per_day, base.paidHoursPerDay), driveGapCapMinutes: num(data.drive_gap_cap_minutes, base.driveGapCapMinutes),
    paperworkAllowanceMinutes: num(data.paperwork_allowance_minutes, base.paperworkAllowanceMinutes), partsRunCapMinutes: num(data.parts_run_cap_minutes, base.partsRunCapMinutes),
  });
}

export async function saveSettings(ownerId: string, raw: Partial<HtSettings>): Promise<HtSettings> {
  const s = sanitizeHtSettings(raw);
  const { error } = await supabase.from('ht_settings').upsert({
    user_id: ownerId, hourly_cost: s.hourlyCost, paid_hours_per_day: s.paidHoursPerDay, drive_gap_cap_minutes: s.driveGapCapMinutes,
    paperwork_allowance_minutes: s.paperworkAllowanceMinutes, parts_run_cap_minutes: s.partsRunCapMinutes, time_zone: s.timeZone,
  }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
  return s;
}

// ------------------------------------------------------------------ reads

async function pageAll<T>(run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const { data, error } = await run(p * PAGE, p * PAGE + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export async function loadTeamNames(ownerId: string): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('team_members').select('id, member_name, member_email').eq('account_owner_id', ownerId).limit(2000);
  if (error) throw new Error(error.message);
  const m = new Map<string, string>();
  for (const r of data ?? []) m.set(r.id as string, (str(r.member_name)?.trim() || (str(r.member_email) ?? '').split('@')[0] || 'Technician'));
  return m;
}

interface JobRow {
  id: string; assigned_technician_id: string | null; scheduled_datetime: string | null; started_at: string | null; arrived_at: string | null;
  completed_at: string | null; duration_minutes: number | null; job_status: string | null; is_rework: boolean | null; tags: string | null;
}
const JOB_COLS = 'id, assigned_technician_id, scheduled_datetime, started_at, arrived_at, completed_at, duration_minutes, job_status, is_rework, tags';

function toJob(r: JobRow, names: Map<string, string>, visits: Map<string, { in: string; out: string | null }>): HtJob {
  const v = visits.get(r.id);
  return {
    id: r.id, techId: r.assigned_technician_id ?? '', techName: r.assigned_technician_id ? names.get(r.assigned_technician_id) ?? null : null,
    scheduledAt: r.scheduled_datetime, startedAt: r.started_at, enRouteAt: r.arrived_at, completedAt: r.completed_at,
    onsiteArrivedAt: v?.in ?? null, onsiteDepartedAt: v?.out ?? null,
    durationMinutes: r.duration_minutes, status: r.job_status, isRework: r.is_rework === true, tags: r.tags,
  };
}

async function loadVisits(ownerId: string, fromIso: string, toIso: string): Promise<Map<string, { in: string; out: string | null }>> {
  const map = new Map<string, { in: string; out: string | null }>();
  try {
    const rows = await pageAll<{ job_id: string; arrived_at: string; departed_at: string | null }>((a, b) =>
      supabase.from('telematics_job_visits').select('job_id, arrived_at, departed_at').eq('user_id', ownerId).gte('arrived_at', fromIso).lt('arrived_at', toIso).order('arrived_at').range(a, b));
    for (const r of rows) {
      const cur = map.get(r.job_id);
      if (!cur) map.set(r.job_id, { in: r.arrived_at, out: r.departed_at });
      else if (r.departed_at && (!cur.out || r.departed_at > cur.out)) cur.out = r.departed_at; // several visits → first arrival, last departure
    }
  } catch {
    /* telematics not enabled for this account: measured on-site time is optional */
  }
  return map;
}

async function loadJobs(ownerId: string, fromIso: string, toIso: string, names: Map<string, string>): Promise<HtJob[]> {
  const [rows, visits] = await Promise.all([
    pageAll<JobRow>((a, b) => supabase.from('jobs').select(JOB_COLS).eq('user_id', ownerId).gte('scheduled_datetime', fromIso).lt('scheduled_datetime', toIso).order('scheduled_datetime').range(a, b)),
    loadVisits(ownerId, fromIso, toIso),
  ]);
  return rows.map((r) => toJob(r, names, visits));
}

async function loadWaitlist(ownerId: string): Promise<WaitlistEntry[]> {
  const { data, error } = await supabase.from('capacity_waitlist_entries')
    .select('id, customer_name, service_type, requested_date, priority, created_at').eq('user_id', ownerId).eq('status', 'waiting')
    .order('priority', { ascending: false }).order('created_at').limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({ id: r.id as string, customerName: String(r.customer_name ?? ''), serviceType: str(r.service_type), requestedDate: String(r.requested_date ?? ''), priority: num(r.priority), createdAt: String(r.created_at ?? '') }));
}

function toFix(r: Record<string, unknown>): FixRecord {
  return {
    id: r.id as string, fingerprint: String(r.fingerprint), kind: r.kind as FixKind, cause: r.cause as LeakCause,
    technicianId: str(r.technician_id), waitlistEntryId: str(r.waitlist_entry_id), targetDay: str(r.target_day),
    windowStart: str(r.window_start), windowEnd: str(r.window_end), status: r.status as FixStatus,
    estimatedHours: num(r.estimated_hours), baselineHoursPerDay: r.baseline_hours_per_day === null ? null : num(r.baseline_hours_per_day),
    recoveredHours: r.recovered_hours === null ? null : num(r.recovered_hours), measureMethod: (str(r.measure_method) as MeasureMethod | null),
    title: String(r.title ?? ''), detail: (r.detail && typeof r.detail === 'object' ? r.detail : {}) as Record<string, string | number>,
    approvedAt: str(r.approved_at), measuredAt: str(r.measured_at), createdAt: String(r.created_at ?? ''),
  };
}

export async function loadFixes(ownerId: string): Promise<FixRecord[]> {
  const { data, error } = await supabase.from('ht_fixes').select('*').eq('user_id', ownerId).neq('status', 'expired').order('created_at', { ascending: false }).limit(300);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => toFix(r as Record<string, unknown>));
}

// ------------------------------------------------------------------ writes (RPC only)

export async function decideFix(fixId: string, decision: 'approve' | 'dismiss'): Promise<void> {
  const { error } = await supabase.rpc('ht_decide_fix', { p_fix_id: fixId, p_decision: decision });
  if (error) throw new Error(error.message);
}

async function persistLedger(from: string, to: string, result: LeakResult): Promise<void> {
  const rows = result.rows.filter((r) => r.hours >= 0.001 && r.day >= from && r.day <= to).map((r) => ({
    technician_id: r.techId, job_id: r.jobId, leak_day: r.day, cause: r.cause, hours: Math.round(r.hours * 10000) / 10000,
    starts_at: new Date(r.startMs).toISOString(), ends_at: new Date(r.endMs).toISOString(), confidence: r.confidence, rule: r.rule,
  }));
  const { error } = await supabase.rpc('ht_replace_ledger', { p_from: from, p_to: to, p_rows: rows });
  if (error) throw new Error(error.message);
}

async function persistSuggestions(items: ReturnType<typeof suggestFixes>): Promise<void> {
  if (items.length === 0) return;
  const payload = items.slice(0, 200).map((f) => ({
    fingerprint: f.fingerprint, kind: f.kind, cause: f.cause, technician_id: f.technicianId, waitlist_entry_id: f.waitlistEntryId,
    target_day: f.targetDay, window_start: f.windowStart, window_end: f.windowEnd, estimated_hours: f.estimatedHours,
    baseline_hours_per_day: f.baselineHoursPerDay, title: f.title, detail: f.detail,
  }));
  const { error } = await supabase.rpc('ht_save_fixes', { p_fixes: payload });
  if (error) throw new Error(error.message);
}

async function recordRecovery(fixId: string, hours: number, method: MeasureMethod): Promise<void> {
  const { error } = await supabase.rpc('ht_record_recovery', { p_fix_id: fixId, p_hours: hours, p_method: method });
  if (error) throw new Error(error.message);
}

// ------------------------------------------------------------------ orchestration

function startOfLocalDay(ms: number, tz: string): number {
  const [y, m, d] = localDay(ms, tz).split('-').map(Number);
  return zonedToUtc(y, m, d, 0, 0, 0, tz);
}

/** Loads data, rebuilds the ledger, saves new suggestions, measures recovery for approved fixes, returns what the dashboard shows. */
export async function refreshSnapshot(ownerId: string, now: number = Date.now()): Promise<Snapshot> {
  const settings = await loadSettings(ownerId);
  const tz = settings.timeZone;
  const today = startOfLocalDay(now, tz);
  const histFrom = today - FIX_ASSUMPTIONS.historyDays * DAY;
  const horizon = today + 8 * DAY;
  const names = await loadTeamNames(ownerId);
  const all = await loadJobs(ownerId, new Date(histFrom - DAY).toISOString(), new Date(horizon).toISOString(), names);

  const unassignedJobs = all.filter((j) => !j.techId).length;
  const actual = analyzeLeaks(all, { ...settings, includePlanned: false });
  const future = all.filter((j) => {
    const t = Date.parse(j.scheduledAt ?? j.startedAt ?? '');
    return Number.isFinite(t) && t >= today;
  });
  const forecast = analyzeLeaks(future, { ...settings, includePlanned: true });

  const fromDay = localDay(histFrom, tz);
  const toDay = localDay(today, tz);
  await persistLedger(fromDay, toDay, actual);
  const waitlist = await loadWaitlist(ownerId);
  await persistSuggestions(suggestFixes({ forecast, history: actual, waitlist, nowMs: now, settings }));

  let fixes = await loadFixes(ownerId);
  const recent = fixes.filter((f) => (f.status === 'approved' || f.status === 'measured') && f.approvedAt && now - Date.parse(f.approvedAt) <= FIX_ASSUMPTIONS.historyDays * DAY);
  let changed = false;
  for (const f of recent) {
    try {
      const m = f.kind === 'fill_gap' && f.status === 'approved' ? await measureSlot(ownerId, f, names, now, settings)
        : f.kind !== 'fill_gap' ? measureBaselineDelta(f, actual.rows, actual.days, localDay(Date.parse(f.approvedAt as string), tz)) : null;
      if (m?.ready) { await recordRecovery(f.id, m.hours, m.method); changed = true; }
    } catch {
      /* one failed measurement must never block the dashboard; it is retried on the next refresh */
    }
  }
  if (changed) fixes = await loadFixes(ownerId);

  const monthStart = Date.parse(`${localDay(now, tz).slice(0, 7)}-01T00:00:00Z`);
  const hours = fixes.filter((f) => f.status === 'measured' && f.measuredAt && Date.parse(f.measuredAt) >= monthStart).reduce((a, f) => a + (f.recoveredHours ?? 0), 0);
  const rounded = Math.round(hours * 100) / 100;
  return {
    settings, actual, forecast, fixes, waitlistCount: waitlist.length, unassignedJobs,
    recovered: { hours: rounded, cost: Math.round(rounded * settings.hourlyCost * 100) / 100 },
    generatedAt: new Date(now).toISOString(),
  };
}

async function measureSlot(ownerId: string, f: FixRecord, names: Map<string, string>, now: number, settings: HtSettings) {
  const { data: entry, error } = await supabase.from('capacity_waitlist_entries').select('job_id').eq('id', f.waitlistEntryId as string).eq('user_id', ownerId).maybeSingle();
  if (error) throw new Error(error.message);
  let job: HtJob | null = null;
  if (entry?.job_id) {
    const { data: row, error: e2 } = await supabase.from('jobs').select(JOB_COLS).eq('id', entry.job_id).eq('user_id', ownerId).maybeSingle();
    if (e2) throw new Error(e2.message);
    if (row) job = toJob(row as JobRow, names, new Map());
  }
  return measureFillGap(f, job, now, settings);
}
