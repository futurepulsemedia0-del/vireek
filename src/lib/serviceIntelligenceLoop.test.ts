import { describe, expect, it } from 'vitest';
import {
  LOOP_MILESTONES,
  evidenceLevel,
  listLoopContexts,
  loopContextFor,
  milestoneProgress,
  pct,
  priorLift,
  resolveLoopContext,
  type LoopMetrics,
} from '@/lib/serviceIntelligenceLoop';

const preds = (over: Partial<LoopMetrics['predictions']> = {}): LoopMetrics['predictions'] => ({
  cases: 0,
  scored: 0,
  top1: 0,
  top3: 0,
  with_priors_scored: 0,
  with_priors_top1: 0,
  without_priors_scored: 0,
  without_priors_top1: 0,
  ...over,
});

describe('resolveLoopContext', () => {
  it('returns null for empty or unknown service types', () => {
    expect(resolveLoopContext(null)).toBeNull();
    expect(resolveLoopContext('   ')).toBeNull();
    expect(resolveLoopContext('zzz unrelated text')).toBeNull();
  });

  it('maps an AC complaint to hvac / ac-no-cooling with catalog cause keys', () => {
    const ctx = resolveLoopContext('AC not cooling');
    expect(ctx?.playbookSlug).toBe('hvac');
    expect(ctx?.jobTypeKey).toBe('ac-no-cooling');
    expect(ctx?.candidates.map((c) => c.key)).toContain('failed-capacitor');
  });

  it('prefers the longest fragment across playbooks (water heater is plumbing, not hvac)', () => {
    const ctx = resolveLoopContext('Water heater leaking');
    expect(ctx?.playbookSlug).toBe('plumbing');
    expect(ctx?.jobTypeKey).toBe('water-heater');
  });
});

describe('loopContextFor / listLoopContexts', () => {
  it('returns null for unknown or cause-less job types', () => {
    expect(loopContextFor('hvac', 'nope')).toBeNull();
    expect(loopContextFor('nope', 'ac-no-cooling')).toBeNull();
  });

  it('every listed context has 1..12 candidates with unique, vocabulary-safe keys', () => {
    const all = listLoopContexts();
    expect(all.length).toBeGreaterThan(0);
    for (const ctx of all) {
      expect(ctx.candidates.length).toBeGreaterThan(0);
      expect(ctx.candidates.length).toBeLessThanOrEqual(12);
      const keys = ctx.candidates.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) expect(/^[a-z0-9-]{2,48}$/.test(k)).toBe(true);
      expect(/^[a-z0-9-]{2,40}$/.test(ctx.playbookSlug)).toBe(true);
      expect(/^[a-z0-9-]{2,48}$/.test(ctx.jobTypeKey)).toBe(true);
    }
  });
});

describe('milestoneProgress', () => {
  it('handles zero, bad input and the first milestone', () => {
    expect(milestoneProgress(0)).toEqual({ reached: null, next: 100, pct: 0 });
    expect(milestoneProgress(Number.NaN)).toEqual({ reached: null, next: 100, pct: 0 });
    expect(milestoneProgress(50).pct).toBe(50);
  });

  it('advances through the ladder and caps at the top', () => {
    expect(milestoneProgress(100)).toEqual({ reached: 100, next: 1000, pct: 0 });
    expect(milestoneProgress(5_500)).toEqual({ reached: 1000, next: 10_000, pct: 50 });
    const top = LOOP_MILESTONES[LOOP_MILESTONES.length - 1];
    expect(milestoneProgress(top)).toEqual({ reached: top, next: null, pct: 100 });
    expect(milestoneProgress(top * 3).pct).toBe(100);
  });
});

describe('evidenceLevel', () => {
  it('is conservative at the edges', () => {
    expect(evidenceLevel(0)).toBe('cold');
    expect(evidenceLevel(9.9)).toBe('cold');
    expect(evidenceLevel(10)).toBe('learning');
    expect(evidenceLevel(30)).toBe('reliable');
    expect(evidenceLevel(100)).toBe('proven');
    expect(evidenceLevel(Number.NaN)).toBe('cold');
  });
});

describe('pct / priorLift', () => {
  it('never reports a fake 0% for empty data', () => {
    expect(pct(0, 0)).toBeNull();
    expect(pct(3, 4)).toBe(75);
    expect(pct(9, 4)).toBe(100);
  });

  it('needs enough scored cases on both sides before claiming a lift', () => {
    expect(priorLift(preds({ with_priors_scored: 9, without_priors_scored: 50 }))).toBeNull();
    const lift = priorLift(
      preds({ with_priors_scored: 20, with_priors_top1: 15, without_priors_scored: 20, without_priors_top1: 10 }),
    );
    expect(lift).toBe(25);
  });
});
