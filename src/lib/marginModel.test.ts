import { describe, it, expect } from 'vitest';
import { revenueFor, marginAt, projectPlan, breakEvenMinutes, rateSensitivity, enterpriseQuote, reconcile, freeTierCostPerSignup, type PlanTerms } from './marginModel';
import { evaluateGuardrail, effectiveMaxCallSeconds } from '../../supabase/functions/_shared/billing/costGuardrail';

const starter: PlanTerms = { planId: 'starter', priceUsd: 79, includedMinutes: 400, overageRateUsd: 0.2 };
const free: PlanTerms = { planId: 'free', priceUsd: 0, includedMinutes: 50, overageRateUsd: null };

describe('revenue and margin', () => {
  it('adds overage only beyond included minutes', () => {
    expect(revenueFor(starter, 400)).toBe(79);
    expect(revenueFor(starter, 500)).toBeCloseTo(99);
    expect(revenueFor(free, 80)).toBe(0);
  });
  it('margin at usage', () => {
    const m = marginAt(starter, 400, 0.1);
    expect(m.costUsd).toBeCloseTo(40);
    expect(m.marginPct).toBeCloseTo((39 / 79) * 100);
    expect(marginAt(free, 10, 0.1).marginPct).toBeNull();
  });
});

describe('projection', () => {
  it('uses historical percentiles and reports negative share', () => {
    const pr = projectPlan(starter, [100, 200, 300, 400, 1000], 0.25);
    expect(pr.sampleSize).toBe(5);
    expect(pr.p50?.minutes).toBe(300);
    expect(pr.negativeShare).toBeCloseTo(0.4); // 400 and 1000 min are negative at $0.25/min
  });
  it('never invents usage', () => {
    const pr = projectPlan(starter, [], 0.25);
    expect(pr.p50).toBeNull();
    expect(pr.negativeShare).toBeNull();
  });
});

describe('break-even', () => {
  it('inside included minutes', () => expect(breakEvenMinutes(starter, 0.25)).toBeCloseTo(316));
  it('never negative when overage covers cost', () => expect(breakEvenMinutes(starter, 0.1)).toBeNull());
  it('beyond included when overage < cost', () => {
    const p: PlanTerms = { planId: 'x', priceUsd: 100, includedMinutes: 100, overageRateUsd: 0.1 };
    expect(breakEvenMinutes(p, 0.5)).toBeCloseTo((100 - 100 * 0.1) / (0.5 - 0.1));
  });
  it('null when cost per minute is not positive', () => expect(breakEvenMinutes(starter, 0)).toBeNull());
});

describe('sensitivity', () => {
  it('higher provider cost lowers margin', () => {
    const r = rateSensitivity(starter, [300, 400, 500], 0.1, [-10, 0, 50]);
    expect(r[2].p50MarginPct!).toBeLessThan(r[0].p50MarginPct!);
  });
});

describe('enterprise quote', () => {
  it('computes the floor for a target margin', () => {
    const q = enterpriseQuote({ minutesPerMonth: 10000, costPerMinuteUsd: 0.1, fixedCostUsd: 200, targetMarginPct: 60 });
    expect(q.costToServeUsd).toBe(1200);
    expect(q.priceFloorUsd).toBeCloseTo(3000);
    expect(q.floorPerMinuteUsd).toBeCloseTo(0.3);
  });
  it('rejects invalid input', () => {
    expect(() => enterpriseQuote({ minutesPerMonth: 1, costPerMinuteUsd: 1, fixedCostUsd: 0, targetMarginPct: 100 })).toThrow(RangeError);
    expect(() => enterpriseQuote({ minutesPerMonth: -1, costPerMinuteUsd: 1, fixedCostUsd: 0, targetMarginPct: 10 })).toThrow(RangeError);
  });
});

describe('reconcile', () => {
  it('flags drift over threshold', () => {
    expect(reconcile(110, 100, 5).status).toBe('drift');
    expect(reconcile(103, 100, 5).status).toBe('ok');
    expect(reconcile(10, null, 5).status).toBe('no_invoice');
    expect(reconcile(0, 0, 5).status).toBe('ok');
    expect(reconcile(5, 0, 5).status).toBe('drift');
  });
  it('free-tier cost per signup', () => {
    expect(freeTierCostPerSignup([])).toBeNull();
    expect(freeTierCostPerSignup([1, 3])).toBe(2);
  });
});

describe('guardrail', () => {
  const limits = { softCostUsd: 20, hardCostUsd: 40, maxCallSeconds: 900 };
  it('alerts on minutes and soft cost', () => {
    expect(evaluateGuardrail({ usedMinutes: 85, includedMinutes: 100, monthCostUsd: 1, limits, isEmergency: false }).minutesAlert).toBe(80);
    expect(evaluateGuardrail({ usedMinutes: 1, includedMinutes: 100, monthCostUsd: 25, limits, isEmergency: false }).level).toBe('soft');
  });
  it('hard limit restricts only non-emergency', () => {
    expect(evaluateGuardrail({ usedMinutes: 1, includedMinutes: 100, monthCostUsd: 50, limits, isEmergency: false }).action).toBe('restrict_non_emergency');
    expect(evaluateGuardrail({ usedMinutes: 1, includedMinutes: 100, monthCostUsd: 50, limits, isEmergency: true }).action).toBe('none');
  });
  it('no limits configured means no cost action', () => {
    expect(evaluateGuardrail({ usedMinutes: 1, includedMinutes: 100, monthCostUsd: 999, limits: null, isEmergency: false }).action).toBe('none');
  });
  it('call cap never applies to emergencies', () => {
    expect(effectiveMaxCallSeconds(limits, false)).toBe(900);
    expect(effectiveMaxCallSeconds(limits, true)).toBeNull();
    expect(effectiveMaxCallSeconds({ ...limits, maxCallSeconds: null }, false)).toBeNull();
  });
});
