import { describe, expect, it } from 'vitest';
import {
  buildInsightsCsv,
  changeTone,
  contributorBandLabel,
  formatChange,
  formatInsightValue,
  groupByTrade,
  normalizeCell,
  periodLabelHuman,
  rangePosition,
  regionLabel,
  tradeLabel,
  type InsightCell,
} from '@/lib/insights';

function cell(over: Partial<InsightCell> = {}): InsightCell {
  return {
    period_label: '2027-Q4',
    trade: 'hvac',
    region_key: 'all',
    metric: 'close_rate_pct',
    unit: 'percent',
    direction: 'higher_is_better',
    contributor_band: '20-49',
    p25: 30,
    p50: 41.2,
    p75: 52,
    qoq_change_pct: 2.5,
    ...over,
  };
}

describe('formatting', () => {
  it('formats each unit', () => {
    expect(formatInsightValue('cents', 48250)).toBe('$483');
    expect(formatInsightValue('percent', 41.234)).toBe('41.2%');
    expect(formatInsightValue('hours', 0.5)).toBe('30 min');
    expect(formatInsightValue('hours', 3.46)).toBe('3.5 h');
    expect(formatInsightValue('count', 48.4)).toBe('48');
    expect(formatInsightValue('index', 104.26)).toBe('104.3');
    expect(formatInsightValue('percent', Number.NaN)).toBe('-');
  });

  it('formats change and tone direction-aware', () => {
    expect(formatChange(4.2)).toBe('+4.2%');
    expect(formatChange(-3.14)).toBe('-3.1%');
    expect(formatChange(0)).toBe('0.0%');
    expect(formatChange(null)).toBe('-');
    expect(changeTone('higher_is_better', 2)).toBe('good');
    expect(changeTone('lower_is_better', -2)).toBe('good');
    expect(changeTone('lower_is_better', 2)).toBe('bad');
    expect(changeTone('neutral', 9)).toBe('neutral');
    expect(changeTone('higher_is_better', null)).toBe('neutral');
  });

  it('labels periods, trades, regions and bands', () => {
    expect(periodLabelHuman('2027-Q4')).toBe('Q4 2027');
    expect(periodLabelHuman('weird')).toBe('weird');
    expect(tradeLabel('pest-control')).toBe('Pest control');
    expect(tradeLabel('some-new-trade')).toBe('Some New Trade');
    expect(regionLabel('all')).toBe('United States');
    expect(regionLabel('tx')).toBe('Texas');
    expect(regionLabel('zz')).toBe('ZZ');
    expect(contributorBandLabel('100+')).toBe('100+ businesses');
    expect(contributorBandLabel('10-19')).toBe('10-19 businesses');
  });
});

describe('normalizeCell', () => {
  const good = { metric: 'close_rate_pct', unit: 'percent', direction: 'higher_is_better', contributor_band: '10-19', p25: '30', p50: '40', p75: '50', qoq_change_pct: null, trade: 'hvac', period_label: '2027-Q4' };

  it('coerces numeric strings and defaults region', () => {
    const c = normalizeCell(good);
    expect(c).not.toBeNull();
    expect(c?.p50).toBe(40);
    expect(c?.region_key).toBe('all');
    expect(c?.qoq_change_pct).toBeNull();
  });

  it('rejects disordered, missing or unknown values', () => {
    expect(normalizeCell({ ...good, p25: 60 })).toBeNull();
    expect(normalizeCell({ ...good, p50: null })).toBeNull();
    expect(normalizeCell({ ...good, metric: 'secret_metric' })).toBeNull();
    expect(normalizeCell({ ...good, contributor_band: '3' })).toBeNull();
    expect(normalizeCell({ ...good, unit: 'bananas' })).toBeNull();
  });
});

describe('groupByTrade', () => {
  it('puts all first, then sorts by label, and keys by metric', () => {
    const groups = groupByTrade([
      cell({ trade: 'plumbing' }),
      cell({ trade: 'all' }),
      cell({ trade: 'hvac', metric: 'avg_ticket_cents', unit: 'cents' }),
      cell({ trade: 'hvac' }),
    ]);
    expect(groups.map((g) => g.trade)).toEqual(['all', 'hvac', 'plumbing']);
    expect(groups[1].metrics.avg_ticket_cents).toBeDefined();
    expect(groups[1].metrics.close_rate_pct).toBeDefined();
  });
});

describe('rangePosition', () => {
  it('is bounded and safe for flat ranges', () => {
    expect(rangePosition(5, 0, 10)).toBe(50);
    expect(rangePosition(-5, 0, 10)).toBe(0);
    expect(rangePosition(50, 0, 10)).toBe(100);
    expect(rangePosition(3, 5, 5)).toBe(50);
  });
});

describe('buildInsightsCsv', () => {
  it('has a header, one row per cell, and never exposes exact counts', () => {
    const csv = buildInsightsCsv([cell(), cell({ trade: 'plumbing', qoq_change_pct: null })]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('period,trade,region,metric,unit,p25,median,p75,qoq_change_pct,businesses');
    expect(lines[1]).toBe('2027-Q4,hvac,all,close_rate_pct,percent,30,41.2,52,2.5,20-49');
    expect(lines[2].endsWith(',,20-49')).toBe(true);
  });

  it('neutralises spreadsheet formulas', () => {
    const csv = buildInsightsCsv([cell({ trade: '=HYPERLINK("x")' })]);
    expect(csv.split('\n')[1].startsWith("2027-Q4,\"'=HYPERLINK(\"\"x\"\")\"")).toBe(true);
  });
});
