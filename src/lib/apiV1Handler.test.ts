/**
 * Runs the REAL supabase/functions/api-v1/index.ts handler (Deno + supabase-js stubbed) to prove the
 * behaviour the docs promise: error format, headers, test-mode isolation, IP allowlist, usage recording.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CATALOG, sandboxRecords } from '../../supabase/functions/api-v1/contract';

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  keys: {} as Record<string, Row>,
  tables: {} as Record<string, Row[]>,
  touched: [] as string[],
  keyUpdates: [] as Row[],
  logs: [] as Row[],
  rateOk: true,
}));

const fakeClient = () => ({
  rpc: async () => ({ data: state.rateOk }),
  from(table: string) {
    state.touched.push(table);
    let rows: Row[] = state.tables[table] ?? [];
    const b: Record<string, unknown> = {
      select: () => b,
      order: () => b,
      limit: () => b,
      lt: () => b,
      eq(col: string, val: unknown) {
        if (table === 'api_keys' && col === 'key_hash')
          rows = state.keys[val as string] ? [state.keys[val as string]] : [];
        else rows = rows.filter((r) => r[col] === val);
        return b;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      update(v: Row) {
        if (table === 'api_keys') state.keyUpdates.push(v);
        return b;
      },
      insert: async (v: Row) => (state.logs.push(v), { error: null }),
      then: (res: (v: unknown) => unknown) => res({ data: rows, error: null }),
    };
    return b;
  },
});

const USER = '11111111-1111-4111-8111-111111111111';
const REAL_CALL = {
  id: '3f2b8c1e-7a4d-4e0b-9c5a-1d2e3f4a5b6c',
  user_id: USER,
  created_at: '2026-10-01T10:00:00.000Z',
  caller_name: 'REAL CUSTOMER',
};
let handler: (req: Request) => Promise<Response>;

async function hash(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
async function addKey(raw: string, extra: Row = {}) {
  state.keys[await hash(raw)] = {
    id: `key-${raw}`,
    user_id: USER,
    scopes: ['calls:read'],
    revoked_at: null,
    mode: raw.startsWith('vrk_test_') ? 'test' : 'live',
    ip_allowlist: [],
    ...extra,
  };
}
const call = (path: string, key?: string, headers: Record<string, string> = {}, method = 'GET') =>
  handler(
    new Request(`https://x.supabase.co/api-v1${path}`, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    }),
  );

beforeAll(async () => {
  vi.stubGlobal('__testCreateClient', fakeClient);
  vi.stubGlobal('Deno', {
    env: {
      get: (k: string) =>
        ({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srv' })[k],
    },
    serve: (h: typeof handler) => (handler = h),
  });
  await import('../../supabase/functions/api-v1/index.ts');
});

beforeEach(async () => {
  Object.assign(state, {
    keys: {},
    tables: { calls: [REAL_CALL] },
    touched: [],
    keyUpdates: [],
    logs: [],
    rateOk: true,
  });
  await addKey('vrk_live_good');
  await addKey('vrk_test_good');
});

describe('error format and headers', () => {
  it('every catalog code that the handler can produce comes back as { error, code, doc_url, request_id } with the catalogued status', async () => {
    await addKey('vrk_live_noscope', { scopes: ['leads:read'] });
    await addKey('vrk_live_revoked', { revoked_at: '2026-01-01T00:00:00Z' });
    const cases: [string, Response, string][] = [
      ['missing_api_key', await call('/calls'), 'missing_api_key'],
      ['invalid_api_key', await call('/calls', 'vrk_live_nope'), 'invalid_api_key'],
      ['revoked', await call('/calls', 'vrk_live_revoked'), 'invalid_api_key'],
      ['insufficient_scope', await call('/calls', 'vrk_live_noscope'), 'insufficient_scope'],
      ['invalid_id', await call('/calls/not-a-uuid', 'vrk_live_good'), 'invalid_id'],
      ['invalid_before', await call('/calls?before=yesterday', 'vrk_live_good'), 'invalid_before'],
      ['route_not_found', await call('/nope', 'vrk_live_good'), 'route_not_found'],
      [
        'record_not_found',
        await call('/calls/3f2b8c1e-0000-4e0b-9c5a-1d2e3f4a5b6c', 'vrk_live_good'),
        'record_not_found',
      ],
      [
        'method_not_allowed',
        await call('/calls', 'vrk_live_good', {}, 'POST'),
        'method_not_allowed',
      ],
    ];
    state.rateOk = false;
    cases.push(['rate_limited', await call('/calls', 'vrk_live_good'), 'rate_limited']);
    for (const [name, res, code] of cases) {
      const body = await res.json();
      const def = ERROR_CATALOG.find((e) => e.code === code)!;
      expect(res.status, name).toBe(def.status);
      expect(body, name).toEqual({
        error: expect.any(String),
        code,
        doc_url: expect.stringContaining(`#error-${code}`),
        request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
      expect(res.headers.get('X-Request-Id'), name).toBe(body.request_id);
    }
    const rl = cases.at(-1)![1];
    expect(rl.headers.get('Retry-After')).toBe('60');
    expect(cases[8][1].headers.get('Allow')).toBe('GET, OPTIONS');
  });

  it('success responses carry request id, rate-limit limit, mode and API version', async () => {
    const res = await call('/calls', 'vrk_live_good');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    expect(res.headers.get('X-RateLimit-Limit')).toBe('120');
    expect(res.headers.get('X-Vireek-Mode')).toBe('live');
    expect(res.headers.get('X-Vireek-Api-Version')).toBe('1.0.0');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('X-Request-Id');
    expect(res.headers.get('Deprecation')).toBeNull();
  });
});

describe('test-mode keys', () => {
  it('return synthetic data and NEVER touch the real tables', async () => {
    const res = await call('/calls?limit=3', 'vrk_test_good');
    const body = await res.json();
    expect(res.headers.get('X-Vireek-Mode')).toBe('test');
    expect(body.data).toHaveLength(3);
    expect(body.data[0].livemode).toBe(false);
    expect(JSON.stringify(body)).not.toContain('REAL CUSTOMER');
    expect(state.touched).not.toContain('calls');
  });

  it('support by-id, pagination, validation and scope checks', async () => {
    const id = sandboxRecords('calls')[2].id as string;
    expect((await (await call(`/calls/${id}`, 'vrk_test_good')).json()).data.id).toBe(id);
    expect(
      (await call('/calls/3f2b8c1e-0000-4e0b-9c5a-1d2e3f4a5b6c', 'vrk_test_good')).status,
    ).toBe(404);
    expect((await call('/calls/zzz', 'vrk_test_good')).status).toBe(400);
    expect((await call('/calls?before=bad', 'vrk_test_good')).status).toBe(400);
    expect((await call('/leads', 'vrk_test_good')).status).toBe(403);
    const page = await (await call('/calls?limit=5', 'vrk_test_good')).json();
    const next = await (
      await call(`/calls?limit=5&before=${encodeURIComponent(page.next_before)}`, 'vrk_test_good')
    ).json();
    expect(next.data[0].id).not.toBe(page.data[0].id);
    expect(page.data.at(-1).created_at > next.data[0].created_at).toBe(true);
  });

  it('live keys still read the real table', async () => {
    const body = await (await call('/calls', 'vrk_live_good')).json();
    expect(state.touched).toContain('calls');
    expect(body.data[0].caller_name).toBe('REAL CUSTOMER');
  });
});

describe('IP allowlist', () => {
  beforeEach(async () => addKey('vrk_live_ip', { ip_allowlist: ['203.0.113.0/24'] }));

  it('allows an address inside the range', async () => {
    expect(
      (await call('/calls', 'vrk_live_ip', { 'cf-connecting-ip': '203.0.113.50' })).status,
    ).toBe(200);
  });

  it('rejects other addresses with ip_not_allowed and names the address it saw', async () => {
    const res = await call('/calls', 'vrk_live_ip', { 'cf-connecting-ip': '198.51.100.9' });
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe('ip_not_allowed');
    expect(body.error).toContain('198.51.100.9');
    expect(state.touched).not.toContain('calls');
  });

  it('fails closed when the address is unknown, and ignores a forged X-Forwarded-For', async () => {
    expect((await call('/calls', 'vrk_live_ip')).status).toBe(403);
    expect(
      (await call('/calls', 'vrk_live_ip', { 'x-forwarded-for': '203.0.113.50' })).status,
    ).toBe(403);
  });

  it('applies to test keys too', async () => {
    await addKey('vrk_test_ip', { ip_allowlist: ['203.0.113.7'] });
    expect((await call('/calls', 'vrk_test_ip', { 'cf-connecting-ip': '8.8.8.8' })).status).toBe(
      403,
    );
    expect(
      (await call('/calls', 'vrk_test_ip', { 'cf-connecting-ip': '203.0.113.7' })).status,
    ).toBe(200);
  });

  it('records last_used_at and last_used_ip on success', async () => {
    await call('/calls', 'vrk_live_ip', { 'cf-connecting-ip': '203.0.113.50' });
    expect(state.keyUpdates.at(-1)).toMatchObject({
      last_used_ip: '203.0.113.50',
      last_used_at: expect.any(String),
    });
  });
});
