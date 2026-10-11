import { describe, it, expect } from 'vitest';
import {
  buildTaxReportCsv,
  calculateSalesTax,
  evaluateExemption,
  getDocumentTotals,
  isAddressComplete,
  normalizeState,
  normalizeZip,
  parseTaxRatesCsv,
  parseUsAddress,
  selectionFromDocument,
  taxColumnsFromSelection,
  taxOnBase,
  emptyTaxSelection,
  type TaxClass,
  type TaxExemption,
  type TaxRateComponent,
  type TaxSelection,
} from './salesTax';

const ON = '2027-04-15';

const austin: TaxRateComponent[] = [
  { level: 'state', name: 'Texas state sales tax', ratePercent: 6.25, isAccountRate: false },
  { level: 'city', name: 'Austin', ratePercent: 1, isAccountRate: true },
  { level: 'district', name: 'Capital Metro', ratePercent: 1, isAccountRate: true },
];
const address = { city: 'Austin', state: 'TX', postal_code: '78701' };

const classes: TaxClass[] = [
  { id: 'c1', code: 'general', name: 'General', defaultTaxable: true, stateRules: {} },
  { id: 'c2', code: 'materials', name: 'Parts & materials', defaultTaxable: true, stateRules: {} },
  { id: 'c3', code: 'labor', name: 'Service labor', defaultTaxable: false, stateRules: { WA: true } },
];

function cert(over: Partial<TaxExemption> = {}): TaxExemption {
  return {
    id: 'e1',
    customerId: 'cust',
    exemptionType: 'resale',
    certificateNumber: 'R-123',
    appliesToStates: [],
    appliesToClasses: [],
    issuedOn: '2026-01-01',
    expiresOn: '2028-01-01',
    status: 'verified',
    ...over,
  };
}

const base = { address, rates: austin, classes, exemptions: [] as TaxExemption[], onDate: ON };

describe('normalization & address parsing', () => {
  it('normalizes states and ZIPs', () => {
    expect(normalizeState(' tx ')).toBe('TX');
    expect(normalizeState('Texas')).toBe('TX');
    expect(normalizeState('ZZ')).toBe('');
    expect(normalizeZip('78701-1234')).toBe('78701');
    expect(normalizeZip('787')).toBe('');
  });

  it('requires state and ZIP for a complete address', () => {
    expect(isAddressComplete(address)).toBe(true);
    expect(isAddressComplete({ city: 'Austin', state: 'TX', postal_code: '' })).toBe(false);
    expect(isAddressComplete(null)).toBe(false);
  });

  it('parses comma and newline separated US addresses', () => {
    expect(parseUsAddress('12 Main St, Austin, TX 78701')).toEqual({ line1: '12 Main St', city: 'Austin', state: 'TX', postal_code: '78701' });
    expect(parseUsAddress('12 Main St\nAustin, TX 78701-1234')).toEqual({ line1: '12 Main St', city: 'Austin', state: 'TX', postal_code: '78701' });
    expect(parseUsAddress('12 Main St, Austin TX 78701')).toEqual({ line1: '12 Main St', city: 'Austin', state: 'TX', postal_code: '78701' });
  });

  it('returns null instead of guessing', () => {
    expect(parseUsAddress('somewhere nice')).toBeNull();
    expect(parseUsAddress('Austin, ZZ 78701')).toBeNull();
    expect(parseUsAddress('')).toBeNull();
  });
});

describe('taxOnBase', () => {
  it('rounds half-up in integer math', () => {
    expect(taxOnBase(1000, 8.25)).toBe(83); // 82.5 -> 83
    expect(taxOnBase(5, 10)).toBe(1); // 0.5 -> 1
    expect(taxOnBase(199, 6.25)).toBe(12); // 12.4375
    expect(taxOnBase(0, 8)).toBe(0);
    expect(taxOnBase(-500, 8)).toBe(0);
  });
});

describe('calculateSalesTax', () => {
  it('sums components, each rounded on its own', () => {
    const calc = calculateSalesTax({ ...base, lines: [{ quantity: 1, unit_price_cents: 10_050 }] });
    expect(calc.status).toBe('calculated');
    expect(calc.breakdown.map((b) => b.tax_cents)).toEqual([628, 101, 101]); // 628.125, 100.5, 100.5
    expect(calc.taxCents).toBe(830);
    expect(calc.totalCents).toBe(10_880);
    expect(calc.combinedRatePercent).toBe(8.25);
    expect(calc.rateSource).toBe('mixed');
  });

  it('applies per-service tax classes (labor non-taxable, materials taxable)', () => {
    const calc = calculateSalesTax({
      ...base,
      lines: [
        { quantity: 1, unit_price_cents: 20_000, tax_class: 'labor' },
        { quantity: 2, unit_price_cents: 5_000, tax_class: 'materials' },
      ],
    });
    expect(calc.subtotalCents).toBe(30_000);
    expect(calc.taxableCents).toBe(10_000);
    expect(calc.nonTaxableCents).toBe(20_000);
    expect(calc.taxCents).toBe(625 + 100 + 100);
    expect(calc.lines.map((l) => l.treatment)).toEqual(['class_non_taxable', 'taxable']);
  });

  it('lets a per-state rule override the class default', () => {
    const wa = [{ level: 'state' as const, name: 'Washington state sales tax', ratePercent: 6.5, isAccountRate: true }];
    const calc = calculateSalesTax({
      ...base,
      address: { city: 'Seattle', state: 'WA', postal_code: '98101' },
      rates: wa,
      lines: [{ quantity: 1, unit_price_cents: 10_000, tax_class: 'labor' }],
    });
    expect(calc.taxableCents).toBe(10_000);
    expect(calc.taxCents).toBe(650);
  });

  it('treats missing and unknown classes as taxable (legacy behaviour) and warns on unknown', () => {
    const calc = calculateSalesTax({
      ...base,
      lines: [
        { quantity: 1, unit_price_cents: 1_000 },
        { quantity: 1, unit_price_cents: 1_000, tax_class: 'mystery' },
      ],
    });
    expect(calc.taxableCents).toBe(2_000);
    expect(calc.warnings.some((w) => w.includes('mystery'))).toBe(true);
  });

  it('exempts a verified, unexpired certificate and reports it', () => {
    const calc = calculateSalesTax({ ...base, exemptions: [cert()], lines: [{ quantity: 1, unit_price_cents: 50_000 }] });
    expect(calc.taxCents).toBe(0);
    expect(calc.exemptCents).toBe(50_000);
    expect(calc.exemption?.id).toBe('e1');
    expect(calc.exemption?.label).toBe('Resale #R-123');
    expect(calc.totalCents).toBe(50_000);
  });

  it('charges tax and explains why when the certificate cannot be used', () => {
    const lines = [{ quantity: 1, unit_price_cents: 10_000 }];
    const pending = calculateSalesTax({ ...base, exemptions: [cert({ status: 'pending' })], lines });
    expect(pending.taxCents).toBeGreaterThan(0);
    expect(pending.warnings.join(' ')).toContain('awaiting verification');

    const expired = calculateSalesTax({ ...base, exemptions: [cert({ expiresOn: '2027-04-14' })], lines });
    expect(expired.taxCents).toBeGreaterThan(0);
    expect(expired.warnings.join(' ')).toContain('expired');

    const otherState = calculateSalesTax({ ...base, exemptions: [cert({ appliesToStates: ['CA'] })], lines });
    expect(otherState.taxCents).toBeGreaterThan(0);

    const notYet = calculateSalesTax({ ...base, exemptions: [cert({ issuedOn: '2027-05-01' })], lines });
    expect(notYet.taxCents).toBeGreaterThan(0);

    const revoked = calculateSalesTax({ ...base, exemptions: [cert({ status: 'revoked' })], lines });
    expect(revoked.taxCents).toBeGreaterThan(0);
  });

  it('scopes a certificate to specific tax classes', () => {
    const calc = calculateSalesTax({
      ...base,
      exemptions: [cert({ appliesToClasses: ['materials'] })],
      lines: [
        { quantity: 1, unit_price_cents: 10_000, tax_class: 'materials' },
        { quantity: 1, unit_price_cents: 10_000, tax_class: 'general' },
      ],
    });
    expect(calc.exemptCents).toBe(10_000);
    expect(calc.taxableCents).toBe(10_000);
    expect(calc.taxCents).toBe(825);
  });

  it('evaluateExemption checks every constraint', () => {
    const ctx = { state: 'TX', classCode: 'general', onDate: ON };
    expect(evaluateExemption(cert(), ctx).applies).toBe(true);
    expect(evaluateExemption(cert({ expiresOn: null }), ctx).applies).toBe(true);
    expect(evaluateExemption(cert({ status: 'rejected' }), ctx).applies).toBe(false);
  });

  it('returns no_address / no_rates / not_collecting without charging tax', () => {
    const lines = [{ quantity: 1, unit_price_cents: 10_000 }];
    expect(calculateSalesTax({ ...base, address: {}, lines }).status).toBe('no_address');
    expect(calculateSalesTax({ ...base, rates: [], lines }).status).toBe('no_rates');
    const notCollecting = calculateSalesTax({ ...base, settings: { collectInStates: ['CA'] }, lines });
    expect(notCollecting.status).toBe('not_collecting');
    expect(notCollecting.taxCents).toBe(0);
    expect(notCollecting.totalCents).toBe(10_000);
    expect(calculateSalesTax({ ...base, settings: { collectInStates: ['TX'] }, lines }).status).toBe('calculated');
  });

  it('warns when only the state rate is known', () => {
    const calc = calculateSalesTax({
      ...base,
      rates: [{ level: 'state', name: 'Texas state sales tax', ratePercent: 6.25, isAccountRate: false }],
      lines: [{ quantity: 1, unit_price_cents: 10_000 }],
    });
    expect(calc.warnings.join(' ')).toContain('Only the TX state rate');
  });

  it('warns about stale verified rates', () => {
    const calc = calculateSalesTax({
      ...base,
      rates: [{ level: 'city', name: 'Austin', ratePercent: 2, isAccountRate: true, verifiedAt: '2026-01-01T00:00:00Z' }],
      lines: [{ quantity: 1, unit_price_cents: 10_000 }],
    });
    expect(calc.warnings.join(' ')).toContain('more than 180 days');
  });

  it('never charges tax on a negative taxable balance', () => {
    const calc = calculateSalesTax({
      ...base,
      lines: [
        { quantity: 1, unit_price_cents: 1_000 },
        { quantity: 1, unit_price_cents: -5_000 },
      ],
    });
    expect(calc.taxCents).toBe(0);
    expect(calc.taxableCents).toBe(0);
    expect(calc.warnings.join(' ')).toContain('Discounts exceed');
  });

  it('keeps legacy math exact: effective percent reproduces tax_cents via the old formula', () => {
    const lineSets = [
      [{ quantity: 1, unit_price_cents: 10_050 }],
      [{ quantity: 3, unit_price_cents: 3_333, tax_class: 'materials' }, { quantity: 1, unit_price_cents: 12_345, tax_class: 'labor' }],
      [{ quantity: 7, unit_price_cents: 1_999 }],
    ];
    for (const lines of lineSets) {
      const calc = calculateSalesTax({ ...base, lines });
      const subtotal = lines.reduce((s, l) => s + l.quantity * l.unit_price_cents, 0);
      expect(Math.round((subtotal * calc.effectivePercent) / 100)).toBe(calc.taxCents);
    }
  });

  it('uses the combined rate as effective percent when the subtotal is zero (tiered options)', () => {
    expect(calculateSalesTax({ ...base, lines: [] }).effectivePercent).toBe(8.25);
    expect(calculateSalesTax({ ...base, exemptions: [cert()], lines: [] }).effectivePercent).toBe(8.25); // nothing exempted yet
  });

  it('handles zero-rate states (no breakdown lines, still calculated)', () => {
    const calc = calculateSalesTax({
      ...base,
      address: { city: 'Portland', state: 'OR', postal_code: '97201' },
      rates: [{ level: 'state', name: 'Oregon state sales tax', ratePercent: 0, isAccountRate: false }],
      lines: [{ quantity: 1, unit_price_cents: 10_000 }],
    });
    expect(calc.status).toBe('calculated');
    expect(calc.breakdown).toEqual([]);
    expect(calc.taxCents).toBe(0);
  });
});

describe('document plumbing', () => {
  const lines = [{ quantity: 1, unit_price_cents: 10_000, tax_class: 'materials' }];
  const calc = calculateSalesTax({ ...base, lines });
  const now = new Date('2027-04-15T12:00:00Z');

  it('writes the full snapshot for an auto calculation', () => {
    const selection: TaxSelection = { ...emptyTaxSelection(), address: { ...address, postal_code: '78701-1234' }, customerId: 'cust', calculation: calc };
    const cols = taxColumnsFromSelection(selection, now);
    expect(cols.tax_cents).toBe(825);
    expect(cols.tax_percent).toBeCloseTo(8.25, 10);
    expect(cols.tax_breakdown).toHaveLength(3);
    expect(cols.service_address?.postal_code).toBe('78701');
    expect(cols.customer_id).toBe('cust');
    expect(cols.tax_calculated_at).toBe('2027-04-15T12:00:00.000Z');
    expect(cols.tax_exempt).toBe(false);
  });

  it('records the exemption reference for audits', () => {
    const exemptCalc = calculateSalesTax({ ...base, exemptions: [cert()], lines });
    const cols = taxColumnsFromSelection({ ...emptyTaxSelection(), address, calculation: exemptCalc }, now);
    expect(cols.tax_exempt).toBe(true);
    expect(cols.tax_exemption_id).toBe('e1');
    expect(cols.tax_exemption_ref).toBe('Resale #R-123');
    expect(cols.exempt_cents).toBe(10_000);
  });

  it('manual mode clears every snapshot column', () => {
    const cols = taxColumnsFromSelection({ ...emptyTaxSelection(), mode: 'manual', manualPercent: 7.5, address }, now);
    expect(cols.tax_percent).toBe(7.5);
    expect(cols.tax_cents).toBeNull();
    expect(cols.tax_breakdown).toEqual([]);
    expect(cols.tax_calculated_at).toBeNull();
    expect(cols.service_address?.state).toBe('TX');
  });

  it('auto mode without a usable calculation saves zero tax, not a stale number', () => {
    const noAddress = calculateSalesTax({ ...base, address: {}, lines });
    const cols = taxColumnsFromSelection({ ...emptyTaxSelection(), calculation: noAddress }, now);
    expect(cols.tax_percent).toBe(0);
    expect(cols.tax_cents).toBe(0);
    expect(cols.service_address).toBeNull();
    expect(taxColumnsFromSelection(emptyTaxSelection(), now).tax_cents).toBe(0);
  });

  it('rebuilds a selection from a stored document', () => {
    const auto = selectionFromDocument({ tax_percent: 8.25, tax_calculated_at: '2027-04-01T00:00:00Z', tax_cents: 825, service_address: address, customer_id: 'c' });
    expect(auto).toMatchObject({ mode: 'auto', pending: true, savedTaxCents: 825, customerId: 'c' });
    const manual = selectionFromDocument({ tax_percent: 5 });
    expect(manual).toMatchObject({ mode: 'manual', manualPercent: 5, pending: false, savedTaxCents: null });
  });

  it('getDocumentTotals prefers the snapshot and falls back to the legacy percent', () => {
    const items = [{ quantity: 2, unit_price_cents: 5_000 }];
    expect(getDocumentTotals({ line_items: items, tax_percent: 10 })).toEqual({ subtotalCents: 10_000, taxCents: 1_000, totalCents: 11_000 });
    expect(getDocumentTotals({ line_items: items, tax_percent: 99, tax_cents: 123 })).toEqual({ subtotalCents: 10_000, taxCents: 123, totalCents: 10_123 });
    expect(getDocumentTotals({ line_items: items, tax_percent: 0, tax_cents: 0 }).totalCents).toBe(10_000);
  });
});

describe('rate CSV import', () => {
  it('parses valid rows, quotes and percent signs', () => {
    const csv = ['state,jurisdiction_level,jurisdiction_name,rate_percent,city,postal_code', 'TX,city,"Austin, City",1%,Austin,78701', 'tx,district,Capital Metro,1,,'].join('\n');
    const { rows, errors } = parseTaxRatesCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ state: 'TX', jurisdiction_name: 'Austin, City', rate_percent: 1, city: 'Austin', postal_code: '78701' });
  });

  it('reports bad rows by number instead of fixing them', () => {
    const csv = ['state,jurisdiction_level,jurisdiction_name,rate_percent,postal_code', 'ZZ,city,X,1,', 'TX,planet,X,1,', 'TX,city,,1,', 'TX,city,X,99,', 'TX,city,X,1,787', 'TX,city,Good,2,78701'].join('\n');
    const { rows, errors } = parseTaxRatesCsv(csv);
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(5);
    expect(errors[0]).toContain('Row 2');
  });

  it('requires the mandatory columns', () => {
    expect(parseTaxRatesCsv('state,rate_percent\nTX,1').errors.length).toBeGreaterThan(0);
    expect(parseTaxRatesCsv('state').errors.length).toBeGreaterThan(0);
  });
});

describe('report CSV', () => {
  it('formats dollars, escapes cells and neutralises formula injection', () => {
    const csv = buildTaxReportCsv(
      [{ state: 'TX', invoice_count: 2, gross_cents: 10_000, taxable_cents: 8_000, nontaxable_cents: 1_000, exempt_cents: 1_000, tax_cents: 660 }],
      [{ state: 'TX', jurisdiction_level: 'state', jurisdiction_name: 'Texas state sales tax', rate_percent: 6.25, taxable_cents: 8_000, tax_cents: 500, invoice_count: 2 }],
      [{ invoice_id: 'i', invoice_number: 'INV-0001', customer_name: '=HYPERLINK("x")', invoiced_on: '2027-04-01', exempt_cents: 1_000, certificate_ref: 'Resale #1', exemption_type: 'resale', expires_on: null, state: 'TX' }]
    );
    expect(csv).toContain('TX,2,100.00,80.00,10.00,10.00,6.60');
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
    expect(csv.split('\r\n')[0]).toBe('SUMMARY BY STATE');
  });
});
