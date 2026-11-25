import { describe, it, expect } from 'vitest';
import {
  normalCdf, normalQuantile, makeRng, estimateRawCells, clusterBootstrapCi, shrinkCells, gradeEffect, benjaminiHochberg,
  evaluatePolicy, topRankedPolicy, loggedPolicy, weightChangePolicy, assessFeasibility, poolJobTypePriors, toShrinkagePriors,
  POOLING_MIN_TENANTS, type EstRow, type TenantJobTypeContribution,
} from './index';

const row = (i: number, chosen: string, y: number, p = { a: 0.55, b: 0.45 }, extra: Partial<EstRow> = {}): EstRow => ({
  decisionId: `d${i}`, jobId: `j${i}`, jobType: 'hvac', chosenId: chosen,
  members: [{ id: 'a', p: p.a, score: 10, f: { skill: 5 } }, { id: 'b', p: p.b, score: 9, f: { skill: 2 } }],
  outcomes: { ftf: y, callback14: null, callback30: null, durationResidual: null }, ...extra,
});

describe('normal helpers', () => {
  it('cdf and quantile are consistent', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 5);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 4);
    expect(normalQuantile(0.2)).toBeCloseTo(-0.841621, 4);
    expect(() => normalQuantile(0)).toThrow();
  });
});

describe('seeded randomness', () => {
  it('same seed gives the same stream, different seed differs', () => {
    const a = makeRng('x'), b = makeRng('x'), c = makeRng('y');
    const sa = [a(), a(), a()], sb = [b(), b(), b()];
    expect(sa).toEqual(sb);
    expect(c()).not.toBe(sa[0]);
  });
  it('bootstrap is deterministic for a seed and null with <2 clusters', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ phi: Math.sin(i), cluster: `c${i % 8}` }));
    expect(clusterBootstrapCi(entries, 200, makeRng(7))).toEqual(clusterBootstrapCi(entries, 200, makeRng(7)));
    expect(clusterBootstrapCi(entries.map((e) => ({ ...e, cluster: 'one' })), 200, makeRng(7))).toBeNull();
  });
});

describe('estimators', () => {
  it('IPW recovers a known difference when assignment is perfectly randomized (p = 1/2)', () => {
    const rows: EstRow[] = [];
    for (let i = 0; i < 400; i++) rows.push(row(i, i % 2 ? 'a' : 'b', i % 2 ? (i % 10 < 8 ? 1 : 0) : (i % 10 < 4 ? 1 : 0), { a: 0.5, b: 0.5 }));
    const cells = estimateRawCells(rows, 'ftf', 'ipw').cells;
    const a = cells.find((c) => c.technicianId === 'a')!;
    const b = cells.find((c) => c.technicianId === 'b')!;
    expect(a.est).toBeCloseTo(0.2, 1);   // (0.8 - 0.4)/2
    expect(b.est).toBeCloseTo(-0.2, 1);
    expect(a.est + b.est).toBeCloseTo(0, 9); // contrasts within a set always sum to zero
  });
  it('clips tiny propensities, reports clipped share and effective sample size', () => {
    const rows = [row(1, 'a', 1, { a: 0.995, b: 0.005 }), row(2, 'b', 1, { a: 0.995, b: 0.005 }), row(3, 'a', 0, { a: 0.995, b: 0.005 })];
    const r = estimateRawCells(rows, 'ftf', 'ipw', { pClip: 0.05 });
    expect(r.diagnostics.clippedRows).toBe(1);
    const b = r.cells.find((c) => c.technicianId === 'b')!;
    expect(b.clippedShare).toBe(1);
    expect(b.ess).toBeCloseTo(1, 9);
    expect(() => estimateRawCells(rows, 'ftf', 'ipw', { pClip: 0 })).toThrow();
  });
  it('ignores rows without an outcome and is deterministic', () => {
    const rows = [row(1, 'a', 1), row(2, 'b', 0), { ...row(3, 'a', 0), outcomes: { ftf: null, callback14: null, callback30: null, durationResidual: null } }];
    const x = estimateRawCells(rows, 'ftf', 'aipw');
    expect(x.diagnostics.nRows).toBe(2);
    expect(estimateRawCells(rows, 'ftf', 'aipw')).toEqual(x);
  });
  it('conditions on set composition: a row only ever contrasts members of its own set', () => {
    const rows: EstRow[] = [row(1, 'a', 1), { ...row(2, 'c', 0), members: [{ id: 'c', p: 0.5, score: 1, f: {} }, { id: 'd', p: 0.5, score: 1, f: {} }] }];
    const cells = estimateRawCells(rows, 'ftf', 'ipw').cells;
    expect(cells.some((c) => c.technicianId === 'a') && cells.some((c) => c.technicianId === 'd')).toBe(true);
    for (const id of ['a', 'b']) expect(cells.filter((c) => c.technicianId === id).every((c) => c.nSet === 1)).toBe(true);
  });
});

describe('shrinkage', () => {
  it('pulls a thin noisy cell toward its peers and never invents precision', () => {
    const cells = [
      ...['t1', 't2', 't3', 't4'].flatMap((t) => ['x', 'y', 'z'].map((j) => ({ technicianId: t, jobType: j, est: 0.01, se: 0.02, n: 200 }))),
      { technicianId: 't5', jobType: 'x', est: 0.4, se: 0.3, n: 5 },
      { technicianId: 't6', jobType: 'x', est: 0.2, se: null, n: 1 },
    ];
    const r = shrinkCells(cells).cells;
    const thin = r.find((c) => c.technicianId === 't5')!;
    const solid = r.find((c) => c.technicianId === 't1')!;
    expect(Math.abs(thin.shrunk)).toBeLessThan(0.4);   // pulled toward its peers
    expect(thin.weight).toBeLessThan(solid.weight);     // trusts its own data less than a well-measured cell
    expect(thin.shrunkSe).not.toBeNull();
    const none = r.find((c) => c.technicianId === 't6')!;
    expect(none.weight).toBe(0);
    expect(none.rawP).toBeNull();
  });
  it('returns finite, empty-safe output with no informative cells', () => {
    const r = shrinkCells([{ technicianId: 'a', jobType: 'x', est: 0.1, se: null }]);
    expect(r.cells[0].shrunk).toBe(0);
    expect(r.cells[0].ciLow).toBeNull();
  });
  it('pooled prior only moves the target for job types with little local data', () => {
    const local = [{ technicianId: 'a', jobType: 'rare', est: 0.3, se: 0.1, n: 50 }];
    const base = shrinkCells(local).cells[0];
    const withPrior = shrinkCells(local, { rare: { mean: 0, tau2: 0.0004 } }).cells[0];
    expect(Number.isFinite(withPrior.shrunk)).toBe(true);
    expect(Math.abs(withPrior.shrunk)).toBeLessThanOrEqual(Math.abs(base.est));
  });
});

describe('evidence rules', () => {
  const ok = { outcome: 'ftf' as const, nSet: 80, ess: 60, shrunk: 0.1, ciLow: 0.02, ciHigh: 0.18, fdrQ: 0.01, rawCiLow: 0.01, rawCiHigh: 0.2 };
  it('reports a direction only when interval excludes zero AND min-n AND effective n are met', () => {
    expect(gradeEffect(ok)).toMatchObject({ reportable: true, direction: 'above_peers', favourable: true });
    expect(gradeEffect({ ...ok, ciLow: -0.01 }).reportable).toBe(false);
    expect(gradeEffect({ ...ok, nSet: 29 }).reportable).toBe(false);
    expect(gradeEffect({ ...ok, ess: 5 }).reportable).toBe(false);
    expect(gradeEffect({ ...ok, rawCiLow: -0.02 }).reportable).toBe(false);
    expect(gradeEffect({ ...ok, fdrQ: 0.5 }).reportable).toBe(false);
    expect(gradeEffect({ ...ok, ciLow: -0.01 })).toMatchObject({ grade: 'C', direction: 'inconclusive', favourable: null });
  });
  it('direction is business-aware: lower callbacks are favourable', () => {
    const e = gradeEffect({ ...ok, outcome: 'callback14', shrunk: -0.1, ciLow: -0.18, ciHigh: -0.02, rawCiLow: -0.2, rawCiHigh: -0.01 });
    expect(e).toMatchObject({ direction: 'below_peers', favourable: true });
  });
  it('Benjamini–Hochberg is monotone, preserves order and nulls', () => {
    const q = benjaminiHochberg([0.001, null, 0.04, 0.03, 0.5]);
    expect(q[1]).toBeNull();
    expect(q[0]).toBeCloseTo(0.004, 9);
    expect(q[2]).toBeCloseTo(0.0533333, 5);
    expect(q[4]).toBe(0.5);
  });
});

describe('off-policy evaluation', () => {
  const mk = (n: number, pTop: number): EstRow[] =>
    Array.from({ length: n }, (_, i) => {
      const topChosen = (i % 100) / 100 < pTop;
      return row(i, topChosen ? 'a' : 'b', i % 3 === 0 ? 0 : 1, { a: pTop, b: 1 - pTop }, { clusterId: `c${i % 20}` });
    });
  it('the logging policy is worth exactly the observed mean (sanity) and "always top" is evaluable', () => {
    const rows = mk(400, 0.8);
    const logged = evaluatePolicy(rows, loggedPolicy);
    expect(logged.status).toBe('ok');
    expect(logged.snips!.value).toBeCloseTo(logged.behaviour!, 6);
    expect(Math.abs(logged.uplift!.value)).toBeLessThan(1e-9);
    expect(evaluatePolicy(rows, topRankedPolicy).status).toBe('ok');
  });
  it('refuses with insufficient rows, no overlap, or dominant weights', () => {
    expect(evaluatePolicy(mk(10, 0.8), topRankedPolicy).status).toBe('refused');
    const allB = mk(200, 0.0001).map((r) => ({ ...r, members: [{ ...r.members[0], p: 0.99 }, { ...r.members[1], p: 0.01 }] })).map((r) => ({ ...r, chosenId: 'a' }));
    const noOverlap = evaluatePolicy(allB, (r) => r.members.map((_, i) => (i === 1 ? 1 : 0)));
    expect(noOverlap.status).toBe('refused');
    expect(noOverlap.snips).toBeNull();
    const rare = mk(300, 0.97);
    const res = evaluatePolicy(rare, (r) => r.members.map((_, i) => (i === 1 ? 1 : 0)));
    expect(res.status).toBe('refused');
    expect(res.refusals.length).toBeGreaterThan(0);
  });
  it('rejects malformed policies', () => {
    expect(() => evaluatePolicy(mk(100, 0.8), () => [0.7, 0.7])).toThrow();
  });
  it('weight-change policy re-ranks by factor points', () => {
    const r = row(1, 'a', 1);
    expect(topRankedPolicy(r)).toEqual([1, 0]);
    expect(weightChangePolicy({ skill: 0 })(r)).toEqual([0, 1]); // removing skill points flips 10-5=5 vs 9-2=7
  });
});

describe('power and feasibility', () => {
  const dist = { 1: 100, 2: 250, 3: 150, 4: 100 };
  it('says plainly when volume is too low and recommends leaving the feature off', () => {
    const r = assessFeasibility({ technicians: 12, jobsPerWeek: 15, setSizeDistribution: dist, budgetPct: 5, baselineFtf: 0.8 });
    expect(r.verdict).toBe('no_go');
    expect(r.message).toMatch(/Not enough volume to learn this/);
    expect(r.message).toMatch(/leaving this feature off/);
  });
  it('detects a feasible tenant, with MDE shrinking over time', () => {
    const r = assessFeasibility({ technicians: 4, jobsPerWeek: 400, setSizeDistribution: dist, budgetPct: 25, baselineFtf: 0.8 });
    expect(r.verdict).toBe('go');
    expect(r.mdeAt52Weeks!).toBeLessThan(r.mdeAt26Weeks!);
  });
  it('handles no data, zero budget and no qualifying sets', () => {
    expect(assessFeasibility({ technicians: 4, jobsPerWeek: 100, setSizeDistribution: {}, budgetPct: 10, baselineFtf: 0.8 }).verdict).toBe('no_data');
    expect(assessFeasibility({ technicians: 4, jobsPerWeek: 100, setSizeDistribution: dist, budgetPct: 0, baselineFtf: 0.8 }).verdict).toBe('no_go');
    expect(assessFeasibility({ technicians: 4, jobsPerWeek: 100, setSizeDistribution: { 1: 500 }, budgetPct: 10, baselineFtf: 0.8 }).verdict).toBe('no_go');
  });
  it('is monotone: more budget or volume never lengthens time-to-detect', () => {
    const w = (b: number, j: number) => assessFeasibility({ technicians: 6, jobsPerWeek: j, setSizeDistribution: dist, budgetPct: b, baselineFtf: 0.8 }).weeksToTarget!;
    expect(w(20, 200)).toBeLessThan(w(10, 200));
    expect(w(10, 400)).toBeLessThan(w(10, 200));
  });
});

describe('cross-tenant pooling (k-anonymity style minimums)', () => {
  const c = (jobType: string, nRows = 100, tau2 = 0.001): TenantJobTypeContribution => ({ jobType, nRows, nTechnicians: 5, tau2, baseline: 0.8 });
  it('suppresses a job type with fewer than the minimum number of tenants', () => {
    const t = Array.from({ length: POOLING_MIN_TENANTS - 1 }, () => [c('hvac')]);
    expect(poolJobTypePriors(t)).toEqual([]);
  });
  it('publishes with enough tenants, no identifiers, floored counts, equal tenant weights', () => {
    const t = [[c('hvac', 1000, 0.01)], ...Array.from({ length: 5 }, () => [c('hvac', 100, 0.001)])];
    const out = poolJobTypePriors(t);
    expect(out).toHaveLength(1);
    expect(Object.keys(out[0]).sort()).toEqual(['baseline', 'jobType', 'nRows', 'nTenants', 'tau2']);
    expect(out[0].nRows % 10).toBe(0);
    expect(out[0].tau2).toBeCloseTo(0.0025, 9); // (0.01 + 5·0.001)/6: a 1000-row tenant gets no extra weight
    expect(toShrinkagePriors(out).hvac).toEqual({ mean: 0, tau2: out[0].tau2 });
  });
  it('drops thin tenants and free-text labels that fail the allow-list', () => {
    const t = Array.from({ length: 6 }, () => [c('call john at 555-1234!', 100), c('hvac', 10)]);
    expect(poolJobTypePriors(t)).toEqual([]);
  });
});
