import { describe, expect, it } from 'vitest';
import {
  CONFIRMATION_DEFAULTS, buildConfirmationSms, classifySendOutcome, evaluateEligibility, parseConfirmationReply, safeBusinessName,
  type EligibilityInput,
} from '../../../supabase/functions/_shared/results-plan/confirmation';

const NOW = '2026-05-10T12:00:00.000Z';
const ok = (o: Partial<EligibilityInput> = {}): EligibilityInput => ({
  featureEnabled: true, customerPhone: '+15551234567', jobStatus: 'completed', isRework: false, jobSource: 'sarah',
  chargeStatus: 'pending', chargeCreatedAt: '2026-05-10T10:00:00.000Z', alreadyAsked: false, ...o,
});

describe('parseConfirmationReply', () => {
  it.each([['YES', 'yes'], [' yes! ', 'yes'], ['Y', 'yes'], ['no', 'no'], ['N.', 'no'], ['Nope', 'no']])('%s -> %s', (b, a) => {
    expect(parseConfirmationReply(b)).toBe(a);
  });
  it('STOP-class words always win and are never read as an answer', () => {
    for (const w of ['STOP', 'stop', 'Unsubscribe', 'cancel', 'END', 'QUIT', ' stopall ']) expect(parseConfirmationReply(w)).toBe('stop');
  });
  it('ambiguous or longer messages are left for the inbox', () => {
    for (const b of ['yes but he was late', 'no thanks call me', 'maybe', '', null, undefined, 'yes no', '😀']) expect(parseConfirmationReply(b as string)).toBeNull();
  });
});

describe('buildConfirmationSms', () => {
  it('asks the question and always carries the opt-out line', () => {
    const s = buildConfirmationSms({ businessName: 'Acme Plumbing', serviceType: 'Drain Cleaning' });
    expect(s).toContain('Did Acme Plumbing arrive');
    expect(s).toContain('drain cleaning');
    expect(s).toMatch(/Reply YES or NO\./);
    expect(s).toMatch(/Reply STOP to opt out\.$/);
  });
  it('falls back safely when the business name is missing', () => {
    expect(buildConfirmationSms({ businessName: null })).toContain('Did your service provider arrive');
  });
  it('strips links and control characters from names (no URL can be injected)', () => {
    const n = safeBusinessName('Evil https://phish.example/x\u0007 Co');
    expect(n).not.toMatch(/https?:|\u0007/);
    expect(safeBusinessName('x'.repeat(200)).length).toBeLessThanOrEqual(40);
  });
});

describe('evaluateEligibility', () => {
  it('sends after the configured delay', () => {
    const r = evaluateEligibility(ok(), NOW);
    expect(r).toEqual({ send: true, notBefore: new Date(Date.parse('2026-05-10T10:00:00.000Z') + CONFIRMATION_DEFAULTS.delayMinutes * 60_000).toISOString() });
  });
  it.each([
    [{ featureEnabled: false }, 'feature_disabled', false],
    [{ customerPhone: null }, 'no_phone', true],
    [{ customerPhone: '12345' }, 'invalid_phone', true],
    [{ jobStatus: 'cancelled' }, 'cancelled', true],
    [{ isRework: true }, 'rework', true],
    [{ jobSource: 'owner' }, 'not_sarah_job', true],
    [{ jobSource: 'test' }, 'not_sarah_job', true],
    [{ chargeStatus: 'voided' }, 'charge_not_active', true],
    [{ chargeStatus: 'credited' }, 'charge_not_active', true],
    [{ chargeCreatedAt: '2026-04-01T00:00:00.000Z' }, 'too_old', true],
    [{ alreadyAsked: true }, 'already_asked', true],
  ] as const)('%j -> %s', (patch, reason, permanent) => {
    expect(evaluateEligibility(ok(patch as Partial<EligibilityInput>), NOW)).toEqual({ send: false, reason, permanent });
  });
  it('unparseable timestamps fail closed', () => {
    expect(evaluateEligibility(ok({ chargeCreatedAt: 'nope' }), NOW)).toMatchObject({ send: false });
  });
});

describe('classifySendOutcome', () => {
  it('sent', () => expect(classifySendOutcome({ ok: true, sid: 'SM1' }, 0, NOW)).toEqual({ status: 'sent', sid: 'SM1' }));
  it('an opted-out number is skipped permanently (opt-out respected)', () => {
    expect(classifySendOutcome({ ok: false, reason: 'OPTED_OUT' }, 0, NOW)).toEqual({ status: 'skipped', reason: 'opted_out' });
  });
  it('quiet hours re-queue without spending an attempt', () => {
    expect(classifySendOutcome({ ok: false, reason: 'QUIET_HOURS', sendAt: '2026-05-11T14:00:00.000Z' }, 1, NOW)).toEqual({ status: 'queued', nextAttemptAt: '2026-05-11T14:00:00.000Z', countAttempt: false });
  });
  it('fraud guard: retryable re-queues at retryAt, non-retryable skips', () => {
    expect(classifySendOutcome({ ok: false, reason: 'FRAUD_BLOCKED', block: { retryable: true, retryAt: '2026-05-10T13:00:00.000Z' } }, 0, NOW)).toMatchObject({ status: 'queued', nextAttemptAt: '2026-05-10T13:00:00.000Z' });
    expect(classifySendOutcome({ ok: false, reason: 'FRAUD_BLOCKED', block: { retryable: false, retryAt: null } }, 0, NOW)).toEqual({ status: 'skipped', reason: 'fraud_blocked' });
  });
  it('transient errors back off and finally fail after maxAttempts', () => {
    expect(classifySendOutcome({ ok: false, reason: 'TWILIO_ERROR', detail: 'x' }, 0, NOW)).toMatchObject({ status: 'queued', countAttempt: true });
    expect(classifySendOutcome({ ok: false, reason: 'TWILIO_ERROR', detail: 'x' }, CONFIRMATION_DEFAULTS.maxAttempts - 1, NOW)).toMatchObject({ status: 'failed' });
  });
  it('missing Twilio config never burns attempts', () => {
    expect(classifySendOutcome({ ok: false, reason: 'NOT_CONFIGURED' }, 2, NOW)).toMatchObject({ status: 'queued', countAttempt: false });
  });
});
