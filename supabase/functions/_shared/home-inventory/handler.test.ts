// @vitest-environment node
// Handler-level tests for portal-home-inventory: supabase-js, env and the Gemini fetch are injected in-memory fakes,
// so this exercises the real request flow (token gate, tenant folder guard, real-type sniffing, SHA-256 de-duplication,
// rate limits, OCR + prefill, privacy-first deletes) without Deno, a network or a database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleHomeInventoryRequest, type HandlerDeps } from './handler.ts';

type Row = Record<string, any>;

const TOKEN = '3f2b8c1e-9a4d-4e7b-8c55-1a2b3c4d5e6f';
const OWNER = '11111111-1111-4111-8111-111111111111';
const CUST = '22222222-2222-4222-8222-222222222222';
const OTHER_CUST = '99999999-9999-4999-8999-999999999999';
const ITEM = '44444444-4444-4444-8444-444444444444';
const OTHER_ITEM = '55555555-5555-4555-8555-555555555555';

const h = {
  db: {} as Record<string, Row[]>,
  storage: new Map<string, Uint8Array>(),
  removed: [] as string[],
  ctxRows: [] as Row[],
  denied: new Set<string>(),
  removeFails: false,
  seq: 0,
  uuidSeq: 0,
};

function table(name: string) {
  const st = { op: 'select', filters: [] as [string, unknown][], payload: null as Row | null };
  const rows = () => (h.db[name] ??= []);
  const match = () => rows().filter((r) => st.filters.every(([k, v]) => r[k] === v));
  const run = (): { data: any; error: any; count?: number } => {
    if (st.op === 'insert') {
      const p = st.payload!;
      if (name === 'home_inventory_files' && rows().some((r) => r.customer_id === p.customer_id && r.sha256 === p.sha256)) {
        return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      const row = { id: `00000000-0000-4000-8000-${String(++h.seq).padStart(12, '0')}`, created_at: '2026-10-23T10:00:00Z', item_id: null, ...p };
      rows().push(row);
      return { data: [row], error: null };
    }
    if (st.op === 'delete') {
      const hit = match();
      h.db[name] = rows().filter((r) => !hit.includes(r));
      return { data: hit, error: null };
    }
    const hit = match();
    return { data: hit, error: null, count: hit.length };
  };
  const b: any = {
    select: () => b,
    eq: (k: string, v: unknown) => (st.filters.push([k, v]), b),
    insert: (p: Row) => ((st.op = 'insert'), (st.payload = p), b),
    delete: () => ((st.op = 'delete'), b),
    maybeSingle: () => Promise.resolve({ data: run().data?.[0] ?? null, error: null }),
    single: () => { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
    then: (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res),
  };
  return b;
}

const admin = {
  from: table,
  rpc: (fn: string, args: Row) => {
    if (fn === 'hi_resolve_customer') return Promise.resolve({ data: h.ctxRows, error: null });
    if (fn === 'hi_rate_limit_hit') return Promise.resolve({ data: !h.denied.has(args.p_bucket), error: null });
    return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
  },
  storage: {
    from: () => ({
      createSignedUploadUrl: (path: string) => Promise.resolve({ data: { token: `upl-${path}`, path }, error: null }),
      download: (path: string) => {
        const b = h.storage.get(path);
        return Promise.resolve(b ? { data: { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }, error: null } : { data: null, error: { message: 'not found' } });
      },
      remove: (paths: string[]) => {
        if (h.removeFails) return Promise.resolve({ data: null, error: { message: 'boom' } });
        paths.forEach((p) => { h.removed.push(p); h.storage.delete(p); });
        return Promise.resolve({ data: [], error: null });
      },
      createSignedUrl: (path: string, ttl: number) => Promise.resolve({ data: { signedUrl: `https://signed.example/${path}?ttl=${ttl}` }, error: null }),
    }),
  },
};

const env: Record<string, string | undefined> = { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'service', GEMINI_API_KEY: 'k' };
let currentFetch: any = vi.fn();
const deps: HandlerDeps = {
  createClient: () => admin,
  env: (k) => env[k],
  fetch: ((...a: any[]) => currentFetch(...a)) as typeof fetch,
  uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++h.uuidSeq).padStart(12, '0')}`,
};

const call = async (body: Row) => {
  const res = await handleHomeInventoryRequest(new Request('http://x/fn', { method: 'POST', body: JSON.stringify(body) }), deps);
  return { status: res.status, body: (await res.json()) as Row };
};

const JPEG = (tag = 0) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, tag, tag, 1, 2]);
const PDF = new Uint8Array([...'%PDF-1.7\n%âãÏÓ'].map((c) => c.charCodeAt(0) & 0xff));
const path = (n: number, ext = 'jpg', cust = CUST) => `${OWNER}/${cust}/aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}.${ext}`;
const put = (p: string, bytes: Uint8Array) => h.storage.set(p, bytes);

const RECEIPT = {
  doc_found: true, doc_type: 'receipt', product_name: 'Carrier 24ACC636', category: 'hvac', brand: 'Carrier', model: '24ACC636',
  serial: null, retailer: 'Home Depot', purchase_date: { year: 2024, month: 3, day: 14, raw_text: '03/14/2024' },
  total_amount: 4999.99, currency: 'USD', warranty_months: 120, confidence: 0.9, issues: [],
};
const geminiOk = (payload: Row) => vi.fn(async () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 120 },
}), { status: 200 }));

beforeEach(() => {
  h.db = { home_inventory_files: [], home_inventory_items: [{ id: ITEM, customer_id: CUST }, { id: OTHER_ITEM, customer_id: OTHER_CUST }] };
  h.storage = new Map();
  h.removed = [];
  h.ctxRows = [{ customer_id: CUST, owner_id: OWNER, customer_name: 'Ana', business_name: 'Cool Air' }];
  h.denied = new Set();
  h.removeFails = false;
  h.seq = 0;
  h.uuidSeq = 0;
  env.GEMINI_API_KEY = 'k';
  currentFetch = geminiOk(RECEIPT);
});

describe('gate', () => {
  it('answers CORS preflight and refuses other methods', async () => {
    expect((await handleHomeInventoryRequest(new Request('http://x', { method: 'OPTIONS' }), deps)).status).toBe(200);
    expect((await handleHomeInventoryRequest(new Request('http://x', { method: 'GET' }), deps)).status).toBe(405);
  });
  it('rejects bad JSON, a missing/invalid token and an unknown token with the same "unavailable" answer', async () => {
    const bad = await handleHomeInventoryRequest(new Request('http://x', { method: 'POST', body: '{nope' }), deps);
    expect(bad.status).toBe(400);
    expect((await call({ action: 'sign_upload' })).body.code).toBe('unavailable');
    expect((await call({ action: 'sign_upload', token: 'not-a-uuid' })).status).toBe(404);
    h.ctxRows = []; // unknown token OR portal switched off: indistinguishable
    const r = await call({ action: 'sign_upload', token: TOKEN, kind: 'receipt', mime: 'image/jpeg', bytes: 10 });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('unavailable');
  });
  it('rejects unknown actions', async () => {
    expect((await call({ token: TOKEN, action: 'drop_database' })).status).toBe(400);
  });
});

describe('sign_upload', () => {
  const ok = { token: TOKEN, action: 'sign_upload', kind: 'receipt', mime: 'image/jpeg', bytes: 2_000_000 };
  it('issues a path inside the customer’s own private folder', async () => {
    const r = await call(ok);
    expect(r.status).toBe(200);
    expect(r.body.path).toBe(path(1));
    expect(r.body.upload_token).toBe(`upl-${path(1)}`);
  });
  it('validates kind, type and size', async () => {
    expect((await call({ ...ok, kind: 'selfie' })).status).toBe(400);
    expect((await call({ ...ok, mime: 'image/svg+xml' })).status).toBe(400);
    expect((await call({ ...ok, mime: 'text/html' })).status).toBe(400);
    expect((await call({ ...ok, bytes: 0 })).status).toBe(400);
    expect((await call({ ...ok, bytes: 10 * 1024 * 1024 + 1 })).status).toBe(400);
    expect((await call({ ...ok, bytes: 1.5 })).status).toBe(400);
  });
  it('is rate limited and capped per customer', async () => {
    h.denied.add('upload_hour');
    expect((await call(ok)).status).toBe(429);
    h.denied.clear();
    h.db.home_inventory_files = Array.from({ length: 400 }, (_, i) => ({ id: `f${i}`, customer_id: CUST }));
    const r = await call(ok);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('limit');
  });
});

describe('register', () => {
  const reg = (p: string, extra: Row = {}) => call({ token: TOKEN, action: 'register', kind: 'receipt', path: p, name: 'Receipt.jpg', ...extra });

  it('stores a receipt, reads it and returns a form prefill — without ever exposing the storage path', async () => {
    put(path(1), JPEG(1));
    const r = await reg(path(1));
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(false);
    expect(r.body.warning).toBeNull();
    expect(r.body.file).toMatchObject({ kind: 'receipt', mime_type: 'image/jpeg', ocr_status: 'done', original_name: 'Receipt.jpg' });
    expect(r.body.read.suggestion).toMatchObject({
      name: 'Carrier 24ACC636', category: 'hvac', brand: 'Carrier', purchase_date: '2024-03-14', purchase_price_cents: 499999,
      currency: 'USD', warranty_months: 120, warranty_expires_at: '2034-03-14',
    });
    expect(JSON.stringify(r.body)).not.toContain(OWNER);
    expect(JSON.stringify(r.body)).not.toContain('storage_path');
    const saved = h.db.home_inventory_files[0];
    expect(saved).toMatchObject({ customer_id: CUST, user_id: OWNER, storage_path: path(1), ocr_status: 'done', input_tokens: 800 });
    expect(saved.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(currentFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses paths outside the customer’s folder (other customer, other tenant, traversal, junk)', async () => {
    put(path(1, 'jpg', OTHER_CUST), JPEG(1));
    for (const p of [path(1, 'jpg', OTHER_CUST), `${CUST}/${OWNER}/x.jpg`, `${OWNER}/${CUST}/../${CUST}/x.jpg`, 'nope', '']) {
      expect((await reg(p)).status).toBe(400);
    }
    expect(h.db.home_inventory_files).toHaveLength(0);
    expect(currentFetch).not.toHaveBeenCalled();
  });

  it('404s when nothing was uploaded', async () => {
    expect((await reg(path(9))).status).toBe(404);
  });

  it('checks the REAL file type: a script renamed .jpg, or a PDF under a .jpg name, is rejected and its object deleted', async () => {
    put(path(1), new Uint8Array([...'<html><script>x</script></html>'].map((c) => c.charCodeAt(0))));
    expect((await reg(path(1))).status).toBe(415);
    expect(h.removed).toContain(path(1));
    put(path(2), PDF);
    expect((await reg(path(2))).status).toBe(415);
    expect(h.removed).toContain(path(2));
    expect(h.db.home_inventory_files).toHaveLength(0);
    expect(currentFetch).not.toHaveBeenCalled();
  });

  it('accepts a PDF warranty card', async () => {
    put(path(1, 'pdf'), PDF);
    const r = await reg(path(1, 'pdf'), { kind: 'warranty_card' });
    expect(r.status).toBe(200);
    expect(r.body.file.mime_type).toBe('application/pdf');
  });

  it('is idempotent for the same path and de-duplicates identical bytes at zero token cost', async () => {
    put(path(1), JPEG(7));
    const first = await reg(path(1));
    const again = await reg(path(1)); // browser retry
    expect(again.body.file.id).toBe(first.body.file.id);
    put(path(2), JPEG(7)); // same photo uploaded again under a new name
    const dup = await reg(path(2));
    expect(dup.body.duplicate).toBe(true);
    expect(dup.body.file.id).toBe(first.body.file.id);
    expect(dup.body.read.suggestion.name).toBe('Carrier 24ACC636'); // stored read is returned, no new AI call
    expect(h.removed).toContain(path(2));
    expect(h.db.home_inventory_files).toHaveLength(1);
    expect(currentFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the file when OCR fails or is unavailable — the customer can still type the details', async () => {
    currentFetch = vi.fn(async () => new Response('upstream down', { status: 500 }));
    put(path(1), JPEG(1));
    const failed = await reg(path(1));
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ warning: 'ocr_failed', read: null });
    expect(h.db.home_inventory_files[0].ocr_status).toBe('failed');

    delete env.GEMINI_API_KEY;
    put(path(2), JPEG(2));
    const off = await reg(path(2));
    expect(off.body.warning).toBe('ocr_unavailable');
    expect(off.body.file.ocr_status).toBe('skipped');
  });

  it('keeps the file but skips the AI call when the OCR budget is used up', async () => {
    h.denied.add('ocr_hour');
    put(path(1), JPEG(1));
    const r = await reg(path(1));
    expect(r.status).toBe(200);
    expect(r.body.warning).toBe('ocr_rate_limited');
    expect(currentFetch).not.toHaveBeenCalled();
  });

  it('does not read whole-appliance photos unless asked, and reads labels with the plate reader', async () => {
    put(path(1), JPEG(1));
    const photo = await reg(path(1), { kind: 'appliance_photo' });
    expect(photo.body.file.ocr_status).toBe('skipped');
    expect(currentFetch).not.toHaveBeenCalled();

    currentFetch = geminiOk({
      plate_found: true, kind: 'water_heater', make: 'RHEEM', model: 'XE40M06', serial: 'RHLN1234567', serial_legibility: 'clear',
      specs: '40 gal', manufacture: { year: 2020, month: 5, day: null, raw_text: '05/2020' }, confidence: 0.92, photo_issues: [],
    });
    put(path(2), JPEG(2));
    const label = await reg(path(2), { kind: 'label' });
    expect(label.body.read).toMatchObject({ source: 'label', manufacture_date: '2020-05-01' });
    expect(label.body.read.suggestion).toMatchObject({ category: 'water_heating', brand: 'Rheem', serial_number: 'RHLN1234567', purchase_date: null });
  });

  it('only attaches to an item that belongs to this customer', async () => {
    put(path(1), JPEG(1));
    expect((await reg(path(1), { itemId: OTHER_ITEM })).status).toBe(404);
    expect((await reg(path(1), { itemId: 'garbage' })).status).toBe(400);
    expect((await reg(path(1), { itemId: ITEM })).body.file.item_id).toBe(ITEM);
  });
});

describe('file_url / delete_file / delete_item', () => {
  const seed = (id: string, cust: string, p: string, item: string | null = null) =>
    h.db.home_inventory_files.push({ id, customer_id: cust, storage_path: p, item_id: item, mime_type: 'image/jpeg', original_name: 'a.jpg' });
  const F1 = '66666666-6666-4666-8666-666666666666';
  const F2 = '77777777-7777-4777-8777-777777777777';
  const F_OTHER = '88888888-8888-4888-8888-888888888888';

  it('signs a short-lived view URL for the customer’s own file only', async () => {
    seed(F1, CUST, path(1));
    seed(F_OTHER, OTHER_CUST, path(2, 'jpg', OTHER_CUST));
    const ok = await call({ token: TOKEN, action: 'file_url', fileId: F1 });
    expect(ok.body.url).toBe(`https://signed.example/${path(1)}?ttl=120`);
    expect((await call({ token: TOKEN, action: 'file_url', fileId: F_OTHER })).status).toBe(404);
    expect((await call({ token: TOKEN, action: 'file_url', fileId: 'x' })).status).toBe(400);
  });

  it('deletes the stored object first, then the row — and keeps the row when storage fails so it can be retried', async () => {
    seed(F1, CUST, path(1));
    h.removeFails = true;
    expect((await call({ token: TOKEN, action: 'delete_file', fileId: F1 })).status).toBe(502);
    expect(h.db.home_inventory_files).toHaveLength(1);
    h.removeFails = false;
    expect((await call({ token: TOKEN, action: 'delete_file', fileId: F1 })).status).toBe(200);
    expect(h.removed).toContain(path(1));
    expect(h.db.home_inventory_files).toHaveLength(0);
  });

  it('cannot delete another customer’s file or item', async () => {
    seed(F_OTHER, OTHER_CUST, path(2, 'jpg', OTHER_CUST));
    expect((await call({ token: TOKEN, action: 'delete_file', fileId: F_OTHER })).status).toBe(404);
    expect((await call({ token: TOKEN, action: 'delete_item', itemId: OTHER_ITEM })).status).toBe(404);
    expect(h.db.home_inventory_files).toHaveLength(1);
    expect(h.db.home_inventory_items).toHaveLength(2);
  });

  it('delete_item removes every file object of the item before the item itself', async () => {
    seed(F1, CUST, path(1), ITEM);
    seed(F2, CUST, path(2), ITEM);
    h.removeFails = true;
    expect((await call({ token: TOKEN, action: 'delete_item', itemId: ITEM })).status).toBe(502);
    expect(h.db.home_inventory_items.some((i) => i.id === ITEM)).toBe(true);
    h.removeFails = false;
    const r = await call({ token: TOKEN, action: 'delete_item', itemId: ITEM });
    expect(r.body).toMatchObject({ ok: true, deleted_files: 2 });
    expect(h.removed).toEqual([path(1), path(2)]);
    expect(h.db.home_inventory_items.some((i) => i.id === ITEM)).toBe(false);
  });
});
