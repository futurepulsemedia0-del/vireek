import { describe, expect, it } from 'vitest';
import { FM_SEED_RULES } from '../../supabase/functions/_shared/compliance-rules/fmSeedRules';
import type { RuleVersion } from '../../supabase/functions/_shared/compliance-rules/types';
import { SERVICECHANNEL_DEFAULTS, type WorkOrder } from '@/lib/workOrderGuard';
import { applyLineFix, checkBeforeSending, moneyAtRisk, orderToFmFacts, suggestRuleCandidates } from '@/lib/fmCheck';

const TZ = 'America/New_York';
const NOW = new Date('2026-11-05T15:00:00Z');

function wo(over: Partial<WorkOrder> = {}): WorkOrder {
  return {
    woNumber: 'WO-1', location: null, trade: null, priority: 'normal', nteCents: 50_000, estimateCents: null,
    receivedAt: '2026-10-25T12:00:00Z', acceptedAt: '2026-10-25T12:05:00Z', declinedAt: null, checkedInAt: null, checkInDistanceMiles: null,
    proposalStatus: 'none', proposalAmountCents: null, proposalApprovedAt: null, completedAt: null, invoiceNumber: null,
    invoiceSubmittedAt: null, invoiceCount: 0, invoiceLaborCents: null, invoiceTechnicians: null, invoiceMaterialsCents: null,
    invoiceTripCents: null, invoiceFreightCents: null, invoiceTaxCents: null, invoiceMgmtFeeCents: null, invoiceTotalCents: null,
    outcome: 'open', outcomeReason: null, ...over,
  };
}

const approvedPack = (): RuleVersion[] => FM_SEED_RULES.map((r, i) => ({
  id: `p${i}`, packSlug: r.packSlug, ruleKey: r.ruleKey, version: 1, jurisdiction: r.jurisdiction, kind: r.kind, severity: r.severity,
  appliesTo: r.appliesTo, title: r.title, ownerExplanation: r.ownerExplanation, params: r.params, sourceRefs: r.sourceRefs,
  status: 'approved', effectiveFrom: '2026-11-04', effectiveTo: null,
}));

describe('orderToFmFacts', () => {
  it('maps the invoice breakdown to line items in cents and ignores empty lines', () => {
    const f = orderToFmFacts(wo({ invoiceLaborCents: 10_000, invoiceTaxCents: 825, invoiceTripCents: 0, invoiceTotalCents: 10_825, invoiceMaterialsCents: 2_500 }), { timezone: TZ });
    expect(f.lineItems).toEqual([
      { category: 'labor', amountCents: 10_000 }, { category: 'materials', amountCents: 2_500 }, { category: 'sales_tax', amountCents: 825 },
    ]);
    expect(f.totalCents).toBe(10_825);
    expect(f.partsCents).toBe(2_500);
  });
  it('falls back to the estimate and anchors day rules on completion and receipt', () => {
    const f = orderToFmFacts(wo({ estimateCents: 7_000, completedAt: '2026-10-30T10:00:00Z' }), { timezone: TZ });
    expect(f).toMatchObject({ totalCents: 7_000, workConfirmedAt: '2026-10-30T10:00:00Z', workReceivedAt: '2026-10-25T12:00:00Z' });
  });
  it('counts only OTHER invoices: a draft counts all saved ones, a submitted one excludes itself, a rejected one is ignored', () => {
    expect(orderToFmFacts(wo({ invoiceCount: 1 }), { timezone: TZ }).existingInvoiceCount).toBe(1);
    expect(orderToFmFacts(wo({ invoiceCount: 1, invoiceSubmittedAt: '2026-11-01T00:00:00Z' }), { timezone: TZ }).existingInvoiceCount).toBe(0);
    expect(orderToFmFacts(wo({ invoiceCount: 1, outcome: 'rejected' }), { timezone: TZ }).existingInvoiceCount).toBe(0);
  });
});

describe('checkBeforeSending', () => {
  it('checks nothing — and says so — when no portal rule is approved', () => {
    const inReview = approvedPack().map((v) => ({ ...v, status: 'in_review' as const }));
    const r = checkBeforeSending(orderToFmFacts(wo({ invoiceTotalCents: 99_999 }), { timezone: TZ }), inReview, NOW);
    expect(r.noActiveRules).toBe(true);
    expect(r.items).toEqual([]);
    expect(r.rulesApplied).toBe(0);
  });
  it('reports each broken rule with its citation and a fix, most severe first', () => {
    const facts = orderToFmFacts(wo({
      completedAt: '2026-10-01T12:00:00Z', invoiceTotalCents: 60_000, invoiceTaxCents: 500, invoiceLaborCents: 59_500, invoiceCount: 1,
    }), { timezone: TZ, billingParty: 'portal', hasSubcontractor: true });
    const r = checkBeforeSending(facts, approvedPack(), NOW);
    expect(r.noActiveRules).toBe(false);
    expect(r.outcome).toBe('block');
    const keys = r.items.map((i) => i.ruleKey);
    expect(keys).toEqual(expect.arrayContaining(['sc-nte-cap', 'sc-no-sales-tax-billing-portal', 'sc-one-invoice-per-work-order', 'sc-invoice-within-10-days', 'sc-subcontractor-invoice-attached']));
    expect(r.items.map((i) => i.severity)).toEqual([...r.items.map((i) => i.severity)].sort((a, b) => ['block', 'require', 'warn', 'info'].indexOf(a) - ['block', 'require', 'warn', 'info'].indexOf(b)));
    const tax = r.items.find((i) => i.ruleKey === 'sc-no-sales-tax-billing-portal')!;
    expect(tax.fixes[0]).toMatchObject({ kind: 'remove_line_item', oneClick: true });
    expect(tax.sourceRefs[0].url).toContain('servicechannel.com');
  });
  it('a clean invoice passes with no items', () => {
    const facts = orderToFmFacts(wo({ completedAt: '2026-11-03T12:00:00Z', invoiceTotalCents: 40_000, invoiceLaborCents: 40_000 }), { timezone: TZ, billingParty: 'portal' });
    const r = checkBeforeSending(facts, approvedPack(), NOW);
    expect(r.items).toEqual([]);
    expect(r.outcome).toBe('allow');
    expect(r.passed).toBeGreaterThan(0);
  });
});

describe('applyLineFix', () => {
  const lines = [{ category: 'labor' as const, amountCents: 1 }, { category: 'sales_tax' as const, amountCents: 2 }];
  const fix = { kind: 'remove_line_item' as const, label: 'x', oneClick: true, params: { index: 1 } };
  it('removes exactly the indexed line without mutating the input', () => {
    expect(applyLineFix(lines, fix)).toEqual([lines[0]]);
    expect(lines).toHaveLength(2);
  });
  it('ignores anything that is not a one-click line removal or has a bad index', () => {
    expect(applyLineFix(lines, { ...fix, oneClick: false })).toEqual(lines);
    expect(applyLineFix(lines, { ...fix, kind: 'create_proposal' })).toEqual(lines);
    expect(applyLineFix(lines, { ...fix, params: { index: 9 } })).toEqual(lines);
    expect(applyLineFix(lines, { ...fix, params: { index: -1 } })).toEqual(lines);
    expect(applyLineFix(lines, { ...fix, params: { index: 0.5 } })).toEqual(lines);
  });
});

describe('moneyAtRisk', () => {
  const r = SERVICECHANNEL_DEFAULTS;
  it('keeps measured and estimated apart and counts each order once', () => {
    const orders = [
      wo({ woNumber: 'A', completedAt: '2026-10-15T12:00:00Z', invoiceTotalCents: 100_000 }),            // overdue, measured
      wo({ woNumber: 'B', completedAt: '2026-10-15T12:00:00Z', estimateCents: 30_000 }),                  // overdue, estimated
      wo({ woNumber: 'C', completedAt: '2026-10-15T12:00:00Z' }),                                          // overdue, no amount
      wo({ woNumber: 'D', nteCents: 50_000, estimateCents: 80_000, completedAt: '2026-11-03T12:00:00Z' }), // NTE overrun 300.00, estimated
    ];
    const m = moneyAtRisk(orders, r, TZ, NOW);
    expect(m.measuredCents).toBe(100_000);
    expect(m.estimatedCents).toBe(30_000 + 30_000);
    expect(m.unknownCount).toBe(1);
    expect(m.byBucket.invoice_overdue.count).toBe(3);
    expect(m.byBucket.nte_overrun).toMatchObject({ count: 1, estimatedCents: 30_000 });
    const d = m.items.filter((i) => i.woNumber === 'D');
    expect(d.filter((i) => i.counted)).toHaveLength(1);
  });
  it('does not double count an order that falls in two buckets', () => {
    const o = wo({ woNumber: 'E', completedAt: '2026-10-01T12:00:00Z', receivedAt: '2026-07-01T12:00:00Z', invoiceTotalCents: 10_000 });
    const m = moneyAtRisk([o], r, TZ, NOW);
    expect(m.items.length).toBeGreaterThan(1);
    expect(m.items.filter((i) => i.counted)).toHaveLength(1);
    expect(m.measuredCents).toBe(10_000);
    expect(m.items.find((i) => i.counted)!.bucket).toBe('ineligible');
  });
  it('ignores orders that are not open, and flags work done under an unapproved proposal', () => {
    const closed = ['paid', 'approved', 'cancelled', 'rejected', 'expired'] as const;
    const orders = closed.map((outcome, i) => wo({ woNumber: `X${i}`, outcome, completedAt: '2026-10-01T12:00:00Z', invoiceTotalCents: 5_000 }));
    expect(moneyAtRisk(orders, r, TZ, NOW).items).toEqual([]);
    const p = moneyAtRisk([wo({ woNumber: 'P', proposalStatus: 'pending', proposalAmountCents: 22_000, checkedInAt: '2026-11-04T12:00:00Z' })], r, TZ, NOW);
    expect(p.byBucket.proposal_not_approved).toMatchObject({ count: 1, estimatedCents: 22_000 });
  });
  it('is empty when nothing is at risk', () => expect(moneyAtRisk([wo({ completedAt: '2026-11-04T12:00:00Z', invoiceTotalCents: 1 })], r, TZ, NOW)).toMatchObject({ items: [], measuredCents: 0, estimatedCents: 0, unknownCount: 0 }));
});

describe('suggestRuleCandidates', () => {
  const rej = (reason: string | null, outcome: WorkOrder['outcome'] = 'rejected') => wo({ outcome, outcomeReason: reason });
  it('groups reasons, needs repeated evidence and never invents a rule from a single rejection', () => {
    const orders = [rej('Sales tax not allowed'), rej('Invoice includes TAX line'), rej('Missing subcontractor invoice backup')];
    const c = suggestRuleCandidates(orders, []);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ candidateKey: 'sales-tax', kind: 'fm_prohibited_line_item', evidenceCount: 2, alreadyCovered: false });
    expect(c[0].suggestedParams).toEqual({ categories: ['sales_tax'] });
  });
  it('flags a candidate already covered by an approved or in-review rule, ignores non-rejected orders and empty reasons', () => {
    const orders = [rej('over NTE'), rej('Exceeds the NTE amount'), rej('exceeds nte', 'paid'), rej(null), rej('   ')];
    const covered = suggestRuleCandidates(orders, approvedPack());
    expect(covered).toHaveLength(1);
    expect(covered[0]).toMatchObject({ kind: 'fm_nte_cap', evidenceCount: 2, alreadyCovered: true });
    const inReview = approvedPack().map((v) => ({ ...v, status: 'in_review' as const }));
    expect(suggestRuleCandidates(orders, inReview)[0].alreadyCovered).toBe(true);
    const retired = approvedPack().map((v) => ({ ...v, status: 'retired' as const }));
    expect(suggestRuleCandidates(orders, retired)[0].alreadyCovered).toBe(false);
  });
  it('truncates long examples and returns plain data only (no rule is created)', () => {
    const long = `duplicate invoice ${'x'.repeat(300)}`;
    const c = suggestRuleCandidates([rej(long), rej(long)], []);
    expect(c[0].exampleReasons[0].length).toBeLessThanOrEqual(160);
    expect(Object.keys(c[0]).sort()).toEqual(['alreadyCovered', 'candidateKey', 'evidenceCount', 'exampleReasons', 'kind', 'suggestedParams']);
  });
});
