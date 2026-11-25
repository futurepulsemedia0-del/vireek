import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

import { currentMonth, monthToDate, previewScore, verdictFor, type Criterion } from '@/lib/aiCallQa';

const rubric: Criterion[] = [
  { key: 'accuracy', label: 'A', weight: 30, description: '' }, { key: 'safety', label: 'S', weight: 25, description: '' },
  { key: 'disclosure', label: 'D', weight: 15, description: '' }, { key: 'resolution', label: 'R', weight: 20, description: '' },
  { key: 'tone', label: 'T', weight: 10, description: '' },
];

describe('previewScore (mirrors the SQL scoring)', () => {
  it('all 5s = 100, all 1s = 0', () => {
    expect(previewScore(rubric, { accuracy: 5, safety: 5, disclosure: 5, resolution: 5, tone: 5 }).overall).toBe(100);
    expect(previewScore(rubric, { accuracy: 1, safety: 1, disclosure: 1, resolution: 1, tone: 1 }).overall).toBe(0);
  });
  it('N/A criteria are excluded from the weighting', () => {
    expect(previewScore(rubric, { accuracy: 5, safety: null, disclosure: 5, resolution: 5, tone: 5 })).toEqual({ overall: 100, scored: 4 });
  });
  it('weights apply (accuracy 3, rest 5)', () => {
    // 30*0.5 + 70*1 = 85
    expect(previewScore(rubric, { accuracy: 3, safety: 5, disclosure: 5, resolution: 5, tone: 5 }).overall).toBe(85);
  });
  it('needs at least 3 scored criteria and ignores invalid values', () => {
    expect(previewScore(rubric, { accuracy: 5, safety: 5 }).overall).toBeNull();
    expect(previewScore(rubric, { accuracy: 6, safety: 0, disclosure: 2.5, resolution: 5, tone: 5 }).scored).toBe(2);
  });
});

describe('verdictFor', () => {
  it('thresholds and critical override', () => {
    expect(verdictFor(80, false)).toBe('pass');
    expect(verdictFor(79, false)).toBe('needs_improvement');
    expect(verdictFor(60, false)).toBe('needs_improvement');
    expect(verdictFor(59, false)).toBe('fail');
    expect(verdictFor(100, true)).toBe('fail');
  });
});

describe('month helpers', () => {
  it('formats and validates months', () => {
    expect(currentMonth(new Date('2026-11-25T10:00:00Z'))).toBe('2026-11');
    expect(monthToDate('2026-03')).toBe('2026-03-01');
    expect(monthToDate('garbage')).toBe(`${currentMonth()}-01`);
    expect(monthToDate('2026-13')).toBe(`${currentMonth()}-01`);
  });
});
