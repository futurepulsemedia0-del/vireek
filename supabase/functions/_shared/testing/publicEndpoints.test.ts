// Rate-limit + validation + auth tests for the public / cron Edge Functions hardened in this change.
// Every rejection case also asserts the handler touched NOTHING but the limiter (no data access before the gate).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadHandler, post, get, jsonOf } from './edgeHarness';

const ENV = { SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'srk-test-key-123', SUPABASE_ANON_KEY: 'anon-key', CRON_SECRET: 'cron-secret-xyz', SITE_URL: 'https://app.test' };
const CONN = { id: 'conn-1', user_id: 'u1', connector_key: 'k', status: 'active', entities: [], field_mapping: {} };

interface Fake { limiter: Array<{ allowed: boolean; retry?: number }>; buckets: string[]; other: string[] }
let fake: Fake;

function installClient() {
  (globalThis as any).__testCreateClient = () => {
    const chain = (table: string): any => new Proxy(function () {}, {
      get: (_t, prop) => {
        if (prop === 'then') return (res: (v: unknown) => void) => res({ data: [], error: null });
        if (prop === 'maybeSingle' || prop === 'single') return async () => ({ data: table === 'fabric_connections' ? CONN : null, error: null });
        return () => chain(table);
      },
      apply: () => chain(table),
    });
    return {
      rpc: async (fn: string, args: any) => {
        if (fn === 'edge_rate_limit_hit') {
          fake.buckets.push(String(args.p_bucket));
          const next = fake.limiter.shift() ?? { allowed: true };
          return { data: { allowed: next.allowed, remaining: 0, retry_after: next.retry ?? 30 }, error: null };
        }
        fake.other.push(`rpc:${fn}`);
        return { data: null, error: { message: 'no data in test' } };
      },
      from: (t: string) => { fake.other.push(`from:${t}`); return chain(t); },
    };
  };
}
const load = (path: string, env: Record<string, string | undefined> = ENV) => loadHandler(() => import(/* @vite-ignore */ path), env);
const denyAll = () => { fake.limiter = [{ allowed: false, retry: 42 }]; };

beforeEach(() => { fake = { limiter: [], buckets: [], other: [] }; installClient(); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

const expect429 = async (res: Response) => { expect(res.status).toBe(429); expect(res.headers.get('Retry-After')).toBe('42'); };

describe('status-feed', () => {
  it('429 when the limit is exceeded, before any data access', async () => {
    const h = await load('../../status-feed/index.ts'); denyAll();
    await expect429(await h(get()));
    expect(fake.buckets[0]).toMatch(/^status-feed:/);
    expect(fake.other).toEqual([]);
  });
  it('400 on repeated or invalid format', async () => {
    const h = await load('../../status-feed/index.ts');
    expect((await h(new Request('http://x.test/?format=atom&format=json'))).status).toBe(400);
    expect((await h(new Request('http://x.test/?format=<script>'))).status).toBe(400);
    expect(fake.other).toEqual([]);
  });
});

describe('careers-sitemap', () => {
  it('429 + 400 before any data access', async () => {
    const h = await load('../../careers-sitemap/index.ts'); denyAll();
    await expect429(await h(get()));
    expect((await h(new Request('http://x.test/?a=1&a=2'))).status).toBe(400);
    expect(fake.other).toEqual([]);
  });
});

describe('job-feeds', () => {
  it('429 + 400 before any data access', async () => {
    const h = await load('../../job-feeds/index.ts'); denyAll();
    await expect429(await h(new Request('http://x.test/?board=indeed')));
    expect((await h(new Request('http://x.test/?board=indeed&board=indeed'))).status).toBe(400);
    expect(fake.other).toEqual([]);
  });
});

describe('google-booking-feed', () => {
  it('public GET: 429 when exceeded, 400 on repeated slug', async () => {
    const h = await load('../../google-booking-feed/index.ts'); denyAll();
    await expect429(await h(new Request('http://x.test/?slug=acme-hvac')));
    expect((await h(new Request('http://x.test/?slug=acme-hvac&slug=other'))).status).toBe(400);
    expect(fake.buckets[0]).toMatch(/^google-booking-feed:/);
    expect(fake.other).toEqual([]);
  });
  it('owner preview POST uses its own, tighter bucket', async () => {
    const h = await load('../../google-booking-feed/index.ts'); denyAll();
    await expect429(await h(post({}, { Authorization: 'Bearer x' })));
    expect(fake.buckets[0]).toMatch(/^google-booking-feed-preview:/);
    expect(fake.other).toEqual([]);
  });
});

describe('video-ice', () => {
  const TOKEN = 'a'.repeat(64);
  it('429 when the IP limit is exceeded', async () => {
    const h = await load('../../video-ice/index.ts'); denyAll();
    await expect429(await h(post({ token: TOKEN })));
    expect(fake.other).toEqual([]);
  });
  it('429 when one session token is hammered (second bucket)', async () => {
    const h = await load('../../video-ice/index.ts'); fake.limiter = [{ allowed: true }, { allowed: false, retry: 42 }];
    await expect429(await h(post({ token: TOKEN })));
    expect(fake.buckets[1]).toMatch(/^video-ice-token:/);
    expect(fake.other).toEqual([]);
  });
  it('400 malformed JSON / bad token / extra field / wrong type; 413 oversized', async () => {
    const h = await load('../../video-ice/index.ts');
    expect((await h(new Request('http://x.test/', { method: 'POST', body: '{nope' }))).status).toBe(400);
    expect((await h(post({ token: 'short' }))).status).toBe(400);
    expect((await h(post({ token: 123 }))).status).toBe(400);
    const extra = await h(post({ token: TOKEN, role: 'admin' }));
    expect(extra.status).toBe(400);
    expect(JSON.stringify(await jsonOf(extra))).not.toContain('"admin"');
    expect((await h(post({ token: TOKEN, pad: 'x'.repeat(5000) }))).status).toBe(413);
    expect(fake.other).toEqual([]);
  });
});

describe('punchout-return', () => {
  it('limit exceeded redirects the buyer back with error=rate_limited (no data access)', async () => {
    const h = await load('../../punchout-return/index.ts'); denyAll();
    const res = await h(new Request('http://x.test/', { method: 'POST', body: '<cXML/>' }));
    expect(String(res.headers.get('location'))).toContain('error=rate_limited');
    expect(fake.other).toEqual([]);
  });
  it('oversized form field is rejected as invalid, not parsed', async () => {
    const h = await load('../../punchout-return/index.ts');
    const body = new URLSearchParams({ 'cxml-urlencoded': 'x'.repeat(1_100_000) }).toString();
    const res = await h(new Request('http://x.test/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '10' }, body }));
    expect(String(res.headers.get('location'))).toMatch(/error=(too_large|failed|invalid_cart)/);
    expect(fake.other).toEqual([]);
  });
});

describe('fabric-ingest', () => {
  const auth = { Authorization: 'Bearer vfk_' + 'b'.repeat(40) };
  const rec = { entity: 'customer', external_id: '1', data: {} };
  it('429 pre-auth, legacy string error body kept', async () => {
    const h = await load('../../fabric-ingest/index.ts'); denyAll();
    const res = await h(post({ records: [rec] }, auth));
    await expect429(res);
    expect(typeof (await jsonOf(res)).error).toBe('string');
    expect(fake.other).toEqual([]);
  });
  it('429 per connection after auth (second bucket keyed by connection id)', async () => {
    const h = await load('../../fabric-ingest/index.ts'); fake.limiter = [{ allowed: true }, { allowed: false, retry: 42 }];
    await expect429(await h(post({ records: [rec] }, auth)));
    expect(fake.buckets[1]).toBe('fabric-ingest-conn:conn-1');
  });
  it('400/413: malformed, empty, too many records, wrong shape; 413 oversized', async () => {
    const h = await load('../../fabric-ingest/index.ts');
    expect((await h(new Request('http://x.test/', { method: 'POST', headers: auth, body: '{bad' }))).status).toBe(400);
    expect((await h(post([], auth))).status).toBe(400);
    expect((await h(post({ records: Array.from({ length: 201 }, () => rec) }, auth))).status).toBe(400);
    expect((await h(post({ records: 'nope' }, auth))).status).toBe(400);
    expect((await h(post('str', auth))).status).toBe(400);
    expect((await h(post({ records: [rec], pad: 'x'.repeat(1_100_000) }, auth))).status).toBe(413);
  });
  it('401 without a vfk_ key (before any DB access)', async () => {
    const h = await load('../../fabric-ingest/index.ts');
    expect((await h(post({ records: [rec] }))).status).toBe(401);
    expect(fake.other).toEqual([]);
  });
  it('unknown top-level keys are stripped, not fatal (third-party senders keep working)', async () => {
    const h = await load('../../fabric-ingest/index.ts');
    const res = await h(post({ records: [{}], source: 'legacy-sender' }, auth));
    expect(res.status).not.toBe(400);
  });
});

describe.each([
  ['business-immune-scan', (h: any, init: any) => h(new Request('http://x.test/', { method: 'POST', ...init }))],
  ['analyze-equipment-lifecycle', (h: any, init: any) => h(new Request('http://x.test/', { method: 'POST', ...init }))],
])('%s (cron, service role)', (name, call) => {
  const path = `../../${name}/index.ts`;
  it('429 when exceeded, before auth or data access', async () => {
    const h = await load(path); denyAll();
    await expect429(await call(h, { headers: { 'x-cron-secret': ENV.CRON_SECRET } }));
    expect(fake.buckets[0]).toMatch(new RegExp(`^${name}:`));
    expect(fake.other).toEqual([]);
  });
  it('401 with no / wrong secret — the public anon JWT alone is not enough', async () => {
    const h = await load(path);
    expect((await call(h, {})).status).toBe(401);
    expect((await call(h, { headers: { 'x-cron-secret': 'wrong' } })).status).toBe(401);
    expect((await call(h, { headers: { authorization: 'Bearer anon-key' } })).status).toBe(401);
    expect(fake.other).toEqual([]);
  });
  it('fails CLOSED (500) when no secret is configured at all', async () => {
    const h = await load(path, { SUPABASE_URL: ENV.SUPABASE_URL });
    expect((await call(h, { headers: { 'x-cron-secret': 'anything' } })).status).toBe(500);
    expect(fake.other).toEqual([]);
  });
  it('400 on an unexpected body field even with valid auth', async () => {
    const h = await load(path);
    const res = await call(h, { headers: { 'x-cron-secret': ENV.CRON_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: 'other-tenant' }) });
    expect(res.status).toBe(400);
    expect(fake.other).toEqual([]);
  });
  it('valid cron secret OR service-role bearer passes the gate', async () => {
    const h = await load(path);
    expect([401, 400, 429]).not.toContain((await call(h, { headers: { 'x-cron-secret': ENV.CRON_SECRET } })).status);
    expect([401, 400, 429]).not.toContain((await call(h, { headers: { authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}` } })).status);
  });
});

describe('email-campaign-dispatcher', () => {
  const path = '../../email-campaign-dispatcher/index.ts';
  const call = (h: any, init: any) => h(new Request('http://x.test/', { method: 'POST', ...init }));
  it('429 when exceeded (legacy string error body), before data access', async () => {
    const h = await load(path); denyAll();
    const res = await call(h, { headers: { authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}` } });
    await expect429(res);
    expect(typeof (await jsonOf(res)).error).toBe('string');
    expect(fake.other).toEqual([]);
  });
  it('401 for a wrong or missing key; fail-closed when the service key is empty', async () => {
    const h = await load(path);
    expect((await call(h, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await call(h, {})).status).toBe(401);
    const h2 = await load(path, { ...ENV, SUPABASE_SERVICE_ROLE_KEY: '' });
    expect((await call(h2, { headers: { authorization: 'Bearer ' } })).status).toBe(401);
    expect(fake.other).toEqual([]);
  });
  it('400 on an unexpected body field with the right key', async () => {
    const h = await load(path);
    const res = await call(h, { headers: { authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }, body: '{"campaign_id":"x"}' });
    expect(res.status).toBe(400);
    expect(fake.other).toEqual([]);
  });
});
