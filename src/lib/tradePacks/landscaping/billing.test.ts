import { describe, it, expect } from 'vitest';
import { buildInvoiceDraft, planBatch, activeDaysInPeriod, periodBounds, idempotencyKey, taxCentsFor, type BillingContract } from './billing.ts';
import type { VisitRow } from './types.ts';

const c = (o: Partial<BillingContract> = {}): BillingContract => ({ id: 'c1', title: 'Lawn care', billing_mode: 'per_visit', monthly_fee_cents: 24000, tax_percent: 0, start_date: '2027-01-01', end_date: null, pauses: [], status: 'active', ...o });
const v = (id: string, date: string, o: Partial<VisitRow> = {}): VisitRow => ({ id, contract_id: 'c1', addon_id: null, kind: 'maintenance', status: 'completed', skip_reason: null, visit_date: date, scheduled_at: `${date}T14:00:00Z`, crew_id: 'k1', crew_size: 2, route_position: 1, planned_minutes: 45, started_at: null, completed_at: null, price_cents: 5000, billed_invoice_id: null, tasks_total: 0, tasks_done: 0, ...o });

describe('landscaping billing: per visit', () => {
  it('bills completed unbilled visits, ignores skipped/billed/other-contract', () => {
    const out = buildInvoiceDraft(c(), [v('a', '2027-04-05'), v('b', '2027-04-12'), v('s', '2027-04-19', { status: 'skipped' }), v('x', '2027-04-26', { billed_invoice_id: 'inv' }), v('o', '2027-04-27', { contract_id: 'c2' })], '2027-04');
    expect(out.kind).toBe('invoice');
    if (out.kind !== 'invoice') return;
    expect(out.draft.visitIds).toEqual(['a', 'b']);
    expect(out.draft.totalCents).toBe(10000);
    expect(out.draft.idempotencyKey).toBe('c1:2027-04');
  });
  it('late completions from earlier months roll into the next run; future visits do not', () => {
    const out = buildInvoiceDraft(c(), [v('late', '2027-03-29'), v('fut', '2027-05-03')], '2027-04');
    expect(out.kind === 'invoice' && out.draft.visitIds).toEqual(['late']);
  });
  it('adds tax in integer cents and bills add-ons', () => {
    const out = buildInvoiceDraft(c({ tax_percent: 8.25 }), [v('a', '2027-04-05', { price_cents: 3333 }), v('n', '2027-04-06', { kind: 'addon', price_cents: 6500 })], '2027-04');
    if (out.kind !== 'invoice') throw new Error('expected invoice');
    expect(out.draft.subtotalCents).toBe(9833);
    expect(out.draft.taxCents).toBe(811);
    expect(out.draft.totalCents).toBe(10644);
    expect(Number.isInteger(out.draft.totalCents)).toBe(true);
    expect(taxCentsFor(1000, 0)).toBe(0);
  });
  it('nothing to bill → no invoice; draft contracts and bad periods are not billable', () => {
    expect(buildInvoiceDraft(c(), [], '2027-04').kind).toBe('nothing_to_bill');
    expect(buildInvoiceDraft(c({ status: 'draft' }), [v('a', '2027-04-05')], '2027-04').kind).toBe('not_billable');
    expect(buildInvoiceDraft(c(), [], '2027-13').kind).toBe('not_billable');
  });
});

describe('landscaping billing: monthly flat + pause/resume', () => {
  it('full month = full fee; flat visits marked billed but not itemised', () => {
    const out = buildInvoiceDraft(c({ billing_mode: 'monthly_flat' }), [v('a', '2027-04-05'), v('n', '2027-04-06', { kind: 'addon', price_cents: 6500 })], '2027-04');
    if (out.kind !== 'invoice') throw new Error('expected invoice');
    expect(out.draft.lines.map((l) => l.unit_price_cents)).toEqual([24000, 6500]);
    expect(out.draft.visitIds.sort()).toEqual(['a', 'n']);
  });
  it('prorates paused days, counting overlapping pauses once', () => {
    const contract = c({ billing_mode: 'monthly_flat', pauses: [{ from: '2027-04-11', to: '2027-04-20' }, { from: '2027-04-16', to: '2027-04-25' }] });
    expect(activeDaysInPeriod(contract, '2027-04')).toEqual({ active: 15, total: 30 });
    const out = buildInvoiceDraft(contract, [], '2027-04');
    expect(out.kind === 'invoice' && out.draft.lines[0].unit_price_cents).toBe(12000);
  });
  it('open-ended pause bills nothing; resume month bills from resume day; mid-month start prorates', () => {
    expect(buildInvoiceDraft(c({ billing_mode: 'monthly_flat', pauses: [{ from: '2027-04-01', to: null }] }), [], '2027-04').kind).toBe('nothing_to_bill');
    expect(activeDaysInPeriod(c({ pauses: [{ from: '2027-04-01', to: '2027-04-09' }] }), '2027-04').active).toBe(21);
    expect(activeDaysInPeriod(c({ start_date: '2027-04-16' }), '2027-04').active).toBe(15);
    expect(activeDaysInPeriod(c({ end_date: '2027-04-10' }), '2027-04').active).toBe(10);
  });
  it('period bounds handle leap years', () => {
    expect(periodBounds('2028-02').end).toBe('2028-02-29');
  });
});

describe('landscaping billing: batch idempotency', () => {
  const contracts = [c({ id: 'c1' }), c({ id: 'c2' }), c({ id: 'c3' }), c({ id: 'c4', status: 'draft' })];
  const visits = new Map<string, VisitRow[]>([
    ['c1', [v('a', '2027-04-05')]],
    ['c2', [v('b', '2027-04-05', { contract_id: 'c2' })]],
    ['c3', []],
    ['c4', [v('d', '2027-04-05', { contract_id: 'c4' })]],
  ]);
  it('first run creates, second run with stored keys creates nothing', () => {
    const first = planBatch(contracts, visits, '2027-04', new Set());
    expect(first.created.map((d) => d.contractId)).toEqual(['c1', 'c2']);
    expect(first.nothingToBill).toEqual(['c3']);
    expect(first.notBillable).toEqual(['c4']);
    const stored = new Set(first.created.map((d) => d.idempotencyKey));
    const second = planBatch(contracts, visits, '2027-04', stored);
    expect(second.created).toEqual([]);
    expect(second.skippedExisting).toEqual(['c1', 'c2']);
  });
  it('is deterministic regardless of input order, and one key per contract+month', () => {
    const a = planBatch([...contracts].reverse(), visits, '2027-04', new Set());
    const b = planBatch(contracts, visits, '2027-04', new Set());
    expect(a).toEqual(b);
    expect(idempotencyKey('c1', '2027-04')).not.toBe(idempotencyKey('c1', '2027-05'));
  });
});
