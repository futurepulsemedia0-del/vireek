import { describe, expect, it } from 'vitest';
import { rankCustomers, scoreCustomer, type HealthSignals } from './customerHealth';

const NOW = new Date('2029-03-10T12:00:00Z');
const base: HealthSignals = {
  account_id: 'a1', email: 'o@example.com', company_name: 'Acme', plan: 'pro', subscription_status: 'active',
  onboarding_completed: true, has_forwarding: true, created_at: '2028-12-01T00:00:00Z',
  calls_7d: 20, calls_30d: 80, calls_prev_7d: 22, integrations_in_error: 0, escalations_open: 0,
  tickets_open: 0, last_sign_in_at: '2029-03-09T00:00:00Z',
};

describe('scoreCustomer', () => {
  it('healthy account scores 100 / low with no reasons', () => {
    expect(scoreCustomer(base, NOW)).toEqual({ score: 100, risk: 'low', reasons: [] });
  });
  it('past_due is always high risk even if everything else is fine', () => {
    const r = scoreCustomer({ ...base, subscription_status: 'past_due' }, NOW);
    expect(r.risk).toBe('high');
    expect(r.reasons[0].code).toBe('payment_failed');
  });
  it('volume drop and integration errors are explained', () => {
    const r = scoreCustomer({ ...base, calls_7d: 4, calls_prev_7d: 20, integrations_in_error: 2 }, NOW);
    expect(r.reasons.map((x) => x.code).sort()).toEqual(['call_volume_drop', 'integration_errors']);
    expect(r.score).toBe(70);
    expect(r.risk).toBe('medium');
  });
  it('does not flag volume drop below the 10-call baseline', () => {
    expect(scoreCustomer({ ...base, calls_7d: 0, calls_prev_7d: 9, calls_30d: 9 }, NOW).reasons.map((x) => x.code)).toEqual(['no_calls_7d']);
  });
  it('new accounts are not penalised for no calls or activation yet', () => {
    const r = scoreCustomer({ ...base, created_at: '2029-03-09T00:00:00Z', onboarding_completed: false, calls_7d: 0, calls_30d: 0, calls_prev_7d: 0, last_sign_in_at: null }, NOW);
    expect(r.reasons).toEqual([]);
  });
  it('stale login tiers and never-logged-in', () => {
    expect(scoreCustomer({ ...base, last_sign_in_at: '2029-02-20T00:00:00Z' }, NOW).reasons[0].code).toBe('login_14d');
    expect(scoreCustomer({ ...base, last_sign_in_at: '2029-01-01T00:00:00Z' }, NOW).reasons[0].code).toBe('login_30d');
    expect(scoreCustomer({ ...base, last_sign_in_at: null }, NOW).reasons[0].code).toBe('never_logged_in');
  });
  it('score is clamped to 0..100', () => {
    const r = scoreCustomer({ ...base, subscription_status: 'past_due', onboarding_completed: false, has_forwarding: false, calls_7d: 0, calls_30d: 0, calls_prev_7d: 0, integrations_in_error: 1, escalations_open: 2, tickets_open: 5, last_sign_in_at: null }, NOW);
    expect(r.score).toBe(0);
  });
  it('ignores malformed dates instead of throwing', () => {
    expect(() => scoreCustomer({ ...base, created_at: 'nope', last_sign_in_at: 'nope' }, NOW)).not.toThrow();
  });
});

describe('rankCustomers', () => {
  it('puts high risk first', () => {
    const out = rankCustomers([base, { ...base, account_id: 'a2', subscription_status: 'past_due' }], NOW);
    expect(out.map((x) => x.signals.account_id)).toEqual(['a2', 'a1']);
  });
});
