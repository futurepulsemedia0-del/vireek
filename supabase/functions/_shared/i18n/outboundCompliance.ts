// supabase/functions/_shared/i18n/outboundCompliance.ts
//
// The ONE switch that decides which languages may be used for outbound voice / SMS COMPLIANCE text
// (AI disclosure, recording consent, opt-out, emergency wording).
//
// Rules
//  - Pure and dependency-free on purpose: it is imported by Edge Functions (Deno), by Vitest, and loaded by
//    scripts/i18n-status.mjs through a TypeScript transpile, so it must not import anything.
//  - A language may be listed in OUTBOUND_COMPLIANCE_LANGUAGES ONLY when every key returned by
//    outboundComplianceKeys(lang, ...) is recorded under that language in docs/i18n/reviewed-keys.json
//    by a named native reviewer (and counsel for legal text [COUNSEL]).
//  - That is enforced twice: `node scripts/i18n-status.mjs --check` (CI) and scripts/i18n-status.test.mjs.
//    Adding a language here without the reviewed keys makes both fail. Never add keys to the manifest on a
//    reviewer's behalf.
//  - English is the source language and is always allowed.

/** Languages currently cleared for outbound compliance wording. Edit only together with reviewed-keys.json. */
export const OUTBOUND_COMPLIANCE_LANGUAGES: readonly string[] = ["en"];

export const OUTBOUND_FALLBACK_LANGUAGE = "en";

/** Server-side compliance wording that lives in code, not in src/locales. Manifest ids use the `server.` namespace. */
export const SERVER_AI_DISCLOSURE_KEY = "server.aiDisclosure.builtin";
export const SERVER_RECORDING_CONSENT_KEY = "server.recordingConsent.script";

/** Languages for which _shared/compliance/recordingProfiles.ts ships a recording-consent script (others use English). */
export const RECORDING_SCRIPT_LANGUAGES: readonly string[] = ["en", "de", "fr", "es"];

/** Locale-file categories that count as outbound compliance wording (see scripts/i18n-status.mjs categoryOf). */
export const OUTBOUND_CATEGORIES: readonly string[] = ["ai-disclosure", "recording", "emergency", "opt-out"];

export function isOutboundComplianceLanguage(
  language: string | null | undefined,
  enabled: readonly string[] = OUTBOUND_COMPLIANCE_LANGUAGES,
): boolean {
  if (typeof language !== "string") return false;
  return language === OUTBOUND_FALLBACK_LANGUAGE || enabled.includes(language);
}

/** The language compliance text may actually be served in: the requested one if cleared, otherwise English. */
export function outboundComplianceLanguage(
  language: string | null | undefined,
  enabled: readonly string[] = OUTBOUND_COMPLIANCE_LANGUAGES,
): string {
  return isOutboundComplianceLanguage(language, enabled) ? (language as string) : OUTBOUND_FALLBACK_LANGUAGE;
}

/** Server-side manifest ids a language must have reviewed before it can be enabled. English needs none. */
export function serverComplianceKeys(language: string): string[] {
  if (language === OUTBOUND_FALLBACK_LANGUAGE) return [];
  return [SERVER_AI_DISCLOSURE_KEY, ...(RECORDING_SCRIPT_LANGUAGES.includes(language) ? [SERVER_RECORDING_CONSENT_KEY] : [])];
}

/** Full list of manifest ids required to enable `language`, given the English locale-file ids in OUTBOUND_CATEGORIES. */
export function outboundComplianceKeys(language: string, localeKeyIds: readonly string[]): string[] {
  if (language === OUTBOUND_FALLBACK_LANGUAGE) return [];
  return [...new Set([...localeKeyIds, ...serverComplianceKeys(language)])].sort();
}

/** Ids still missing from the reviewed manifest. Empty array => the language may be enabled. English is always clear. */
export function outboundComplianceBlockers(
  language: string,
  localeKeyIds: readonly string[],
  reviewed: readonly string[] | null | undefined,
): string[] {
  const have = new Set(reviewed ?? []);
  return outboundComplianceKeys(language, localeKeyIds).filter((id) => !have.has(id));
}
