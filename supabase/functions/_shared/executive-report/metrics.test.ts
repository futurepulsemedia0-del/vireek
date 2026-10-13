import { describe, it, expect } from 'vitest';
import { computeExecutiveMetrics, pctChange, pointChange, buildGoalRows, computeKpis } from './metrics';
import { periodForMonth } from './period';
import type { ReportData, ReportSettings, JobRow } from './types';

const settings: ReportSettings = {
  user_id: 'u1', enabled: true, send_day: 1, send_hour: 8, timezone: 'UTC',
  include_owner: true, include_co_owners: true, extra_recipients: [], ai_commentary_enabled: true,
  revenue_goal: 1000, jobs_goal: 2, close_rate_goal_pct: 60, margin_goal_pct: 50,
};
const period = periodForMonth('2026-09', 'UTC')!;

const job = (o: Partial<JobRow> & { id: string }): JobRow => ({
  assigned_technician_id: 't1', job_status: 'completed', invoice_amount: 500, invoice_status: 'paid',
  completed_at: '2026-09-10T12:00:00Z', scheduled_datetime: null, created_at: '2026-09-01T00:00:00Z', ...o,
});

const data: ReportData = {
  jobs: [
    job({ id: 'a', invoice_amount: 600 }),
    job({ id: 'b', invoice_amount: 400, invoice_status: 'sent', assigned_technician_id: 't2', is_rework: true }),
    job({ id: 'c', invoice_amount: 300, completed_at: '2026-08-15T12:00:00Z' }), // prior month
    job({ id: 'd', job_status: 'cancelled', invoice_amount: 999 }), // ignored
    job({ id: 'e', completed_at: '2026-10-01T00:00:00Z', invoice_amount: 700 }), // after period (end exclusive)
  ],
  costs: [{ job_id: 'a', amount: 100 }, { job_id: 'a', amount: 50 }, { job_id: 'c', amount: 100 }],
  quotes: [
    { status: 'accepted', sent_at: '2026-09-05T00:00:00Z' },
    { status: 'declined', sent_at: '2026-09-06T00:00:00Z' },
    { status: 'sent', sent_at: '2026-09-07T00:00:00Z' }, // pending → excluded from decided
    { status: 'accepted', sent_at: '2026-08-05T00:00:00Z' },
  ],
  calls: [
    { status: 'missed', call_datetime: '2026-09-02T00:00:00Z' },
    { status: 'booked', call_datetime: '2026-09-02T00:00:00Z' },
  ],
  recoveries: [
    { source_type: 'missed_call', status: 'recovered', occurred_at: '2026-09-02T00:00:00Z', recovered_amount_cents: 25000 },
    { source_type: 'voicemail', status: 'open', occurred_at: '2026-09-03T00:00:00Z', recovered_amount_cents: null },
    { source_type: 'declined_quote', status: 'recovered', occurred_at: '2026-09-03T00:00:00Z', recovered_amount_cents: 99900 },
  ],
  technicians: [{ id: 't1', member_name: 'Ana', member_email: 'a@x.com' }, { id: 't2', member_name: null, member_email: 'b@x.com' }],
};

describe('computeExecutiveMetrics', () => {
  const m = computeExecutiveMetrics(period, data, settings);

  it('computes revenue, jobs, collected and average ticket for the period only', () => {
    expect(m.current.revenue).toBe(1000);
    expect(m.current.jobsCompleted).toBe(2);
    expect(m.current.collected).toBe(600);
    expect(m.current.avgTicket).toBe(500);
  });
  it('computes close rate over decided quotes only', () => {
    expect(m.current.quotesSent).toBe(3);
    expect(m.current.quotesDecided).toBe(2);
    expect(m.current.closeRatePct).toBe(50);
  });
  it('only counts missed-call/voicemail recoveries', () => {
    expect(m.current.missedCalls).toBe(1);
    expect(m.current.missedCallEvents).toBe(2);
    expect(m.current.recoveredCount).toBe(1);
    expect(m.current.recoveredValue).toBe(250);
    expect(m.current.recoveryRatePct).toBe(50);
  });
  it('computes margin from costed jobs and reports coverage', () => {
    expect(m.current.costedJobs).toBe(1);
    expect(m.current.marginPct).toBe(75); // (600-150)/600
    expect(m.dataQuality.costCoveragePct).toBe(50);
    expect(m.dataQuality.notes[0]).toMatch(/1 of 2/);
  });
  it('compares against the prior month', () => {
    expect(m.prior.revenue).toBe(300);
    expect(m.deltas.revenuePct).toBe(233.3);
  });
  it('ranks technicians by revenue and falls back to email', () => {
    expect(m.topTechnicians.map((t) => t.name)).toEqual(['Ana', 'b@x.com']);
    expect(m.topTechnicians[1].reworkRatePct).toBe(100);
  });
  it('marks goals achieved / near / behind', () => {
    const byKey = Object.fromEntries(m.goals.map((g) => [g.key, g.status]));
    expect(byKey).toEqual({ revenue: 'achieved', jobs: 'achieved', close_rate: 'behind', margin: 'achieved' });
  });
});

describe('helpers', () => {
  it('pctChange / pointChange handle nulls and zero baselines', () => {
    expect(pctChange(10, 0)).toBeNull();
    expect(pctChange(null, 5)).toBeNull();
    expect(pctChange(110, 100)).toBe(10);
    expect(pointChange(55.5, 50)).toBe(5.5);
    expect(pointChange(null, 50)).toBeNull();
  });
  it('flags goals with no data and skips unset goals', () => {
    const k = computeKpis({ startMs: 0, endMs: 1 }, { ...data, jobs: [], quotes: [] });
    const rows = buildGoalRows(k, { revenue_goal: null, jobs_goal: null, close_rate_goal_pct: 60, margin_goal_pct: null });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('no_data');
  });
  it('uses the near band between 90% and 100%', () => {
    const k = { ...computeKpis({ startMs: 0, endMs: 1 }, { ...data, jobs: [] }), revenue: 950 };
    const rows = buildGoalRows(k, { revenue_goal: 1000, jobs_goal: null, close_rate_goal_pct: null, margin_goal_pct: null });
    expect(rows[0].status).toBe('near');
  });
});
