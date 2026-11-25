// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applicationTransitionAllowed, buildProgramActions, summarizeApplications, type ApplicationRow, type SubmissionProfile } from './utilityPrograms';
import type { IncentiveEvaluation } from './engine';

const NOW = '2026-11-24T12:00:00Z';
const ev = (o: Partial<IncentiveEvaluation> = {}): IncentiveEvaluation => ({
  program_id: 'p1', slug: 'p1', name: 'Utility Heat Pump Rebate', level: 'utility', kind: 'rebate', payout_timing: 'post_install', status: 'eligible',
  amount_cents: 100_000, expected_cents: 80_000, upside_cents: 0, confidence: 0.8, realization: { rate: 0.8, decided: 10, scope: 'prior' },
  reasons: [], missing: [], warnings: [], requires_pre_approval: false, requires_participating_contractor: false, end_date: null,
  funding_status: 'open', source_url: null, last_verified_at: null, is_private: false, ...o,
});
const profile = (o: Partial<SubmissionProfile> = {}): SubmissionProfile => ({
  program_id: 'p1', submission_method: 'online_portal', submission_url: 'https://example.invalid/apply', submission_deadline_days: 60, required_documents: ['invoice'], ...o,
});
const run = (evs: IncentiveEvaluation[], o: { profiles?: Record<string, SubmissionProfile>; enrollments?: Record<string, never> | Record<string, 'active'>; completedAt?: string | null } = {}) =>
  buildProgramActions({ evaluations: evs, profiles: o.profiles ?? { p1: profile() }, enrollments: o.enrollments ?? {}, job: { completedAt: o.completedAt ?? null }, now: NOW });

describe('buildProgramActions', () => {
  it('keeps only utility-level, non-ineligible programs', () => {
    const r = run([ev(), ev({ program_id: 'f', level: 'federal' }), ev({ program_id: 'x', status: 'ineligible' })]);
    expect(r.map((a) => a.program_id)).toEqual(['p1']);
  });
  it('asks for completion before submission and computes the deadline from completion', () => {
    expect(run([ev()])[0].next_step).toBe('complete_job');
    const a = run([ev()], { completedAt: '2026-11-14T12:00:00Z' })[0];
    expect(a.next_step).toBe('submit');
    expect(a.submit).toMatchObject({ method: 'online_portal', days_left: 50, due_at: '2027-01-13T12:00:00.000Z', documents: ['invoice'] });
  });
  it('blocks on contractor enrolment until it is active', () => {
    const e = ev({ requires_participating_contractor: true });
    expect(run([e])[0]).toMatchObject({ blockers: ['enrollment_required'], next_step: 'enroll' });
    expect(run([e], { enrollments: { p1: 'active' } })[0].blockers).toEqual([]);
  });
  it('flags pre-approval, closed funding and ended programs', () => {
    expect(run([ev({ requires_pre_approval: true })])[0]).toMatchObject({ blockers: ['pre_approval_required'], next_step: 'get_pre_approval' });
    expect(run([ev({ funding_status: 'waitlist' })], { completedAt: NOW })[0]).toMatchObject({ blockers: ['funding_unavailable'], next_step: 'none' });
    expect(run([ev({ end_date: '2026-01-01' })])[0].blockers).toContain('program_ended');
  });
  it('never invents submission info: missing profile, unknown method or non-https portal URL is a blocker', () => {
    expect(run([ev()], { profiles: {} })[0]).toMatchObject({ blockers: ['submission_info_missing'], submit: null });
    expect(run([ev()], { profiles: { p1: profile({ submission_method: 'unknown' }) } })[0].blockers).toContain('submission_info_missing');
    const a = run([ev()], { profiles: { p1: profile({ submission_url: 'http://insecure.invalid' }) } })[0];
    expect(a.blockers).toContain('submission_info_missing');
    expect(a.submit?.url).toBeNull();
  });
  it('orders by soonest deadline, then value, deterministically', () => {
    const profiles = { a: profile({ program_id: 'a', submission_deadline_days: 10 }), b: profile({ program_id: 'b', submission_deadline_days: 5 }) };
    const r = run([ev({ program_id: 'a', name: 'A' }), ev({ program_id: 'b', name: 'B' })], { profiles, completedAt: NOW });
    expect(r.map((x) => x.program_id)).toEqual(['b', 'a']);
  });
});

describe('summarizeApplications', () => {
  const row = (o: Partial<ApplicationRow>): ApplicationRow => ({ id: 'a', status: 'identified', estimated_cents: 10_000, approved_cents: null, paid_cents: null, submission_due_at: null, submitted_at: null, ...o });
  it('totals by stage and computes approval rate only from decided applications', () => {
    const s = summarizeApplications([
      row({ id: '1', status: 'submitted', estimated_cents: 50_000, submitted_at: '2026-11-20T00:00:00Z' }),
      row({ id: '2', status: 'approved', approved_cents: 30_000 }), row({ id: '3', status: 'paid', paid_cents: 20_000 }), row({ id: '4', status: 'denied' }),
    ], NOW);
    expect(s).toMatchObject({ submitted_cents: 50_000, approved_cents: 30_000, paid_cents: 20_000, decided: 3 });
    expect(s.approval_rate).toBeCloseTo(2 / 3);
    expect(summarizeApplications([row({ status: 'submitted' })], NOW).approval_rate).toBeNull();
  });
  it('lists overdue unsubmitted and stale submitted applications', () => {
    const s = summarizeApplications([
      row({ id: 'o', status: 'proposed', submission_due_at: '2026-11-01T00:00:00Z' }),
      row({ id: 'f', status: 'proposed', submission_due_at: '2027-01-01T00:00:00Z' }),
      row({ id: 's', status: 'submitted', submitted_at: '2026-09-01T00:00:00Z' }),
    ], NOW);
    expect(s.overdue).toEqual(['o']);
    expect(s.stale_submitted).toEqual(['s']);
  });
  it('treats paid as final', () => {
    expect(applicationTransitionAllowed('paid', 'denied')).toBe(false);
    expect(applicationTransitionAllowed('denied', 'submitted')).toBe(true);
    expect(applicationTransitionAllowed('approved', 'approved')).toBe(true);
  });
});
