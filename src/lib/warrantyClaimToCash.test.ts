import { describe, expect, it } from 'vitest';
import {
  buildTransitionPatch, canTransition, daysUnpaid, isUnpaidBeyond, missingLabel,
  nextStatuses, normalizeStatus, paymentVariance, transitionErrorMessage,
} from './warrantyClaimToCash';

describe('status machine', () => {
  it('maps legacy statuses', () => {
    expect(normalizeStatus('eligible')).toBe('needs_review');
    expect(normalizeStatus('packet_pending')).toBe('ready');
    expect(normalizeStatus('credit_received')).toBe('paid');
  });
  it('allows the full happy path', () => {
    const path = ['needs_review', 'ready', 'submitted', 'approved', 'paid', 'closed'];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
  });
  it('rejects skips and backwards moves', () => {
    expect(canTransition('needs_review', 'submitted')).toBe(false);
    expect(canTransition('ready', 'paid')).toBe(false);
    expect(canTransition('submitted', 'paid')).toBe(false);
    expect(canTransition('paid', 'approved')).toBe(false);
    expect(nextStatuses('closed')).toEqual([]);
  });
  it('allows denied and expired from submitted', () => {
    expect(canTransition('submitted', 'denied')).toBe(true);
    expect(canTransition('submitted', 'expired')).toBe(true);
  });
});

describe('paymentVariance', () => {
  it('computes short-pay vs approved and estimate', () => {
    const v = paymentVariance(40000, 50000, 45000);
    expect(v).toEqual({ vsEstimateCents: -10000, vsApprovedCents: -5000, shortPaid: true, overPaid: false });
  });
  it('flags overpay', () => {
    expect(paymentVariance(50000, 40000, 45000).overPaid).toBe(true);
  });
  it('is null (not guessed) when inputs unknown', () => {
    expect(paymentVariance(40000, null, undefined)).toEqual({ vsEstimateCents: null, vsApprovedCents: null, shortPaid: false, overPaid: false });
  });
  it('exact pay is neither short nor over', () => {
    const v = paymentVariance(45000, 45000, 45000);
    expect(v.shortPaid || v.overPaid).toBe(false);
    expect(v.vsEstimateCents).toBe(0);
  });
});

describe('aging', () => {
  const now = new Date('2028-03-31T00:00:00Z');
  it('counts days for submitted/approved only', () => {
    expect(daysUnpaid('submitted', '2028-03-01T00:00:00Z', now)).toBe(30);
    expect(daysUnpaid('approved', '2028-03-21T00:00:00Z', now)).toBe(10);
    expect(daysUnpaid('paid', '2028-03-01T00:00:00Z', now)).toBeNull();
    expect(daysUnpaid('submitted', null, now)).toBeNull();
    expect(daysUnpaid('submitted', 'garbage', now)).toBeNull();
  });
  it('lists submitted > N days unpaid', () => {
    const rows = [
      { id: 'a', status: 'submitted', submitted_at: '2028-02-01T00:00:00Z' },
      { id: 'b', status: 'submitted', submitted_at: '2028-03-25T00:00:00Z' },
      { id: 'c', status: 'paid', submitted_at: '2028-01-01T00:00:00Z' },
    ];
    expect(isUnpaidBeyond(rows, 30, now).map((r) => r.id)).toEqual(['a']);
  });
});

describe('transition patch and errors', () => {
  it('builds required fields per target', () => {
    expect(buildTransitionPatch('submitted', { claimNumber: ' R-1 ' })).toEqual({ status: 'submitted', claim_number: 'R-1' });
    expect(buildTransitionPatch('paid', { paidCents: 100, paidAt: '2028-03-01' })).toEqual({ status: 'paid', credit_received_cents: 100, credit_received_at: '2028-03-01' });
    expect(buildTransitionPatch('denied', { denialReason: ' no ' })).toEqual({ status: 'denied', denial_reason: 'no' });
  });
  it('maps DB error codes and labels', () => {
    expect(transitionErrorMessage('invalid_claim_transition: ready -> paid')).toMatch(/not allowed/);
    expect(transitionErrorMessage('boom')).toBe('Could not update status');
    expect(missingLabel('checklist:defect_photo')).toBe('Checklist: defect photo');
    expect(missingLabel('serial_number')).toBe('Serial number');
  });
});
