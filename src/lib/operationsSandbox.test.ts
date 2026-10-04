import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ASSUMPTIONS,
  PRESETS,
  SIM,
  calibrateBaseline,
  defaultBaseline,
  defaultLever,
  deltaTone,
  formatDelta,
  percentile,
  resolveLevers,
  runScenario,
  sanitizeAssumptions,
  type Baseline,
  type BaselineKey,
  type LeverInstance,
} from './operationsSandbox';

const KEYS: BaselineKey[] = ['jobsPerMonth', 'avgTicket', 'technicians', 'capacity', 'sla', 'calls', 'bookRate', 'rework', 'churn', 'daysToPay'];

function twin(over: Partial<Baseline> = {}, measured = true): Baseline {
  return calibrateBaseline({
    jobsPerMonth: 300,
    avgTicket: 480,
    technicians: 6,
    jobsPerTechMonth: SIM.defaultJobsPerDay * SIM.practicalUtilization * SIM.workdays,
    slaOnTimePct: 90,
    callsPerMonth: 520,
    missedCallRate: 0.2,
    bookRate: 0.4,
    reworkRate: 0.07,
    churnMonthlyPct: 2.4,
    daysToPay: 16,
    provenance: Object.fromEntries(KEYS.map((k) => [k, measured ? 'measured' : 'assumed'])) as Baseline['provenance'],
    sample: { jobs: 900, calls: 1500, customers: 400, windowMonths: 3 },
    ...over,
  });
}

const A = DEFAULT_ASSUMPTIONS;
const hire = (count: number): LeverInstance => ({ type: 'hire_technicians', params: { count, rampMonths: 2 } });
const price = (pct: number): LeverInstance => ({ type: 'price_change', params: { pct } });

describe('calibrateBaseline', () => {
  it('never lets today\'s volume exceed today\'s capacity', () => {
    const b = calibrateBaseline({ ...twin(), jobsPerMonth: 2000, technicians: 3, jobsPerTechMonth: 40 });
    expect(b.jobsPerMonth / (b.technicians * b.jobsPerTechMonth)).toBeLessThanOrEqual(SIM.capacityCeiling);
  });

  it('clamps unrealistic inputs', () => {
    const b = calibrateBaseline({ ...twin(), missedCallRate: 5, churnMonthlyPct: 99, technicians: 0 });
    expect(b.missedCallRate).toBeLessThanOrEqual(0.95);
    expect(b.churnMonthlyPct).toBeLessThanOrEqual(15);
    expect(b.technicians).toBeGreaterThanOrEqual(1);
  });

  it('default twin is fully assumed and self-consistent', () => {
    const b = defaultBaseline();
    expect(Object.values(b.provenance).every((p) => p === 'assumed')).toBe(true);
    expect(b.jobsPerMonth).toBeLessThan(b.technicians * b.jobsPerTechMonth);
  });
});

describe('runScenario: no change', () => {
  it('produces zero deltas and an inconclusive verdict', () => {
    const r = runScenario(twin(), A, []);
    expect(r.verdict.key).toBe('inconclusive');
    for (const v of Object.values(r.deltas)) expect(Math.abs(v)).toBeLessThan(1e-6);
    expect(r.risks).toHaveLength(0);
  });

  it('keeps the baseline steady month to month', () => {
    const r = runScenario(twin(), A, []);
    expect(r.baselineTimeline[0].revenue).toBeCloseTo(r.baselineTimeline[SIM.horizonMonths - 1].revenue, 6);
    expect(r.baselineTimeline[0].revenue).toBeCloseTo(300 * 480, 0);
  });
});

describe('runScenario: determinism and ranges', () => {
  it('returns identical output for identical inputs', () => {
    const a = runScenario(twin(), A, PRESETS[0].levers);
    const b = runScenario(twin(), A, PRESETS[0].levers);
    expect(a.ranges).toEqual(b.ranges);
    expect(a.probability).toEqual(b.probability);
  });

  it('orders every range p10 <= p50 <= p90', () => {
    const r = runScenario(twin(), A, [price(8), hire(2)]);
    for (const range of Object.values(r.ranges)) {
      expect(range.p10).toBeLessThanOrEqual(range.p50 + 1e-9);
      expect(range.p50).toBeLessThanOrEqual(range.p90 + 1e-9);
    }
  });

  it('keeps probabilities within 0..1', () => {
    const r = runScenario(twin(), A, [hire(3)]);
    expect(r.probability.runRateUplift).toBeGreaterThanOrEqual(0);
    expect(r.probability.runRateUplift).toBeLessThanOrEqual(1);
  });
});

describe('hiring', () => {
  it('adds cost but no revenue when capacity is not the constraint', () => {
    const b = twin({ jobsPerMonth: 200 });
    const r = runScenario(b, A, [hire(3)]);
    expect(r.deltas.revenue).toBeCloseTo(0, 0);
    expect(r.deltas.marginPct).toBeLessThan(0);
    expect(r.projected.utilizationPct).toBeLessThan(r.baseline.utilizationPct);
    expect(r.risks.some((x) => x.key === 'idle')).toBe(true);
    expect(r.cash.trough).toBeLessThan(0);
  });

  it('turns waiting demand into revenue when the team is saturated', () => {
    const b = twin({ jobsPerMonth: 600, technicians: 5 });
    const r = runScenario(b, A, [hire(3)]);
    expect(r.deltas.revenue).toBeGreaterThan(0);
    expect(r.projected.slaPct).toBeGreaterThan(r.baseline.slaPct);
  });

  it('charges the hire cost immediately but ramps productivity', () => {
    const b = twin({ jobsPerMonth: 600, technicians: 5 });
    const r = runScenario(b, A, [hire(3)]);
    expect(r.timeline[0].headcount).toBe(r.timeline[SIM.horizonMonths - 1].headcount);
    expect(r.timeline[0].capacity).toBeLessThan(r.timeline[SIM.horizonMonths - 1].capacity);
    expect(r.timeline[0].oneTimeCost).toBeCloseTo(3 * A.recruitCost, 6);
    expect(r.timeline[1].oneTimeCost).toBe(0);
  });
});

describe('pricing', () => {
  it('a price rise lifts margin and lowers volume', () => {
    const r = runScenario(twin(), A, [price(10)]);
    expect(r.deltas.marginPct).toBeGreaterThan(0);
    expect(r.projected.jobs).toBeLessThan(r.baseline.jobs);
    expect(r.deltas.churnPct).toBeGreaterThan(0);
  });

  it('a more elastic market punishes a price rise harder', () => {
    const soft = runScenario(twin(), { ...A, priceElasticity: -0.3 }, [price(10)]);
    const hard = runScenario(twin(), { ...A, priceElasticity: -1.8 }, [price(10)]);
    expect(hard.deltas.revenue).toBeLessThan(soft.deltas.revenue);
  });
});

describe('AI call coverage', () => {
  it('recovers missed calls into booked jobs', () => {
    const r = runScenario(twin(), A, [{ type: 'ai_call_coverage', params: { pct: 20 } }]);
    expect(r.deltas.revenue).toBeGreaterThan(0);
    expect(r.drivers.length).toBeGreaterThan(0);
  });

  it('does nothing extra when no calls are missed', () => {
    const r = runScenario(twin({ missedCallRate: 0 }), A, [{ type: 'ai_call_coverage', params: { pct: 20 } }]);
    expect(Math.abs(r.deltas.revenue)).toBeLessThan(500);
  });
});

describe('SLA target', () => {
  it('a tighter promise on a stretched team is flagged as risky', () => {
    const r = runScenario(twin({ jobsPerMonth: 560, technicians: 5 }), A, [{ type: 'sla_target', params: { toHours: 1 } }]);
    expect(r.risks.length).toBeGreaterThan(0);
  });
});

describe('verdict, risks and cash', () => {
  it('flags saturation above the service floor', () => {
    const r = runScenario(twin({ jobsPerMonth: 520, technicians: 5 }), A, [{ type: 'new_region', params: { demandPct: 50, setupCost: 0, drivePenaltyPct: 30, rampMonths: 1 } }]);
    expect(r.projected.utilizationPct).toBeGreaterThan(80);
  });

  it('reports payback null when cash never recovers inside the horizon', () => {
    const r = runScenario(twin({ jobsPerMonth: 200 }), A, [hire(5)]);
    expect(r.cash.paybackMonth).toBeNull();
  });

  it('lower data quality lowers confidence', () => {
    const measured = runScenario(twin({}, true), A, [price(8)]);
    const assumed = runScenario(twin({}, false), A, [price(8)]);
    expect(assumed.confidence.score).toBeLessThan(measured.confidence.score);
  });

  it('uses the calibrated churn only while churn is assumed', () => {
    const assumedTwin = twin({}, false);
    const r1 = runScenario(assumedTwin, { ...A, churnMonthlyPct: 6 }, []);
    expect(r1.baseline.churnPct).toBeCloseTo(6, 6);
    const r2 = runScenario(twin({}, true), { ...A, churnMonthlyPct: 6 }, []);
    expect(r2.baseline.churnPct).toBeCloseTo(2.4, 6);
  });

  it('every preset runs without NaN', () => {
    for (const p of PRESETS) {
      const r = runScenario(defaultBaseline(), A, p.levers);
      for (const v of Object.values(r.projected)) expect(Number.isFinite(v)).toBe(true);
      for (const range of Object.values(r.ranges)) expect(Number.isFinite(range.p50)).toBe(true);
    }
  });
});

describe('levers and helpers', () => {
  it('clamps lever parameters to their allowed range', () => {
    const r = resolveLevers([{ type: 'price_change', params: { pct: 500 } }, { type: 'hire_technicians', params: { count: -4 } }]);
    expect(r.price?.pct).toBe(30);
    expect(r.hire?.count).toBe(1);
  });

  it('falls back to defaults for missing or invalid params', () => {
    const r = resolveLevers([{ type: 'ai_call_coverage', params: { pct: Number.NaN } }]);
    expect(r.ai?.pct).toBe(20);
  });

  it('the last lever of a type wins', () => {
    const r = resolveLevers([price(5), price(12)]);
    expect(r.price?.pct).toBe(12);
  });

  it('defaultLever carries every field default', () => {
    expect(defaultLever('new_region').params).toEqual({ demandPct: 15, setupCost: 6000, drivePenaltyPct: 12, rampMonths: 4 });
  });

  it('percentile interpolates', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([10, 20], 0.5)).toBe(15);
    expect(percentile([], 0.5)).toBe(0);
  });

  it('sanitizeAssumptions repairs bad stored data', () => {
    const s = sanitizeAssumptions({ techMonthlyCost: -5, materialsPct: 'x', priceElasticity: 3 });
    expect(s.techMonthlyCost).toBe(1000);
    expect(s.materialsPct).toBe(DEFAULT_ASSUMPTIONS.materialsPct);
    expect(s.priceElasticity).toBe(-0.1);
    expect(sanitizeAssumptions(null)).toEqual(DEFAULT_ASSUMPTIONS);
  });

  it('formats deltas by unit and judges them by direction', () => {
    expect(formatDelta('marginPct', 2.14)).toBe('+2.1 pts');
    expect(formatDelta('revenue', -1500)).toBe('−$1,500');
    expect(deltaTone('churnPct', 0.4)).toBe('bad');
    expect(deltaTone('revenue', 900)).toBe('good');
    expect(deltaTone('utilizationPct', 12)).toBe('neutral');
  });
});
