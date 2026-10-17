import { COMPETITORS, getCompetitorBySlug, type Competitor, type CompetitorFAQ, type PositioningPoint } from '@/lib/competitors';

/**
 * Data for the public /alternatives/:competitor SEO pages.
 *
 * Single source of truth rules:
 *  - Competitor facts (name, icon, category, feature rows, positioning) come from `competitors.ts` via `competitorSlug`.
 *    This file only holds what is specific to the "alternatives" search intent.
 *  - Same honesty rule as competitors.ts: NO prices, percentages, review scores or customer counts here. Re-check each
 *    competitor's public site before changing claims; comparative advertising has to stay accurate.
 */

export const SITE_ORIGIN = 'https://vireek.com';

/** field-service: a job-management tool Vireek sits in front of. answering-service: a receptionist product Vireek can replace. */
export type AlternativeKind = 'field-service' | 'answering-service';

export interface Alternative {
  /** URL slug: /alternatives/:slug */
  slug: string;
  /** Extra slugs that redirect to the canonical one. */
  aliases?: string[];
  /** Key into COMPETITORS. */
  competitorSlug: string;
  kind: AlternativeKind;
  seoTitle: string;
  seoDescription: string;
  headline: string;
  intro: string;
  /** Why people start looking beyond the competitor. */
  reasons: PositioningPoint[];
  /** Honest "the competitor is the better pick if…" list. */
  stayIf: string[];
  /** "Vireek is the better fit if…" list. */
  switchIf: string[];
  /** How trying Vireek works for this competitor's users. */
  steps: PositioningPoint[];
  faq: CompetitorFAQ[];
  /** ISO date of the last content review; used for sitemap lastmod. */
  reviewedOn: string;
}

const FIELD_SERVICE_STEPS = (name: string): PositioningPoint[] => [
  { title: 'Start a free trial', body: 'Create your account and tell Sarah about your business: trades, service area, and what counts as an emergency.' },
  { title: `Keep ${name} exactly as it is`, body: `Nothing about your ${name} setup has to change. Vireek is the part that answers the phone, so you don’t migrate jobs, customers, or invoices.` },
  { title: 'Route the calls you miss', body: 'Send after-hours calls, overflow, or every call to Vireek, whichever matches where you lose jobs today.' },
  { title: 'Review what happened', body: 'See answered, triaged, and booked calls in your dashboard, then decide how much of your phone traffic to hand over.' },
];

const ANSWERING_STEPS = (name: string): PositioningPoint[] => [
  { title: 'Start a free trial', body: 'Create your account and tell Sarah about your business: trades, service area, and what counts as an emergency.' },
  { title: `Run it next to ${name}`, body: `You don’t have to cancel anything first. Let Vireek answer your real calls for a week while ${name} stays in place.` },
  { title: 'Compare on your own calls', body: 'Look at how many calls were answered, triaged, and booked, and how each handled your trade’s emergencies.' },
  { title: 'Choose your setup', body: `Replace ${name}, keep it as backup for the calls where you want a person, or keep both. It’s your call, with no contract to untangle.` },
];

export const ALTERNATIVES: Alternative[] = [
  {
    slug: 'servicetitan',
    competitorSlug: 'servicetitan',
    kind: 'field-service',
    seoTitle: 'ServiceTitan Alternative for Answering Calls | Vireek',
    seoDescription:
      'Looking for a ServiceTitan alternative because calls go unanswered? Vireek is an AI voice receptionist for home-service trades that answers and books every call, 24/7.',
    headline: 'A ServiceTitan alternative for the calls you’re missing',
    intro:
      'ServiceTitan is a full operations platform, and Vireek is not a replacement for its dispatch, reporting, or accounting. If you’re searching for an alternative because calls still go to voicemail, or because a platform that size is more than you need at the front door, here is where Vireek fits.',
    reasons: [
      { title: 'It manages the job, not the phone call', body: 'Field-service software starts working once a job exists. If nobody picks up, there is no job to manage, and that gap is where many home-service businesses quietly lose revenue.' },
      { title: 'A big platform can be a lot for one problem', body: 'Enterprise suites tend to bring setup, training, and ongoing administration. If your pain is specifically missed calls, a focused tool can be a lighter way to fix it.' },
      { title: 'After-hours and overflow still depend on people', body: 'Even a well-run office can’t answer every call at 2am or during a rush. An AI receptionist covers the hours and moments staff can’t.' },
    ],
    stayIf: [
      'You run multiple crews or locations and depend on its dispatch, reporting, and financial tooling.',
      'Your calls are already answered reliably and the real bottleneck is job management.',
      'You want one system of record for operations and are happy with it.',
    ],
    switchIf: [
      'Calls reach voicemail at night, on weekends, or while crews are on a job.',
      'You want emergencies recognized from what the caller says and booked immediately.',
      'You want to fix the phone without migrating your operations software.',
    ],
    steps: FIELD_SERVICE_STEPS('ServiceTitan'),
    faq: [
      { q: 'What is the best ServiceTitan alternative for answering calls?', a: 'It depends on what you want to replace. ServiceTitan covers dispatch, invoicing, and reporting. If the gap is the phone, Vireek is built to answer, triage, and book calls for home-service trades. It does not replace ServiceTitan’s full feature set.' },
      { q: 'Can Vireek replace ServiceTitan?', a: 'No. Vireek focuses on the phone call. Most businesses that use it keep their existing operations software and add Vireek in front of the phone.' },
      { q: 'Do I need to migrate data from ServiceTitan to try Vireek?', a: 'No. You can start a free trial and have Vireek answer calls without moving jobs, customers, or invoices out of ServiceTitan.' },
      { q: 'Is Vireek a good fit for a small business that finds ServiceTitan too large?', a: 'If your main problem is missed calls, yes. If you also need scheduling, quoting, and invoicing, you’ll still need a tool for those; Vireek is not designed to be your entire back office.' },
    ],
    reviewedOn: '2026-10-08',
  },
  {
    slug: 'jobber',
    competitorSlug: 'jobber',
    kind: 'field-service',
    seoTitle: 'Jobber Alternative: AI Receptionist for Missed Calls | Vireek',
    seoDescription:
      'Searching for a Jobber alternative because calls slip through? Vireek is an AI voice receptionist for the trades that answers, triages, and books every call, around the clock.',
    headline: 'A Jobber alternative for the calls Jobber can’t answer',
    intro:
      'Jobber handles scheduling, quoting, and invoicing for small crews, and it does that job well. It doesn’t pick up your phone. If you’re looking for an alternative because calls go to voicemail while you’re on a job, Vireek is built for that specific gap, and it isn’t a Jobber replacement.',
    reasons: [
      { title: 'Nobody answers while you’re under a sink', body: 'Small crews can’t pick up every call. Scheduling software can’t help with a call that never gets answered.' },
      { title: 'Voicemail loses jobs', body: 'Callers with an urgent problem usually try the next company rather than leave a message. A live answer is often what decides who gets the job.' },
      { title: 'You want less manual entry', body: 'Taking notes from voicemails and retyping them into your scheduler is slow. A receptionist that captures details and books directly removes that step.' },
    ],
    stayIf: [
      'You mainly need straightforward quoting, scheduling, and invoicing for a small crew.',
      'You already answer almost every call, in person or through an existing service.',
      'You want a simple system and your phone isn’t where you lose work.',
    ],
    switchIf: [
      'Calls go unanswered nights, weekends, or during busy job-site hours.',
      'You’d rather have a trade-trained receptionist than a generic answering script.',
      'You want to add phone coverage without changing how you run jobs.',
    ],
    steps: FIELD_SERVICE_STEPS('Jobber'),
    faq: [
      { q: 'Is there a Jobber alternative that answers the phone?', a: 'Jobber is scheduling and invoicing software, so it doesn’t answer calls. Vireek is an AI voice receptionist that does, and it can sit in front of the tools you already use.' },
      { q: 'Should I switch from Jobber to Vireek?', a: 'They solve different problems, so it’s usually not a switch. If your calls are answered reliably today, you may not need Vireek. If some go to voicemail, adding it is the cleaner fix.' },
      { q: 'Will Vireek work alongside my Jobber account?', a: 'Yes, you keep Jobber as is. Vireek answers and books the call and gives you the details, so you aren’t starting from a voicemail.' },
      { q: 'How can I test this without risking my current setup?', a: 'Start a free trial and route a slice of your calls, such as after-hours only. Review the results in your dashboard before expanding.' },
    ],
    reviewedOn: '2026-10-08',
  },
  {
    slug: 'housecall-pro',
    competitorSlug: 'housecall-pro',
    kind: 'field-service',
    seoTitle: 'Housecall Pro Alternative: AI Phone Receptionist | Vireek',
    seoDescription:
      'Need a Housecall Pro alternative for answering your phones? Vireek is an AI voice receptionist for home-service trades that answers, triages, and books calls 24/7.',
    headline: 'A Housecall Pro alternative for answering every call',
    intro:
      'Housecall Pro is a mobile-first app for scheduling, invoicing, and payments, and Vireek isn’t trying to be that. If you want an alternative because the phone is where jobs slip away, this page shows where Vireek fits and where Housecall Pro is still the right tool.',
    reasons: [
      { title: 'The app starts after the call', body: 'Scheduling and payments matter once a job is booked. They don’t help with the call that rang out.' },
      { title: 'Call tracking isn’t call answering', body: 'Knowing that a call was missed is useful, but you still lost the customer. Answering and booking in the moment is a different capability.' },
      { title: 'Emergencies don’t wait for office hours', body: 'A no-heat or burst-pipe call at night needs a response right away. A receptionist that recognizes urgency can act on it.' },
    ],
    stayIf: [
      'You rely on its mobile app for scheduling, invoicing, and getting paid in the field.',
      'Your team already covers the phone reliably.',
      'You’re looking for a field-service system rather than phone coverage.',
    ],
    switchIf: [
      'You’re missing calls when the team is busy, after hours, or on weekends.',
      'You want trade-specific call handling, not a general message-taking script.',
      'You’d like to improve phone coverage without replacing your scheduling app.',
    ],
    steps: FIELD_SERVICE_STEPS('Housecall Pro'),
    faq: [
      { q: 'Is Vireek a Housecall Pro alternative?', a: 'For phone answering, yes. For scheduling, invoicing, and payments, no. Those are Housecall Pro’s strengths, and Vireek is designed to work in front of them.' },
      { q: 'Does Housecall Pro have an AI receptionist?', a: 'Housecall Pro focuses on scheduling, invoicing, and payments and tracks calls. It isn’t built around an AI agent that holds a conversation with the caller the way Vireek is. Check Housecall Pro’s site for its current features.' },
      { q: 'Can I use both?', a: 'Yes. Many businesses answer and book calls with Vireek and keep running the job in the tool they already use.' },
      { q: 'What should I try first?', a: 'If missed calls are the problem, start with Vireek on a limited set of calls. If you need scheduling and invoicing and your phone is covered, Housecall Pro addresses that instead.' },
    ],
    reviewedOn: '2026-10-08',
  },
  {
    slug: 'smith-ai',
    competitorSlug: 'smith-ai',
    kind: 'answering-service',
    seoTitle: 'Smith.ai Alternative for Home Service Businesses | Vireek',
    seoDescription:
      'Comparing Smith.ai alternatives? Vireek is a pure-AI voice receptionist built for HVAC, plumbing, and electrical businesses, trained on trade calls rather than general intake.',
    headline: 'A Smith.ai alternative built for the trades',
    intro:
      'Smith.ai blends AI with live human receptionists for professional services across many industries. If you run a home-service business and want an assistant built around trade calls and emergencies, Vireek is a focused alternative. If you want a person backing up the AI, Smith.ai’s model is built for that.',
    reasons: [
      { title: 'General-purpose, not trade-specific', body: 'A receptionist designed for law firms, agencies, and consultants handles a wide range of calls. Home-service calls involve emergencies, equipment, and dispatch details that reward trade-specific training.' },
      { title: 'Per-call pricing scales with volume', body: 'Per-call billing can climb as call volume grows. Compare it against your own expected volume before committing to any provider.' },
      { title: 'You may not need a human layer', body: 'A hybrid model adds a live-agent layer. If you mostly want fast, consistent answers and bookings, a pure-AI receptionist may be all you need.' },
    ],
    stayIf: [
      'You run a professional-services firm and want live human backup on complex calls.',
      'You value a human voice available when a caller needs one.',
      'Your calls are more about intake and screening than dispatching a technician.',
    ],
    switchIf: [
      'You’re a home-service contractor handling emergencies, estimates, and bookings.',
      'You want an agent trained on HVAC, plumbing, and electrical language.',
      'You’d prefer a simple AI-only setup without a live-agent layer to configure.',
    ],
    steps: ANSWERING_STEPS('Smith.ai'),
    faq: [
      { q: 'What is the best Smith.ai alternative for a plumbing or HVAC business?', a: 'If you want an AI receptionist built around home-service calls, Vireek is designed for that. If you want live human agents available, a hybrid service like Smith.ai fits that need better.' },
      { q: 'Is Vireek AI-only?', a: 'Yes. Vireek is a pure-AI voice receptionist, with no live-agent layer.' },
      { q: 'Can I try Vireek before leaving Smith.ai?', a: 'Yes. Start a free trial and have Vireek answer a share of your real calls while your current service stays in place.' },
      { q: 'How do I compare cost fairly?', a: 'Price both against your own call volume. Pricing changes, so confirm current rates with each provider rather than relying on a third-party page.' },
    ],
    reviewedOn: '2026-10-08',
  },
  {
    slug: 'ruby',
    aliases: ['ruby-receptionists'],
    competitorSlug: 'ruby-receptionists',
    kind: 'answering-service',
    seoTitle: 'Ruby Receptionists Alternative: AI Voice Receptionist | Vireek',
    seoDescription:
      'Looking for a Ruby Receptionists alternative? Vireek is an AI voice receptionist for home-service trades that answers instantly, books jobs, and doesn’t bill by the minute.',
    headline: 'A Ruby Receptionists alternative for the trades',
    intro:
      'Ruby Receptionists is a live-human answering service used by small businesses across many industries. If you want an alternative that answers instantly, knows trade-specific emergencies, and doesn’t depend on agent availability, Vireek is built for that. If a real person on every call matters most, Ruby is built for that.',
    reasons: [
      { title: 'Minute-based billing rises with volume', body: 'Minute bundles tend to cost more as calls get longer or more frequent. Check how that would look against your own call volume.' },
      { title: 'Agents are general-purpose', body: 'Receptionists who serve many industries aren’t trained on a no-heat call or a tripped breaker. Trade-specific handling can matter on urgent calls.' },
      { title: 'Availability can mean waiting', body: 'A human service depends on an agent being free. An AI receptionist can pick up every call the moment it comes in.' },
    ],
    stayIf: [
      'You want a live human voice on every call.',
      'Your calls are mostly general messages and screening, not dispatch.',
      'You’re happy with how its per-minute pricing works for your volume.',
    ],
    switchIf: [
      'You want instant answers with no wait for an available agent.',
      'You want booking and emergency triage built around the trades.',
      'You’d rather not have cost climb with every extra minute on the phone.',
    ],
    steps: ANSWERING_STEPS('Ruby'),
    faq: [
      { q: 'What is a good Ruby Receptionists alternative for home services?', a: 'If you want an AI receptionist trained on the trades, Vireek is built for that. If you want a live person on every call, a human service like Ruby is the closer fit.' },
      { q: 'Is Vireek cheaper than Ruby?', a: 'It depends on your call volume and the plan you compare. Confirm current rates with each provider; pricing changes.' },
      { q: 'Will callers know they’re talking to an AI?', a: 'Vireek’s receptionist, Sarah, is an AI voice agent. Try it on your own calls to judge how it sounds for your customers.' },
      { q: 'Can I keep Ruby for some calls?', a: 'Yes. Some businesses keep a live-human service for calls where a person matters most and use Vireek for after-hours and overflow.' },
    ],
    reviewedOn: '2026-10-08',
  },
];

/* ----------------------------- lookup ------------------------------ */

export const alternativePath = (slug: string): string => `/alternatives/${slug}`;
export const alternativeUrl = (slug: string): string => `${SITE_ORIGIN}${alternativePath(slug)}`;

/** Resolves a canonical slug or alias. */
export function getAlternativeBySlug(slug?: string): Alternative | undefined {
  if (!slug) return undefined;
  const s = slug.toLowerCase();
  return ALTERNATIVES.find((a) => a.slug === s || a.aliases?.includes(s));
}

export function getAlternativeByCompetitorSlug(competitorSlug: string): Alternative | undefined {
  return ALTERNATIVES.find((a) => a.competitorSlug === competitorSlug);
}

export interface ResolvedAlternative {
  alternative: Alternative;
  competitor: Competitor;
}

export function resolveAlternative(slug?: string): ResolvedAlternative | undefined {
  const alternative = getAlternativeBySlug(slug);
  const competitor = alternative ? getCompetitorBySlug(alternative.competitorSlug) : undefined;
  return alternative && competitor ? { alternative, competitor } : undefined;
}

/** True when every alternative points at a competitor that exists (guards against drift between the two files). */
export const allCompetitorsResolve = (): boolean => ALTERNATIVES.every((a) => COMPETITORS.some((c) => c.slug === a.competitorSlug));

/* ----------------------------- JSON-LD ----------------------------- */

export function buildAlternativeJsonLd({ alternative, competitor }: ResolvedAlternative): Record<string, unknown>[] {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: alternative.faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_ORIGIN },
        { '@type': 'ListItem', position: 2, name: 'Compare', item: `${SITE_ORIGIN}/compare` },
        { '@type': 'ListItem', position: 3, name: `${competitor.name} alternatives`, item: alternativeUrl(alternative.slug) },
      ],
    },
  ];
}
