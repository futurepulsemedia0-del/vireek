import { describe, expect, it } from 'vitest';
import { ACCOUNTS_API, GBP_SCOPE, MAX_CANDIDATES, buildAuthorizeUrl, exchangeCode, listCandidates, parseAccounts, parseLocationList } from './gbpConnect.ts';
import type { GbpFetch } from './gbpClient.ts';

const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const bad = (status: number) => ({ ok: false, status, text: async () => '{}' });
const NOW = () => Date.parse('2026-11-19T10:00:00Z');

describe('buildAuthorizeUrl', () => {
  it('requests offline access, forced consent and only the business.manage scope', () => {
    const u = new URL(buildAuthorizeUrl('cid', 'https://x.supabase.co/functions/v1/gbp-oauth-callback', 'st.ate'));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('scope')).toBe(GBP_SCOPE);
    expect(u.searchParams.get('state')).toBe('st.ate');
    expect(u.searchParams.get('redirect_uri')).toBe('https://x.supabase.co/functions/v1/gbp-oauth-callback');
  });
});

describe('parseAccounts / parseLocationList', () => {
  it('keeps only well-formed names, dedupes and caps accounts', () => {
    expect(parseAccounts({ accounts: [{ name: 'accounts/1' }, { name: 'accounts/1' }, { name: 'accounts/x' }, { name: 5 }, null] })).toEqual(['accounts/1']);
    expect(parseAccounts({ accounts: Array.from({ length: 30 }, (_, i) => ({ name: `accounts/${i + 1}` })) })).toHaveLength(10);
    expect(parseAccounts(null)).toEqual([]);
    expect(parseAccounts({ accounts: 'x' })).toEqual([]);
  });
  it('maps locations, trims and cuts titles, falls back to the name, drops junk', () => {
    const out = parseLocationList({ locations: [{ name: 'locations/10', title: '  Acme  ' }, { name: 'locations/11' }, { name: 'locations/../1', title: 'evil' }, { name: 'locations/12', title: 'T'.repeat(500) }, 7] }, 'accounts/1');
    expect(out.map((c) => c.location)).toEqual(['locations/10', 'locations/11', 'locations/12']);
    expect(out[0]).toEqual({ location: 'locations/10', account: 'accounts/1', title: 'Acme' });
    expect(out[1].title).toBe('locations/11');
    expect(out[2].title.length).toBe(120);
  });
});

describe('exchangeCode', () => {
  const p = { clientId: 'c', clientSecret: 's', redirectUri: 'https://r', code: 'abc' };
  it('returns tokens with a capped expiry', async () => {
    const f: GbpFetch = async () => ok({ access_token: 'a', refresh_token: 'r', expires_in: 99999, scope: `openid ${GBP_SCOPE}` });
    expect(await exchangeCode(f, p, NOW)).toEqual({ ok: true, accessToken: 'a', refreshToken: 'r', expiresAt: '2026-11-19T11:00:00.000Z' });
  });
  it('fails closed: no refresh token, scope unticked, HTTP error, network error, junk', async () => {
    expect(await exchangeCode(async () => ok({ access_token: 'a' }), p, NOW)).toEqual({ ok: false, code: 'no_refresh_token' });
    expect(await exchangeCode(async () => ok({ access_token: 'a', refresh_token: 'r', scope: 'openid email' }), p, NOW)).toEqual({ ok: false, code: 'exchange_failed' });
    expect(await exchangeCode(async () => bad(400), p, NOW)).toEqual({ ok: false, code: 'exchange_failed' });
    expect(await exchangeCode(async () => { throw new Error('x'); }, p, NOW)).toEqual({ ok: false, code: 'exchange_failed' });
    expect(await exchangeCode(async () => ({ ok: true, status: 200, text: async () => '<html>' }), p, NOW)).toEqual({ ok: false, code: 'exchange_failed' });
  });
  it('sends the authorization_code grant as a form body', async () => {
    let body = '';
    await exchangeCode(async (_u, init) => { body = init.body ?? ''; return bad(400); }, p, NOW);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=abc');
  });
});

describe('listCandidates', () => {
  const route = (accounts: unknown, perAccount: Record<string, unknown>): GbpFetch => async (url) => {
    if (url === ACCOUNTS_API) return accounts instanceof Error ? bad(403) : ok(accounts);
    const m = /\/(accounts\/\d+)\/locations/.exec(url);
    const r = m ? perAccount[m[1]] : undefined;
    return typeof r === 'number' ? bad(r) : ok(r ?? {});
  };
  it('collects locations across accounts, tagging each with its account', async () => {
    const f = route({ accounts: [{ name: 'accounts/1' }, { name: 'accounts/2' }] }, {
      'accounts/1': { locations: [{ name: 'locations/10', title: 'A' }] }, 'accounts/2': { locations: [{ name: 'locations/20', title: 'B' }] },
    });
    const out = await listCandidates(f, 't');
    expect(out).toEqual({ ok: true, truncated: false, candidates: [{ location: 'locations/10', account: 'accounts/1', title: 'A' }, { location: 'locations/20', account: 'accounts/2', title: 'B' }] });
  });
  it('an unreadable account does not hide the others, but an access refusal stops everything', async () => {
    const some = route({ accounts: [{ name: 'accounts/1' }, { name: 'accounts/2' }] }, { 'accounts/1': 500, 'accounts/2': { locations: [{ name: 'locations/20' }] } });
    const r = await listCandidates(some, 't');
    expect(r.ok && r.candidates.length).toBe(1);
    const denied = route({ accounts: [{ name: 'accounts/1' }] }, { 'accounts/1': 403 });
    expect(await listCandidates(denied, 't')).toEqual({ ok: false, code: 'api_access' });
    expect(await listCandidates(route(new Error('x'), {}), 't')).toEqual({ ok: false, code: 'api_access' });
    expect(await listCandidates(async () => bad(503), 't')).toEqual({ ok: false, code: 'unavailable' });
  });
  it('dedupes a location seen twice, caps the list and flags truncation', async () => {
    const dup = route({ accounts: [{ name: 'accounts/1' }, { name: 'accounts/2' }] }, { 'accounts/1': { locations: [{ name: 'locations/1' }] }, 'accounts/2': { locations: [{ name: 'locations/1' }] } });
    const d = await listCandidates(dup, 't');
    expect(d.ok && d.candidates.length).toBe(1);
    const many = route({ accounts: [{ name: 'accounts/1' }] }, { 'accounts/1': { locations: Array.from({ length: 100 }, (_, i) => ({ name: `locations/${i + 1}` })), nextPageToken: 'n' } });
    const m = await listCandidates(many, 't');
    expect(m.ok && m.candidates.length).toBe(MAX_CANDIDATES);
    expect(m.ok && m.truncated).toBe(true);
  });
  it('only ever issues GET requests with a bearer token', async () => {
    const seen: string[] = [];
    const f: GbpFetch = async (url, init) => { seen.push(`${init.method} ${init.headers.Authorization}`); return url === ACCOUNTS_API ? ok({ accounts: [{ name: 'accounts/1' }] }) : ok({ locations: [] }); };
    await listCandidates(f, 'tok');
    expect(seen.every((s) => s === 'GET Bearer tok')).toBe(true);
  });
});
