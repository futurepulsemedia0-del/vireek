/**
 * locales.config.ts — single source of truth for the tiered localization program.
 * Pure data + pure helpers (no React, no i18next): safe to import from Node scripts, CI and the UI.
 * Decisions come from docs/i18n/decision-report.md (provisional defaults; edit here to change policy).
 */

export type LocaleCode = 'en' | 'es' | 'fr' | 'de' | 'ar' | 'fa' | 'hi' | 'ja' | 'zh';
export type LanguageTier = 'source' | 'A' | 'B' | 'C';
export type ReviewLevel = 'source' | 'human-reviewed' | 'machine-assisted-reviewed' | 'machine-only';
export type SurfaceId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6';

/** i18next namespaces mapped to the surface they belong to. */
export const NAMESPACE_SURFACE: Readonly<Record<string, SurfaceId>> = {
  common: 'S2',
  forms: 'S2',
  consent: 'S1',
  trust: 'S2',
  dashboard: 'S3',
  productivity: 'S4',
  hiddenTech: 'S4',
  retention: 'S4',
  security: 'S4',
  agentCallers: 'S4',
  consumerAgent: 'S4',
  revenueRealization: 'S4',
  capacityGuard: 'S4',
  voiceLog: 'S4',
  agentReadiness: 'S4',
};

export interface LocaleConfig {
  code: LocaleCode;
  tier: LanguageTier;
  review: ReviewLevel;
  /** Surfaces this language is committed to cover. Anything else falls back to English. */
  surfaces: readonly SurfaceId[];
  /** Minimum share (0-1) of English keys that must exist for each covered surface's namespaces. */
  minCoverage: number;
  /** Show a "Beta" badge in the language picker. */
  beta: boolean;
  /** Frozen: keep existing translations, but do not extend or require new ones. */
  frozen?: boolean;
}

export const LOCALES: Readonly<Record<LocaleCode, LocaleConfig>> = {
  en: { code: 'en', tier: 'source', review: 'source', surfaces: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'], minCoverage: 1, beta: false },
  es: { code: 'es', tier: 'A', review: 'human-reviewed', surfaces: ['S1', 'S2', 'S3'], minCoverage: 1, beta: false },
  fr: { code: 'fr', tier: 'C', review: 'machine-assisted-reviewed', surfaces: ['S1'], minCoverage: 0.9, beta: true },
  de: { code: 'de', tier: 'C', review: 'machine-assisted-reviewed', surfaces: ['S1'], minCoverage: 0.9, beta: true },
  ar: { code: 'ar', tier: 'C', review: 'machine-assisted-reviewed', surfaces: ['S1'], minCoverage: 0.9, beta: true },
  fa: { code: 'fa', tier: 'C', review: 'machine-assisted-reviewed', surfaces: ['S1'], minCoverage: 0.9, beta: true, frozen: true },
  hi: { code: 'hi', tier: 'C', review: 'machine-assisted-reviewed', surfaces: ['S1'], minCoverage: 0.9, beta: true },
  ja: { code: 'ja', tier: 'C', review: 'machine-assisted-reviewed', surfaces: ['S1'], minCoverage: 0.9, beta: true },
  zh: { code: 'zh', tier: 'C', review: 'machine-assisted-reviewed', surfaces: ['S1'], minCoverage: 0.9, beta: true },
};

export const LOCALE_CODES = Object.keys(LOCALES) as LocaleCode[];

/** Text that may NEVER ship machine-only, in any language (counsel + native review required). */
export const HUMAN_REVIEW_REQUIRED_KEYS: readonly RegExp[] = [
  /^consent\./,
  /(^|\.)aiDisclosure(\.|$)/,
  /(^|\.)(recording|recordingConsent|emergency|safety|optOut|smsStop|smsHelp)(\.|$)/i,
  /(^|\.)(terms|privacy|legalNotice|disclaimer)(\.|$)/i,
  /(^|\.)(nte|commitment|guarantee|warranty|priceQuote)(\.|$)/i,
];

export const isHumanReviewRequired = (key: string): boolean => HUMAN_REVIEW_REQUIRED_KEYS.some((re) => re.test(key));

export function surfaceOfNamespace(ns: string): SurfaceId {
  return NAMESPACE_SURFACE[ns] ?? 'S4';
}

/** Namespaces a given locale is required to cover (according to its surfaces). */
export function requiredNamespaces(code: LocaleCode, allNamespaces: readonly string[]): string[] {
  const cfg = LOCALES[code];
  return allNamespaces.filter((ns) => cfg.surfaces.includes(surfaceOfNamespace(ns)));
}

export function isBeta(code: string): boolean {
  return code in LOCALES ? LOCALES[code as LocaleCode].beta : false;
}

/** Fallback chain, e.g. es-MX -> es -> en. Unknown input -> ['en']. */
export function fallbackChain(raw: string): LocaleCode[] {
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  const chain: LocaleCode[] = [];
  if (base in LOCALES) chain.push(base as LocaleCode);
  if (!chain.includes('en')) chain.push('en');
  return chain;
}
