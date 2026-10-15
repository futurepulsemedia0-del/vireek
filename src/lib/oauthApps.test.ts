import { describe, expect, it, vi, beforeEach } from 'vitest';

// Chainable supabase mock — records the calls so scoping can be asserted.
const calls: { table: string; ops: Array<[string, unknown[]]> }[] = [];
let nextResult: { data: unknown; error: unknown } = { data: [], error: null };

function makeBuilder(table: string) {
  const entry = { table, ops: [] as Array<[string, unknown[]]> };
  calls.push(entry);
  const builder: Record<string, unknown> = {};
  for (const op of ['select', 'insert', 'update', 'delete', 'eq', 'is', 'order', 'limit', 'single']) {
    builder[op] = (...args: unknown[]) => {
      entry.ops.push([op, args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => resolve(nextResult);
  return builder;
}

vi.mock('@/lib/supabase', () => ({ supabase: { from: (table: string) => makeBuilder(table) } }));

import {
  validateRedirectUri,
  validateOptionalUrl,
  validateAppInput,
  normalizeAppInput,
  hasErrors,
  grantStatus,
  listOAuthApps,
  createOAuthApp,
  revokeOAuthGrant,
  revokeAllGrantsForApp,
  type OAuthAppInput,
} from '@/lib/oauthApps';

const valid: OAuthAppInput = {
  name: 'Acme CRM',
  description: 'Syncs leads',
  homepage_url: 'https://acme.test',
  privacy_url: '',
  terms_url: '',
  redirect_uris: ['https://acme.test/callback'],
  scopes: ['leads:read'],
};

beforeEach(() => {
  calls.length = 0;
  nextResult = { data: [], error: null };
});

describe('validateRedirectUri', () => {
  it('accepts https and loopback http', () => {
    expect(validateRedirectUri('https://app.example.com/cb')).toBeNull();
    expect(validateRedirectUri('http://localhost:3000/cb')).toBeNull();
    expect(validateRedirectUri('http://127.0.0.1/cb')).toBeNull();
  });

  it('rejects insecure, wildcard, fragment, credential and malformed URIs', () => {
    expect(validateRedirectUri('http://example.com/cb')).toMatch(/https/);
    expect(validateRedirectUri('https://*.example.com/cb')).toMatch(/Wildcard/);
    expect(validateRedirectUri('https://example.com/cb#x')).toMatch(/fragment/);
    expect(validateRedirectUri('https://user:pw@example.com/cb')).toMatch(/credentials/);
    expect(validateRedirectUri('javascript:alert(1)')).not.toBeNull();
    expect(validateRedirectUri('not a url')).toMatch(/valid/);
    expect(validateRedirectUri('  ')).toMatch(/Enter/);
  });
});

describe('validateOptionalUrl', () => {
  it('allows empty, requires https otherwise', () => {
    expect(validateOptionalUrl('')).toBeNull();
    expect(validateOptionalUrl('https://x.test')).toBeNull();
    expect(validateOptionalUrl('http://x.test')).not.toBeNull();
  });
});

describe('validateAppInput', () => {
  it('passes a valid input', () => {
    expect(hasErrors(validateAppInput(valid))).toBe(false);
  });

  it('flags name, scopes and redirect problems', () => {
    const e = validateAppInput({ ...valid, name: 'a', scopes: [], redirect_uris: [''] });
    expect(e.name).toBeDefined();
    expect(e.scopes).toBeDefined();
    expect(e.redirect_uris).toBeDefined();
  });

  it('rejects duplicates, too many URIs and unknown scopes', () => {
    expect(validateAppInput({ ...valid, redirect_uris: ['https://a.test/cb', 'https://a.test/cb'] }).redirect_uris).toMatch(/unique/);
    const many = Array.from({ length: 11 }, (_, i) => `https://a.test/${i}`);
    expect(validateAppInput({ ...valid, redirect_uris: many }).redirect_uris).toMatch(/At most/);
    expect(validateAppInput({ ...valid, scopes: ['admin:all' as never] }).scopes).toMatch(/Unknown/);
  });
});

describe('normalizeAppInput', () => {
  it('trims, dedupes and nulls empty optional URLs', () => {
    const n = normalizeAppInput({
      ...valid,
      name: '  Acme  ',
      redirect_uris: [' https://a.test/cb ', 'https://a.test/cb', ''],
      scopes: ['leads:read', 'leads:read'],
    });
    expect(n.name).toBe('Acme');
    expect(n.redirect_uris).toEqual(['https://a.test/cb']);
    expect(n.scopes).toEqual(['leads:read']);
    expect(n.privacy_url).toBeNull();
    expect(n.homepage_url).toBe('https://acme.test');
  });
});

describe('grantStatus', () => {
  const now = new Date('2027-04-10T00:00:00Z').getTime();
  it('derives active / expired / revoked', () => {
    expect(grantStatus({ revoked_at: null, expires_at: null }, now)).toBe('active');
    expect(grantStatus({ revoked_at: null, expires_at: '2027-04-09T00:00:00Z' }, now)).toBe('expired');
    expect(grantStatus({ revoked_at: null, expires_at: '2027-04-11T00:00:00Z' }, now)).toBe('active');
    expect(grantStatus({ revoked_at: '2027-04-01T00:00:00Z', expires_at: null }, now)).toBe('revoked');
  });
});

describe('data access is scoped to the account owner', () => {
  it('listOAuthApps filters by user_id', async () => {
    await listOAuthApps('owner-1');
    expect(calls[0].table).toBe('oauth_apps');
    expect(calls[0].ops).toContainEqual(['eq', ['user_id', 'owner-1']]);
  });

  it('createOAuthApp writes owner id + only a hashed secret, returns raw secret once', async () => {
    nextResult = { data: { id: 'a1', client_id: 'vrk_app_x' }, error: null };
    const { rawSecret } = await createOAuthApp('owner-1', valid);
    expect(rawSecret).toMatch(/^vrk_secret_[0-9a-f]{64}$/);
    const insert = calls[0].ops.find(([op]) => op === 'insert');
    const row = (insert?.[1] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(row.user_id).toBe('owner-1');
    expect(row.client_secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(rawSecret);
    expect(String(row.client_id)).toMatch(/^vrk_app_[0-9a-f]{24}$/);
  });

  it('createOAuthApp refuses invalid input before touching the database', async () => {
    await expect(createOAuthApp('owner-1', { ...valid, scopes: [] })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('revoke helpers scope by owner and only touch active tokens', async () => {
    await revokeOAuthGrant('owner-1', 'g1');
    await revokeAllGrantsForApp('owner-1', 'a1');
    for (const c of calls) {
      expect(c.table).toBe('oauth_grants');
      expect(c.ops).toContainEqual(['eq', ['user_id', 'owner-1']]);
      expect(c.ops).toContainEqual(['is', ['revoked_at', null]]);
    }
  });

  it('surfaces database errors', async () => {
    nextResult = { data: null, error: new Error('boom') };
    await expect(listOAuthApps('owner-1')).rejects.toThrow('boom');
  });
});
