import { describe, it, expect } from 'vitest';
import { computeDunningUpdate, computeRecoveryUpdate, GRACE_PERIOD_DAYS } from './dunningLogic';

describe('computeDunningUpdate', () => {
  it('starts a fresh grace period on the first failure in a streak', () => {
    const now = new Date('2026-09-24T12:00:00.000Z');
    const result = computeDunningUpdate({ dunning_stage: 0, payment_failed_at: null }, 'card_declined', now);

    expect(result.dunning_stage).toBe(1);
    expect(result.payment_failed_at).toBe(now.toISOString());
    expect(result.payment_grace_period_ends_at).toBe(new Date(now.getTime() + GRACE_PERIOD_DAYS * 86400000).toISOString());
    expect(result.daysLeft).toBe(GRACE_PERIOD_DAYS);
    expect(result.last_payment_error).toBe('card_declined');
  });

  it('does NOT reset the grace-period clock on a repeat failure in the same streak', () => {
    const originalFailure = new Date('2026-09-20T12:00:00.000Z');
    const now = new Date('2026-09-24T12:00:00.000Z'); // ۴ روز داخل streak
    const result = computeDunningUpdate(
      { dunning_stage: 2, payment_failed_at: originalFailure.toISOString() },
      'insufficient_funds',
      now,
    );

    // failedAt باید همون شکست اولیه بمونه، نه now
    expect(result.payment_failed_at).toBe(originalFailure.toISOString());
    expect(result.dunning_stage).toBe(3);
    // 7 - 4 = 3 روز باقی‌مانده
    expect(result.daysLeft).toBe(3);
  });

  it('never reports fewer than 1 day left, even past the grace-period boundary', () => {
    const originalFailure = new Date('2026-09-01T00:00:00.000Z');
    const now = new Date('2026-09-30T00:00:00.000Z'); // خیلی جلوتر از پنجره‌ی ۷ روزه
    const result = computeDunningUpdate({ dunning_stage: 5, payment_failed_at: originalFailure.toISOString() }, null, now);

    expect(result.daysLeft).toBe(1);
  });

  it('carries a null decline reason through unchanged, when the bank gave no reason', () => {
    const result = computeDunningUpdate({ dunning_stage: 0, payment_failed_at: null }, null, new Date());
    expect(result.last_payment_error).toBeNull();
  });
});

describe('computeRecoveryUpdate', () => {
  it('fully clears dunning state regardless of what stage it was at', () => {
    expect(computeRecoveryUpdate()).toEqual({
      subscription_status: 'active',
      status: 'active',
      dunning_stage: 0,
      payment_failed_at: null,
      payment_grace_period_ends_at: null,
      last_payment_error: null,
    });
  });
});
