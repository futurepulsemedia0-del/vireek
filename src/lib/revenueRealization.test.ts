import { describe, expect, it } from 'vitest';
import {
  BACKTEST_TARGETS, DETECTORS, FORMULA_VERSION, adaptLedger, breakdown, buildDigest, calibrate, computeRealization, csvCell,
  dedupeCandidates, detectAgreementsExpiring, detectDeclinedRisk, detectDiscountOverPolicy, detectNoShowGaps,
  detectUnbilledTripFees, detectUnderpriced, detectUnquotedFindings, detectWarrantyUnfiled, floorRevenueCents,
  ledgerOutcomes, meetsTargets, realizedAmount, scoreBacktest, shrink, splitEstimatedRealized, toCsv,
  type LeakCandidate, type LedgerFact, type ReportLeak, type ScoredLeak,
} from '../../supabase/functions/_shared/revenue-realization/engine';

const NOW = Date.parse('2028-06-15T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const ledger = (o: Partial<LedgerFact> = {}): LedgerFact => ({
  id: 'e1', sourceType: 'job_completed_unbilled', sourceTable: 'jobs', sourceId: 'j1', estimatedValueCents: 50_000, status: 'open',
  occurredAt: daysAgo(3), assignedTo: null, customerName: 'Ana', recoveredAmountCents: null, recoveredJobId: null, ...o,
});
const scored = (o: Partial<ScoredLeak> = {}): ScoredLeak => ({ poolKey: 'p1', detector: 'stale_quote', amountCents: 10_000, confidence: 0.5, status: 'open', ...o });

describe('formula', () => {
  it('computes weighted, low and high realization', () => {
    const r = computeRealization(90_000, [scored({ amountCents: 10_000, confidence: 0.8 }), scored({ poolKey: 'p2', amountCents: 20_000, confidence: 0.25 })]);
    expect(r.leakedWeightedCents).toBe(13_000);
    expect(r.pct).toBe(87.4); // 90000 / 103000
    expect(r.pctLow).toBe(75); // 90000 / 120000
    expect(r.pctHigh).toBe(90); // only the 0.8 leak: 90000 / 100000
    expect(r.formulaVersion).toBe(FORMULA_VERSION);
  });
  it('is null when there is nothing to measure and 100 with no leaks', () => {
    expect(computeRealization(0, []).pct).toBeNull();
    expect(computeRealization(5_000, []).pct).toBe(100);
  });
  it('counts only open / in_progress leaks', () => {
    const r = computeRealization(1_000, [scored({ status: 'dismissed' }), scored({ poolKey: 'a', status: 'false_positive' }), scored({ poolKey: 'b', status: 'realized' }), scored({ poolKey: 'c', status: 'in_progress' })]);
    expect(r.leakCount).toBe(1);
  });
  it('counts a shared pool once (largest weighted)', () => {
    const r = computeRealization(0, [scored({ amountCents: 10_000, confidence: 0.5 }), scored({ detector: 'missed_call', amountCents: 10_000, confidence: 0.9 })]);
    expect(r.leakCount).toBe(1);
    expect(r.leakedWeightedCents).toBe(9_000);
  });
  it('clamps negative captured and never exceeds 100', () => {
    const r = computeRealization(-5, [scored()]);
    expect(r.capturedCents).toBe(0);
    expect(r.pct).toBe(0);
    expect(computeRealization(1, [scored({ amountCents: 0 })]).pct).toBe(100);
  });
  it('shrink stays in [0,1] and moves toward data', () => {
    expect(shrink(0, 0, 0.3)).toBe(0.3);
    expect(shrink(100, 100, 0.3)).toBeGreaterThan(0.9);
    expect(shrink(0, 100, 0.3)).toBeLessThan(0.05);
  });
});

describe('ledger adapter', () => {
  it('maps open rows, skips recovered / written_off / unknown types, and links evidence', () => {
    const c = adaptLedger([ledger(), ledger({ id: 'e2', sourceId: 'j2', status: 'recovered' }), ledger({ id: 'e3', sourceId: 'j3', status: 'written_off' }), ledger({ id: 'e4', sourceType: 'nope', sourceId: 'j4' })], {});
    expect(c).toHaveLength(1);
    expect(c[0].detector).toBe('uninvoiced_work');
    expect(c[0].evidence.map((e) => e.table)).toEqual(['jobs', 'revenue_recovery_events']);
    expect(c[0].fix).toBe('invoice_correction');
    expect(c[0].lowSample).toBe(true);
  });
  it('derives confidence from the account\'s own outcomes', () => {
    const hist = [...Array(18).fill(0).map(() => ({ sourceType: 'missed_call', status: 'recovered' })), ...Array(2).fill(0).map(() => ({ sourceType: 'missed_call', status: 'written_off' }))];
    const o = ledgerOutcomes(hist);
    const c = adaptLedger([ledger({ sourceType: 'missed_call', sourceTable: 'calls', sourceId: 'c1' })], o)[0];
    expect(c.confidence).toBeGreaterThan(0.6);
    expect(c.lowSample).toBe(false);
  });
  it('drops zero-value rows (no invented money)', () => {
    expect(adaptLedger([ledger({ estimatedValueCents: 0 })], {})).toHaveLength(0);
  });
});

describe('new detectors', () => {
  it('declined safety recommendation → quote fix; skips if later quote, too fresh, or non-risk', () => {
    const f = { itemId: 'i1', packageId: 'p', jobId: 'j', severity: 'urgent' as const, decidedAt: daysAgo(10), optionTotalCents: 80_000, equipmentAgeYears: 18, endOfLifeYears: 15, customerName: 'Bo', ownerId: null, laterQuoteOrJob: false };
    const [c] = detectDeclinedRisk([f], NOW);
    expect(c.fix).toBe('create_quote');
    expect(c.confidence).toBe(0.65);
    expect(c.whyKey).toBe('declined_safety_age');
    expect(detectDeclinedRisk([{ ...f, laterQuoteOrJob: true }], NOW)).toHaveLength(0);
    expect(detectDeclinedRisk([{ ...f, decidedAt: daysAgo(0) }], NOW)).toHaveLength(0);
    expect(detectDeclinedRisk([{ ...f, severity: 'monitor', equipmentAgeYears: 2 }], NOW)).toHaveLength(0);
    expect(detectDeclinedRisk([{ ...f, severity: 'recommended', equipmentAgeYears: 16 }], NOW)[0].whyKey).toBe('declined_age');
  });
  it('unquoted finding lowers confidence when verification is required', () => {
    const f = { id: 'f1', jobId: 'j', source: 'photo' as const, severity: 'high' as const, valueCents: 30_000, visionConfidence: 0.9, verifyRequired: false, observedAt: daysAgo(5), quoted: false, ownerId: null, customerName: null };
    const a = detectUnquotedFindings([f], NOW)[0], b = detectUnquotedFindings([{ ...f, verifyRequired: true }], NOW)[0];
    expect(a.confidence).toBeGreaterThan(b.confidence);
    expect(detectUnquotedFindings([{ ...f, quoted: true }], NOW)).toHaveLength(0);
    expect(detectUnquotedFindings([{ ...f, severity: 'low' }], NOW)).toHaveLength(0);
  });
  it('trip fee: flags the shortfall, honours waivers', () => {
    const f = { jobId: 'j', completedAt: daysAgo(2), policyCents: 14_900, billedCents: 0, waived: false, technicianId: 't1', customerName: null };
    expect(detectUnbilledTripFees([f])[0].amountCents).toBe(14_900);
    expect(detectUnbilledTripFees([{ ...f, waived: true }])).toHaveLength(0);
    expect(detectUnbilledTripFees([{ ...f, billedCents: 14_900 }])).toHaveLength(0);
  });
  it('discount over policy: gap to margin floor, accepted quotes only, preventive (no fix)', () => {
    expect(floorRevenueCents(60_000, 40)).toBe(100_000);
    const f = { checkId: 'c', quoteId: 'q', quoteStatus: 'accepted', revenueCents: 90_000, costCents: 60_000, floorPct: 40, overrideReason: null, ownerId: null, occurredAt: daysAgo(4), customerName: null };
    const [c] = detectDiscountOverPolicy([f]);
    expect(c.amountCents).toBe(10_000);
    expect(c.fix).toBeNull();
    expect(c.confidence).toBe(0.9);
    expect(detectDiscountOverPolicy([{ ...f, overrideReason: 'loyal customer' }])[0].confidence).toBe(0.6);
    expect(detectDiscountOverPolicy([{ ...f, quoteStatus: 'sent' }])).toHaveLength(0);
    expect(detectDiscountOverPolicy([{ ...f, revenueCents: 100_000 }])).toHaveLength(0);
  });
  it('warranty: eligible claims inside the window only', () => {
    const f = { id: 'w', jobId: 'j', status: 'eligible', claimedCents: null, partCostCents: 40_000, laborCostCents: 20_000, claimDeadline: '2028-07-01', occurredAt: daysAgo(9), customerName: null };
    const [c] = detectWarrantyUnfiled([f], NOW);
    expect(c.amountCents).toBe(60_000);
    expect(c.whyParams.days).toBe(17);
    expect(detectWarrantyUnfiled([{ ...f, claimDeadline: '2028-06-01' }], NOW)).toHaveLength(0);
    expect(detectWarrantyUnfiled([{ ...f, status: 'submitted' }], NOW)).toHaveLength(0);
    expect(detectWarrantyUnfiled([{ ...f, claimDeadline: null }], NOW)[0].whyKey).toBe('warranty_unfiled');
  });
  it('agreements expiring inside the window with no successor', () => {
    const f = { id: 'a', title: 'PM plan', customerName: null, status: 'active', endDate: '2028-06-30', annualValueCents: 120_000, successorExists: false, ownerId: null };
    expect(detectAgreementsExpiring([f], NOW)).toHaveLength(1);
    expect(detectAgreementsExpiring([{ ...f, successorExists: true }], NOW)).toHaveLength(0);
    expect(detectAgreementsExpiring([{ ...f, endDate: '2029-01-01' }], NOW)).toHaveLength(0);
    expect(detectAgreementsExpiring([{ ...f, endDate: '2028-05-01' }], NOW)).toHaveLength(0);
  });
  it('underpriced: tolerance and match quality', () => {
    const f = { jobId: 'j', service: 'Tune-up', invoicedCents: 10_000, bookCents: 20_000, match: 'exact' as const, technicianId: 't', occurredAt: daysAgo(3), customerName: null };
    const [c] = detectUnderpriced([f]);
    expect(c.amountCents).toBe(10_000);
    expect(detectUnderpriced([{ ...f, match: 'keyword' }])[0].confidence).toBeLessThan(c.confidence);
    expect(detectUnderpriced([{ ...f, invoicedCents: 18_000 }])).toHaveLength(0);
    expect(detectUnderpriced([{ ...f, invoicedCents: 0 }])).toHaveLength(0);
  });
  it('no-show gap: unrebooked inside the window', () => {
    const f = { jobId: 'j', scheduledAt: daysAgo(5), valueCents: 25_000, rebooked: false, ownerId: null, customerName: null };
    expect(detectNoShowGaps([f], NOW)).toHaveLength(1);
    expect(detectNoShowGaps([{ ...f, rebooked: true }], NOW)).toHaveLength(0);
    expect(detectNoShowGaps([{ ...f, scheduledAt: daysAgo(1) }], NOW)).toHaveLength(0);
  });
  it('every detector id is unique', () => { expect(new Set(DETECTORS).size).toBe(DETECTORS.length); });
});

describe('calibration, dedupe, realized', () => {
  const base = adaptLedger([ledger()], {})[0];
  it('false positives lower confidence; true positives raise it; none leaves it unchanged', () => {
    expect(calibrate([base], {})[0].confidence).toBeCloseTo(base.confidence, 10);
    expect(calibrate([base], { uninvoiced_work: { truePositive: 0, falsePositive: 30 } })[0].confidence).toBeLessThan(base.confidence * 0.5);
    expect(calibrate([base], { uninvoiced_work: { truePositive: 30, falsePositive: 0 } })[0].confidence).toBeGreaterThan(base.confidence);
    expect(calibrate([{ ...base, confidence: 0.99 }], { uninvoiced_work: { truePositive: 500, falsePositive: 0 } })[0].confidence).toBeLessThanOrEqual(0.99);
  });
  it('dedupe keeps one row per key and ranks by weighted dollars', () => {
    const a: LeakCandidate = { ...base, dedupeKey: 'k1', amountCents: 100, confidence: 0.5 };
    const b: LeakCandidate = { ...base, dedupeKey: 'k2', amountCents: 1_000, confidence: 0.5 };
    expect(dedupeCandidates([a, a, b]).map((c) => c.dedupeKey)).toEqual(['k2', 'k1']);
  });
  it('realized requires a confirmed payment/booking proof', () => {
    expect(realizedAmount(null)).toBe(0);
    expect(realizedAmount({ kind: 'invoice_paid', table: 'invoices', id: 'i', amountCents: 12_345, at: 'x' })).toBe(12_345);
    expect(realizedAmount({ kind: 'invoice_paid', table: 'invoices', id: 'i', amountCents: 0, at: 'x' })).toBe(0);
    // @ts-expect-error a draft is not a valid proof kind
    expect(realizedAmount({ kind: 'draft_created', table: 'invoices', id: 'i', amountCents: 500, at: 'x' })).toBe(0);
  });
  it('estimated and realized never mix', () => {
    const s = splitEstimatedRealized([
      { status: 'open', amountCents: 1_000, confidence: 0.5, realizedAmountCents: null },
      { status: 'in_progress', amountCents: 1_000, confidence: 0.5, realizedAmountCents: 999 },
      { status: 'realized', amountCents: 5_000, confidence: 0.9, realizedAmountCents: 4_000 },
      { status: 'dismissed', amountCents: 9_000, confidence: 0.9, realizedAmountCents: null },
    ]);
    expect(s).toEqual({ estimatedOpenCents: 1_000, realizedCents: 4_000 });
  });
});

describe('reporting', () => {
  const L = (o: Partial<ReportLeak>): ReportLeak => ({ id: 'a', detector: 'stale_quote', amountCents: 1_000, confidence: 0.5, status: 'open', ownerId: null, technicianId: null, source: null, occurredAt: daysAgo(1), customerName: null, ...o });
  it('breakdown groups, sorts, and buckets unknowns as unassigned', () => {
    const b = breakdown([L({ id: '1', technicianId: 't1', amountCents: 4_000 }), L({ id: '2' }), L({ id: '3', technicianId: 't1' }), L({ id: '4', status: 'dismissed', technicianId: 't9' })], 'technicianId');
    expect(b.map((x) => [x.key, x.count])).toEqual([['t1', 2], ['unassigned', 1]]);
  });
  it('digest ranks, counts new, and reports the percentage-point delta', () => {
    const cur = computeRealization(9_000, [scored({ amountCents: 1_000, confidence: 1 })]);
    const prev = computeRealization(8_000, [scored({ amountCents: 2_000, confidence: 1 })]);
    const d = buildDigest([L({ id: 'x', amountCents: 5 }), L({ id: 'y', amountCents: 5_000, occurredAt: daysAgo(30) })], daysAgo(7), cur, prev, 1);
    expect(d.topLeaks[0].id).toBe('y');
    expect(d.newCount).toBe(1);
    expect(d.deltaPctPoints).toBe(90 - 80);
  });
  it('csv neutralises formula injection and quotes separators', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    expect(toCsv([L({ customerName: '@evil' })]).split('\n')[1]).toContain("'@evil");
  });
});

describe('backtest harness', () => {
  it('scores precision and recall and enforces targets', () => {
    const s = scoreBacktest(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'e']);
    expect(s).toMatchObject({ tp: 3, fp: 1, fn: 1, precision: 0.75, recall: 0.75 });
    expect(meetsTargets(s)).toBe(true);
    expect(meetsTargets(scoreBacktest(['a'], ['a', 'b', 'c', 'd']))).toBe(false);
    expect(scoreBacktest([], [])).toMatchObject({ precision: null, recall: null });
    expect(BACKTEST_TARGETS.precision).toBeGreaterThan(0.5);
  });
  it('labelled fixtures: each wired pure detector meets the targets', () => {
    // Labelled cases: `key` = detector key suffix; truth = records a human marked as real leaks.
    const warranty = [
      { id: 'w1', jobId: null, status: 'eligible', claimedCents: 1_000, partCostCents: 0, laborCostCents: 0, claimDeadline: '2028-07-10', occurredAt: daysAgo(3), customerName: null },
      { id: 'w2', jobId: null, status: 'packet_pending', claimedCents: 2_000, partCostCents: 0, laborCostCents: 0, claimDeadline: null, occurredAt: daysAgo(3), customerName: null },
      { id: 'w3', jobId: null, status: 'submitted', claimedCents: 3_000, partCostCents: 0, laborCostCents: 0, claimDeadline: null, occurredAt: daysAgo(3), customerName: null },
      { id: 'w4', jobId: null, status: 'eligible', claimedCents: 4_000, partCostCents: 0, laborCostCents: 0, claimDeadline: '2028-05-01', occurredAt: daysAgo(40), customerName: null },
    ];
    const s = scoreBacktest(detectWarrantyUnfiled(warranty, NOW).map((c) => c.dedupeKey), ['warranty_unfiled:w1', 'warranty_unfiled:w2']);
    expect(meetsTargets(s)).toBe(true);
    const disc = [
      { checkId: 'd1', quoteId: 'q1', quoteStatus: 'accepted', revenueCents: 50_000, costCents: 40_000, floorPct: 30, overrideReason: null, ownerId: null, occurredAt: daysAgo(2), customerName: null },
      { checkId: 'd2', quoteId: 'q2', quoteStatus: 'accepted', revenueCents: 80_000, costCents: 40_000, floorPct: 30, overrideReason: null, ownerId: null, occurredAt: daysAgo(2), customerName: null },
    ];
    expect(meetsTargets(scoreBacktest(detectDiscountOverPolicy(disc).map((c) => c.dedupeKey), ['discount_over_policy:d1']))).toBe(true);
  });
});
