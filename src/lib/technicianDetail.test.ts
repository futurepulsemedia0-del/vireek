import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import type { Job, ReviewRequest, TechnicianCredential } from '@/lib/supabase';
import {
  buildCredentialViews,
  computeAvailability,
  computeSkillEvidence,
  credentialAttentionCount,
  credentialHealth,
  filterJobHistory,
  locationFreshness,
  metricDelta,
  periodRanges,
  summarizeEarnings,
  summarizeHours,
  type PayslipView,
} from './technicianDetail';

const NOW = new Date(2026, 5, 15, 12, 0, 0); // Mon 15 Jun 2026, local
const TECH = 't1';

const job = (id: string, over: Partial<Job> = {}): Job =>
  ({ id, assigned_technician_id: TECH, job_status: 'completed', service_type: 'Water heater repair', customer_name: 'Ada', address: '1 Main St',
    scheduled_datetime: new Date(2026, 5, 10, 9).toISOString(), completed_at: new Date(2026, 5, 10, 11).toISOString(), is_rework: false, rework_of_job_id: null,
    invoice_amount: 100, ...over }) as unknown as Job;
const cred = (over: Partial<TechnicianCredential>): TechnicianCredential =>
  ({ id: 'c', user_id: 'u', technician_id: TECH, credential_type: 'EPA 608', credential_name: null, issuing_authority: null, credential_number: null,
    issued_at: null, expires_at: null, status: 'active', created_at: '', updated_at: '', ...over });
const day = (offset: number) => { const d = new Date(2026, 5, 15 + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

describe('periodRanges / metricDelta', () => {
  it('returns an equally long previous window directly before the current one', () => {
    const { current, previous } = periodRanges(30, NOW);
    const span = (r: { start: Date; end: Date }) => Math.round((r.end.getTime() - r.start.getTime()) / 86_400_000);
    expect(span(current)).toBe(span(previous));
    expect(previous.end.getTime()).toBeLessThan(current.start.getTime());
    expect(current.end.getDate()).toBe(15);
  });
  it('delta is null when either side is missing', () => {
    expect(metricDelta(90, 80)).toBe(10);
    expect(metricDelta(null, 80)).toBeNull();
    expect(metricDelta(90, null)).toBeNull();
  });
});

describe('credentialHealth', () => {
  it('classifies expiry windows and statuses', () => {
    expect(credentialHealth(cred({ expires_at: day(-1) }), NOW)).toEqual({ health: 'expired', daysLeft: -1 });
    expect(credentialHealth(cred({ expires_at: day(0) }), NOW)).toEqual({ health: 'expiring_soon', daysLeft: 0 });
    expect(credentialHealth(cred({ expires_at: day(60) }), NOW).health).toBe('expiring_soon');
    expect(credentialHealth(cred({ expires_at: day(61) }), NOW).health).toBe('valid');
    expect(credentialHealth(cred({ expires_at: null }), NOW)).toEqual({ health: 'valid', daysLeft: null });
    expect(credentialHealth(cred({ status: 'revoked', expires_at: day(-5) }), NOW).health).toBe('revoked');
    expect(credentialHealth(cred({ status: 'pending_renewal', expires_at: day(200) }), NOW).health).toBe('pending_renewal');
  });
  it('sorts needs-attention first and counts them', () => {
    const views = buildCredentialViews([cred({ id: 'ok', expires_at: day(300) }), cred({ id: 'old', expires_at: day(-3) }), cred({ id: 'soon', expires_at: day(10) }), cred({ id: 'rev', status: 'revoked' })], NOW);
    expect(views.map((v) => v.credential.id)).toEqual(['old', 'soon', 'ok', 'rev']);
    expect(credentialAttentionCount(views)).toBe(2);
  });
});

describe('computeAvailability', () => {
  const at = (offset: number, status: Job['job_status'] = 'scheduled', tech = TECH) =>
    ({ assigned_technician_id: tech, job_status: status, scheduled_datetime: new Date(2026, 5, 15 + offset, 10).toISOString() });
  const tech = { id: TECH, dispatch_enabled: true, max_jobs_per_day: 4 };

  it('marks open / busy / full by load and ignores cancelled and other technicians', () => {
    const jobs = [at(0), at(0), at(0), at(0), at(1), at(1), at(1), at(2, 'cancelled'), at(2, 'scheduled', 'other'), at(3)];
    const days = computeAvailability(tech, jobs, NOW);
    expect(days).toHaveLength(7);
    expect(days.map((d) => d.state).slice(0, 4)).toEqual(['full', 'busy', 'open', 'open']);
    expect(days[0]).toMatchObject({ date: day(0), booked: 4, capacity: 4 });
  });
  it('is off when dispatch is paused or capacity is zero', () => {
    expect(computeAvailability({ ...tech, dispatch_enabled: false }, [], NOW).every((d) => d.state === 'off')).toBe(true);
    expect(computeAvailability({ ...tech, max_jobs_per_day: 0 }, [], NOW)[0].state).toBe('off');
  });
});

describe('locationFreshness', () => {
  it('is live within 15 minutes and null when never reported', () => {
    expect(locationFreshness(null, NOW)).toBeNull();
    expect(locationFreshness(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toEqual({ live: true, minutesAgo: 5 });
    expect(locationFreshness(new Date(NOW.getTime() - 90 * 60_000).toISOString(), NOW)?.live).toBe(false);
  });
});

describe('summarizeHours', () => {
  const ts = (work_date: string, regular_hours: number, overtime_hours = 0, status: 'pending' | 'approved' | 'rejected' = 'approved') => ({ work_date, regular_hours, overtime_hours, status });
  it('sums the period, excludes rejected, and tracks pending', () => {
    const { current } = periodRanges(30, NOW);
    const s = summarizeHours([ts(day(-1), 8), ts(day(-2), 8, 2, 'pending'), ts(day(-3), 8, 0, 'rejected'), ts(day(-90), 8)], current, NOW);
    expect(s).toMatchObject({ regular: 16, overtime: 2, total: 18, pendingHours: 10, entries: 2 });
  });
  it('always returns 8 weekly buckets ending this week', () => {
    const s = summarizeHours([ts(day(0), 5)], periodRanges(30, NOW).current, NOW);
    expect(s.weeks).toHaveLength(8);
    expect(s.weeks[7].hours).toBe(5);
    expect(s.weeks[0].hours).toBe(0);
  });
});

describe('summarizeEarnings', () => {
  const slip = (id: string, pay_date: string, status: PayslipView['run']['status'], gross: number, net: number): PayslipView => ({
    run: { id, pay_date, pay_period_start: pay_date, pay_period_end: pay_date, status },
    item: { id, pay_run_id: id, employee_id: 'e', gross_pay_cents: gross, net_pay_cents: net } as PayslipView['item'],
  });
  it('counts only approved/paid runs and splits period vs year-to-date', () => {
    const { current } = periodRanges(30, NOW);
    const s = summarizeEarnings(
      [slip('a', day(-5), 'paid', 100000, 80000), slip('b', day(-6), 'draft', 999, 999), slip('c', day(-7), 'void', 999, 999), slip('d', '2026-01-10', 'approved', 50000, 40000), slip('e', '2025-12-30', 'paid', 70000, 60000)],
      [{ commission_cents: 5000, status: 'approved', pay_run_item_id: null }, { commission_cents: 3000, status: 'paid', pay_run_item_id: 'x' }, { commission_cents: 700, status: 'approved', pay_run_item_id: 'y' }],
      current, NOW,
    );
    expect(s).toMatchObject({ periodGrossCents: 100000, periodNetCents: 80000, ytdGrossCents: 150000, ytdNetCents: 120000, commissionUnpaidCents: 5000, commissionPaidCents: 3000 });
    expect(s.lastPay).toEqual({ payDate: day(-5), netCents: 80000 });
  });
  it('handles no data', () => {
    expect(summarizeEarnings([], [], periodRanges(30, NOW).current, NOW)).toMatchObject({ ytdGrossCents: 0, lastPay: null });
  });
});

describe('computeSkillEvidence', () => {
  const review = (job_id: string, rating: number) => ({ id: job_id, job_id, rating }) as unknown as ReviewRequest;
  it('joins declared skills with demonstrated work and flags the gaps', () => {
    const jobs = [job('j1'), job('j2'), job('r1', { is_rework: true, rework_of_job_id: 'j1', service_type: 'Water heater repair', assigned_technician_id: 'other' }), job('j3', { service_type: 'Duct cleaning' })];
    const out = computeSkillEvidence(['water heater', 'Boiler install'], jobs, [review('j1', 5), review('j2', 3)], TECH);
    const wh = out.find((s) => s.declared && s.jobs > 0);
    expect(wh).toMatchObject({ name: 'water heater', jobs: 2, firstTimeFixRate: 50, csatAvg: 4 });
    expect(out.find((s) => s.name === 'Duct cleaning')).toMatchObject({ declared: false, jobs: 1 });
    expect(out.find((s) => s.name === 'Boiler install')).toMatchObject({ declared: true, jobs: 0 });
    expect(out[out.length - 1].name).toBe('Boiler install'); // unproven claims sort last
  });
  it('returns nothing for no skills and no jobs', () => {
    expect(computeSkillEvidence([], [], [], TECH)).toEqual([]);
  });
});

describe('filterJobHistory', () => {
  const jobs = [job('a', { scheduled_datetime: new Date(2026, 5, 1).toISOString() }), job('b', { job_status: 'scheduled', customer_name: 'Bob', scheduled_datetime: new Date(2026, 5, 20).toISOString() }),
    job('c', { job_status: 'no_show' }), job('d', { assigned_technician_id: 'other' })];
  it('only returns this technician’s jobs, newest first, with status filters and search', () => {
    expect(filterJobHistory(jobs, TECH, 'all', '').map((j) => j.id)).toEqual(['b', 'c', 'a']);
    expect(filterJobHistory(jobs, TECH, 'upcoming', '').map((j) => j.id)).toEqual(['b']);
    expect(filterJobHistory(jobs, TECH, 'cancelled', '').map((j) => j.id)).toEqual(['c']);
    expect(filterJobHistory(jobs, TECH, 'all', 'bob').map((j) => j.id)).toEqual(['b']);
    expect(filterJobHistory(jobs, TECH, 'completed', 'zzz')).toEqual([]);
  });
});
