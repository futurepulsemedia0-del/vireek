import { supabase } from '@/lib/supabase';
import {
  addDays,
  normalizeBlackout,
  normalizeList,
  normalizeTimeOff,
  normalizeWeekly,
  type AvailabilityData,
  type BlackoutDraft,
  type BlackoutEntry,
  type ScheduledJob,
  type TechnicianLite,
  type TimeOffDraft,
  type TimeOffEntry,
} from '@/lib/timeOff';

/**
 * Data access for /dashboard/time-off and the Dispatch hooks. Every read is scoped to the account owner
 * (accountOwnerId) on top of RLS. Entries are append-only: "removing" one cancels it.
 * Schema + rules: supabase/migrations/20270502000000_time_off_availability.sql.
 */

const TIME_OFF_COLUMNS = 'id, user_id, technician_id, kind, start_date, end_date, note, status, created_by, created_at, updated_at';
const BLACKOUT_COLUMNS = 'id, user_id, label, start_date, end_date, status, created_by, created_at, updated_at';

export async function fetchTechnicians(accountOwnerId: string): Promise<TechnicianLite[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, member_name, member_email, max_jobs_per_day, dispatch_enabled')
    .eq('account_owner_id', accountOwnerId)
    .eq('role', 'technician')
    .eq('invite_status', 'active')
    .order('member_name', { ascending: true });
  if (error) throw error;
  return (Array.isArray(data) ? data : []).flatMap((row) => {
    const r = row as Partial<TechnicianLite>;
    if (typeof r.id !== 'string') return [];
    return [
      {
        id: r.id,
        member_name: typeof r.member_name === 'string' ? r.member_name : null,
        member_email: typeof r.member_email === 'string' ? r.member_email : null,
        max_jobs_per_day: typeof r.max_jobs_per_day === 'number' ? r.max_jobs_per_day : 6,
        dispatch_enabled: r.dispatch_enabled !== false,
      },
    ];
  });
}

/** Everything that still matters on or after `fromIso` (approved time off, active blackouts, weekly patterns). */
export async function fetchAvailabilityData(accountOwnerId: string, fromIso: string): Promise<AvailabilityData> {
  const [timeOff, blackouts, weekly] = await Promise.all([
    supabase
      .from('technician_time_off')
      .select(TIME_OFF_COLUMNS)
      .eq('user_id', accountOwnerId)
      .eq('status', 'approved')
      .gte('end_date', fromIso)
      .order('start_date', { ascending: true })
      .limit(2000),
    supabase
      .from('company_blackout_dates')
      .select(BLACKOUT_COLUMNS)
      .eq('user_id', accountOwnerId)
      .eq('status', 'active')
      .gte('end_date', fromIso)
      .order('start_date', { ascending: true })
      .limit(500),
    supabase.from('technician_availability').select('technician_id, working_days').eq('user_id', accountOwnerId),
  ]);
  if (timeOff.error) throw timeOff.error;
  if (blackouts.error) throw blackouts.error;
  if (weekly.error) throw weekly.error;
  return {
    timeOff: normalizeList(timeOff.data, normalizeTimeOff),
    blackouts: normalizeList(blackouts.data, normalizeBlackout),
    weekly: normalizeWeekly(weekly.data),
  };
}

/** Active jobs in a day range (padded by a day on each side so local-timezone days are never cut off). */
export async function fetchScheduledJobs(accountOwnerId: string, fromIso: string, toIso: string): Promise<ScheduledJob[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, customer_name, assigned_technician_id, scheduled_datetime, job_status, service_type')
    .eq('user_id', accountOwnerId)
    .in('job_status', ['scheduled', 'en_route', 'in_progress'])
    .gte('scheduled_datetime', `${addDays(fromIso, -1)}T00:00:00Z`)
    .lte('scheduled_datetime', `${addDays(toIso, 2)}T00:00:00Z`)
    .order('scheduled_datetime', { ascending: true })
    .limit(3000);
  if (error) throw error;
  return (Array.isArray(data) ? data : []).flatMap((row) => {
    const r = row as Partial<ScheduledJob>;
    if (typeof r.id !== 'string' || typeof r.job_status !== 'string') return [];
    return [
      {
        id: r.id,
        customer_name: typeof r.customer_name === 'string' ? r.customer_name : null,
        assigned_technician_id: typeof r.assigned_technician_id === 'string' ? r.assigned_technician_id : null,
        scheduled_datetime: typeof r.scheduled_datetime === 'string' ? r.scheduled_datetime : null,
        job_status: r.job_status,
        service_type: typeof r.service_type === 'string' ? r.service_type : null,
      },
    ];
  });
}

export async function createTimeOff(accountOwnerId: string, draft: TimeOffDraft): Promise<TimeOffEntry> {
  const { data, error } = await supabase
    .from('technician_time_off')
    .insert({
      user_id: accountOwnerId,
      technician_id: draft.technician_id,
      kind: draft.kind,
      start_date: draft.start_date,
      end_date: draft.end_date,
      note: draft.note.trim() ? draft.note.trim() : null,
    })
    .select(TIME_OFF_COLUMNS)
    .single();
  if (error) throw error;
  const row = normalizeTimeOff(data);
  if (!row) throw new Error('Unexpected response from the server.');
  return row;
}

export async function cancelTimeOff(id: string, accountOwnerId: string): Promise<void> {
  const { data, error } = await supabase
    .from('technician_time_off')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('user_id', accountOwnerId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('This entry is no longer available. Reload to see the latest version.');
}

export async function createBlackout(accountOwnerId: string, draft: BlackoutDraft): Promise<BlackoutEntry> {
  const { data, error } = await supabase
    .from('company_blackout_dates')
    .insert({ user_id: accountOwnerId, label: draft.label.trim(), start_date: draft.start_date, end_date: draft.end_date })
    .select(BLACKOUT_COLUMNS)
    .single();
  if (error) throw error;
  const row = normalizeBlackout(data);
  if (!row) throw new Error('Unexpected response from the server.');
  return row;
}

export async function cancelBlackout(id: string, accountOwnerId: string): Promise<void> {
  const { data, error } = await supabase
    .from('company_blackout_dates')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('user_id', accountOwnerId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('This entry is no longer available. Reload to see the latest version.');
}

export async function saveWorkingDays(accountOwnerId: string, technicianId: string, days: number[]): Promise<void> {
  const { error } = await supabase
    .from('technician_availability')
    .upsert({ technician_id: technicianId, user_id: accountOwnerId, working_days: days }, { onConflict: 'technician_id' });
  if (error) throw error;
}

/** Turns any thrown value into a message that is safe and useful to show in a toast. */
export function describeTimeOffError(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  const code = e?.code ?? '';
  const message = typeof e?.message === 'string' ? e.message : '';
  if (code === '42501') return 'You do not have permission to change time off.';
  if (code === '23514') return 'Those dates are not valid. An entry can cover at most 366 days and must end on or after its start.';
  if (code === '23503') return 'That technician is no longer on your team.';
  if (['P0001', '55000', '22023'].includes(code) && message) return message;
  if (err instanceof Error && !code && message && message.length < 140) return message;
  return 'Something went wrong. Please try again.';
}
