import { describe, expect, it } from 'vitest';
import {
  analyzeOutcomes,
  contributorLabel,
  formatDuration,
  formatGap,
  formatOutcomeValue,
  gapToTarget,
  getLever,
  leversFor,
  outperformPct,
  prettyIndustry,
  scopeLabel,
  topQuartileValue,
  type OutcomeBenchmarkRow,
} from '@/lib/outcomeBenchmark';

function row(over: Partial<OutcomeBenchmarkRow>): OutcomeBenchmarkRow {
  return {
    metric: 'first_time_fix_rate',
    unit: 'percent',
    direction: 'higher_is_better',
    my_value: 60,
    my_sample: 40,
    scope: 'region',
    industry: 'hvac',
    region_key: 'tx',
    contributor_count: 14,
    p10: 50,
    p25: 62,
    p50: 71,
    p75: 80,
    p90: 89,
    percentile_bucket: 'bottom25',
    ...over,
  };
}

const RESP = row({
  metric: 'median_response_minutes', unit: 'minutes', direction: 'lower_is_better',
  my_value: 200, p10: 30, p25: 48, p50: 134, p75: 220, p90: 400, percentile_bucket: 'bottom50',
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(0.4)).toBe('<1m');
    expect(formatDuration(48)).toBe('48m');
    expect(formatDuration(134)).toBe('2h 14m');
    expect(formatDuration(120)).toBe('2h');
    expect(formatDuration(1500)).toBe('1d 1h');
  });
  it('formats values and gaps', () => {
    expect(formatOutcomeValue(71.4, 'percent')).toBe('71%');
    expect(formatOutcomeValue(7.25, 'percent')).toBe('7.3%');
    expect(formatGap(11, 'percent')).toBe('11 pts');
    expect(formatGap(86, 'minutes')).toBe('1h 26m');
  });
  it('rounds contributor counts down and labels scope', () => {
    expect(contributorLabel(null)).toBe('5+');
    expect(contributorLabel(7)).toBe('5+');
    expect(contributorLabel(14)).toBe('10+');
    expect(contributorLabel(27)).toBe('25+');
    expect(prettyIndustry('hvac')).toBe('HVAC');
    expect(prettyIndustry('garage-door')).toBe('Garage Door');
    expect(scopeLabel(row({}))).toBe('10+ HVAC businesses in TX');
    expect(scopeLabel(row({ scope: 'industry' }))).toBe('10+ HVAC businesses nationwide');
    expect(scopeLabel(row({ scope: 'none' }))).toBe('Not enough peers yet');
  });
});

describe('gaps and percentiles', () => {
  it('computes gaps for both directions and never goes negative', () => {
    expect(gapToTarget(row({}), 'median')).toBe(11);
    expect(gapToTarget(row({}), 'top_quartile')).toBe(20);
    expect(gapToTarget(row({ my_value: 90 }), 'top_quartile')).toBe(0);
    expect(gapToTarget(RESP, 'median')).toBe(66);
    expect(topQuartileValue(RESP)).toBe(48);
    expect(gapToTarget(RESP, 'top_quartile')).toBe(152);
    expect(gapToTarget(row({ p50: null }), 'median')).toBe(0);
  });
  it('estimates outperform share by interpolation', () => {
    expect(outperformPct(row({ my_value: 71 }))).toBe(50);
    expect(outperformPct(row({ my_value: 95 }))).toBe(95);
    expect(outperformPct(row({ my_value: 10 }))).toBe(5);
    expect(outperformPct(row({ my_value: 66.5 }))).toBe(38);
    expect(outperformPct({ ...RESP, my_value: 134 })).toBe(50);
    expect(outperformPct({ ...RESP, my_value: 20 })).toBe(95);
    expect(outperformPct(row({ p90: null }))).toBeNull();
  });
  it('does not divide by zero on flat anchors', () => {
    const flat = row({ my_value: 50, p10: 50, p25: 50, p50: 50, p75: 50, p90: 50 });
    expect(outperformPct(flat)).toBe(5);
  });
});

describe('analyzeOutcomes', () => {
  it('orders weakest relative gap first and ignores uncomparable rows', () => {
    const rows = [
      row({ metric: 'reservice_rate', direction: 'lower_is_better', my_value: 5, p10: 2, p25: 4, p50: 11, p75: 16, p90: 22, percentile_bucket: 'top50' }),
      RESP,
      row({}),
      row({ metric: 'reservice_rate', scope: 'none', p50: null }),
    ];
    const a = analyzeOutcomes(rows);
    expect(a.comparable.map((r) => r.metric)).toEqual(['first_time_fix_rate', 'median_response_minutes', 'reservice_rate']);
    expect(a.behind.map((b) => b.row.metric)).toEqual(['median_response_minutes', 'first_time_fix_rate']);
    expect(a.strong).toHaveLength(0);
  });
});

describe('levers', () => {
  it('maps primary levers per metric and resolves ids', () => {
    expect(leversFor('median_response_minutes').map((l) => l.id)).toContain('dispatch_board');
    expect(leversFor('first_time_fix_rate').map((l) => l.id)).toContain('ftf_autopilot');
    expect(getLever('on_call')?.href).toBe('/dashboard/on-call');
    expect(getLever('nope')).toBeNull();
  });
});
