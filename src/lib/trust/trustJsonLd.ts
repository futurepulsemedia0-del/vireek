/** Pure schema.org builders for trust pages (no React). Only emit facts that exist on the page. */

export const TRUST_ORIGIN = 'https://vireek.com';

export interface Crumb {
  name: string;
  /** Path starting with "/". */
  path: string;
}

export interface FaqItem {
  question: string;
  answer: string;
}

const abs = (path: string): string => `${TRUST_ORIGIN}${path === '/' ? '' : path}`;

/** "Home" is always the first crumb; pass the remaining trail in order. */
export function breadcrumbJsonLd(crumbs: Crumb[]): Record<string, unknown> {
  const trail: Crumb[] = [{ name: 'Home', path: '/' }, ...crumbs];
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: abs(c.path),
    })),
  };
}

/** Only pass questions that are visibly rendered on the same page. */
export function faqJsonLd(items: FaqItem[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((q) => ({
      '@type': 'Question',
      name: q.question,
      acceptedAnswer: { '@type': 'Answer', text: q.answer },
    })),
  };
}

export function webPageJsonLd(opts: {
  name: string;
  description: string;
  path: string;
  /** ISO date (YYYY-MM-DD) of the last real content change. */
  dateModified?: string;
}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: opts.name,
    description: opts.description,
    url: abs(opts.path),
    isPartOf: { '@type': 'WebSite', name: 'Vireek', url: TRUST_ORIGIN },
    ...(opts.dateModified ? { dateModified: opts.dateModified } : {}),
  };
}
