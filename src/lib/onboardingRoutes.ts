// Single source of truth for retired onboarding URLs. Old bookmarks, emails and external links
// keep working: every legacy path maps to the canonical flow (/onboarding) or its manual mode.
export const CANONICAL_ONBOARDING_PATH = '/onboarding';
export const MANUAL_ONBOARDING_PATH = '/onboarding/manual';

export const LEGACY_ONBOARDING_REDIRECTS: Readonly<Record<string, string>> = {
  '/onboarding/concierge': CANONICAL_ONBOARDING_PATH,
  '/onboarding/classic': MANUAL_ONBOARDING_PATH,
};
