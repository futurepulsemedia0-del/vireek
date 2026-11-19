// Agent Readiness — read-only Google Business Profile client. Network goes through an injected `fetch`
// so tests use fixtures and never touch Google. No Deno globals, never logs a token or a response body.
//
// Read-only by construction: this module only issues GET requests. Writes stay in `gbp-sync`.
import { ACCOUNT_RE, LOCATION_RE, LOCATION_READ_MASK, parseLocation, parseMediaCount, type GbpFacts, type GbpStatus } from './gbp.ts';

export const INFO_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
/** v4 media list. It is the only place the photo count lives. [VERIFY] still served for this project. */
export const MEDIA_API = 'https://mybusiness.googleapis.com/v4';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const MAX_BODY_CHARS = 600_000;
const TIMEOUT_MS = 8000;

export type GbpFetch = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

export type GbpReadFailure = Exclude<GbpStatus, 'ok' | 'disabled' | 'not_connected' | 'no_location'>;
export type GbpReadOutcome = { ok: true; facts: GbpFacts } | { ok: false; code: GbpReadFailure };

export function failureFor(status: number): GbpReadFailure {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

async function getJson(doFetch: GbpFetch, url: string, token: string): Promise<{ ok: true; body: unknown } | { ok: false; code: GbpReadFailure }> {
  let res: Awaited<ReturnType<GbpFetch>>;
  try {
    res = await doFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { ok: false, code: 'unavailable' };
  }
  if (!res.ok) return { ok: false, code: failureFor(res.status) };
  try {
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) return { ok: false, code: 'unavailable' };
    return { ok: true, body: text.trim() === '' ? {} : JSON.parse(text) };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}

/**
 * Read one location. `accountName` is optional: without it the photo count stays null (the media list needs it).
 * A failing media call never fails the read.
 */
export async function readLocation(
  doFetch: GbpFetch, token: string, locationName: string, accountName: string | null,
): Promise<GbpReadOutcome> {
  if (!LOCATION_RE.test(locationName)) return { ok: false, code: 'not_found' };
  const loc = await getJson(doFetch, `${INFO_API}/${locationName}?readMask=${encodeURIComponent(LOCATION_READ_MASK)}`, token);
  if (!loc.ok) return loc;
  const facts = parseLocation(loc.body);
  if (!facts) return { ok: false, code: 'unavailable' };
  if (accountName && ACCOUNT_RE.test(accountName)) {
    const media = await getJson(doFetch, `${MEDIA_API}/${accountName}/${locationName}/media?pageSize=1`, token);
    if (media.ok) facts.photoCount = parseMediaCount(media.body);
  }
  return { ok: true, facts };
}

export type TokenOutcome = { ok: true; accessToken: string; expiresAt: string } | { ok: false; code: 'unauthorized' | 'unavailable' };

/** Exchange a refresh token. Never returns or logs the refresh token. `invalid_grant` (revoked) maps to `unauthorized`. */
export async function refreshAccessToken(
  doFetch: GbpFetch, clientId: string, clientSecret: string, refreshToken: string, now: () => number,
): Promise<TokenOutcome> {
  let res: Awaited<ReturnType<GbpFetch>>;
  try {
    res = await doFetch(GOOGLE_TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: 'unavailable' };
  }
  if (res.status === 400 || res.status === 401) return { ok: false, code: 'unauthorized' };
  if (!res.ok) return { ok: false, code: 'unavailable' };
  try {
    const tok = JSON.parse(await res.text()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof tok.access_token !== 'string' || !tok.access_token) return { ok: false, code: 'unavailable' };
    const secs = typeof tok.expires_in === 'number' && tok.expires_in > 0 ? Math.min(tok.expires_in, 3600) : 3600;
    return { ok: true, accessToken: tok.access_token, expiresAt: new Date(now() + secs * 1000).toISOString() };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}
