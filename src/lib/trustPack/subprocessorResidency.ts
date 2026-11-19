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
  // Added by the sub-processor reconciliation (docs/compliance/subprocessor-reconciliation.md).
  // [VERIFY] Processing locations are unconfirmed; vendors that handle content are classed conservatively as US processing.
  'Anthropic, PBC': 'us_processing',
  'Cohere': 'us_processing',
  'ElevenLabs': 'us_processing',
  'Twilio Inc.': 'us_processing',
  'Telnyx LLC': 'us_processing',
  'Daily.co': 'us_processing',
  'Sinch': 'us_processing',
  'Apple Inc.': 'us_processing',
  'Google LLC (Firebase Cloud Messaging, Business Profile, Ads, BigQuery, Maps)': 'us_processing',
  'Yelp Inc.': 'us_processing',
  'RentCast': 'us_processing',
  'ATTOM Data Solutions': 'us_processing',
  'Formspark (submit-form.com)': 'us_processing',
  'Formspree, Inc.': 'us_processing',
  'Cloudflare, Inc. (Turnstile, TURN, DNS)': 'us_processing',
  'PagerDuty, Inc.': 'no_customer_content',
  'OpenFreeMap': 'no_customer_content',
  'Xero Limited': 'customer_optional',
  'Sage Intacct': 'customer_optional',
  'Oracle NetSuite': 'customer_optional',
  'Zoho Corporation': 'customer_optional',
  'Gusto, Inc.': 'customer_optional',
  'HubSpot, Inc.': 'customer_optional',
  'Salesforce, Inc.': 'customer_optional',
  'Pipedrive': 'customer_optional',
  'Jobber': 'customer_optional',
  'Housecall Pro': 'customer_optional',
  'ServiceTitan, Inc.': 'customer_optional',
  'RealPage, Inc. (Buildium, Propertyware)': 'customer_optional',
  'Yardi Systems, Inc.': 'customer_optional',
  'Samsara Inc.': 'customer_optional',
  'Splunk': 'customer_optional',
  'Klaviyo, Inc.': 'customer_optional',
  'Slack Technologies, LLC': 'customer_optional',
  'Microsoft Corporation': 'customer_optional',
  'Meta Platforms, Inc.': 'customer_optional',
  'Telegram': 'customer_optional',
  'Plaid Inc.': 'customer_optional',
  'Wisetack, Inc.': 'customer_optional',
  'TaxJar, Inc.': 'customer_optional',
  'Checkr, Inc.': 'customer_optional',
  'Lob.com, Inc.': 'customer_optional',
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
