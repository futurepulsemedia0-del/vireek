import { useMemo } from 'react';
import { useSEO } from '@/lib/seo';
import { TRUST_ORIGIN, breadcrumbJsonLd, faqJsonLd, webPageJsonLd, type Crumb, type FaqItem } from '@/lib/trust/trustJsonLd';

export interface TrustSEOConfig {
  title: string;
  description: string;
  /** Path starting with "/", e.g. "/trust/compliance". */
  path: string;
  /** Trail after "Home", ending with this page. */
  crumbs: Crumb[];
  dateModified?: string;
  faq?: FaqItem[];
}

/** useSEO + canonical, WebPage, BreadcrumbList and (optional) FAQPage JSON-LD for every trust page. */
export function useTrustSEO({ title, description, path, crumbs, dateModified, faq }: TrustSEOConfig) {
  const jsonLd = useMemo(
    () => [
      webPageJsonLd({ name: title, description, path, dateModified }),
      breadcrumbJsonLd(crumbs),
      ...(faq && faq.length > 0 ? [faqJsonLd(faq)] : []),
    ],
    // crumbs/faq are static per page; keying on path keeps the array stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [title, description, path, dateModified]
  );
  useSEO({ title, description, canonical: `${TRUST_ORIGIN}${path}`, jsonLd });
}
