import { describe, expect, it } from 'vitest';
import { FUNNEL_ORDER, formatMinutes, normalizeFunnel } from './activation';

describe('normalizeFunnel', () => {
  it('returns every step in funnel order, zero-filled', () => {
    const rows = normalizeFunnel([{ event: 'first_booking', accounts: '3', pct_of_signups: '30.5', median_minutes_from_signup: '90' }]);
    expect(rows.map((r) => r.event)).toEqual([...FUNNEL_ORDER]);
    expect(rows.find((r) => r.event === 'first_booking')).toEqual({ event: 'first_booking', accounts: 3, pctOfSignups: 30.5, medianMinutes: 90 });
    expect(rows.find((r) => r.event === 'signup')).toEqual({ event: 'signup', accounts: 0, pctOfSignups: 0, medianMinutes: null });
  });
  it('tolerates null/garbage input', () => {
    expect(normalizeFunnel(null)).toHaveLength(FUNNEL_ORDER.length);
    expect(normalizeFunnel([{ event: 'signup', accounts: 'x', pct_of_signups: 'y', median_minutes_from_signup: 'z' }])[0]).toMatchObject({ accounts: 0, pctOfSignups: 0, medianMinutes: null });
  });
});

describe('formatMinutes', () => {
  it.each([[null, '—'], [-5, '—'], [12.4, '12 min'], [180, '3.0 h'], [4320, '3.0 d']])('%s → %s', (v, out) => {
    expect(formatMinutes(v as number | null)).toBe(out);
  });
});
