import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  NS_VERIFICATION,
  accountHost,
  apiBaseFor,
  buildNsInvoiceCreate,
  buildNsInvoicePatch,
  buildNsPaymentCreate,
  buildPatchRequest,
  buildSuiteQlRequest,
  buildUpsertRequest,
  canonToNs,
  changedIdsQuery,
  classifyResponse,
  customerAddressPayload,
  decryptSecret,
  defaultSettings,
  effectiveDirection,
  encryptSecret,
  environmentFor,
  externalIdFor,
  findQuery,
  idFromLocation,
  initialBase,
  invoiceAmountSig,
  isAllowedApiBase,
  mergeEntity,
  nsLiteral,
  nsToCanon,
  parseNsInvoice,
  parseNsPayment,
  paymentMethodFromName,
  pctEncode,
  resolveLineItems,
  signRequest,
  validateCredentials,
  validateSettings,
  type NsCredentials,
} from '../../supabase/functions/_shared/netsuite/engine';
import { NsAuthError, NsClient, NsRateLimitError } from '../../supabase/functions/_shared/netsuite/client';

const creds: NsCredentials = { accountId: '1234567_SB1', consumerKey: 'ck'.repeat(16), consumerSecret: 'cs'.repeat(16), tokenId: 'ti'.repeat(16), tokenSecret: 'ts'.repeat(16) };

// ---------------------------------------------------------------- fake NetSuite ----
function fakeNetSuite() {
  const records = new Map<string, Record<string, unknown>>(); // "type/id" -> record
  const byExt = new Map<string, string>(); // "type/ext" -> id
  let next = 1000;
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    calls.push({ method, url });
    expect(String((init.headers as Record<string, string>).Authorization)).toMatch(/^OAuth realm="1234567_SB1"/);
    const rec = /\/record\/v1\/([a-z]+)\/(eid:([\w-]+)|(\d+))$/.exec(u.pathname);
    if (method === 'PUT' && rec?.[3]) {
      const key = `${rec[1]}/${rec[3]}`;
      let id = byExt.get(key);
      if (!id) {
        id = String(next++);
        byExt.set(key, id);
      }
      records.set(`${rec[1]}/${id}`, { ...(records.get(`${rec[1]}/${id}`) ?? {}), ...JSON.parse(String(init.body)), id, externalId: rec[3] });
      return new Response(null, { status: 204, headers: { Location: `${u.origin}/services/rest/record/v1/${rec[1]}/${id}` } });
    }
    if (method === 'GET' && rec?.[4]) {
      const r = records.get(`${rec[1]}/${rec[4]}`);
      return r ? new Response(JSON.stringify(r), { status: 200 }) : new Response(JSON.stringify({ title: 'Not Found' }), { status: 404 });
    }
    if (method === 'PATCH' && rec?.[4]) {
      const k = `${rec[1]}/${rec[4]}`;
      if (!records.has(k)) return new Response('{}', { status: 404 });
      records.set(k, { ...records.get(k), ...JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && u.pathname.endsWith('/query/v1/suiteql')) {
      const q = String(JSON.parse(String(init.body)).q);
      const ext = /externalId = '([^']+)'/.exec(q)?.[1];
      const items = ext ? [...byExt].filter(([k]) => k.endsWith(`/${ext}`)).map(([, id]) => ({ id })) : [];
      return new Response(JSON.stringify({ items, hasMore: false }), { status: 200 });
    }
    return new Response('{}', { status: 400 });
  }) as unknown as typeof fetch;
  return { fetchImpl, records, calls };
}

describe('verification label', () => {
  it('says not live-verified', () => {
    expect(NS_VERIFICATION.liveVerified).toBe(false);
    expect(NS_VERIFICATION.label).toBe('Not live-verified');
  });
});

describe('account ids and hosts', () => {
  it('derives the REST host and environment', () => {
    expect(accountHost('1234567_SB1')).toBe('1234567-sb1.suitetalk.api.netsuite.com');
    expect(apiBaseFor('1234567')).toBe('https://1234567.suitetalk.api.netsuite.com');
    expect(environmentFor('1234567_sb1')).toBe('sandbox');
    expect(environmentFor('1234567_RP1')).toBe('release_preview');
    expect(environmentFor('1234567')).toBe('production');
  });
  it('only allows NetSuite hosts', () => {
    expect(isAllowedApiBase('https://1234567.suitetalk.api.netsuite.com')).toBe(true);
    expect(isAllowedApiBase('https://evil.example.com')).toBe(false);
    expect(isAllowedApiBase('http://1234567.suitetalk.api.netsuite.com')).toBe(false);
    expect(isAllowedApiBase('https://1234567.suitetalk.api.netsuite.com.evil.com')).toBe(false);
  });
});

describe('credentials', () => {
  const ok = { accountId: ' 1234567_sb1 ', consumerKey: 'a'.repeat(64), consumerSecret: 'b'.repeat(64), tokenId: 'c'.repeat(64), tokenSecret: 'd'.repeat(64) };
  it('accepts and normalises', () => {
    const r = validateCredentials(ok);
    expect(r.ok && r.credentials.accountId).toBe('1234567_SB1');
  });
  it('rejects junk with a field-specific message', () => {
    expect(validateCredentials({ ...ok, accountId: "x'; drop" })).toMatchObject({ ok: false });
    const r = validateCredentials({ ...ok, tokenId: 'short' });
    expect(!r.ok && r.error).toMatch(/Token ID/);
    expect(validateCredentials(null).ok).toBe(false);
  });
});

describe('request signing (OAuth 1.0 HMAC-SHA256)', () => {
  it('matches an independent HMAC computation, including query params', async () => {
    const url = 'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=10&offset=0';
    const header = await signRequest('POST', url, creds, { timestamp: 1700000000, nonce: 'abc123' });
    const params = [
      ['limit', '10'], ['offset', '0'], ['oauth_consumer_key', creds.consumerKey], ['oauth_nonce', 'abc123'], ['oauth_signature_method', 'HMAC-SHA256'],
      ['oauth_timestamp', '1700000000'], ['oauth_token', creds.tokenId], ['oauth_version', '1.0'],
    ].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${pctEncode(k)}=${pctEncode(v)}`).join('&');
    const base = `POST&${pctEncode('https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql')}&${pctEncode(params)}`;
    const expected = createHmac('sha256', `${pctEncode(creds.consumerSecret)}&${pctEncode(creds.tokenSecret)}`).update(base).digest('base64');
    expect(header).toContain(`oauth_signature="${pctEncode(expected)}"`);
    expect(header).toContain('realm="1234567_SB1"');
    expect(header).toContain('oauth_signature_method="HMAC-SHA256"');
    expect(header).not.toContain(creds.consumerSecret);
    expect(header).not.toContain(creds.tokenSecret);
  });
  it('uses a new nonce each call', async () => {
    const url = 'https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/customer/1';
    expect(await signRequest('GET', url, creds)).not.toBe(await signRequest('GET', url, creds));
  });
  it('percent-encodes RFC 3986', () => {
    expect(pctEncode("a b!'()*")).toBe('a%20b%21%27%28%29%2A');
  });
});

describe('settings', () => {
  it('defaults: NetSuite owns items, money documents are manual', () => {
    const s = defaultSettings();
    expect(s.entities.item.direction).toBe('from_ns');
    expect(s.entities.invoice.conflict).toBe('manual');
    expect(validateSettings(s).ok).toBe(true);
  });
  it('rejects bad input', () => {
    expect(validateSettings(null).ok).toBe(false);
    expect(validateSettings({ entities: { customer: { direction: 'sideways' } } }).ok).toBe(false);
    expect(validateSettings({ entities: { customer: { fields: { name: 'off' } } } }).ok).toBe(false);
    expect(validateSettings({ entities: { customer: { fields: { nope: 'both' } } } }).ok).toBe(false);
    expect(validateSettings({ defaults: { fallbackItemId: "1'; --" } }).ok).toBe(false);
    expect(validateSettings({ defaults: { sendTranId: 'yes' } }).ok).toBe(false);
  });
  it('accepts numeric ids and clears empty ones', () => {
    const r = validateSettings({ defaults: { fallbackItemId: '123', taxCodeId: '' } });
    expect(r.ok && r.settings.defaults.fallbackItemId).toBe('123');
    expect(r.ok && r.settings.defaults.taxCodeId).toBeNull();
  });
  it('resolves effective direction', () => {
    expect(effectiveDirection('both', 'from_ns')).toBe('from_ns');
    expect(effectiveDirection('to_ns', 'both')).toBe('to_ns');
    expect(effectiveDirection('to_ns', 'from_ns')).toBe('off');
    expect(effectiveDirection('both', 'off')).toBe('off');
  });
});

describe('requests', () => {
  const base = 'https://1234567.suitetalk.api.netsuite.com';
  it('escapes SuiteQL literals', () => {
    expect(nsLiteral("O'Brien")).toBe("'O''Brien'");
    expect(findQuery('customer', 'email', "a'b@x.com")).toContain("LOWER('a''b@x.com')");
    expect(() => findQuery('invoice', 'email', 'x')).toThrow();
  });
  it('builds changed-id queries with a date-only filter', () => {
    expect(changedIdsQuery('invoice', Date.parse('2026-10-27T12:00:00Z'))).toBe("SELECT id, lastModifiedDate FROM transaction WHERE type = 'CustInvc' AND lastModifiedDate >= TO_DATE('2026-10-27', 'YYYY-MM-DD') ORDER BY lastModifiedDate, id");
    expect(changedIdsQuery('customer', null)).toBe('SELECT id, lastModifiedDate FROM customer ORDER BY lastModifiedDate, id');
    expect(changedIdsQuery('item', null)).toContain("itemType = 'Service'");
  });
  it('builds SuiteQL / upsert / patch requests', () => {
    const q = buildSuiteQlRequest({ base, q: 'SELECT 1', limit: 5000, offset: -3 });
    expect(q.url).toBe(`${base}/services/rest/query/v1/suiteql?limit=1000&offset=0`);
    expect(q.headers).toEqual({ Prefer: 'transient' });
    const u = buildUpsertRequest({ base, entity: 'customer', externalId: 'vk-c-abc', payload: { a: 1 } });
    expect(u).toMatchObject({ method: 'PUT', url: `${base}/services/rest/record/v1/customer/eid:vk-c-abc` });
    expect(() => buildUpsertRequest({ base, entity: 'customer', externalId: '../x', payload: {} })).toThrow();
    expect(buildPatchRequest({ base, entity: 'invoice', id: '55', payload: {}, replace: 'item' }).url).toBe(`${base}/services/rest/record/v1/invoice/55?replace=item`);
    expect(() => buildPatchRequest({ base, entity: 'invoice', id: '5/../6', payload: {} })).toThrow();
    expect(() => buildPatchRequest({ base, entity: 'invoice', id: '5', payload: {}, replace: 'x;y' })).toThrow();
  });
  it('derives deterministic external ids', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(externalIdFor('c', id)).toBe('vk-c-123e4567e89b12d3a456426614174000');
    expect(externalIdFor('c', id)).toBe(externalIdFor('c', id));
    expect(() => externalIdFor('c', 'nope')).toThrow();
  });
  it('reads the id from Location', () => {
    expect(idFromLocation('https://x.suitetalk.api.netsuite.com/services/rest/record/v1/customer/4321')).toBe('4321');
    expect(idFromLocation(null)).toBeNull();
  });
  it('classifies faults', () => {
    expect(classifyResponse(204, null).kind).toBe('ok');
    expect(classifyResponse(401, { 'o:errorDetails': [{ 'o:errorCode': 'INVALID_LOGIN_ATTEMPT' }] }).kind).toBe('auth');
    expect(classifyResponse(403, null).kind).toBe('permission');
    expect(classifyResponse(429, { 'o:errorDetails': [{ 'o:errorCode': 'CONCURRENCY_LIMIT_EXCEEDED' }] }).kind).toBe('throttle');
    expect(classifyResponse(404, null).kind).toBe('notfound');
    const v = classifyResponse(400, { 'o:errorDetails': [{ detail: 'Bad field', 'o:errorCode': 'INVALID_FLD_VALUE' }] });
    expect(v.kind).toBe('validation');
    expect(v.fault?.message).toBe('Bad field');
  });
});

describe('record adapters', () => {
  it('maps customers both ways (company and person)', () => {
    expect(nsToCanon('customer', { companyName: 'Acme', email: 'A@x.com', phone: '555', comments: 'n' })).toEqual({ name: 'Acme', email: 'A@x.com', phone: '555', notes: 'n' });
    expect(nsToCanon('customer', { isPerson: 'T', firstName: 'Ann', lastName: 'Lee' }).name).toBe('Ann Lee');
    const d = defaultSettings().defaults;
    expect(canonToNs('customer', { name: 'Ann Lee', email: null }, { defaults: d, isPerson: true }, false)).toEqual({ firstName: 'Ann', lastName: 'Lee', email: null });
    const c = canonToNs('customer', { name: 'Acme' }, { defaults: { ...d, subsidiaryId: '3' }, isPerson: false }, true);
    expect(c).toMatchObject({ companyName: 'Acme', isPerson: false, subsidiary: { id: '3' } });
    expect(customerAddressPayload('1 Main St')).toMatchObject({ addressBook: { items: [{ defaultBilling: true }] } });
    expect(customerAddressPayload('  ')).toBeNull();
  });
  it('maps items', () => {
    expect(nsToCanon('item', { itemId: 'Drain', description: 'x', isInactive: true })).toEqual({ name: 'Drain', description: 'x', active: 'inactive' });
    expect(canonToNs('item', { name: 'Drain' }, { defaults: { ...defaultSettings().defaults, incomeAccountId: '9' } }, true)).toMatchObject({ itemId: 'Drain', incomeAccount: { id: '9' } });
  });

  const inv = (over: Record<string, unknown> = {}) => ({
    id: '77', tranId: 'INV-1', tranDate: '2026-10-01', dueDate: '2026-10-31', entity: { id: '5' }, currency: { refName: 'USD' },
    item: { items: [{ item: { id: '9', refName: 'Drain' }, description: 'Drain clean', quantity: 2, rate: 50, amount: 100 }] },
    taxTotal: 8, total: 108, amountRemaining: 108, lastModifiedDate: '2026-10-02T10:00:00Z', ...over,
  });
  it('parses an invoice into integer cents', () => {
    const p = parseNsInvoice(inv());
    expect(p.ok && p.doc).toMatchObject({ id: '77', tranId: 'INV-1', customerId: '5', subtotalCents: 10000, taxCents: 800, totalCents: 10800, balanceCents: 10800, voided: false });
  });
  it('refuses what it cannot represent', () => {
    expect(parseNsInvoice(inv({ currency: { refName: 'EUR' } }))).toMatchObject({ ok: false });
    expect(parseNsInvoice(inv({ total: 120 }))).toMatchObject({ ok: false });
    expect(parseNsInvoice(inv({ item: { items: [{ item: { id: '1' }, amount: -5 }] } }))).toMatchObject({ ok: false });
    expect(parseNsInvoice(inv({ item: undefined }))).toMatchObject({ ok: false });
    expect(parseNsInvoice({ ...inv(), id: 'abc' })).toMatchObject({ ok: false });
  });
  it('detects voided invoices', () => {
    const p = parseNsInvoice(inv({ voided: 'T' }));
    expect(p.ok && p.doc.voided).toBe(true);
  });
  it('signs amounts identically on both sides', () => {
    const p = parseNsInvoice(inv());
    if (!p.ok) throw new Error('parse');
    expect(invoiceAmountSig(p.doc)).toBe(invoiceAmountSig({ lines: [{ description: ' DRAIN  clean ', qty: 2, amountCents: 10000 }], taxCents: 800, totalCents: 10800 }));
  });
  it('builds invoice payloads', () => {
    const d = { ...defaultSettings().defaults, taxCodeId: '4', subsidiaryId: '2' };
    const lines = [{ description: 'Drain', qty: 2, unitPriceCents: 5000, amountCents: 10000, itemId: '9' }, { description: 'Odd', qty: 3, unitPriceCents: 33, amountCents: 100, itemId: '9' }];
    const create = buildNsInvoiceCreate({ invoiceNumber: 'INV-1', issueDate: '2026-10-01', dueDate: '2026-10-31', taxCents: 800, lines }, '5', d);
    expect(create).toMatchObject({ entity: { id: '5' }, tranId: 'INV-1', subsidiary: { id: '2' } });
    const items = (create.item as { items: Record<string, unknown>[] }).items;
    expect(items[0]).toMatchObject({ quantity: 2, rate: 50, amount: 100, taxCode: { id: '4' } });
    expect(items[1]).toMatchObject({ quantity: 1, rate: 1, amount: 1 }); // inexact qty*rate collapses to one line unit
    const patch = buildNsInvoicePatch({ invoiceNumber: 'INV-1', issueDate: '2026-10-01', dueDate: '2026-11-15', taxCents: 0, lines }, d, { amounts: false, due: true });
    expect(patch).toEqual({ body: { dueDate: '2026-11-15' }, replace: null });
  });
  it('resolves items with a fallback', () => {
    const lines = [{ description: 'Drain Clean', qty: 1, unitPriceCents: 1, amountCents: 1, itemId: null }];
    expect(resolveLineItems(lines, new Map([['drain clean', '9']]), null)).toMatchObject({ ok: true });
    expect(resolveLineItems(lines, new Map(), null)).toMatchObject({ ok: false });
    const r = resolveLineItems(lines, new Map(), '3');
    expect(r.ok && r.lines[0].itemId).toBe('3');
  });
  it('parses payments and builds the apply list', () => {
    const p = parseNsPayment({ id: '88', customer: { id: '5' }, tranDate: '2026-10-05', payment: 50, account: { id: '12' }, paymentMethod: { refName: 'Visa' }, apply: { items: [{ doc: { id: '77' }, apply: true, amount: 50 }, { doc: { id: '78' }, apply: false, amount: 9 }] } });
    expect(p).toMatchObject({ id: '88', totalCents: 5000, depositAccountId: '12', applications: [{ invoiceId: '77', amountCents: 5000 }] });
    expect(paymentMethodFromName('Visa')).toBe('card');
    expect(paymentMethodFromName('Check')).toBe('check');
    expect(paymentMethodFromName(null)).toBe('other');
    expect(buildNsPaymentCreate({ customerId: '5', invoiceId: '77', amountCents: 5000, date: '2026-10-05', accountId: null, subsidiaryId: null, note: 'n' })).toMatchObject({ payment: 50, apply: { items: [{ doc: { id: '77' }, apply: true, amount: 50 }] } });
  });
});

describe('merge', () => {
  const es = defaultSettings().entities.customer;
  it('does nothing when both sides agree with the base', () => {
    const c = { name: 'A', email: 'a@x.com', phone: '555', notes: null };
    const r = mergeEntity({ entity: 'customer', settings: es, base: initialBase('customer', es, c, c), vireek: c, ns: c, vireekTs: 1, nsTs: 1 });
    expect(r.toCrm).toEqual({});
    expect(r.toVireek).toEqual({});
    expect(r.conflicts).toEqual([]);
  });
  it('moves only the side that changed', () => {
    const base = { name: 'A', email: 'a@x.com', phone: '555', notes: null };
    const r = mergeEntity({ entity: 'customer', settings: es, base, vireek: { ...base, phone: '999' }, ns: { ...base, email: 'new@x.com' }, vireekTs: 2, nsTs: 2 });
    expect(r.toCrm).toEqual({ phone: '999' });
    expect(r.toVireek).toEqual({ email: 'new@x.com' });
  });
  it('flags a real conflict under the manual rule and honours overrides', () => {
    const base = { name: 'A', email: null, phone: '555', notes: null };
    const input = { entity: 'customer' as const, settings: { ...es, conflict: 'manual' as const }, base, vireek: { ...base, phone: '111' }, ns: { ...base, phone: '222' }, vireekTs: 1, nsTs: 2 };
    expect(mergeEntity(input).conflicts).toHaveLength(1);
    expect(mergeEntity({ ...input, ruleOverride: 'ns_wins' }).toVireek).toEqual({ phone: '222' });
    expect(mergeEntity({ ...input, ruleOverride: 'vireek_wins' }).toCrm).toEqual({ phone: '111' });
  });
  it('NetSuite-owned fields always come from NetSuite', () => {
    const items = defaultSettings().entities.item;
    const r = mergeEntity({ entity: 'item', settings: items, base: null, vireek: { name: 'X', description: 'mine', active: 'active' }, ns: { name: 'X', description: 'theirs', active: 'active' }, vireekTs: 9, nsTs: 1 });
    expect(r.toVireek).toEqual({ description: 'theirs' });
    expect(r.toCrm).toEqual({});
  });
});

describe('encryption', () => {
  it('round-trips and never contains the plaintext', async () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
    const blob = JSON.stringify({ tokenSecret: creds.tokenSecret });
    const enc = await encryptSecret(blob, key);
    expect(enc).not.toContain(creds.tokenSecret);
    expect(await decryptSecret(enc, key)).toBe(blob);
  });
});

describe('NsClient against a fake NetSuite', () => {
  const sleep = async () => undefined;

  it('refuses addresses outside NetSuite', async () => {
    const c = new NsClient({ credentials: creds, fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch, sleep });
    await expect(c.request({ method: 'GET', url: 'https://evil.example.com/x' })).rejects.toThrow(/outside NetSuite/);
  });

  it('upserts idempotently: the same externalId never creates a second record', async () => {
    const ns = fakeNetSuite();
    const c = new NsClient({ credentials: creds, fetchImpl: ns.fetchImpl, sleep });
    const ext = externalIdFor('c', '123e4567-e89b-12d3-a456-426614174000');
    const a = await c.upsert('customer', ext, { companyName: 'Acme' });
    const b = await c.upsert('customer', ext, { companyName: 'Acme' });
    expect(a.ok && b.ok).toBe(true);
    expect(a.ok && b.ok && a.id === b.id).toBe(true);
    expect([...ns.records.keys()].filter((k) => k.startsWith('customer/'))).toHaveLength(1);
    const found = await c.suiteql(findQuery('customer', 'externalId', ext), 5, 0);
    expect(found.rows).toEqual([{ id: a.ok ? a.id : '' }]);
  });

  it('patches and reads back', async () => {
    const ns = fakeNetSuite();
    const c = new NsClient({ credentials: creds, fetchImpl: ns.fetchImpl, sleep });
    const made = await c.upsert('customer', 'vk-c-1', { companyName: 'Acme' });
    if (!made.ok) throw new Error('upsert');
    const p = await c.patch('customer', made.id, { email: 'a@x.com' });
    expect(p.ok && p.record.email).toBe('a@x.com');
    expect(await c.getRecord('customer', '99999')).toBeNull();
  });

  it('retries 429 then succeeds, honouring the attempt budget', async () => {
    let n = 0;
    const f = (async () => (++n < 3 ? new Response('{}', { status: 429, headers: { 'Retry-After': '1' } }) : new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 }))) as unknown as typeof fetch;
    const c = new NsClient({ credentials: creds, fetchImpl: f, sleep });
    expect((await c.suiteql('SELECT 1', 1, 0)).rows).toEqual([]);
    expect(n).toBe(3);
    const always429 = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
    await expect(new NsClient({ credentials: creds, fetchImpl: always429, sleep, maxAttempts: 2 }).suiteql('SELECT 1', 1, 0)).rejects.toBeInstanceOf(NsRateLimitError);
  });

  it('retries 5xx and network errors', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) throw new TypeError('boom');
      if (n === 2) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ items: [{ id: '1' }], hasMore: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const page = await new NsClient({ credentials: creds, fetchImpl: f, sleep }).suiteql('SELECT 1', 1, 0);
    expect(page).toEqual({ rows: [{ id: '1' }], hasMore: true });
  });

  it('turns 401 into NsAuthError without leaking credentials', async () => {
    const f = (async () => new Response('{"title":"Unauthorized"}', { status: 401 })) as unknown as typeof fetch;
    const err = await new NsClient({ credentials: creds, fetchImpl: f, sleep }).suiteql('SELECT 1', 1, 0).catch((e) => e);
    expect(err).toBeInstanceOf(NsAuthError);
    expect(String(err.message)).not.toContain(creds.tokenSecret);
  });

  it('a failed list is an error, never an empty result', async () => {
    const f = (async () => new Response('{"title":"Bad"}', { status: 400 })) as unknown as typeof fetch;
    await expect(new NsClient({ credentials: creds, fetchImpl: f, sleep }).suiteql('SELECT 1', 1, 0)).rejects.toThrow();
  });

  it('reports validation faults from writes without throwing', async () => {
    const f = (async () => new Response(JSON.stringify({ 'o:errorDetails': [{ detail: 'Please enter value(s) for: Subsidiary', 'o:errorCode': 'USER_ERROR' }] }), { status: 400 })) as unknown as typeof fetch;
    const r = await new NsClient({ credentials: creds, fetchImpl: f, sleep }).upsert('customer', 'vk-c-1', {});
    expect(r).toMatchObject({ ok: false, kind: 'validation' });
    expect(!r.ok && r.message).toContain('Subsidiary');
  });
});
