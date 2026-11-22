import { describe, expect, it } from 'vitest';
import { revokeProviderAccess } from './revocation';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Scripted fetch: each entry answers one call in order; records everything that was sent. */
function scriptedFetch(script: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body == null ? null : init.body instanceof URLSearchParams ? init.body.toString() : String(init.body);
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body });
    const next = script.shift();
    if (!next) throw new Error('unexpected extra fetch call');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchFn, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const empty = (status: number) => new Response(null, { status });

const SECRET_A = 'secret-access-token-AAA';
const SECRET_R = 'secret/refresh+token=RRR';

describe('google', () => {
  it('revokes the refresh token (preferred over the access token) via RFC 7009', async () => {
    const { fetchFn, calls } = scriptedFetch([empty(200)]);
    const r = await revokeProviderAccess('google_calendar', { access_token: SECRET_A, refresh_token: SECRET_R }, { fetchFn });
    expect(r).toEqual({ outcome: 'revoked', detail: 'google_revoked', manualActionRequired: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/revoke');
    expect(calls[0].method).toBe('POST');
    expect(new URLSearchParams(calls[0].body ?? '').get('token')).toBe(SECRET_R);
  });

  it('falls back to the access token when there is no refresh token', async () => {
    const { fetchFn, calls } = scriptedFetch([empty(200)]);
    await revokeProviderAccess('google_calendar', { access_token: SECRET_A }, { fetchFn });
    expect(new URLSearchParams(calls[0].body ?? '').get('token')).toBe(SECRET_A);
  });

  it('treats 400 invalid_token (already revoked/expired) as nothing left to revoke', async () => {
    const { fetchFn } = scriptedFetch([json(400, { error: 'invalid_token' })]);
    const r = await revokeProviderAccess('google_calendar', { refresh_token: SECRET_R }, { fetchFn });
    expect(r.outcome).toBe('revoked');
    expect(r.detail).toBe('google_token_already_invalid');
  });

  it('reports failure for other 400s and 5xx, without leaking the body', async () => {
    const { fetchFn } = scriptedFetch([json(400, { error: 'invalid_request', error_description: SECRET_R })]);
    const r = await revokeProviderAccess('google_calendar', { refresh_token: SECRET_R }, { fetchFn });
    expect(r.outcome).toBe('failed');
    expect(r.detail).toBe('google_http_400');
    expect(JSON.stringify(r)).not.toContain(SECRET_R);
  });

  it('reports failure on network errors and never throws', async () => {
    const { fetchFn } = scriptedFetch([new Error(`connect failed for ${SECRET_R}`)]);
    const r = await revokeProviderAccess('google_calendar', { refresh_token: SECRET_R }, { fetchFn });
    expect(r).toEqual({ outcome: 'failed', detail: 'google_network_error', manualActionRequired: false });
    expect(JSON.stringify(r)).not.toContain(SECRET_R);
  });

  it('makes no call when there are no credentials', async () => {
    const { fetchFn, calls } = scriptedFetch([]);
    const r = await revokeProviderAccess('google_calendar', {}, { fetchFn });
    expect(r.outcome).toBe('no_credentials');
    expect(calls).toHaveLength(0);
  });
});

describe('hubspot', () => {
  it('deletes the refresh token, URL-encoded in the path, and still asks for manual uninstall', async () => {
    const { fetchFn, calls } = scriptedFetch([empty(204)]);
    const r = await revokeProviderAccess('hubspot', { access_token: SECRET_A, refresh_token: SECRET_R }, { fetchFn });
    expect(r).toEqual({ outcome: 'revoked', detail: 'hubspot_refresh_token_deleted', manualActionRequired: true });
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe(`https://api.hubapi.com/oauth/v1/refresh-tokens/${encodeURIComponent(SECRET_R)}`);
    expect(calls[0].url).not.toContain(SECRET_A);
  });

  it('treats 404 as already invalid', async () => {
    const { fetchFn } = scriptedFetch([empty(404)]);
    const r = await revokeProviderAccess('hubspot', { refresh_token: SECRET_R }, { fetchFn });
    expect(r.outcome).toBe('revoked');
    expect(r.detail).toBe('hubspot_token_already_invalid');
  });

  it('reports failure on 5xx / 401', async () => {
    const { fetchFn } = scriptedFetch([empty(503), empty(401)]);
    expect((await revokeProviderAccess('hubspot', { refresh_token: SECRET_R }, { fetchFn })).detail).toBe('hubspot_http_503');
    expect((await revokeProviderAccess('hubspot', { refresh_token: SECRET_R }, { fetchFn })).detail).toBe('hubspot_http_401');
  });

  it('cannot revoke an access token alone (no endpoint) => no_credentials + manual action', async () => {
    const { fetchFn, calls } = scriptedFetch([]);
    const r = await revokeProviderAccess('hubspot', { access_token: SECRET_A }, { fetchFn });
    expect(r).toEqual({ outcome: 'no_credentials', detail: 'hubspot_no_refresh_token', manualActionRequired: true });
    expect(calls).toHaveLength(0);
  });
});

describe('jobber', () => {
  const ok = () => json(200, { data: { appDisconnect: { app: { name: 'Vireek' }, userErrors: [] } } });

  it('calls the appDisconnect mutation with the bearer token and API version header', async () => {
    const { fetchFn, calls } = scriptedFetch([ok()]);
    const r = await revokeProviderAccess('jobber', { jobber_access_token: SECRET_A, jobber_refresh_token: SECRET_R }, { fetchFn });
    expect(r).toEqual({ outcome: 'revoked', detail: 'jobber_app_disconnected', manualActionRequired: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.getjobber.com/api/graphql');
    expect(calls[0].headers['authorization']).toBe(`Bearer ${SECRET_A}`);
    expect(calls[0].headers['x-jobber-graphql-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calls[0].body).toContain('appDisconnect');
    expect(calls[0].body).not.toContain(SECRET_A);
  });

  it('refreshes once when the stored access token is rejected (401), then disconnects', async () => {
    const { fetchFn, calls } = scriptedFetch([empty(401), ok()]);
    const seen: string[] = [];
    const r = await revokeProviderAccess(
      'jobber',
      { jobber_access_token: SECRET_A, jobber_refresh_token: SECRET_R },
      { fetchFn, refreshJobberAccessToken: async (rt) => (seen.push(rt), 'fresh-token') },
    );
    expect(r.outcome).toBe('revoked');
    expect(seen).toEqual([SECRET_R]);
    expect(calls[1].headers['authorization']).toBe('Bearer fresh-token');
  });

  it('refreshes straight away when only a refresh token is stored', async () => {
    const { fetchFn, calls } = scriptedFetch([ok()]);
    const r = await revokeProviderAccess('jobber', { jobber_refresh_token: SECRET_R }, { fetchFn, refreshJobberAccessToken: async () => 'fresh-token' });
    expect(r.outcome).toBe('revoked');
    expect(calls).toHaveLength(1);
  });

  it('fails (and never loops) when the refresh also fails', async () => {
    const { fetchFn, calls } = scriptedFetch([empty(401)]);
    const r = await revokeProviderAccess(
      'jobber',
      { jobber_access_token: SECRET_A, jobber_refresh_token: SECRET_R },
      { fetchFn, refreshJobberAccessToken: async () => null },
    );
    expect(r).toEqual({ outcome: 'failed', detail: 'jobber_refresh_failed', manualActionRequired: false });
    expect(calls).toHaveLength(1);
  });

  it('fails when the token is rejected and no refresh is possible', async () => {
    const { fetchFn } = scriptedFetch([empty(401)]);
    const r = await revokeProviderAccess('jobber', { jobber_access_token: SECRET_A }, { fetchFn });
    expect(r.detail).toBe('jobber_token_rejected_no_refresh');
  });

  it('does not throw when the refresh callback throws', async () => {
    const { fetchFn } = scriptedFetch([]);
    const r = await revokeProviderAccess(
      'jobber',
      { jobber_refresh_token: SECRET_R },
      { fetchFn, refreshJobberAccessToken: async () => { throw new Error(`boom ${SECRET_R}`); } },
    );
    expect(r.outcome).toBe('failed');
    expect(JSON.stringify(r)).not.toContain(SECRET_R);
  });

  it('classifies GraphQL-level failures (HTTP 200 with errors / userErrors / empty data)', async () => {
    const throttled = json(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] });
    const generic = json(200, { errors: [{ message: `bad ${SECRET_A}` }] });
    const userErr = json(200, { data: { appDisconnect: { app: null, userErrors: [{ message: 'nope' }] } } });
    const missing = json(200, { data: {} });
    const { fetchFn } = scriptedFetch([throttled, generic, userErr, missing]);
    const run = () => revokeProviderAccess('jobber', { jobber_access_token: SECRET_A }, { fetchFn });
    expect((await run()).detail).toBe('jobber_throttled');
    const g = await run();
    expect(g.detail).toBe('jobber_graphql_error');
    expect(JSON.stringify(g)).not.toContain(SECRET_A);
    expect((await run()).detail).toBe('jobber_user_errors');
    expect((await run()).detail).toBe('jobber_unexpected_response');
  });

  it('treats a GraphQL UNAUTHENTICATED error like a 401 (refresh and retry)', async () => {
    const unauth = json(200, { errors: [{ message: 'x', extensions: { code: 'UNAUTHENTICATED' } }] });
    const { fetchFn } = scriptedFetch([unauth, ok()]);
    const r = await revokeProviderAccess(
      'jobber',
      { jobber_access_token: SECRET_A, jobber_refresh_token: SECRET_R },
      { fetchFn, refreshJobberAccessToken: async () => 'fresh' },
    );
    expect(r.outcome).toBe('revoked');
  });

  it('no tokens => no_credentials, no call', async () => {
    const { fetchFn, calls } = scriptedFetch([]);
    expect((await revokeProviderAccess('jobber', {}, { fetchFn })).outcome).toBe('no_credentials');
    expect(calls).toHaveLength(0);
  });
});

describe('providers without a documented revocation endpoint', () => {
  it.each(['service_titan', 'housecall_pro'] as const)('%s is reported as unsupported with manual action, and nothing is sent', async (provider) => {
    const { fetchFn, calls } = scriptedFetch([]);
    const r = await revokeProviderAccess(provider, { st_client_secret: SECRET_A, hcp_api_key: SECRET_R }, { fetchFn });
    expect(r.outcome).toBe('unsupported');
    expect(r.manualActionRequired).toBe(true);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain(SECRET_A);
  });
});
