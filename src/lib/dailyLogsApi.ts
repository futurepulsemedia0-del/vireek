import { supabase } from '@/lib/supabase';
import { uploadPhoto } from '@/lib/galleryApi';
import {
  buildPayload,
  dailyLogError,
  type AmendmentRecord,
  type CrewRecord,
  type DailyLog,
  type DelayRecord,
  type LogForm,
  type VisitorRecord,
  type WeatherCode,
} from '@/lib/dailyLogs';

// Project Daily Logs data layer. Reads are scoped to the account owner on top of RLS.
// The log, crew, delays and visitors are written only through save_project_daily_log() (atomic);
// locking goes through submit_project_daily_log().

type Res<T> = { data: T | null; error: { message: string } | null };

function unwrap<T>(res: Res<T>, fallback: string): T {
  if (res.error) throw new Error(dailyLogError(res.error, fallback));
  return res.data as T;
}

const PAGE = 1000;
const MAX_PAGES = 20;

async function fetchAllRows<T>(build: (from: number, to: number) => PromiseLike<Res<T[]>>, fallback: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = unwrap(await build(page * PAGE, page * PAGE + PAGE - 1), fallback) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// ------------------------------------------------------------------
// List
// ------------------------------------------------------------------

export interface LogListRow extends DailyLog {
  crew_hours: number;
  crew_count: number;
  delay_minutes: number;
  photo_count: number;
}

export async function fetchLogList(ownerId: string, projectId: string, limit = 90): Promise<LogListRow[]> {
  const logs =
    unwrap(
      (await supabase
        .from('project_daily_logs')
        .select('*')
        .eq('user_id', ownerId)
        .eq('project_id', projectId)
        .order('log_date', { ascending: false })
        .limit(limit)) as Res<DailyLog[]>,
      'Could not load daily logs.',
    ) ?? [];
  if (logs.length === 0) return [];
  const ids = logs.map((l) => l.id);

  const [crew, delays, photos] = await Promise.all([
    fetchAllRows<{ log_id: string; hours: number }>(
      (from, to) => supabase.from('project_daily_log_crew').select('log_id, hours').in('log_id', ids).range(from, to) as PromiseLike<Res<{ log_id: string; hours: number }[]>>,
      'Could not load crew hours.',
    ),
    fetchAllRows<{ log_id: string; minutes: number }>(
      (from, to) => supabase.from('project_daily_log_delays').select('log_id, minutes').in('log_id', ids).range(from, to) as PromiseLike<Res<{ log_id: string; minutes: number }[]>>,
      'Could not load delays.',
    ),
    fetchAllRows<{ log_id: string }>(
      (from, to) => supabase.from('project_daily_log_photos').select('log_id').in('log_id', ids).range(from, to) as PromiseLike<Res<{ log_id: string }[]>>,
      'Could not load photos.',
    ),
  ]);

  const agg = new Map<string, { hours: number; count: number; delay: number; photos: number }>();
  for (const id of ids) agg.set(id, { hours: 0, count: 0, delay: 0, photos: 0 });
  for (const c of crew) { const a = agg.get(c.log_id); if (a) { a.hours += Number(c.hours) || 0; a.count += 1; } }
  for (const d of delays) { const a = agg.get(d.log_id); if (a) a.delay += Number(d.minutes) || 0; }
  for (const p of photos) { const a = agg.get(p.log_id); if (a) a.photos += 1; }

  return logs.map((l) => {
    const a = agg.get(l.id)!;
    return { ...l, crew_hours: Math.round(a.hours * 100) / 100, crew_count: a.count, delay_minutes: a.delay, photo_count: a.photos };
  });
}

// ------------------------------------------------------------------
// Detail
// ------------------------------------------------------------------

export interface LogPhoto {
  link_id: string;
  photo_id: string;
  storage_path: string;
  thumb_path: string | null;
  file_name: string;
  caption: string | null;
}

export interface LogDetail {
  log: DailyLog | null;
  crew: CrewRecord[];
  delays: DelayRecord[];
  visitors: VisitorRecord[];
  photos: LogPhoto[];
  amendments: AmendmentRecord[];
}

interface PhotoLinkRow {
  id: string;
  photo_id: string;
  job_photos: { storage_path: string; thumb_path: string | null; file_name: string; caption: string | null } | null;
}

export async function fetchLogDetail(ownerId: string, projectId: string, date: string): Promise<LogDetail> {
  const log = unwrap(
    (await supabase.from('project_daily_logs').select('*').eq('user_id', ownerId).eq('project_id', projectId).eq('log_date', date).maybeSingle()) as Res<DailyLog>,
    'Could not load this log.',
  );
  if (!log) return { log: null, crew: [], delays: [], visitors: [], photos: [], amendments: [] };

  const [crew, delays, visitors, photos, amendments] = await Promise.all([
    supabase.from('project_daily_log_crew').select('id, employee_id, name, role, hours, source, sort_order').eq('log_id', log.id).order('sort_order') as PromiseLike<Res<CrewRecord[]>>,
    supabase.from('project_daily_log_delays').select('id, cause, minutes, description, sort_order').eq('log_id', log.id).order('sort_order') as PromiseLike<Res<DelayRecord[]>>,
    supabase.from('project_daily_log_visitors').select('id, name, company, purpose, sort_order').eq('log_id', log.id).order('sort_order') as PromiseLike<Res<VisitorRecord[]>>,
    supabase.from('project_daily_log_photos').select('id, photo_id, job_photos(storage_path, thumb_path, file_name, caption)').eq('log_id', log.id).order('sort_order') as PromiseLike<Res<PhotoLinkRow[]>>,
    supabase.from('project_daily_log_amendments').select('id, note, created_at').eq('log_id', log.id).order('created_at') as PromiseLike<Res<AmendmentRecord[]>>,
  ]);

  return {
    log,
    crew: (unwrap(crew, 'Could not load crew.') ?? []).map((c) => ({ ...c, hours: Number(c.hours) })),
    delays: unwrap(delays, 'Could not load delays.') ?? [],
    visitors: unwrap(visitors, 'Could not load visitors.') ?? [],
    photos: (unwrap(photos, 'Could not load photos.') ?? []).flatMap((p) =>
      p.job_photos ? [{ link_id: p.id, photo_id: p.photo_id, ...p.job_photos }] : [],
    ),
    amendments: unwrap(amendments, 'Could not load amendments.') ?? [],
  };
}

export async function fetchLogPhotos(logId: string): Promise<LogPhoto[]> {
  const rows = unwrap(
    (await supabase.from('project_daily_log_photos').select('id, photo_id, job_photos(storage_path, thumb_path, file_name, caption)').eq('log_id', logId).order('sort_order')) as Res<PhotoLinkRow[]>,
    'Could not load photos.',
  );
  return (rows ?? []).flatMap((p) => (p.job_photos ? [{ link_id: p.id, photo_id: p.photo_id, ...p.job_photos }] : []));
}

export interface EmployeeOption { id: string; full_name: string }

/** Optional (the crew list also accepts typed names), so a permission failure never blocks the editor. */
export async function fetchEmployees(ownerId: string): Promise<EmployeeOption[]> {
  try {
    const res = (await supabase.from('employees').select('id, full_name').eq('user_id', ownerId).eq('active', true).order('full_name').limit(300)) as Res<EmployeeOption[]>;
    return res.error ? [] : res.data ?? [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------

export async function saveLog(projectId: string, date: string, form: LogForm): Promise<string> {
  const { data, error } = await supabase.rpc('save_project_daily_log', { p_project_id: projectId, p_log_date: date, p_payload: buildPayload(form) });
  if (error) throw new Error(dailyLogError(error, 'Could not save the log.'));
  return data as string;
}

export async function submitLog(logId: string): Promise<void> {
  const { error } = await supabase.rpc('submit_project_daily_log', { p_log_id: logId });
  if (error) throw new Error(dailyLogError(error, 'Could not submit the log.'));
}

export async function discardDraft(logId: string): Promise<void> {
  const { error } = await supabase.from('project_daily_logs').delete().eq('id', logId).eq('status', 'draft');
  if (error) throw new Error(dailyLogError(error, 'Could not discard the draft.'));
}

export interface TimesheetHours { employee_id: string; full_name: string; hours: number }

export async function fetchTimesheetHours(projectId: string, date: string): Promise<TimesheetHours[]> {
  const { data, error } = await supabase.rpc('get_project_daily_log_timesheet_hours', { p_project_id: projectId, p_log_date: date });
  if (error) throw new Error(dailyLogError(error, 'Could not read timesheets.'));
  return ((data ?? []) as TimesheetHours[]).map((r) => ({ ...r, hours: Number(r.hours) || 0 }));
}

export async function attachPhotos(args: {
  ownerId: string;
  userId: string;
  logId: string;
  files: File[];
  startOrder: number;
}): Promise<{ added: number; failed: string[] }> {
  let added = 0;
  const failed: string[] = [];
  for (let i = 0; i < args.files.length; i++) {
    const file = args.files[i];
    try {
      const row = await uploadPhoto({ ownerId: args.ownerId, userId: args.userId, file, jobId: null, kind: 'progress', tags: ['daily-log'] });
      const { error } = await supabase
        .from('project_daily_log_photos')
        .insert({ user_id: args.ownerId, log_id: args.logId, photo_id: row.id, sort_order: args.startOrder + i });
      if (error) throw new Error(dailyLogError(error, 'Could not attach the photo.'));
      added += 1;
    } catch {
      failed.push(file.name);
    }
  }
  return { added, failed };
}

/** Removes the link only; the photo stays in the Gallery. */
export async function detachPhoto(linkId: string): Promise<void> {
  const { error } = await supabase.from('project_daily_log_photos').delete().eq('id', linkId);
  if (error) throw new Error(dailyLogError(error, 'Could not remove the photo.'));
}

export async function addAmendment(ownerId: string, logId: string, note: string): Promise<void> {
  const { error } = await supabase.from('project_daily_log_amendments').insert({ user_id: ownerId, log_id: logId, note: note.trim() });
  if (error) throw new Error(dailyLogError(error, 'Could not add the amendment.'));
}

// ------------------------------------------------------------------
// Assist (weather + AI draft) — nothing is saved by these; the person reviews first.
// ------------------------------------------------------------------

async function invokeAssist<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke('daily-log-assist', { body });
  if (error) {
    let message = error.message;
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const j = (await ctx.json()) as { error?: unknown };
        if (j?.error) message = String(j.error);
      } catch {
        /* keep the generic message */
      }
    }
    throw new Error(dailyLogError(new Error(message), fallback));
  }
  if (data && typeof data === 'object' && 'error' in data) throw new Error(dailyLogError(new Error(String((data as { error: unknown }).error)), fallback));
  return data as T;
}

export interface WeatherSuggestion { weather_code: WeatherCode; temp_high_f: number | null; temp_low_f: number | null; wind_mph: number | null }

export async function requestWeather(projectId: string, date: string): Promise<WeatherSuggestion> {
  const res = await invokeAssist<{ weather: WeatherSuggestion }>({ action: 'weather', projectId, date }, 'Could not fetch the weather.');
  return res.weather;
}

export async function requestSummary(logId: string): Promise<string> {
  const res = await invokeAssist<{ summary: string }>({ action: 'summary', logId }, 'Could not generate the draft.');
  return res.summary;
}
