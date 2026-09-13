import { supabase } from '@/lib/supabase';

/**
 * Real per-session visibility and revocation (Step 35), built entirely on
 * two SECURITY DEFINER Postgres functions (see the
 * 20260913010000_add_session_management_functions.sql migration) — no
 * edge function or service-role key needed here, since RPC calls run
 * under the caller's own JWT and the functions self-restrict to
 * `auth.uid()`.
 */

export interface OwnSessionRow {
  id: string;
  created_at: string;
  updated_at: string;
  refreshed_at: string | null;
  not_after: string | null;
  user_agent: string | null;
  ip: string | null;
}

export async function listOwnSessions(): Promise<OwnSessionRow[]> {
  const { data, error } = await supabase.rpc('list_own_sessions');
  if (error) throw error;
  return (data ?? []) as OwnSessionRow[];
}

export async function revokeOwnSession(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_own_session', { target_session_id: sessionId });
  if (error) throw error;
}

/**
 * Decodes the `session_id` claim out of the current access token so the
 * UI can mark "This device" in the session list. This does not verify
 * the token's signature — it doesn't need to, since the token is already
 * the one the browser is actively using for a trusted, authenticated
 * request; it's read-only client-side decoding of a JWT we already hold.
 */
export async function getCurrentSessionId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  try {
    const payloadB64 = token.split('.')[1];
    const normalized = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const payload = JSON.parse(atob(padded));
    return payload.session_id ?? null;
  } catch {
    return null;
  }
}

/** Very light user-agent -> readable label, matching the style used for trusted devices. */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isMac = /Macintosh/.test(ua);
  const isWindows = /Windows/.test(ua);
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Safari\//.test(ua) && !/Chrome\//.test(ua)
        ? 'Safari'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : 'Browser';
  const platform = isIOS ? 'iOS' : isAndroid ? 'Android' : isMac ? 'Mac' : isWindows ? 'Windows' : 'device';
  return `${browser} on ${platform}`;
}
