import { type LucideIcon } from 'lucide-react';
import { INTEGRATIONS } from '@/lib/integrations';

/* ------------------------------------------------------------------ */
/*  marketplace — data for the public App Marketplace / Integration    */
/*  Directory (/marketplace).                                          */
/*                                                                      */
/*  Two kinds of listing:                                              */
/*   - 'first_party': built and maintained by Vireek. Sourced directly  */
/*     from src/lib/integrations.ts so this page never drifts out of    */
/*     sync with the real Integrations Hub (/integrations) — add a new  */
/*     integration there and it appears here automatically.             */
/*   - 'partner': built by a third party. Add entries to                */
/*     PARTNER_LISTINGS by hand once a submission (see                  */
/*     MARKETPLACE_SUBMISSION_EMAIL below) has been reviewed and        */
/*     approved. There is no self-serve publishing yet — every partner  */
/*     listing is manually vetted before it ships, same as Slack's and  */
/*     Zapier's app directories did in their early days.                */
/* ------------------------------------------------------------------ */

export type ListingKind = 'first_party' | 'partner';

export interface MarketplaceListing {
  slug: string;
  name: string;
  developer: string;
  kind: ListingKind;
  category: string;
  icon: LucideIcon;
  tagline: string;
  /** Internal route for first-party listings (links into /integrations/:slug) */
  href?: string;
  /** External site for partner-built listings */
  externalUrl?: string;
}

const FIRST_PARTY_LISTINGS: MarketplaceListing[] = INTEGRATIONS.map((integration) => ({
  slug: integration.slug,
  name: integration.name,
  developer: 'Vireek',
  kind: 'first_party',
  category: integration.category,
  icon: integration.icon,
  tagline: integration.tagline,
  href: `/integrations/${integration.slug}`,
}));

/**
 * Partner-built listings that have been reviewed and approved.
 * Empty by default — this is where an approved submission gets added.
 */
const PARTNER_LISTINGS: MarketplaceListing[] = [];

export const MARKETPLACE_LISTINGS: MarketplaceListing[] = [
  ...FIRST_PARTY_LISTINGS,
  ...PARTNER_LISTINGS,
];

export const MARKETPLACE_CATEGORIES: string[] = [
  'All',
  ...Array.from(new Set(MARKETPLACE_LISTINGS.map((listing) => listing.category))),
];

export const MARKETPLACE_SUBMISSION_EMAIL = 'ali@vireek.com';
