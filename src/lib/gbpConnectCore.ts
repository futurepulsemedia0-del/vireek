// Pure helpers for the Google Business Profile connect card (no React, no Supabase) so they are unit-testable.

export type GbpConnState = 'not_connected' | 'needs_choice' | 'connected';
export interface GbpCandidateRow { location: string; title: string }
export interface GbpConnection { state: GbpConnState; locationName: string | null; locationTitle: string | null; candidates: GbpCandidateRow[] }

const LOCATION_RE = /^locations\/\d{1,24}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Validates the `gbp_connection_state` RPC result; anything unexpected becomes null (the card shows an error). */
export function parseGbpConnection(raw: unknown): GbpConnection | null {
  if (!isObj(raw)) return null;
  const state = raw.state;
  if (state !== 'not_connected' && state !== 'needs_choice' && state !== 'connected') return null;
  const candidates = (Array.isArray(raw.candidates) ? raw.candidates : []).flatMap((c): GbpCandidateRow[] =>
    isObj(c) && typeof c.location === 'string' && LOCATION_RE.test(c.location) ? [{ location: c.location, title: typeof c.title === 'string' && c.title ? c.title : c.location }] : []);
  return {
    state, candidates,
    locationName: typeof raw.location_name === 'string' && LOCATION_RE.test(raw.location_name) ? raw.location_name : null,
    locationTitle: typeof raw.location_title === 'string' && raw.location_title ? raw.location_title : null,
  };
}

export type GbpReturn = { status: 'connected' | 'choose' | 'error'; reason: string | null };
export const GBP_RETURN_REASONS = ['access_denied', 'google_error', 'missing_code_or_state', 'not_configured', 'invalid_state', 'exchange_failed', 'no_refresh_token', 'api_access', 'unavailable', 'no_locations', 'save_failed'] as const;

/** Reads `?gbp=connected|choose|error&reason=...` left by gbp-oauth-callback. Unknown reasons collapse to `unknown`. */
export function parseGbpReturn(search: string): GbpReturn | null {
  const q = new URLSearchParams(search);
  const status = q.get('gbp');
  if (status !== 'connected' && status !== 'choose' && status !== 'error') return null;
  if (status !== 'error') return { status, reason: null };
  const reason = q.get('reason') ?? '';
  return { status, reason: (GBP_RETURN_REASONS as readonly string[]).includes(reason) ? reason : 'unknown' };
}

/** The browser is only ever sent to Google's consent screen, whatever the function returned. */
export function isGoogleAuthUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'accounts.google.com'; } catch { return false; }
}
