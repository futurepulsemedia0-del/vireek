import { describe, expect, it } from 'vitest';
import { fmtDelta, fmtPct, fmtUsd, rangeFromDays } from './analyticsFormat';

describe('analyticsFormat', () => {
  it('renders null as an em dash, never 0', () => {
    expect(fmtPct(null)).toBe('—');
    expect(fmtUsd(undefined)).toBe('—');
    expect(fmtPct(0)).toBe('0.0%');
  });
  it('formats basis points and cents', () => {
    expect(fmtPct(3217)).toBe('32.2%');
    expect(fmtUsd(320000)).toBe('$3,200');
  });
  it('delta tone depends on which direction is better', () => {
    expect(fmtDelta(8000, 7500, 'pct', 'up')).toEqual({ text: '+5.0 pts', tone: 'good' });
    expect(fmtDelta(1500, 1000, 'pct', 'down')).toEqual({ text: '+5.0 pts', tone: 'bad' });
    expect(fmtDelta(100000, 150000, 'usd', 'up')).toEqual({ text: '-$500', tone: 'bad' });
    expect(fmtDelta(5, 5, 'pct', 'up').tone).toBe('flat');
    expect(fmtDelta(null, 5, 'pct', 'up').tone).toBe('none');
  });
  it('rangeFromDays is inclusive', () => {
    expect(rangeFromDays(7, new Date('2028-03-12T10:00:00Z'))).toEqual({ from: '2028-03-06', to: '2028-03-12' });
  });
});
