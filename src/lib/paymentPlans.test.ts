import { describe, expect, it } from 'vitest';
import {
  addMonths, buildSchedule, dollarsToCents, dueLabel, filterPlans, lateFeeFor, planProgress, validatePlanInput,
  type InstallmentRow, type PlanInput, type PlanRow,
} from './paymentPlans';

const TODAY = '2026-10-10';
const input = (over: Partial<PlanInput> = {}): PlanInput & { customer_name: string; customer_email: string; customer_phone: string } => ({
  total_cents: 100000, deposit_cents: 25000, installment_count: 3, frequency: 'monthly', first_due_date: '2026-11-01',
  late_fee_type: 'none', late_fee_value: 0, late_fee_cap_cents: 0, grace_days: 3, auto_charge: true,
  customer_name: 'Jane Roe', customer_email: 'jane@example.com', customer_phone: '', ...over,
});
const inst = (over: Partial<InstallmentRow>): InstallmentRow => ({
  id: 'i', plan_id: 'p', seq: 1, kind: 'installment', amount_cents: 25000, late_fee_cents: 0, due_date: '2026-10-20', status: 'scheduled',
  attempt_count: 0, next_attempt_at: null, paid_at: null, paid_cents: 0, payment_method: null, last_error: null, ...over,
});
const plan = (over: Partial<PlanRow>, items: InstallmentRow[] = []): PlanRow => ({
  id: 'p', user_id: 'u', job_id: null, customer_name: 'Jane Roe', customer_email: null, customer_phone: null, currency: 'usd', total_cents: 100000, deposit_cents: 0,
  installment_count: 4, frequency: 'monthly', first_due_date: '2026-10-20', late_fee_type: 'none', late_fee_value: 0, late_fee_cap_cents: 0, grace_days: 3, auto_charge: true,
  max_charge_attempts: 3, retry_interval_days: 2, status: 'active', authorization_url: null, authorization_sent_at: null, terms_text: null, terms_accepted_at: null,
  stripe_payment_method_id: null, notes: null, created_at: '2026-10-01T00:00:00Z', canceled_at: null, payment_plan_installments: items, ...over,
});

describe('buildSchedule', () => {
  it('always sums to the total, giving remainder cents to the earliest installments', () => {
    const s = buildSchedule({ total_cents: 100000, deposit_cents: 10001, installment_count: 3, frequency: 'monthly', first_due_date: '2026-11-01' }, TODAY);
    expect(s.map((x) => x.amount_cents)).toEqual([10001, 30000, 30000, 29999]);
    expect(s.reduce((a, x) => a + x.amount_cents, 0)).toBe(100000);
    const odd = buildSchedule({ total_cents: 10000, deposit_cents: 0, installment_count: 3, frequency: 'weekly', first_due_date: '2026-11-01' }, TODAY);
    expect(odd.map((x) => x.amount_cents)).toEqual([3334, 3333, 3333]);
  });
  it('puts the deposit due today as seq 0 and spaces dates by frequency', () => {
    const s = buildSchedule({ total_cents: 90000, deposit_cents: 30000, installment_count: 3, frequency: 'biweekly', first_due_date: '2026-11-01' }, TODAY);
    expect(s[0]).toMatchObject({ seq: 0, kind: 'deposit', due_date: TODAY });
    expect(s.slice(1).map((x) => x.due_date)).toEqual(['2026-11-01', '2026-11-15', '2026-11-29']);
  });
  it('clamps month-end dates like Postgres does, without drifting', () => {
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonths('2027-01-31', 2)).toBe('2027-03-31');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-12-15', 2)).toBe('2027-02-15');
  });
});

describe('validatePlanInput', () => {
  it('accepts a sound plan', () => expect(validatePlanInput(input(), TODAY)).toEqual({}));
  it('requires contact info, a future date and a deposit below the total', () => {
    const e = validatePlanInput(input({ first_due_date: '2026-10-01', deposit_cents: 100000 }), TODAY);
    expect(e.first_due_date).toBeTruthy();
    expect(e.deposit).toBeTruthy();
    expect(validatePlanInput({ ...input(), customer_email: '' }, TODAY).contact).toBeTruthy();
  });
  it('forces auto-charge when there is no deposit and enforces the 5.00 installment floor', () => {
    expect(validatePlanInput(input({ deposit_cents: 0, auto_charge: false }), TODAY).auto_charge).toBeTruthy();
    expect(validatePlanInput(input({ total_cents: 1000, deposit_cents: 0, installment_count: 4 }), TODAY).count).toMatch(/at least/);
  });
  it('bounds late fees (<= 25%)', () => {
    expect(validatePlanInput(input({ late_fee_type: 'percent', late_fee_value: 30 }), TODAY).late_fee).toBeTruthy();
    expect(validatePlanInput(input({ late_fee_type: 'percent', late_fee_value: 5 }), TODAY).late_fee).toBeUndefined();
    expect(validatePlanInput(input({ late_fee_type: 'flat', late_fee_value: 20000 }), TODAY).late_fee).toMatch(/at most/);
    expect(validatePlanInput(input({ late_fee_type: 'flat', late_fee_value: 2500 }), TODAY).late_fee).toBeUndefined();
  });
});

describe('helpers', () => {
  it('parses money strictly', () => {
    expect(dollarsToCents('1,250.5')).toBe(125050);
    expect(dollarsToCents('$99')).toBe(9900);
    expect(dollarsToCents('12.345')).toBeNull();
    expect(dollarsToCents('-5')).toBeNull();
    expect(dollarsToCents('abc')).toBeNull();
  });
  it('previews late fees with caps', () => {
    expect(lateFeeFor({ late_fee_type: 'percent', late_fee_value: 5, late_fee_cap_cents: 0 }, 30000)).toBe(1500);
    expect(lateFeeFor({ late_fee_type: 'percent', late_fee_value: 10, late_fee_cap_cents: 2000 }, 50000)).toBe(2000);
    expect(lateFeeFor({ late_fee_type: 'none', late_fee_value: 9, late_fee_cap_cents: 0 }, 50000)).toBe(0);
  });
  it('computes progress ignoring canceled/waived and finds the next open installment', () => {
    const items = [inst({ seq: 1, status: 'paid', paid_at: '2026-10-01T00:00:00Z' }), inst({ seq: 2, due_date: '2026-11-01' }), inst({ seq: 3, due_date: '2026-10-25' }), inst({ seq: 4, status: 'canceled' })];
    const p = planProgress(items);
    expect(p).toMatchObject({ paidCents: 25000, totalCents: 75000, pct: 33 });
    expect(p.next?.seq).toBe(3);
  });
  it('labels due state', () => {
    expect(dueLabel(inst({ due_date: '2026-10-08' }), TODAY)).toEqual({ label: '2 days overdue', tone: 'danger' });
    expect(dueLabel(inst({ due_date: '2026-10-10' }), TODAY).label).toBe('Due today');
    expect(dueLabel(inst({ due_date: '2026-10-11' }), TODAY).label).toBe('Due tomorrow');
    expect(dueLabel(inst({ due_date: '2026-10-14' }), TODAY).label).toBe('Due in 4 days');
    expect(dueLabel(inst({ status: 'paid', paid_at: '2026-10-02T10:00:00Z' }), TODAY).tone).toBe('success');
  });
  it('filters tabs and ranks overdue plans first', () => {
    const overdue = plan({ id: 'o', created_at: '2026-09-01T00:00:00Z' }, [inst({ due_date: '2026-10-01' })]);
    const fine = plan({ id: 'f', created_at: '2026-10-05T00:00:00Z' }, [inst({ due_date: '2026-11-01' })]);
    const waiting = plan({ id: 'w', status: 'pending_authorization' });
    const done = plan({ id: 'd', status: 'completed' });
    expect(filterPlans([fine, waiting, overdue, done], 'all', '', TODAY).map((p) => p.id)).toEqual(['o', 'w', 'f', 'd']);
    expect(filterPlans([fine, overdue], 'overdue', '', TODAY).map((p) => p.id)).toEqual(['o']);
    expect(filterPlans([fine, waiting, done], 'approval', '', TODAY).map((p) => p.id)).toEqual(['w']);
    expect(filterPlans([fine, done], 'all', 'jane', TODAY)).toHaveLength(2);
    expect(filterPlans([fine], 'all', 'nobody', TODAY)).toHaveLength(0);
  });
});
