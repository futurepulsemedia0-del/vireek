export type BillingCycle = 'monthly' | 'annual';

export type PlanId = 'free' | 'starter' | 'professional' | 'business' | 'enterprise';

export interface PricingPlan {
  id: PlanId;
  name: string;
  tagline: string;
  /** Full price for the period (monthly = per month, annual = per year). Null for Enterprise (custom). */
  monthly: number | null;
  annual: number | null;
  /** Only used for Enterprise's "from $X" display. */
  startingAt?: number;
  minutes: string;
  overage: string | null;
  seats: string;
  locations: string;
  /** Shown in the compact 2-card homepage section. */
  core: boolean;
  /** Highlighted as "Most popular". */
  recommended?: boolean;
  ctaLabel: string;
  ctaHint: string;
  features: string[];
}

/**
 * Single source of truth for every plan shown on the site (homepage teaser + /pricing page).
 * Keep this in sync with the live Stripe products in STRIPE_CHECKOUT_LINKS below.
 */
export const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'Prove the value before you spend a dollar.',
    monthly: 0,
    annual: 0,
    minutes: '50 min',
    overage: null,
    seats: '1 seat',
    locations: '1 location',
    core: false,
    ctaLabel: 'Start free',
    ctaHint: 'No card required',
    features: [
      '24/7 AI call answering',
      'Voicemail-to-text',
      'Missed-call text-back',
      'Email call summaries',
      'Community support',
    ],
  },
  {
    id: 'starter',
    name: 'Starter',
    tagline: 'Everything a solo operator needs to stop missing work.',
    monthly: 79,
    annual: 790,
    minutes: '400 min',
    overage: '$0.20/min after',
    seats: '2 seats',
    locations: '1 location',
    core: true,
    ctaLabel: 'Start 14-day trial',
    ctaHint: 'No commitment',
    features: [
      'Everything in Free',
      'Smart calendar booking',
      'SMS appointment confirmations',
      '1 CRM integration',
      '7-day call transcript history',
      'Standard support (24h)',
    ],
  },
  {
    id: 'professional',
    name: 'Professional',
    tagline: 'Replaces a full-time receptionist — with emergency coverage built in.',
    monthly: 199,
    annual: 1990,
    minutes: '1,500 min',
    overage: '$0.15/min after',
    seats: '5 seats',
    locations: '1 location',
    core: true,
    recommended: true,
    ctaLabel: 'Start 14-day trial',
    ctaHint: 'No commitment',
    features: [
      'Everything in Starter',
      'Emergency detection & live dispatch',
      'Warm transfer to on-call staff',
      'ServiceTitan, Housecall Pro, Jobber sync',
      'Full call recording, unlimited history',
      'Custom after-hours routing',
      'Automated review requests',
      'Priority support (4h)',
    ],
  },
  {
    id: 'business',
    name: 'Business',
    tagline: 'One dashboard for every location, with the data to prove ROI.',
    monthly: 399,
    annual: 3990,
    minutes: '4,000 min',
    overage: '$0.12/min after',
    seats: '15 seats',
    locations: 'Up to 3 locations',
    core: false,
    ctaLabel: 'Start 14-day trial',
    ctaHint: 'No commitment',
    features: [
      'Everything in Professional',
      'Up to 3 business locations',
      'Custom voice & script per location',
      'Advanced call-outcome analytics',
      'Role-based team access',
      'Dedicated Slack channel support',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'For multi-location operators who need one system, contractually guaranteed.',
    monthly: null,
    annual: null,
    startingAt: 999,
    minutes: 'Unlimited',
    overage: 'SLA-backed, no metering',
    seats: 'Unlimited seats',
    locations: 'Unlimited locations',
    core: false,
    ctaLabel: 'Talk to sales',
    ctaHint: 'Response within 1 business day',
    features: [
      'Everything in Business',
      'Custom-trained voice model',
      'Full API & webhook access',
      'Dedicated account manager',
      'Audit logs & advanced access controls',
      'Written SLA & onboarding support',
    ],
  },
];

/**
 * Live Stripe Payment Links. Free has no checkout (goes to signup) and Enterprise
 * is sales-assisted (goes to contact), so only these three plans need links.
 * Update these two values any time you rotate a Stripe Payment Link.
 */
export const STRIPE_CHECKOUT_LINKS: Partial<Record<PlanId, Record<BillingCycle, string>>> = {
  starter: {
    monthly: 'https://buy.stripe.com/fZu4gyfNI4CFbda3YI5wI01',
    annual: 'https://buy.stripe.com/eVqcN48lg9WZ80Y1QA5wI02',
  },
  professional: {
    monthly: 'https://buy.stripe.com/dRm5kC30W4CFgxu0Mw5wI03',
    annual: 'https://buy.stripe.com/9B614mato8SV3KI1QA5wI04',
  },
  business: {
    monthly: 'https://buy.stripe.com/6oU14mfNI5GJ4OM8eY5wI05',
    annual: 'https://buy.stripe.com/7sY5kCgRM2ux1CAfHq5wI06',
  },
};

/** Where a plan's CTA button should point for a given billing cycle. */
/** Sales inbox for Enterprise inquiries. Update this if the address ever changes. */
export const SALES_EMAIL = 'ali@vireek.com';

function buildEnterpriseMailto(): string {
  const subject = encodeURIComponent('Enterprise plan inquiry');
  const body = encodeURIComponent(
    "Hi Vireek team,\n\nI'm interested in the Enterprise plan. Here are a few details about my business:\n\n- Company name:\n- Number of locations:\n- Approximate monthly call volume:\n\nThanks!"
  );
  return `mailto:${SALES_EMAIL}?subject=${subject}&body=${body}`;
}

export function getPlanHref(planId: PlanId, billing: BillingCycle): string {
  if (planId === 'free') return '/login';
    if (planId === 'enterprise') return '/enterprise';
  return STRIPE_CHECKOUT_LINKS[planId]?.[billing] ?? '/login';
}

/**
 * Every plan except Free links away from the SPA (Stripe checkout or a mailto: link),
 * so it must render as a plain <a>, not React Router's <Link>.
 */
export function isExternalLink(planId: PlanId): boolean {
  return planId !== 'free' && planId !== 'enterprise';
}

export interface CompareRow {
  label: string;
  key: 'minutes' | 'overage' | 'seats' | 'locations' | 'dispatch' | 'crm' | 'recording' | 'analytics' | 'api';
}

export const COMPARE_ROWS: CompareRow[] = [
  { label: 'Minutes included', key: 'minutes' },
  { label: 'Overage', key: 'overage' },
  { label: 'Team seats', key: 'seats' },
  { label: 'Locations', key: 'locations' },
  { label: 'Emergency dispatch', key: 'dispatch' },
  { label: 'CRM integrations', key: 'crm' },
  { label: 'Call recording', key: 'recording' },
  { label: 'Advanced analytics', key: 'analytics' },
  { label: 'API access', key: 'api' },
];

export const COMPARE_VALUES: Record<string, Partial<Record<PlanId, string | boolean>>> = {
  dispatch: { free: false, starter: false, professional: true, business: true, enterprise: true },
  crm: {
    free: false,
    starter: '1 integration',
    professional: '3 native',
    business: '3 native',
    enterprise: 'Unlimited + API',
  },
  recording: { free: false, starter: false, professional: true, business: true, enterprise: true },
  analytics: { free: false, starter: false, professional: 'Standard', business: 'Advanced', enterprise: 'Advanced' },
  api: { free: false, starter: false, professional: false, business: false, enterprise: true },
};

export const PRICING_FAQS: { q: string; a: string }[] = [
  {
    q: 'What happens if I go over my included minutes?',
    a: "You're billed the per-minute overage rate shown on your plan — visible up front, never hidden. There are no surprise fees or automatic upgrades.",
  },
  {
    q: 'Can I change plans later?',
    a: 'Yes. Upgrade or downgrade at any time from your billing settings. Changes take effect on your next billing cycle, and we prorate the difference.',
  },
  {
    q: 'Is there a setup fee?',
    a: "No plan requires a setup fee. An optional white-glove onboarding is available on Professional and above if you'd rather we configure everything for you.",
  },
  {
    q: 'What counts as one minute?',
    a: 'Total talk time per call, rounded to the nearest minute. Hold time and voicemail transcription are not billed.',
  },
  {
    q: 'How is my data secured?',
    a: 'All calls are encrypted in transit and at rest. Enterprise plans include audit logging and role-based access controls — ask our team for our current compliance documentation.',
  },
];
