import { useEffect } from 'react';
import { useAccessibility } from '@/contexts/AccessibilityContext';
import { LANGUAGES, type LanguageCode } from '@/lib/i18n';

export interface SEOConfig {
  title: string;
  description: string;
  /** Canonical URL for this page (without trailing slash). */
  canonical: string;
  /** og:type — defaults to "website". */
    type?: string;
  /** One or more schema.org objects to inject as <script type="application/ld+json">. */
  jsonLd?: Record<string, unknown> | Record<string, unknown>[];
}

const SITE_NAME = 'Vireek';
const DEFAULT_OG_IMAGE = 'https://vireek.com/og-image.png';

/**
 * Open Graph locale codes for each of the 9 UI languages Vireek supports.
 * og:locale tells crawlers, social platforms, and link-preview bots which
 * language the current render is in; og:locale:alternate advertises that
 * the same URL is also available in the other supported languages. This
 * matters even though language-switching is client-side (no separate
 * URL per locale) — without it, every share/crawl defaults to en_US.
 */
const OG_LOCALE_MAP: Record<LanguageCode, string> = {
  en: 'en_US',
  es: 'es_ES',
  zh: 'zh_CN',
  hi: 'hi_IN',
  fr: 'fr_FR',
  de: 'de_DE',
  ar: 'ar_AR',
  fa: 'fa_IR',
  ja: 'ja_JP',
};

function upsertMeta(selector: string, attr: 'name' | 'property', key: string, content: string): () => void {
  let el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  const previous = el.getAttribute('content');
  el.setAttribute('content', content);
  return () => {
    if (previous === null) el?.remove();
    else el?.setAttribute('content', previous);
  };
}

function upsertLink(rel: string, href: string): () => void {
  let el = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', rel);
    document.head.appendChild(el);
  }
  const previous = el.getAttribute('href');
  el.setAttribute('href', href);
  return () => {
    if (previous === null) el?.remove();
    else el?.setAttribute('href', previous);
  };
}

/** Page-specific SEO metadata for the SPA. Restores previous values on unmount. */
export function useSEO({ title, description, canonical, type = 'website', jsonLd }: SEOConfig) {
  const { language } = useAccessibility();

  useEffect(() => {
    const previousTitle = document.title;
    const currentLocale = OG_LOCALE_MAP[language] ?? 'en_US';

    document.title = title;

    const cleanups = [
      upsertMeta('meta[name="description"]', 'name', 'description', description),
      upsertMeta('meta[name="robots"]', 'name', 'robots', 'index, follow'),
      upsertLink('canonical', canonical),
      upsertMeta('meta[property="og:title"]', 'property', 'og:title', title),
      upsertMeta('meta[property="og:description"]', 'property', 'og:description', description),
      upsertMeta('meta[property="og:type"]', 'property', 'og:type', type),
      upsertMeta('meta[property="og:url"]', 'property', 'og:url', canonical),
      upsertMeta('meta[property="og:site_name"]', 'property', 'og:site_name', SITE_NAME),
      upsertMeta('meta[property="og:image"]', 'property', 'og:image', DEFAULT_OG_IMAGE),
      upsertMeta('meta[property="og:locale"]', 'property', 'og:locale', currentLocale),
      upsertMeta('meta[name="twitter:card"]', 'name', 'twitter:card', 'summary_large_image'),
      upsertMeta('meta[name="twitter:title"]', 'name', 'twitter:title', title),
      upsertMeta('meta[name="twitter:description"]', 'name', 'twitter:description', description),
      upsertMeta('meta[name="twitter:image"]', 'name', 'twitter:image', DEFAULT_OG_IMAGE),
    ];

    // og:locale:alternate needs one <meta> tag PER other language, so it
    // can't reuse upsertMeta (which assumes one tag per property). Create
    // them directly and remove them on cleanup/re-run.
    const alternateEls = (Object.values(OG_LOCALE_MAP) as string[])
      .filter((loc) => loc !== currentLocale)
      .map((loc) => {
        const el = document.createElement('meta');
        el.setAttribute('property', 'og:locale:alternate');
        el.setAttribute('content', loc);
        document.head.appendChild(el);
        return el;
      });

    // hreflang: since language-switching here is client-side (one URL
    // serves every language, not /fa/... /ar/... paths), we self-reference
    // the same canonical for every hreflang value plus x-default. This is
    // the correct honest signal for this architecture ("this URL serves
    // all these languages") — it is NOT equivalent to true per-locale URLs,
    // which would need locale-prefixed routing to do better.
    const hreflangEls = [...LANGUAGES.map((l) => l.code), 'x-default'].map((code) => {
      const el = document.createElement('link');
      el.setAttribute('rel', 'alternate');
      el.setAttribute('hreflang', code);
      el.setAttribute('href', canonical);
      document.head.appendChild(el);
      return el;
    });

    const jsonLdEls = (jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : []).map((schema) => {
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.text = JSON.stringify(schema);
      document.head.appendChild(script);
      return script;
    });

    return () => {
      document.title = previousTitle;
      cleanups.forEach((fn) => fn());
      alternateEls.forEach((el) => el.remove());
      hreflangEls.forEach((el) => el.remove());
      jsonLdEls.forEach((el) => el.remove());
    };
  }, [title, description, canonical, type, language, jsonLd]);
}
