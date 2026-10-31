/**
 * Retired. The consent banner and settings now live in src/components/consent/ConsentManager.tsx,
 * mounted once in src/main.tsx. This stub only keeps the many existing <CookieConsent /> mounts
 * (and test mocks of this path) valid without rendering a second banner.
 */
export function CookieConsent(): null {
  return null;
}
