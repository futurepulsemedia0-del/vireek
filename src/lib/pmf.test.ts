import { describe, expect, it } from 'vitest';
import {
  PMF_BENCHMARK_PCT, PMF_MIN_RELIABLE_N, PMF_SMALL_GROUPS, isPmfAnswer, overallPmf, parsePmfSummary, parseRetention, pmfVerdict, retentionMatrix,
} from '@/lib/pmf';

describe('parsePmfSummary', () => {
  it('maps server rows and recomputes the percentage from counts', () => {
    const rows = parsePmfSummary([{ segment: 'starter', n: 50, very: 21, somewhat: 15, not_disappointed: 10, no_longer_use: 4, pct_very: 42 }]);
    expect(rows).toEqual([{ segment: 'starter', n: 50, very: 21, somewhat: 15, notDisappointed: 10, noLongerUse: 4, pctVery: 42 }]);
  });
  it('survives garbage without throwing', () => {
    expect(parsePmfSummary(null)).toEqual([]);
    expect(parsePmfSummary([{ n: 'x', very: -3 }])).toEqual([{ segment: 'unknown', n: 0, very: 0, somewhat: 0, notDisappointed: 0, noLongerUse: 0, pctVery: 0 }]);
  });
});

describe('pmfVerdict', () => {
  it('never judges a small sample', () => {
    expect(pmfVerdict({ n: PMF_MIN_RELIABLE_N - 1, pctVery: 90 })).toBe('too_few');
  });
  it('uses the 40% benchmark inclusively', () => {
    expect(pmfVerdict({ n: PMF_MIN_RELIABLE_N, pctVery: PMF_BENCHMARK_PCT })).toBe('at_or_above_benchmark');
    expect(pmfVerdict({ n: 100, pctVery: 39.9 })).toBe('below_benchmark');
  });
});

describe('overallPmf', () => {
  it('pools counts instead of averaging percentages', () => {
    const rows = parsePmfSummary([
      { segment: 'a', n: 10, very: 9, somewhat: 1, not_disappointed: 0, no_longer_use: 0 },
      { segment: 'b', n: 90, very: 9, somewhat: 40, not_disappointed: 40, no_longer_use: 1 },
    ]);
    expect(overallPmf(rows)).toEqual({ n: 100, very: 18, pctVery: 18 });
    expect(overallPmf([])).toEqual({ n: 0, very: 0, pctVery: 0 });
  });
});

describe('answers', () => {
  it('accepts only the four known answers', () => {
    expect(isPmfAnswer('very_disappointed')).toBe(true);
    expect(isPmfAnswer('very')).toBe(false);
    expect(isPmfAnswer(3)).toBe(false);
  });
});

describe('retention', () => {
  const raw = [
    { segment: 'starter', week_offset: 0, cohort_accounts: 20, active_accounts: 20 },
    { segment: 'starter', week_offset: 4, cohort_accounts: 15, active_accounts: 9 },
    { segment: PMF_SMALL_GROUPS, week_offset: 0, cohort_accounts: 3, active_accounts: 3 },
    { segment: 'business', week_offset: 0, cohort_accounts: 8, active_accounts: 7 },
  ];
  it('clamps active to cohort size and computes percentages', () => {
    const rows = parseRetention([{ segment: 'x', week_offset: 1, cohort_accounts: 4, active_accounts: 9 }]);
    expect(rows[0]).toMatchObject({ activeAccounts: 4, retentionPct: 100 });
  });
  it('builds a matrix with small_groups last and null for unreached weeks', () => {
    const m = retentionMatrix(parseRetention(raw));
    expect(m.segments).toEqual(['starter', 'business', PMF_SMALL_GROUPS]);
    expect(m.offsets).toEqual([0, 4]);
    expect(m.cell('starter', 4)?.retentionPct).toBe(60);
    expect(m.cell('business', 4)).toBeNull();
  });
  it('ignores offsets beyond the requested horizon', () => {
    const m = retentionMatrix(parseRetention([{ segment: 'a', week_offset: 20, cohort_accounts: 5, active_accounts: 1 }]), 12);
    expect(m.segments).toEqual([]);
  });
});
