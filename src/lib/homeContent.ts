/**
 * Single source of truth for homepage copy that carries a factual claim.
 * Every claim here is either (a) verifiable in this repo — cited in the comment — or
 * (b) flagged OWNER_CONFIRM, meaning the owner must confirm it is true before launch.
 * Strings live here (not inline) so they can be moved to i18n resources in one pass.
 */

export const SITE_URL = 'https://vireek.com';

/** Trial terms. VERIFIED: SignupPage says "no credit card required"; RefundPolicy §5 says no payment is collected during a free trial. */
export const TRIAL = {
  days: 14,
  short: '14-day free trial · No credit card · Cancel anytime',
} as const;

/**
 * OWNER_CONFIRM: "about 15 minutes" is used across the existing site (FAQ, hero, final CTA) but
 * there is no measurement in the repo. Edit here if the real median differs.
 */
export const SETUP_MINUTES = 15;

export const HERO_PROOF = [
  { label: 'Answers', value: '24/7', detail: 'Nights, weekends and holidays' },
  { label: 'Setup', value: `~${SETUP_MINUTES} min`, detail: 'Forward your number, add your services' },
  { label: 'Trial', value: `${TRIAL.days} days`, detail: 'No credit card, no contract' },
] as const;

export const HERO_HEADLINES = {
  control: { line1: 'Every missed call is a lost job.', line2: 'Sarah answers all of them.' },
  variant_b: { line1: 'Never miss another job.', line2: 'Sarah answers instead.' },
} as const;

/**
 * VERIFIED in repo:
 *  - Google Calendar, HubSpot: OAuth connectors (supabase/functions/google-calendar-oauth-*, hubspot-oauth-*; IntegrationsPage.tsx)
 *  - ServiceTitan, Housecall Pro, Jobber: price-book connectors (supabase/functions/price-book-connect-*, jobber-oauth-*) —
 *    they import your price book. They are NOT verified as two-way job/CRM sync, so the page must not say "sync jobs".
 */
export const INTEGRATION_GROUPS = [
  { heading: 'Calendar & CRM', note: 'Connect with one click', names: ['Google Calendar', 'HubSpot'] },
  { heading: 'Price-book import', note: 'Bring your pricing into Vireek', names: ['ServiceTitan', 'Housecall Pro', 'Jobber'] },
] as const;

export const TRADES = ['Plumbing', 'HVAC', 'Electrical', 'Roofing'] as const;

/** Pricing teaser: plan ids shown on the homepage (Free and Enterprise are linked from /pricing). */
export const HOME_PLAN_IDS = ['starter', 'professional', 'business'] as const;

/**
 * Optional real assets. While a value is null the page renders a clearly-labelled "Example" UI
 * illustration instead. Supply real, compressed WebP (and real width/height) to replace them.
 * NOTE: the /public/*.png "product" images in this repo are AI-generated concept renders, not
 * screenshots, so they are deliberately NOT used here.
 */
export interface RealAsset {
  src: string;
  width: number;
  height: number;
  alt: string;
}
export const PRODUCT_SHOTS: Record<'answer' | 'dispatch' | 'recover', RealAsset | null> = {
  answer: null,
  dispatch: null,
  recover: null,
};
/** Real recorded demo call (mp3/m4a). While null, no audio player is rendered. */
export const SARAH_SAMPLE_AUDIO: { src: string; durationLabel: string } | null = null;

/** Real founding-customer offer. While null, the section states plainly that the program has no fixed offer yet. */
export const FOUNDING_OFFER: { title: string; terms: string } | null = null;

export interface FaqItem {
  q: string;
  a: string;
}

/**
 * Answers use only behaviour that is verifiable in the repo (pricing.ts plan features, RefundPolicyContent,
 * existing FAQ copy) and avoid unverified numbers. Rendered in the page AND emitted as FAQPage JSON-LD,
 * so what Google sees always matches what visitors read.
 */
export const HOME_FAQS: FaqItem[] = [
  {
    q: 'What happens with emergency calls?',
    a: 'Sarah listens for urgent language such as a burst pipe or no heat in winter and flags the call as an emergency. On the Professional plan and above she can also warm-transfer the caller to your on-call person, so it does not sit in a voicemail box.',
  },
  {
    q: 'Does Sarah understand accents and other languages?',
    a: 'She is built to follow natural speech and to reply in the caller’s language where she supports it. Accuracy still depends on the accent and the line quality, so test her with your own voice in the live demo above, then review real call transcripts during your trial.',
  },
  {
    q: 'What if the AI gets something wrong?',
    a: 'Every call gets a summary, and paid plans keep the call transcript so you can see exactly what was said and fix anything. If a caller asks for a person, Sarah tells them someone will follow up. Sarah is software, and she says so.',
  },
  {
    q: 'Do I have to change or port my phone number?',
    a: 'No. You keep your number and forward calls to Sarah, so your customers and your marketing do not change. You can stop forwarding at any time.',
  },
  {
    q: 'Is there a contract?',
    a: 'No long-term contracts and no early-termination fees. You can cancel anytime. Details are in the refund and cancellation policy.',
  },
  {
    q: 'What happens to my customers’ data?',
    a: 'Your data is stored in your own account and isolated from other businesses. You can read how we handle it on the security and privacy pages, and Sarah tells callers she is an AI at the start of the call.',
  },
  {
    q: 'How long does setup take?',
    a: `Most businesses are live in about ${SETUP_MINUTES} minutes: forward your line, tell Sarah about your services and hours, and she starts answering. Connecting a calendar or CRM is optional and takes a few more minutes.`,
  },
  {
    q: 'How much does it cost?',
    a: 'Plans start at $79 a month with a 14-day free trial that needs no credit card. There is also a Free plan with 50 minutes. Prices are shown above and on the pricing page.',
  },
];
