import { useEffect } from 'react';

export interface SEOConfig {
  title: string;
  description: string;
  /** Canonical URL for this page (without trailing slash). */
  canonical: string;
  /** og:type — defaults to "website". */
  type?: string;
}

const SITE_NAME = 'Vireek';
const DEFAULT_OG_IMAGE = 'https://vireek.com/og-image.png';

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
export function useSEO({ title, description, canonical, type = 'website' }: SEOConfig) {
  useEffect(() => {
    const previousTitle = document.title;

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
      upsertMeta('meta[name="twitter:card"]', 'name', 'twitter:card', 'summary_large_image'),
      upsertMeta('meta[name="twitter:title"]', 'name', 'twitter:title', title),
      upsertMeta('meta[name="twitter:description"]', 'name', 'twitter:description', description),
      upsertMeta('meta[name="twitter:image"]', 'name', 'twitter:image', DEFAULT_OG_IMAGE),
    ];

    return () => {
      document.title = previousTitle;
      cleanups.forEach((fn) => fn());
    };
  }, [title, description, canonical, type]);
}
