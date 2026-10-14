import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  detectBrowserLanguage,
  isRTL,
  type LanguageCode,
} from '@/lib/i18n';

/* ------------------------------------------------------------------ */
/*  Single source of truth for language resolution, <html> syncing,    */
/*  localized URLs and hreflang. Pure helpers: no React, easy to test. */
/* ------------------------------------------------------------------ */

export const LANG_STORAGE_KEY = 'vireek-a11y-lang';
export const LANG_QUERY_PARAM = 'lang';

const SUPPORTED: ReadonlySet<string> = new Set(LANGUAGES.map((l) => l.code));

/** "fa-IR" / "AR" / "zh_CN" -> supported base code, anything else -> null. */
export function normalizeLanguage(raw: unknown): LanguageCode | null {
  if (typeof raw !== 'string') return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED.has(base) ? (base as LanguageCode) : null;
}

export function readUrlLanguage(search?: string): LanguageCode | null {
  try {
    const query = search ?? (typeof window !== 'undefined' ? window.location.search : '');
    return normalizeLanguage(new URLSearchParams(query).get(LANG_QUERY_PARAM));
  } catch {
    return null;
  }
}

export function readStoredLanguage(): LanguageCode | null {
  try {
    return normalizeLanguage(localStorage.getItem(LANG_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function storeLanguage(code: LanguageCode): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, code);
  } catch {
    /* private mode / quota — non-fatal */
  }
}

/** URL (?lang=) > localStorage > browser language > default. */
export function resolveInitialLanguage(): LanguageCode {
  return readUrlLanguage() ?? readStoredLanguage() ?? detectBrowserLanguage(DEFAULT_LANGUAGE);
}

/** Keeps <html lang>, <html dir> and the a11y-rtl class consistent. */
export function applyDocumentLanguage(
  code: LanguageCode,
  root: HTMLElement = document.documentElement,
): void {
  const rtl = isRTL(code);
  root.setAttribute('lang', code);
  root.setAttribute('dir', rtl ? 'rtl' : 'ltr');
  root.classList.toggle('a11y-rtl', rtl);
}

/** Removes ?lang= from the address bar (after an explicit user choice) so a refresh can't revert it. */
export function clearUrlLanguage(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(LANG_QUERY_PARAM)) return;
    url.searchParams.delete(LANG_QUERY_PARAM);
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  } catch {
    /* noop */
  }
}

/** Default language keeps the clean URL; every other language gets ?lang=xx. */
export function localizedUrl(canonical: string, code: LanguageCode): string {
  if (code === DEFAULT_LANGUAGE) return canonical;
  try {
    const url = new URL(canonical);
    url.searchParams.set(LANG_QUERY_PARAM, code);
    return url.toString();
  } catch {
    return canonical;
  }
}

export interface HreflangLink {
  hreflang: string;
  href: string;
}

export function buildHreflangLinks(canonical: string): HreflangLink[] {
  return [
    ...LANGUAGES.map((l) => ({ hreflang: l.code, href: localizedUrl(canonical, l.code) })),
    { hreflang: 'x-default', href: canonical },
  ];
}
