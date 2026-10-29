import { describe, it, expect } from 'vitest';
import {
  ACCT_ENTITIES,
  ACCT_PROVIDERS,
  allocateTax,
  decryptSecret,
  defaultSettings,
  effectiveDirection,
  encryptSecret,
  fieldsFor,
  invoiceAmountSig,
  mergeEntity,
  mergeFieldsFor,
  paymentLinkKey,
  paymentMethodFromName,
  resolveLineItems,
  signOAuthState,
  validateSettings,
  verifyHmacBase64,
  verifyOAuthState,
  type ConnInfo,
} from '../../supabase/functions/_shared/accounting/core';
import { PROVIDERS } from '../../supabase/functions/_shared/accounting/registry';
import { jwtClaims, parseConnections, xeroTime, xeroWebhookTenants } from '../../supabase/functions/_shared/accounting/xero';
import { isZohoRegion, parseOrganizations, regionFromAccountsServer, zohoTime } from '../../supabase/functions/_shared/accounting/zoho';
import { buildClientAssertion, idFromLocation, nsBase, nsHost, nsNormalizeAccountId } from '../../supabase/functions/_shared/accounting/netsuite';

const XERO_TENANT = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const cx = (provider: ConnInfo['provider'], tenantId: string, region: string | null = null): ConnInfo => ({ provider, tenantId, region, config: {} });
const xero = PROVIDERS.xero.adapter;
const zoho = PROVIDERS.zoho_books.adapter;
const ns = PROVIDERS.netsuite.adapter;

describe('settings', () => {
  it('has safe defaults for every provider and entity', () => {
    for (const p of ACCT_PROVIDERS) {
      const s = defaultSettings(p);
      expect(s.entities.invoice.conflict).toBe('manual');
      expect(s.entities.payment.conflict).toBe('manual');
      expect(s.entities.account.direction).toBe('from_ext');
      expect(validateSettings(p, s).ok).toBe(true);
      for (const e of ACCT_ENTITIES) expect(Object.keys(s.entities[e].fields).sort()).toEqual(fieldsFor(p, e).map((f) => f.key).sort());
    }
    expect(defaultSettings('netsuite').entities.item.direction).toBe('from_ext');
    expect(defaultSettings('xero').entities.item.direction).toBe('both');
    expect(defaultSettings('netsuite').defaults.sendDocNumber).toBe(false);
  });

  it('hides fields a provider cannot store', () => {
    expect(fieldsFor('xero', 'customer').some((f) => f.key === 'notes')).toBe(false);
    expect(fieldsFor('zoho_books', 'customer').some((f) => f.key === 'notes')).toBe(true);
    expect(fieldsFor('netsuite', 'item').some((f) => f.key === 'price')).toBe(false);
  });

  it('rejects malformed settings with a readable reason', () => {
    expect(validateSettings('xero', null).ok).toBe(false);
    expect(validateSettings('xero', { entities: { customer: { direction: 'sideways' } } })).toMatchObject({ ok: false });
    expect(validateSettings('xero', { entities: { customer: { fields: { notes: 'both' } } } })).toMatchObject({ ok: false }); // notes unsupported on Xero
    expect(validateSettings('xero', { entities: { customer: { fields: { name: 'off' } } } })).toMatchObject({ ok: false }); // required
    expect(validateSettings('xero', { defaults: { incomeAccountId: "x'; drop table" } })).toMatchObject({ ok: false });
    expect(validateSettings('xero', { defaults: { currency: 'usd' } })).toMatchObject({ ok: false });
    expect(validateSettings('xero', { defaults: { incomeAccountId: 'SALES-1', currency: 'GBP' } })).toMatchObject({ ok: true });
  });

  it('applies entity direction on top of field direction', () => {
    expect(effectiveDirection('both', 'to_ext')).toBe('to_ext');
    expect(effectiveDirection('to_ext', 'both')).toBe('to_ext');
    expect(effectiveDirection('to_ext', 'from_ext')).toBe('off');
    expect(effectiveDirection('both', 'off')).toBe('off');
  });

  it('forces provider read-only fields to flow inward only', () => {
    const s = defaultSettings('zoho_books').entities.item;
    expect(mergeFieldsFor('zoho_books', 'item', s).find((f) => f.key === 'active')?.direction).toBe('from_crm');
    const onlyOut = { ...s, direction: 'to_ext' as const };
    expect(mergeFieldsFor('zoho_books', 'item', onlyOut).some((f) => f.key === 'active')).toBe(false);
  });
});

describe('three-way merge', () => {
  const settings = defaultSettings('xero').entities.customer;
  const base = { name: 'Acme', email: 'a@acme.com', phone: '5551234567', address: '1 Main St' };
  it('moves only what changed and detects a true conflict', () => {
    const r = mergeEntity({ provider: 'xero', entity: 'customer', settings, base, vireek: { ...base, phone: '5559999999' }, ext: { ...base, email: 'b@acme.com' }, vireekTs: 2, extTs: 1 });
    expect(r.toCrm).toMatchObject({ phone: '5559999999' });
    expect(r.toVireek).toMatchObject({ email: 'b@acme.com' });
    expect(r.conflicts).toHaveLength(0);
    const c = mergeEntity({ provider: 'xero', entity: 'customer', settings: { ...settings, conflict: 'manual' }, base, vireek: { ...base, name: 'Acme Inc' }, ext: { ...base, name: 'ACME LLC' }, vireekTs: 2, extTs: 1 });
    expect(c.conflicts.map((x) => x.field)).toEqual(['name']);
    const w = mergeEntity({ provider: 'xero', entity: 'customer', settings: { ...settings, conflict: 'ext_wins' }, base, vireek: { ...base, name: 'Acme Inc' }, ext: { ...base, name: 'ACME LLC' }, vireekTs: 2, extTs: 1 });
    expect(w.toVireek).toMatchObject({ name: 'ACME LLC' });
  });
});

describe('money helpers', () => {
  it('allocates tax exactly, never losing a cent', () => {
    for (const [lines, tax] of [[[3333, 3333, 3334], 1], [[10000, 5000], 1234], [[1, 1, 1], 2], [[100], 0]] as [number[], number][]) {
      const out = allocateTax(lines.map((amountCents) => ({ amountCents })), tax);
      expect(out.reduce((s, n) => s + n, 0)).toBe(tax);
      expect(out.every((n) => n >= 0)).toBe(true);
    }
    expect(allocateTax([], 5)).toEqual([]);
  });

  it('signs invoices canonically', () => {
    const a = invoiceAmountSig({ lines: [{ description: ' Tune  Up ', qty: 1, amountCents: 5000 }], taxCents: 400, totalCents: 5400 });
    const b = invoiceAmountSig({ lines: [{ description: 'tune up', qty: 1.0, amountCents: 5000 }], taxCents: 400, totalCents: 5400 });
    expect(a).toBe(b);
    expect(a).not.toBe(invoiceAmountSig({ lines: [{ description: 'tune up', qty: 1, amountCents: 5000 }], taxCents: 0, totalCents: 5000 }));
  });

  it('resolves line items, requiring a fallback only where the provider needs one', () => {
    const lines = [{ description: 'Tune Up', qty: 1, unitPriceCents: 100, amountCents: 100, itemId: null }, { description: 'Other', qty: 1, unitPriceCents: 100, amountCents: 100, itemId: null }];
    const map = new Map([['tune up', '77']]);
    expect(resolveLineItems(lines, map, null, true)).toMatchObject({ ok: false });
    expect(resolveLineItems(lines, map, '9', true)).toMatchObject({ ok: true, lines: [{ itemId: '77' }, { itemId: '9' }] });
    expect(resolveLineItems(lines, map, null, false)).toMatchObject({ ok: true });
  });

  it('maps payment methods and link keys', () => {
    expect(paymentMethodFromName('creditcard')).toBe('card');
    expect(paymentMethodFromName('banktransfer')).toBe('ach');
    expect(paymentMethodFromName('Cheque')).toBe('check');
    expect(paymentMethodFromName(null)).toBe('other');
    expect(paymentLinkKey('p1', 'i1')).toBe('p1:i1');
  });
});

describe('xero adapter', () => {
  const c = cx('xero', XERO_TENANT);
  const inv = (over: Record<string, unknown> = {}) => ({
    InvoiceID: XERO_TENANT, Type: 'ACCREC', Status: 'AUTHORISED', InvoiceNumber: 'INV-1', Contact: { ContactID: 'c1' }, DateString: '2026-10-01T00:00:00', DueDateString: '2026-10-31T00:00:00',
    CurrencyCode: 'USD', LineAmountTypes: 'Exclusive', UpdatedDateUTC: '/Date(1790000000000+0000)/',
    LineItems: [{ Description: 'Tune up', Quantity: 2, UnitAmount: 50, LineAmount: 100, TaxAmount: 8 }], SubTotal: 100, TotalTax: 8, Total: 108, AmountDue: 108, ...over,
  });

  it('parses Xero timestamps', () => {
    expect(xeroTime('/Date(1573639200000+0000)/')).toBe(1573639200000);
    expect(xeroTime('2019-11-13T10:00:00')).toBe(Date.parse('2019-11-13T10:00:00Z'));
    expect(xeroTime('nope')).toBeNull();
  });

  it('builds paged, filtered, incremental list requests', () => {
    const r = xero.list(c, 'invoice', '2026-10-01T10:00:00.000Z', 3);
    expect(r.url).toContain('https://api.xero.com/api.xro/2.0/Invoices?');
    expect(r.url).toContain('page=3');
    expect(decodeURIComponent(r.url)).toContain('Type=="ACCREC"');
    expect(r.headers?.['If-Modified-Since']).toBe('2026-10-01T10:00:00');
    expect(xero.list(c, 'account', null, 1).url).toBe('https://api.xero.com/api.xro/2.0/Accounts');
    expect(xero.parseList('invoice', { Invoices: [inv()] }, 1).more).toBe(false);
    expect(xero.parseList('customer', { Contacts: Array.from({ length: 100 }, (_, i) => ({ ContactID: `${i}`, UpdatedDateUTC: '/Date(1+0000)/' })) }, 1).more).toBe(true);
  });

  it('parses an invoice and rejects what it cannot represent faithfully', () => {
    const ok = xero.parseInvoice(inv(), 'USD');
    expect(ok.ok && ok.doc).toMatchObject({ totalCents: 10800, taxCents: 800, subtotalCents: 10000, dueDate: '2026-10-31', customerId: 'c1' });
    expect(xero.parseInvoice(inv({ Status: 'DRAFT' }), 'USD')).toMatchObject({ ok: false, silent: true });
    expect(xero.parseInvoice(inv({ Type: 'ACCPAY' }), 'USD')).toMatchObject({ ok: false, silent: true });
    expect(xero.parseInvoice(inv({ CurrencyCode: 'GBP' }), 'USD')).toMatchObject({ ok: false });
    expect(xero.parseInvoice(inv({ Total: 200 }), 'USD')).toMatchObject({ ok: false });
    const v = xero.parseInvoice(inv({ Status: 'VOIDED' }), 'USD');
    expect(v.ok && v.doc.voided).toBe(true);
    const incl = xero.parseInvoice(inv({ LineAmountTypes: 'Inclusive', LineItems: [{ Description: 'x', Quantity: 1, UnitAmount: 108, LineAmount: 108, TaxAmount: 8 }] }), 'USD');
    expect(incl.ok && incl.doc.subtotalCents).toBe(10000);
  });

  it('sends exact tax per line so totals always match', () => {
    const p = xero.buildInvoice(
      { invoiceNumber: 'INV-9', issueDate: '2026-10-01', dueDate: '2026-10-31', taxCents: 1, lines: [{ description: 'a', qty: 1, unitPriceCents: 3333, amountCents: 3333, itemId: null }, { description: 'b', qty: 1, unitPriceCents: 3333, amountCents: 3333, itemId: null }, { description: 'c', qty: 1, unitPriceCents: 3334, amountCents: 3334, itemId: null }] },
      'c1', { defaults: defaultSettings('xero').defaults },
    );
    const lines = p.LineItems as { TaxAmount: number }[];
    expect(Math.round(lines.reduce((s, l) => s + l.TaxAmount, 0) * 100)).toBe(1);
    expect(p).toMatchObject({ Type: 'ACCREC', Status: 'AUTHORISED', InvoiceNumber: 'INV-9', LineAmountTypes: 'Exclusive' });
    expect(xero.buildInvoice({ invoiceNumber: 'x', issueDate: '2026-10-01', dueDate: '2026-10-31', taxCents: 0, lines: [] }, 'c1', { defaults: defaultSettings('xero').defaults }, { id: 'i', version: '', raw: null })).not.toHaveProperty('Contact');
  });

  it('maps customers both ways and never invents fields it cannot store', () => {
    const canon = xero.toCanon('customer', { Name: 'Acme', EmailAddress: 'a@acme.com', Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: '5551234', PhoneAreaCode: '555', PhoneCountryCode: '1' }], Addresses: [{ AddressType: 'POBOX', AddressLine1: '1 Main', City: 'Austin', Region: 'TX', PostalCode: '78701' }] });
    expect(canon).toMatchObject({ name: 'Acme', email: 'a@acme.com', phone: '+1 555 5551234', address: '1 Main, Austin, TX 78701' });
    const payload = xero.toPayload('customer', { name: 'Acme', notes: 'secret' }, { defaults: defaultSettings('xero').defaults }, true);
    expect(payload).toEqual({ Name: 'Acme' });
    const item = xero.toPayload('item', { name: 'N'.repeat(80), price: 5 }, { defaults: { ...defaultSettings('xero').defaults, incomeAccountId: '200' }, vireekId: 'abcdef12-3456' }, true);
    expect((item.Name as string).length).toBe(50);
    expect(item).toMatchObject({ Code: 'VK-ABCDEF123456', IsSold: true, SalesDetails: { UnitPrice: 5, AccountCode: '200' } });
    expect(xero.isCustomerRecord({ IsSupplier: true, IsCustomer: false })).toBe(false);
  });

  it('creates payments with idempotency and the right account reference', () => {
    const r = xero.createPayment(c, { customerId: 'c1', invoiceId: XERO_TENANT, amountCents: 2550, date: '2026-10-02', depositAccountId: '090', method: 'card', note: 'n' }, 'vk-pay-1');
    expect(r.method).toBe('PUT');
    expect(r.headers?.['Idempotency-Key']).toBe('vk-pay-1');
    expect(JSON.stringify(r.body)).toContain('"Code":"090"');
    expect(JSON.stringify(r.body)).toContain('"Amount":25.5');
  });

  it('classifies failures, never trusts ids and never leaves xero.com', () => {
    expect(xero.classify(400, { Elements: [{ ValidationErrors: [{ Message: 'Name must be unique' }] }] })).toMatchObject({ kind: 'duplicate' });
    expect(xero.classify(429, null).kind).toBe('throttle');
    expect(xero.classify(401, null).kind).toBe('auth');
    expect(() => xero.get(c, 'invoice', "1' or '1'='1")).toThrow();
    expect(xero.isAllowedUrl('https://api.xero.com/api.xro/2.0/Invoices', c)).toBe(true);
    expect(xero.isAllowedUrl('https://api.xero.com.evil.test/x', c)).toBe(false);
    expect(xero.find(c, 'customer', 'name', 'Bad "Name"')).toBeNull();
  });

  it('reads tenants and webhook payloads', () => {
    const conns = parseConnections([
      { id: XERO_TENANT, tenantId: XERO_TENANT, tenantType: 'ORGANISATION', tenantName: 'Old', updatedDateUtc: '2025-01-01T00:00:00' },
      { id: '11111111-2222-3333-4444-555555555555', tenantId: '66666666-7777-8888-9999-000000000000', tenantType: 'ORGANISATION', tenantName: 'New', updatedDateUtc: '2026-01-01T00:00:00' },
      { id: 'x', tenantId: 'y', tenantType: 'PRACTICE' },
    ]);
    expect(conns.map((x) => x.name)).toEqual(['New', 'Old']);
    expect(xeroWebhookTenants({ events: [{ tenantId: XERO_TENANT }, { tenantId: XERO_TENANT }, { tenantId: 'junk' }] })).toEqual([XERO_TENANT]);
    const jwt = `h.${btoa(JSON.stringify({ authentication_event_id: 'abc' })).replace(/=/g, '')}.s`;
    expect(jwtClaims(jwt).authentication_event_id).toBe('abc');
    expect(jwtClaims('garbage')).toEqual({});
  });
});

describe('zoho books adapter', () => {
  const c = cx('zoho_books', '10234695', 'eu');
  const inv = (over: Record<string, unknown> = {}) => ({
    invoice_id: '1001', invoice_number: 'INV-1', customer_id: '2002', status: 'sent', date: '2026-10-01', due_date: '2026-10-31', currency_code: 'USD', last_modified_time: '2026-10-02T10:00:00+0530',
    line_items: [{ item_id: '55', name: 'Tune up', description: 'Tune up', rate: 50, quantity: 2, item_total: 100 }], sub_total: 100, tax_total: 8, total: 108, balance: 108, ...over,
  });

  it('knows its data centres and timestamps', () => {
    expect(isZohoRegion('eu')).toBe(true);
    expect(isZohoRegion('evil.com')).toBe(false);
    expect(regionFromAccountsServer('https://accounts.zoho.in')).toBe('in');
    expect(regionFromAccountsServer('https://accounts.zoho.evil.com')).toBeNull();
    expect(zohoTime('2026-10-02T10:00:00+0530')).toBe(Date.parse('2026-10-02T10:00:00+05:30'));
  });

  it('puts the organisation and region on every call', () => {
    const r = zoho.list(c, 'invoice', '2026-10-01T10:00:00.000Z', 2);
    expect(r.url.startsWith('https://www.zohoapis.eu/books/v3/invoices?')).toBe(true);
    expect(r.url).toContain('organization_id=10234695');
    expect(r.url).toContain('page=2');
    expect(r.url).toContain('last_modified_time=');
    expect(zoho.isAllowedUrl(r.url, c)).toBe(true);
    expect(zoho.isAllowedUrl(r.url, cx('zoho_books', '1', 'com'))).toBe(false);
    expect(() => zoho.get(c, 'invoice', '1/../2')).toThrow();
  });

  it('lists: full rows for accounts, ids + markers for everything else', () => {
    const accounts = zoho.parseList('account', { chartofaccounts: [{ account_id: '9', account_name: 'Sales', account_type: 'income' }], page_context: { has_more_page: false } }, 1);
    expect(accounts.records[0].raw).not.toBeNull();
    const invoices = zoho.parseList('invoice', { invoices: [inv()], page_context: { has_more_page: true } }, 1);
    expect(invoices.records[0]).toMatchObject({ id: '1001', version: '2026-10-02T10:00:00+0530', raw: null });
    expect(invoices.more).toBe(true);
  });

  it('parses invoices and refuses what would corrupt the ledger', () => {
    const ok = zoho.parseInvoice(inv(), 'USD');
    expect(ok.ok && ok.doc).toMatchObject({ totalCents: 10800, taxCents: 800, customerId: '2002' });
    expect(zoho.parseInvoice(inv({ status: 'draft' }), 'USD')).toMatchObject({ ok: false, silent: true });
    expect(zoho.parseInvoice(inv({ discount: 5 }), 'USD')).toMatchObject({ ok: false });
    expect(zoho.parseInvoice(inv({ currency_code: 'EUR' }), 'USD')).toMatchObject({ ok: false });
    const v = zoho.parseInvoice(inv({ status: 'void' }), 'USD');
    expect(v.ok && v.doc.voided).toBe(true);
  });

  it('creates invoices as sent, applies payments to the invoice', () => {
    expect(zoho.caps.markSentAfterCreate).toBe(true);
    expect(zoho.markSent(c, '1001')?.url).toContain('/invoices/1001/status/sent');
    expect(zoho.voidInvoice(c, '1001', null)?.url).toContain('/invoices/1001/status/void');
    const pay = zoho.createPayment(c, { customerId: '2002', invoiceId: '1001', amountCents: 10800, date: '2026-10-05', depositAccountId: '77', method: 'ach', note: 'n' }, 'k');
    expect(pay.body).toMatchObject({ payment_mode: 'banktransfer', amount: 108, account_id: '77', invoices: [{ invoice_id: '1001', amount_applied: 108 }] });
    const p = zoho.parsePayment({ payment_id: '5', customer_id: '2002', amount: 108, date: '2026-10-05', account_id: '77', payment_mode: 'banktransfer', invoices: [{ invoice_id: '1001', amount_applied: 108 }] });
    expect(p).toMatchObject({ totalCents: 10800, applications: [{ invoiceId: '1001', amountCents: 10800 }] });
  });

  it('classifies Zoho error envelopes', () => {
    expect(zoho.classify(200, { code: 0, message: 'success' }).kind).toBe('ok');
    expect(zoho.classify(400, { code: 4, message: 'Invoice number already exists' }).kind).toBe('duplicate');
    expect(zoho.classify(401, { code: 57 }).kind).toBe('auth');
    expect(zoho.classify(429, {}).kind).toBe('throttle');
  });

  it('picks the default organisation', () => {
    expect(parseOrganizations({ organizations: [{ organization_id: '11111', name: 'A' }, { organization_id: '22222', name: 'B', is_default_org: true, currency_code: 'EUR' }] })).toEqual({ id: '22222', name: 'B', currency: 'EUR' });
    expect(parseOrganizations({ organizations: [] })).toBeNull();
  });
});

describe('netsuite adapter', () => {
  const c = cx('netsuite', '1234567_SB1');
  it('normalises account ids into the right host', () => {
    expect(nsNormalizeAccountId(' 1234567-sb1 ')).toBe('1234567_SB1');
    expect(nsNormalizeAccountId('evil.com/x')).toBeNull();
    expect(nsHost('1234567_SB1')).toBe('1234567-sb1.suitetalk.api.netsuite.com');
    expect(ns.isAllowedUrl(`${nsBase('1234567_SB1')}/record/v1/invoice`, c)).toBe(true);
    expect(ns.isAllowedUrl('https://other.suitetalk.api.netsuite.com/x', c)).toBe(false);
  });

  it('lists with SuiteQL, an incremental filter and a stable order', () => {
    const r = ns.list(c, 'invoice', '2026-10-01T10:00:00.000Z', 1000);
    expect(r.method).toBe('POST');
    expect(r.url).toContain('/query/v1/suiteql?limit=1000&offset=1000');
    expect(r.headers?.Prefer).toBe('transient');
    const q = (r.body as { q: string }).q;
    expect(q).toContain("type = 'CustInvc'");
    expect(q).toContain("TO_DATE('2026-10-01 10:00:00'");
    expect(q).toMatch(/ORDER BY lastmodifieddate, id$/);
    expect((ns.list(c, 'customer', null, 0).body as { q: string }).q).not.toContain('WHERE');
    expect(ns.parseList('customer', { items: [{ id: '5', lm: '2026-10-01 10:00:00' }, { id: "5'; --" }], hasMore: true }, 0)).toMatchObject({ more: true, records: [{ id: '5', version: '2026-10-01 10:00:00' }] });
    expect(() => ns.get(c, 'customer', '1 OR 1=1')).toThrow();
  });

  it('escapes lookups', () => {
    const q = (ns.find(c, 'customer', 'name', "O'Brien & Sons")!.body as { q: string }).q;
    expect(q).toContain("'O''Brien & Sons'");
  });

  it('parses invoices and explains what it cannot do', () => {
    const raw = { id: '88', tranId: 'INV-1', tranDate: '2026-10-01', dueDate: '2026-10-31', entity: { id: '12' }, currency: { refName: 'USD' }, status: { refName: 'Open' }, lastModifiedDate: '2026-10-02T10:00:00Z',
      item: { items: [{ item: { id: '55', refName: 'Tune up' }, description: 'Tune up', quantity: 2, rate: 50, amount: 100 }] }, taxTotal: 8, total: 108, amountRemaining: 108 };
    const ok = ns.parseInvoice(raw, 'USD');
    expect(ok.ok && ok.doc).toMatchObject({ totalCents: 10800, customerId: '12', lines: [{ itemId: '55' }] });
    expect(ns.parseInvoice({ ...raw, total: 500 }, 'USD')).toMatchObject({ ok: false });
    const v = ns.parseInvoice({ ...raw, status: { refName: 'Voided' } }, 'USD');
    expect(v.ok && v.doc.voided).toBe(true);
    expect(ns.caps.canVoid).toBe(false);
    expect(ns.voidInvoice(c, '88', null)).toBeNull();
    expect(ns.caps.lineNeedsItem).toBe(true);
  });

  it('turns an invoice into a payment through the transform endpoint', () => {
    const r = ns.createPayment(c, { customerId: '12', invoiceId: '88', amountCents: 10800, date: '2026-10-05', depositAccountId: '3', method: 'card', note: 'n' }, 'k');
    expect(r.url.endsWith('/record/v1/invoice/88/!transform/customerPayment')).toBe(true);
    expect(r.body).toMatchObject({ account: { id: '3' }, payment: 108, tranDate: '2026-10-05' });
    expect(idFromLocation('https://x.suitetalk.api.netsuite.com/services/rest/record/v1/customerpayment/4567')).toBe('4567');
    expect(ns.parseWrite('payment', null, 'https://x/services/rest/record/v1/customerpayment/4567').id).toBe('4567');
  });

  it('signs a verifiable ES256 client assertion', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----`;
    const now = Date.parse('2026-10-28T12:00:00Z');
    const jwt = await buildClientAssertion({ accountId: '1234567_SB1', clientId: 'cid', certificateId: 'cert1', privateKeyPem: pem, now });
    const [h, b, s] = jwt.split('.');
    const dec = (x: string) => JSON.parse(atob(x.replace(/-/g, '+').replace(/_/g, '/')));
    expect(dec(h)).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'cert1' });
    const claims = dec(b);
    expect(claims).toMatchObject({ iss: 'cid', scope: ['rest_webservices'], aud: 'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token', iat: Math.floor(now / 1000) });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(3600);
    const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (ch) => ch.charCodeAt(0));
    expect(sig.length).toBe(64);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, sig, new TextEncoder().encode(`${h}.${b}`))).toBe(true);
    // an escaped one-line PEM (as stored in env vars) works too
    expect(await buildClientAssertion({ accountId: '1234567', clientId: 'cid', certificateId: 'c', privateKeyPem: pem.replace(/\n/g, '\\n'), now })).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });
});

describe('security primitives', () => {
  const secret = 'state-secret';
  it('binds the OAuth state to a provider and expires it', async () => {
    const now = Date.now();
    const s = await signOAuthState({ owner: 'o', user: 'u', provider: 'xero' }, secret, now);
    expect(await verifyOAuthState(s, secret, now + 1000)).toMatchObject({ o: 'o', u: 'u', p: 'xero' });
    expect(await verifyOAuthState(s, 'other', now)).toBeNull();
    expect(await verifyOAuthState(s, secret, now + 11 * 60_000)).toBeNull();
    expect(await verifyOAuthState(`${s}x`, secret, now)).toBeNull();
    const [body, sig] = s.split('.');
    const forged = btoa(JSON.stringify({ ...JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))), p: 'zoho_books' })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    expect(await verifyOAuthState(`${forged}.${sig}`, secret, now)).toBeNull();
    expect((await verifyOAuthState(await signOAuthState({ owner: 'o', user: 'u', provider: 'zoho_books', region: 'eu' }, secret, now), secret, now))?.r).toBe('eu');
  });

  it('verifies webhook signatures in constant time', async () => {
    const body = '{"events":[]}';
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('whkey'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))));
    expect(await verifyHmacBase64(body, sig, 'whkey')).toBe(true);
    expect(await verifyHmacBase64(`${body} `, sig, 'whkey')).toBe(false);
    expect(await verifyHmacBase64(body, null, 'whkey')).toBe(false);
    expect(await verifyHmacBase64(body, sig, '')).toBe(false);
  });

  it('encrypts tokens at rest', async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const enc = await encryptSecret('refresh-token', key);
    expect(enc).not.toContain('refresh-token');
    expect(await decryptSecret(enc, key)).toBe('refresh-token');
    await expect(decryptSecret(enc, btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))))).rejects.toBeTruthy();
  });
});
