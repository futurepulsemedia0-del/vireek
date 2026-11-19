import { describe, expect, it } from 'vitest';
import { describeRedirect, errorRedirect, parseAuthorizeParams, resourceIsOurs, savePending, successRedirect, takePending, clearPending } from './oauthConsent';

const base = 'client_id=vrk_oc_abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A7777%2Fcb&response_type=code&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&resource=https%3A%2F%2Fp.supabase.co%2Ffunctions%2Fv1%2Fmcp-server%2Fmcp&state=xyz';

describe('parseAuthorizeParams', () => {
  it('parses a valid request and defaults to read-only scopes', () => {
    const r = parseAuthorizeParams(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.scopeWasDefaulted).toBe(true);
      expect(r.request.scopes.every((s) => s.endsWith(':read'))).toBe(true);
      expect(r.request.state).toBe('xyz');
    }
  });
  it('keeps only known scopes', () => {
    const r = parseAuthorizeParams(`${base}&scope=jobs%3Aread+nope+payments%3Acollect`);
    expect(r.ok && r.request.scopes).toEqual(['jobs:read', 'payments:collect']);
  });
  it('fails closed on unknown-only scopes, missing params, wrong response_type, oversize state and duplicates', () => {
    expect(parseAuthorizeParams(`${base}&scope=nope`)).toEqual({ ok: false, reason: 'invalid_scope' });
    expect(parseAuthorizeParams('client_id=a')).toEqual({ ok: false, reason: 'missing_params' });
    expect(parseAuthorizeParams(base.replace('response_type=code', 'response_type=token'))).toEqual({ ok: false, reason: 'unsupported_response_type' });
    expect(parseAuthorizeParams(`${base}&state=${'x'.repeat(600)}`)).toEqual({ ok: false, reason: 'duplicate_params' });
    expect(parseAuthorizeParams(base.replace('&state=xyz', `&state=${'x'.repeat(600)}`))).toEqual({ ok: false, reason: 'state_too_long' });
    expect(parseAuthorizeParams(`${base}&client_id=other`)).toEqual({ ok: false, reason: 'duplicate_params' });
  });
});

describe('resourceIsOurs', () => {
  it('accepts only this project\'s MCP server', () => {
    expect(resourceIsOurs('https://p.supabase.co/functions/v1/mcp-server/mcp', 'https://p.supabase.co')).toBe(true);
    expect(resourceIsOurs('https://p.supabase.co/functions/v1/mcp-server', 'https://p.supabase.co/')).toBe(true);
    expect(resourceIsOurs('https://p.supabase.co/functions/v1/other', 'https://p.supabase.co')).toBe(false);
    expect(resourceIsOurs('https://evil.com/functions/v1/mcp-server', 'https://p.supabase.co')).toBe(false);
    expect(resourceIsOurs('not a url', 'https://p.supabase.co')).toBe(false);
  });
});

describe('redirects', () => {
  const req = { redirectUri: 'http://127.0.0.1:7777/cb', state: 'a b' };
  it('adds code/state/iss (RFC 9207) and encodes state', () => {
    expect(successRedirect(req, 'CODE', 'https://vireek.com')).toBe('http://127.0.0.1:7777/cb?code=CODE&state=a+b&iss=https%3A%2F%2Fvireek.com');
  });
  it('builds error redirects and omits state when the client sent none', () => {
    const u = new URL(errorRedirect({ redirectUri: 'cursor://x/cb', state: null }, 'access_denied', 'https://vireek.com'));
    expect(u.searchParams.get('error')).toBe('access_denied');
    expect(u.searchParams.has('state')).toBe(false);
    expect(u.searchParams.get('iss')).toBe('https://vireek.com');
  });
});

describe('describeRedirect', () => {
  it('shows host for web URIs and scheme for app URIs', () => {
    expect(describeRedirect('https://app.example.com/cb')).toBe('app.example.com');
    expect(describeRedirect('http://127.0.0.1:7777/cb')).toBe('127.0.0.1:7777');
    expect(describeRedirect('cursor://anysphere/cb')).toBe('cursor://');
    expect(describeRedirect('junk')).toBe('');
  });
});

describe('pending request storage', () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
  it('round-trips once and then is gone', () => {
    const s = mem();
    savePending('?a=1', s, 1000);
    expect(takePending(s, 2000)).toBe('?a=1');
    expect(takePending(s, 2000)).toBeNull();
  });
  it('can be read without consuming (React double render) and cleared afterwards', () => {
    const s = mem();
    savePending('?a=1', s, 1000);
    expect(takePending(s, 2000, false)).toBe('?a=1');
    expect(takePending(s, 2000, false)).toBe('?a=1');
    clearPending(s);
    expect(takePending(s, 2000)).toBeNull();
  });
  it('expires after 15 minutes and ignores oversized or corrupt data', () => {
    const s = mem();
    savePending('?a=1', s, 0);
    expect(takePending(s, 16 * 60 * 1000)).toBeNull();
    savePending('x'.repeat(5000), s);
    expect(takePending(s)).toBeNull();
    s.setItem('vrk_oauth_pending', '{bad');
    expect(takePending(s)).toBeNull();
  });
});
