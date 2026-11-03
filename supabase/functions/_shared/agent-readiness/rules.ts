// Agent Readiness — rule registry. Pure (no imports): runs in Deno, Vitest and the browser.
//
// One entry per check. User-facing text (title / why / how-to-fix) lives in the i18n namespace
// `agentReadiness` under `rules.<id>.*`; this file only holds machine facts: weights, the official
// source to cite, and whether the underlying platform rule is known to change.
//
// `source` links point at Google / web.dev documentation. They have NOT been re-verified by a human
// against the live docs — `reviewBy` is when each must be re-checked (see the release checklist).

export type SubscoreId = 'profile' | 'website' | 'phone' | 'reviews' | 'booking' | 'nap' | 'ai_visibility';

export const SUBSCORE_ORDER: readonly SubscoreId[] = ['profile', 'website', 'phone', 'reviews', 'booking', 'nap', 'ai_visibility'];

/** Share of the overall 0-100 score. Subscores that cannot be measured are excluded and the rest re-weighted. */
export const SUBSCORE_WEIGHTS: Record<SubscoreId, number> = {
  profile: 25, website: 20, phone: 10, reviews: 15, booking: 15, nap: 5, ai_visibility: 10,
};

export interface RuleDef {
  subscore: SubscoreId;
  /** Relative weight inside its subscore. */
  max: number;
  source: string;
  /** True when the platform behaviour behind the rule is known to shift (shown as a "may change" badge). */
  mayChange: boolean;
  reviewBy: string;
}

const LB = 'https://developers.google.com/search/docs/appearance/structured-data/local-business';
const SD = 'https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data';
const FAQ = 'https://developers.google.com/search/docs/appearance/structured-data/faqpage';
const GBP = 'https://support.google.com/business/answer/3038177';
const REVIEWS = 'https://developers.google.com/my-business/content/review-data';
const CWV = 'https://web.dev/articles/vitals';
const AIF = 'https://developers.google.com/search/docs/appearance/ai-features';
const ACTIONS = 'https://developers.google.com/actions-center';
const REVIEW_BY = '2027-02-01';

const r = (subscore: SubscoreId, max: number, source: string, mayChange = false): RuleDef =>
  ({ subscore, max, source, mayChange, reviewBy: REVIEW_BY });

export const RULES = {
  // Business profile completeness & consistency
  nap_basics: r('profile', 14, GBP),
  hours_defined: r('profile', 12, GBP),
  hours_special: r('profile', 10, GBP),
  services_count: r('profile', 12, GBP),
  services_priced: r('profile', 14, GBP),
  services_described: r('profile', 12, GBP),
  service_areas: r('profile', 8, GBP),
  faq_qa: r('profile', 8, GBP),
  gbp_categories_photos: r('profile', 10, GBP),
  // Website data
  site_https: r('website', 8, SD),
  site_meta: r('website', 8, SD),
  site_jsonld_business: r('website', 22, LB),
  site_jsonld_service: r('website', 14, SD),
  // FAQ rich results are limited by Google, so this rule only claims machine-readability.
  site_jsonld_faq: r('website', 8, FAQ, true),
  site_booking_link: r('website', 14, ACTIONS),
  site_click_to_call: r('website', 14, SD),
  site_speed: r('website', 12, CWV, true),
  // Phone readiness
  phone_ai_number: r('phone', 14, GBP),
  phone_after_hours: r('phone', 12, GBP),
  phone_answer_time: r('phone', 10, GBP),
  // Review health
  reviews_volume: r('reviews', 10, REVIEWS),
  reviews_recency: r('reviews', 10, REVIEWS),
  reviews_response: r('reviews', 10, REVIEWS),
  // Booking feed health
  booking_enabled: r('booking', 10, ACTIONS),
  booking_feed: r('booking', 12, ACTIONS, true),
  booking_partner: r('booking', 8, ACTIONS, true),
  // NAP consistency
  nap_site_match: r('nap', 10, GBP),
  nap_directories: r('nap', 10, GBP),
  // AI visibility (sampled)
  ai_samples: r('ai_visibility', 10, AIF, true),
} as const satisfies Record<string, RuleDef>;

export type RuleId = keyof typeof RULES;
export const RULE_IDS = Object.keys(RULES) as RuleId[];
