import { describe, expect, it } from 'vitest';
import { buildTerms, chargeIdempotencyKey, computeLateFee, nextReminder, reminderMessage } from './logic';

const base = { kind: 'installment', status: 'scheduled', due_date: '2026-10-20', reminders_sent: [] as string[], auto_charge: false };

describe('nextReminder', () => {
  it('sends the 3-day heads-up once, never for deposits', () => {
    expect(nextReminder(base, '2026-10-17')?.stage).toBe('upcoming_3d');
    expect(nextReminder(base, '2026-10-16')).toBeNull(); // 4 days out
    expect(nextReminder({ ...base, reminders_sent: ['upcoming_3d'] }, '2026-10-18')).toBeNull();
    expect(nextReminder({ ...base, kind: 'deposit' }, '2026-10-17')).toBeNull();
  });
  it('skips the due-day reminder for pending auto-charges but not after a failed charge', () => {
    expect(nextReminder({ ...base, auto_charge: true }, '2026-10-20')).toBeNull();
    expect(nextReminder({ ...base, auto_charge: true, status: 'failed' }, '2026-10-20')?.stage).toBe('due');
    expect(nextReminder(base, '2026-10-20')?.stage).toBe('due');
  });
  it('escalates overdue reminders and never back-fills older stages', () => {
    expect(nextReminder(base, '2026-10-21')?.stage).toBe('overdue_1d');
    expect(nextReminder(base, '2026-10-27')?.stage).toBe('overdue_7d');
    const late = nextReminder(base, '2026-11-10');
    expect(late?.stage).toBe('overdue_14d');
    expect(late?.mark).toEqual(['upcoming_3d', 'due', 'overdue_1d', 'overdue_7d', 'overdue_14d']);
    expect(nextReminder({ ...base, reminders_sent: ['overdue_1d'] }, '2026-10-22')).toBeNull();
  });
});

describe('computeLateFee', () => {
  it('handles flat, percent, cap and none', () => {
    expect(computeLateFee({ late_fee_type: 'none', late_fee_value: 0, late_fee_cap_cents: 0 }, 50000)).toBe(0);
    expect(computeLateFee({ late_fee_type: 'flat', late_fee_value: 2500, late_fee_cap_cents: 0 }, 50000)).toBe(2500);
    expect(computeLateFee({ late_fee_type: 'percent', late_fee_value: 5, late_fee_cap_cents: 0 }, 33333)).toBe(1667);
    expect(computeLateFee({ late_fee_type: 'percent', late_fee_value: 10, late_fee_cap_cents: 3000 }, 100000)).toBe(3000);
  });
});

describe('terms, messages, keys', () => {
  const terms = buildTerms({
    business_name: 'Cool Air', customer_name: 'Jane Roe', currency: 'usd', total_cents: 120000, deposit_cents: 30000, installment_count: 3,
    installment_cents: [30000, 30000, 30000], first_due_date: '2026-11-01', frequency: 'monthly', auto_charge: true,
    late_fee_type: 'flat', late_fee_value: 2500, late_fee_cap_cents: 0, grace_days: 3,
  });
  it('states every material term the customer is consenting to', () => {
    expect(terms).toContain('total $1,200.00');
    expect(terms).toContain('Deposit today: $300.00');
    expect(terms).toContain('3 payments of $300.00 every month');
    expect(terms).toContain('authorize automatic charges');
    expect(terms).toContain('late fee of $25.00');
    expect(terms).toContain('3 days after its due date');
  });
  it('says so when there are no late fees', () => {
    expect(buildTerms({ customer_name: 'A', currency: 'usd', total_cents: 1000, deposit_cents: 0, installment_count: 1, installment_cents: [1000], first_due_date: '2026-11-01', frequency: 'weekly', auto_charge: true, late_fee_type: 'none', late_fee_value: 0, late_fee_cap_cents: 0, grace_days: 0 })).toContain('No late fees apply.');
  });
  it('includes the late fee in overdue reminders and the link in manual ones', () => {
    const m = reminderMessage('overdue_7d', { name: 'Jane', amountCents: 30000, lateFeeCents: 2500, currency: 'usd', dueDate: '2026-10-20', autoCharge: false, link: 'https://x/pay' });
    expect(m.text).toContain('$325.00');
    expect(m.text).toContain('includes a $25.00 late fee');
    expect(m.text).toContain('https://x/pay');
  });
  it('builds a stable idempotency key per attempt', () => {
    expect(chargeIdempotencyKey('abc', 2)).toBe('pplan-abc-2');
  });
});
