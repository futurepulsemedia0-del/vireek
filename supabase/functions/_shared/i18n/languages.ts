// supabase/functions/_shared/i18n/languages.ts
//
// Single source of truth for the languages a CUSTOMER can be served in
// (voice agent, SMS, email, invoices, portal). Pure TypeScript with no Deno or
// browser APIs, so the same file is imported by Edge Functions (relative
// import) and by the React app (relative import from src/), and unit-tested
// by vitest.
//
// The 9 codes intentionally match src/lib/i18n.ts (UI languages) and the
// CHECK constraint on customers.preferred_language / profiles.preferred_language.

export const SUPPORTED_LANGUAGES = ["en", "es", "zh", "hi", "fr", "de", "ar", "fa", "ja"] as const;
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: LanguageCode = "en";

/** Who set the stored preference. NULL source <=> NULL language. */
export const LANGUAGE_SOURCES = ["auto_detected", "staff", "customer"] as const;
export type LanguageSource = (typeof LANGUAGE_SOURCES)[number];

export interface LanguageMeta {
  /** English name — used inside AI prompts, which are written in English. */
  name: string;
  /** Name in the language itself — shown in pickers. */
  nativeName: string;
  dir: "ltr" | "rtl";
  /** BCP-47 tag for Intl / <html lang>. Region chosen for a US home-service business. */
  locale: string;
}

export const LANGUAGE_META: Record<LanguageCode, LanguageMeta> = {
  en: { name: "English", nativeName: "English", dir: "ltr", locale: "en-US" },
  es: { name: "Spanish", nativeName: "Español", dir: "ltr", locale: "es-US" },
  zh: { name: "Chinese (Simplified)", nativeName: "简体中文", dir: "ltr", locale: "zh-CN" },
  hi: { name: "Hindi", nativeName: "हिन्दी", dir: "ltr", locale: "hi-IN" },
  fr: { name: "French", nativeName: "Français", dir: "ltr", locale: "fr-FR" },
  de: { name: "German", nativeName: "Deutsch", dir: "ltr", locale: "de-DE" },
  ar: { name: "Arabic", nativeName: "العربية", dir: "rtl", locale: "ar" },
  fa: { name: "Persian (Farsi)", nativeName: "فارسی", dir: "rtl", locale: "fa-IR" },
  ja: { name: "Japanese", nativeName: "日本語", dir: "ltr", locale: "ja-JP" },
};

const SUPPORTED_SET: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGES);
const SOURCE_SET: ReadonlySet<string> = new Set(LANGUAGE_SOURCES);

export function isSupportedLanguage(value: unknown): value is LanguageCode {
  return typeof value === "string" && SUPPORTED_SET.has(value);
}

export function isLanguageSource(value: unknown): value is LanguageSource {
  return typeof value === "string" && SOURCE_SET.has(value);
}

/**
 * "fa-IR" / "ES" / "zh_CN" / " de " -> supported base code; anything else
 * (including "pt", "", null, numbers) -> null. Never throws.
 */
export function normalizeLanguage(raw: unknown): LanguageCode | null {
  if (typeof raw !== "string") return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return isSupportedLanguage(base) ? base : null;
}

export function languageName(code: LanguageCode): string {
  return LANGUAGE_META[code].name;
}

export function languageDirection(code: LanguageCode): "ltr" | "rtl" {
  return LANGUAGE_META[code].dir;
}

/**
 * Intl locale for a customer-facing document. Forces Gregorian calendar and
 * Latin digits so amounts, dates and phone numbers read identically in every
 * language (an invoice due date must never be ambiguous between calendars).
 */
export function intlLocale(code: LanguageCode): string {
  return `${LANGUAGE_META[code].locale}-u-ca-gregory-nu-latn`;
}

/** Display label for pickers, e.g. "Español (Spanish)". English stays plain. */
export function languageOptionLabel(code: LanguageCode): string {
  const m = LANGUAGE_META[code];
  return m.nativeName === m.name ? m.name : `${m.nativeName} (${m.name})`;
}

/**
 * May an automatic detection write over what is stored?
 * Only when nothing is stored yet — the first detection wins, so a customer
 * who answers one call in English does not flip a Spanish preference, and a
 * staff/customer choice is never overwritten by a guess.
 */
export function canAutoDetectOverwrite(currentLanguage: string | null | undefined): boolean {
  return normalizeLanguage(currentLanguage) === null;
}

export function sourceLabel(source: LanguageSource | null | undefined): string {
  switch (source) {
    case "auto_detected":
      return "Detected automatically";
    case "staff":
      return "Set by your team";
    case "customer":
      return "Chosen by the customer";
    default:
      return "Not set — the assistant will adapt on the first call";
  }
}
