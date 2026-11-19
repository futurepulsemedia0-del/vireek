import { describe, it, expect } from 'vitest';
import {
  buildCacheKey, cacheEligibility, cacheLookup, cacheStore, clampTtl, stableStringify,
  MAX_CACHED_CHARS, MAX_TTL_SECONDS, MIN_TTL_SECONDS,
  type CacheKeyInput, type CachedResponse, type ResponseCacheStore,
} from './responseCache.ts';
import { createSupabaseResponseCacheStore } from './responseCacheStore.ts';

const base: CacheKeyInput = {
  accountId: 'acct-1', task: 'bank_categorization', system: 'sys',
  messages: [{ role: 'user', content: 'hello' }], maxTokens: 500, temperature: 0, jsonMode: true,
  route: [{ provider: 'gemini', model: 'gemini-2.5-flash' }],
};

function memStore(): ResponseCacheStore & { rows: Map<string, CachedResponse> } {
  const rows = new Map<string, CachedResponse>();
  return {
    rows,
    async get(a, k) { return rows.get(`${a}|${k}`) ?? null; },
    async put(a, k, _t, v) { rows.set(`${a}|${k}`, v); },
  };
}

describe('stableStringify', () => {
  it('is independent of key order', () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: [1, { y: 1, x: 2 }] } })).toBe(stableStringify({ b: { d: [1, { x: 2, y: 1 }], c: 2 }, a: 1 }));
  });
  it('drops undefined like JSON does', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});

describe('buildCacheKey', () => {
  it('is deterministic 64-hex', async () => {
    const k = await buildCacheKey(base);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(await buildCacheKey({ ...base })).toBe(k);
  });
  it.each([
    ['account', { accountId: 'acct-2' }],
    ['task', { task: 'job_autopsy' as const }],
    ['system', { system: 'sys2' }],
    ['messages', { messages: [{ role: 'user' as const, content: 'hello!' }] }],
    ['maxTokens', { maxTokens: 501 }],
    ['jsonMode', { jsonMode: false }],
    ['route', { route: [{ provider: 'groq' as const, model: 'llama-3.3-70b-versatile' }] }],
  ])('changes when %s changes (no stale or cross-tenant hit)', async (_n, patch) => {
    expect(await buildCacheKey({ ...base, ...patch })).not.toBe(await buildCacheKey(base));
  });
});

describe('cacheEligibility', () => {
  const ok = { flagOn: true, cache: { ttlSeconds: 600 }, accountId: 'a', temperature: 0, hasSecurityContext: false, streaming: false };
  it('accepts a fully qualified request', () => {
    expect(cacheEligibility(ok)).toEqual({ ok: true, ttlSeconds: 600 });
  });
  it.each([
    ['flag_off', { flagOn: false }],
    ['not_opted_in', { cache: undefined }],
    ['streaming', { streaming: true }],
    ['no_account_scope', { accountId: undefined }],
    ['security_vault', { hasSecurityContext: true }],
    ['not_deterministic', { temperature: 0.7 }],
    ['not_deterministic', { temperature: undefined }],
  ])('rejects: %s', (reason, patch) => {
    expect(cacheEligibility({ ...ok, ...patch })).toEqual({ ok: false, reason });
  });
});

describe('clampTtl', () => {
  it('bounds and sanitises', () => {
    expect(clampTtl(1)).toBe(MIN_TTL_SECONDS);
    expect(clampTtl(1e12)).toBe(MAX_TTL_SECONDS);
    expect(clampTtl(NaN)).toBe(MIN_TTL_SECONDS);
    expect(clampTtl(90.9)).toBe(90);
  });
});

describe('cache lookup / store', () => {
  const v: CachedResponse = { text: 'answer', provider: 'gemini', model: 'm', inputTokens: 10, outputTokens: 5 };
  it('round-trips within one tenant and never crosses tenants', async () => {
    const s = memStore();
    await cacheStore(s, 'A', 'k', 't', v, 600);
    expect(await cacheLookup(s, 'A', 'k')).toEqual(v);
    expect(await cacheLookup(s, 'B', 'k')).toBeNull();
  });
  it('does not store empty or oversize responses', async () => {
    const s = memStore();
    await cacheStore(s, 'A', 'k1', 't', { ...v, text: '' }, 600);
    await cacheStore(s, 'A', 'k2', 't', { ...v, text: 'x'.repeat(MAX_CACHED_CHARS + 1) }, 600);
    expect(s.rows.size).toBe(0);
  });
  it('swallows store failures (best-effort)', async () => {
    const broken: ResponseCacheStore = { async get() { throw new Error('db down'); }, async put() { throw new Error('db down'); } };
    expect(await cacheLookup(broken, 'A', 'k')).toBeNull();
    await expect(cacheStore(broken, 'A', 'k', 't', v, 600)).resolves.toBeUndefined();
  });
});

describe('createSupabaseResponseCacheStore', () => {
  it('maps the RPC row and upserts with a ttl-derived expiry', async () => {
    let upserted: Record<string, unknown> | undefined;
    const store = createSupabaseResponseCacheStore({
      rpc: async () => ({ data: [{ response_text: 'hi', provider: 'gemini', model: 'm', input_tokens: 3, output_tokens: 2 }], error: null }),
      from: () => ({ upsert: async (row: Record<string, unknown>) => { upserted = row; return { error: null }; } }),
    }, () => 1_000_000);
    expect(await store.get('A', 'k')).toEqual({ text: 'hi', provider: 'gemini', model: 'm', inputTokens: 3, outputTokens: 2 });
    await store.put('A', 'k', 'task', { text: 'hi', provider: 'gemini', model: 'm', inputTokens: 3, outputTokens: 2 }, 60);
    expect(upserted?.expires_at).toBe(new Date(1_000_000 + 60_000).toISOString());
    expect(upserted?.account_id).toBe('A');
  });
  it('returns null on an empty RPC result and throws on an RPC error', async () => {
    const empty = createSupabaseResponseCacheStore({ rpc: async () => ({ data: [], error: null }), from: () => ({ upsert: async () => ({ error: null }) }) });
    expect(await empty.get('A', 'k')).toBeNull();
    const bad = createSupabaseResponseCacheStore({ rpc: async () => ({ data: null, error: { message: 'x' } }), from: () => ({ upsert: async () => ({ error: null }) }) });
    await expect(bad.get('A', 'k')).rejects.toThrow('x');
  });
});
