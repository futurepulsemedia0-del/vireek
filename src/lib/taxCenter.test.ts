import { describe, it, expect } from 'vitest';
import {
  allocate,
  buildTaxReport,
  computeInvoiceTax,
  effectiveRate,
  extractPostalCode,
  extractState,
  filingCsv,
  filingPeriod,
  findExemption,
  matchJurisdictions,
  parsePostalList,
  type ReportInvoiceRow,
  type TaxClass,
  type TaxContext,
  type TaxExemption,
  type TaxJurisdiction,
} from './taxCenter';

const J = (over: Partial<TaxJurisdiction> & { id: string; name: string; rate_percent: number }): TaxJurisdiction => ({
  level: 'state', state: 'TX', postal_codes: [], effective_from: null, effective_to: null, source: 'manual', active: true, ...over,
});

const texas = J({ id: 'tx', name: 'Texas', rate_percent: 6.25 });
const austin = J({ id: 'atx', name: 'Austin', level: 'city', rate_percent: 1, postal_codes: ['787*'] });
const transit = J({ id: 'cap', name: 'Capital Metro', level: 'district', rate_percent: 1, postal_codes: ['78701', '78702'] });
const JURS = [texas, austin, transit];

const labor: TaxClass = { id: 'labor', name: 'Labor', treatment: 'exempt', reduced_percent: 100, description: null };
const half: TaxClass = { id: 'half', name: 'Half', treatment: 'reduced', reduced_percent: 50, description: null };
const exemption: TaxExemption = {
  id: 'ex1', customer_id: 'c1', customer_name: 'Acme', reason: 'resale', certificate_number: 'R-1', states: ['TX'],
  issued_on: null, expires_on: '2026-12-31', status: 'active', notes: null,
};

const ctx = (over: Partial<TaxContext> = {}): TaxContext => ({
  jurisdictions: JURS, classes: [labor, half], exemptions: [], serviceClassByName: new Map(), defaultClassId: null, ...over,
});

const inv = (over: Partial<ReportInvoiceRow> = {}): ReportInvoiceRow => ({
  id: 'i1', invoice_number: 'INV-0001', customer_name: 'Jane', status: 'sent',
  line_items: [{ description: 'Drain cleaning', quantity: 1, unit_price_cents: 10000 }],
  tax_percent: 8.25, billed_at: '2026-05-10T12:00:00Z', customer_id: null, address: '1 Main St, Austin, TX 78701', ...over,
});

describe('address parsing', () => {
  it('extracts the trailing ZIP and the state', () => {
    expect(extractPostalCode('12345 Oak Rd, Austin, TX 78701-1234')).toBe('78701');
    expect(extractState('12345 Oak Rd, Austin, TX 78701')).toBe('TX');
    expect(extractPostalCode(null)).toBeNull();
    expect(extractState('no state here')).toBeNull();
  });
  it('parses postal lists and reports invalid entries', () => {
    expect(parsePostalList('78701, 787* 78701 abc 1234567')).toEqual({ codes: ['78701', '787*'], invalid: ['abc', '1234567'] });
  });
});

describe('jurisdiction matching', () => {
  it('stacks state + city + district for a matching ZIP', () => {
    const m = matchJurisdictions('1 Main, Austin, TX 78701', JURS, '2026-05-10');
    expect(m.jurisdictions.map((j) => j.id)).toEqual(['tx', 'atx', 'cap']);
    expect(m.combinedRate).toBe(8.25);
  });
  it('only applies state rate when no local ZIP matches', () => {
    expect(matchJurisdictions('1 Main, Dallas, TX 75001', JURS, '2026-05-10').combinedRate).toBe(6.25);
  });
  it('respects effective windows and inactive rows', () => {
    const old = J({ id: 'old', name: 'Old', rate_percent: 5, effective_to: '2026-01-01' });
    expect(matchJurisdictions('x, TX 75001', [old, J({ id: 'off', name: 'Off', rate_percent: 3, active: false })], '2026-05-10').jurisdictions).toHaveLength(0);
  });
  it('matches nothing for an address with no state or ZIP', () => {
    expect(matchJurisdictions('somewhere', JURS, '2026-05-10').jurisdictions).toHaveLength(0);
  });
});

describe('class + exemption', () => {
  it('computes effective rate per treatment', () => {
    expect(effectiveRate(8, null)).toBe(8);
    expect(effectiveRate(8, labor)).toBe(0);
    expect(effectiveRate(8, half)).toBe(4);
  });
  it('honours certificate state, expiry, revocation', () => {
    expect(findExemption([exemption], 'c1', 'Acme', 'TX', '2026-05-10')).not.toBeNull();
    expect(findExemption([exemption], 'c1', 'Acme', 'CA', '2026-05-10')).toBeNull();
    expect(findExemption([exemption], 'c1', 'Acme', 'TX', '2027-01-01')).toBeNull();
    expect(findExemption([{ ...exemption, status: 'revoked' }], 'c1', 'Acme', 'TX', '2026-05-10')).toBeNull();
  });
});

describe('allocate', () => {
  it('always sums to the total', () => {
    const parts = allocate(100, [6.25, 1, 1]);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(100);
    expect(allocate(5, [])).toEqual([]);
    expect(allocate(0, [1, 2])).toEqual([0, 0]);
  });
});

describe('computeInvoiceTax', () => {
  it('charges the full stack and finds no variance when collected correctly', () => {
    const r = computeInvoiceTax(inv(), ctx());
    expect(r.expectedTaxCents).toBe(825);
    expect(r.collectedTaxCents).toBe(825);
    expect(r.varianceCents).toBe(0);
    expect(r.flags).toEqual([]);
    expect(r.shares.reduce((s, x) => s + x.expectedCents, 0)).toBe(825);
  });
  it('flags under-collection', () => {
    const r = computeInvoiceTax(inv({ tax_percent: 6.25 }), ctx());
    expect(r.varianceCents).toBe(-200);
    expect(r.flags).toContain('under_collected');
  });
  it('treats exempt-class lines as non-taxable', () => {
    const c = ctx({ serviceClassByName: new Map([['drain cleaning', 'labor']]) });
    const r = computeInvoiceTax(inv({ tax_percent: 0 }), c);
    expect(r.taxableCents).toBe(0);
    expect(r.exemptCents).toBe(10000);
    expect(r.expectedTaxCents).toBe(0);
  });
  it('uses the default class for unmapped services', () => {
    const r = computeInvoiceTax(inv(), ctx({ defaultClassId: 'half' }));
    expect(r.expectedTaxCents).toBe(413); // 4.125% of $100, half-up
  });
  it('zeroes tax for exempt customers and flags tax charged anyway', () => {
    const r = computeInvoiceTax(inv({ customer_id: 'c1', customer_name: 'Acme' }), ctx({ exemptions: [exemption] }));
    expect(r.expectedTaxCents).toBe(0);
    expect(r.flags).toEqual(expect.arrayContaining(['exempt_customer', 'tax_on_exempt']));
  });
  it('flags missing address / unmatched jurisdiction without throwing', () => {
    expect(computeInvoiceTax(inv({ address: null }), ctx()).flags).toContain('no_address');
    expect(computeInvoiceTax(inv({ address: '1 St, Reno, NV 89501' }), ctx()).flags).toContain('no_jurisdiction');
    expect(computeInvoiceTax(inv({ line_items: null }), ctx()).subtotalCents).toBe(0);
  });
});

describe('buildTaxReport + csv + periods', () => {
  const report = buildTaxReport(
    [inv(), inv({ id: 'i2', invoice_number: 'INV-0002', address: '9 Elm, Dallas, TX 75001', tax_percent: 6.25 }), inv({ id: 'i3', invoice_number: 'INV-0003', address: null })],
    ctx(), '2026-04-01', '2026-06-30',
  );
  it('groups sales and tax by jurisdiction', () => {
    const tx = report.lines.find((l) => l.jurisdictionId === 'tx')!;
    expect(tx.invoiceCount).toBe(2);
    expect(tx.grossSalesCents).toBe(20000);
    expect(tx.taxDueCents + report.lines.filter((l) => l.jurisdictionId !== 'tx').reduce((s, l) => s + l.taxDueCents, 0)).toBe(report.totals.expectedTaxCents);
    expect(report.unmatchedCount).toBe(1);
    expect(report.unmatchedSalesCents).toBe(10000);
  });
  it('exports a CSV with a totals row and neutralises formulas', () => {
    const csv = filingCsv(report);
    expect(csv).toContain('TOTAL');
    const evil = buildTaxReport([inv({ customer_name: '=HYPERLINK("x")' })], ctx(), '2026-04-01', '2026-06-30');
    expect(filingCsv({ ...evil, lines: [{ ...evil.lines[0], name: '=cmd' }] })).toContain("'=cmd");
  });
  it('computes filing periods', () => {
    const now = new Date('2026-05-15T00:00:00Z');
    expect(filingPeriod('quarterly', now)).toMatchObject({ from: '2026-04-01', to: '2026-06-30', label: 'Q2 2026' });
    expect(filingPeriod('quarterly', new Date('2026-02-01T00:00:00Z'), true)).toMatchObject({ from: '2025-10-01', to: '2025-12-31' });
    expect(filingPeriod('monthly', now)).toMatchObject({ from: '2026-05-01', to: '2026-05-31' });
    expect(filingPeriod('annually', now, true)).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
  });
});
