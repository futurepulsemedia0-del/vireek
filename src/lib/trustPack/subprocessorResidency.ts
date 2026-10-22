// Enterprise Trust Pack — which sub-processors handle data OUTSIDE a tenant's region.
//
// Reuses the existing single source of truth (src/lib/subprocessors.ts) instead of
// keeping a second list. Every processor must be classified below; the unit test fails
// when someone adds a processor to subprocessors.ts without classifying it, so the
// residency panel can never silently omit a new vendor.

import { SUBPROCESSOR_CATEGORIES, type Processor, type ProcessorCategory } from '@/lib/subprocessors';
import type { RegionCode } from './regions';

export type ResidencyClass =
  /** Has a regional deployment Vireek can route this tenant's regional data to. */
  | 'regional'
  /** Processes content in the United States regardless of tenant region (in transit / on request). */
  | 'us_processing'
  /** Never receives customer content (hosting of static assets, scrubbed telemetry, consent-gated analytics). */
  | 'no_customer_content'
  /** Only involved when the customer connects it. */
  | 'customer_optional';

export const PROCESSOR_RESIDENCY: Record<string, ResidencyClass> = {
  'Supabase, Inc.': 'regional',
  'Vercel Inc.': 'no_customer_content',
  'Vapi Inc.': 'us_processing',
  'Google LLC (Gemini API)': 'us_processing',
  'Groq, Inc.': 'us_processing',
  'Cerebras Systems Inc.': 'us_processing',
  'Cloudflare, Inc. (Workers AI)': 'us_processing',
  'OpenRouter, Inc.': 'us_processing',
  'Stripe, Inc.': 'us_processing',
  'Resend': 'us_processing',
  'Sentry (Functional Software, Inc.)': 'no_customer_content',
  'Google LLC (Google Analytics)': 'no_customer_content',
  'Google LLC (Google Calendar)': 'customer_optional',
  'Intuit Inc. (QuickBooks)': 'customer_optional',
  'Zapier, Inc.': 'customer_optional',
};

export function classifyProcessor(p: Pick<Processor, 'name'>): ResidencyClass | null {
  return PROCESSOR_RESIDENCY[p.name] ?? null;
}

export interface ResidencyImpact {
  inRegion: Processor[];
  outsideRegion: Processor[];
  noCustomerContent: Processor[];
  customerOptional: Processor[];
  /** Processors that are not classified yet — must be empty in a healthy build. */
  unclassified: Processor[];
}

export function residencyImpact(
  region: RegionCode,
  categories: ProcessorCategory[] = SUBPROCESSOR_CATEGORIES,
): ResidencyImpact {
  const out: ResidencyImpact = { inRegion: [], outsideRegion: [], noCustomerContent: [], customerOptional: [], unclassified: [] };
  for (const category of categories) {
    for (const p of category.processors) {
      switch (classifyProcessor(p)) {
        case 'regional': out.inRegion.push(p); break;
        // US processing is "inside" only for US tenants.
        case 'us_processing': (region === 'us' ? out.inRegion : out.outsideRegion).push(p); break;
        case 'no_customer_content': out.noCustomerContent.push(p); break;
        case 'customer_optional': out.customerOptional.push(p); break;
        default: out.unclassified.push(p);
      }
    }
  }
  return out;
}
