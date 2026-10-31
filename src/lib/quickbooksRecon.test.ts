import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildInvoiceAuditQuery, defaultSettings, validateSettings } from '../../supabase/functions/_shared/quickbooks/engine';
import {
  RECON_BUCKETS,
  csvCell,
  findingsToCsv,
  parseBaseAmounts,
  reconcileInvoices,
  severityFor,
  toReconQbo,
  type ReconBucket,
  type ReconQboInvoice,
  type ReconSettings,
  type ReconVireekInvoice,
} from '../../supabase/functions/_shared/quickbooks/reconcile';

const SETTINGS: ReconSettings = { taxToleranceCents: 1, dateWindowDays: 7, billToRule: 'invoice_customer' };
const D = '2026-09-10';

function rawInvoice(o: { id: string; doc: string | null; cust: string; date?: string; sub: number; tax?: number; balance?: number; deposit?: number; creditMemo?: boolean; voided?: boolean }) {
  const tax = o.tax ?? 0;
  const total = o.sub + tax;
  return {
    Id: o.id,
    SyncToken: '0',
    DocNumber: o.doc ?? undefined,
    CustomerRef: { value: o.cust, name: `Customer ${o.cust}` },
    TxnDate: o.date ?? D,
    DueDate: '2026-10-10',
    Line: [{ DetailType: 'SalesItemLineDetail', Amount: o.sub / 100, Description: 'Service', SalesItemLineDetail: { Qty: 1, UnitPrice: o.sub / 100, ItemRef: { value: '1', name: 'Service' } } }],
    TxnTaxDetail: { TotalTax: tax / 100 },
    TotalAmt: total / 100,
    Balance: (o.balance ?? total) / 100,
    Deposit: o.deposit ? o.deposit / 100 : undefined,
    LinkedTxn: o.creditMemo ? [{ TxnId: '9', TxnType: 'CreditMemo' }] : [],
    PrivateNote: o.voided ? 'Voided' : undefined,
    MetaData: { LastUpdatedTime: '2026-09-11T00:00:00-07:00' },
  };
}
function qbo(o: Parameters<typeof rawInvoice>[0]): ReconQboInvoice {
  const r = toReconQbo(rawInvoice(o));
  if (!r.ok) throw new Error(r.reason);
  return r.inv;
}
function vi(o: Partial<ReconVireekInvoice> & { id: string; invoiceNumber: string; subtotalCents: number }): ReconVireekInvoice {
  const tax = o.taxCents ?? 0;
  return {
    customerId: 'c1',
    customerName: 'Ann',
    qboCustomerId: 'C1',
    status: 'sent',
    issueDate: D,
    taxCents: tax,
    totalCents: o.subtotalCents + tax,
    amountPaidCents: 0,
    creditMemoCents: 0,
    sourceSystem: 'servicetitan',
    sourceId: `ST-${o.invoiceNumber}`,
    billToRole: null,
    customerTaxExempt: false,
    link: null,
    ...o,
  };
}

// ---- the seeded dataset: exactly one case per bucket --------------------------------------------
function seeded() {
  const vireek = [
    vi({ id: 'v1', invoiceNumber: 'INV-100', subtotalCents: 10000, taxCents: 800 }), // matched
    vi({ id: 'v2', invoiceNumber: 'INV-200', subtotalCents: 25000 }), // missing in QuickBooks
    vi({ id: 'v3', invoiceNumber: 'INV-400', subtotalCents: 20000 }), // amount mismatch (QB 19500)
    vi({ id: 'v4', invoiceNumber: 'INV-500', subtotalCents: 5000 }), // duplicate in QB (ids 500 + 501)
    vi({ id: 'v5', invoiceNumber: 'INV-600', subtotalCents: 32000, link: { externalId: '600', baseAmounts: '30000|0|service~1~30000' } }), // edited after export
    vi({ id: 'v6', invoiceNumber: 'INV-700', subtotalCents: 40000 }), // deposit in QB only
    vi({ id: 'v7', invoiceNumber: 'INV-800', subtotalCents: 10000, taxCents: 825 }), // tax 25c off
    vi({ id: 'v8', invoiceNumber: 'INV-900', subtotalCents: 15000, customerId: 'c2', qboCustomerId: 'C2' }), // QB bills C9
    vi({ id: 'v9', invoiceNumber: 'INV-950', subtotalCents: 10000, taxCents: 801 }), // 1c rounding: matched
  ];
  const q = [
    qbo({ id: '100', doc: 'INV-100', cust: 'C1', sub: 10000, tax: 800 }),
    qbo({ id: '300', doc: 'X-300', cust: 'C1', sub: 7000, tax: 700 }), // missing in Vireek
    qbo({ id: '400', doc: 'INV-400', cust: 'C1', sub: 19500 }),
    qbo({ id: '500', doc: 'INV-500', cust: 'C1', sub: 5000 }),
    qbo({ id: '501', doc: 'INV-500', cust: 'C1', sub: 5000 }),
    qbo({ id: '600', doc: 'INV-600', cust: 'C1', sub: 30000 }),
    qbo({ id: '700', doc: 'INV-700', cust: 'C1', sub: 40000, balance: 30000, deposit: 10000 }),
    qbo({ id: '800', doc: 'INV-800', cust: 'C1', sub: 10000, tax: 800 }),
    qbo({ id: '900', doc: 'INV-900', cust: 'C9', sub: 15000 }),
    qbo({ id: '950', doc: 'INV-950', cust: 'C1', sub: 10000, tax: 800 }),
  ];
  return { vireek, qbo: q, settings: SETTINGS, fromDate: '2026-09-01' };
}

describe('seeded dataset: one case per bucket', () => {
  const r = reconcileInvoices(seeded());
  const by = (b: ReconBucket) => r.findings.filter((f) => f.bucket === b);

  it('produces exactly one finding per bucket and nothing else', () => {
    expect(r.findings).toHaveLength(8);
    for (const b of RECON_BUCKETS) expect(by(b), b).toHaveLength(1);
  });

  it('dollars at stake are exact integer cents per bucket', () => {
    const cents = Object.fromEntries(RECON_BUCKETS.map((b) => [b, r.summary.buckets[b].cents]));
    expect(cents).toEqual({
      missing_in_qbo: 25000,
      missing_in_fsm: 7700,
      amount_mismatch: 500,
      duplicate_in_qbo: 5000,
      modified_after_export: 2000,
      deposit_credit_mismatch: 10000,
      tax_mismatch: 25,
      bill_to_mismatch: 15000,
    });
    expect(r.summary.totalCentsAtStake).toBe(65225);
    expect(Object.values(r.summary.buckets).every((b) => b.count === 1)).toBe(true);
    expect(r.findings.every((f) => Number.isInteger(f.centsAtStake))).toBe(true);
  });

  it('matched bucket: exact, tolerated-rounding and the primary of a duplicate', () => {
    expect(r.summary.matched).toEqual({ count: 3, cents: 10800 + 10801 + 5000 });
  });

  it('points each finding at the right records', () => {
    expect(by('missing_in_qbo')[0]).toMatchObject({ vireekId: 'v2', qboId: null });
    expect(by('missing_in_fsm')[0]).toMatchObject({ vireekId: null, qboId: '300' });
    expect(by('duplicate_in_qbo')[0]).toMatchObject({ vireekId: 'v4', qboId: '501' });
    expect(by('modified_after_export')[0].evidence.detail.changedSide).toMatch(/Vireek/);
    expect(by('deposit_credit_mismatch')[0].evidence.detail).toMatchObject({ kind: 'deposit', qboAppliedCents: 10000, vireekPaidCents: 0 });
    expect(by('bill_to_mismatch')[0].evidence.detail).toMatchObject({ expectedQboCustomerId: 'C2', actualQboCustomerId: 'C9' });
  });

  it('every finding carries both records as evidence, a severity and an action', () => {
    for (const f of r.findings) {
      expect(f.suggestedAction.length).toBeGreaterThan(10);
      expect(['low', 'medium', 'high', 'critical']).toContain(f.severity);
      expect(f.fingerprint).toContain(f.bucket);
      if (f.vireekId) expect(f.evidence.vireek).not.toBeNull();
      if (f.qboId) expect(f.evidence.qbo).not.toBeNull();
    }
  });

  it('is deterministic regardless of input order', () => {
    const s = seeded();
    const flipped = reconcileInvoices({ ...s, vireek: [...s.vireek].reverse(), qbo: [...s.qbo].reverse() });
    expect(flipped).toEqual(r);
  });
});

describe('matching', () => {
  it('matches by customer + amount + date window when there is no document number', () => {
    const v = vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 9000, issueDate: '2026-09-10' });
    const r = reconcileInvoices({ vireek: [v], qbo: [qbo({ id: '1', doc: null, cust: 'C1', sub: 9000, date: '2026-09-13' })], settings: SETTINGS, fromDate: '2026-09-01' });
    expect(r.findings).toEqual([]);
    expect(r.summary.matched.count).toBe(1);
  });
  it('does not match outside the date window', () => {
    const v = vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 9000 });
    const r = reconcileInvoices({ vireek: [v], qbo: [qbo({ id: '1', doc: null, cust: 'C1', sub: 9000, date: '2026-09-30' })], settings: SETTINGS, fromDate: '2026-09-01' });
    expect(r.findings.map((f) => f.bucket).sort()).toEqual(['missing_in_fsm', 'missing_in_qbo']);
  });
  it('never guesses when two QuickBooks invoices fit equally well', () => {
    const v = vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 9000 });
    const r = reconcileInvoices({
      vireek: [v],
      qbo: [qbo({ id: '1', doc: null, cust: 'C1', sub: 9000 }), qbo({ id: '2', doc: null, cust: 'C1', sub: 9000 })],
      settings: SETTINGS,
      fromDate: null,
    });
    expect(r.summary.matched.count).toBe(0);
    expect(r.summary.skipped[0].reason).toMatch(/Ambiguous/);
    expect(r.findings.map((f) => f.bucket)).toEqual(['missing_in_qbo']);
  });
  it('matches the incumbent source id as a document number', () => {
    const v = vi({ id: 'a', invoiceNumber: 'V-9', subtotalCents: 1000, sourceId: '4471' });
    const r = reconcileInvoices({ vireek: [v], qbo: [qbo({ id: '1', doc: '4471', cust: 'C1', sub: 1000 })], settings: SETTINGS, fromDate: null });
    expect(r.findings).toEqual([]);
  });
  it('a stored link beats a document number', () => {
    const v = vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 1000, link: { externalId: '7', baseAmounts: null } });
    const r = reconcileInvoices({ vireek: [v], qbo: [qbo({ id: '7', doc: 'OTHER', cust: 'C1', sub: 1000 }), qbo({ id: '8', doc: 'A-1', cust: 'C1', sub: 1000 })], settings: SETTINGS, fromDate: null });
    expect(r.findings.map((f) => [f.bucket, f.qboId])).toEqual([['duplicate_in_qbo', '8']]);
  });
  it('duplicates that Vireek never had: first is missing in Vireek, the rest are duplicates', () => {
    const r = reconcileInvoices({
      vireek: [],
      qbo: [qbo({ id: '10', doc: 'Z-1', cust: 'C1', sub: 100 }), qbo({ id: '11', doc: 'Z-1', cust: 'C1', sub: 100 })],
      settings: SETTINGS,
      fromDate: '2026-09-01',
    });
    expect(r.findings.map((f) => [f.bucket, f.qboId])).toEqual([['missing_in_fsm', '10'], ['duplicate_in_qbo', '11']]);
  });
  it('skips (and reports) QuickBooks invoices it cannot compare', () => {
    const bad = toReconQbo({ ...rawInvoice({ id: '5', doc: 'M-1', cust: 'C1', sub: 100 }), CurrencyRef: { value: 'CAD' } });
    expect(bad.ok).toBe(false);
    const r = reconcileInvoices({ vireek: [], qbo: [], settings: SETTINGS, fromDate: null, unparsed: bad.ok ? [] : [{ id: bad.id, reason: bad.reason }] });
    expect(r.summary.skipped).toEqual([{ qboId: '5', vireekId: null, reason: expect.stringMatching(/Currency CAD/) }]);
    expect(r.findings).toEqual([]);
  });
  it('ignores drafts and does not flag non-imported Vireek invoices as missing in QuickBooks', () => {
    const r = reconcileInvoices({
      vireek: [vi({ id: 'd', invoiceNumber: 'D-1', subtotalCents: 500, status: 'draft' }), vi({ id: 'n', invoiceNumber: 'N-1', subtotalCents: 500, sourceSystem: null, sourceId: null })],
      qbo: [],
      settings: SETTINGS,
      fromDate: null,
    });
    expect(r.findings).toEqual([]);
  });
  it('skips the missing-in-Vireek bucket when there is no start date, and old history before it', () => {
    const q = [qbo({ id: '1', doc: 'OLD', cust: 'C1', sub: 100, date: '2025-01-01' })];
    expect(reconcileInvoices({ vireek: [], qbo: q, settings: SETTINGS, fromDate: null }).findings).toEqual([]);
    expect(reconcileInvoices({ vireek: [], qbo: q, settings: SETTINGS, fromDate: '2026-09-01' }).findings).toEqual([]);
  });
});

describe('tax, rounding and amounts', () => {
  const run = (vTax: number, qTax: number, extra: Partial<ReconVireekInvoice> = {}) =>
    reconcileInvoices({
      vireek: [vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 10000, taxCents: vTax, ...extra })],
      qbo: [qbo({ id: '1', doc: 'A-1', cust: 'C1', sub: 10000, tax: qTax })],
      settings: SETTINGS,
      fromDate: null,
    });
  it('1 cent of tax rounding is tolerated, 2 cents is a finding', () => {
    expect(run(801, 800).findings).toEqual([]);
    expect(run(802, 800).findings.map((f) => [f.bucket, f.centsAtStake])).toEqual([['tax_mismatch', 2]]);
  });
  it('the tolerance is a setting', () => {
    const r = reconcileInvoices({ vireek: [vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 10000, taxCents: 805 })], qbo: [qbo({ id: '1', doc: 'A-1', cust: 'C1', sub: 10000, tax: 800 })], settings: { ...SETTINGS, taxToleranceCents: 5 }, fromDate: null });
    expect(r.findings).toEqual([]);
  });
  it('tax and subtotal differences split the total difference with no double counting', () => {
    const r = reconcileInvoices({
      vireek: [vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 10100, taxCents: 850 })],
      qbo: [qbo({ id: '1', doc: 'A-1', cust: 'C1', sub: 10000, tax: 800 })],
      settings: SETTINGS,
      fromDate: null,
    });
    expect(r.summary.buckets.amount_mismatch.cents + r.summary.buckets.tax_mismatch.cents).toBe(150);
  });
  it('a tax-exempt customer who was taxed is called out', () => {
    const r = run(800, 800, { customerTaxExempt: true });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ bucket: 'tax_mismatch', centsAtStake: 800 });
    expect(r.findings[0].suggestedAction).toMatch(/exemption/);
  });
  it('a tax-exempt customer with no tax on either side is clean', () => {
    expect(run(0, 0, { customerTaxExempt: true }).findings).toEqual([]);
  });
  it('QuickBooks edit after export is attributed to QuickBooks', () => {
    const r = reconcileInvoices({
      vireek: [vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 10000, link: { externalId: '1', baseAmounts: '10000|0|x' } })],
      qbo: [qbo({ id: '1', doc: 'A-1', cust: 'C1', sub: 9000 })],
      settings: SETTINGS,
      fromDate: null,
    });
    expect(r.findings[0]).toMatchObject({ bucket: 'modified_after_export', centsAtStake: 1000 });
    expect(r.findings[0].evidence.detail.changedSide).toMatch(/QuickBooks/);
  });
  it('when BOTH sides changed it is a plain amount mismatch, not an export problem', () => {
    const r = reconcileInvoices({
      vireek: [vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 11000, link: { externalId: '1', baseAmounts: '10000|0|x' } })],
      qbo: [qbo({ id: '1', doc: 'A-1', cust: 'C1', sub: 9000 })],
      settings: SETTINGS,
      fromDate: null,
    });
    expect(r.findings.map((f) => f.bucket)).toEqual(['amount_mismatch']);
  });
  it('voided on one side only is flagged with the live amount at stake', () => {
    const a = reconcileInvoices({ vireek: [vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 700, status: 'void' })], qbo: [qbo({ id: '1', doc: 'A-1', cust: 'C1', sub: 700 })], settings: SETTINGS, fromDate: null });
    expect(a.findings.map((f) => [f.bucket, f.centsAtStake])).toEqual([['amount_mismatch', 700]]);
    const b = reconcileInvoices({ vireek: [vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 700 })], qbo: [qbo({ id: '1', doc: 'A-1', cust: 'C1', sub: 100, voided: true })], settings: SETTINGS, fromDate: null });
    expect(b.findings.map((f) => [f.bucket, f.centsAtStake])).toEqual([['amount_mismatch', 700]]);
  });
});

describe('deposits, credit memos and bill-to', () => {
  it('a credit memo that exists in Vireek but is not linked in QuickBooks is flagged', () => {
    const r = reconcileInvoices({ vireek: [vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 5000, creditMemoCents: 1200 })], qbo: [qbo({ id: '1', doc: 'A-1', cust: 'C1', sub: 5000 })], settings: SETTINGS, fromDate: null });
    expect(r.findings[0]).toMatchObject({ bucket: 'deposit_credit_mismatch', centsAtStake: 1200 });
  });
  it('matching payments on both sides are clean', () => {
    const r = reconcileInvoices({ vireek: [vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 5000, amountPaidCents: 5000, status: 'paid' })], qbo: [qbo({ id: '1', doc: 'A-1', cust: 'C1', sub: 5000, balance: 0 })], settings: SETTINGS, fromDate: null });
    expect(r.findings).toEqual([]);
  });
  it('bill-to rule: an invoice billed to the wrong role is flagged only when a rule is set', () => {
    const v = vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 5000, billToRole: 'tenant' });
    const q = [qbo({ id: '1', doc: 'A-1', cust: 'C1', sub: 5000 })];
    expect(reconcileInvoices({ vireek: [v], qbo: q, settings: SETTINGS, fromDate: null }).findings).toEqual([]);
    const r = reconcileInvoices({ vireek: [v], qbo: q, settings: { ...SETTINGS, billToRule: 'owner' }, fromDate: null });
    expect(r.findings[0]).toMatchObject({ bucket: 'bill_to_mismatch', centsAtStake: 5000 });
  });
  it('an unlinked customer is skipped, not guessed', () => {
    const r = reconcileInvoices({ vireek: [vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 5000, qboCustomerId: null })], qbo: [qbo({ id: '1', doc: 'A-1', cust: 'C77', sub: 5000 })], settings: SETTINGS, fromDate: null });
    expect(r.findings).toEqual([]);
    expect(r.summary.skipped[0].reason).toMatch(/not linked/);
  });
});

describe('payments-present invariant', () => {
  const paid = reconcileInvoices({
    vireek: [vi({ id: 'a', invoiceNumber: 'A-1', subtotalCents: 5000, amountPaidCents: 5000, status: 'paid' }), vi({ id: 'b', invoiceNumber: 'B-1', subtotalCents: 5000 })],
    qbo: [qbo({ id: '1', doc: 'A-1', cust: 'C1', sub: 4000, balance: 0 }), qbo({ id: '2', doc: 'A-1', cust: 'C1', sub: 5000, balance: 0 }), qbo({ id: '3', doc: 'B-1', cust: 'C1', sub: 5000 }), qbo({ id: '4', doc: 'B-1', cust: 'C1', sub: 5000 })],
    settings: SETTINGS,
    fromDate: null,
  });
  it('flags payments on either side and raises severity one level', () => {
    expect(severityFor(5000, false)).toBe('low');
    expect(severityFor(5000, true)).toBe('medium');
    expect(severityFor(10000, true)).toBe('high');
    expect(severityFor(100000, true)).toBe('critical');
    expect(paid.findings.some((f) => f.hasPayments)).toBe(true);
  });
  it('never suggests voiding or re-itemising an invoice that has payments', () => {
    for (const f of paid.findings.filter((x) => x.hasPayments)) {
      const stripped = f.suggestedAction.replace(/do not void[^.]*\./gi, '').toLowerCase();
      expect(stripped).not.toMatch(/void|delete|re-itemise/);
    }
    const dup = paid.findings.find((f) => f.bucket === 'duplicate_in_qbo' && f.hasPayments);
    if (dup) expect(dup.suggestedAction).toMatch(/Do not void/);
    const amt = paid.findings.find((f) => f.bucket === 'amount_mismatch');
    expect(amt?.suggestedAction).toMatch(/do not void or re-itemise/i);
  });
  it('the audit has no QuickBooks write path and no database write other than qbo_recon_apply', () => {
    const pure = readFileSync('supabase/functions/_shared/quickbooks/reconcile.ts', 'utf8');
    expect(pure).not.toMatch(/fetch\(|buildWriteRequest|buildVoidRequest|method: 'POST'/);
    const fn = readFileSync('supabase/functions/qbo-sync-run/index.ts', 'utf8');
    const seg = fn.slice(fn.indexOf('async function executeReconcile'), fn.indexOf('// HTTP ENTRY'));
    expect(seg.length).toBeGreaterThan(500);
    expect(seg).not.toMatch(/writeQbo|buildWriteRequest|buildVoidRequest|method: "POST"|\.insert\(|\.delete\(/);
    expect(seg).not.toMatch(/from\("ar_(invoices|payments|invoice_lines)"\)\.(update|upsert)/);
    expect([...seg.matchAll(/\.update\(/g)].length).toBe(1); // only the qbo_recon_runs bookkeeping row
    expect(seg).toMatch(/qbo_recon_apply/);
  });
});

describe('helpers', () => {
  it('parseBaseAmounts reads the signature prefix and refuses anything else', () => {
    expect(parseBaseAmounts('10800|800|a~1~10000')).toEqual({ totalCents: 10800, taxCents: 800 });
    expect(parseBaseAmounts(null)).toBeNull();
    expect(parseBaseAmounts('garbage')).toBeNull();
  });
  it('CSV: quoting, cents to dollars, and formula-injection guard', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-5')).toBe("'-5");
    const csv = findingsToCsv([
      { bucket: 'tax_mismatch', severity: 'low', cents_at_stake: 25, status: 'open', has_payments: false, suggested_action: 'Check, then fix', resolution_note: null, evidence: { vireek: { invoice_number: 'INV-800', customer: 'Ann' }, qbo: { doc_number: 'INV-800' } } },
    ]);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('Tax mismatch,low,0.25,open,no,INV-800,INV-800,Ann,"Check, then fix",');
  });
  it('audit query is read-only, validates its date and paginates deterministically', () => {
    const req = buildInvoiceAuditQuery({ base: 'https://sandbox-quickbooks.api.intuit.com', realm: '123145820001', fromDate: '2026-09-01', pos: 101, pageSize: 100 });
    expect(req.method).toBe('GET');
    expect(decodeURIComponent(req.url)).toContain("select * from Invoice where TxnDate >= '2026-09-01' order by Id startposition 101 maxresults 100");
    expect(() => buildInvoiceAuditQuery({ base: 'x', realm: '1', fromDate: "2026-09-01' or 1=1", pos: 1, pageSize: 1 })).toThrow();
  });
  it('bill-to rule is a validated engine default', () => {
    expect(defaultSettings().defaults.billToRule).toBe('invoice_customer');
    const ok = validateSettings({ defaults: { billToRule: 'tenant' } });
    expect(ok.ok && ok.settings.defaults.billToRule).toBe('tenant');
    expect(validateSettings({ defaults: { billToRule: 'landlord' } }).ok).toBe(false);
  });
});
