// Agent Readiness — Google Business Profile connect helpers. Pure + injected fetch (no Deno globals), so the
// OAuth callback logic is unit-tested with fixtures and never touches Google in tests.
//
// Read-only: the only scope requested is Google's single Business Profile scope (`business.manage`); Google has
// no read-only variant [VERIFY]. The scope is sensitive and needs Google OAuth verification before real customers connect.
import { ACCOUNT_RE, LOCATION_RE } from './gbp.ts';
import { failureFor, GOOGLE_TOKEN_URL, INFO_API, type GbpFetch, type GbpReadFailure } from './gbpClient.ts';

export const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';
export const ACCOUNTS_API = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
export const MAX_ACCOUNTS = 10;
export const MAX_CANDIDATES = 50;
const TIMEOUT_MS = 8000;

export interface GbpCandidate { location: string; account: string; title: string }

export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('scope', GBP_SCOPE);
  u.searchParams.set('state', state);
  return u.toString();
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function parseAccounts(raw: unknown): string[] {
  if (!isObj(raw) || !Array.isArray(raw.accounts)) return [];
  const out: string[] = [];
  for (const a of raw.accounts) if (isObj(a) && typeof a.name === 'string' && ACCOUNT_RE.test(a.name) && !out.includes(a.name)) out.push(a.name);
  return out.slice(0, MAX_ACCOUNTS);
}

export function parseLocationList(raw: unknown, account: string): GbpCandidate[] {
  if (!isObj(raw) || !Array.isArray(raw.locations)) return [];
  const out: GbpCandidate[] = [];
  for (const l of raw.locations) {
    if (!isObj(l) || typeof l.name !== 'string' || !LOCATION_RE.test(l.name)) continue;
    const title = (typeof l.title === 'string' ? l.title.trim() : '').slice(0, 120);
    out.push({ location: l.name, account, title: title || l.name });
  }
  return out;
}

export type TokenExchange =
  | { ok: true; accessToken: string; refreshToken: string; expiresAt: string }
  | { ok: false; code: 'exchange_failed' | 'no_refresh_token' };

/** Authorization-code exchange. Never returns or logs more than the three values needed. */
export async function exchangeCode(
  doFetch: GbpFetch, p: { clientId: string; clientSecret: string; redirectUri: string; code: string }, now: () => number,
): Promise<TokenExchange> {
  let res: Awaited<ReturnType<GbpFetch>>;
  try {
    res = await doFetch(GOOGLE_TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: p.code, client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, grant_type: 'authorization_code' }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { return { ok: false, code: 'exchange_failed' }; }
  if (!res.ok) return { ok: false, code: 'exchange_failed' };
  try {
    const t = JSON.parse(await res.text()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
    if (typeof t.access_token !== 'string' || !t.access_token) return { ok: false, code: 'exchange_failed' };
    if (typeof t.refresh_token !== 'string' || !t.refresh_token) return { ok: false, code: 'no_refresh_token' };
    // The user can untick the permission on Google's consent screen; without the scope every read would 403.
    if (typeof t.scope === 'string' && !t.scope.split(' ').includes(GBP_SCOPE)) return { ok: false, code: 'exchange_failed' };
    const secs = typeof t.expires_in === 'number' && t.expires_in > 0 ? Math.min(t.expires_in, 3600) : 3600;
    return { ok: true, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: new Date(now() + secs * 1000).toISOString() };
  } catch { return { ok: false, code: 'exchange_failed' }; }
}

async function getJson(doFetch: GbpFetch, url: string, token: string): Promise<{ ok: true; body: unknown } | { ok: false; code: GbpReadFailure }> {
  try {
    const res = await doFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, code: failureFor(res.status) };
    const text = await res.text();
    if (text.length > 600_000) return { ok: false, code: 'unavailable' };
    return { ok: true, body: text.trim() ? JSON.parse(text) : {} };
  } catch { return { ok: false, code: 'unavailable' }; }
}

export type CandidateOutcome = { ok: true; candidates: GbpCandidate[]; truncated: boolean } | { ok: false; code: 'api_access' | 'unavailable' };

/** Lists the locations the connecting Google user can read. One page per account (100); capped at MAX_CANDIDATES. */
export async function listCandidates(doFetch: GbpFetch, token: string): Promise<CandidateOutcome> {
  const acc = await getJson(doFetch, ACCOUNTS_API, token);
  if (!acc.ok) return { ok: false, code: acc.code === 'forbidden' || acc.code === 'unauthorized' ? 'api_access' : 'unavailable' };
  const out: GbpCandidate[] = [];
  let truncated = false;
  for (const account of parseAccounts(acc.body)) {
    const loc = await getJson(doFetch, `${INFO_API}/${account}/locations?readMask=name,title&pageSize=100`, token);
    if (!loc.ok) {
      if (loc.code === 'forbidden' || loc.code === 'unauthorized') return { ok: false, code: 'api_access' };
      continue; // one unreadable account must not hide the others
    }
    const found = parseLocationList(loc.body, account);
    if (isObj(loc.body) && typeof loc.body.nextPageToken === 'string' && loc.body.nextPageToken) truncated = true;
    for (const c of found) {
      if (out.length >= MAX_CANDIDATES) { truncated = true; break; }
      if (!out.some((x) => x.location === c.location)) out.push(c);
    }
  }
  return { ok: true, candidates: out, truncated };
}
