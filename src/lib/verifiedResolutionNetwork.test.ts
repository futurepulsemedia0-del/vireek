import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));

import { formatValue, industries, industryRows, isStale, parseSummary, platformCell, STALE_AFTER_HOURS } from '@/lib/verifiedResolutionNetwork';

const row = (o: Record<string, unknown> = {}) => ({
  metric: 'first_time_fix_rate', unit: 'percent', direction: 'higher_is_better', window_days: 90, scope: 'platform', industry: null,
  contributors: 12, p25: 70, p50: 80, p75: 88, computed_at: '2026-11-24T00:00:00Z', ...o,
});

describe('parseSummary', () => {
  it('returns an empty summary for garbage', () => {
    expect(parseSummary(null).rows).toEqual([]);
    expect(parseSummary('x').rows).toEqual([]);
    expect(parseSummary({ rows: 5 }).rows).toEqual([]);
  });
  it('drops rows below k, with bad metric/window/scope or missing percentiles', () => {
    const s = parseSummary({ k_threshold: 10, rows: [
      row(), row({ contributors: 9 }), row({ metric: 'revenue' }), row({ window_days: 7 }), row({ scope: 'region' }), row({ p50: null }),
    ] });
    expect(s.rows).toHaveLength(1);
  });
});

describe('cells', () => {
  const s = parseSummary({ k_threshold: 10, rows: [row(), row({ scope: 'industry', industry: 'hvac', metric: 'reservice_rate', unit: 'percent', direction: 'lower_is_better' })] });
  it('returns insufficient (never a number) when no row exists', () => {
    expect(platformCell(s, 'median_response_minutes', 90)).toEqual({ state: 'insufficient' });
    expect(platformCell(s, 'first_time_fix_rate', 30)).toEqual({ state: 'insufficient' });
  });
  it('returns the real row when present', () => {
    const c = platformCell(s, 'first_time_fix_rate', 90, Date.parse('2026-11-25T00:00:00Z'));
    expect(c.state).toBe('ok');
    if (c.state === 'ok') { expect(c.row.p50).toBe(80); expect(c.stale).toBe(false); }
  });
  it('lists industries and their rows per window', () => {
    expect(industries(s, 90)).toEqual(['hvac']);
    expect(industries(s, 30)).toEqual([]);
    expect(industryRows(s, 'hvac', 90)).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('flags stale and missing timestamps', () => {
    const now = Date.parse('2026-11-25T00:00:00Z');
    expect(isStale(null, now)).toBe(true);
    expect(isStale('nope', now)).toBe(true);
    expect(isStale(new Date(now - (STALE_AFTER_HOURS + 1) * 3_600_000).toISOString(), now)).toBe(true);
    expect(isStale(new Date(now - 3_600_000).toISOString(), now)).toBe(false);
  });
  it('formats values', () => {
    expect(formatValue(80.04, 'percent')).toBe('80%');
    expect(formatValue(12.36, 'minutes')).toBe('12.4 min');
  });
});
