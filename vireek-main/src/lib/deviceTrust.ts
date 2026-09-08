import { supabase } from '@/lib/supabase';

/**
 * Thin client for the `trusted-device` edge function. The function is the
 * only thing that ever reads/writes the httpOnly device cookie or the
 * trusted_devices table — this file just calls it with the caller's own
 * Supabase access token so the function can identify the user securely.
 *
 * `credentials: 'include'` is required on every call so the browser sends
 * and accepts the httpOnly cookie the function sets/reads.
 */

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trusted-device`;

async function callDeviceFn<T>(body: Record<string, unknown>): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error('No active session');

  const res = await fetch(FUNCTIONS_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Device trust request failed');
  }
  return res.json();
}

/** Is the browser making this request already a trusted device for the signed-in user? */
export async function checkDeviceTrusted(): Promise<boolean> {
  try {
    const result = await callDeviceFn<{ trusted: boolean }>({ action: 'check' });
    return result.trusted;
  } catch {
    // Fail closed: if the check can't be completed, treat the device as
    // untrusted so the user gets the OTP step-up instead of a silent skip.
    return false;
  }
}

/** Mark the current browser as trusted for the signed-in user (issues a fresh device cookie). */
export async function registerTrustedDevice(): Promise<void> {
  await callDeviceFn<{ registered: boolean }>({ action: 'register' });
}

export interface TrustedDeviceRow {
  id: string;
  device_name: string | null;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  is_current: boolean;
}

export async function listTrustedDevices(): Promise<TrustedDeviceRow[]> {
  const result = await callDeviceFn<{ devices: TrustedDeviceRow[] }>({ action: 'list' });
  return result.devices;
}

export async function revokeTrustedDevice(deviceId: string): Promise<void> {
  await callDeviceFn<{ revoked: boolean }>({ action: 'revoke', device_id: deviceId });
}
