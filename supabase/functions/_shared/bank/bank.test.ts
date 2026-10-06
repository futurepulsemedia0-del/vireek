import { describe, it, expect } from 'vitest';
import { merchantKey, maskPii, nameSimilarity, addDays } from './normalize';
import { suggestMatches, findSubsets, isAutoApplicable } from './matching';
import { detectRecurring, projectCash } from './forecast';
import type { MatchContext, MatchTxn } from './types';

const txn = (over: Partial<MatchTxn>): MatchTxn => ({ id: 't', amountCents: 0, postedDate: '2026-10-01', name: '', merchantKey: null, ...over });
const emptyCtx: MatchContext = { invoices: [], bills: [], unlinkedPayments: [] };
const inv = (id: string, number: string, cents: number, customer: string, due = '2026-10-05') =>
  ({ id, number, customerId: customer, customerName: customer, balanceCents: cents, dueDate: due });

describe('normalize', () => {
  it('builds a stable merchant key without store numbers', () => {
    expect(merchantKey('SHELL OIL 57444212345')).toBe('shell oil');
    expect(merchantKey('POS PURCHASE SQ *JOES DINER 4421')).toBe('joes diner');
    expect(merchantKey('12')).toBeNull();
  });
  it('masks account-like numbers and emails', () => {
    expect(maskPii('ACH 123456789012 bob@x.com')).toBe('ACH # <email>');
  });
  it('scores party-name similarity', () => {
    expect(nameSimilarity('ACH ACME CORP PAYMENT', 'Acme Heating')).toBeGreaterThanOrEqual(0.5);
    expect(nameSimilarity('ACH ACME CORP', 'Beta LLC')).toBe(0);
  });
});

describe('findSubsets', () => {
  it('finds exact subsets and respects max size', () => {
    expect(findSubsets([400000, 320000, 400000, 150000], 1120000)).toHaveLength(1);
    expect(findSubsets([5, 5, 10], 10)).toHaveLength(2);
    expect(findSubsets([5, 5, 5], 15, 2)).toHaveLength(0);
  });
});

describe('suggestMatches (inflows)', () => {
  const invoices = [inv('1', 'INV-202610-0001', 400000, 'Acme'), inv('2', 'INV-202610-0002', 320000, 'Acme'), inv('3', 'INV-202610-0003', 400000, 'Acme'), inv('4', 'INV-202610-0004', 150000, 'Beta')];

  it('matches a deposit to multiple invoices of the same named customer', () => {
    const s = suggestMatches(txn({ amountCents: 1120000, name: 'ACH ACME CORP' }), { ...emptyCtx, invoices });
    expect(s[0].kind).toBe('ar');
    expect(s[0].items.map((i) => i.invoiceId).sort()).toEqual(['1', '2', '3']);
    expect(s[0].confidence).toBeGreaterThanOrEqual(0.95);
    expect(isAutoApplicable(s, 0.95)).toBe(true);
  });

  it('prefers an explicit invoice reference with top confidence', () => {
    const s = suggestMatches(txn({ amountCents: 150000, name: 'WIRE INV-202610-0004' }), { ...emptyCtx, invoices });
    expect(s[0].method).toBe('reference');
    expect(s[0].confidence).toBe(0.99);
  });

  it('refuses to auto-apply when several invoices share the amount and no name disambiguates', () => {
    const twins = [inv('a', 'INV-A-0001', 50000, 'Gamma'), inv('b', 'INV-B-0002', 50000, 'Delta')];
    const s = suggestMatches(txn({ amountCents: 50000, name: 'MOBILE DEPOSIT' }), { ...emptyCtx, invoices: twins });
    expect(s.length).toBeGreaterThan(0);
    expect(isAutoApplicable(s, 0.9)).toBe(false);
  });

  it('treats a processor payout as net of fees', () => {
    const s = suggestMatches(txn({ amountCents: 145500, name: 'STRIPE TRANSFER', merchantKey: 'stripe' }), { ...emptyCtx, invoices });
    const fee = s.find((x) => x.method === 'processor_fee');
    expect(fee?.feeCents).toBe(4500);
    expect(isAutoApplicable(s, 0.5)).toBe(false);
  });

  it('links an already recorded manual payment instead of double counting', () => {
    const s = suggestMatches(txn({ amountCents: 80000, name: 'CHECK DEPOSIT' }), {
      ...emptyCtx,
      unlinkedPayments: [{ id: 'p1', kind: 'ar', amountCents: 80000, paymentDate: '2026-09-29', partyName: 'Acme' }],
    });
    expect(s[0].kind).toBe('ar_payment');
  });
});

describe('suggestMatches (outflows)', () => {
  it('matches a withdrawal to a vendor bill', () => {
    const s = suggestMatches(txn({ amountCents: -250000, name: 'FERGUSON SUPPLY ACH' }), {
      ...emptyCtx,
      bills: [{ id: 'b1', number: 'BILL-1', vendorId: 'v', vendorName: 'Ferguson Enterprises', balanceCents: 250000, dueDate: '2026-10-03' }],
    });
    expect(s[0].kind).toBe('ap');
    expect(s[0].confidence).toBeGreaterThanOrEqual(0.95);
  });
});

describe('forecast', () => {
  it('detects monthly recurring outflows and ignores irregular ones', () => {
    const rent = ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'].map((date) => ({ merchantKey: 'landlord llc', amountCents: 250000, date, label: 'Landlord' }));
    const random = ['2026-06-03', '2026-06-20', '2026-09-15'].map((date) => ({ merchantKey: 'home depot', amountCents: 9000, date, label: 'Home Depot' }));
    const r = detectRecurring([...rent, ...random], '2026-10-03');
    expect(r).toHaveLength(1);
    expect(r[0].cadence).toBe('monthly');
    expect(r[0].nextDate).toBe('2026-10-01'.replace('10-01', '10-01') > '2026-10-03' ? '2026-10-01' : '2026-11-01');
  });

  it('computes runway and a no-collections worst case', () => {
    const today = '2026-10-03';
    const res = projectCash({
      today, horizonDays: 60, startingBalanceCents: 1000000, thresholdCents: 0,
      receivables: [{ id: 'r', balanceCents: 500000, dueDate: addDays(today, 30), customerKey: 'acme' }],
      payables: [{ id: 'p', balanceCents: 400000, dueDate: addDays(today, 5), vendorKey: null }],
      recurring: [], fixed: [{ label: 'Rent', amountCents: 450000, frequency: 'monthly', nextDueDate: addDays(today, 10) }],
      customerLagDays: { acme: 0 },
    });
    expect(res.days).toHaveLength(61);
    expect(res.runwayDaysNoCollections).not.toBeNull();
    expect(res.lowestBalanceCents).toBeLessThan(1000000);
    expect((res.runwayDaysExpected ?? 99)).toBeGreaterThanOrEqual(res.runwayDaysNoCollections ?? 0);
  });
});
