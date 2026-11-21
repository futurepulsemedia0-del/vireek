import { describe, expect, it } from 'vitest';
import { SAFE_STATE, isStripeCheckoutUrl, parseCheckoutBody, parsePlanState } from './api';
import { isLikelyNewAccount, shouldRedirectToPlanStep, showResumeBanner } from './gate';

describe('parsePlanState', () => {
  it('fails closed on garbage', () => {
    for (const bad of [null, undefined, 'x', 5, [], {}]) expect(parsePlanState(bad)).toEqual(SAFE_STATE);
    expect(SAFE_STATE.shouldPrompt).toBe(false);
    expect(SAFE_STATE.canUseStep).toBe(false);
    expect(SAFE_STATE.trialEligible).toBe(false);
  });
  it('maps the RPC payload and re-validates every field', () => {
    const s = parsePlanState({
      can_use_step: true, should_prompt: true, show_resume: false, reason: 'ok', step: 'checkout', plan: 'professional', billing: 'annual',
      source: 'pricing_page', size_answers: { monthly_calls: 120, technicians: 'x', locations: 2 }, reminder_consent: true, trial_eligible: true,
      policy: { trial_mode: 'no_card', allow_skip: false, reminder_delay_hours: 48 },
    });
    expect(s).toMatchObject({ canUseStep: true, shouldPrompt: true, step: 'checkout', plan: 'professional', billing: 'annual', trialEligible: true });
    expect(s.sizeAnswers).toEqual({ monthlyCalls: 120, locations: 2 });
    expect(s.policy).toEqual({ trialMode: 'no_card', allowSkip: false, reminderDelayHours: 48 });
  });
  it('rejects unknown steps / plans / modes', () => {
    const s = parsePlanState({ can_use_step: true, step: 'hax', plan: 'free', billing: 'weekly', policy: { trial_mode: 'forever' } });
    expect(s.step).toBe('plan');
    expect(s.plan).toBeNull();
    expect(s.billing).toBe('monthly');
    expect(s.policy.trialMode).toBe('card_required');
  });
});

describe('checkout response handling', () => {
  it('only follows https Stripe URLs (no open redirect)', () => {
    expect(isStripeCheckoutUrl('https://checkout.stripe.com/c/pay/cs_test_123')).toBe(true);
    for (const bad of ['http://checkout.stripe.com/x', 'https://evil.com/?checkout.stripe.com', 'javascript:alert(1)', 'https://stripe.com.evil.com/x', null, 7])
      expect(isStripeCheckoutUrl(bad)).toBe(false);
    expect(parseCheckoutBody({ url: 'https://evil.com' })).toEqual({ kind: 'error', code: 'unavailable' });
  });
  it('maps bodies to results', () => {
    expect(parseCheckoutBody({ url: 'https://checkout.stripe.com/c/pay/cs_1' })).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    expect(parseCheckoutBody({ alreadySubscribed: true })).toEqual({ kind: 'already_subscribed' });
    expect(parseCheckoutBody({ processing: true })).toEqual({ kind: 'already_subscribed' });
    expect(parseCheckoutBody({ code: 'promo_invalid' })).toEqual({ kind: 'error', code: 'promo_invalid' });
    expect(parseCheckoutBody(null)).toEqual({ kind: 'error', code: 'unavailable' });
  });
});

describe('dashboard gate helpers', () => {
  const prompt = { ...SAFE_STATE, canUseStep: true, shouldPrompt: true };
  it('redirects only prompt-eligible owners and never loops on the plan page', () => {
    expect(shouldRedirectToPlanStep(prompt, '/dashboard')).toBe(true);
    expect(shouldRedirectToPlanStep(prompt, '/onboarding/plan')).toBe(false);
    expect(shouldRedirectToPlanStep({ ...prompt, shouldPrompt: false }, '/dashboard')).toBe(false);
    expect(shouldRedirectToPlanStep({ ...prompt, canUseStep: false }, '/dashboard')).toBe(false);
    expect(shouldRedirectToPlanStep(SAFE_STATE, '/dashboard')).toBe(false);
  });
  it('shows the resume banner only for open intents', () => {
    expect(showResumeBanner({ ...prompt, showResume: true }, '/dashboard')).toBe(true);
    expect(showResumeBanner({ ...prompt, showResume: true }, '/onboarding/plan')).toBe(false);
    expect(showResumeBanner(SAFE_STATE, '/dashboard')).toBe(false);
  });
  it('pre-filters old or undated accounts without a server call', () => {
    const now = Date.parse('2029-03-10T00:00:00Z');
    expect(isLikelyNewAccount('2029-03-09T00:00:00Z', now)).toBe(true);
    expect(isLikelyNewAccount('2028-01-01T00:00:00Z', now)).toBe(false);
    expect(isLikelyNewAccount(null, now)).toBe(false);
    expect(isLikelyNewAccount('garbage', now)).toBe(false);
  });
});
