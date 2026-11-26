import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_DEFAULTS, attributeAll, attributeInvoice, billableDecisions, compareToBaseline, computeFee, isAtRisk,
  pctOfCents, pickTerms, validateFeeTerms, wilson95,
  type AttributionDecision, type AttributionRules, type BaselineMetrics, type FeeContext, type FeeTerms,
  type HumanConfirmation, type InvoiceFacts, type LoggedAction,
} from '../../../supabase/functions/_shared/results-plan/invoiceAttribution';

// FAKE numbers for testing only — not prices.
const R: AttributionRules = ATTRIBUTION_DEFAULTS;
const inv = (o: Partial<InvoiceFacts> = {}): InvoiceFacts => ({
  id: 'inv-1', issuedAt: '2026-01-01T00:00:00Z', dueAt: '2026-01-31T00:00:00Z', totalCents: 100_000, status: 'open',
  payments: [{ id: 'p1', at: '2026-03-01T00:00:00Z', cents: 100_000 }], rejectedAt: null, rejectionClearedAt: null,
  disputed: false, creditedCents: 0, isTest: false, ...o,
});
const act = (o: Partial<LoggedAction> = {}): LoggedAction => ({
  id: 'a1', invoiceId: 'inv-1', type: 'follow_up', at: '2026-02-15T00:00:00Z', actor: 'vireek', riskSnapshot: 'at_risk', ...o,
});
const human: HumanConfirmation = { invoiceId: 'inv-1', confirmedAt: '2026-03-02T00:00:00Z', confirmedBy: 'owner-1' };

describe('isAtRisk', () => {
  it('is not at risk at exactly the threshold, at risk beyond it', () => {
    expect(isAtRisk(inv(), '2026-01-31T00:00:00Z', R)).toBe(false); // exactly 30 days
    expect(isAtRisk(inv(), '2026-02-01T00:00:00Z', R)).toBe(true);
  });
  it('open rejection makes it at risk; cleared rejection does not', () => {
    const rejected = inv({ rejectedAt: '2026-01-05T00:00:00Z' });
    expect(isAtRisk(rejected, '2026-01-10T00:00:00Z', R)).toBe(true);
    expect(isAtRisk({ ...rejected, rejectionClearedAt: '2026-01-08T00:00:00Z' }, '2026-01-10T00:00:00Z', R)).toBe(false);
  });
  it('fully paid before the action means not at risk', () => {
    expect(isAtRisk(inv({ payments: [{ id: 'x', at: '2026-02-01T00:00:00Z', cents: 100_000 }] }), '2026-02-15T00:00:00Z', R)).toBe(false);
  });
});

describe('attribution matrix', () => {
  it('qualifies with a complete evidence chain', () => {
    const d = attributeInvoice(inv(), [act()], null, R);
    expect(d.qualifies).toBe(true);
    expect(d.confirmationBasis).toBe('evidence_chain');
    expect(d.recoveredCents).toBe(100_000);
    expect(d.primaryActionId).toBe('a1');
    expect(d.paymentIds).toEqual(['p1']);
  });
  it('(i) false: action by a human or another system', () => {
    expect(attributeInvoice(inv(), [act({ actor: 'human' })], null, R).reasons).toContain('no_vireek_action');
    expect(attributeInvoice(inv(), [], null, R).reasons).toContain('no_vireek_action');
    expect(attributeInvoice(inv(), [act({ invoiceId: 'other' })], null, R).qualifies).toBe(false);
  });
  it('(ii) false: not at risk at action time, even if the snapshot claims it was', () => {
    const d = attributeInvoice(inv(), [act({ at: '2026-01-20T00:00:00Z', riskSnapshot: 'at_risk' })], human, R);
    expect(d.reasons).toContain('not_at_risk_at_action');
    expect(d.qualifies).toBe(false);
  });
  it('(ii) true via rejection even when young', () => {
    const d = attributeInvoice(
      inv({ rejectedAt: '2026-01-05T00:00:00Z', payments: [{ id: 'p1', at: '2026-02-20T00:00:00Z', cents: 100_000 }] }),
      [act({ at: '2026-01-10T00:00:00Z' })], null, R,
    );
    expect(d.conditions.atRiskAtAction).toBe(true);
    expect(d.qualifies).toBe(true);
  });
  it('(iii) false: payment before the action', () => {
    const d = attributeInvoice(inv({ payments: [{ id: 'p1', at: '2026-02-10T00:00:00Z', cents: 50_000 }] }), [act()], human, R);
    expect(d.reasons).toContain('no_payment_after_action');
    expect(d.recoveredCents).toBe(0);
  });
  it('(iii) paid in full before the action means the invoice was never at risk', () => {
    const d = attributeInvoice(inv({ payments: [{ id: 'p1', at: '2026-02-10T00:00:00Z', cents: 100_000 }] }), [act()], human, R);
    expect(d.reasons).toContain('not_at_risk_at_action');
  });
  it('(iii) false: payment outside the attribution window', () => {
    const d = attributeInvoice(inv({ payments: [{ id: 'p1', at: '2026-06-01T00:00:00Z', cents: 100_000 }] }), [act()], human, R);
    expect(d.reasons).toContain('payment_outside_window');
  });
  it('(iii) false: paid within normal terms regardless of the action', () => {
    const d = attributeInvoice(
      inv({ rejectedAt: '2026-01-05T00:00:00Z', payments: [{ id: 'p1', at: '2026-01-25T00:00:00Z', cents: 100_000 }] }),
      [act({ at: '2026-01-10T00:00:00Z' })], human, R,
    );
    expect(d.reasons).toContain('paid_within_terms');
    expect(d.recoveredCents).toBe(0);
  });
  it('unknown due date never qualifies', () => {
    expect(attributeInvoice(inv({ dueAt: null }), [act()], human, R).reasons).toContain('due_date_unknown');
  });
  it('(iv) false: no human and incomplete chain', () => {
    const d = attributeInvoice(inv(), [act({ riskSnapshot: null })], null, R);
    expect(d.reasons).toContain('not_confirmed_or_incomplete_chain');
    expect(d.qualifies).toBe(false);
  });
  it('(iv) true via human confirmation even with an incomplete chain', () => {
    const d = attributeInvoice(inv(), [act({ riskSnapshot: null })], human, R);
    expect(d.qualifies).toBe(true);
    expect(d.confirmationBasis).toBe('human');
  });
  it('human_only mode rejects a complete chain without a human', () => {
    const d = attributeInvoice(inv(), [act()], null, { ...R, confirmationMode: 'human_only' });
    expect(d.reasons).toContain('not_confirmed_or_incomplete_chain');
  });
  it('blank or mismatched confirmation is ignored', () => {
    expect(attributeInvoice(inv(), [act({ riskSnapshot: null })], { ...human, confirmedBy: '  ' }, R).qualifies).toBe(false);
    expect(attributeInvoice(inv(), [act({ riskSnapshot: null })], { ...human, invoiceId: 'other' }, R).qualifies).toBe(false);
  });
});

describe('exclusions', () => {
  it.each([
    ['disputed', { disputed: true }, 'invoice_disputed'],
    ['credited', { creditedCents: 1 }, 'credited'],
    ['void', { status: 'void' as const }, 'invoice_void_or_written_off'],
    ['written off', { status: 'written_off' as const }, 'invoice_void_or_written_off'],
    ['test', { isTest: true }, 'test_invoice'],
  ])('%s invoice is excluded', (_n, o, reason) => {
    const d = attributeInvoice(inv(o), [act()], human, R);
    expect(d.qualifies).toBe(false);
    expect(d.recoveredCents).toBe(0);
    expect(d.reasons).toContain(reason);
  });
  it('invalid timestamps and amounts fail closed', () => {
    expect(attributeInvoice(inv({ issuedAt: 'nope' }), [act()], human, R).reasons).toEqual(['invalid_timestamp']);
    expect(attributeInvoice(inv(), [act({ at: 'x' })], human, R).reasons).toEqual(['invalid_timestamp']);
    expect(attributeInvoice(inv({ totalCents: 0 }), [act()], human, R).reasons).toEqual(['invalid_timestamp']);
    expect(attributeInvoice(inv({ payments: [{ id: 'p', at: '2026-03-01T00:00:00Z', cents: 1.5 }] }), [act()], human, R).qualifies).toBe(false);
  });
});

describe('double counting prevention', () => {
  it('two qualifying actions produce one outcome with the latest action before payment as primary', () => {
    const d = attributeInvoice(inv(), [act({ id: 'a1' }), act({ id: 'a2', at: '2026-02-20T00:00:00Z' }), act({ id: 'a3', at: '2026-03-05T00:00:00Z' })], null, R);
    expect(d.primaryActionId).toBe('a2');
    expect(d.recoveredCents).toBe(100_000);
  });
  it('partial payments sum and are capped at the invoice total', () => {
    const d = attributeInvoice(inv({ payments: [{ id: 'p1', at: '2026-03-01T00:00:00Z', cents: 70_000 }, { id: 'p2', at: '2026-03-02T00:00:00Z', cents: 70_000 }] }), [act()], null, R);
    expect(d.recoveredCents).toBe(100_000);
  });
  it('amounts already counted in earlier statements are subtracted', () => {
    expect(attributeInvoice(inv(), [act()], null, R, 40_000).recoveredCents).toBe(60_000);
    const d = attributeInvoice(inv(), [act()], null, R, 100_000);
    expect(d.qualifies).toBe(false);
    expect(d.reasons).toContain('already_counted');
  });
  it('a repeated invoice id in the input is excluded, not summed', () => {
    const ds = attributeAll([inv(), inv()], [act()], [], R);
    expect(ds).toHaveLength(1);
    expect(ds[0].reasons).toEqual(['duplicate_invoice_input']);
  });
  it('is deterministic regardless of input order', () => {
    const a = inv({ id: 'b' }); const b = inv({ id: 'a' });
    const acts = [act({ invoiceId: 'a' }), act({ id: 'a9', invoiceId: 'b' })];
    expect(attributeAll([a, b], acts, [], R)).toEqual(attributeAll([b, a], [...acts].reverse(), [], R));
  });
});

describe('contested lines', () => {
  it('are excluded from billable until resolved', () => {
    const ds = attributeAll([inv({ id: 'a' }), inv({ id: 'b' })], [act({ invoiceId: 'a' }), act({ id: 'a2', invoiceId: 'b' })], [], R);
    expect(billableDecisions(ds, new Set<string>()).map((d) => d.invoiceId)).toEqual(['a', 'b']);
    expect(billableDecisions(ds, new Set(['b'])).map((d) => d.invoiceId)).toEqual(['a']);
  });
});

// ---------------- fees ----------------

const T: FeeTerms = {
  version: 1, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null, model: 'recovered_pct', baseFeeCents: 1_000, pctBps: 1_000,
  perInvoiceCents: 500, outcomeFloorCents: 0, outcomeCapCents: null, monthlyMaxTotalCents: null, pilotFreeUntil: null, noFeeFirstDays: 0,
};
const dec = (id: string, cents: number, actionAt = '2026-02-15T00:00:00Z'): AttributionDecision => ({
  ...attributeInvoice(inv({ id, totalCents: cents, payments: [{ id: `p-${id}`, at: '2026-03-01T00:00:00Z', cents }] }), [act({ invoiceId: id, id: `a-${id}`, at: actionAt })], null, R),
});
const ctx = (o: Partial<FeeContext> = {}): FeeContext => ({
  enabled: true, suspendedReason: null, enrolledAt: '2026-01-01T00:00:00Z', periodStart: '2026-03-01T00:00:00Z', periodEnd: '2026-04-01T00:00:00Z',
  billable: [dec('a', 100_000)], firstPass: null, ...o,
});

describe('fee math', () => {
  it('rounds half-up in integer cents', () => {
    expect(pctOfCents(1, 5_000)).toBe(1);
    expect(pctOfCents(1, 4_999)).toBe(0);
    expect(pctOfCents(333, 1_000)).toBe(33);
    expect(pctOfCents(335, 1_000)).toBe(34);
  });
  it('percent model: lines + base, and totals reconcile', () => {
    const r = computeFee(T, ctx({ billable: [dec('a', 100_000), dec('b', 33_350)] }));
    expect(r.lines.map((l) => l.feeCents)).toEqual([10_000, 3_335]);
    expect(r.outcomeFeeCents).toBe(13_335);
    expect(r.totalCents).toBe(14_335);
    expect(r.adjustmentCents).toBe(0);
  });
  it('cap lowers the outcome fee and records the adjustment', () => {
    const r = computeFee({ ...T, outcomeCapCents: 4_000 }, ctx());
    expect(r.outcomeFeeCents).toBe(4_000);
    expect(r.appliedCap).toBe(true);
    expect(r.adjustmentCents).toBe(-6_000);
    expect(r.rawLinesCents + r.adjustmentCents).toBe(r.outcomeFeeCents);
  });
  it('floor applies only when there is a billable outcome', () => {
    const small = computeFee({ ...T, outcomeFloorCents: 5_000 }, ctx({ billable: [dec('a', 1_000)] }));
    expect(small.outcomeFeeCents).toBe(5_000);
    expect(small.appliedFloor).toBe(true);
    const none = computeFee({ ...T, outcomeFloorCents: 5_000 }, ctx({ billable: [] }));
    expect(none.outcomeFeeCents).toBe(0);
    expect(none.zeroReason).toBe('no_billable');
  });
  it('monthly maximum bounds base plus outcome', () => {
    const r = computeFee({ ...T, monthlyMaxTotalCents: 5_000 }, ctx());
    expect(r.totalCents).toBe(5_000);
    expect(r.appliedMonthlyMax).toBe(true);
    const tiny = computeFee({ ...T, monthlyMaxTotalCents: 500 }, ctx());
    expect(tiny.totalCents).toBe(500);
    expect(tiny.baseFeeCents).toBe(500);
  });
  it('pilot / first-N-days make events fee-free by action date', () => {
    const r = computeFee({ ...T, pilotFreeUntil: '2026-03-01T00:00:00Z' }, ctx());
    expect(r.lines[0].feeFree).toBe(true);
    expect(r.outcomeFeeCents).toBe(0);
    const n = computeFee({ ...T, noFeeFirstDays: 90 }, ctx({ periodEnd: '2026-03-15T00:00:00Z' }));
    expect(n.baseFeeCents).toBe(0);
    expect(n.outcomeFeeCents).toBe(0);
  });
  it('suspension zeroes the outcome fee only; kill switch zeroes everything', () => {
    const s = computeFee(T, ctx({ suspendedReason: 'data_quality_unreliable' }));
    expect(s.outcomeFeeCents).toBe(0);
    expect(s.baseFeeCents).toBe(1_000);
    expect(s.zeroReason).toBe('suspended');
    const k = computeFee(T, ctx({ enabled: false }));
    expect(k.totalCents).toBe(0);
    expect(k.zeroReason).toBe('disabled');
  });
  it('model none charges only the base', () => {
    const r = computeFee({ ...T, model: 'none', pctBps: 0, perInvoiceCents: 0 }, ctx());
    expect(r.totalCents).toBe(1_000);
    expect(r.zeroReason).toBe('model_none');
  });
  it('first-pass model charges only above baseline and fails closed without one', () => {
    const t: FeeTerms = { ...T, model: 'first_pass_per_invoice', pctBps: 0 };
    const r = computeFee(t, ctx({ billable: [], firstPass: { acceptedFirstPass: 90, submitted: 100, baselineRateBps: 8_000 } }));
    expect(r.firstPassBasis).toEqual({ expectedAtBaseline: 80, aboveBaseline: 10 });
    expect(r.outcomeFeeCents).toBe(5_000);
    expect(computeFee(t, ctx({ billable: [], firstPass: { acceptedFirstPass: 90, submitted: 100, baselineRateBps: null } })).zeroReason).toBe('baseline_missing');
    expect(computeFee(t, ctx({ billable: [], firstPass: null })).zeroReason).toBe('baseline_missing');
    expect(computeFee(t, ctx({ billable: [], firstPass: { acceptedFirstPass: 70, submitted: 100, baselineRateBps: 8_000 } })).outcomeFeeCents).toBe(0);
    expect(computeFee(t, ctx({ billable: [], firstPass: { acceptedFirstPass: 11, submitted: 10, baselineRateBps: 8_000 } })).zeroReason).toBe('invalid_terms');
  });
  it('invalid terms fail closed to zero', () => {
    expect(computeFee({ ...T, pctBps: -1 }, ctx()).totalCents).toBe(0);
  });
});

describe('terms validation and versioning', () => {
  it('accepts valid terms and rejects bad ones', () => {
    expect(validateFeeTerms(T)).toEqual([]);
    expect(validateFeeTerms({ ...T, pctBps: 10_001 })).toContain('pctBps');
    expect(validateFeeTerms({ ...T, outcomeFloorCents: 9, outcomeCapCents: 8 })).toContain('floor_above_cap');
    expect(validateFeeTerms({ ...T, pctBps: 0 })).toContain('pct_model_zero_rate');
    expect(validateFeeTerms({ ...T, model: 'none' })).toContain('none_model_has_outcome_price');
    expect(validateFeeTerms({ ...T, effectiveTo: '2025-01-01T00:00:00Z' })).toContain('effectiveTo');
  });
  it('picks the version in force at a given time', () => {
    const v1 = { ...T, version: 1, effectiveTo: '2026-06-01T00:00:00Z' };
    const v2 = { ...T, version: 2, effectiveFrom: '2026-06-01T00:00:00Z' };
    expect(pickTerms([v1, v2], '2026-05-31T23:59:59Z')?.version).toBe(1);
    expect(pickTerms([v1, v2], '2026-06-01T00:00:00Z')?.version).toBe(2);
    expect(pickTerms([v1, v2], '2025-12-31T00:00:00Z')).toBeNull();
    expect(pickTerms([v1], 'bad')).toBeNull();
  });
});

describe('baseline comparison', () => {
  const B: BaselineMetrics = { dsoDays: { value: 50, n: 80 }, over30ArCents: { value: 900_000, n: 80 }, firstPass: { accepted: 60, total: 100 } };
  it('baseline missing is reported honestly', () => {
    const c = compareToBaseline(null, B);
    expect(c.status).toBe('baseline_missing');
    expect(c.causal).toBe(false);
    expect(c.dso.change).toBe('insufficient_data');
  });
  it('small samples are labelled insufficient', () => {
    const c = compareToBaseline({ ...B, dsoDays: { value: 50, n: 5 } }, { ...B, dsoDays: { value: 40, n: 80 }, firstPass: { accepted: 3, total: 5 } });
    expect(c.dso.sample).toBe('insufficient');
    expect(c.dso.change).toBe('insufficient_data');
    expect(c.firstPass.change).toBe('insufficient_data');
  });
  it('clear first-pass improvement requires non-overlapping intervals', () => {
    const better = compareToBaseline(B, { ...B, dsoDays: { value: 42, n: 90 }, firstPass: { accepted: 90, total: 100 } });
    expect(better.status).toBe('compared');
    expect(better.firstPass.change).toBe('observed_higher');
    expect(better.dso.change).toBe('observed_lower');
    expect(better.causal).toBe(false);
    const noise = compareToBaseline(B, { ...B, firstPass: { accepted: 63, total: 100 } });
    expect(noise.firstPass.change).toBe('no_clear_change');
  });
  it('wilson interval is sane and guards bad input', () => {
    const w = wilson95(50, 100);
    expect(w).not.toBeNull();
    expect((w as [number, number])[0]).toBeLessThan(0.5);
    expect((w as [number, number])[1]).toBeGreaterThan(0.5);
    expect(wilson95(1, 0)).toBeNull();
    expect(wilson95(5, 3)).toBeNull();
  });
});
