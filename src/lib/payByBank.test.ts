import { describe, it, expect } from 'vitest';
import {
  ATTEMPT_STATUS_META, describeProblem, describeSettlement, formatCents, matchesAttemptTab, needsLedgerReview, type AttemptRow,
} from './payByBank';

const row = (o: Partial<AttemptRow> = {}): AttemptRow => ({
  id: 'a1', customer_name: 'Ann', rail: 'ach_debit', amount_cents: 50000, fee_estimate_cents: 400, card_fee_estimate_cents: 1480,
  status: 'processing', verification_method: 'instant', failure_code: null, failure_message: null, return_code: null, retryable: null,
  bank_name: 'Chase', account_last4: '6789', expected_settlement_date: '2026-10-30', settled_at: null, accounting_status: 'pending',
  accounting_error: null, payment_request_id: 'r1', installment_id: null, membership_id: null, created_at: '2026-10-26T00:00:00Z', ...o,
});

describe('formatCents', () => {
  it('formats dollars with grouping and sign', () => {
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(-250)).toBe('-$2.50');
  });
});

describe('tabs', () => {
  it('splits in-flight, problems and ledger review', () => {
    expect(matchesAttemptTab(row(), 'in_flight')).toBe(true);
    expect(matchesAttemptTab(row({ status: 'verification_required' }), 'attention')).toBe(true);
    expect(matchesAttemptTab(row({ status: 'failed' }), 'problems')).toBe(true);
    expect(matchesAttemptTab(row({ status: 'succeeded', accounting_status: 'posted' }), 'attention')).toBe(false);
    expect(matchesAttemptTab(row({ status: 'succeeded', accounting_status: 'unlinked' }), 'review')).toBe(true);
    expect(matchesAttemptTab(row({ status: 'succeeded', accounting_status: 'unlinked' }), 'attention')).toBe(true);
    expect(matchesAttemptTab(row({ status: 'canceled' }), 'all')).toBe(true);
  });
  it('flags a failed reversal as ledger review', () => {
    expect(needsLedgerReview(row({ status: 'returned', accounting_status: 'failed' }))).toBe(true);
    expect(needsLedgerReview(row({ status: 'returned', accounting_status: 'reversed' }))).toBe(false);
  });
});

describe('describeProblem', () => {
  it('uses friendly copy for known codes and falls back safely', () => {
    expect(describeProblem(row({ status: 'failed', failure_code: 'insufficient_funds' }))).toBe('Insufficient funds');
    expect(describeProblem(row({ status: 'failed', failure_code: 'weird', failure_message: 'Bank said no' }))).toBe('Bank said no');
    expect(describeProblem(row({ status: 'failed' }))).toBe('The bank payment failed');
    expect(describeProblem(row({ status: 'returned', return_code: 'insufficient_funds' }))).toBe('Bank return: Insufficient funds');
    expect(describeProblem(row({ status: 'disputed', return_code: 'debit_not_authorized' }))).toBe('Customer dispute: Debits not authorized');
    expect(describeProblem(row({ status: 'succeeded' }))).toBeNull();
  });
});

describe('describeSettlement', () => {
  it('describes each phase without timezone drift', () => {
    expect(describeSettlement(row())).toBe('Expected Oct 30');
    expect(describeSettlement(row({ expected_settlement_date: null }))).toBe('Expected in 1–4 business days');
    expect(describeSettlement(row({ status: 'succeeded', settled_at: '2026-10-28T23:30:00Z' }))).toBe('Settled Oct 28');
    expect(describeSettlement(row({ status: 'verification_required' }))).toMatch(/verify/);
    expect(describeSettlement(row({ status: 'failed' }))).toBe('—');
  });
});

describe('status meta', () => {
  it('covers every status', () => {
    for (const s of ['verification_required', 'processing', 'succeeded', 'failed', 'returned', 'disputed', 'canceled'] as const) {
      expect(ATTEMPT_STATUS_META[s].label).toBeTruthy();
    }
  });
});
