import { supabase } from '@/lib/supabase';
import { clearSessionStart } from '@/lib/enterpriseSecurity';
import { listTrustedDevices, revokeTrustedDevice } from '@/lib/deviceTrust';
import type { LoginEventLike } from '@/lib/sessionInsights';

/**
 * Login alerts + sign-out-everywhere — client wrapper.
 *
 * Backed by supabase/migrations/20270403000000_login_alerts.sql. Session
 * and trusted-device listing/revocation already exist in
 * `@/lib/sessions` and `@/lib/deviceTrust` and are reused as-is.
 */

export interface LoginEvent extends LoginEventLike {
  session_id: string;
  user_agent: string | null;
}

export type DeviceStep = 'skipped' | 'ok' | 'partial' | 'failed';

function fail(error: { message: string } | null): void {
  if (error) throw error;
}

/** Supabase errors are plain objects, not Error instances. */
export function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message || fallback;
  }
  return fallback;
}

/**
 * Called once after sign-in. Never throws: a failure to record a login must
 * never get in the way of signing in. Returns true when it raised an alert.
 */
export async function recordLoginEvent(): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('record_login_event');
    if (error) return false;
    return Boolean((data as { alerted?: boolean } | null)?.alerted);
  } catch {
    return false;
  }
}

export async function fetchLoginEvents(userId: string, limit = 25): Promise<LoginEvent[]> {
  const { data, error } = await supabase
    .from('login_events')
    .select('id,session_id,ip,user_agent,device_label,is_new_device,is_new_ip,alerted,acknowledged_at,created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  fail(error);
  return (data ?? []) as LoginEvent[];
}

export async function acknowledgeLoginEvents(): Promise<void> {
  const { error } = await supabase.rpc('acknowledge_login_events');
  fail(error);
}

export async function fetchLoginAlertPreference(userId: string): Promise<boolean> {
  const { data, error } = await supabase.from('profiles').select('notify_login_alert').eq('id', userId).maybeSingle();
  fail(error);
  return (data as { notify_login_alert?: boolean } | null)?.notify_login_alert ?? true;
}

export async function setLoginAlertPreference(userId: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from('profiles').update({ notify_login_alert: enabled }).eq('id', userId);
  fail(error);
}

/**
 * Ends every session on every device, this one included. When
 * `forgetDevices` is set it first removes all trusted devices so the next
 * sign-in anywhere needs a fresh code. Device removal needs a live access
 * token, so it must happen before the global sign-out.
 */
export async function signOutEverywhere(forgetDevices: boolean): Promise<{ deviceStep: DeviceStep }> {
  let deviceStep: DeviceStep = 'skipped';
  if (forgetDevices) {
    try {
      const devices = await listTrustedDevices();
      const results = await Promise.allSettled(devices.map((d) => revokeTrustedDevice(d.id)));
      const failed = results.filter((r) => r.status === 'rejected').length;
      deviceStep = failed === 0 ? 'ok' : failed === results.length ? 'failed' : 'partial';
    } catch {
      deviceStep = 'failed';
    }
  }
  clearSessionStart();
  const { error } = await supabase.auth.signOut({ scope: 'global' });
  if (error) throw error;
  return { deviceStep };
}
