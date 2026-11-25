import { describe, expect, it } from 'vitest';
import { formatUsd, groupByTrade, tradeLabel, type PublishedCell } from './costIndex';

const cell = (o: Partial<PublishedCell>): PublishedCell => ({
  trade: 'hvac', region: 'south', job_kind: 'repair', period_key: '2026-Q3', suppressed: false, suppression_reason: null,
  n_orgs: 25, n_jobs: 640, p25_cents: 31_000, p50_cents: 43_000, p75_cents: 59_000, ...o,
});

describe('costIndex helpers', () => {
  it('formats whole dollars and a dash for withheld values', () => {
    expect(formatUsd(43_000)).toBe('$430');
    expect(formatUsd(1_230_000)).toBe('$12,300');
    expect(formatUsd(null)).toBe('—');
  });
  it('groups by trade for one job kind with regions in fixed order and keeps withheld cells', () => {
    const g = groupByTrade([
      cell({ region: 'west' }), cell({ region: 'all' }), cell({ region: 'midwest', suppressed: true, suppression_reason: 'k_anonymity', p50_cents: null }),
      cell({ trade: 'plumbing', region: 'all' }), cell({ job_kind: 'install', region: 'all' }),
    ], 'repair');
    expect(g.map((x) => x.trade)).toEqual(['hvac', 'plumbing']);
    expect(g[0].rows.map((r) => r.region)).toEqual(['all', 'midwest', 'west']);
    expect(g[0].rows[1].suppressed).toBe(true);
  });
  it('title-cases trade slugs', () => { expect(tradeLabel('garage-doors')).toBe('Garage Doors'); });
});
