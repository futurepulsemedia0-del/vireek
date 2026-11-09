import { describe, it, expect } from 'vitest';
import { consolidate, dueDate, validateTerms, type BillableItem } from './billing';

describe('dueDate', () => {
  it('handles net days across month and year ends', () => {
    expect(dueDate('2027-12-20', { kind: 'net', days: 30 })).toBe('2028-01-19');
    expect(dueDate('2027-01-31', { kind: 'net', days: 30 })).toBe('2027-03-02');
  });
  it('net_eom counts from the end of the issue month (leap year too)', () => {
    expect(dueDate('2028-02-10', { kind: 'net_eom', days: 15 })).toBe('2028-03-15');
    expect(dueDate('2027-02-10', { kind: 'net_eom', days: 0 })).toBe('2027-02-28');
  });
  it('due on receipt = issue date', () => expect(dueDate('2027-06-07', { kind: 'due_on_receipt' })).toBe('2027-06-07'));
  it('rejects bad terms and bad dates', () => {
    expect(validateTerms({ kind: 'net', days: -1 }).length).toBe(1);
    expect(validateTerms({ kind: 'net', days: 181 }).length).toBe(1);
    expect(() => dueDate('2027-02-30', { kind: 'net', days: 1 })).toThrow(RangeError);
    expect(() => dueDate('nope', { kind: 'net', days: 1 })).toThrow(RangeError);
  });
});

const item = (id: string, over: Partial<BillableItem> = {}): BillableItem => ({ id, customerId: 'c1', issuedOn: '2027-06-10', subtotalCents: 10_000, taxCents: 800, ...over });

describe('consolidate', () => {
  const terms = { kind: 'net', days: 30 } as const;
  it('groups a customer\'s month into one statement with exact totals and net-30 due date', () => {
    const [s, ...rest] = consolidate([item('a'), item('b', { issuedOn: '2027-06-28', subtotalCents: 5_001, taxCents: 400 }), item('c', { issuedOn: '2027-07-01' })], { cadence: 'monthly', terms });
    expect(rest).toHaveLength(1); // July is separate
    expect({ periodStart: s.periodStart, periodEnd: s.periodEnd, issueOn: s.issueOn, dueOn: s.dueOn, subtotalCents: s.subtotalCents, taxCents: s.taxCents, totalCents: s.totalCents, itemIds: s.itemIds })
      .toEqual({ periodStart: '2027-06-01', periodEnd: '2027-06-30', issueOn: '2027-06-30', dueOn: '2027-07-30', subtotalCents: 15_001, taxCents: 1_200, totalCents: 16_201, itemIds: ['a', 'b'] });
  });
  it('splits by PO when asked, and keeps unspecified POs together', () => {
    const out = consolidate([item('a', { poNumber: 'PO-1' }), item('b', { poNumber: 'PO-2' }), item('c', { poNumber: ' PO-1 ' })], { cadence: 'monthly', splitByPo: true, terms });
    expect(out.map((s) => [s.poNumber, s.itemIds.length])).toEqual([['PO-1', 2], ['PO-2', 1]]);
  });
  it('weekly periods run Monday–Sunday', () => {
    const [s] = consolidate([item('a', { issuedOn: '2027-06-13' })], { cadence: 'weekly', terms }); // a Sunday
    expect(s.periodStart).toBe('2027-06-07');
    expect(s.periodEnd).toBe('2027-06-13');
  });
  it('never mixes customers; per_invoice keeps same-day invoices apart', () => {
    expect(consolidate([item('a'), item('b', { customerId: 'c2' })], { cadence: 'monthly', terms })).toHaveLength(2);
    expect(consolidate([item('a'), item('b')], { cadence: 'per_invoice', terms })).toHaveLength(2);
  });
  it('is idempotent: duplicate input rows count once, order does not matter, keys are stable', () => {
    const a = consolidate([item('a'), item('b'), item('a')], { cadence: 'monthly', terms });
    const b = consolidate([item('b'), item('a')], { cadence: 'monthly', terms });
    expect(a).toEqual(b);
    expect(a[0].totalCents).toBe(21_600);
  });
  it('credits (negative subtotal) reduce the statement; fractional cents are rejected', () => {
    expect(consolidate([item('a'), item('cr', { subtotalCents: -2_500, taxCents: 0 })], { cadence: 'monthly', terms })[0].totalCents).toBe(8_300);
    expect(() => consolidate([item('a', { subtotalCents: 10.5 })], { cadence: 'monthly', terms })).toThrow(RangeError);
  });
});
