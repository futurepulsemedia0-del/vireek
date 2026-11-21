import { describe, expect, it } from 'vitest';
import {
  classifyRatio,
  formatMonth,
  formatRatio,
  latestMonths,
  levelTone,
  trend,
  validateThresholds,
  worstLevel,
  type TenantMonthRow,
} from './disputeRatio';

const row = (month: string, disputes: number, txn: number, over: Partial<TenantMonthRow> = {}): TenantMonthRow => ({
  user_id: 'u1',
  month,
  disputes_count: disputes,
  txn_count: txn,
  ratio_pct: txn > 0 ? Math.round((100000 * disputes) / txn) / 1000 : null,
  level: classifyRatio(disputes, txn, 0.5, 0.75, 20),
  warning_pct: 0.5,
  critical_pct: 0.75,
  min_transactions: 20,
  ...over,
});

describe('classifyRatio (mirror of SQL dispute_ratio_level)', () => {
  it('needs the minimum sample before judging', () => {
    expect(classifyRatio(5, 19, 0.5, 0.75, 20)).toBe('insufficient_data');
    expect(classifyRatio(0, 0, 0.5, 0.75, 20)).toBe('insufficient_data');
  });
  it('is inclusive at both thresholds', () => {
    expect(classifyRatio(1, 200, 0.5, 0.75, 20)).toBe('warning'); // exactly 0.50%
    expect(classifyRatio(3, 400, 0.5, 0.75, 20)).toBe('critical'); // exactly 0.75%
    expect(classifyRatio(1, 201, 0.5, 0.75, 20)).toBe('ok');
  });
  it('zero disputes is ok once the sample is large enough', () => {
    expect(classifyRatio(0, 20, 0.5, 0.75, 20)).toBe('ok');
  });
  it('treats a non-positive minimum as 1', () => {
    expect(classifyRatio(0, 1, 0.5, 0.75, 0)).toBe('ok');
  });
});

describe('formatting', () => {
  it('formats ratios and null', () => {
    expect(formatRatio(0.5, 'en-US')).toBe('0.50%');
    expect(formatRatio(1.2345, 'en-US')).toBe('1.235%');
    expect(formatRatio(null)).toBe('—');
  });
  it('formats months without time-zone drift', () => {
    expect(formatMonth('2026-11-01', 'en-US')).toBe('Nov 2026');
    expect(formatMonth('2027-01-01', 'en-US')).toBe('Jan 2027');
    expect(formatMonth('garbage')).toBe('garbage');
  });
});

describe('levels and ordering', () => {
  it('worstLevel picks the most severe', () => {
    expect(worstLevel(['ok', 'warning', 'insufficient_data'])).toBe('warning');
    expect(worstLevel(['ok', 'critical', 'warning'])).toBe('critical');
    expect(worstLevel([])).toBe('insufficient_data');
  });
  it('maps level to a tone', () => {
    expect(levelTone('ok')).toBe('success');
    expect(levelTone('critical')).toBe('danger');
    expect(levelTone('insufficient_data')).toBe('neutral');
  });
  it('latestMonths sorts newest first and caps', () => {
    const rows = [row('2026-08-01', 0, 50), row('2026-10-01', 0, 50), row('2026-09-01', 0, 50)];
    expect(latestMonths(rows, 2).map((r) => r.month)).toEqual(['2026-10-01', '2026-09-01']);
    expect(latestMonths(rows, 0)).toEqual([]);
  });
});

describe('trend', () => {
  it('detects up, down, flat and not-enough-data', () => {
    expect(trend([row('2026-10-01', 1, 100), row('2026-11-01', 2, 100)])).toBe('up');
    expect(trend([row('2026-10-01', 2, 100), row('2026-11-01', 1, 100)])).toBe('down');
    expect(trend([row('2026-10-01', 1, 100), row('2026-11-01', 1, 100)])).toBe('flat');
    expect(trend([row('2026-11-01', 1, 100)])).toBeNull();
  });
  it('ignores months with too little data', () => {
    expect(trend([row('2026-10-01', 1, 100), row('2026-11-01', 3, 10)])).toBeNull();
  });
});

describe('validateThresholds', () => {
  it('accepts a sane config', () => {
    expect(validateThresholds({ warning: '0.5', critical: '0.75', minTransactions: '20' })).toEqual({
      error: null,
      value: { warning: 0.5, critical: 0.75, minTransactions: 20 },
    });
  });
  it('rejects bad input', () => {
    expect(validateThresholds({ warning: 'x', critical: '1', minTransactions: '20' }).error).toBe('invalidNumber');
    expect(validateThresholds({ warning: '1', critical: '0.5', minTransactions: '20' }).error).toBe('order');
    expect(validateThresholds({ warning: '1', critical: '101', minTransactions: '20' }).error).toBe('range');
    expect(validateThresholds({ warning: '0.5', critical: '0.75', minTransactions: '0' }).error).toBe('minTransactions');
    expect(validateThresholds({ warning: '0.5', critical: '0.75', minTransactions: '1e3' }).error).toBe('minTransactions');
  });
});
