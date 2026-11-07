import { describe, it, expect } from 'vitest';
import {
  decideBooking, decideFinancing, decideInvoicePaid, ruleForTargetTable, RULES,
} from './attribution';
import { estimateProportion, wilsonInterval } from './intervals';

const H = 3_600_000;
const T0 = new Date('2026-11-01T12:00:00Z');
const at = (h: number) => new Date(T0.getTime() + h * H);

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('ruleForTargetTable', () => {
  it('maps the three supported targets and nothing else', () => {
    expect(ruleForTargetTable('workflow_runs')).toBe('booking_after_sms');
    expect(ruleForTargetTable('financing_offers')).toBe('financing_offer_acceptance');
    expect(ruleForTargetTable('invoices')).toBe('invoice_paid_after_action');
    expect(ruleForTargetTable('jobs')).toBeNull();
    expect(ruleForTargetTable(null)).toBeNull();
  });
});

describe('decideBooking', () => {
  const base = { executedAt: T0, otherTouchAt: [] as Date[] };
  it('credits a job strictly after the action inside the window', () => {
    const d = decideBooking({ ...base, now: at(100), jobCreatedAt: [at(10)] });
    expect(d.outcome).toBe('success');
    expect(d.state).toBe('final');
  });
  it('never credits a job that preceded the action', () => {
    const d = decideBooking({ ...base, now: at(100), jobCreatedAt: [at(-5)] });
    expect(d.outcome).toBe('no_effect');
    expect(d.flags).toContain('outcome_preceded_action');
  });
  it('treats a job at the exact same instant as preceding (strictly-after rule)', () => {
    const d = decideBooking({ ...base, now: at(100), jobCreatedAt: [at(0)] });
    expect(d.outcome).toBe('no_effect');
  });
  it('a prior job blocks credit even if a later job also exists', () => {
    const d = decideBooking({ ...base, now: at(100), jobCreatedAt: [at(-1), at(5)] });
    expect(d.outcome).toBe('no_effect');
  });
  it('window end is inclusive; one millisecond later is outside', () => {
    const edge = decideBooking({ ...base, now: at(200), jobCreatedAt: [at(72)] });
    expect(edge.outcome).toBe('success');
    const out = decideBooking({ ...base, now: at(200), jobCreatedAt: [new Date(at(72).getTime() + 1)] });
    expect(out.outcome).toBe('no_effect');
  });
  it('stays pending while the window is open and no job exists', () => {
    const d = decideBooking({ ...base, now: at(10), jobCreatedAt: [] });
    expect(d.state).toBe('pending');
    expect(d.outcome).toBeNull();
  });
  it('closed window without a job is no_effect, not failure', () => {
    const d = decideBooking({ ...base, now: at(80), jobCreatedAt: [] });
    expect(d.state).toBe('final');
    expect(d.outcome).toBe('no_effect');
  });
  it('multi-touch inside the lookback is an unknown conflict', () => {
    const d = decideBooking({ ...base, now: at(100), jobCreatedAt: [at(30)], otherTouchAt: [at(20)] });
    expect(d.outcome).toBe('unknown');
    expect(d.conflict).toBe(true);
  });
  it('a touch AFTER the booking is not a conflict', () => {
    const d = decideBooking({ ...base, now: at(100), jobCreatedAt: [at(30)], otherTouchAt: [at(40)] });
    expect(d.outcome).toBe('success');
  });
  it('a touch older than the lookback is not a conflict', () => {
    const d = decideBooking({ ...base, now: at(300), jobCreatedAt: [at(60)], otherTouchAt: [at(-20)] });
    expect(d.outcome).toBe('success');
  });
  it('future-dated action resolves to unknown, never success', () => {
    const d = decideBooking({ ...base, executedAt: at(50), now: at(0), jobCreatedAt: [at(60)] });
    expect(d.outcome).toBe('unknown');
    expect(d.flags).toContain('executed_at_in_future');
  });
  it('missing executed_at resolves to unknown', () => {
    const d = decideBooking({ executedAt: null, now: at(0), jobCreatedAt: [at(1)], otherTouchAt: [] });
    expect(d.outcome).toBe('unknown');
  });
  it('future-dated jobs are ignored and flagged', () => {
    const d = decideBooking({ ...base, now: at(10), jobCreatedAt: [at(50)] });
    expect(d.state).toBe('pending');
    expect(d.flags).toContain('job_timestamp_in_future_ignored');
  });
  it('property: success implies a job strictly after executedAt within 72h, no earlier job', () => {
    const r = rng(42);
    for (let i = 0; i < 2000; i++) {
      const jobs = Array.from({ length: Math.floor(r() * 4) }, () => at(Math.floor(r() * 300) - 50));
      const touches = Array.from({ length: Math.floor(r() * 3) }, () => at(Math.floor(r() * 300) - 50));
      const now = at(Math.floor(r() * 400) - 20);
      const d = decideBooking({ executedAt: T0, now, jobCreatedAt: jobs, otherTouchAt: touches });
      if (d.outcome === 'success') {
        const valid = jobs.filter((j) => j.getTime() <= now.getTime());
        expect(valid.every((j) => j.getTime() > T0.getTime())).toBe(true);
        expect(valid.some((j) => j.getTime() <= T0.getTime() + RULES.booking_after_sms.windowHours * H)).toBe(true);
      }
      if (d.state === 'final' && d.outcome === 'success') expect(d.conflict).toBe(false);
    }
  });
});

describe('decideFinancing', () => {
  const b = { executedAt: T0, approvedAmountCents: 500000 };
  it('funded inside window is success with dollars', () => {
    const d = decideFinancing({ ...b, now: at(100), status: 'funded', statusUpdatedAt: at(50) });
    expect(d.outcome).toBe('success');
    expect(d.financialCents).toBe(500000);
  });
  it('loan_confirmed is success without dollars', () => {
    const d = decideFinancing({ ...b, now: at(100), status: 'loan_confirmed', statusUpdatedAt: at(50) });
    expect(d.outcome).toBe('success');
    expect(d.financialCents).toBeNull();
  });
  it('acceptance timestamp before the action is unknown, not success', () => {
    const d = decideFinancing({ ...b, now: at(100), status: 'funded', statusUpdatedAt: at(-1) });
    expect(d.outcome).toBe('unknown');
  });
  it('approved inside window is measured, then partial when the window closes', () => {
    expect(decideFinancing({ ...b, now: at(100), status: 'approved', statusUpdatedAt: at(50) }).state).toBe('measured');
    expect(decideFinancing({ ...b, now: at(400), status: 'approved', statusUpdatedAt: at(50) }).state).toBe('final');
  });
  it('declined is no_effect (lender decision is not an agent failure)', () => {
    expect(decideFinancing({ ...b, now: at(100), status: 'declined', statusUpdatedAt: at(50) }).outcome).toBe('no_effect');
  });
  it('sent and open stays pending, then no_effect after 14 days', () => {
    expect(decideFinancing({ ...b, now: at(100), status: 'sent', statusUpdatedAt: at(1) }).state).toBe('pending');
    expect(decideFinancing({ ...b, now: at(337), status: 'sent', statusUpdatedAt: at(1) }).outcome).toBe('no_effect');
  });
});

describe('decideInvoicePaid', () => {
  const b = { executedAt: T0 };
  it('paid after the action inside the window is success', () => {
    expect(decideInvoicePaid({ ...b, now: at(100), status: 'paid', paidAt: at(30) }).outcome).toBe('success');
  });
  it('paid before the action gets no credit', () => {
    const d = decideInvoicePaid({ ...b, now: at(100), status: 'paid', paidAt: at(-2) });
    expect(d.outcome).toBe('no_effect');
    expect(d.flags).toContain('outcome_preceded_action');
  });
  it('paid after the window is partial, not success', () => {
    expect(decideInvoicePaid({ ...b, now: at(2000), status: 'paid', paidAt: at(800) }).outcome).toBe('partial');
  });
  it('paid status with no paid_at is unknown', () => {
    expect(decideInvoicePaid({ ...b, now: at(100), status: 'paid', paidAt: null }).outcome).toBe('unknown');
  });
  it('unpaid stays pending then no_effect', () => {
    expect(decideInvoicePaid({ ...b, now: at(100), status: 'sent', paidAt: null }).state).toBe('pending');
    expect(decideInvoicePaid({ ...b, now: at(800), status: 'sent', paidAt: null }).outcome).toBe('no_effect');
  });
});

describe('idempotency', () => {
  it('same facts twice yield identical decisions', () => {
    const f = { executedAt: T0, now: at(100), jobCreatedAt: [at(10)], otherTouchAt: [] as Date[] };
    expect(decideBooking(f)).toEqual(decideBooking(f));
  });
});

describe('wilsonInterval / estimateProportion', () => {
  it('matches a known value (50/100 -> ~[0.404, 0.596])', () => {
    const ci = wilsonInterval(50, 100)!;
    expect(ci.lower).toBeCloseTo(0.4038, 3);
    expect(ci.upper).toBeCloseTo(0.5962, 3);
  });
  it('stays within [0,1] at the extremes', () => {
    const lo = wilsonInterval(0, 10)!;
    const hi = wilsonInterval(10, 10)!;
    expect(lo.lower).toBe(0);
    expect(hi.upper).toBe(1);
  });
  it('rejects invalid input', () => {
    expect(wilsonInterval(5, 0)).toBeNull();
    expect(wilsonInterval(11, 10)).toBeNull();
  });
  it('suppresses below minimum n and reports above it', () => {
    const small = estimateProportion(9, 10);
    expect(small.suppressed).toBe(true);
    expect(small.rate).toBeNull();
    const ok = estimateProportion(18, 30);
    expect(ok.suppressed).toBe(false);
    expect(ok.rate).toBeCloseTo(0.6, 5);
  });
  it('property: interval always contains the point estimate and narrows with n', () => {
    const r = rng(7);
    for (let i = 0; i < 1000; i++) {
      const n = 30 + Math.floor(r() * 500);
      const k = Math.floor(r() * (n + 1));
      const e = estimateProportion(k, n);
      expect(e.lower! <= e.rate! && e.rate! <= e.upper!).toBe(true);
    }
    const w = (n: number) => { const c = wilsonInterval(n / 2, n)!; return c.upper - c.lower; };
    expect(w(400)).toBeLessThan(w(40));
  });
});
