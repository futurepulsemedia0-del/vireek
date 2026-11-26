import { describe, expect, it } from 'vitest';
import {
  approvalBlockers, dimensionRows, findMetric, formatCount, formatMinutes, isPeriodLabel, labelFor, lastClosedPeriod, periodBounds,
  periodHasEnded, publishBlocker, reportToMarkdown, toMetricRows, toPublicIncident, type MetricRow,
} from '@/lib/transparencyReport';

const rows: MetricRow[] = [
  { section: 'legal_requests', metric: 'received', dimension: '', key: '', count: 3 },
  { section: 'legal_requests', metric: 'received', dimension: 'request_type', key: 'subpoena', count: 2 },
  { section: 'legal_requests', metric: 'received', dimension: 'request_type', key: 'court_order', count: null, suppressed: true },
];

describe('periods', () => {
  it('derives UTC half-year bounds', () => {
    expect(periodBounds('2026-H1')).toEqual({ start: '2026-01-01', end: '2026-06-30' });
    expect(periodBounds('2026-H2')).toEqual({ start: '2026-07-01', end: '2026-12-31' });
    expect(periodBounds('2026-H3')).toBeNull();
    expect(periodBounds('2019-H1')).toBeNull();
    expect(isPeriodLabel('2026-H2')).toBe(true);
    expect(isPeriodLabel('26-H2')).toBe(false);
  });
  it('knows the last closed period and whether a period has ended', () => {
    expect(lastClosedPeriod(new Date('2026-11-25T10:00:00Z'))).toBe('2026-H1');
    expect(lastClosedPeriod(new Date('2027-03-01T10:00:00Z'))).toBe('2026-H2');
    expect(periodHasEnded('2026-H1', new Date('2026-07-01T00:00:00Z'))).toBe(true);
    expect(periodHasEnded('2026-H1', new Date('2026-06-30T12:00:00Z'))).toBe(false);
  });
});

describe('figures', () => {
  it('finds exact rows and never invents a zero for a missing one', () => {
    expect(findMetric(rows, 'legal_requests', 'received')?.count).toBe(3);
    expect(findMetric(rows, 'legal_requests', 'disclosed')).toBeUndefined();
    expect(dimensionRows(rows, 'legal_requests', 'received', 'request_type')).toHaveLength(2);
  });
  it('formats counts, suppression and gaps', () => {
    expect(formatCount(rows[0], null)).toBe('3');
    expect(formatCount(rows[2], 5)).toBe('< 5');
    expect(formatCount(undefined, 5)).toBe('—');
    expect(formatCount({ ...rows[0], count: 12345 }, null, 'en')).toBe('12,345');
    expect(formatMinutes(125)).toBe('2 h 5 min');
    expect(formatMinutes(45)).toBe('45 min');
  });
  it('sanitises database output', () => {
    expect(toMetricRows([{ section: 'a', metric: 'b', dimension: '', key: '', count: 'x' }, { nope: 1 }, null])).toEqual([
      { section: 'a', metric: 'b', dimension: '', key: '', count: null, suppressed: false },
    ]);
    expect(toMetricRows('bad')).toEqual([]);
    expect(labelFor('subpoena')).toBe('Subpoena');
    expect(labelFor('unknown_key')).toBe('unknown_key');
  });
  it('maps a public incident without internal fields', () => {
    const i = toPublicIncident({ public_ref: 'PIL-2026-0001', incident_type: 'other', severity: 'low', occurred_on: '2026-02-01', title: 't', what_happened: 'w', impact: 'i', what_we_did: 'd', incident_id: 'SECRET', published_at: '2026-03-01' });
    expect(JSON.stringify(i)).not.toContain('SECRET');
  });
});

describe('gates', () => {
  it('lists what blocks approval and publishing', () => {
    expect(approvalBlockers({ introText: ' ', reportingRulesText: '', metrics: [] })).toEqual(['intro', 'rules', 'metrics']);
    expect(approvalBlockers({ introText: 'a', reportingRulesText: 'b', metrics: rows })).toEqual([]);
    expect(publishBlocker({ status: 'draft', periodLabel: '2026-H1' })).toBe('notApproved');
    expect(publishBlocker({ status: 'approved', periodLabel: '2026-H1' }, new Date('2026-06-30T00:00:00Z'))).toBe('periodOpen');
    expect(publishBlocker({ status: 'approved', periodLabel: '2026-H1' }, new Date('2026-08-01T00:00:00Z'))).toBeNull();
  });
});

describe('markdown draft', () => {
  it('prints sections with suppression applied and the rules text', () => {
    const md = reportToMarkdown({ periodLabel: '2026-H1', periodStart: '2026-01-01', periodEnd: '2026-06-30', suppressBelow: 5, introText: 'Intro.', reportingRulesText: 'Rule text.', metrics: rows });
    expect(md).toContain('# Vireek transparency report: 2026-H1');
    expect(md).toContain('## Legal requests for customer data');
    expect(md).toContain('| received | request type: Court order | < 5 |');
    expect(md).toContain('Rule text.');
  });
});
