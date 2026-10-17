import { CASE_STUDIES, type CaseStudy } from '@/components/sections/CaseStudies';

/**
 * Data layer for the public /customers hub.
 *
 * Source of truth: CASE_STUDIES (same data as the homepage section and /case-studies). This file adds only what the hub
 * needs: trade taxonomy, per-story provenance, filtering and structured data.
 *
 * HONESTY RULES (Vireek's stated value: no fake testimonials or invented numbers):
 *  - Every story is labelled "illustrative" until you record written permission for it in PROVENANCE
 *    (`provenance: 'verified'` + `consentOn`). Flip a story only when that is true; the UI badge, banner and
 *    structured data all follow this single flag.
 *  - No aggregate claims are ever computed from the stories (no "$X recovered across customers", no customer counts).
 *  - No Review / AggregateRating structured data is emitted. Marking up unverified testimonials as reviews would
 *    violate search-engine guidelines.
 */

export const SITE_ORIGIN = 'https://vireek.com';

export type Provenance = 'verified' | 'illustrative';

export interface StoryProvenance {
  provenance: Provenance;
  /** Required when verified: ISO date written permission to publish name, quote and numbers was obtained. */
  consentOn?: string;
}

/** Keyed by CaseStudy.slug. Anything missing here is treated as illustrative. */
export const PROVENANCE: Record<string, StoryProvenance> = {
  'ramirez-plumbing': { provenance: 'illustrative' },
  'apex-heating-air': { provenance: 'illustrative' },
  'volt-electric': { provenance: 'illustrative' },
};

export interface Trade {
  slug: string;
  label: string;
  /** CaseStudy.industry values that belong to this trade. */
  industries: string[];
}

export const TRADES: Trade[] = [
  { slug: 'hvac', label: 'HVAC', industries: ['HVAC'] },
  { slug: 'plumbing', label: 'Plumbing', industries: ['Plumbing'] },
  { slug: 'electrical', label: 'Electrical', industries: ['Electrical'] },
  { slug: 'roofing', label: 'Roofing', industries: ['Roofing'] },
  { slug: 'restoration', label: 'Restoration', industries: ['Restoration'] },
  { slug: 'locksmith', label: 'Locksmith', industries: ['Locksmith'] },
];

export interface CustomerStory extends CaseStudy, StoryProvenance {
  tradeSlug: string;
  /** Deep link to the full story. */
  href: string;
}

export interface StoryMetric {
  label: string;
  before: string;
  after: string;
}

export const storyHref = (slug: string): string => `/case-studies#${slug}`;

export function tradeForIndustry(industry: string): Trade | undefined {
  return TRADES.find((t) => t.industries.some((i) => i.toLowerCase() === industry.toLowerCase()));
}

function toStory(c: CaseStudy): CustomerStory {
  const p = PROVENANCE[c.slug];
  // A "verified" flag without a consent date is not trusted.
  const verified = p?.provenance === 'verified' && !!p.consentOn;
  return {
    ...c,
    provenance: verified ? 'verified' : 'illustrative',
    consentOn: verified ? p!.consentOn : undefined,
    tradeSlug: tradeForIndustry(c.industry)?.slug ?? 'other',
    href: storyHref(c.slug),
  };
}

export function getStories(source: CaseStudy[] = CASE_STUDIES): CustomerStory[] {
  return source.map(toStory);
}

/** Only accepts a known trade slug; anything else (typos, junk query strings) means "all". */
export function parseTradeParam(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toLowerCase();
  return TRADES.some((t) => t.slug === v) ? v : null;
}

export function filterStories(stories: CustomerStory[], tradeSlug: string | null): CustomerStory[] {
  return tradeSlug ? stories.filter((s) => s.tradeSlug === tradeSlug) : stories;
}

export function tradeCounts(stories: CustomerStory[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of TRADES) counts[t.slug] = 0;
  for (const s of stories) if (s.tradeSlug in counts) counts[s.tradeSlug] += 1;
  return counts;
}

export function storyMetrics(s: CaseStudy): StoryMetric[] {
  return [
    { label: 'Missed calls', before: s.before.callsMissed, after: s.after.callsAnswered + ' answered' },
    { label: 'Response time', before: s.before.responseTime, after: s.after.responseTime },
    { label: 'Revenue', before: `${s.before.revenueLost} lost`, after: `${s.after.revenueRecovered} recovered` },
  ];
}

export const isVerified = (s: Pick<CustomerStory, 'provenance'>): boolean => s.provenance === 'verified';
export const provenanceLabel = (s: Pick<CustomerStory, 'provenance'>): string => (isVerified(s) ? 'Verified customer' : 'Illustrative example');

/** Banner copy; null when every shown story is verified. */
export function disclosure(stories: Pick<CustomerStory, 'provenance'>[]): string | null {
  const n = stories.filter((s) => !isVerified(s)).length;
  if (n === 0) return null;
  return n === stories.length
    ? 'These stories are illustrative examples of what Vireek is designed to do. They are not statements from named customers. We label each story and will replace them with verified ones as customers give written permission.'
    : 'Stories marked “Illustrative example” show what Vireek is designed to do and are not statements from named customers. Stories marked “Verified customer” were published with the customer’s written permission.';
}

export interface HubSeo {
  title: string;
  description: string;
  canonical: string;
}

/** Filtered views canonicalise to /customers so they never compete with the hub. */
export function hubSeo(): HubSeo {
  return {
    title: 'Customer Stories for HVAC, Plumbing & Electrical | Vireek',
    description:
      'See how home-service businesses use Vireek’s AI voice receptionist to answer missed calls, book jobs, and respond faster. Filter by trade and see how each story is labelled.',
    canonical: `${SITE_ORIGIN}/customers`,
  };
}

export function buildHubJsonLd(stories: CustomerStory[]): Record<string, unknown>[] {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Vireek customer stories',
      url: `${SITE_ORIGIN}/customers`,
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: stories.length,
        itemListElement: stories.map((s, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: `${s.business} (${s.industry})`,
          url: `${SITE_ORIGIN}${s.href}`,
        })),
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_ORIGIN },
        { '@type': 'ListItem', position: 2, name: 'Customer stories', item: `${SITE_ORIGIN}/customers` },
      ],
    },
  ];
}
