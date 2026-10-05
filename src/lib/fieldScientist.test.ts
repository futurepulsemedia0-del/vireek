import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  assignArm,
  benjaminiHochberg,
  cochranMantelHaenszel,
  discoverHypotheses,
  requiredSampleSizePerArm,
  twoProportionTest,
  type JobFeature,
} from '@/lib/fieldScientist';

function lcg(seed: number) {
  // mulberry32 — small, fast, well-mixed deterministic PRNG
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function job(i: number, over: Partial<JobFeature>): JobFeature {
  return {
    id: `j${i}`, techId: 'B', techName: 'Bea', techGroup: null, equipment: 'ac', service: 'repair',
    timeBucket: 'weekday morning', durationBucket: '60–120 min', tags: [], completedAtMs: 1, callback: false, ...over,
  };
}

describe('twoProportionTest', () => {
  it('detects a real difference and gives a CI that excludes zero', () => {
    const t = twoProportionTest({ n: 200, k: 40 }, { n: 300, k: 30 });
    expect(t.z).toBeCloseTo(3.16, 1);
    expect(t.p).toBeLessThan(0.01);
    expect(t.ci_low).toBeGreaterThan(0);
  });

  it('does not flag identical rates', () => {
    const t = twoProportionTest({ n: 100, k: 10 }, { n: 100, k: 10 });
    expect(t.diff).toBe(0);
    expect(t.p).toBeGreaterThan(0.99);
  });
});

describe('requiredSampleSizePerArm', () => {
  it('matches the textbook value for 20% -> 10%', () => {
    expect(requiredSampleSizePerArm(0.2, 0.1)).toBe(199);
  });
  it('is infinite when there is no effect to detect', () => {
    expect(requiredSampleSizePerArm(0.1, 0.1)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('benjaminiHochberg', () => {
  it('is monotone and never below the raw p-value', () => {
    const raw = [0.01, 0.04, 0.03, 0.005];
    const adj = benjaminiHochberg(raw);
    adj.forEach((q, i) => expect(q).toBeGreaterThanOrEqual(raw[i]));
    expect(adj[3]).toBeCloseTo(0.02, 5);
  });
});

describe('cochranMantelHaenszel', () => {
  it('returns null with no usable strata', () => {
    expect(cochranMantelHaenszel([{ a: 0, b: 0, c: 0, d: 0 }])).toBeNull();
  });
  it('reports an odds ratio above 1 when the segment has more events in every stratum', () => {
    const r = cochranMantelHaenszel([{ a: 10, b: 40, c: 5, d: 45 }, { a: 8, b: 42, c: 4, d: 46 }]);
    expect(r?.oddsRatio).toBeGreaterThan(1);
  });
});

describe('assignArm', () => {
  it('is deterministic and roughly balanced', () => {
    expect(assignArm('job-1', 'seed')).toBe(assignArm('job-1', 'seed'));
    let treatment = 0;
    for (let i = 0; i < 4000; i++) if (assignArm(`job-${i}`, 'seed') === 'treatment') treatment++;
    expect(treatment).toBeGreaterThan(1800);
    expect(treatment).toBeLessThan(2200);
  });
});

describe('discoverHypotheses', () => {
  it('finds a planted technician x equipment effect and ranks it first', () => {
    const rnd = lcg(7);
    const techs: Array<[string, string]> = [['A', 'Alex'], ['B', 'Bea'], ['C', 'Cy']];
    const equipment = ['furnace', 'ac', 'boiler'];
    const jobs: JobFeature[] = [];
    for (let i = 0; i < 1500; i++) {
      const [techId, techName] = techs[Math.floor(rnd() * 3)];
      const eq = equipment[Math.floor(rnd() * 3)];
      const rate = techId === 'A' && eq === 'furnace' ? 0.28 : 0.08;
      jobs.push(job(i, { techId, techName, equipment: eq, service: rnd() < 0.5 ? 'repair' : 'install', callback: rnd() < rate }));
    }
    const { proposals } = discoverHypotheses(jobs);
    expect(proposals[0].segment_label).toBe('Alex on furnace');
    expect(proposals[0].direction).toBe('worse');
    expect(proposals[0].discovery.q_value).toBeLessThan(0.01);
  });

  it('proposes nothing when callbacks are pure noise', () => {
    const rnd = lcg(11);
    const jobs = Array.from({ length: 1200 }, (_, i) =>
      job(i, { techId: ['A', 'B', 'C'][i % 3], techName: 'T', equipment: ['furnace', 'ac'][i % 2], callback: rnd() < 0.1 }));
    expect(discoverHypotheses(jobs).proposals).toHaveLength(0);
  });

  it('filters a segment whose gap is entirely explained by job mix', () => {
    const rnd = lcg(3);
    const jobs: JobFeature[] = [];
    for (let i = 0; i < 2000; i++) {
      // Tech A mostly does "install" jobs, which have a high callback rate for EVERYONE.
      const isA = rnd() < 0.5;
      const service = isA ? (rnd() < 0.9 ? 'install' : 'repair') : (rnd() < 0.1 ? 'install' : 'repair');
      jobs.push(job(i, { techId: isA ? 'A' : 'B', techName: isA ? 'Alex' : 'Bea', service, callback: rnd() < (service === 'install' ? 0.25 : 0.05) }));
    }
    const { proposals, confoundedFiltered } = discoverHypotheses(jobs);
    expect(proposals.filter((p) => p.segment_dimension === 'technician')).toHaveLength(0);
    expect(confoundedFiltered).toBeGreaterThan(0);
  });
});
