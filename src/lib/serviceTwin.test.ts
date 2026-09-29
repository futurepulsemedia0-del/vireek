import { describe, it, expect, vi } from 'vitest';

// Pure-helper tests: keep the Supabase client out of the unit under test.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
import { compareTwinsBySeverity, formatMinutes, formatOverrun, formatPct, type ServiceTwin } from './serviceTwin';

const twin = (status: ServiceTwin['status'], time_ratio: number) => ({ status, variance: { time_ratio } }) as ServiceTwin;

describe('formatMinutes', () => {
  it('formats minutes, hours and mixed', () => {
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(120)).toBe('2h');
    expect(formatMinutes(192)).toBe('3h 12m');
  });
  it('is safe on missing values', () => {
    expect(formatMinutes(null)).toBe('—');
    expect(formatMinutes(Number.NaN)).toBe('—');
  });
});

describe('formatOverrun', () => {
  it('shows signed overrun and "on plan" at or under plan', () => {
    expect(formatOverrun(1.6)).toBe('+60%');
    expect(formatOverrun(1)).toBe('on plan');
    expect(formatOverrun(0.8)).toBe('on plan');
  });
});

describe('formatPct', () => {
  it('rounds and handles null', () => {
    expect(formatPct(90.6)).toBe('91%');
    expect(formatPct(null)).toBe('—');
  });
});

describe('compareTwinsBySeverity', () => {
  it('puts critical first, then worse time ratio', () => {
    const list = [twin('watch', 1.2), twin('critical', 1.6), twin('watch', 1.3), twin('on_plan', 1)];
    const sorted = list.slice().sort(compareTwinsBySeverity);
    expect(sorted.map((t) => t.status)).toEqual(['critical', 'watch', 'watch', 'on_plan']);
    expect(sorted[1].variance.time_ratio).toBe(1.3);
  });
});
