import { describe, it, expect } from 'vitest';
import {
  allFactorProvenance,
  analyzeCausalDispatch,
  buildCausalRows,
  estimateCellEffects,
  factorProvenance,
  gradeEvidence,
  parseSet,
  reworkedWithin,
  suggestWeightChanges,
  type CausalRow,
  type RawDecision,
  type RawOutcomeJob,
} from './causalDispatch';
import { buildReworkIndex, callbackWithin } from '../../supabase/functions/_shared/dispatch/outcomes';
import { observe } from './opsExperiments';

// ---------- deterministic PRNG so the synthetic study is reproducible ----------
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TECHS = ['A', 'B', 'C'];
/** Ground truth: effect of each technician on P(first-time fix), by job type. */
const TRUE_EFFECT: Record<string, Record<string, number>> = {
  hvac: { A: +0.12, B: -0.04, C: -0.08 },
  plumbing: { A: -0.06, B: +0.02, C: +0.04 },
};
const trueRel = (tech: string, type: string) => TRUE_EFFECT[type][tech] - TECHS.reduce((s, t) => s + TRUE_EFFECT[type][t], 0) / TECHS.length;

/**
 * Confounded world: hard jobs (which lower FTF by 25 pp) are always sent to technician A by the deterministic policy,
 * easy jobs to B. A fraction q of jobs is randomized uniformly inside the set {A,B,C}. Propensities are the true ones.
 */
function simulate(n: number, q: number, seed = 7): CausalRow[] {
  const rand = rng(seed);
  const rows: CausalRow[] = [];
  for (let i = 0; i < n; i++) {
    const type = rand() < 0.5 ? 'hvac' : 'plumbing';
    const hard = rand() < 0.5;
    const top = hard ? 'A' : 'B';
    const enrolled = rand() < q;
    const chosen = enrolled ? TECHS[Math.floor(rand() * 3)] : top;
    const p = (id: string) => q / 3 + (id === top ? 1 - q : 0);
    const pFtf = Math.min(0.99, Math.max(0.01, 0.8 - (hard ? 0.25 : 0) + TRUE_EFFECT[type][chosen]));
    const y = rand() < pFtf ? 1 : 0;
    rows.push({
      decisionId: `d${i}`, jobId: `j${i}`, jobType: type, chosenId: chosen,
      members: TECHS.map((id) => ({ id, p: p(id), score: 50, f: { zone: id === 'A' ? 15 : 0 } })),
      outcomes: { ftf: y, callback14: 1 - y, callback30: 1 - y, durationResidual: null },
    });
  }
  return rows;
}

describe('estimateCellEffects — doubly robust under confounding', () => {
  const rows = simulate(14000, 0.35);
  const effects = estimateCellEffects(rows, 'ftf');
  const cell = (t: string, type: string) => effects.find((e) => e.technicianId === t && e.jobType === type)!;

  it('the observational estimate is badly biased in this world (sanity check of the scenario)', () => {
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const naive = (t: string, type: string) => mean(rows.filter((r) => r.chosenId === t && r.jobType === type).map((r) => r.outcomes.ftf as number));
    const naiveRel = (t: string, type: string) => naive(t, type) - mean(TECHS.map((x) => naive(x, type)));
    // A is sent the hard jobs, so naively A looks worse than the truth says (+0.08 in hvac)
    expect(trueRel('A', 'hvac')).toBeGreaterThan(0.08);
    expect(naiveRel('A', 'hvac')).toBeLessThan(trueRel('A', 'hvac') - 0.08);
  });

  it('recovers every technician x job-type effect within its own confidence interval', () => {
    for (const type of Object.keys(TRUE_EFFECT)) {
      for (const tech of TECHS) {
        const e = cell(tech, type);
        expect(e.se).not.toBeNull();
        expect(e.se!).toBeLessThan(0.05);
        expect(Math.abs(e.est - trueRel(tech, type))).toBeLessThan(3 * e.se!);
      }
    }
  });

  it('gets the sign and ordering right', () => {
    expect(cell('A', 'hvac').est).toBeGreaterThan(cell('B', 'hvac').est);
    expect(cell('B', 'hvac').est).toBeGreaterThan(cell('C', 'hvac').est);
    expect(cell('C', 'plumbing').est).toBeGreaterThan(cell('A', 'plumbing').est);
  });

  it('effects within a set average to ~0 (relative to peers)', () => {
    for (const type of Object.keys(TRUE_EFFECT)) {
      const s = TECHS.reduce((acc, t) => acc + cell(t, type).raw, 0);
      expect(Math.abs(s)).toBeLessThan(0.02);
    }
  });

  it('deterministic: same data, same answer', () => {
    expect(estimateCellEffects(rows, 'ftf')).toEqual(effects);
  });

  it('callback outcomes mirror FTF with opposite sign', () => {
    const cb = estimateCellEffects(rows, 'callback14').find((e) => e.technicianId === 'A' && e.jobType === 'hvac')!;
    expect(cb.est).toBeCloseTo(-cell('A', 'hvac').est, 6);
  });
});

describe('thin cells and shrinkage', () => {
  it('a technician with very few randomized jobs in a job type is pulled towards their overall effect, with a wide interval', () => {
    const rows = simulate(6000, 0.4, 11);
    // add 4 extreme observations for A in a brand-new job type
    for (let i = 0; i < 4; i++) {
      rows.push({
        decisionId: `t${i}`, jobId: `t${i}`, jobType: 'rare', chosenId: 'A',
        members: TECHS.map((id) => ({ id, p: 1 / 3, score: 50, f: {} })),
        outcomes: { ftf: 1, callback14: 0, callback30: 0, durationResidual: null },
      });
    }
    const e = estimateCellEffects(rows, 'ftf').find((x) => x.jobType === 'rare' && x.technicianId === 'A')!;
    expect(e.n).toBe(4);
    expect(e.grade).toBe('C');
    expect(Math.abs(e.est)).toBeLessThan(Math.abs(e.raw) + 1e-9);
    expect(e.se === null || e.se > 0.05).toBe(true);
  });

  it('a single observation yields a finite shrunk estimate and no fake precision', () => {
    const rows: CausalRow[] = [{
      decisionId: 'd', jobId: 'j', jobType: 'x', chosenId: 'A',
      members: [{ id: 'A', p: 0.5, score: 1, f: {} }, { id: 'B', p: 0.5, score: 1, f: {} }],
      outcomes: { ftf: 1, callback14: 0, callback30: 0, durationResidual: null },
    }];
    const e = estimateCellEffects(rows, 'ftf');
    expect(e.length).toBe(2);
    for (const c of e) { expect(Number.isFinite(c.est)).toBe(true); expect(c.rawSe).toBeNull(); expect(c.grade).toBe('C'); }
  });

  it('no usable outcomes => no effects', () => {
    expect(estimateCellEffects([{ ...simulate(1, 0.5)[0], outcomes: { ftf: null, callback14: null, callback30: null, durationResidual: null } }], 'ftf')).toEqual([]);
  });

  it('duration residual is estimated on its own scale (minutes)', () => {
    const rand = rng(3);
    const rows = simulate(6000, 0.4, 5).map((r) => ({ ...r, outcomes: { ...r.outcomes, durationResidual: (r.chosenId === 'A' ? -10 : 0) + (rand() - 0.5) * 20 } }));
    const a = estimateCellEffects(rows, 'durationResidual').filter((e) => e.technicianId === 'A');
    for (const e of a) expect(e.est).toBeLessThan(-4); // A is ~7 min faster than the average of A,B,C
  });

  it('evidence grade: A needs size and precision, B size, C otherwise', () => {
    expect(gradeEvidence('ftf', 100, 0.03)).toBe('A');
    expect(gradeEvidence('ftf', 100, 0.2)).toBe('B');
    expect(gradeEvidence('ftf', 31, 0.01)).toBe('B');
    expect(gradeEvidence('ftf', 10, 0.01)).toBe('C');
    expect(gradeEvidence('durationResidual', 100, 5)).toBe('A');
    expect(gradeEvidence('ftf', 100, null)).toBe('B');
  });
});

describe('factor provenance', () => {
  /** Factor "zone" is worth +15 for tech A. Truth: A has a real +10 pp advantage (so the factor is valid). */
  const world = (zoneEffect: number, seed: number) => {
    const rand = rng(seed);
    const rows: CausalRow[] = [];
    for (let i = 0; i < 4000; i++) {
      const hard = rand() < 0.5;
      const top = hard ? 'A' : 'B';
      const q = 0.4;
      const enrolled = rand() < q;
      const chosen = enrolled ? TECHS[Math.floor(rand() * 3)] : top;
      const p = (id: string) => q / 3 + (id === top ? 1 - q : 0);
      const pr = 0.75 - (hard ? 0.2 : 0) + (chosen === 'A' ? zoneEffect : 0);
      rows.push({
        decisionId: `d${i}`, jobId: `j${i}`, jobType: 'hvac', chosenId: chosen,
        members: TECHS.map((id) => ({ id, p: p(id), score: 50, f: { zone: id === 'A' ? 15 : 0, drive: id === 'B' ? 8 : 0, noise: 0 } })),
        outcomes: { ftf: rand() < pr ? 1 : 0, callback14: 0, callback30: 0, durationResidual: null },
      });
    }
    return rows;
  };

  it('validated_by_randomization when the factor truly helps (despite A being sent hard jobs)', () => {
    const r = factorProvenance(world(+0.12, 1), 'zone');
    expect(r.provenance).toBe('validated_by_randomization');
    expect(r.beta!).toBeGreaterThan(0);
    expect(r.ciLow!).toBeGreaterThan(0);
  });

  it('contradicted when the factor hurts', () => {
    const r = factorProvenance(world(-0.12, 2), 'zone');
    expect(r.provenance).toBe('contradicted');
    expect(r.ciHigh!).toBeLessThan(0);
  });

  it('observational_only when the effect is null (CI straddles 0)', () => {
    expect(factorProvenance(world(0, 3), 'zone').provenance).toBe('observational_only');
  });

  it('observational_only when the factor never varies inside sets, or there is little randomized data', () => {
    expect(factorProvenance(world(0.1, 4), 'noise')).toMatchObject({ provenance: 'observational_only', beta: null, nInformative: 0 });
    expect(factorProvenance(world(0.1, 4).slice(0, 10), 'zone').provenance).toBe('observational_only');
    expect(factorProvenance([], 'zone').provenance).toBe('observational_only');
  });

  it('allFactorProvenance covers every factor seen in the data', () => {
    expect(Object.keys(allFactorProvenance(world(0.1, 5))).sort()).toEqual(['drive', 'noise', 'zone']);
  });
});

describe('suggestions are advisory and conservative', () => {
  const prov = (kind: 'validated_by_randomization' | 'contradicted' | 'observational_only', grade: 'A' | 'B' | 'C' = 'A') => ({
    factor: 'zone', provenance: kind, beta: 0.01, ciLow: 0, ciHigh: 0.02, nInformative: 100, grade, note: 'n',
  });
  const rule = (over = {}) => ({ rule_type: 'zone', weight: 20, mode: 'score' as const, enabled: true, ...over });

  it('halves a contradicted weight; raises a grade-A validated weight by 20% (capped)', () => {
    expect(suggestWeightChanges({ zone: prov('contradicted') }, [rule()])[0]).toMatchObject({ direction: 'decrease', suggestedWeight: 10, currentWeight: 20 });
    expect(suggestWeightChanges({ zone: prov('validated_by_randomization') }, [rule()])[0]).toMatchObject({ direction: 'increase', suggestedWeight: 24 });
    expect(suggestWeightChanges({ zone: prov('validated_by_randomization') }, [rule({ weight: 95 })])[0].suggestedWeight).toBe(100);
  });

  it('suggests nothing for observational / weaker evidence, require-mode, disabled or max-weight rules', () => {
    expect(suggestWeightChanges({ zone: prov('observational_only') }, [rule()])).toEqual([]);
    expect(suggestWeightChanges({ zone: prov('validated_by_randomization', 'B') }, [rule()])).toEqual([]);
    expect(suggestWeightChanges({ zone: prov('contradicted') }, [rule({ mode: 'require' })])).toEqual([]);
    expect(suggestWeightChanges({ zone: prov('contradicted') }, [rule({ enabled: false })])).toEqual([]);
    expect(suggestWeightChanges({ zone: prov('validated_by_randomization') }, [rule({ weight: 100 })])).toEqual([]);
    expect(suggestWeightChanges({}, [rule()])).toEqual([]);
  });
});

// ---------- building rows from the decision log: maturity, reassignment, malformed input ----------
const NOW = new Date('2026-11-01T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const SET = { reason: 'explored', q: 0.1, k: 2, delta: 3, top_id: 'A', members: [{ id: 'A', score: 50, ftf: 0.9, p: 0.55 }, { id: 'B', score: 49, ftf: 0.9, p: 0.45 }] };
const dec = (id: string, job: string, tech: string, extra: Partial<RawDecision> = {}): RawDecision => ({ id, job_id: job, technician_id: tech, arm: 'explore', set_size: 2, indifference_set: SET, ...extra });
const job = (id: string, over: Partial<RawOutcomeJob> = {}): RawOutcomeJob => ({
  id, service_type: 'HVAC ', job_status: 'completed', scheduled_datetime: daysAgo(40), created_at: daysAgo(41), completed_at: daysAgo(40),
  invoice_amount: null, sla_response_hours: null, assigned_technician_id: 'A', is_rework: false, rework_of_job_id: null, ...over,
});

describe('buildCausalRows — maturity and attribution', () => {
  it('only mature jobs yield outcomes; a 20-day-old job has a 14-day but no 30-day outcome', () => {
    const jobs = [job('j1', { completed_at: daysAgo(20) }), job('j2', { completed_at: daysAgo(5) }), job('j3', { completed_at: daysAgo(40) })];
    const { rows } = buildCausalRows({ decisions: ['j1', 'j2', 'j3'].map((j, i) => dec(`d${i}`, j, 'A')), jobs, reworks: [], now: NOW });
    const by = Object.fromEntries(rows.map((r) => [r.jobId, r.outcomes]));
    expect(by.j1).toMatchObject({ ftf: 1, callback14: 0, callback30: null });
    expect(by.j2).toMatchObject({ ftf: null, callback14: null, callback30: null });
    expect(by.j3).toMatchObject({ ftf: 1, callback14: 0, callback30: 0 });
  });

  it('windows are respected: a rework on day 20 is a 30-day callback but not a 14-day one', () => {
    const jobs = [job('j1', { completed_at: daysAgo(60) })];
    const reworks = [{ rework_of_job_id: 'j1', created_at: daysAgo(60 - 20) }];
    const { rows } = buildCausalRows({ decisions: [dec('d', 'j1', 'A')], jobs, reworks, now: NOW });
    expect(rows[0].outcomes).toMatchObject({ ftf: 1, callback14: 0, callback30: 1 });
    expect(reworkedWithin(jobs, reworks, 14).size).toBe(0);
    expect(reworkedWithin(jobs, reworks, 30).size).toBe(1);
  });

  it('agrees with the edge-side outcome helper used by the guardrail (opsExperiments cross-check)', () => {
    const jobs = [job('a', { completed_at: daysAgo(60) }), job('b', { completed_at: daysAgo(10) }), job('c', { completed_at: daysAgo(60) })];
    const reworks = [{ rework_of_job_id: 'a', created_at: daysAgo(55) }, { rework_of_job_id: 'c', created_at: daysAgo(20) }];
    const idx = buildReworkIndex(reworks);
    for (const w of [14, 30]) {
      const set = reworkedWithin(jobs, reworks, w);
      for (const j of jobs) {
        expect(callbackWithin(j, idx, w, NOW)).toBe(observe('callback_rate', j, { reworked: set, now: NOW, maturityDays: w }));
      }
    }
  });

  it('drops reassigned jobs, non-randomized and malformed rows, and keeps one row per job; reports why', () => {
    const jobs = [job('j1'), job('j2', { assigned_technician_id: 'B' }), job('j3'), job('j4')];
    const decisions: RawDecision[] = [
      dec('d1', 'j1', 'A'),
      dec('d2', 'j2', 'A'),                                                   // job now belongs to B
      dec('d3', 'j3', 'A', { indifference_set: { ...SET, reason: 'budget_exhausted' } }), // propensity not known
      dec('d4', 'j4', 'A', { indifference_set: { ...SET, members: [{ id: 'A', score: 1, p: 0.9 }, { id: 'B', score: 1, p: 0.3 }] } }), // sums to 1.2
      dec('d5', 'j1', 'A'),                                                   // second decision for j1
      dec('d6', 'nope', 'A'),                                                 // unknown job
      dec('d7', 'j1', 'A', { arm: null }),
    ];
    const { rows, diagnostics } = buildCausalRows({ decisions, jobs, reworks: [], now: NOW });
    expect(rows.map((r) => r.decisionId)).toEqual(['d1']);
    expect(diagnostics).toMatchObject({ considered: 7, used: 1, droppedReassigned: 2, droppedNotRandomized: 2, droppedMalformed: 2 });
  });

  it('parseSet rejects bad probabilities, duplicate members and a chosen technician outside the set', () => {
    expect(parseSet(SET, 'A')).toHaveLength(2);
    expect(parseSet(SET, 'Z')).toBeNull();
    expect(parseSet({ ...SET, members: [{ id: 'A', score: 1, p: 1 }] }, 'A')).toBeNull();
    expect(parseSet({ ...SET, members: [{ id: 'A', score: 1, p: 0.5 }, { id: 'A', score: 1, p: 0.5 }] }, 'A')).toBeNull();
    expect(parseSet({ ...SET, members: [{ id: 'A', score: 1, p: 0 }, { id: 'B', score: 1, p: 1 }] }, 'B')).toBeNull();
    expect(parseSet(null, 'A')).toBeNull();
  });

  it('end to end: analyzeCausalDispatch returns effects for every outcome and factor provenance', () => {
    const out = analyzeCausalDispatch({ decisions: [dec('d1', 'j1', 'A'), dec('d2', 'j3', 'B')], jobs: [job('j1'), job('j3', { assigned_technician_id: 'B' })], reworks: [], durationResidual: { j1: 5 }, now: NOW });
    expect(Object.keys(out.effects).sort()).toEqual(['callback14', 'callback30', 'durationResidual', 'ftf']);
    expect(out.diagnostics.used).toBe(2);
    expect(out.effects.durationResidual.length).toBeGreaterThan(0);
  });
});
