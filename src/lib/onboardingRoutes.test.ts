import { describe, expect, it } from 'vitest';
import { CANONICAL_ONBOARDING_PATH, LEGACY_ONBOARDING_REDIRECTS, MANUAL_ONBOARDING_PATH } from './onboardingRoutes';

describe('legacy onboarding redirects', () => {
  it('maps every retired route to a live one', () => {
    expect(LEGACY_ONBOARDING_REDIRECTS['/onboarding/concierge']).toBe(CANONICAL_ONBOARDING_PATH);
    expect(LEGACY_ONBOARDING_REDIRECTS['/onboarding/classic']).toBe(MANUAL_ONBOARDING_PATH);
  });
  it('never redirects to itself or into another legacy route (no loops)', () => {
    for (const [from, to] of Object.entries(LEGACY_ONBOARDING_REDIRECTS)) {
      expect(to === from).toBe(false);
      expect(to in LEGACY_ONBOARDING_REDIRECTS).toBe(false);
    }
  });
  it('only targets same-origin absolute paths', () => {
    for (const to of Object.values(LEGACY_ONBOARDING_REDIRECTS)) expect(/^\/[a-z-/]*$/.test(to)).toBe(true);
  });
});
