// Handler-level tests for equipment-nameplate-scan: supabase-js, env and the Gemini fetch are injected
// in-memory fakes, so this exercises the real request flow (auth, scope, dedupe, rate limit,
// normalisation, auto-create gate, review -> create) without Deno, a network or a database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleNameplateRequest, type HandlerDeps } from './nameplate-handler.ts';

type Row = Record<string, any>;
const h = { db: {} as Record<string, Row[]>, rpcCalls: [] as Row[], user: { id: 'user-1' } as Row | null };

function admin() {
  const table = (name: string) => {
    const st = { op: 'select', filters: [] as [string, unknown][], payload: null as Row | null, conflict: [] as string[] };
    const rows = () => (h.db[name] ??= []);
    const match = () => rows().filter((r) => st.filters.every(([k, v]) => r[k] === v));
    const run = () => {
      if (st.op === 'update') { const hit = match(); hit.forEach((r) => Object.assign(r, st.payload)); return hit; }
      if (st.op === 'upsert') {
        const keys = st.conflict.length ? st.conflict : ['user_id'];
        const hit = rows().find((r) => keys.every((k) => r[k] === st.payload![k]));
        if (hit) { Object.assign(hit, st.payload); return [hit]; }
        const row = { id: `00000000-0000-4000-8000-${String(rows().length + 1).padStart(12, '0')}`, ...st.payload };
        rows().push(row);
        return [row];
      }
      return match();
    };
    const b: any = {
      select: () => b,
      eq: (k: string, v: unknown) => (st.filters.push([k, v]), b),
      update: (p: Row) => ((st.op = 'update'), (st.payload = p), b),
      upsert: (p: Row, o?: { onConflict?: string }) => ((st.op = 'upsert'), (st.payload = p), (st.conflict = o?.onConflict?.split(',') ?? []), b),
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(res),
    };
    return b;
  };
  return {
    from: table,
    rpc: (fn: string, args: Row) => {
      h.rpcCalls.push({ fn, args });
      const scan = (h.db.equipment_nameplate_scans ?? []).find((s) => s.id === args.p_scan);
      if (!scan) return Promise.resolve({ data: null, error: { message: 'NAMEPLATE_SCAN_NOT_FOUND' } });
      Object.assign(scan, { status: 'created', equipment_id: 'eq-1' });
      h.db.equipment_passport_links = [{ equipment_id: 'eq-1', status: 'active', verified: true, verified_via: 'issuer', passport: { public_code: 'ABCDEFGHJKMN' } }];
      h.db.equipment = [{ id: 'eq-1', warranty_expires_at: args.p_fields.warranty_expires_at, warranty_notes: args.p_fields.warranty_notes }];
      return Promise.resolve({ data: { equipment_id: 'eq-1', reused: false, passport: { code: 'ABCDEFGHJKMN', verified: true, joined_existing: false } }, error: null });
    },
  };
}

function caller() {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: h.user } }) },
    rpc: () => Promise.resolve({ data: 'owner-1' }),
    storage: { from: () => ({ download: () => Promise.resolve({ data: { size: 3, type: 'image/jpeg', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, error: null }) }) },
  };
}

const env: Record<string, string> = { SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', GEMINI_API_KEY: 'k' };
let currentFetch: typeof fetch = vi.fn() as unknown as typeof fetch;
const setFetch = (f: unknown) => { currentFetch = f as typeof fetch; };
const deps: HandlerDeps = {
  createClient: (_url, key) => (key === 'service' ? admin() : caller()),
  env: (k) => env[k],
  fetch: ((...a: Parameters<typeof fetch>) => currentFetch(...a)) as typeof fetch,
};
const handler = (req: Request) => handleNameplateRequest(req, deps);

const SHA = 'a'.repeat(64);
const capture = (sha = SHA) => ({ path: `owner-1/aa/${sha}.jpg`, sha256: sha, mime: 'image/jpeg', bytes: 1000 });
const post = (body: Row, auth = true) =>
  handler(new Request('http://x', { method: 'POST', headers: auth ? { Authorization: 'Bearer t' } : {}, body: JSON.stringify(body) }));
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Row });

const plate = (over: Row = {}) => ({
  plate_found: true, kind: 'water_heater', make: 'RHEEM', model: 'PROG50', serial: 'RH1219456789', serial_legibility: 'clear',
  specs: '50 gal', confidence: 0.93, photo_issues: [], manufacture: { year: 2023, month: 3, day: null, raw_text: '03/2023' }, ...over,
});
const geminiReturns = (obj: Row) => vi.fn(async () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 120 },
}), { status: 200 }));

beforeEach(() => {
  h.db = { customers: [{ id: '11111111-1111-1111-1111-111111111111', user_id: 'owner-1' }], jobs: [], property_vision_rate_limit: [] };
  h.rpcCalls = [];
  h.user = { id: 'user-1' };
  setFetch(vi.fn());
});

const CUSTOMER = '11111111-1111-1111-1111-111111111111';

describe('request validation', () => {
  it('requires auth', async () => {
    expect((await read(await post({}, false))).status).toBe(401);
    h.user = null;
    expect((await read(await post({ customerId: CUSTOMER, capture: capture() }))).status).toBe(401);
  });

  it('requires a customer or job, and a photo inside the caller\'s own folder', async () => {
    expect((await read(await post({ capture: capture() }))).status).toBe(400);
    const stranger = { ...capture(), path: `someone-else/aa/${SHA}.jpg` };
    expect((await read(await post({ customerId: CUSTOMER, capture: stranger }))).body.error).toMatch(/path/i);
    expect((await read(await post({ customerId: CUSTOMER, capture: { ...capture(), mime: 'application/pdf' } }))).status).toBe(400);
  });

  it('404s on a customer from another account', async () => {
    h.db.customers = [{ id: CUSTOMER, user_id: 'other-owner' }];
    expect((await read(await post({ customerId: CUSTOMER, capture: capture() }))).status).toBe(404);
  });
});

describe('extract + auto-create', () => {
  it('reads a clear plate, creates the equipment and returns the passport + estimated warranty', async () => {
    const fetchMock = geminiReturns(plate());
    setFetch(fetchMock);
    const { status, body } = await read(await post({ customerId: CUSTOMER, capture: capture(), autoCreate: true }));
    expect(status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.scan.fields).toMatchObject({ make: 'Rheem', model: 'PROG50', serial: 'RH1219456789' });
    expect(body.scan.auto_create_ready).toBe(true);
    expect(body.created).toMatchObject({ equipment_id: 'eq-1', passport: { code: 'ABCDEFGHJKMN', verified: true } });
    expect(body.created.warranty).toMatchObject({ basis: 'estimated', term_years: 6, expires_at: '2029-03-01' });
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.rpcCalls[0].args.p_user).toBe('owner-1');
    expect(h.rpcCalls[0].args.p_fields).toMatchObject({ equipment_type: 'Water heater', make: 'Rheem', serial_number: 'RH1219456789', manufacture_date: '2023-03-01' });
    expect(h.db.equipment_nameplate_scans[0]).toMatchObject({ input_tokens: 700, output_tokens: 120, prompt_version: 'nameplate-v1' });
  });

  it('serves a repeated photo from the cache: no second AI call, no second equipment', async () => {
    const fetchMock = geminiReturns(plate());
    setFetch(fetchMock);
    await post({ customerId: CUSTOMER, capture: capture(), autoCreate: true });
    const again = await read(await post({ customerId: CUSTOMER, capture: capture(), autoCreate: true }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.rpcCalls).toHaveLength(1);
    expect(again.body.scan.cached).toBe(true);
    expect(again.body.created).toMatchObject({ equipment_id: 'eq-1', passport: { code: 'ABCDEFGHJKMN', verified: true } });
  });

  it('does NOT auto-create a doubtful read; the technician reviews and creates', async () => {
    setFetch(geminiReturns(plate({ serial_legibility: 'partial', confidence: 0.9 })));
    const first = await read(await post({ customerId: CUSTOMER, capture: capture(), autoCreate: true }));
    expect(first.body.created).toBeNull();
    expect(first.body.scan).toMatchObject({ status: 'extracted', auto_create_ready: false });
    expect(first.body.scan.review_reasons).toContain('serial_partial');
    expect(h.rpcCalls).toHaveLength(0);

    const second = await read(await post({ action: 'create', scanId: first.body.scan.id, fields: { serial: 'rh-1219456789', installDate: '2023-04-10' } }));
    expect(second.status).toBe(200);
    expect(h.rpcCalls[0].args.p_fields).toMatchObject({ serial_number: 'RH-1219456789', install_date: '2023-04-10', warranty_expires_at: '2029-04-10' });
    expect(second.body.created.equipment_id).toBe('eq-1');
  });

  it('rejects invalid corrections before touching the database', async () => {
    setFetch(geminiReturns(plate({ confidence: 0.2 })));
    const first = await read(await post({ customerId: CUSTOMER, capture: capture() }));
    const bad = await read(await post({ action: 'create', scanId: first.body.scan.id, fields: { make: '' } }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/brand/i);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('404s when creating from a scan that is not yours', async () => {
    h.db.equipment_nameplate_scans = [{ id: '5c5c5c5c-0000-4000-8000-000000000001', user_id: 'other-owner', status: 'extracted', extracted: plate() }];
    expect((await read(await post({ action: 'create', scanId: '5c5c5c5c-0000-4000-8000-000000000001' }))).status).toBe(404);
  });
});

describe('guards', () => {
  it('enforces the hourly limit before spending tokens', async () => {
    h.db.property_vision_rate_limit = [{ user_id: 'user-1', window_start: new Date().toISOString(), request_count: 30 }];
    const fetchMock = geminiReturns(plate());
    setFetch(fetchMock);
    expect((await read(await post({ customerId: CUSTOMER, capture: capture() }))).status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records a failed scan when the vision service is down, and retries on the next attempt', async () => {
    setFetch(vi.fn(async () => new Response('boom', { status: 503 })));
    expect((await read(await post({ customerId: CUSTOMER, capture: capture() }))).status).toBe(502);
    expect(h.db.equipment_nameplate_scans[0]).toMatchObject({ status: 'failed' });

    setFetch(geminiReturns(plate()));
    const retry = await read(await post({ customerId: CUSTOMER, capture: capture(), autoCreate: true }));
    expect(retry.status).toBe(200);
    expect(retry.body.created.equipment_id).toBe('eq-1');
    expect(h.db.equipment_nameplate_scans).toHaveLength(1);
  });

  it('never trusts plate text: markup in the read is stripped', async () => {
    setFetch(geminiReturns(plate({ make: '<script>x</script>', confidence: 0.2 })));
    const { body } = await read(await post({ customerId: CUSTOMER, capture: capture() }));
    expect(JSON.stringify(body.scan.fields)).not.toMatch(/[<>]/);
  });
});
