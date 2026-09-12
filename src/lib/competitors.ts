import { Building2, Wrench, ClipboardList, Bot, Headset, type LucideIcon } from 'lucide-react';

export interface CompetitorFAQ {
  q: string;
  a: string;
}

export type FeatureValue = 'yes' | 'no' | 'partial';

export interface FeatureRow {
  feature: string;
  vireek: FeatureValue;
  competitor: FeatureValue;
}

export interface PositioningPoint {
  title: string;
  body: string;
}

export interface Competitor {
  slug: string;
  /** Display name of the competitor, e.g. "ServiceTitan" */
  name: string;
  icon: LucideIcon;
  /** One-line category label shown under the name, e.g. "Enterprise field service platform" */
  category: string;
  seoTitle: string;
  seoDescription: string;
  /** Short, factual paragraph describing what the competitor actually is. */
  summary: string;
  /** Who the competitor is generally built for. */
  builtFor: string;
  /**
   * true  -> the competitor is itself an AI voice/phone-answering product
   *          (currently: Avoca AI). We render a "positioning" comparison
   *          instead of a yes/no feature table for these, since a fair
   *          head-to-head table against a real competing AI product needs
   *          verified, up-to-date specifics rather than assumptions.
   * false -> the competitor is an operations / field-service-management
   *          tool that does not natively include an AI phone receptionist
   *          (ServiceTitan, Housecall Pro, Jobber). A feature table is
   *          reasonable here because the core claim ("no built-in AI voice
   *          receptionist") is a category fact, not a moving target.
   */
  isVoiceAICompetitor: boolean;
  featureRows?: FeatureRow[];
  positioning?: PositioningPoint[];
  /** Optional callout: many buyers use Vireek *alongside* rather than instead of the competitor. */
  worksWellTogether?: string;
  faq: CompetitorFAQ[];
}

/**
 * IMPORTANT — keep this data honest and current before publishing:
 * Competitor pricing, feature sets, and positioning change over time and are
 * not something we control. Re-check each competitor's public site before
 * shipping updates to this file, and avoid adding specific numeric claims
 * (prices, percentages, review scores) here unless you can cite a source —
 * comparative-advertising claims need to stay accurate or they create real
 * legal and reputational risk for Vireek.
 */
export const COMPETITORS: Competitor[] = [
  {
    slug: 'servicetitan',
    name: 'ServiceTitan',
    icon: Building2,
    category: 'Enterprise field service & construction management platform',
    seoTitle: 'Vireek vs ServiceTitan: AI Phone Receptionist vs Enterprise FSM Software | Vireek',
    seoDescription:
      'ServiceTitan is enterprise field service management software for dispatch, invoicing, and reporting. Vireek is an AI voice receptionist that answers every call, 24/7. See how they compare — and how they work together.',
    summary:
      'ServiceTitan is a large, enterprise-grade field service and construction management platform. It brings dispatch, marketing attribution, financial reporting, and multi-location management into one system for bigger operations.',
    builtFor:
      'Larger home-service operations with dedicated office staff, multiple crews, and complex reporting needs.',
    isVoiceAICompetitor: false,
    featureRows: [
      { feature: 'Answers and holds a live phone conversation, 24/7', vireek: 'yes', competitor: 'no' },
      { feature: 'Books appointments directly from the call itself', vireek: 'yes', competitor: 'no' },
      { feature: 'Flags emergencies from what the caller says', vireek: 'yes', competitor: 'no' },
      { feature: 'Job scheduling, dispatch, and invoicing', vireek: 'partial', competitor: 'yes' },
      { feature: 'Built for small-to-mid-size teams, not just enterprise', vireek: 'yes', competitor: 'no' },
      { feature: 'Transparent, published pricing', vireek: 'yes', competitor: 'no' },
    ],
    worksWellTogether:
      'Many ServiceTitan customers still lose after-hours and overflow calls to voicemail. Vireek is built to answer those calls, triage them, and log everything back into your workflow — it doesn\u2019t require you to replace ServiceTitan to do it.',
    faq: [
      {
        q: 'Is Vireek a replacement for ServiceTitan?',
        a: 'Not necessarily. ServiceTitan is an operations platform for dispatch, invoicing, and reporting once a job exists. Vireek is focused on the phone call itself — answering it, triaging it, and booking it. Many businesses use both: Vireek to make sure every call gets answered, and whatever platform they already run (ServiceTitan included) to manage the job afterward.',
      },
      {
        q: 'Does ServiceTitan already answer calls automatically?',
        a: 'ServiceTitan is built around managing a job once a call has already turned into a lead or booking. It does not include a built-in AI voice receptionist that answers and holds a live conversation with a caller the way Vireek does.',
      },
      {
        q: 'Why would a business look at Vireek instead of ServiceTitan?',
        a: 'Usually cost and complexity. ServiceTitan is priced and built for larger operations with dedicated admin staff and an implementation process. Businesses that mainly need every call answered, triaged, and booked — without an enterprise-size platform or contract — often start with something focused, like Vireek.',
      },
    ],
  },
  {
    slug: 'housecall-pro',
    name: 'Housecall Pro',
    icon: Wrench,
    category: 'Mobile-first field service software for small & mid-size teams',
    seoTitle: 'Vireek vs Housecall Pro: AI Voice Receptionist vs Field Service App | Vireek',
    seoDescription:
      'Housecall Pro is mobile-first field service software for scheduling, invoicing, and payments. Vireek is an AI voice receptionist that answers and books every call. Compare what each one actually does.',
    summary:
      'Housecall Pro is mobile-first field service software built around scheduling, invoicing, mobile payments, and basic marketing automation for small and mid-size home-service teams.',
    builtFor:
      'Small-to-mid-size teams that want an easy-to-learn mobile app for scheduling, quoting, and getting paid in the field.',
    isVoiceAICompetitor: false,
    featureRows: [
      { feature: 'Answers and holds a live phone conversation, 24/7', vireek: 'yes', competitor: 'no' },
      { feature: 'Books appointments directly from the call itself', vireek: 'yes', competitor: 'no' },
      { feature: 'Basic call tracking / attribution', vireek: 'partial', competitor: 'yes' },
      { feature: 'Job scheduling, invoicing, and mobile payments', vireek: 'partial', competitor: 'yes' },
      { feature: 'Trade-specific call vocabulary and triage', vireek: 'yes', competitor: 'no' },
      { feature: 'CRM and calendar sync without manual entry', vireek: 'yes', competitor: 'partial' },
    ],
    worksWellTogether:
      'Vireek is built to sit in front of the phone — answering, triaging, and booking the call — while Housecall Pro (or whatever you already run) handles the job once it\u2019s on the calendar.',
    faq: [
      {
        q: 'Does Housecall Pro answer my phone for me?',
        a: 'Housecall Pro focuses on scheduling, invoicing, and payments once a job is in the system — it tracks calls but doesn\u2019t include an AI voice agent that actually answers and converses with a caller the way Vireek does.',
      },
      {
        q: 'Can I use Vireek and Housecall Pro together?',
        a: 'Yes. Vireek answers and books the call, then syncs the lead or job details so they show up wherever you\u2019re already tracking work — including Housecall Pro.',
      },
      {
        q: 'Which one should I start with?',
        a: 'If your main problem is missed or unanswered calls, start with Vireek — that\u2019s the specific gap it closes. If you need scheduling, quoting, and invoicing and already answer your phone reliably, Housecall Pro solves a different problem.',
      },
    ],
  },
  {
    slug: 'jobber',
    name: 'Jobber',
    icon: ClipboardList,
    category: 'Scheduling & invoicing software for small home-service businesses',
    seoTitle: 'Vireek vs Jobber: AI Voice Receptionist vs Job Scheduling Software | Vireek',
    seoDescription:
      'Jobber is scheduling and invoicing software for small home-service businesses. Vireek is an AI voice receptionist that answers, triages, and books every call, 24/7. See the difference.',
    summary:
      'Jobber is scheduling, quoting, and invoicing software built for small home-service businesses — typically running one to fifteen trucks — that want a simple system without much configuration.',
    builtFor:
      'Small owner-operator and small-crew businesses that want straightforward quoting, scheduling, and invoicing.',
    isVoiceAICompetitor: false,
    featureRows: [
      { feature: 'Answers and holds a live phone conversation, 24/7', vireek: 'yes', competitor: 'no' },
      { feature: 'Detects emergencies from caller language', vireek: 'yes', competitor: 'no' },
      { feature: 'Quoting, scheduling, and client management', vireek: 'partial', competitor: 'yes' },
      { feature: 'Built specifically around handling the trades\u2019 phone calls', vireek: 'yes', competitor: 'no' },
      { feature: 'Sends automated SMS confirmations after booking', vireek: 'yes', competitor: 'partial' },
      { feature: 'Simple, published pricing', vireek: 'yes', competitor: 'yes' },
    ],
    worksWellTogether:
      'Jobber is a favorite for small crews that want simple scheduling. Vireek pairs well with it by making sure calls get answered and booked in the first place — especially nights, weekends, and busy job-site hours when nobody\u2019s free to pick up.',
    faq: [
      {
        q: 'Is Jobber an AI phone receptionist?',
        a: 'No. Jobber is scheduling, quoting, and invoicing software. It helps you manage jobs once they\u2019re booked, but it doesn\u2019t answer the phone or hold a conversation with a caller — that\u2019s the part Vireek is built for.',
      },
      {
        q: 'I already use Jobber — do I still need Vireek?',
        a: 'If calls are getting answered and booked reliably today, maybe not. If any calls are going to voicemail — nights, weekends, or when your crew is on a job — Vireek is built to catch exactly those calls and book them straight onto your calendar.',
      },
      {
        q: 'Does Vireek replace Jobber?',
        a: 'No — they solve different problems. Vireek focuses on the phone call; Jobber focuses on managing the job afterward. Most small businesses that use Vireek keep whatever scheduling tool they already run.',
      },
    ],
  },
  {
    slug: 'answering-service',
    name: 'Answering Service',
    icon: Headset,
    category: 'Live human call-answering service, billed per call or per minute',
    seoTitle: 'AI Receptionist vs Answering Service: Which One Should Answer Your Calls? | Vireek',
    seoDescription:
      'Traditional answering services route your calls to a live operator reading from a script, usually billed per minute or per call. Vireek is an AI voice receptionist trained on the trades that answers instantly, books the job, and syncs everything to your dashboard. See how they compare.',
    summary:
      'A traditional answering service routes your business calls to a live, off-site operator (or a call center) who answers using a generic script, takes down a message or basic details, and forwards it to you \u2014 typically billed per minute or per call handled.',
    builtFor:
      'Businesses that want a human voice picking up the phone when staff can\u2019t, without needing the call itself to result in a booked job.',
    isVoiceAICompetitor: false,
    featureRows: [
      { feature: 'Answers every call instantly, 24/7/365', vireek: 'yes', competitor: 'partial' },
      { feature: 'Books appointments directly onto your calendar during the call', vireek: 'yes', competitor: 'no' },
      { feature: 'Trained on HVAC, plumbing, electrical & trade-specific language', vireek: 'yes', competitor: 'no' },
      { feature: 'Flags true emergencies vs. routine calls', vireek: 'yes', competitor: 'partial' },
      { feature: 'Costs scale with call volume (per-minute or per-agent billing)', vireek: 'no', competitor: 'yes' },
      { feature: 'Consistent script and tone on every single call', vireek: 'yes', competitor: 'partial' },
      { feature: 'Syncs call summaries and leads to your CRM automatically', vireek: 'yes', competitor: 'no' },
      { feature: 'Sends automated SMS confirmation after booking', vireek: 'yes', competitor: 'no' },
    ],
    worksWellTogether:
      'Some businesses transitioning off an answering service keep it as an emergency overflow line for the rare edge case, while Vireek handles the bulk of inbound calls, triage, and booking day to day.',
    faq: [
      {
        q: 'What\u2019s the actual difference between an AI receptionist and an answering service?',
        a: 'An answering service routes your call to a live human operator, usually reading from a general script, who takes a message or basic details and passes it along \u2014 the booking still has to happen after the call. Vireek is an AI voice receptionist that has a live conversation with the caller, understands the trade-specific problem they\u2019re describing, and books the appointment directly onto your calendar before the call even ends.',
      },
      {
        q: 'Is a live human always better than an AI voice receptionist?',
        a: 'Not necessarily for this use case. Answering-service operators typically handle calls for many different businesses and follow a generic script, so they can\u2019t triage a trade-specific emergency or book directly into your calendar. Vireek is trained specifically on HVAC, plumbing, electrical, and similar trades, and connects directly to your scheduling system \u2014 so callers get a more specific, more useful conversation, not just a human voice.',
      },
      {
        q: 'How does pricing typically compare?',
        a: 'Traditional answering services commonly bill per minute or per call handled, so costs rise directly with call volume. Vireek is built to answer unlimited calls without that per-call math. Exact pricing for any answering service varies by provider \u2014 check their current rates directly \u2014 but the billing model itself is worth comparing before you commit.',
      },
      {
        q: 'Can Vireek handle a true emergency call the way a person would?',
        a: 'Vireek is built to recognize emergency language \u2014 things like a burst pipe, no heat in winter, or a gas smell \u2014 and route or flag those calls immediately, the same job a live answering-service operator is trained to do. The difference is Vireek can also move straight into booking the emergency appointment on the spot, without a separate callback.',
      },
      {
        q: 'Do I need to switch everything over at once?',
        a: 'No. Many businesses start Vireek on overflow or after-hours calls \u2014 the ones an answering service usually charges the most to cover \u2014 and expand from there once they see how many get booked automatically.',
      },
    ],
  },
  {
    slug: 'avoca-ai',
    name: 'Avoca AI',
    icon: Bot,
    category: 'AI voice agent & CSR platform for home services',
    seoTitle: 'Vireek vs Avoca AI: Two AI Voice Receptionists for Home Services Compared | Vireek',
    seoDescription:
      'Vireek and Avoca AI are both AI voice agents built for home-service businesses. See how they differ in focus, setup, and who each one is built for.',
    summary:
      'Avoca is a well-funded AI voice and CSR platform for home services, with deep integration into ServiceTitan and features spanning inbound calls, outbound campaigns, and CSR call coaching — commonly deployed by larger, multi-location operations.',
    builtFor:
      'Larger, often multi-location home-service operations — frequently already standardized on ServiceTitan — that want AI across inbound calls, outbound follow-up, and CSR performance coaching.',
    isVoiceAICompetitor: true,
    positioning: [
      {
        title: 'Focus',
        body: 'Avoca spans inbound calls, large-scale outbound campaigns, and CSR coaching in one enterprise platform. Vireek answers, triages, and books the inbound call — and can also call back on unconverted quotes, appointment reminders, and review requests — with far less to configure to get started.'
      },
      {
        title: 'Setup and footprint',
        body: 'Avoca is commonly deployed by larger, multi-brand operations already running ServiceTitan. Vireek is built to get a single-location or growing home-service business live in minutes, independent of which CRM or field-service tool you use.',
      },
      {
        title: 'Who each one fits best',
        body: 'If you need CSR performance coaching and outbound campaigns at large, multi-location scale, Avoca is built for that. If you want every inbound call answered, triaged, and booked — plus simple outbound follow-up on quotes, reminders, and reviews — without a large platform commitment, that\u2019s what Vireek is built to solve first.'
      },
    ],
    faq: [
      {
        q: 'Is Vireek the same kind of product as Avoca?',
        a: 'Both are AI voice agents built for home-service businesses, so they solve an overlapping problem. Avoca is built as a broader AI front office spanning inbound, outbound, and CSR coaching, and is commonly used by larger, ServiceTitan-based operations. Vireek is focused specifically on answering and booking the inbound call, aimed at businesses that want that solved first without a bigger platform commitment.',
      },
      {
        q: 'Does Vireek integrate with the CRM or field-service tool I already use?',
        a: 'Vireek syncs call, lead, and job data to your dashboard so nothing needs manual entry. If you have a specific integration in mind, reach out and we\u2019ll confirm compatibility before you switch anything.',
      },
      {
        q: 'Can I see how Vireek handles my real calls before deciding?',
        a: 'Yes — start a free trial and let Sarah answer your calls for a week. You\u2019ll see exactly how many get answered, triaged, and booked before committing to anything.',
      },
    ],
  },
];

export function getCompetitorBySlug(slug?: string): Competitor | undefined {
  if (!slug) return undefined;
  return COMPETITORS.find((c) => c.slug === slug);
}
