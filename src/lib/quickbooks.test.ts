import { describe, it, expect } from 'vitest';
import {
  QBO_ENTITIES,
  buildAuthorizeUrl,
  buildFindRequest,
  buildGetRequest,
  buildQboInvoicePayload,
  buildQboPaymentPayload,
  buildQueryRequest,
  buildTokenRequest,
  buildVoidRequest,
  buildWriteRequest,
  canonToQbo,
  classifyResponse,
  composeAddress,
  decryptSecret,
  defaultSettings,
  effectiveDirection,
  encryptSecret,
  generatedAccountCode,
  invoiceAmountSig,
  isAllowedApiBase,
  isValidRealmId,
  mergeEntity,
  parseQboInvoice,
  parseQboPayment,
  parseQueryResponse,
  parseTokenResponse,
  paymentMethodFromName,
  qboLiteral,
  qboName,
  qboTimestamp,
  qboToCanon,
  resolveLineItems,
  signOAuthState,
  suggestQboAccountType,
  validateSettings,
  verifyOAuthState,
  verifyWebhookSignature,
  webhookRealms,
  type InvoiceLine,
  type QboSettings,
} from '../../supabase/functions/_shared/quickbooks/engine';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const BASE = 'https://sandbox-quickbooks.api.intuit.com';
const defaults = defaultSettings().defaults;

describe('settings', () => {
  it('defaults are valid and safe for money documents', () => {
    const s = defaultSettings();
    expect(validateSettings(s).ok).toBe(true);
    expect(s.entities.invoice.conflict).toBe('manual');
    expect(s.entities.payment.conflict).toBe('manual');
    expect(s.entities.account.direction).toBe('from_qbo');
    for (const e of QBO_ENTITIES) expect(s.entities[e].enabled).toBe(true);
  });

  it('rejects unknown entities fields, directions, rules and bad ids', () => {
    const bad = (m: (s: QboSettings) => void) => {
      const s = structuredClone(defaultSettings());
      m(s);
      return validateSettings(s);
    };
    expect(bad((s) => ((s.entities.customer.fields as Record<string, string>)['drop_table'] = 'both')).ok).toBe(false);
    expect(bad((s) => ((s.entities.customer as { direction: string }).direction = 'sideways')).ok).toBe(false);
    expect(bad((s) => ((s.entities.customer as { conflict: string }).conflict = 'coin_flip')).ok).toBe(false);
    expect(bad((s) => (s.defaults.incomeAccountId = "1'; drop")).ok).toBe(false);
    expect(bad((s) => (s.defaults.incomeAccountId = '81')).ok).toBe(true);
    expect(bad((s) => (s.entities.customer.fields.name = 'off')).ok).toBe(false);
  });

  it('fills missing entities from defaults', () => {
    const r = validateSettings({ entities: { customer: { enabled: false } } });
    expect(r.ok && r.settings.entities.customer.enabled).toBe(false);
    expect(r.ok && r.settings.entities.invoice.conflict).toBe('manual');
  });

  it('applies entity direction on top of field direction', () => {
    expect(effectiveDirection('both', 'to_qbo')).toBe('to_qbo');
    expect(effectiveDirection('to_qbo', 'both')).toBe('to_qbo');
    expect(effectiveDirection('to_qbo', 'from_qbo')).toBe('off');
    expect(effectiveDirection('from_qbo', 'off')).toBe('off');
  });
});

describe('three-way merge wrapper', () => {
  const es = defaultSettings().entities.customer;
  it('moves only what changed since the base', () => {
    const base = { name: 'Ann', email: 'a@x.com', phone: '5550001', address: null, notes: null };
    const r = mergeEntity({
      entity: 'customer', settings: es, base,
      vireek: { ...base, phone: '5550002' }, qbo: { ...base, email: 'new@x.com' },
      vireekTs: 1, qboTs: 2,
    });
    expect(r.toQbo ?? r.toCrm).toEqual({ phone: '5550002' });
    expect(r.toVireek).toEqual({ email: 'new@x.com' });
    expect(r.conflicts).toEqual([]);
  });

  it('ignores formatting-only differences (no write loops)', () => {
    const r = mergeEntity({
      entity: 'customer', settings: es, base: { name: 'Ann', phone: '+15551234567' },
      vireek: { name: 'Ann', phone: '+1 (555) 123-4567' }, qbo: { name: ' Ann ', phone: '+15551234567' },
      vireekTs: null, qboTs: null,
    });
    expect(r.toVireek).toEqual({});
    expect(r.toCrm).toEqual({});
  });

  it('manual rule reports a conflict and keeps the base; overrides resolve it', () => {
    const input = {
      entity: 'customer' as const, settings: { ...es, conflict: 'manual' as const },
      base: { name: 'Old' }, vireek: { name: 'Vireek' }, qbo: { name: 'Quick' }, vireekTs: 5, qboTs: 9,
    };
    const m = mergeEntity(input);
    expect(m.conflicts).toHaveLength(1);
    expect(mergeEntity({ ...input, ruleOverride: 'qbo_wins' }).toVireek).toEqual({ name: 'Quick' });
    expect(mergeEntity({ ...input, ruleOverride: 'vireek_wins' }).toCrm).toEqual({ name: 'Vireek' });
  });

  it('respects per-field direction "off" and one-way entities', () => {
    const off = structuredClone(es);
    off.fields.notes = 'off';
    const r = mergeEntity({ entity: 'customer', settings: off, base: { notes: 'a' }, vireek: { notes: 'b' }, qbo: { notes: 'c' }, vireekTs: 1, qboTs: 2 });
    expect(r.toVireek).toEqual({});
    expect(r.conflicts).toEqual([]);
    const oneWay = { ...es, direction: 'to_qbo' as const };
    const r2 = mergeEntity({ entity: 'customer', settings: oneWay, base: { name: 'a' }, vireek: { name: 'b' }, qbo: { name: 'c' }, vireekTs: 1, qboTs: 2 });
    expect(r2.toVireek).toEqual({});
    expect(r2.toCrm).toEqual({ name: 'b' });
  });
});

describe('record adapters', () => {
  it('reads a QuickBooks customer', () => {
    const c = qboToCanon('customer', {
      DisplayName: 'Acme HVAC', PrimaryEmailAddr: { Address: 'a@acme.com' }, PrimaryPhone: { FreeFormNumber: '(555) 111-2222' },
      BillAddr: { Line1: '1 Main St', City: 'Austin', CountrySubDivisionCode: 'TX', PostalCode: '78701' }, Notes: 'VIP',
    });
    expect(c).toEqual({ name: 'Acme HVAC', email: 'a@acme.com', phone: '(555) 111-2222', address: '1 Main St, Austin, TX 78701', notes: 'VIP' });
    expect(composeAddress(null)).toBeNull();
  });

  it('writes sparse customer updates and never blanks the address', () => {
    expect(canonToQbo('customer', { phone: '555' }, { defaults }, false)).toEqual({ PrimaryPhone: { FreeFormNumber: '555' } });
    expect(canonToQbo('customer', { email: null }, { defaults }, false)).toEqual({ PrimaryEmailAddr: { Address: '' } });
    expect(canonToQbo('customer', { address: null }, { defaults }, false)).toEqual({});
  });

  it('items: type, income account and name sanitising', () => {
    const p = canonToQbo('item', { name: 'AC: Tune-up', price: 129, active: 'active' }, { defaults: { ...defaults, incomeAccountId: '81' } }, true);
    expect(p).toMatchObject({ Name: 'AC- Tune-up', UnitPrice: 129, Active: true, Type: 'Service', IncomeAccountRef: { value: '81' } });
    expect(qboName('a:b'.padEnd(300, 'x')).length).toBe(100);
    expect(qboToCanon('item', { Name: 'X', UnitPrice: 10, Active: false })).toMatchObject({ price: 10, active: 'inactive' });
  });

  it('accounts: type suggestion and generated codes', () => {
    expect(suggestQboAccountType('asset', '1000')).toBe('Bank');
    expect(suggestQboAccountType('expense', '5100')).toBe('Cost of Goods Sold');
    expect(suggestQboAccountType('revenue', '4000')).toBe('Income');
    expect(generatedAccountCode('42')).toBe('QB42');
    expect(canonToQbo('account', { name: 'Fuel', code: '6100', active: 'active' }, { defaults, accountType: 'Expense' }, true)).toMatchObject({ AccountType: 'Expense', AcctNum: '6100' });
  });
});

const qboInvoice = (over: Record<string, unknown> = {}) => ({
  Id: '130', SyncToken: '2', DocNumber: 'INV-1', TxnDate: '2026-10-01', DueDate: '2026-10-31',
  CustomerRef: { value: '58' }, TotalAmt: 270, Balance: 270,
  TxnTaxDetail: { TotalTax: 20 },
  Line: [
    { DetailType: 'SalesItemLineDetail', Amount: 250, Description: 'AC tune-up', SalesItemLineDetail: { ItemRef: { value: '7', name: 'Tune-up' }, Qty: 2, UnitPrice: 125 } },
    { DetailType: 'SubTotalLineDetail', Amount: 250 },
  ],
  MetaData: { LastUpdatedTime: '2026-10-02T10:00:00-07:00' },
  ...over,
});

describe('invoices', () => {
  it('parses a standard invoice into integer cents', () => {
    const r = parseQboInvoice(qboInvoice());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc).toMatchObject({ id: '130', customerId: '58', subtotalCents: 25000, taxCents: 2000, totalCents: 27000, dueDate: '2026-10-31', voided: false });
    expect(r.doc.lines[0]).toEqual({ description: 'AC tune-up', qty: 2, unitPriceCents: 12500, amountCents: 25000, itemId: '7' });
  });

  it('refuses what it cannot represent, with a reason', () => {
    const disc = parseQboInvoice(qboInvoice({ Line: [{ DetailType: 'DiscountLineDetail', Amount: 5 }] }));
    expect(disc.ok).toBe(false);
    expect(parseQboInvoice(qboInvoice({ TotalAmt: 999 }))).toMatchObject({ ok: false });
    expect(parseQboInvoice(qboInvoice({ CurrencyRef: { value: 'EUR' } }))).toMatchObject({ ok: false });
  });

  it('detects voided invoices', () => {
    const r = parseQboInvoice(qboInvoice({ PrivateNote: 'Voided', TotalAmt: 0, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 0, SalesItemLineDetail: {} }] }));
    expect(r.ok && r.doc.voided).toBe(true);
  });

  it('the money signature ignores case and spacing but catches real changes', () => {
    const a = { lines: [{ description: 'AC  Tune-up', qty: 2, amountCents: 25000 }], taxCents: 2000, totalCents: 27000 };
    const b = { lines: [{ description: 'ac tune-up', qty: 2, amountCents: 25000 }], taxCents: 2000, totalCents: 27000 };
    expect(invoiceAmountSig(a)).toBe(invoiceAmountSig(b));
    expect(invoiceAmountSig({ ...a, taxCents: 0, totalCents: 25000 })).not.toBe(invoiceAmountSig(a));
  });

  it('resolves lines to items by name, else the fallback, else explains', () => {
    const lines: InvoiceLine[] = [{ description: 'Tune-up', qty: 1, unitPriceCents: 100, amountCents: 100, itemId: null }];
    const hit = resolveLineItems(lines, new Map([['tune-up', '7']]), null);
    expect(hit.ok && hit.lines[0].itemId).toBe('7');
    expect(resolveLineItems(lines, new Map(), '99')).toMatchObject({ ok: true });
    const miss = resolveLineItems(lines, new Map(), null);
    expect(!miss.ok && miss.reason).toMatch(/fallback item/);
  });

  it('builds a create payload and a sparse update payload', () => {
    const inv = { invoiceNumber: 'INV-202610-0001', issueDate: '2026-10-01', dueDate: '2026-10-31', taxCents: 2000, lines: [{ description: 'Tune-up', qty: 2, unitPriceCents: 12500, amountCents: 25000, itemId: '7' }] };
    const create = buildQboInvoicePayload(inv, '58', { defaults: { ...defaults, taxCodeId: 'TAX' } });
    expect(create).toMatchObject({ CustomerRef: { value: '58' }, DocNumber: 'INV-202610-0001', TxnTaxDetail: { TotalTax: 20 } });
    expect((create.Line as { SalesItemLineDetail: { TaxCodeRef?: unknown; Qty: number } }[])[0].SalesItemLineDetail).toMatchObject({ Qty: 2, TaxCodeRef: { value: 'TAX' } });
    const upd = buildQboInvoicePayload(inv, '58', { defaults }, { id: '130', syncToken: '2' });
    expect(upd).toMatchObject({ Id: '130', SyncToken: '2', sparse: true });
    expect(upd.DocNumber).toBeUndefined();
  });

  it('collapses inexact qty x price lines to qty 1 so the amount always wins', () => {
    const inv = { invoiceNumber: 'X', issueDate: '2026-10-01', dueDate: '2026-10-31', taxCents: 0, lines: [{ description: 'Odd', qty: 3, unitPriceCents: 3333, amountCents: 10000, itemId: '7' }] };
    const d = (buildQboInvoicePayload(inv, '1', { defaults }).Line as { SalesItemLineDetail: { Qty: number; UnitPrice: number } }[])[0].SalesItemLineDetail;
    expect(d).toMatchObject({ Qty: 1, UnitPrice: 100 });
  });
});

describe('payments', () => {
  it('parses applications to invoices and ignores credit memos', () => {
    const p = parseQboPayment({
      Id: '9', CustomerRef: { value: '58' }, TotalAmt: 150, TxnDate: '2026-10-05',
      DepositToAccountRef: { value: '35' }, PaymentMethodRef: { value: '3', name: 'Visa' },
      Line: [
        { Amount: 100, LinkedTxn: [{ TxnId: '130', TxnType: 'Invoice' }] },
        { Amount: 50, LinkedTxn: [{ TxnId: '77', TxnType: 'CreditMemo' }] },
      ],
    });
    expect(p).toMatchObject({ id: '9', totalCents: 15000, depositAccountId: '35', applications: [{ invoiceId: '130', amountCents: 10000 }] });
    expect(paymentMethodFromName('Visa')).toBe('card');
    expect(paymentMethodFromName('Cheque')).toBe('check');
    expect(paymentMethodFromName(null)).toBe('other');
  });

  it('builds a linked payment payload', () => {
    const p = buildQboPaymentPayload({ customerId: '58', invoiceId: '130', amountCents: 10050, date: '2026-10-05', depositAccountId: '35', note: 'Vireek payment' });
    expect(p).toMatchObject({ TotalAmt: 100.5, DepositToAccountRef: { value: '35' }, Line: [{ Amount: 100.5, LinkedTxn: [{ TxnId: '130', TxnType: 'Invoice' }] }] });
  });
});

describe('requests', () => {
  it('builds an incremental, ordered, paged query', () => {
    const r = buildQueryRequest({ base: BASE, realm: '123145', entity: 'customer', since: qboTimestamp(Date.UTC(2026, 9, 1, 12, 0, 0)), pos: 101, pageSize: 100 });
    const q = decodeURIComponent(r.url.split('query=')[1]);
    expect(r.url.startsWith(`${BASE}/v3/company/123145/query?minorversion=`)).toBe(true);
    expect(q).toBe("select * from Customer where Metadata.LastUpdatedTime >= '2026-10-01T12:00:00+00:00' and Active IN (true, false) order by Metadata.LastUpdatedTime startposition 101 maxresults 100");
    const inv = decodeURIComponent(buildQueryRequest({ base: BASE, realm: '123145', entity: 'invoice', since: null, pos: 1, pageSize: 50 }).url.split('query=')[1]);
    expect(inv).toBe('select * from Invoice order by Metadata.LastUpdatedTime startposition 1 maxresults 50');
  });

  it('escapes literals so a customer name cannot inject query text', () => {
    expect(qboLiteral("O'Brien \\ Sons")).toBe("'O\\'Brien \\\\ Sons'");
    const q = decodeURIComponent(buildFindRequest({ base: BASE, realm: '123145', entity: 'customer', field: 'DisplayName', value: "x' or Id > '0" }).url.split('query=')[1]);
    expect(q).toContain("DisplayName = 'x\\' or Id > \\'0'");
    expect(() => buildFindRequest({ base: BASE, realm: '123145', entity: 'customer', field: 'Id; drop', value: 'x' })).toThrow();
  });

  it('only accepts numeric ids in paths', () => {
    expect(buildGetRequest({ base: BASE, realm: '123145', entity: 'invoice', id: '130' }).url).toContain('/invoice/130?');
    expect(() => buildGetRequest({ base: BASE, realm: '123145', entity: 'invoice', id: '../x' })).toThrow();
    expect(() => buildVoidRequest({ base: BASE, realm: '123145', id: '1/2', syncToken: '0' })).toThrow();
  });

  it('idempotent creates and void', () => {
    expect(buildWriteRequest({ base: BASE, realm: '123145', entity: 'invoice', payload: {}, requestId: 'vk-i-abc123' }).url).toContain('&requestid=vk-i-abc123');
    expect(buildWriteRequest({ base: BASE, realm: '123145', entity: 'invoice', payload: {}, requestId: 'bad id!' }).url).not.toContain('requestid');
    expect(buildVoidRequest({ base: BASE, realm: '123145', id: '130', syncToken: '2' }).url).toContain('operation=void');
  });

  it('allow-lists API hosts and realm ids', () => {
    expect(isAllowedApiBase('https://quickbooks.api.intuit.com/')).toBe(true);
    expect(isAllowedApiBase(BASE)).toBe(true);
    expect(isAllowedApiBase('https://evil.example.com')).toBe(false);
    expect(isAllowedApiBase('https://quickbooks.api.intuit.com.evil.com')).toBe(false);
    expect(isValidRealmId('123145820')).toBe(true);
    expect(isValidRealmId('1/../2')).toBe(false);
  });

  it('classifies responses', () => {
    const f = (code: string) => ({ Fault: { Error: [{ code, Message: 'm', Detail: 'd' }] } });
    expect(classifyResponse(200, {}).kind).toBe('ok');
    expect(classifyResponse(401, {}).kind).toBe('auth');
    expect(classifyResponse(429, {}).kind).toBe('throttle');
    expect(classifyResponse(400, f('5010')).kind).toBe('stale');
    expect(classifyResponse(400, f('6240')).kind).toBe('duplicate');
    expect(classifyResponse(400, f('2020')).kind).toBe('validation');
    expect(classifyResponse(200, f('2020')).kind).toBe('validation');
    expect(classifyResponse(404, {}).kind).toBe('notfound');
    expect(classifyResponse(503, {}).kind).toBe('error');
  });

  it('parses pages', () => {
    const p = parseQueryResponse('customer', { QueryResponse: { Customer: [{ Id: '1' }, { Id: '2' }] } }, 2);
    expect(p.records).toHaveLength(2);
    expect(p.more).toBe(true);
    expect(parseQueryResponse('customer', { QueryResponse: {} }, 2)).toEqual({ records: [], more: false });
  });
});

describe('OAuth + secrets', () => {
  it('builds the authorize URL and token requests', () => {
    const u = new URL(buildAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://x.supabase.co/functions/v1/qbo-oauth-callback', state: 's' }));
    expect(u.origin + u.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(u.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    expect(u.searchParams.get('response_type')).toBe('code');
    const t = buildTokenRequest('code', { clientId: 'cid', clientSecret: 'sec', code: 'abc', redirectUri: 'https://r' });
    expect(t.url).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    expect(t.headers.Authorization).toBe(`Basic ${btoa('cid:sec')}`);
    expect(new URLSearchParams(t.body).get('grant_type')).toBe('authorization_code');
    expect(new URLSearchParams(buildTokenRequest('refresh', { clientId: 'a', clientSecret: 'b', refreshToken: 'r' }).body).get('refresh_token')).toBe('r');
  });

  it('parses tokens', () => {
    expect(parseTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600, x_refresh_token_expires_in: 8726400 })).toEqual({ accessToken: 'a', refreshToken: 'r', expiresInSec: 3600, refreshExpiresInSec: 8726400 });
    expect(() => parseTokenResponse({})).toThrow();
  });

  it('signs state, rejects tampering, expiry and a wrong secret', async () => {
    const now = Date.now();
    const state = await signOAuthState({ owner: 'o1', user: 'u1' }, 'secret', now);
    expect(await verifyOAuthState(state, 'secret', now + 1000)).toMatchObject({ o: 'o1', u: 'u1' });
    expect(await verifyOAuthState(state, 'other', now)).toBeNull();
    expect(await verifyOAuthState(state, 'secret', now + 11 * 60_000)).toBeNull();
    expect(await verifyOAuthState(`${state.split('.')[0]}x.${state.split('.')[1]}`, 'secret', now)).toBeNull();
    expect(await verifyOAuthState('garbage', 'secret', now)).toBeNull();
  });

  it('encrypts tokens at rest (random IV, authenticated)', async () => {
    const a = await encryptSecret('refresh-token', KEY);
    const b = await encryptSecret('refresh-token', KEY);
    expect(a).not.toBe(b);
    expect(a).not.toContain('refresh-token');
    expect(await decryptSecret(a, KEY)).toBe('refresh-token');
    await expect(decryptSecret(a.slice(0, -2) + 'AA', KEY)).rejects.toThrow();
  });

  it('verifies Intuit webhook signatures and extracts realms', async () => {
    const body = JSON.stringify({ eventNotifications: [{ realmId: '123145820', dataChangeEvent: { entities: [] } }, { realmId: 'bad/id' }] });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('verifier'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))));
    expect(await verifyWebhookSignature(body, sig, 'verifier')).toBe(true);
    expect(await verifyWebhookSignature(body + ' ', sig, 'verifier')).toBe(false);
    expect(await verifyWebhookSignature(body, null, 'verifier')).toBe(false);
    expect(webhookRealms(JSON.parse(body))).toEqual(['123145820']);
  });
});
