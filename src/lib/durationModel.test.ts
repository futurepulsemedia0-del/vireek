import { describe, it, expect } from 'vitest';
import {
  DURATION_MODEL,
  detectDrift,
  durationKey,
  equipmentTypeEffects,
  formatMinutes,
  formatRange,
  historyFor,
  isExplicitEstimate,
  normalQuantile,
  predictDuration,
  resolveExistingEstimate,
  slotMinutesFor,
  summarizeBacktest,
  summarizeBy,
  technicianEffects,
  trainDurationModel,
  typeTable,
  type PredictionContext,
  type TrainingJob,
} from './durationModel';

// ---------- deterministic data generator ----------
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return { next, normal };
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

interface GenOpts {
  n: number;
  seed?: number;
  sigma?: number;
  endMs?: number;
  spanDays?: number;
  types?: Record<string, number>;
  techs?: Record<string, number>; // id -> multiplier
  customers?: Record<string, number>;
  equipmentTypes?: Record<string, number>;
  shiftLastN?: { n: number; factor: number; type?: string };
}

function gen(o: GenOpts): TrainingJob[] {
  const r = rng(o.seed ?? 1);
  const types = o.types ?? { 'ac repair': 90, 'drain clean': 45 };
  const techs = o.techs ?? { t1: 1, t2: 1 };
  const customers = o.customers ?? { c1: 1, c2: 1, c3: 1, c4: 1 };
  const eqs = o.equipmentTypes ?? { furnace: 1, boiler: 1 };
  const typeKeys = Object.keys(types);
  const techKeys = Object.keys(techs);
  const custKeys = Object.keys(customers);
  const eqKeys = Object.keys(eqs);
  const end = o.endMs ?? NOW - DAY;
  const span = (o.spanDays ?? 200) * DAY;
  const sigma = o.sigma ?? 0.25;
  const out: TrainingJob[] = [];
  for (let i = 0; i < o.n; i++) {
    const type = typeKeys[Math.floor(r.next() * typeKeys.length)];
    const tech = techKeys[Math.floor(r.next() * techKeys.length)];
    const cust = custKeys[Math.floor(r.next() * custKeys.length)];
    const eq = eqKeys[Math.floor(r.next() * eqKeys.length)];
    let minutes = types[type] * techs[tech] * customers[cust] * eqs[eq] * Math.exp(sigma * r.normal());
    const t = end - span + (span * (i + 1)) / o.n;
    if (o.shiftLastN && i >= o.n - o.shiftLastN.n && (!o.shiftLastN.type || o.shiftLastN.type === type)) {
      minutes *= o.shiftLastN.factor;
    }
    out.push({
      jobId: `j${i}`,
      completedAtMs: Math.round(t),
      jobTypeKey: type,
      technicianId: tech,
      equipmentIds: [`${eq}-${cust}`],
      equipmentTypes: [eq],
      customerId: cust,
      actualMinutes: Math.min(1400, Math.max(6, minutes)),
    });
  }
  return out;
}

const ctx = (o: Partial<PredictionContext> = {}): PredictionContext => ({
  jobTypeKey: 'ac repair',
  technicianId: 't1',
  equipmentIds: [],
  equipmentTypes: [],
  customerId: null,
  ...o,
});

// ---------- helpers ----------
describe('helpers', () => {
  it('normalizes keys', () => {
    expect(durationKey('  AC   Repair ')).toBe('ac repair');
    expect(durationKey(null)).toBe('unspecified');
    expect(durationKey('   ')).toBe('unspecified');
  });

  it('inverse normal CDF matches known values', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(normalQuantile(0.9)).toBeCloseTo(1.2815516, 5);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.1)).toBeCloseTo(-1.2815516, 5);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 4);
  });

  it('formats minutes and ranges', () => {
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(95)).toBe('1h 35m');
    expect(formatRange(40, 90)).toBe('40m–1h 30m');
  });
});

// ---------- existing estimates ----------
describe('resolveExistingEstimate (mirrors the service-twin precedence)', () => {
  it('plan beats everything', () => {
    expect(resolveExistingEstimate({ planMinutes: 75, templateMinutes: 30, historyMedianMinutes: 50, historyCount: 9, slotMinutes: 60 })).toEqual({ minutes: 75, source: 'job_plan' });
  });
  it('then template, then history (n>=5), then brief, catalog, slot, default', () => {
    expect(resolveExistingEstimate({ templateMinutes: 30, historyMedianMinutes: 50, historyCount: 9 }).source).toBe('template');
    expect(resolveExistingEstimate({ historyMedianMinutes: 50, historyCount: 9, missionBriefMinutes: 40 })).toEqual({ minutes: 50, source: 'history' });
    expect(resolveExistingEstimate({ historyMedianMinutes: 50, historyCount: 4, missionBriefMinutes: 40 }).source).toBe('mission_brief');
    expect(resolveExistingEstimate({ catalogMinutes: 120, slotMinutes: 60 }).source).toBe('catalog');
    expect(resolveExistingEstimate({ slotMinutes: 60 }).source).toBe('scheduled_slot');
    expect(resolveExistingEstimate({})).toEqual({ minutes: 90, source: 'default' });
  });
  it('enforces the twin 15-minute floor and ignores junk', () => {
    expect(resolveExistingEstimate({ planMinutes: 5 }).minutes).toBe(15);
    expect(resolveExistingEstimate({ planMinutes: Number.NaN, slotMinutes: -3 }).source).toBe('default');
  });
  it('only deliberate estimates count as a prior', () => {
    expect(isExplicitEstimate({ minutes: 60, source: 'job_plan' })).toBe(true);
    expect(isExplicitEstimate({ minutes: 60, source: 'history' })).toBe(false);
    expect(isExplicitEstimate({ minutes: 60, source: 'scheduled_slot' })).toBe(false);
    expect(isExplicitEstimate(null)).toBe(false);
  });
});

// ---------- training ----------
describe('trainDurationModel', () => {
  it('drops invalid rows and reports them', () => {
    const jobs = gen({ n: 30 });
    jobs.push({ ...jobs[0], jobId: 'bad1', actualMinutes: 2 });
    jobs.push({ ...jobs[0], jobId: 'bad2', actualMinutes: 5000 });
    jobs.push({ ...jobs[0], jobId: 'bad3', actualMinutes: Number.NaN });
    const m = trainDurationModel(jobs, NOW);
    expect(m.trainedOn).toBe(30);
    expect(m.dropped).toBe(3);
    expect(m.records).toHaveLength(30);
  });

  it('is strictly out-of-sample: a job never influences its own backtest prediction', () => {
    const jobs = gen({ n: 60, seed: 7 });
    const a = trainDurationModel(jobs, NOW);
    const tweaked = jobs.map((j, i) => (i === jobs.length - 1 ? { ...j, actualMinutes: 900 } : j));
    const b = trainDurationModel(tweaked, NOW);
    for (let i = 0; i < jobs.length; i++) {
      expect(b.records[i].predicted).toBe(a.records[i].predicted);
      expect(b.records[i].low).toBe(a.records[i].low);
      expect(b.records[i].high).toBe(a.records[i].high);
    }
  });

  it('is order-independent (sorts by completion time)', () => {
    const jobs = gen({ n: 50, seed: 3 });
    const shuffled = [...jobs].reverse();
    const a = trainDurationModel(jobs, NOW).records.map((r) => r.predicted);
    const b = trainDurationModel(shuffled, NOW).records.map((r) => r.predicted);
    expect(b).toEqual(a);
  });

  it('first prediction with no history falls back to the 90-minute default', () => {
    const m = trainDurationModel(gen({ n: 5 }), NOW);
    expect(m.records[0].predicted).toBeGreaterThan(70);
    expect(m.records[0].predicted).toBeLessThan(115);
    expect(m.records[0].source).toBe('prior');
  });

  it('handles an empty history', () => {
    const m = trainDurationModel([], NOW);
    expect(m.trainedOn).toBe(0);
    const p = predictDuration(m, ctx({ existing: { minutes: 50, source: 'job_plan' } }), NOW);
    expect(p.source).toBe('prior');
    expect(p.minutes).toBeGreaterThan(40);
    expect(p.minutes).toBeLessThan(62);
    expect(p.confidence).toBe('low');
  });
});

// ---------- prediction quality ----------
describe('predictDuration', () => {
  const jobs = gen({ n: 400, seed: 11, techs: { t1: 1, t2: 1.4, t3: 0.8 }, customers: { c1: 1, c2: 1.5, c3: 1, c4: 1 }, equipmentTypes: { furnace: 1, boiler: 1.25 } });
  const model = trainDurationModel(jobs, NOW);

  it('learns per-type durations', () => {
    const ac = predictDuration(model, ctx({ technicianId: null }), NOW);
    const drain = predictDuration(model, ctx({ jobTypeKey: 'Drain Clean', technicianId: null }), NOW);
    expect(ac.minutes).toBeGreaterThan(70);
    expect(ac.minutes).toBeLessThan(130);
    expect(drain.minutes).toBeGreaterThan(33);
    expect(drain.minutes).toBeLessThan(68);
    expect(ac.minutes).toBeGreaterThan(drain.minutes);
    expect(ac.source).toBe('model');
  });

  it('technician effect: slow tech > average > fast tech', () => {
    const slow = predictDuration(model, ctx({ technicianId: 't2' }), NOW).minutes;
    const mid = predictDuration(model, ctx({ technicianId: 't1' }), NOW).minutes;
    const fast = predictDuration(model, ctx({ technicianId: 't3' }), NOW).minutes;
    expect(slow).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(fast);
  });

  it('customer and equipment history move the prediction', () => {
    const base = predictDuration(model, ctx({ customerId: 'c1', equipmentTypes: ['furnace'] }), NOW).minutes;
    const slowCust = predictDuration(model, ctx({ customerId: 'c2', equipmentTypes: ['furnace'] }), NOW).minutes;
    const slowEq = predictDuration(model, ctx({ customerId: 'c1', equipmentTypes: ['boiler'] }), NOW).minutes;
    expect(slowCust).toBeGreaterThan(base);
    expect(slowEq).toBeGreaterThan(base);
  });

  it('explains the number: factors are listed and chain to the total', () => {
    const p = predictDuration(model, ctx({ technicianId: 't2', customerId: 'c2', equipmentTypes: ['boiler'], equipmentIds: ['boiler-c2'] }), NOW);
    const ids = p.factors.map((f) => f.id);
    expect(ids[0]).toBe('start');
    expect(ids).toContain('technician');
    expect(ids).toContain('customer');
    const sum = p.factors.reduce((s, f) => s + f.minutes, 0);
    // the chain is the (unrounded) exp(total); P50 also carries the pool's median bias, so allow slack
    expect(Math.abs(sum - p.minutes)).toBeLessThan(Math.max(6, p.minutes * 0.08));
  });

  it('range is ordered, wider than a point, and honestly calibrated (~80%)', () => {
    const p = predictDuration(model, ctx(), NOW);
    expect(p.low).toBeLessThan(p.minutes);
    expect(p.minutes).toBeLessThan(p.high);
    expect(p.quantiles.p25).toBeGreaterThanOrEqual(p.low);
    expect(p.quantiles.p75).toBeLessThanOrEqual(p.high);
    expect(p.intervalMethod).toBe('empirical');
    const late = model.records.slice(150);
    const cov = late.filter((r) => r.withinRange).length / late.length;
    expect(cov).toBeGreaterThan(0.7);
    expect(cov).toBeLessThan(0.9);
  });

  it('beats a flat "everything is 60 minutes" baseline on the walk-forward backtest', () => {
    const withBase = model.records.map((r) => ({ ...r, baselineMinutes: 60 }));
    const s = summarizeBacktest(withBase);
    expect(s.baseline).not.toBeNull();
    expect(s.baseline!.improvementPct).toBeGreaterThan(20);
    expect(s.biasPct).toBeGreaterThan(-8);
    expect(s.biasPct).toBeLessThan(8);
  });

  it('reports deltas against the existing estimate and agreement', () => {
    const longer = predictDuration(model, ctx({ existing: { minutes: 45, source: 'job_plan' } }), NOW);
    expect(longer.agreement).toBe('longer');
    expect(longer.deltaVsExisting).toBeGreaterThan(0);
    const aligned = predictDuration(model, ctx({ existing: { minutes: longer.minutes, source: 'job_plan' } }), NOW);
    expect(aligned.agreement).toBe('aligned');
  });

  it('confidence rises with evidence', () => {
    const small = trainDurationModel(gen({ n: 6, seed: 2 }), NOW);
    expect(predictDuration(small, ctx(), NOW).confidence).toBe('low');
    expect(predictDuration(model, ctx(), NOW).confidence).not.toBe('low');
  });
});

describe('cold start extends the existing estimate instead of guessing', () => {
  const model = trainDurationModel(gen({ n: 200, seed: 5 }), NOW);

  it('unseen type: uses the plan, labels it prior, and refuses to override slots', () => {
    const p = predictDuration(model, ctx({ jobTypeKey: 'generator install', existing: { minutes: 240, source: 'job_plan' } }), NOW);
    expect(p.source).toBe('prior');
    expect(p.sampleSize).toBe(0);
    expect(p.minutes).toBeGreaterThan(200);
    expect(p.minutes).toBeLessThan(280);
    expect(p.confidence).toBe('low');
    expect(p.high / p.low).toBeGreaterThan(1.5);
    expect(slotMinutesFor(p, 'balanced')).toBeNull();
  });

  it('unseen type without a plan falls back to the account average', () => {
    const p = predictDuration(model, ctx({ jobTypeKey: 'weird thing' }), NOW);
    expect(p.source).toBe('prior');
    expect(p.minutes).toBeGreaterThan(35);
    expect(p.minutes).toBeLessThan(120);
  });

  it('a non-explicit existing estimate (booked slot) is NOT used as the prior', () => {
    const slot = predictDuration(model, ctx({ jobTypeKey: 'weird thing', existing: { minutes: 600, source: 'scheduled_slot' } }), NOW);
    expect(slot.minutes).toBeLessThan(200);
  });

  it('blends the plan with learned history as evidence accumulates', () => {
    const few = trainDurationModel(gen({ n: 12, seed: 9, types: { 'ac repair': 90 } }), NOW);
    const pLow = predictDuration(few, ctx({ existing: { minutes: 30, source: 'job_plan' } }), NOW);
    const many = trainDurationModel(gen({ n: 200, seed: 9, types: { 'ac repair': 90 } }), NOW);
    const pHigh = predictDuration(many, ctx({ existing: { minutes: 30, source: 'job_plan' } }), NOW);
    // plan still pulls on thin data, but the data wins when there is a lot of it
    expect(pLow.minutes).toBeLessThan(pHigh.minutes);
    expect(pHigh.minutes).toBeGreaterThan(70);
  });
});

describe('robustness', () => {
  it('shrinks a technician with a single very slow job', () => {
    const jobs = gen({ n: 120, seed: 21, techs: { t1: 1, t2: 1 } });
    jobs.push({ ...jobs[0], jobId: 'solo', technicianId: 'rookie', completedAtMs: NOW - DAY / 2, actualMinutes: 400 });
    const m = trainDurationModel(jobs, NOW);
    const base = predictDuration(m, ctx({ technicianId: 't1' }), NOW).minutes;
    const rookie = predictDuration(m, ctx({ technicianId: 'rookie' }), NOW).minutes;
    expect(rookie / base).toBeLessThan(1.35);
    const eff = technicianEffects(m, NOW, 1).find((e) => e.id === 'rookie');
    expect(eff).toBeDefined();
    expect(eff!.effectPct).toBeLessThan(50);
  });

  it('one 23-hour outlier barely moves a well-supported type', () => {
    const jobs = gen({ n: 150, seed: 31, types: { 'ac repair': 90 } });
    const clean = predictDuration(trainDurationModel(jobs, NOW), ctx({ technicianId: null }), NOW).minutes;
    const poisoned = trainDurationModel([...jobs, { ...jobs[0], jobId: 'outlier', completedAtMs: NOW - DAY / 3, actualMinutes: 1380 }], NOW);
    const after = predictDuration(poisoned, ctx({ technicianId: null }), NOW).minutes;
    expect(Math.abs(after - clean) / clean).toBeLessThan(0.08);
  });

  it('old evidence decays: effective sample size shrinks with time', () => {
    const model = trainDurationModel(gen({ n: 100, seed: 41 }), NOW);
    const fresh = predictDuration(model, ctx(), NOW).effectiveSampleSize;
    const stale = predictDuration(model, ctx(), NOW + 900 * DAY).effectiveSampleSize;
    expect(stale).toBeLessThan(fresh / 4);
  });

  it('never returns durations outside the allowed bounds', () => {
    const model = trainDurationModel(gen({ n: 80, seed: 51, types: { quick: 6 } }), NOW);
    const p = predictDuration(model, ctx({ jobTypeKey: 'quick' }), NOW);
    expect(p.low).toBeGreaterThanOrEqual(DURATION_MODEL.minMinutes);
    expect(p.high).toBeLessThanOrEqual(DURATION_MODEL.maxMinutes);
  });
});

describe('slotMinutesFor', () => {
  const model = trainDurationModel(gen({ n: 300, seed: 61 }), NOW);
  const p = predictDuration(model, ctx(), NOW);

  it('tight <= balanced <= safe, rounded up to 15-minute steps', () => {
    const t = slotMinutesFor(p, 'tight')!;
    const b = slotMinutesFor(p, 'balanced')!;
    const s = slotMinutesFor(p, 'safe')!;
    expect(t).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(s);
    for (const v of [t, b, s]) expect(v % 15).toBe(0);
    expect(t).toBeGreaterThanOrEqual(p.minutes);
    expect(s).toBeGreaterThanOrEqual(p.high);
  });
});

// ---------- scorecards ----------
describe('summarizeBacktest / summarizeBy / typeTable / historyFor', () => {
  const jobs = gen({ n: 200, seed: 71 });
  const model = trainDurationModel(jobs, NOW);

  it('is empty-safe', () => {
    const s = summarizeBacktest([]);
    expect(s.n).toBe(0);
    expect(s.baseline).toBeNull();
  });

  it('groups by type', () => {
    const rows = summarizeBy(model.records, (r) => r.jobTypeKey);
    expect(rows.map((r) => r.key).sort()).toEqual(['ac repair', 'drain clean']);
    expect(rows.reduce((s, r) => s + r.n, 0)).toBe(200);
  });

  it('builds a type table with sane percentiles', () => {
    const rows = typeTable(model);
    const ac = rows.find((r) => r.key === 'ac repair')!;
    expect(ac.p10Minutes).toBeLessThan(ac.medianMinutes);
    expect(ac.medianMinutes).toBeLessThan(ac.p90Minutes);
  });

  it('exposes the twin-style history tier', () => {
    const h = historyFor(model, 'AC Repair');
    expect(h.count).toBeGreaterThan(50);
    expect(h.median).toBeGreaterThan(70);
    expect(historyFor(model, 'nope')).toEqual({ median: null, count: 0 });
  });

  it('lists equipment-type effects', () => {
    const m = trainDurationModel(gen({ n: 300, seed: 72, equipmentTypes: { furnace: 1, boiler: 1.6 } }), NOW);
    const rows = equipmentTypeEffects(m, NOW);
    const boiler = rows.find((r) => r.id === 'boiler')!;
    const furnace = rows.find((r) => r.id === 'furnace')!;
    expect(boiler.effectPct).toBeGreaterThan(furnace.effectPct);
  });
});

// ---------- drift ----------
describe('detectDrift', () => {
  it('reports insufficient data on tiny histories', () => {
    const m = trainDurationModel(gen({ n: 12, seed: 81 }), NOW);
    expect(detectDrift(m.records, { nowMs: NOW }).status).toBe('insufficient_data');
  });

  it('stays quiet on a stable process (no critical alerts)', () => {
    const m = trainDurationModel(gen({ n: 300, seed: 82, spanDays: 120 }), NOW);
    const r = detectDrift(m.records, { nowMs: NOW });
    expect(r.alerts.filter((a) => a.severity === 'critical')).toHaveLength(0);
    expect(['stable', 'watch']).toContain(r.status);
  });

  it('flags a sudden slowdown overall and says which way', () => {
    const jobs = gen({ n: 260, seed: 83, spanDays: 120, endMs: NOW - DAY, shiftLastN: { n: 25, factor: 1.6 } });
    const r = detectDrift(trainDurationModel(jobs, NOW).records, { nowMs: NOW });
    const overall = r.alerts.find((a) => a.scope === 'overall' && a.kind === 'bias');
    expect(overall).toBeDefined();
    expect(overall!.direction).toBe('longer');
    expect(overall!.biasPct).toBeGreaterThan(15);
    expect(overall!.severity).toBe('critical');
    expect(r.status).toBe('drifting');
    expect(overall!.message).toMatch(/longer than predicted/);
  });

  it('flags a speed-up as "shorter"', () => {
    const jobs = gen({ n: 260, seed: 84, spanDays: 120, shiftLastN: { n: 25, factor: 0.55 } });
    const r = detectDrift(trainDurationModel(jobs, NOW).records, { nowMs: NOW });
    const a = r.alerts.find((x) => x.scope === 'overall' && x.kind === 'bias');
    expect(a?.direction).toBe('shorter');
  });

  it('localizes drift to the job type that changed', () => {
    const jobs = gen({ n: 360, seed: 85, spanDays: 100, shiftLastN: { n: 40, factor: 1.9, type: 'drain clean' } });
    const r = detectDrift(trainDurationModel(jobs, NOW).records, { nowMs: NOW, labels: { 'drain clean': 'Drain clean' } });
    const t = r.alerts.find((a) => a.scope === 'job_type' && a.scopeKey === 'drain clean');
    expect(t).toBeDefined();
    expect(t!.message).toContain('Drain clean jobs');
    expect(r.alerts.find((a) => a.scope === 'job_type' && a.scopeKey === 'ac repair' && a.kind === 'bias')).toBeUndefined();
  });

  it('uses stable alert keys and sorts critical first', () => {
    const jobs = gen({ n: 260, seed: 86, spanDays: 120, shiftLastN: { n: 25, factor: 1.7 } });
    const r = detectDrift(trainDurationModel(jobs, NOW).records, { nowMs: NOW });
    const keys = r.alerts.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(r.alerts[0].severity).toBe('critical');
  });

  it('calibration alert when ranges stop covering actuals', () => {
    const jobs = gen({ n: 260, seed: 87, spanDays: 120, sigma: 0.15 });
    const m = trainDurationModel(jobs, NOW);
    // volatility blow-up in the recent window, centered (no bias): coverage collapses
    const r2 = rng(5);
    const recs = m.records.map((rec, i) => {
      if (i < m.records.length - 30) return rec;
      const factor = Math.exp(0.7 * r2.normal());
      const actual = Math.max(6, Math.round(rec.predicted * factor));
      return { ...rec, actual, logError: Math.log(actual / rec.predicted), withinRange: actual >= rec.low && actual <= rec.high };
    });
    const r = detectDrift(recs, { nowMs: NOW });
    expect(r.alerts.some((a) => a.kind === 'calibration')).toBe(true);
  });
});
