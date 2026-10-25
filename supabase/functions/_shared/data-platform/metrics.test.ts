// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  buildOfficialFacts, computeMetrics, dailySnapshots, defaultQuery, bucketOfDate, parseMetricQuery, METRICS, METRIC_IDS,
  type MetricData,
} from './metrics';
import { computeKpis } from '../executive-report/metrics';
import type { ReportData } from '../executive-report/types';

const j = (o: Record<string, unknown>) => ({
  assigned_technician_id: 't1', job_status: 'completed', invoice_amount: 500, invoice_status: 'paid',
  completed_at: '2026-09-10T12:00:00Z', scheduled_datetime: null, created_at: '2026-09-01T00:00:00Z',
  service_type: 'HVAC', customer_type: 'residential', ...o,
}) as MetricData['jobs'][number];

const data: MetricData = {
  jobs: [
    j({ id: 'a', invoice_amount: 600, first_response_at: '2026-09-01T01:00:00Z' }),
    j({ id: 'b', invoice_amount: 400, invoice_status: 'sent', assigned_technician_id: 't2', service_type: 'Plumbing' }),
    j({ id: 'c', invoice_amount: 300, completed_at: '2026-08-15T12:00:00Z' }),
    j({ id: 'd', job_status: 'cancelled', invoice_amount: 999 }),
    j({ id: 'e', completed_at: '2026-10-01T00:00:00Z', invoice_amount: 700 }),
  ],
  costs: [{ job_id: 'a', total_cost_cents: 10000 }, { job_id: 'a', total_cost_cents: 5000 }, { job_id: 'c', total_cost_cents: 10000 }],
  quotes: [
    { status: 'accepted', sent_at: '2026-09-05T00:00:00Z' },
    { status: 'declined', sent_at: '2026-09-06T00:00:00Z' },
    { status: 'sent', sent_at: '2026-09-07T00:00:00Z' },
    { status: 'accepted', sent_at: '2026-08-05T00:00:00Z' },
  ],
  calls: [{ status: 'missed', call_datetime: '2026-09-02T00:00:00Z' }, { status: 'booked', call_datetime: '2026-09-02T00:00:00Z' }],
  recoveries: [
    { source_type: 'missed_call', status: 'recovered', occurred_at: '2026-09-02T00:00:00Z', recovered_amount_cents: 25000 },
    { source_type: 'voicemail', status: 'open', occurred_at: '2026-09-03T00:00:00Z', recovered_amount_cents: null },
    { source_type: 'declined_quote', status: 'recovered', occurred_at: '2026-09-03T00:00:00Z', recovered_amount_cents: 99900 },
  ],
  technicians: [{ id: 't1', name: 'Ana' }, { id: 't2', name: 'b@x.com' }],
};
const q = (o = {}) => defaultQuery({ from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z', tz: 'UTC', ...o });
const val = (id: string, o = {}) => computeMetrics(data, q({ metrics: [id], ...o })).results[0];

describe('semantic metrics', () => {
  it('computes the core definitions', () => {
    expect(val('revenue').total.value).toBe(1000);
    expect(val('collected_revenue').total.value).toBe(600);
    expect(val('collection_rate').total.value).toBe(60);
    expect(val('jobs_completed').total.value).toBe(2);
    expect(val('avg_ticket').total.value).toBe(500);
    expect(val('close_rate').total.value).toBe(50);
    expect(val('quotes_sent').total.value).toBe(3);
    expect(val('gross_profit').total.value).toBe(450);
    expect(val('gross_margin').total.value).toBe(75);
    expect(val('missed_calls').total.value).toBe(1);
    expect(val('recovery_rate').total.value).toBe(50);
    expect(val('recovered_revenue').total.value).toBe(250);
    expect(val('response_time').total.value).toBe(60);
  });
  it('returns null, never a fake zero, when there is no data', () => {
    const r = computeMetrics({ ...data, quotes: [] }, q({ metrics: ['close_rate'] })).results[0];
    expect(r.total.value).toBeNull();
    expect(r.notes.length).toBe(1);
  });
  it('notes partial cost coverage on margin', () => {
    expect(val('gross_margin').notes[0]).toContain('1 of 2');
  });
  it('compares to the prior period', () => {
    const r = val('revenue', { from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z', compare: true });
    expect(r.prior).toBeDefined();
    expect(r.delta?.kind).toBe('pct');
  });
  it('series ratios use numerator/denominator, not averaged ratios', () => {
    const r = val('close_rate', { granularity: 'week' });
    const withData = r.series!.filter((s) => s.cell.value !== null);
    expect(withData.reduce((a, s) => a + (s.cell.denominator ?? 0), 0)).toBe(r.total.denominator);
  });
  it('groups by dimension and rejects unsupported breakdowns', () => {
    const r = val('revenue', { groupBy: 'service_type' });
    expect(r.groups!.map((g) => g.key)).toEqual(['HVAC', 'Plumbing']);
    expect(parseMetricQuery({ metrics: ['close_rate'], groupBy: 'service_type', from: '2026-09-01', to: '2026-09-30' }).ok).toBe(false);
  });
  it('applies filters', () => {
    expect(val('revenue', { filters: { service_type: ['Plumbing'] } }).total.value).toBe(400);
  });
  it('buckets weeks on Monday and months on the 1st', () => {
    expect(bucketOfDate('2026-09-10', 'week')).toBe('2026-09-07');
    expect(bucketOfDate('2026-09-10', 'month')).toBe('2026-09-01');
  });
  it('validates untrusted queries', () => {
    expect(parseMetricQuery({ metrics: [], from: 'x', to: 'y' }).ok).toBe(false);
    expect(parseMetricQuery({ metrics: ['revenue'], from: '2024-01-01', to: '2026-01-01' }).ok).toBe(false);
    expect(parseMetricQuery({ metrics: ['revenue'], from: '2026-01-01', to: '2026-02-01', tz: 'Nope/Zone' })).toMatchObject({ ok: true, query: { tz: 'UTC' } });
  });
  it('produces one daily snapshot per metric per day', () => {
    const s = dailySnapshots(data, { days: 10, tz: 'UTC', now: new Date('2026-09-20T00:00:00Z') });
    expect(s.filter((x) => x.metric_id === 'revenue').length).toBeGreaterThanOrEqual(10);
    expect(s.find((x) => x.metric_id === 'revenue' && x.day === '2026-09-10')?.value).toBe(1000);
  });
  it('official copilot facts carry definitions', () => {
    const f = buildOfficialFacts(data, { now: new Date('2026-09-30T00:00:00Z'), tz: 'UTC' }) as any;
    expect(f.metrics.revenue.definition).toBe(METRICS.revenue.definition);
  });
  it('every metric has a definition and version', () => {
    for (const id of METRIC_IDS) { expect(METRICS[id].definition.length).toBeGreaterThan(20); expect(METRICS[id].version).toBeGreaterThan(0); }
  });
});

describe('parity with the Executive Monthly Report KPIs', () => {
  it('matches revenue, jobs, ticket, close rate, margin, missed calls and recovery', () => {
    const exec: ReportData = {
      jobs: data.jobs as any,
      costs: data.costs.map((c) => ({ job_id: c.job_id, amount: (c.total_cost_cents ?? 0) / 100 })),
      quotes: data.quotes, calls: data.calls, recoveries: data.recoveries,
      technicians: [{ id: 't1', member_name: 'Ana', member_email: 'a@x.com' }],
    };
    const range = { startMs: Date.parse('2026-09-01T00:00:00Z'), endMs: Date.parse('2026-10-01T00:00:00Z') };
    const k = computeKpis(range, exec);
    const m = (id: string) => val(id).total.value;
    expect(m('revenue')).toBe(k.revenue);
    expect(m('collected_revenue')).toBe(k.collected);
    expect(m('jobs_completed')).toBe(k.jobsCompleted);
    expect(m('avg_ticket')).toBe(k.avgTicket);
    expect(m('close_rate')).toBe(k.closeRatePct);
    expect(m('gross_margin')).toBe(k.marginPct);
    expect(m('missed_calls')).toBe(k.missedCalls);
    expect(m('recovery_rate')).toBe(k.recoveryRatePct);
    expect(m('recovered_revenue')).toBe(k.recoveredValue);
  });
});
