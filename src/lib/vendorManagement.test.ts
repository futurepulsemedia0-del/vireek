import { describe, expect, it } from 'vitest';
import {
  analyzePricing,
  analyzeVendorPortfolio,
  computeVendorPerformance,
  computeVendorRisk,
  contractState,
  daysUntil,
  documentState,
  escapeLike,
  evaluateRequiredDocuments,
  filterAndSortVendors,
  gradeFor,
  normalizeOverviewRow,
  normalizeUrl,
  parseMoneyToCents,
  centsToInput,
  reviewDaysLeft,
  riskLevelFor,
  suggestInventoryVendor,
  summarizePortfolio,
  validateContractInput,
  validateDocumentInput,
  validateIncidentInput,
  validateVendorInput,
  DEFAULT_VENDOR_FILTERS,
} from './vendorManagement';
import type {
  VendorContract,
  VendorContractInput,
  VendorDocument,
  VendorOverviewRow,
  VendorPriceRow,
} from './vendorManagement';

// 2026-10-05, local time — all date maths below is relative to this.
const NOW = new Date(2026, 9, 5, 12, 0, 0);

function row(over: Partial<VendorOverviewRow> = {}): VendorOverviewRow {
  return {
    vendor_id: 'v1',
    user_id: 'u1',
    name: 'Acme Supply',
    contact_name: null,
    email: null,
    phone: null,
    address: null,
    category: 'HVAC parts',
    payment_terms: null,
    notes: null,
    active: true,
    tier: 'approved',
    website: null,
    inventory_vendor_id: null,
    review_cadence_days: 180,
    last_reviewed_at: '2026-09-01T00:00:00Z',
    required_documents: ['w9', 'coi'],
    created_at: '2026-01-01T00:00:00Z',
    po_count: 0,
    po_spend_cents: 0,
    po_spend_12m_cents: 0,
    open_po_count: 0,
    open_po_cents: 0,
    late_open_po_count: 0,
    last_order_at: null,
    delivery_measured_count: 0,
    delivery_on_time_count: 0,
    receipt_line_count: 0,
    receipt_issue_line_count: 0,
    ap_open_cents: 0,
    ap_overdue_cents: 0,
    ap_overdue_count: 0,
    job_bills_unpaid_cents: 0,
    job_bills_overdue_cents: 0,
    eval_count: 0,
    avg_quality_score: null,
    avg_price_score: null,
    avg_communication_score: null,
    avg_overall_score: null,
    eval_on_time_rate: null,
    open_incident_count: 0,
    critical_incident_count: 0,
    incident_count_12m: 0,
    incident_cost_12m_cents: 0,
    doc_count: 2,
    expired_doc_count: 0,
    expiring_doc_count: 0,
    pending_doc_count: 0,
    missing_required_doc_count: 0,
    active_contract_count: 0,
    expiring_contract_count: 0,
    lapsed_contract_count: 0,
    next_contract_end: null,
    ...over,
  };
}

const ctx = { spendShare: 0, reviewDaysLeft: 30 };

describe('daysUntil', () => {
  it('counts calendar days and is negative in the past', () => {
    expect(daysUntil('2026-10-05', NOW)).toBe(0);
    expect(daysUntil('2026-10-06', NOW)).toBe(1);
    expect(daysUntil('2026-10-01', NOW)).toBe(-4);
    expect(daysUntil('2026-11-04', NOW)).toBe(30);
  });
  it('returns null for empty / invalid input', () => {
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil('not a date', NOW)).toBeNull();
  });
});

describe('computeVendorPerformance', () => {
  it('is null without any data', () => {
    const p = computeVendorPerformance(row());
    expect(p.score).toBeNull();
    expect(p.grade).toBeNull();
    expect(p.components).toHaveLength(0);
  });

  it('does not let a tiny perfect sample read as 100', () => {
    const p = computeVendorPerformance(row({ delivery_measured_count: 1, delivery_on_time_count: 1 }));
    expect(p.onTimeRate).toBe(1);
    expect(p.score).toBeLessThan(100);
    expect(p.score).toBeGreaterThan(85);
  });

  it('blends components by weight and re-normalises when some are missing', () => {
    const p = computeVendorPerformance(
      row({
        delivery_measured_count: 20,
        delivery_on_time_count: 20,
        receipt_line_count: 40,
        receipt_issue_line_count: 0,
        eval_count: 4,
        avg_overall_score: 5,
      }),
    );
    expect(p.components).toHaveLength(3);
    expect(p.score).toBeGreaterThanOrEqual(95);
    expect(p.grade).toBe('A');

    const onlyEval = computeVendorPerformance(row({ eval_count: 2, avg_overall_score: 3 }));
    expect(onlyEval.score).toBe(50);
    expect(onlyEval.grade).toBe('F');
  });

  it('exposes raw rates for display', () => {
    const p = computeVendorPerformance(
      row({ delivery_measured_count: 10, delivery_on_time_count: 7, receipt_line_count: 20, receipt_issue_line_count: 5 }),
    );
    expect(p.onTimeRate).toBeCloseTo(0.7, 5);
    expect(p.issueRate).toBeCloseTo(0.25, 5);
  });
});

describe('gradeFor / riskLevelFor boundaries', () => {
  it('maps scores to grades', () => {
    expect([90, 80, 70, 60, 59].map(gradeFor)).toEqual(['A', 'B', 'C', 'D', 'F']);
  });
  it('maps risk scores to levels', () => {
    expect([0, 19, 20, 39, 40, 64, 65].map(riskLevelFor)).toEqual([
      'low',
      'low',
      'moderate',
      'moderate',
      'high',
      'high',
      'critical',
    ]);
  });
});

describe('computeVendorRisk', () => {
  it('is low for a clean vendor', () => {
    const r = row();
    const risk = computeVendorRisk(r, computeVendorPerformance(r), ctx);
    expect(risk.score).toBe(0);
    expect(risk.level).toBe('low');
    expect(risk.factors).toHaveLength(0);
  });

  it('caps compliance and incident factors', () => {
    const r = row({ missing_required_doc_count: 5, critical_incident_count: 4, open_incident_count: 4 });
    const risk = computeVendorRisk(r, computeVendorPerformance(r), ctx);
    expect(risk.factors.find((f) => f.key === 'missing_docs')?.points).toBe(30);
    expect(risk.factors.find((f) => f.key === 'critical_incidents')?.points).toBe(30);
    expect(risk.level).toBe('high');
  });

  it('never exceeds 100 and lists the biggest factor first', () => {
    const r = row({
      missing_required_doc_count: 3,
      expiring_doc_count: 3,
      lapsed_contract_count: 2,
      late_open_po_count: 4,
      delivery_measured_count: 10,
      delivery_on_time_count: 2,
      receipt_line_count: 10,
      receipt_issue_line_count: 5,
      critical_incident_count: 3,
      open_incident_count: 6,
      po_spend_12m_cents: 1000,
      ap_overdue_cents: 100,
      tier: 'probation',
    });
    const risk = computeVendorRisk(r, computeVendorPerformance(r), { spendShare: 0.7, reviewDaysLeft: -10 });
    expect(risk.score).toBe(100);
    expect(risk.level).toBe('critical');
    expect(risk.factors[0].points).toBeGreaterThanOrEqual(risk.factors[risk.factors.length - 1].points);
  });

  it('flags concentration only when there is spend', () => {
    const none = row({ po_spend_12m_cents: 0 });
    expect(
      computeVendorRisk(none, computeVendorPerformance(none), { spendShare: 0.9, reviewDaysLeft: 30 }).score,
    ).toBe(0);
    const some = row({ po_spend_12m_cents: 5000 });
    expect(
      computeVendorRisk(some, computeVendorPerformance(some), { spendShare: 0.5, reviewDaysLeft: 30 }).score,
    ).toBe(10);
  });
});

describe('reviewDaysLeft', () => {
  it('uses last review, falls back to creation date', () => {
    expect(reviewDaysLeft(row({ last_reviewed_at: '2026-09-05T00:00:00Z', review_cadence_days: 90 }), NOW)).toBe(60);
    expect(reviewDaysLeft(row({ last_reviewed_at: null, created_at: '2026-01-01T00:00:00Z' }), NOW)).toBeLessThan(0);
  });
});

describe('analyzeVendorPortfolio', () => {
  const rows = [
    row({ vendor_id: 'a', name: 'Alpha', po_spend_12m_cents: 80_000, po_count: 4, open_po_count: 1, late_open_po_count: 1 }),
    row({ vendor_id: 'b', name: 'Beta', po_spend_12m_cents: 20_000, po_count: 2 }),
    row({
      vendor_id: 'c',
      name: 'Gamma',
      tier: 'blocked',
      active: false,
      late_open_po_count: 2,
      ap_overdue_cents: 600_000,
      ap_overdue_count: 1,
    }),
  ];
  const { insights, alerts } = analyzeVendorPortfolio(rows, [], NOW);

  it('computes spend share across all vendors', () => {
    expect(insights.find((i) => i.row.vendor_id === 'a')?.spendShare).toBeCloseTo(0.8, 5);
    expect(insights.find((i) => i.row.vendor_id === 'b')?.spendShare).toBeCloseTo(0.2, 5);
  });

  it('raises concentration + late-delivery alerts for the dominant vendor', () => {
    const kinds = alerts.filter((a) => a.vendorId === 'a').map((a) => a.kind);
    expect(kinds).toContain('concentration');
    expect(kinds).toContain('late_deliveries');
  });

  it('keeps payables alerts for blocked vendors but nothing else', () => {
    const kinds = alerts.filter((a) => a.vendorId === 'c').map((a) => a.kind);
    expect(kinds).toEqual(['overdue_payables']);
    expect(alerts.find((a) => a.vendorId === 'c')?.severity).toBe('critical'); // >= $5,000
  });

  it('sorts critical first and attaches alert counts', () => {
    expect(alerts[0].severity).toBe('critical');
    expect(insights.find((i) => i.row.vendor_id === 'c')?.alertCount).toBe(1);
    expect(insights.find((i) => i.row.vendor_id === 'b')?.alertCount).toBe(0);
  });

  it('adds price-increase alerts from pricing insights', () => {
    const history: VendorPriceRow[] = [
      price('a', 'p1', 1000, '2026-06-01'),
      price('a', 'p1', 1300, '2026-09-01'),
    ];
    const withPrice = analyzeVendorPortfolio(rows, analyzePricing(history, { now: NOW }), NOW);
    expect(withPrice.alerts.some((a) => a.kind === 'price_increase' && a.vendorId === 'a')).toBe(true);
  });

  it('summarises the portfolio', () => {
    const s = summarizePortfolio(insights);
    expect(s.totalVendors).toBe(3);
    expect(s.activeVendors).toBe(2);
    expect(s.spend12mCents).toBe(100_000);
    expect(s.overduePayablesCents).toBe(600_000);
    expect(s.avgPerformance).toBeNull();
  });
});

describe('filterAndSortVendors', () => {
  const rows = [
    row({ vendor_id: 'a', name: 'Alpha Cooling', category: 'HVAC parts', email: 'sales@alpha.com', po_spend_12m_cents: 500 }),
    row({ vendor_id: 'b', name: 'Beta Electric', category: 'Electrical', tier: 'preferred', po_spend_12m_cents: 900 }),
    row({ vendor_id: 'c', name: 'Gamma Tools', category: 'Tools', active: false, po_spend_12m_cents: 0, late_open_po_count: 1 }),
  ];
  const { insights } = analyzeVendorPortfolio(rows, [], NOW);
  const byName = { key: 'name', dir: 'asc' } as const;

  it('matches every search term across name, email and category', () => {
    const r = filterAndSortVendors(insights, { ...DEFAULT_VENDOR_FILTERS, query: 'alpha hvac' }, byName);
    expect(r.map((i) => i.row.vendor_id)).toEqual(['a']);
    expect(filterAndSortVendors(insights, { ...DEFAULT_VENDOR_FILTERS, query: 'ALPHA.COM' }, byName)).toHaveLength(1);
    expect(filterAndSortVendors(insights, { ...DEFAULT_VENDOR_FILTERS, query: 'alpha electric' }, byName)).toHaveLength(0);
  });

  it('filters by tier, status, category and attention', () => {
    expect(filterAndSortVendors(insights, { ...DEFAULT_VENDOR_FILTERS, tier: 'preferred' }, byName)).toHaveLength(1);
    expect(filterAndSortVendors(insights, { ...DEFAULT_VENDOR_FILTERS, status: 'inactive' }, byName)).toHaveLength(1);
    expect(filterAndSortVendors(insights, { ...DEFAULT_VENDOR_FILTERS, category: 'Electrical' }, byName)).toHaveLength(1);
    // Beta holds ~64% of spend (concentration alert); Gamma is inactive so its late PO is ignored.
    expect(
      filterAndSortVendors(insights, { ...DEFAULT_VENDOR_FILTERS, attention: true }, byName).map((i) => i.row.vendor_id),
    ).toEqual(['b']);
  });

  it('sorts numerically and keeps nulls last in both directions', () => {
    expect(filterAndSortVendors(insights, DEFAULT_VENDOR_FILTERS, { key: 'spend', dir: 'desc' }).map((i) => i.row.vendor_id)).toEqual(['b', 'a', 'c']);
    expect(filterAndSortVendors(insights, DEFAULT_VENDOR_FILTERS, { key: 'spend', dir: 'asc' }).map((i) => i.row.vendor_id)).toEqual(['c', 'a', 'b']);
    // nobody has a performance score -> falls back to name order, never throws
    expect(filterAndSortVendors(insights, DEFAULT_VENDOR_FILTERS, { key: 'performance', dir: 'desc' }).map((i) => i.row.vendor_id)).toEqual(['a', 'b', 'c']);
  });
});

function price(vendorId: string, partId: string | null, cents: number, date: string, qty = 10, desc = 'Capacitor'): VendorPriceRow {
  return {
    po_item_id: `${vendorId}-${partId}-${date}`,
    vendor_id: vendorId,
    po_id: `po-${date}`,
    po_number: null,
    part_id: partId,
    description: desc,
    unit_price_cents: cents,
    quantity_ordered: qty,
    ordered_at: `${date}T10:00:00Z`,
  };
}

describe('analyzePricing', () => {
  it('detects increases against the previous order of the same vendor + part', () => {
    const [i] = analyzePricing([price('a', 'p1', 1000, '2026-03-01'), price('a', 'p1', 1200, '2026-09-01')], { now: NOW });
    expect(i.trend).toBe('up');
    expect(i.changePct).toBeCloseTo(0.2, 5);
    expect(i.previousCents).toBe(1000);
    expect(i.orderCount).toBe(2);
  });

  it('treats small moves as flat and a first order as new', () => {
    const flat = analyzePricing([price('a', 'p1', 1000, '2026-03-01'), price('a', 'p1', 1020, '2026-09-01')], { now: NOW });
    expect(flat[0].trend).toBe('flat');
    const fresh = analyzePricing([price('a', 'p1', 1000, '2026-09-01')], { now: NOW });
    expect(fresh[0].trend).toBe('new');
    expect(fresh[0].changePct).toBeNull();
  });

  it('flags the premium vendor and quantifies savings against the cheapest recent vendor', () => {
    const out = analyzePricing(
      [price('a', 'p1', 1500, '2026-09-01', 20), price('b', 'p1', 1000, '2026-08-15', 5)],
      { now: NOW },
    );
    const a = out.find((i) => i.vendorId === 'a')!;
    const b = out.find((i) => i.vendorId === 'b')!;
    expect(a.premiumPct).toBeCloseTo(0.5, 5);
    expect(a.bestVendorId).toBe('b');
    expect(a.potentialSavingsCents).toBe(10_000); // (1500-1000) * 20
    expect(b.premiumPct).toBeNull();
    expect(b.potentialSavingsCents).toBe(0);
  });

  it('ignores vendors whose latest order is outside the benchmark window', () => {
    const out = analyzePricing(
      [price('a', 'p1', 1500, '2026-09-01'), price('b', 'p1', 900, '2024-01-01')],
      { now: NOW },
    );
    expect(out.find((i) => i.vendorId === 'a')?.premiumPct).toBeNull();
  });

  it('skips zero / invalid prices and groups description-only lines case-insensitively', () => {
    const out = analyzePricing(
      [
        price('a', null, 0, '2026-09-01'),
        price('a', null, 500, '2026-05-01', 1, 'Contactor  24V'),
        price('a', null, 600, '2026-09-01', 1, 'contactor 24v'),
      ],
      { now: NOW },
    );
    expect(out).toHaveLength(1);
    expect(out[0].trend).toBe('up');
  });
});

describe('required documents / document + contract state', () => {
  const doc = (over: Partial<VendorDocument>): VendorDocument => ({
    id: 'd',
    vendor_id: 'v1',
    doc_type: 'w9',
    title: null,
    status: 'verified',
    issued_on: null,
    expires_on: null,
    document_url: null,
    verified_at: null,
    verified_by: null,
    notes: null,
    created_at: '',
    updated_at: '',
    ...over,
  });

  it('reports ok / pending / expired / missing per required type', () => {
    const res = evaluateRequiredDocuments(
      ['w9', 'coi', 'license', 'nda'],
      [
        doc({ doc_type: 'w9', status: 'verified' }),
        doc({ doc_type: 'coi', status: 'pending', expires_on: '2027-01-01' }),
        doc({ doc_type: 'license', status: 'verified', expires_on: '2026-01-01' }),
        doc({ doc_type: 'nda', status: 'rejected' }),
      ],
      NOW,
    );
    expect(res.map((r) => r.state)).toEqual(['ok', 'pending', 'expired', 'missing']);
  });

  it('classifies document expiry', () => {
    expect(documentState(doc({ expires_on: '2026-10-04' }), NOW)).toBe('expired');
    expect(documentState(doc({ expires_on: '2026-11-04' }), NOW)).toBe('expiring');
    expect(documentState(doc({ expires_on: '2026-11-05' }), NOW)).toBe('valid');
    expect(documentState(doc({ expires_on: null }), NOW)).toBe('no_expiry');
    expect(documentState(doc({ status: 'rejected' }), NOW)).toBe('rejected');
  });

  it('derives the effective contract state', () => {
    const c = (over: Partial<VendorContract>): VendorContract => ({
      id: 'c', vendor_id: 'v1', title: 'MSA', contract_type: 'master_supply', status: 'active',
      start_date: null, end_date: null, auto_renew: false, renewal_notice_days: 60, value_cents: null,
      discount_percent: null, payment_terms: null, document_url: null, notes: null, created_at: '', updated_at: '',
      ...over,
    });
    expect(contractState(c({ end_date: null }), NOW)).toBe('active');
    expect(contractState(c({ end_date: '2026-10-01' }), NOW)).toBe('lapsed');
    expect(contractState(c({ end_date: '2026-11-20' }), NOW)).toBe('expiring');
    expect(contractState(c({ end_date: '2027-06-01' }), NOW)).toBe('active');
    expect(contractState(c({ status: 'terminated', end_date: '2027-06-01' }), NOW)).toBe('terminated');
  });
});

describe('validation', () => {
  const contract = (over: Partial<VendorContractInput> = {}): VendorContractInput => ({
    title: 'MSA', contract_type: 'master_supply', status: 'active', start_date: '2026-01-01', end_date: '2026-12-31',
    auto_renew: false, renewal_notice_days: 60, value_cents: 1000, discount_percent: 5, payment_terms: null,
    document_url: null, notes: null, ...over,
  });

  it('validates vendors', () => {
    expect(validateVendorInput({ name: ' ', email: null, website: null })).not.toBeNull();
    expect(validateVendorInput({ name: 'A', email: 'nope', website: null })).not.toBeNull();
    expect(validateVendorInput({ name: 'A', email: 'a@b.co', website: 'acme.com' })).toBeNull();
    expect(validateVendorInput({ name: 'A', email: null, website: 'ht!tp://bad url' })).not.toBeNull();
  });

  it('validates contracts', () => {
    expect(validateContractInput(contract())).toBeNull();
    expect(validateContractInput(contract({ title: ' ' }))).not.toBeNull();
    expect(validateContractInput(contract({ end_date: '2025-01-01' }))).not.toBeNull();
    expect(validateContractInput(contract({ value_cents: -1 }))).not.toBeNull();
    expect(validateContractInput(contract({ discount_percent: 101 }))).not.toBeNull();
    expect(validateContractInput(contract({ renewal_notice_days: 400 }))).not.toBeNull();
    expect(validateContractInput(contract({ document_url: 'javascript:alert(1)' }))).not.toBeNull();
  });

  it('validates documents and incidents', () => {
    const base = { doc_type: 'w9' as const, title: null, issued_on: '2026-05-01', expires_on: '2026-04-01', document_url: null, notes: null };
    expect(validateDocumentInput(base)).not.toBeNull();
    expect(validateDocumentInput({ ...base, expires_on: '2027-04-01' })).toBeNull();
    const inc = { incident_type: 'quality' as const, severity: 2 as const, summary: 'Cracked housings', cost_impact_cents: 0, occurred_on: '2026-10-01', po_id: null };
    expect(validateIncidentInput(inc)).toBeNull();
    expect(validateIncidentInput({ ...inc, summary: 'ab' })).not.toBeNull();
    expect(validateIncidentInput({ ...inc, cost_impact_cents: -5 })).not.toBeNull();
  });
});

describe('small utilities', () => {
  it('escapes LIKE wildcards', () => {
    expect(escapeLike('A_B 100%')).toBe('A\\_B 100\\%');
    expect(escapeLike('back\\slash')).toBe('back\\\\slash');
  });

  it('normalises URLs', () => {
    expect(normalizeUrl('acme.com')).toBe('https://acme.com');
    expect(normalizeUrl('http://acme.com')).toBe('http://acme.com');
    expect(normalizeUrl('  ')).toBeNull();
    expect(normalizeUrl(null)).toBeNull();
  });

  it('parses money input to cents', () => {
    expect(parseMoneyToCents('1,234.50')).toBe(123450);
    expect(parseMoneyToCents('$19.99')).toBe(1999);
    expect(parseMoneyToCents('  ')).toBeNull();
    expect(Number.isNaN(parseMoneyToCents('12.345'))).toBe(true);
    expect(Number.isNaN(parseMoneyToCents('abc'))).toBe(true);
    expect(Number.isNaN(parseMoneyToCents('-5'))).toBe(true);
    expect(centsToInput(123450)).toBe('1234.50');
    expect(centsToInput(null)).toBe('');
  });

  it('suggests an inventory vendor only on an unambiguous match', () => {
    const inv = [
      { id: '1', name: 'acme supply', email: null },
      { id: '2', name: 'Other', email: 'x@other.com' },
    ] as never;
    expect(suggestInventoryVendor({ name: 'Acme Supply ', email: null }, inv)?.id).toBe('1');
    expect(suggestInventoryVendor({ name: 'Nope', email: 'X@Other.com' }, inv)?.id).toBe('2');
    expect(suggestInventoryVendor({ name: 'Nope', email: null }, inv)).toBeNull();
    const dupes = [{ id: '1', name: 'Acme', email: null }, { id: '2', name: 'ACME', email: null }] as never;
    expect(suggestInventoryVendor({ name: 'Acme', email: null }, dupes)).toBeNull();
  });

  it('coerces stringly-typed numerics from the API', () => {
    const n = normalizeOverviewRow({ vendor_id: 'x', name: 'X', po_spend_cents: '12345', avg_overall_score: '4.5', eval_on_time_rate: null, required_documents: null });
    expect(n.po_spend_cents).toBe(12345);
    expect(n.avg_overall_score).toBe(4.5);
    expect(n.eval_on_time_rate).toBeNull();
    expect(n.po_count).toBe(0);
    expect(n.required_documents).toEqual([]);
    expect(n.tier).toBe('approved');
  });
});
