import { describe, expect, it } from 'vitest';
import { evaluateSurveyGate, isCriticalRoute, isLowScore, type SurveyGateInput } from './surveyRules';

const base: SurveyGateInput = {
  analyticsConsent: true, pathname: '/dashboard/jobs', now: 1_000_000, lastErrorAt: 0, errorQuietMs: 300_000,
  modalOpen: false, typing: false, visible: true, online: true,
};

describe('evaluateSurveyGate', () => {
  it('allows a calm moment', () => expect(evaluateSurveyGate(base)).toEqual({ show: true }));
  it('requires analytics consent', () =>
    expect(evaluateSurveyGate({ ...base, analyticsConsent: false })).toEqual({ show: false, reason: 'no_consent' }));
  it.each(['/dashboard/billing', '/dashboard/billing/invoices', '/checkout', '/login', '/dashboard/settings/security', '/tech/jobs/1', '/dashboard/emergency'])(
    'never interrupts critical route %s', (p) => {
      expect(isCriticalRoute(p)).toBe(true);
      expect(evaluateSurveyGate({ ...base, pathname: p })).toEqual({ show: false, reason: 'critical_route' });
    });
  it('does not treat look-alike routes as critical', () => {
    expect(isCriticalRoute('/dashboard/billing-report')).toBe(false);
    expect(isCriticalRoute('/dashboard/jobs')).toBe(false);
  });
  it('stays quiet for 5 minutes after an error, then allows', () => {
    expect(evaluateSurveyGate({ ...base, lastErrorAt: base.now - 60_000 })).toEqual({ show: false, reason: 'recent_error' });
    expect(evaluateSurveyGate({ ...base, lastErrorAt: base.now - 301_000 })).toEqual({ show: true });
  });
  it('respects open dialogs, typing, hidden tab and offline', () => {
    expect(evaluateSurveyGate({ ...base, modalOpen: true })).toEqual({ show: false, reason: 'modal_open' });
    expect(evaluateSurveyGate({ ...base, typing: true })).toEqual({ show: false, reason: 'typing' });
    expect(evaluateSurveyGate({ ...base, visible: false })).toEqual({ show: false, reason: 'hidden' });
    expect(evaluateSurveyGate({ ...base, online: false })).toEqual({ show: false, reason: 'offline' });
  });
  it('flags low scores per scale', () => {
    expect(isLowScore('csat', 2)).toBe(true);
    expect(isLowScore('csat', 3)).toBe(false);
    expect(isLowScore('ces', 3)).toBe(true);
    expect(isLowScore('ces', 4)).toBe(false);
  });
});
