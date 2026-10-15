import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  addDaysIso,
  bucketForDaysPastDue,
  bucketShares,
  contactHref,
  describeTiming,
  errMsg,
  hasSequenceErrors,
  isoToday,
  parseDollarsToCents,
  promiseKeptRate,
  renderTemplate,
  sortSteps,
  urgencyFor,
  usd,
  validatePromise,
  validateSequenceDraft,
  type BucketSummary,
  type SequenceDraft,
  type SequenceStep,
} from './collections';

const step = (over: Partial<SequenceStep> = {}): SequenceStep => ({
  days_after_due: 7, channel: 'email', subject: 'Hello', template: 'Pay {{balance}}', escalation_level: null, ...over,
});
const draft = (over: Partial<SequenceDraft> = {}): SequenceDraft => ({
  id: null, name: 'Standard', is_default: true, is_active: true, steps: [step()], ...over,
});

describe('usd / errMsg', () => {
  it('formats cents', () => {
    expect(usd(125050)).toBe('$1,250.50');
    expect(usd(0)).toBe('$0.00');
    expect(usd(-500)).toBe('-$5.00');
  });
  it('reads messages from Error and Postgrest-style errors', () => {
    expect(errMsg(new Error('x'))).toBe('x');
    expect(errMsg({ message: 'denied' })).toBe('denied');
    expect(errMsg(undefined)).toBe('Something went wrong.');
  });
});

describe('bucketForDaysPastDue', () => {
  it('matches the get_ar_aging boundaries', () => {
    expect(bucketForDaysPastDue(-5)).toBe('current');
    expect(bucketForDaysPastDue(0)).toBe('current');
    expect(bucketForDaysPastDue(1)).toBe('1-30');
    expect(bucketForDaysPastDue(30)).toBe('1-30');
    expect(bucketForDaysPastDue(31)).toBe('31-60');
    expect(bucketForDaysPastDue(60)).toBe('31-60');
    expect(bucketForDaysPastDue(61)).toBe('61-90');
    expect(bucketForDaysPastDue(90)).toBe('61-90');
    expect(bucketForDaysPastDue(91)).toBe('90+');
  });
});

describe('bucketShares', () => {
  const b = (bucket: BucketSummary['bucket'], balance_cents: number): BucketSummary => ({ bucket, count: 1, balance_cents });
  it('returns percentages that sum to 100', () => {
    const shares = bucketShares([b('current', 5000), b('1-30', 3000), b('31-60', 2000), b('61-90', 0), b('90+', 0)]);
    expect(shares.map((s) => s.pct)).toEqual([50, 30, 20, 0, 0]);
    expect(shares.reduce((s, x) => s + x.pct, 0)).toBe(100);
  });
  it('returns zeros when nothing is owed', () => {
    expect(bucketShares([b('current', 0), b('1-30', 0)]).map((s) => s.pct)).toEqual([0, 0]);
  });
});

describe('promiseKeptRate', () => {
  it('is kept / resolved, or null with no history', () => {
    expect(promiseKeptRate(3, 1)).toBe(0.75);
    expect(promiseKeptRate(0, 4)).toBe(0);
    expect(promiseKeptRate(0, 0)).toBeNull();
  });
});

describe('describeTiming', () => {
  it('words before, on and after the due date', () => {
    expect(describeTiming(-3)).toBe('3 days before due');
    expect(describeTiming(-1)).toBe('1 day before due');
    expect(describeTiming(0)).toBe('On the due date');
    expect(describeTiming(14)).toBe('14 days after due');
  });
});

describe('renderTemplate', () => {
  const vars = { customer_name: 'Dana Smith', invoice_number: 'INV-1042', balance_cents: 125000, due_date: '2027-03-05', days_overdue: 12, company_name: 'Cool Air Co' };
  it('fills every token, the same way the server does', () => {
    expect(renderTemplate('Hi {{customer_name}}, {{invoice_number}} for {{balance}} due {{due_date}} ({{days_overdue}}d) — {{company_name}}', vars)).toBe(
      'Hi Dana Smith, INV-1042 for $1,250.00 due Mar 05, 2027 (12d) — Cool Air Co',
    );
  });
  it('falls back for blank names/company, clamps negative days and leaves unknown tokens', () => {
    expect(renderTemplate('{{customer_name}}|{{company_name}}|{{days_overdue}}|{{nope}}', { ...vars, customer_name: '', company_name: '  ', days_overdue: -3 })).toBe(
      'there|our team|0|{{nope}}',
    );
  });
});

describe('parseDollarsToCents', () => {
  it('accepts clean amounts', () => {
    expect(parseDollarsToCents('250')).toBe(25000);
    expect(parseDollarsToCents('$1,250.5')).toBe(125050);
    expect(parseDollarsToCents(' 0.07 ')).toBe(7);
  });
  it('rejects junk', () => {
    for (const bad of ['', 'abc', '-5', '1.234', '1e3', '$', '1..2']) expect(parseDollarsToCents(bad)).toBeNull();
  });
});

describe('dates', () => {
  it('formats today and adds days across month ends', () => {
    expect(isoToday(new Date(2027, 0, 5))).toBe('2027-01-05');
    expect(addDaysIso('2027-01-31', 1)).toBe('2027-02-01');
    expect(addDaysIso('2027-03-01', -1)).toBe('2027-02-28');
    expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('validatePromise', () => {
  const today = '2027-03-10';
  it('accepts a valid promise and returns cents', () => {
    expect(validatePromise({ amount: '500', date: '2027-03-20' }, 125000, today)).toEqual({ errors: {}, amountCents: 50000 });
    expect(validatePromise({ amount: '1250', date: today }, 125000, today).errors).toEqual({});
  });
  it('rejects bad amounts', () => {
    expect(validatePromise({ amount: '', date: '2027-03-20' }, 125000, today).errors.amount).toBeTruthy();
    expect(validatePromise({ amount: '0', date: '2027-03-20' }, 125000, today).errors.amount).toBeTruthy();
    expect(validatePromise({ amount: '1250.01', date: '2027-03-20' }, 125000, today).errors.amount).toMatch(/open balance/);
  });
  it('rejects past, missing and too-distant dates', () => {
    expect(validatePromise({ amount: '5', date: '2027-03-09' }, 1000, today).errors.date).toBeTruthy();
    expect(validatePromise({ amount: '5', date: '' }, 1000, today).errors.date).toBeTruthy();
    expect(validatePromise({ amount: '5', date: '2027-09-06' }, 1000, today).errors.date).toBeUndefined();
    expect(validatePromise({ amount: '5', date: '2027-09-07' }, 1000, today).errors.date).toBeTruthy();
  });
});

describe('validateSequenceDraft', () => {
  it('accepts a valid draft', () => {
    expect(hasSequenceErrors(validateSequenceDraft(draft()))).toBe(false);
  });
  it('requires a name and at least one step, capped at 12', () => {
    expect(validateSequenceDraft(draft({ name: '  ' })).name).toBeTruthy();
    expect(validateSequenceDraft(draft({ steps: [] })).steps).toBeTruthy();
    expect(validateSequenceDraft(draft({ steps: Array.from({ length: 13 }, () => step()) })).steps).toMatch(/at most 12/);
  });
  it('checks timing range, messages and escalation level per step', () => {
    const e = validateSequenceDraft(
      draft({
        steps: [
          step({ days_after_due: 400 }),
          step({ template: '  ' }),
          step({ channel: 'escalate', escalation_level: null, template: '' }),
          step({ channel: 'call', template: '' }),
          step({ channel: 'escalate', escalation_level: 2, template: '' }),
        ],
      }),
    );
    expect(Object.keys(e.stepErrors).map(Number)).toEqual([0, 1, 2]);
    expect(hasSequenceErrors(e)).toBe(true);
  });
});

describe('sortSteps', () => {
  it('orders by timing and keeps ties in their original order', () => {
    const out = sortSteps([
      { days_after_due: 14, n: 'a' }, { days_after_due: -3, n: 'b' }, { days_after_due: 14, n: 'c' }, { days_after_due: 1, n: 'd' },
    ]);
    expect(out.map((s) => s.n)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('contactHref', () => {
  const c = { email: 'dana@example.com', phone: '(555) 010-2030', subject: 'Past due & urgent', body: 'Pay $50 now' };
  it('builds an encoded mailto for email and letters', () => {
    expect(contactHref('email', c)).toBe('mailto:dana%40example.com?subject=Past%20due%20%26%20urgent&body=Pay%20%2450%20now');
    expect(contactHref('letter', c)).toContain('mailto:');
    expect(contactHref('email', { ...c, email: null })).toBeNull();
  });
  it('builds sms/tel links from a cleaned phone number', () => {
    expect(contactHref('sms', c)).toBe('sms:5550102030?body=Pay%20%2450%20now');
    expect(contactHref('call', c)).toBe('tel:5550102030');
    expect(contactHref('call', { ...c, phone: '+1 555 010 2030' })).toBe('tel:+15550102030');
    expect(contactHref('sms', { ...c, phone: null })).toBeNull();
  });
  it('has no link for escalations or notes', () => {
    expect(contactHref('escalate', c)).toBeNull();
    expect(contactHref('note', c)).toBeNull();
  });
});

describe('urgencyFor', () => {
  it('rises with age and escalation', () => {
    expect(urgencyFor(5)).toBe('low');
    expect(urgencyFor(31)).toBe('medium');
    expect(urgencyFor(61)).toBe('high');
    expect(urgencyFor(91)).toBe('critical');
    expect(urgencyFor(5, 1)).toBe('high');
    expect(urgencyFor(5, 2)).toBe('critical');
  });
});
