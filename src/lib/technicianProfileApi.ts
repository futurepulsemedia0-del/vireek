import { supabase } from '@/lib/supabase';
import {
  ALERT_LEAD_OPTIONS,
  DEFAULT_PREFERENCES,
  type AlertLeadDays,
  type MyTechnicianProfile,
  type TechCredential,
  type TechnicianMember,
  type TechnicianPreferences,
} from '@/lib/technicianProfile';

const CREDENTIAL_COLUMNS =
  'id, credential_type, credential_name, issuing_authority, credential_number, issued_at, expires_at, status';
const MEMBER_COLUMNS =
  'id, member_name, member_email, member_phone, skills, languages, service_area, max_jobs_per_day, dispatch_enabled';

/**
 * Loads the signed-in technician's own profile. Returns null when this login has no
 * team_members row (e.g. an owner previewing /tech). Every query is pinned to the
 * caller's own team member id, resolved server-side by get_my_team_member_id().
 */
export async function fetchMyTechnicianProfile(): Promise<MyTechnicianProfile | null> {
  const idRes = await supabase.rpc('get_my_team_member_id');
  if (idRes.error) throw idRes.error;
  const memberId = idRes.data as string | null;
  if (!memberId) return null;

  const [memberRes, credRes, prefRes] = await Promise.all([
    supabase.from('team_members').select(MEMBER_COLUMNS).eq('id', memberId).maybeSingle(),
    supabase.from('technician_credentials').select(CREDENTIAL_COLUMNS).eq('technician_id', memberId),
    supabase.from('technician_preferences').select('*').eq('technician_id', memberId).maybeSingle(),
  ]);
  if (memberRes.error) throw memberRes.error;
  if (credRes.error) throw credRes.error;
  if (prefRes.error) throw prefRes.error;
  if (!memberRes.data) return null;

  const m = memberRes.data as Partial<TechnicianMember> & { id: string; member_email: string };
  const member: TechnicianMember = {
    id: m.id,
    member_name: m.member_name ?? null,
    member_email: m.member_email,
    member_phone: m.member_phone ?? null,
    skills: m.skills ?? [],
    languages: m.languages ?? [],
    service_area: m.service_area ?? null,
    max_jobs_per_day: m.max_jobs_per_day ?? 6,
    dispatch_enabled: m.dispatch_enabled ?? true,
  };

  const p = prefRes.data as Partial<TechnicianPreferences> | null;
  const preferences: TechnicianPreferences = {
    notify_credential_expiry: p?.notify_credential_expiry ?? DEFAULT_PREFERENCES.notify_credential_expiry,
    credential_alert_days: ALERT_LEAD_OPTIONS.includes(p?.credential_alert_days as AlertLeadDays)
      ? (p!.credential_alert_days as AlertLeadDays)
      : DEFAULT_PREFERENCES.credential_alert_days,
    notify_job_assigned: p?.notify_job_assigned ?? DEFAULT_PREFERENCES.notify_job_assigned,
    notify_schedule_change: p?.notify_schedule_change ?? DEFAULT_PREFERENCES.notify_schedule_change,
  };

  return { member, credentials: (credRes.data ?? []) as TechCredential[], preferences };
}

export async function saveMyAvailability(input: { dispatchEnabled: boolean; maxJobsPerDay: number }): Promise<void> {
  const { error } = await supabase.rpc('set_my_technician_availability', {
    p_dispatch_enabled: input.dispatchEnabled,
    p_max_jobs_per_day: input.maxJobsPerDay,
  });
  if (error) throw error;
}

export async function saveMyPreferences(prefs: TechnicianPreferences): Promise<void> {
  const { error } = await supabase.rpc('save_my_technician_preferences', {
    p_notify_credential_expiry: prefs.notify_credential_expiry,
    p_credential_alert_days: prefs.credential_alert_days,
    p_notify_job_assigned: prefs.notify_job_assigned,
    p_notify_schedule_change: prefs.notify_schedule_change,
  });
  if (error) throw error;
}
