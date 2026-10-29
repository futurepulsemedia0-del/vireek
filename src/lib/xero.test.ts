// Xero sync engine tests.
// NOT LIVE-VERIFIED: every fixture below is hand-written from Xero's public API documentation.
// Nothing here talks to Xero. Run a Demo Company smoke test (see XERO_SYNC.md) before production use.
import { describe, it, expect } from 'vitest';
import {
  FX_DUST_CENTS,
  XERO_ENTITIES,
  allocateCents,
  buildAuthorizeUrl,
  buildFindContactRequest,
  buildFindInvoiceRequest,
  buildGetRequest,
  buildItemByCodeRequest,
  buildListRequest,
  buildRevokeRequest,
  buildTokenRequest,
  buildVoidRequest,
  buildWriteRequest,
  buildXeroInvoicePayload,
  buildXeroPaymentPayload,
  canonToXero,
  checkBaseCurrency,
  classifyResponse,
  composeAddress,
  convertToBase,
  decryptSecret,
  defaultSettings,
  effectiveDirection,
  encryptSecret,
  generatedAccountCode,
  idempotencyKey,
  invoiceAmountSig,
  isAllowedXeroUrl,
  isSyncableAccount,
  isSyncableContact,
  isSyncableItem,
  jwtClaims,
  mergeEntity,
  paymentBaseCents,
  paymentMethodFromText,
  parseConnections,
  parseCurrencies,
  parseListResponse,
  parseOrganisation,
  parseRetryAfter,
  parseTaxRate,
  parseTokenResponse,
  parseXeroDate,
  parseXeroInvoice,
  parseXeroPayment,
  pickConnection,
  planTaxType,
  resolveLineItems,
  retryDelayMs,
  selectableSalesTaxRates,
  shortHash,
  signOAuthState,
  suggestItemCode,
  suggestXeroAccountType,
  taxRateMismatch,
  validateSettings,
  verifyOAuthState,
  verifyWebhookSignature,
  webhookTenants,
  xeroDateOnly,
  xeroToCanon,
  parseEntityResponse,
  type InvoiceLine,
  type XeroDefaults,
  type XeroSettings,
} from '../../supabase/functions/_shared/xero/engine';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const defaults: XeroDefaults = defaultSettings().defaults;
const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const G3 = '33333333-3333-4333-8333-333333333333';
const opts = { baseCurrency: 'USD', foreignCurrency: 'convert' as const };

const invoice = (over: Record<string, unknown> = {}) => ({
  InvoiceID: G1,
  Type: 'ACCREC',
  Status: 'AUTHORISED',
  InvoiceNumber: 'INV-0001',
  Contact: { ContactID: G2 },
  DateString: '2026-10-01T00:00:00',
  DueDateString: '2026-10-31T00:00:00',
  LineAmountTypes: 'Exclusive',
  UpdatedDateUTC: '/Date(1790000000000+0000)/',
  LineItems: [
    { Description: 'Drain cleaning', Quantity: 2, UnitAmount: 50, LineAmount: 100, TaxAmount: 8, ItemCode: 'DRAIN' },
    { Description: 'Trip charge', Quantity: 1, UnitAmount: 25, LineAmount: 25, TaxAmount: 2, AccountCode: '200' },
  ],
  SubTotal: 125,
  TotalTax: 10,
  Total: 135,
  ...over,
});

describe('settings', () => {
  it('defaults are valid and safe for money documents', () => {
    const s = defaultSettings();
    expect(validateSettings(s).ok).toBe(true);
    expect(s.entities.invoice.conflict).toBe('manual');
    expect(s.entities.payment.conflict).toBe('manual');
    expect(s.entities.account.direction).toBe('from_xero');
    expect(s.defaults.foreignCurrency).toBe('convert');
    for (const e of XERO_ENTITIES) expect(s.entities[e].enabled).toBe(true);
  });

  it('rejects unknown entities fields, directions, rules and malformed defaults', () => {
    const bad = (m: (s: XeroSettings) => void) => {
      const s = structuredClone(defaultSettings());
      m(s);
      return validateSettings(s);
    };
    expect(bad((s) => { (s.entities.contact as { direction: string }).direction = 'sideways'; }).ok).toBe(false);
    expect(bad((s) => { (s.entities.contact as { conflict: string }).conflict = 'coin_flip'; }).ok).toBe(false);
    expect(bad((s) => { s.entities.contact.fields.bogus = 'both'; }).ok).toBe(false);
    expect(bad((s) => { s.entities.contact.fields.name = 'off'; }).ok).toBe(false);
    expect(bad((s) => { s.defaults.depositAccountId = 'not-a-guid'; }).ok).toBe(false);
    expect(bad((s) => { s.defaults.taxType = "OUTPUT'; DROP"; }).ok).toBe(false);
    expect(bad((s) => { s.defaults.salesAccountCode = 'a"b'; }).ok).toBe(false);
    expect(bad((s) => { (s.defaults as { foreignCurrency: string }).foreignCurrency = 'guess'; }).ok).toBe(false);
    expect(validateSettings('nope').ok).toBe(false);
    expect(validateSettings({ entities: { contact: { enabled: 'yes' } } }).ok).toBe(false);
  });

  it('accepts and normalises valid defaults, and empty strings clear a default', () => {
    const r = validateSettings({ defaults: { taxType: 'OUTPUT2', depositAccountId: G3, salesAccountCode: '200', fallbackItemCode: '', foreignCurrency: 'skip' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settings.defaults.taxType).toBe('OUTPUT2');
      expect(r.settings.defaults.fallbackItemCode).toBeNull();
      expect(r.settings.defaults.foreignCurrency).toBe('skip');
      expect(r.settings.entities.invoice.conflict).toBe('manual');
    }
  });

  it('combines entity and field directions', () => {
    expect(effectiveDirection('both', 'to_xero')).toBe('to_xero');
    expect(effectiveDirection('from_xero', 'both')).toBe('from_xero');
    expect(effectiveDirection('from_xero', 'to_xero')).toBe('off');
    expect(effectiveDirection('both', 'off')).toBe('off');
  });
});

describe('merge', () => {
  const es = defaultSettings().entities.contact;
  const base = { name: 'Ann', email: 'a@x.com', phone: null, address: null };
  it('moves only the field that changed on one side', () => {
    const r = mergeEntity({ entity: 'contact', settings: es, base, vireek: { ...base, phone: '+15551234567' }, xero: base, vireekTs: 2, xeroTs: 1 });
    expect(r.toCrm).toEqual({ phone: '+15551234567' });
    expect(r.toVireek).toEqual({});
    expect(r.conflicts).toHaveLength(0);
  });
  it('flags a conflict only when both sides changed the same field (manual rule)', () => {
    const manual = { ...es, conflict: 'manual' as const };
    const r = mergeEntity({ entity: 'contact', settings: manual, base, vireek: { ...base, name: 'Ann V' }, xero: { ...base, name: 'Ann X' }, vireekTs: 2, xeroTs: 1 });
    expect(r.conflicts.map((c) => c.field)).toEqual(['name']);
  });
  it('xero_wins override resolves in favour of Xero', () => {
    const manual = { ...es, conflict: 'manual' as const };
    const r = mergeEntity({ entity: 'contact', settings: manual, base, vireek: { ...base, name: 'Ann V' }, xero: { ...base, name: 'Ann X' }, vireekTs: 2, xeroTs: 1, ruleOverride: 'xero_wins' });
    expect(r.toVireek.name).toBe('Ann X');
  });
});

describe('dates and ids', () => {
  it('parses .NET and ISO dates', () => {
    expect(parseXeroDate('/Date(1439434356790+0000)/')).toBe(1439434356790);
    expect(parseXeroDate('/Date(1439434356790)/')).toBe(1439434356790);
    expect(parseXeroDate('2026-10-01T00:00:00')).toBe(Date.parse('2026-10-01T00:00:00Z'));
    expect(parseXeroDate('nonsense')).toBeNull();
    expect(parseXeroDate(null)).toBeNull();
  });
  it('prefers the String variant for date-only fields', () => {
    expect(xeroDateOnly({ DateString: '2026-10-01T00:00:00', Date: '/Date(0)/' }, 'Date')).toBe('2026-10-01');
    expect(xeroDateOnly({ Date: '/Date(1790000000000+0000)/' }, 'Date')).toBe(new Date(1790000000000).toISOString().slice(0, 10));
    expect(xeroDateOnly({}, 'Date')).toBeNull();
  });
});

describe('allocateCents', () => {
  it('always sums exactly to the total', () => {
    for (let total = 0; total < 60; total++) {
      for (const w of [[1], [1, 1], [1, 1, 1], [100, 25], [3, 3, 3, 1], [0, 0], [0, 5, 0]]) {
        const a = allocateCents(total, w);
        expect(a.reduce((x, y) => x + y, 0)).toBe(total);
        expect(a.every((x) => x >= 0)).toBe(true);
      }
    }
  });
  it('splits proportionally and handles degenerate input', () => {
    expect(allocateCents(10, [8, 2])).toEqual([8, 2]);
    expect(allocateCents(10, [0, 0])).toEqual([10, 0]);
    expect(allocateCents(5, [])).toEqual([]);
  });
});

describe('contacts, items, accounts', () => {
  it('maps a Xero contact to canonical values', () => {
    const c = xeroToCanon('contact', {
      Name: ' Ann Customer ',
      EmailAddress: 'ann@example.com',
      Phones: [{ PhoneType: 'FAX', PhoneNumber: '1' }, { PhoneType: 'DEFAULT', PhoneCountryCode: '1', PhoneAreaCode: '555', PhoneNumber: '1234567' }],
      Addresses: [{ AddressType: 'POBOX', AddressLine1: 'PO Box 1' }, { AddressType: 'STREET', AddressLine1: '1 Main St', City: 'Austin', Region: 'TX', PostalCode: '78701' }],
    });
    expect(c).toEqual({ name: 'Ann Customer', email: 'ann@example.com', phone: '+1 555 1234567', address: '1 Main St, Austin, TX 78701' });
    expect(composeAddress(null)).toBeNull();
  });
  it('pushes only mapped, non-empty contact fields', () => {
    const p = canonToXero('contact', { name: 'Ann', email: null, phone: '555', address: '1 Main St' }, { defaults }, true);
    expect(p.Name).toBe('Ann');
    expect(p.EmailAddress).toBe('');
    expect(p.Phones).toEqual([{ PhoneType: 'DEFAULT', PhoneNumber: '555' }]);
    expect(p.Addresses).toEqual([{ AddressType: 'STREET', AddressLine1: '1 Main St' }]);
    expect(canonToXero('contact', { phone: null }, { defaults }, false).Phones).toBeUndefined();
  });
  it('truncates item names to 50 chars on both sides of the comparison', () => {
    const long = 'X'.repeat(80);
    expect(xeroToCanon('item', { Name: long, SalesDetails: { UnitPrice: 12.5 } })).toEqual({ name: 'X'.repeat(50), description: null, price: 12.5 });
    expect((canonToXero('item', { name: long }, { defaults }, false).Name as string).length).toBe(50);
  });
  it('item create sets the code, sale flags and default sales account; update keeps sibling SalesDetails', () => {
    const d = { ...defaults, salesAccountCode: '200' };
    const create = canonToXero('item', { name: 'Drain', price: 50 }, { defaults: d, itemCode: 'DRAIN-1' }, true);
    expect(create).toMatchObject({ Code: 'DRAIN-1', Name: 'Drain', IsSold: true, IsPurchased: false, SalesDetails: { UnitPrice: 50, AccountCode: '200' } });
    const update = canonToXero('item', { price: 60 }, { defaults: d, existing: { SalesDetails: { AccountCode: '260', TaxType: 'OUTPUT' } } }, false);
    expect(update.SalesDetails).toEqual({ AccountCode: '260', TaxType: 'OUTPUT', UnitPrice: 60 });
    expect(update.Code).toBeUndefined();
  });
  it('maps accounts both ways', () => {
    expect(xeroToCanon('account', { Code: '200', Name: 'Sales', Status: 'ARCHIVED' })).toEqual({ code: '200', name: 'Sales', active: 'inactive' });
    const p = canonToXero('account', { code: '4000-REVENUE-LONG', name: 'Revenue', active: 'active' }, { defaults, accountType: 'REVENUE' }, true);
    expect(p).toMatchObject({ Code: '4000-REVEN', Name: 'Revenue', Status: 'ACTIVE', Type: 'REVENUE' });
    expect((p.Code as string).length).toBeLessThanOrEqual(10);
    expect(suggestXeroAccountType('asset', '1000')).toBe('CURRENT');
    expect(suggestXeroAccountType('revenue', '4000')).toBe('REVENUE');
    expect(suggestXeroAccountType('expense', '5100')).toBe('DIRECTCOSTS');
    expect(generatedAccountCode(G1)).toBe('XR11111111');
  });
  it('filters what is syncable', () => {
    expect(isSyncableItem({ Code: 'A', IsSold: true, IsTrackedAsInventory: false })).toBe(true);
    expect(isSyncableItem({ Code: 'A', IsTrackedAsInventory: true })).toBe(false);
    expect(isSyncableItem({ Code: 'A', IsSold: false })).toBe(false);
    expect(isSyncableContact({ ContactStatus: 'ACTIVE', IsSupplier: true, IsCustomer: false })).toBe(false);
    expect(isSyncableContact({ ContactStatus: 'ACTIVE', IsSupplier: true, IsCustomer: true })).toBe(true);
    expect(isSyncableContact({ ContactStatus: 'ARCHIVED' })).toBe(false);
    expect(isSyncableContact({})).toBe(true);
    expect(isSyncableAccount({ Class: 'REVENUE', Status: 'ACTIVE' })).toBe(true);
    expect(isSyncableAccount({ Class: 'REVENUE', Status: 'DELETED' })).toBe(false);
    expect(isSyncableAccount({ Class: 'WHAT' })).toBe(false);
    expect(suggestItemCode('Drain cleaning!', G1)).toMatch(/^DRAIN-CLEANING-11111111$/);
    expect(suggestItemCode('???', G1)).toBe('VK-11111111');
  });
});

describe('invoices (base currency)', () => {
  it('parses an exclusive-tax invoice', () => {
    const r = parseXeroInvoice(invoice(), opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.doc;
    expect(d.subtotalCents).toBe(12500);
    expect(d.taxCents).toBe(1000);
    expect(d.totalCents).toBe(13500);
    expect(d.txnDate).toBe('2026-10-01');
    expect(d.dueDate).toBe('2026-10-31');
    expect(d.fx).toBeNull();
    expect(d.lines[0]).toMatchObject({ description: 'Drain cleaning', qty: 2, unitPriceCents: 5000, amountCents: 10000, itemCode: 'DRAIN' });
    expect(d.lines[1].accountCode).toBe('200');
  });
  it('parses a tax-inclusive invoice (net = gross - tax)', () => {
    const r = parseXeroInvoice(
      invoice({ LineAmountTypes: 'Inclusive', LineItems: [{ Description: 'Job', Quantity: 1, UnitAmount: 108, LineAmount: 108, TaxAmount: 8 }], Total: 108 }),
      opts,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.subtotalCents).toBe(10000);
      expect(r.doc.taxCents).toBe(800);
      expect(r.doc.lines[0].unitPriceCents).toBe(10000);
    }
  });
  it('parses a NoTax invoice and an in-line discount (LineAmount is already net)', () => {
    const r = parseXeroInvoice(
      invoice({ LineAmountTypes: 'NoTax', LineItems: [{ Description: 'Job', Quantity: 1, UnitAmount: 100, DiscountRate: 10, LineAmount: 90, TaxAmount: 5 }], Total: 90 }),
      opts,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.taxCents).toBe(0);
      expect(r.doc.lines[0].amountCents).toBe(9000);
      expect(r.doc.lines[0].unitPriceCents).toBe(9000);
    }
  });
  it('maps voided and deleted invoices to a voided doc with no lines', () => {
    for (const status of ['VOIDED', 'DELETED']) {
      const r = parseXeroInvoice(invoice({ Status: status, LineItems: [] }), opts);
      expect(r.ok && r.doc.voided).toBe(true);
    }
  });
  it('rejects what it cannot represent, with a reason', () => {
    const kind = (over: Record<string, unknown>) => {
      const r = parseXeroInvoice(invoice(over), opts);
      return r.ok ? 'ok' : r.kind;
    };
    expect(kind({ Type: 'ACCPAY' })).toBe('not_sales');
    expect(kind({ Status: 'DRAFT' })).toBe('draft');
    expect(kind({ Status: 'SUBMITTED' })).toBe('draft');
    expect(kind({ LineItems: [] })).toBe('unsupported');
    expect(kind({ Total: 999 })).toBe('unsupported');
    expect(kind({ LineItems: [{ Description: 'x', Quantity: 1, UnitAmount: -5, LineAmount: -5 }], Total: -5 })).toBe('unsupported');
    expect(kind({ InvoiceID: undefined })).toBe('unsupported');
  });
  it('amount signature ignores case and spacing but not money', () => {
    const a = invoiceAmountSig({ lines: [{ description: ' Drain  Cleaning ', qty: 2, amountCents: 100 }], taxCents: 8, totalCents: 108 });
    const b = invoiceAmountSig({ lines: [{ description: 'drain cleaning', qty: 2, amountCents: 100 }], taxCents: 8, totalCents: 108 });
    const c = invoiceAmountSig({ lines: [{ description: 'drain cleaning', qty: 2, amountCents: 101 }], taxCents: 8, totalCents: 109 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('invoices (multi-currency)', () => {
  const eur = (over: Record<string, unknown> = {}) =>
    invoice({
      CurrencyCode: 'EUR',
      CurrencyRate: 0.9,
      LineItems: [
        { Description: 'A', Quantity: 1, UnitAmount: 100, LineAmount: 100, TaxAmount: 20 },
        { Description: 'B', Quantity: 1, UnitAmount: 50, LineAmount: 50, TaxAmount: 10 },
      ],
      Total: 180,
      ...over,
    });

  it('converts at the Xero rate (units of foreign per 1 base) and keeps the original amounts', () => {
    const r = parseXeroInvoice(eur(), opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 180.00 EUR / 0.9 = 200.00 USD; tax 30 / 0.9 = 33.33; subtotal = 166.67
    expect(r.doc.totalCents).toBe(20000);
    expect(r.doc.taxCents).toBe(3333);
    expect(r.doc.subtotalCents).toBe(16667);
    expect(r.doc.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(r.doc.subtotalCents);
    expect(r.doc.subtotalCents + r.doc.taxCents).toBe(r.doc.totalCents);
    expect(r.doc.fx).toEqual({ currency: 'EUR', rate: 0.9, totalCents: 18000, subtotalCents: 15000, taxCents: 3000 });
  });
  it('is always balanced, whatever the rate', () => {
    for (const rate of [0.9, 1.0837, 0.0123, 145.1, 3.333333]) {
      const r = parseXeroInvoice(eur({ CurrencyRate: rate }), opts);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.doc.lines.reduce((s, l) => s + l.amountCents, 0) + r.doc.taxCents).toBe(r.doc.totalCents);
        expect(r.doc.lines.every((l) => l.amountCents >= 0)).toBe(true);
      }
    }
  });
  it('skips foreign invoices in skip mode and when the rate is missing', () => {
    const skip = parseXeroInvoice(eur(), { baseCurrency: 'USD', foreignCurrency: 'skip' });
    expect(!skip.ok && skip.kind).toBe('foreign');
    const noRate = parseXeroInvoice(eur({ CurrencyRate: undefined }), opts);
    expect(!noRate.ok && noRate.kind).toBe('foreign');
    const zero = parseXeroInvoice(eur({ CurrencyRate: 0 }), opts);
    expect(zero.ok).toBe(false);
  });
  it('treats an invoice in the base currency as plain even when CurrencyCode is present', () => {
    const r = parseXeroInvoice(invoice({ CurrencyCode: 'USD', CurrencyRate: 1 }), opts);
    expect(r.ok && r.doc.fx).toBeNull();
  });
  it('convertToBase handles zero-value lines', () => {
    const c = convertToBase([{ amountCents: 0, qty: 1 }, { amountCents: 100, qty: 1 }], 0, 100, 2);
    expect(c.amounts.reduce((a, b) => a + b, 0)).toBe(50);
  });
  it('compares base currencies', () => {
    expect(checkBaseCurrency('usd', 'USD').ok).toBe(true);
    const bad = checkBaseCurrency('AUD', 'USD');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toContain('AUD');
    expect(checkBaseCurrency(null, 'USD').ok).toBe(false);
    expect(checkBaseCurrency('USD', undefined).ok).toBe(true);
  });
});

describe('outbound invoices', () => {
  const lines: InvoiceLine[] = [
    { description: 'Drain cleaning', qty: 2, unitPriceCents: 5000, amountCents: 10000, itemCode: null, accountCode: null },
    { description: 'Trip charge', qty: 1, unitPriceCents: 2500, amountCents: 2500, itemCode: null, accountCode: null },
  ];
  const inv = { invoiceNumber: 'INV-7', issueDate: '2026-10-01', dueDate: '2026-10-31', taxCents: 1001, lines };

  it('resolves items by name, then fallback item, then sales account, else explains', () => {
    const map = new Map([['drain cleaning', 'DRAIN']]);
    const r = resolveLineItems(lines, map, { fallbackItemCode: null, salesAccountCode: '200' });
    expect(r.ok && r.lines[0]).toMatchObject({ itemCode: 'DRAIN', accountCode: null });
    expect(r.ok && r.lines[1]).toMatchObject({ itemCode: null, accountCode: '200' });
    const fb = resolveLineItems(lines, map, { fallbackItemCode: 'MISC', salesAccountCode: '200' });
    expect(fb.ok && fb.lines[1].itemCode).toBe('MISC');
    const none = resolveLineItems(lines, map, { fallbackItemCode: null, salesAccountCode: null });
    expect(none.ok).toBe(false);
    expect(!none.ok && none.reason).toContain('Trip charge');
  });
  it('requires a tax rate only when the invoice has tax', () => {
    expect(planTaxType(1000, { taxType: null, zeroTaxType: null }).ok).toBe(false);
    expect(planTaxType(1000, { taxType: 'OUTPUT', zeroTaxType: null })).toEqual({ ok: true, taxType: 'OUTPUT' });
    expect(planTaxType(0, { taxType: 'OUTPUT', zeroTaxType: null })).toEqual({ ok: true, taxType: 'NONE' });
    expect(planTaxType(0, { taxType: 'OUTPUT', zeroTaxType: 'EXEMPTOUTPUT' })).toEqual({ ok: true, taxType: 'EXEMPTOUTPUT' });
  });
  it('builds an approved Exclusive invoice whose per-line tax sums to the Vireek tax exactly', () => {
    const resolved = resolveLineItems(lines, new Map(), { fallbackItemCode: null, salesAccountCode: '200' });
    if (!resolved.ok) throw new Error('unreachable');
    const p = buildXeroInvoicePayload({ ...inv, lines: resolved.lines }, G2, { defaults, taxType: 'OUTPUT' });
    expect(p).toMatchObject({ Type: 'ACCREC', Status: 'AUTHORISED', LineAmountTypes: 'Exclusive', InvoiceNumber: 'INV-7', Date: '2026-10-01', DueDate: '2026-10-31' });
    expect(p.Contact).toEqual({ ContactID: G2 });
    const li = p.LineItems as { TaxAmount: number; AccountCode?: string; ItemCode?: string; Quantity: number; UnitAmount: number }[];
    expect(Math.round(li.reduce((s, l) => s + l.TaxAmount * 100, 0))).toBe(1001);
    expect(li[0]).toMatchObject({ Quantity: 2, UnitAmount: 50, AccountCode: '200' });
    expect(li[0].ItemCode).toBeUndefined();
  });
  it('falls back to quantity 1 when qty x unit does not equal the amount, and omits the number on update', () => {
    const odd: InvoiceLine[] = [{ description: 'Odd', qty: 3, unitPriceCents: 333, amountCents: 1000, itemCode: 'X', accountCode: null }];
    const p = buildXeroInvoicePayload({ ...inv, taxCents: 0, lines: odd }, G2, { defaults, taxType: 'NONE' }, { id: G1 });
    const li = (p.LineItems as { Quantity: number; UnitAmount: number }[])[0];
    expect(li).toMatchObject({ Quantity: 1, UnitAmount: 10 });
    expect(p.InvoiceNumber).toBeUndefined();
    expect(p.InvoiceID).toBe(G1);
    const noNum = buildXeroInvoicePayload({ ...inv, lines: odd }, G2, { defaults: { ...defaults, sendInvoiceNumber: false }, taxType: 'NONE' });
    expect(noNum.InvoiceNumber).toBeUndefined();
  });
});

describe('payments', () => {
  const pay = (over: Record<string, unknown> = {}) => ({
    PaymentID: G3,
    PaymentType: 'ACCRECPAYMENT',
    Status: 'AUTHORISED',
    DateString: '2026-10-05T00:00:00',
    Amount: 50,
    Reference: 'Stripe payout',
    Account: { AccountID: G2, Code: '090', Name: 'Business Bank' },
    Invoice: { InvoiceID: G1, InvoiceNumber: 'INV-0001', Type: 'ACCREC' },
    UpdatedDateUTC: '/Date(1790000000000+0000)/',
    ...over,
  });
  it('parses a customer payment', () => {
    const r = parseXeroPayment(pay());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc).toMatchObject({ id: G3, invoiceId: G1, amountCents: 5000, date: '2026-10-05', accountId: G2, deleted: false, reference: 'Stripe payout' });
  });
  it('skips everything that is not a positive customer payment on an invoice', () => {
    expect(parseXeroPayment(pay({ PaymentType: 'ACCPAYPAYMENT' })).ok).toBe(false);
    expect(parseXeroPayment(pay({ PaymentType: 'AROVERPAYMENTPAYMENT' })).ok).toBe(false);
    expect(parseXeroPayment(pay({ Invoice: {} })).ok).toBe(false);
    expect(parseXeroPayment(pay({ Amount: 0 })).ok).toBe(false);
    expect(parseXeroPayment(pay({ Invoice: { InvoiceID: G1, Type: 'ACCPAY' } })).ok).toBe(false);
    const del = parseXeroPayment(pay({ Status: 'DELETED' }));
    expect(del.ok && del.doc.deleted).toBe(true);
  });
  it('guesses the payment method from text', () => {
    expect(paymentMethodFromText('Stripe payout')).toBe('card');
    expect(paymentMethodFromText('Cheque 1001')).toBe('check');
    expect(paymentMethodFromText('Petty cash')).toBe('cash');
    expect(paymentMethodFromText('Business Bank EFT')).toBe('ach');
    expect(paymentMethodFromText('')).toBe('other');
    expect(paymentMethodFromText('misc')).toBe('other');
  });
  it('base-currency payments apply exactly and never exceed the balance', () => {
    expect(paymentBaseCents({ amountCents: 5000, fx: null, invoiceBaseTotalCents: 13500, remainingBaseCents: 13500 })).toEqual({ ok: true, cents: 5000, note: null });
    expect(paymentBaseCents({ amountCents: 5000, fx: null, invoiceBaseTotalCents: 13500, remainingBaseCents: 4000 }).ok).toBe(false);
  });
  it('foreign payments are valued at the invoice rate; dust settles the balance; overpayment is refused', () => {
    const fx = { currency: 'EUR', rate: 0.9, totalCents: 18000, subtotalCents: 15000, taxCents: 3000 };
    const half = paymentBaseCents({ amountCents: 9000, fx, invoiceBaseTotalCents: 20000, remainingBaseCents: 20000 });
    expect(half.ok && half.cents).toBe(10000);
    expect(half.ok && half.note).toContain('Realised FX');
    const final = paymentBaseCents({ amountCents: 9000, fx, invoiceBaseTotalCents: 20000, remainingBaseCents: 10001 });
    expect(final.ok && final.cents).toBe(10001); // 1 cent of rounding dust is settled
    const over = paymentBaseCents({ amountCents: 9000, fx, invoiceBaseTotalCents: 20000, remainingBaseCents: 10000 - FX_DUST_CENTS - 5 });
    expect(over.ok).toBe(false);
    expect(paymentBaseCents({ amountCents: 1, fx: { ...fx, totalCents: 0 }, invoiceBaseTotalCents: 1, remainingBaseCents: 1 }).ok).toBe(false);
  });
  it('builds a payment body', () => {
    expect(buildXeroPaymentPayload({ invoiceId: G1, accountId: G2, amountCents: 5050, date: '2026-10-05', reference: 'Vireek payment' })).toEqual({
      Invoice: { InvoiceID: G1 },
      Account: { AccountID: G2 },
      Date: '2026-10-05',
      Amount: 50.5,
      Reference: 'Vireek payment',
    });
  });
});

describe('tax rates, organisation, currencies', () => {
  const rate = { Name: 'GST on Income', TaxType: 'OUTPUT', Status: 'ACTIVE', ReportTaxType: 'OUTPUT', CanApplyToRevenue: true, EffectiveRate: 10, TaxComponents: [{ Name: 'GST', Rate: 10, IsCompound: false, IsNonRecoverable: false }] };
  it('parses a tax rate and drops malformed ones', () => {
    expect(parseTaxRate(rate)).toMatchObject({ taxType: 'OUTPUT', name: 'GST on Income', effectiveRate: 10, status: 'ACTIVE', canApplyToRevenue: true });
    expect(parseTaxRate({ Name: 'x' })).toBeNull();
    expect(parseTaxRate({ Name: 'x', TaxType: "BAD'TYPE" })).toBeNull();
    expect(parseTaxRate({ Name: 'Sum', TaxType: 'SUM', TaxComponents: [{ Rate: 5 }, { Rate: 2.5 }] })?.effectiveRate).toBe(7.5);
  });
  it('lists only active revenue rates, sorted, and warns about a rate mismatch', () => {
    const all = [rate, { ...rate, TaxType: 'OLD', Name: 'Old', Status: 'ARCHIVED' }, { ...rate, TaxType: 'EXP', Name: 'Expense only', CanApplyToRevenue: false }, { ...rate, TaxType: 'A', Name: 'A rate' }]
      .map(parseTaxRate)
      .filter((r): r is NonNullable<typeof r> => !!r);
    expect(selectableSalesTaxRates(all).map((r) => r.taxType)).toEqual(['A', 'OUTPUT']);
    expect(taxRateMismatch(all[0], 10)).toBeNull();
    expect(taxRateMismatch(all[0], 8.25)).toContain('8.25%');
    expect(taxRateMismatch(undefined, 8)).toBeNull();
    expect(taxRateMismatch(all[0], 0)).toBeNull();
  });
  it('parses the organisation and currency list', () => {
    expect(parseOrganisation({ Organisations: [{ Name: 'Acme Plumbing', LegalName: 'Acme LLC', BaseCurrency: 'usd', CountryCode: 'US', IsDemoCompany: true, ShortCode: '!abc12' }] })).toEqual({
      name: 'Acme Plumbing', legalName: 'Acme LLC', baseCurrency: 'USD', countryCode: 'US', isDemo: true, shortCode: '!abc12',
    });
    expect(parseOrganisation({ Organisations: [] })).toBeNull();
    expect(parseOrganisation({ Organisations: [{ Name: 'x', BaseCurrency: 'DOLLARS' }] })).toBeNull();
    expect(parseCurrencies({ Currencies: [{ Code: 'usd', Description: 'US Dollar' }, { Code: 'bd' }] })).toEqual([{ code: 'USD', description: 'US Dollar' }]);
  });
});

describe('requests', () => {
  it('builds list requests per entity (paged / unpaged, filters, If-Modified-Since)', () => {
    const inv = buildListRequest({ entity: 'invoice', page: 2, pageSize: 100, modifiedSinceMs: Date.parse('2026-10-01T10:00:00Z') });
    const u = new URL(inv.url);
    expect(u.origin + u.pathname).toBe('https://api.xero.com/api.xro/2.0/Invoices');
    expect(u.searchParams.get('page')).toBe('2');
    expect(u.searchParams.get('pageSize')).toBe('100');
    expect(u.searchParams.get('where')).toBe('Type=="ACCREC"');
    expect(u.searchParams.get('Statuses')).toBe('AUTHORISED,PAID,VOIDED,DELETED');
    expect(u.searchParams.get('order')).toBe('UpdatedDateUTC ASC');
    expect(inv.headers).toEqual({ 'If-Modified-Since': '2026-10-01T10:00:00' });
    const pay = buildListRequest({ entity: 'payment', page: 1, pageSize: 100, modifiedSinceMs: null });
    expect(new URL(pay.url).searchParams.get('where')).toBe('PaymentType=="ACCRECPAYMENT"');
    expect(pay.headers).toBeUndefined();
    expect(buildListRequest({ entity: 'account', page: 1, pageSize: 100, modifiedSinceMs: null }).url).toBe('https://api.xero.com/api.xro/2.0/Accounts');
    expect(buildListRequest({ entity: 'item', page: 5, pageSize: 100, modifiedSinceMs: null }).url).toBe('https://api.xero.com/api.xro/2.0/Items');
    expect(new URL(buildListRequest({ entity: 'contact', page: 0, pageSize: 99999, modifiedSinceMs: null }).url).searchParams.get('pageSize')).toBe('1000');
  });
  it('only GETs by valid ids and never interpolates raw input', () => {
    expect(buildGetRequest({ entity: 'contact', id: G1 }).url).toBe(`https://api.xero.com/api.xro/2.0/Contacts/${G1}`);
    expect(() => buildGetRequest({ entity: 'contact', id: '../Organisation' })).toThrow();
    expect(() => buildGetRequest({ entity: 'invoice', id: `${G1}?x=1` })).toThrow();
  });
  it('encodes find requests (quotes, ampersands, unicode) and refuses unsupported lookups', () => {
    const c = new URL(buildFindContactRequest(`O'Brien & "Sons" ✓`).url);
    expect(c.searchParams.get('searchTerm')).toBe(`O'Brien & "Sons" ✓`);
    expect(c.searchParams.getAll('where')).toEqual([]);
    const i = new URL(buildFindInvoiceRequest('INV-1&x=2').url);
    expect(i.searchParams.get('InvoiceNumbers')).toBe('INV-1&x=2');
    expect(i.searchParams.get('x')).toBeNull();
    expect(() => buildFindInvoiceRequest('A,B')).toThrow();
    expect(buildItemByCodeRequest('DRAIN 1').url).toBe('https://api.xero.com/api.xro/2.0/Items/DRAIN%201');
    expect(() => buildItemByCodeRequest('a"b')).toThrow();
  });
  it('creates with PUT + Idempotency-Key and updates with POST to the id', () => {
    const key = idempotencyKey('c', G1, { Name: 'Ann' });
    const create = buildWriteRequest({ entity: 'contact', payload: { Name: 'Ann' }, idempotencyKey: key });
    expect(create.method).toBe('PUT');
    expect(create.url).toBe('https://api.xero.com/api.xro/2.0/Contacts');
    expect(create.headers?.['Idempotency-Key']).toBe(key);
    expect(create.body).toEqual({ Contacts: [{ Name: 'Ann' }] });
    const update = buildWriteRequest({ entity: 'invoice', id: G1, payload: { DueDate: '2026-11-01' } });
    expect(update.method).toBe('POST');
    expect(update.url).toBe(`https://api.xero.com/api.xro/2.0/Invoices/${G1}`);
    expect(update.body).toEqual({ Invoices: [{ DueDate: '2026-11-01', InvoiceID: G1 }] });
    expect(buildWriteRequest({ entity: 'contact', payload: {}, idempotencyKey: 'bad key!' }).headers).toEqual({});
    expect(() => buildWriteRequest({ entity: 'contact', id: 'x', payload: {} })).toThrow();
    expect(buildVoidRequest({ id: G1 }).body).toEqual({ Invoices: [{ Status: 'VOIDED', InvoiceID: G1 }] });
  });
  it('idempotency keys are stable per payload, change with it, and stay URL-safe and short', () => {
    const a = idempotencyKey('i', G1, { a: 1 });
    expect(a).toBe(idempotencyKey('i', G1, { a: 1 }));
    expect(a).not.toBe(idempotencyKey('i', G1, { a: 2 }));
    expect(a).not.toBe(idempotencyKey('i', G2, { a: 1 }));
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(idempotencyKey('i', 'x'.repeat(500), {}).length).toBeLessThanOrEqual(128);
    expect(shortHash('abc')).toHaveLength(8);
  });
  it('only lets tokens reach Xero hosts', () => {
    expect(isAllowedXeroUrl('https://api.xero.com/api.xro/2.0/Invoices')).toBe(true);
    expect(isAllowedXeroUrl('https://api.xero.com/connections')).toBe(true);
    expect(isAllowedXeroUrl(`https://api.xero.com/connections/${G1}`)).toBe(true);
    expect(isAllowedXeroUrl('https://api.xero.com.evil.test/api.xro/2.0/Invoices')).toBe(false);
    expect(isAllowedXeroUrl('https://evil.test/https://api.xero.com/api.xro/2.0/')).toBe(false);
  });
});

describe('responses and retry policy', () => {
  it('classifies success, validation, duplicate, auth, forbidden, throttle and not-found', () => {
    expect(classifyResponse(200, { Invoices: [] }).kind).toBe('ok');
    const v = classifyResponse(400, { ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred', Elements: [{ ValidationErrors: [{ Message: 'Account code is not valid' }] }] });
    expect(v.kind).toBe('validation');
    expect(v.fault?.detail).toContain('Account code');
    const dup = classifyResponse(400, { Type: 'ValidationException', Elements: [{ ValidationErrors: [{ Message: 'Contact name must be unique' }] }] });
    expect(dup.kind).toBe('duplicate');
    expect(classifyResponse(401, { Title: 'Unauthorized', Detail: 'TokenExpired' }).kind).toBe('auth');
    expect(classifyResponse(403, { Detail: 'AuthenticationUnsuccessful' }).kind).toBe('auth');
    expect(classifyResponse(403, { Detail: 'Insufficient permissions' }).kind).toBe('forbidden');
    expect(classifyResponse(429, null).kind).toBe('throttle');
    expect(classifyResponse(404, null).kind).toBe('notfound');
    expect(classifyResponse(500, null).kind).toBe('error');
    expect(classifyResponse(200, { Type: 'ValidationException' }).kind).toBe('validation');
  });
  it('parses list and entity envelopes', () => {
    expect(parseListResponse('invoice', { Invoices: new Array(100).fill({ InvoiceID: G1 }) }, 100).more).toBe(true);
    expect(parseListResponse('invoice', { Invoices: [{ InvoiceID: G1 }] }, 100).more).toBe(false);
    expect(parseListResponse('account', { Accounts: new Array(100).fill({}) }, 100).more).toBe(false); // unpaged
    expect(parseListResponse('contact', null, 100).records).toEqual([]);
    expect(parseEntityResponse('contact', { Contacts: [{ ContactID: G1 }] })?.ContactID).toBe(G1);
    expect(parseEntityResponse('contact', { Contacts: [{}] })).toBeNull();
  });
  it('retries transient failures with backoff, honours Retry-After up to a cap, and gives up cleanly', () => {
    expect(retryDelayMs({ status: null, attempt: 0, retryAfterSec: null })).toBe(800);
    expect(retryDelayMs({ status: 503, attempt: 1, retryAfterSec: null })).toBe(1600);
    expect(retryDelayMs({ status: 429, attempt: 0, retryAfterSec: 7 })).toBe(7000);
    expect(retryDelayMs({ status: 429, attempt: 0, retryAfterSec: 600 })).toBeNull();
    expect(retryDelayMs({ status: 429, attempt: 0, retryAfterSec: null })).toBe(5000);
    expect(retryDelayMs({ status: 400, attempt: 0, retryAfterSec: null })).toBeNull();
    expect(retryDelayMs({ status: 503, attempt: 2, retryAfterSec: null })).toBeNull();
    expect(parseRetryAfter('12')).toBe(12);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('oauth', () => {
  it('builds the authorize URL with granular scopes and the redirect', () => {
    const u = new URL(buildAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://x.supabase.co/functions/v1/xero-oauth-callback', state: 's.t' }));
    expect(u.origin + u.pathname).toBe('https://login.xero.com/identity/connect/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    const scopes = (u.searchParams.get('scope') ?? '').split(' ');
    for (const s of ['offline_access', 'accounting.contacts', 'accounting.settings', 'accounting.invoices', 'accounting.payments']) expect(scopes).toContain(s);
    expect(scopes).not.toContain('accounting.transactions');
    expect(u.searchParams.get('state')).toBe('s.t');
  });
  it('builds token / refresh / revoke requests with Basic auth', () => {
    const t = buildTokenRequest('code', { clientId: 'cid', clientSecret: 'sec', code: 'abc', redirectUri: 'https://r' });
    expect(t.url).toBe('https://identity.xero.com/connect/token');
    expect(t.headers.Authorization).toBe(`Basic ${btoa('cid:sec')}`);
    expect(new URLSearchParams(t.body).get('grant_type')).toBe('authorization_code');
    const r = buildTokenRequest('refresh', { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });
    expect(new URLSearchParams(r.body).get('refresh_token')).toBe('rt');
    const v = buildRevokeRequest({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });
    expect(v.url).toBe('https://identity.xero.com/connect/revocation');
    expect(new URLSearchParams(v.body).get('token')).toBe('rt');
  });
  it('parses token responses and refuses ones without an access token', () => {
    expect(parseTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 1800, scope: 'offline_access accounting.contacts' })).toEqual({
      accessToken: 'a', refreshToken: 'r', expiresInSec: 1800, scope: ['offline_access', 'accounting.contacts'],
    });
    expect(() => parseTokenResponse({})).toThrow();
  });
  it('signs and verifies state, rejecting tampering, wrong secrets, expiry and the future', async () => {
    const now = 1_000_000_000_000;
    const state = await signOAuthState({ owner: 'o1', user: 'u1' }, 'secret', now);
    expect(await verifyOAuthState(state, 'secret', now + 1000)).toMatchObject({ o: 'o1', u: 'u1' });
    expect(await verifyOAuthState(state, 'other', now)).toBeNull();
    expect(await verifyOAuthState(`${state}x`, 'secret', now)).toBeNull();
    expect(await verifyOAuthState(state, 'secret', now + 11 * 60_000)).toBeNull();
    expect(await verifyOAuthState(state, 'secret', now - 120_000)).toBeNull();
    expect(await verifyOAuthState('garbage', 'secret', now)).toBeNull();
  });
  it('reads JWT claims safely', () => {
    const body = btoa(JSON.stringify({ authentication_event_id: G3 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(jwtClaims(`h.${body}.s`).authentication_event_id).toBe(G3);
    expect(jwtClaims('not-a-jwt')).toEqual({});
    expect(jwtClaims('a.%%%.c')).toEqual({});
  });
  it('picks exactly one organisation from this consent', () => {
    const conns = parseConnections([
      { id: G1, tenantId: G2, tenantType: 'ORGANISATION', tenantName: 'Acme', authEventId: G3 },
      { id: G2, tenantId: G3, tenantType: 'ORGANISATION', tenantName: 'Other', authEventId: 'older' },
      { id: G3, tenantId: G1, tenantType: 'PRACTICEMANAGER', authEventId: G3 },
      { id: 'bad', tenantId: 'bad', tenantType: 'ORGANISATION' },
    ]);
    expect(conns).toHaveLength(2);
    const one = pickConnection(conns, G3);
    expect(one.ok && one.connection.tenantName).toBe('Acme');
    const many = pickConnection(
      parseConnections([
        { id: G1, tenantId: G2, tenantType: 'ORGANISATION', authEventId: G3 },
        { id: G2, tenantId: G3, tenantType: 'ORGANISATION', authEventId: G3 },
      ]),
      G3,
    );
    expect(!many.ok && many.reason).toBe('multiple');
    expect(!many.ok && many.extras).toHaveLength(2);
    expect(!pickConnection([], G3).ok).toBe(true);
    const noEvent = pickConnection(conns.slice(0, 1), null);
    expect(noEvent.ok).toBe(true);
  });
  it('verifies webhook signatures in constant time and extracts tenants', async () => {
    const body = JSON.stringify({ events: [{ tenantId: G1, tenantType: 'ORGANISATION', eventCategory: 'INVOICE' }, { tenantId: G1, tenantType: 'ORGANISATION' }, { tenantId: G2, tenantType: 'ORGANISATION' }, { tenantId: 'bad' }], firstEventSequence: 1, lastEventSequence: 4 });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('whkey'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))));
    expect(await verifyWebhookSignature(body, sig, 'whkey')).toBe(true);
    expect(await verifyWebhookSignature(body + ' ', sig, 'whkey')).toBe(false);
    expect(await verifyWebhookSignature(body, sig, 'wrong')).toBe(false);
    expect(await verifyWebhookSignature(body, null, 'whkey')).toBe(false);
    expect(await verifyWebhookSignature(body, sig, '')).toBe(false);
    expect(webhookTenants(JSON.parse(body))).toEqual([G1, G2]);
    expect(webhookTenants({ events: [] })).toEqual([]); // "intent to receive" probe
    expect(webhookTenants(null)).toEqual([]);
  });
  it('encrypts and decrypts tokens (AES-GCM)', async () => {
    const enc = await encryptSecret('refresh-token-123', KEY);
    expect(enc).not.toContain('refresh-token-123');
    expect(await decryptSecret(enc, KEY)).toBe('refresh-token-123');
    await expect(decryptSecret(enc, btoa(String.fromCharCode(...new Uint8Array(32).fill(9))))).rejects.toThrow();
  });
});
