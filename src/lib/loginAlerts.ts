import { supabase } from '@/lib/supabase';
import { getCurrentSessionId } from '@/lib/sessions';

/**
 * Reports "a sign-in completed in this session" to the `login-alert` edge
 * function, which decides (server-side, from Supabase Auth's own record of
 * the session's IP / user agent) whether to send a new-device or
 * new-location alert by email + push.
 *
 * Called once per session from <ProtectedRoute> — i.e. only after the whole
 * login flow (including the OTP step-up) has finished, never for the
 * intermediate password-only session that the step-up discards. The server
 * is idempotent on session_id, so retries and parallel tabs are harmless.
 */

const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/login-alert`;
const storageKey = (sessionId: string) => `vrk_login_reported:${sessionId}`;

function markReported(sessionId: string, on: boolean): void {
  try {
    if (on) sessionStorage.setItem(storageKey(sessionId), '1');
    else sessionStorage.removeItem(storageKey(sessionId));
  } catch {
    /* storage unavailable — the server dedupes anyway */
  }
}

function alreadyReported(sessionId: string): boolean {
  try {
    return sessionStorage.getItem(storageKey(sessionId)) === '1';
  } catch {
    return false;
  }
}

async function post(accessToken: string, withCredentials: boolean): Promise<Response> {
  return fetch(FUNCTION_URL, {
    method: 'POST',
    // `include` lets the browser send the httpOnly device cookie so the
    // server can recognise a trusted browser.
    credentials: withCredentials ? 'include' : 'omit',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: '{}',
  });
}

/** Fire-and-forget safe: never throws, never blocks the UI. */
export async function reportLoginForCurrentSession(): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    const sessionId = await getCurrentSessionId();
    if (!accessToken || !sessionId || alreadyReported(sessionId)) return;

    markReported(sessionId, true); // claim first so StrictMode / fast re-renders don't double-fire
    let res: Response;
    try {
      res = await post(accessToken, true);
    } catch {
      // Credentialed CORS can be rejected by a misconfigured origin list;
      // retry without the cookie (server falls back to user-agent matching).
      res = await post(accessToken, false);
    }
    if (!res.ok) markReported(sessionId, false);
  } catch {
    /* alerts are best-effort; sign-in must never fail because of them */
  }
}
