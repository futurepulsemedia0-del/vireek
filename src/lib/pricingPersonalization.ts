// Personalized-pricing registry + disclosure decision (pure: no React, no I/O, no clock).
//
// This file is the code-side twin of docs/compliance/pricing-personalization.md. Every place in Vireek that
// produces a customer-facing price is listed once, with a CLASSIFICATION of how the price can depend on
// information about the buyer. The disclosure component (components/pricing/PersonalizedPricingNotice.tsx)
// asks `decidePricingNotice()` whether to render; it never decides by itself.
//
// IMPORTANT: the classes below are an engineering reading of the code, not a legal conclusion.
// Whether a class legally counts as "personalized pricing" in a given jurisdiction is [COUNSEL].
// Nothing in this module asserts that showing (or not showing) the notice makes anyone compliant.

/** Feature flag that gates every notice. Default OFF (see supabase/migrations/20290306000100_personalized_pricing_notice_flag.sql). */
export const PERSONALIZED_PRICING_FLAG = 'personalized_pricing_notice';

/**
 * How the final price can depend on information about the buyer:
 *  - none              the same inputs from any buyer give the same price (scope, time, payment method, owner-set tiers)
 *  - location_derived  the price changes with the buyer's SERVICE ADDRESS (zone fee, zone surge)
 *  - account_specific  the price comes from rules tied to THIS buyer's account (customer, contract, membership, tags)
 *  - profile_modeled   an automated model prices from data about THIS buyer or their property/equipment history
 */
export type PersonalizationClass = 'none' | 'location_derived' | 'account_specific' | 'profile_modeled';

export type PricePathId =
  | 'service_area_surge'
  | 'service_area_travel_fee'
  | 'outcome_pricing'
  | 'price_list_override'
  | 'tiered_estimate'
  | 'field_estimate_ai'
  | 'after_hours_fee'
  | 'payment_method_pricing'
  | 'financing_offer'
  | 'price_playbook_voice'
  | 'pricing_flywheel'
  | 'quote_truth_advisory';

export type DecidedBy = 'owner_rule' | 'vireek_model' | 'third_party' | 'advisory_only';

export interface PricePath {
  id: PricePathId;
  classification: PersonalizationClass;
  /** Who sets the figure. A third party (e.g. a lender) owns its own disclosures; Vireek's notice is not shown for it. */
  decidedBy: DecidedBy;
  /** Main code locations, relative to the repo root. Used by the audit doc and by the registry test. */
  files: readonly string[];
  /** Personal data the path reads to produce the price ([] = none). */
  inputs: readonly string[];
}

export const PRICE_PATHS: Readonly<Record<PricePathId, PricePath>> = {
  service_area_surge: {
    id: 'service_area_surge',
    classification: 'location_derived',
    decidedBy: 'owner_rule',
    files: ['src/lib/serviceAreas.ts', 'supabase/functions/_shared/service-areas/resolve.ts', 'supabase/functions/vapi-webhook/index.ts'],
    inputs: ['service address / postal code (resolved to a zone)'],
  },
  service_area_travel_fee: {
    id: 'service_area_travel_fee',
    classification: 'location_derived',
    decidedBy: 'owner_rule',
    files: ['src/lib/serviceAreas.ts', 'supabase/functions/_shared/service-areas/resolve.ts'],
    inputs: ['service address / postal code (resolved to a zone)'],
  },
  outcome_pricing: {
    id: 'outcome_pricing',
    classification: 'profile_modeled',
    decidedBy: 'vireek_model',
    files: ['src/lib/outcomePricing.ts', 'src/lib/outcomePricingApi.ts', 'src/pages/OutcomePricingPage.tsx'],
    inputs: ['customer record', 'equipment type and operating hours', 'repair history of the covered equipment'],
  },
  price_list_override: {
    id: 'price_list_override',
    classification: 'account_specific',
    decidedBy: 'owner_rule',
    files: ['src/lib/priceLists.ts', 'src/pages/PriceListsPage.tsx'],
    inputs: ['customer id', 'customer type', 'customer tags', 'active commercial contracts', 'active membership plans'],
  },
  tiered_estimate: {
    id: 'tiered_estimate',
    classification: 'none',
    decidedBy: 'owner_rule',
    files: ['src/lib/estimates.ts', 'src/components/quotes/TieredEstimateBuilder.tsx', 'src/components/quotes/EstimatePresentation.tsx'],
    inputs: [],
  },
  field_estimate_ai: {
    id: 'field_estimate_ai',
    classification: 'none',
    decidedBy: 'owner_rule',
    files: ['src/lib/fieldEstimate.ts', 'supabase/functions/field-estimate/index.ts'],
    inputs: ['job photos / video / voice note (used to diagnose scope, not to vary the price between buyers)'],
  },
  after_hours_fee: {
    id: 'after_hours_fee',
    classification: 'none',
    decidedBy: 'owner_rule',
    files: ['supabase/functions/vapi-webhook/index.ts'],
    inputs: [],
  },
  payment_method_pricing: {
    id: 'payment_method_pricing',
    classification: 'none',
    decidedBy: 'owner_rule',
    files: ['supabase/functions/_shared/payments/pricing.ts', 'src/lib/paymentPricing.ts'],
    inputs: [],
  },
  financing_offer: {
    id: 'financing_offer',
    classification: 'profile_modeled',
    decidedBy: 'third_party',
    files: ['src/lib/financing.ts', 'src/lib/financingPartners.ts'],
    inputs: ['applicant data sent to the lender (credit decision is made by the lender)'],
  },
  price_playbook_voice: {
    id: 'price_playbook_voice',
    classification: 'none',
    decidedBy: 'owner_rule',
    files: ['src/lib/pricePolicy.ts', 'supabase/functions/_shared/price-playbook/engine.ts'],
    inputs: [],
  },
  pricing_flywheel: {
    id: 'pricing_flywheel',
    classification: 'none',
    decidedBy: 'owner_rule',
    files: ['src/lib/pricingFlywheel.ts'],
    inputs: ['completed-job cost data in aggregate (changes the shared Price Book, never one buyer\'s price)'],
  },
  quote_truth_advisory: {
    id: 'quote_truth_advisory',
    classification: 'none',
    decidedBy: 'advisory_only',
    files: ['src/lib/quoteTruth.ts', 'supabase/functions/_shared/quote-truth/engine.ts'],
    inputs: ['customer history (read for acceptance/trust risk; the engine reports impact_cents 0 for it)'],
  },
};

export const PRICE_PATH_IDS = Object.keys(PRICE_PATHS) as PricePathId[];

export type NoticeVariant = 'location' | 'account' | 'modeled';

const VARIANT_BY_CLASS: Record<PersonalizationClass, NoticeVariant | null> = {
  none: null,
  location_derived: 'location',
  account_specific: 'account',
  profile_modeled: 'modeled',
};

export interface NoticeDecision {
  show: boolean;
  variant: NoticeVariant | null;
  /** Why the answer is what it is. Stable codes, safe to log and assert on in tests. */
  reason: 'flag_off' | 'unknown_path' | 'not_personalized' | 'third_party_decision' | 'not_applied' | 'show';
}

/**
 * Should the "this price is personalized" notice be shown?
 *
 * Fails closed in the narrow sense that matters: with the flag off, with an unknown path, for a path that is not
 * personalized, for a price a third party sets, or when the personalized element is not actually in this price
 * (`applied === false`, e.g. surge configured but not active) the answer is "do not show".
 */
export function decidePricingNotice(input: { path: string; flagEnabled: boolean; applied?: boolean }): NoticeDecision {
  if (!input.flagEnabled) return { show: false, variant: null, reason: 'flag_off' };
  // Own keys only: 'toString', '__proto__' and friends must not resolve to inherited members.
  if (!Object.prototype.hasOwnProperty.call(PRICE_PATHS, input.path)) return { show: false, variant: null, reason: 'unknown_path' };
  const def = PRICE_PATHS[input.path as PricePathId];
  const variant = VARIANT_BY_CLASS[def.classification];
  if (!variant) return { show: false, variant: null, reason: 'not_personalized' };
  if (def.decidedBy === 'third_party') return { show: false, variant: null, reason: 'third_party_decision' };
  if (input.applied === false) return { show: false, variant: null, reason: 'not_applied' };
  return { show: true, variant, reason: 'show' };
}

/** Every path whose notice can ever be shown (flag on). Used by the audit doc generator and tests. */
export function disclosablePaths(): PricePath[] {
  return PRICE_PATH_IDS.map((id) => PRICE_PATHS[id]).filter(
    (p) => VARIANT_BY_CLASS[p.classification] !== null && p.decidedBy !== 'third_party',
  );
}
