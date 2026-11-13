import { describe, it, expect } from 'vitest';
import { analyzeNatural, chiSquareP, ipwContrast, recordFromExplanation, srmNatural, type NaturalRecord } from './naturalRandomization';

// Deterministic PRNG so the simulation is reproducible.
function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const groups = { a: 'treatment', b: 'control', c: 'control' } as const;

function simulate(n: number, trueEffect: number, seed = 7): NaturalRecord[] {
  const rnd = mulberry32(seed);
  const out: NaturalRecord[] = [];
  for (let i = 0; i < n; i++) {
    const tie = rnd() < 0.5 ? ['a', 'b'] : ['a', 'b', 'c']; // unequal propensities across jobs
    const drawn = tie[Math.floor(rnd() * tie.length)];
    const base = 0.8;
    const y = rnd() < base + (drawn === 'a' ? trueEffect : 0) ? 1 : 0;
    out.push({ job_id: `j${i}`, tie_set: tie.map((t) => ({ technician_id: t, score: 10 })), drawn_technician_id: drawn, executed_as_drawn: true, outcome: y });
  }
  return out;
}

describe('recordFromExplanation', () => {
  it('returns null unless randomization was applied', () => {
    expect(recordFromExplanation('j', {}, 1)).toBeNull();
    expect(recordFromExplanation('j', { randomization: { applied: false } }, 1)).toBeNull();
    expect(recordFromExplanation('j', { randomization: { applied: true, tie_set: [{ technician_id: 'a', score: 1 }, { technician_id: 'b', score: 1 }], drawn_technician_id: 'a', executed_as_drawn: true } }, 1)).not.toBeNull();
  });
});

describe('ipwContrast', () => {
  it('recovers a known effect and its CI covers it', () => {
    const r = ipwContrast(simulate(20000, 0.1), groups)!;
    expect(r.effect).toBeGreaterThan(0.07);
    expect(r.effect).toBeLessThan(0.13);
    expect(r.ciLow).toBeLessThan(0.1);
    expect(r.ciHigh).toBeGreaterThan(0.1);
  });
  it('finds no effect under the null (|z| small)', () => {
    expect(Math.abs(ipwContrast(simulate(20000, 0, 11), groups)!.z)).toBeLessThan(3.3);
  });
  it('ignores jobs whose tie set lacks one of the groups (positivity) and immature outcomes', () => {
    const rec: NaturalRecord[] = [{ job_id: 'x', tie_set: [{ technician_id: 'b', score: 1 }, { technician_id: 'c', score: 1 }], drawn_technician_id: 'b', executed_as_drawn: true, outcome: 1 }];
    expect(ipwContrast(rec, groups)).toBeNull();
  });
});

describe('srmNatural', () => {
  it('passes for a fair lottery', () => {
    expect(srmNatural(simulate(5000, 0)).failed).toBe(false);
  });
  it('fails when one technician is drawn far more than their propensity allows', () => {
    const rigged = simulate(3000, 0).map((r) => ({ ...r, drawn_technician_id: 'a' }));
    const s = srmNatural(rigged);
    expect(s.failed).toBe(true);
    expect(s.worstRatioDeviation).toBeGreaterThan(0.3);
  });
  it('chiSquareP matches known values', () => {
    expect(chiSquareP(3.841, 1)).toBeCloseTo(0.05, 2);
    expect(chiSquareP(5.991, 2)).toBeCloseTo(0.05, 2);
  });
});

describe('analyzeNatural', () => {
  const args = { groups: { ...groups }, baselineRate: 0.8, mde: 0.05 };
  it('refuses to conclude with thin data', () => {
    expect(analyzeNatural({ ...args, records: simulate(40, 0.2) }).verdict).toBe('collecting');
  });
  it('reports a benefit with enough data', () => {
    const a = analyzeNatural({ ...args, records: simulate(20000, 0.1) });
    expect(a.verdict).toBe('treatment_better');
    expect(a.messageKey).toBe('dispatch.natural.treatmentBetter');
  });
  it('is inconclusive (not "no difference") when the CI is still wide', () => {
    // Identical outcome pattern in both arms => effect exactly 0, but n (200/arm) is below the planned size for a 5 pp effect.
    const flat: NaturalRecord[] = Array.from({ length: 400 }, (_, i) => ({
      job_id: `f${i}`, tie_set: [{ technician_id: 'a', score: 1 }, { technician_id: 'b', score: 1 }], drawn_technician_id: i % 2 === 0 ? 'a' : 'b', executed_as_drawn: true, outcome: Math.floor(i / 2) % 5 === 0 ? 0 : 1,
    }));
    const a = analyzeNatural({ ...args, records: flat });
    expect(a.verdict).toBe('inconclusive');
    expect(a.contrast!.effect).toBeCloseTo(0, 10);
  });
  it('is invalid when the sample-ratio check fails', () => {
    expect(analyzeNatural({ ...args, records: simulate(3000, 0).map((r) => ({ ...r, drawn_technician_id: 'a' })) }).verdict).toBe('invalid');
  });
});

import { summarizeDraws, validateSettings } from './naturalRandomization';

describe('summarizeDraws / validateSettings', () => {
  const drawn = (job: string) => ({
    job_id: job, created_at: '2026-01-01T00:00:00Z',
    explanation: { randomization: { applied: true, reason: 'drawn', tie_set: [{ technician_id: 'a', score: 1 }, { technician_id: 'b', score: 1 }], drawn_technician_id: 'a', executed_as_drawn: true } },
  });
  it('counts drawn and skipped decisions', () => {
    const s = summarizeDraws([
      drawn('1'), drawn('2'),
      { job_id: '3', created_at: '', explanation: { randomization: { applied: false, reason: 'vip_job' } } },
      { job_id: '4', created_at: '', explanation: {} },
    ]);
    expect(s.total).toBe(3);
    expect(s.applied).toBe(2);
    expect(s.skipped.vip_job).toBe(1);
    expect(s.balance.rows.length).toBe(2);
  });
  it('validates bounds', () => {
    expect(validateSettings({ epsilon: 0.5, top_k: 2, max_eta_delta_minutes: 10 })).toEqual([]);
    expect(validateSettings({ epsilon: 11, top_k: 1, max_eta_delta_minutes: 121 })).toEqual(['epsilon', 'topK', 'eta']);
    expect(validateSettings({ epsilon: NaN, top_k: 2.5, max_eta_delta_minutes: -1 })).toEqual(['epsilon', 'topK', 'eta']);
  });
});
