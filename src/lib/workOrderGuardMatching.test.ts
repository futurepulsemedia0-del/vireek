import { describe, expect, it } from 'vitest';
import { suggestDeposits, type DepositTxn } from './workOrderGuardMatching';
import type { WorkOrder } from './workOrderGuard';

const TZ = 'America/New_York';
const opts = { payerName: 'ServiceChannel', timezone: TZ, paymentTermsDays: 30 };

const wo = (id: string, number: string, cents: number, over: Partial<WorkOrder> = {}): WorkOrder => ({
  id, woNumber: `WO-${id}`, location: null, trade: null, priority: 'normal', nteCents: null, estimateCents: null,
  receivedAt: '2026-08-03T13:00:00.000Z', acceptedAt: null, declinedAt: null, checkedInAt: null, checkInDistanceMiles: null,
  proposalStatus: 'none', proposalAmountCents: null, proposalApprovedAt: null, completedAt: '2026-08-03T19:00:00.000Z',
  invoiceNumber: number, invoiceSubmittedAt: '2026-08-05T14:00:00.000Z', invoiceCount: 1, invoiceLaborCents: null, invoiceTechnicians: null,
  invoiceMaterialsCents: null, invoiceTripCents: null, invoiceFreightCents: null, invoiceTaxCents: null, invoiceMgmtFeeCents: null,
  invoiceTotalCents: cents, outcome: 'approved', outcomeReason: null, ...over,
});
const dep = (id: string, cents: number, name = 'ACH SERVICECHANNEL PAYMENT', postedDate = '2026-09-04'): DepositTxn =>
  ({ id, amountCents: cents, postedDate, name, merchantKey: 'servicechannel' });

describe('deposit matching (reuses _shared/bank/matching.ts)', () => {
  it('matches one deposit to one approved invoice of the same amount', () => {
    const [s] = suggestDeposits([wo('a', 'INV-1', 62500), wo('b', 'INV-2', 31000)], [dep('t1', 62500)], opts);
    expect(s.txn.id).toBe('t1');
    expect(s.orders.map((o) => o.id)).toEqual(['a']);
    expect(s.suggestion.method).toBe('exact_single');
    expect(s.suggestion.confidence).toBeGreaterThan(0.9);
  });
  it('matches one deposit to several invoices that add up exactly', () => {
    const [s] = suggestDeposits([wo('a', 'INV-1', 62500), wo('b', 'INV-2', 31000), wo('c', 'INV-3', 4400)], [dep('t1', 93500)], opts);
    expect(s.orders.map((o) => o.id).sort()).toEqual(['a', 'b']);
    expect(s.suggestion.method).toBe('subset_unique');
  });
  it('uses the invoice number when the bank description mentions it', () => {
    const [s] = suggestDeposits([wo('a', 'INV-20481', 10000), wo('b', 'INV-20482', 10000)], [dep('t1', 10000, 'SERVICECHANNEL INV-20482')], opts);
    expect(s.orders.map((o) => o.id)).toEqual(['b']);
    expect(s.suggestion.method).toBe('reference');
  });
  it('only considers APPROVED invoices with an amount, and only deposits (money in)', () => {
    const orders = [wo('a', 'INV-1', 5000, { outcome: 'paid' }), wo('b', 'INV-2', 5000, { outcome: 'rejected' }), wo('c', 'INV-3', 0), wo('d', 'INV-4', 5000, { id: undefined })];
    expect(suggestDeposits(orders, [dep('t1', 5000), dep('t2', -5000)], opts)).toEqual([]);
  });
  it('never offers the same invoice for two deposits', () => {
    const out = suggestDeposits([wo('a', 'INV-1', 5000), wo('b', 'INV-2', 5000)], [dep('t1', 5000, 'SERVICECHANNEL', '2026-09-04'), dep('t2', 5000, 'SERVICECHANNEL', '2026-09-05')], opts);
    expect(out).toHaveLength(2);
    expect(new Set(out.flatMap((s) => s.orders.map((o) => o.id))).size).toBe(2);
  });
  it('returns nothing when no combination fits', () => {
    expect(suggestDeposits([wo('a', 'INV-1', 5000)], [dep('t1', 7777, 'RANDOM CUSTOMER')], opts)).toEqual([]);
  });
  it('works without a payer name (lower confidence, still suggested)', () => {
    const [s] = suggestDeposits([wo('a', 'INV-1', 5000)], [dep('t1', 5000)], { ...opts, payerName: null });
    expect(s.orders[0].id).toBe('a');
  });
});
