import { supabase } from '@/lib/supabase';
import type { ClockEvent, ServerShiftJson } from '@/lib/timeClock';
import type { SendResult } from '@/lib/timeClockQueue';

export interface TimeProfile {
  teamMemberId: string;
  employeeId: string | null;
  ownerId: string;
  fullName: string;
  standardHoursPerWeek: number | null;
}

export interface ClosedShift {
  id: string;
  work_date: string;
  clock_in_at: string;
  clock_out_at: string;
  break_minutes: number;
  net_minutes: number | null;
  in_gps_error: string | null;
}

export async function fetchTimeProfile(): Promise<TimeProfile | null> {
  const { data, error } = await supabase.rpc('get_my_time_profile');
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { team_member_id: string; employee_id: string | null; owner_id: string; full_name: string; standard_hours_per_week: number | null }
    | undefined;
  return row
    ? { teamMemberId: row.team_member_id, employeeId: row.employee_id, ownerId: row.owner_id, fullName: row.full_name, standardHoursPerWeek: row.standard_hours_per_week }
    : null;
}

export async function fetchOpenShift(): Promise<ServerShiftJson | null> {
  const { data, error } = await supabase.rpc('get_my_open_shift');
  if (error) throw new Error(error.message);
  return (data as ServerShiftJson | null) ?? null;
}

export async function fetchRecentShifts(ownerId: string, teamMemberId: string, limit = 14): Promise<ClosedShift[]> {
  const { data, error } = await supabase
    .from('time_shifts')
    .select('id, work_date, clock_in_at, clock_out_at, break_minutes, net_minutes, in_gps_error')
    .eq('user_id', ownerId)
    .eq('team_member_id', teamMemberId)
    .eq('status', 'closed')
    .order('clock_in_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as ClosedShift[];
}

export async function sendClockEvents(events: ClockEvent[]): Promise<SendResult[]> {
  const { data, error } = await supabase.rpc('apply_time_events', { p_events: events });
  if (error) {
    // Business errors (not linked to payroll, etc.) are permanent; everything else is retried.
    if (/tc_no_employee|tc_not_a_team_member/.test(error.message)) {
      const code = /tc_no_employee/.test(error.message) ? 'tc_no_employee' : 'tc_not_a_team_member';
      return events.map((e) => ({ id: e.id, outcome: 'rejected' as const, code }));
    }
    throw new Error(error.message);
  }
  return (data ?? []) as SendResult[];
}
