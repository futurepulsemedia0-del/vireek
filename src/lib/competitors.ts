import { Building2, Wrench, ClipboardList, Bot, Headset, Zap, UserCheck, MessageSquare, Car, PhoneCall, Sparkles, type LucideIcon } from 'lucide-react';

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
      'Many ServiceTitan customers still lose after-hours and overflow calls to voicemail. Vireek is built to answer those calls, triage them, and log everything back into your workflow — it doesn’t require you to replace ServiceTitan to do it.',
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
      'Vireek is built to sit in front of the phone — answering, triaging, and booking the call — while Housecall Pro (or whatever you already run) handles the job once it’s on the calendar.',
    faq: [
      {
        q: 'Does Housecall Pro answer my phone for me?',
        a: 'Housecall Pro focuses on scheduling, invoicing, and payments once a job is in the system — it tracks calls but doesn’t include an AI voice agent that actually answers and converses with a caller the way Vireek does.',
      },
      {
        q: 'Can I use Vireek and Housecall Pro together?',
        a: 'Yes. Vireek answers and books the call, then syncs the lead or job details so they show up wherever you’re already tracking work — including Housecall Pro.',
      },
      {
        q: 'Which one should I start with?',
        a: 'If your main problem is missed or unanswered calls, start with Vireek — that’s the specific gap it closes. If you need scheduling, quoting, and invoicing and already answer your phone reliably, Housecall Pro solves a different problem.',
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
      { feature: 'Built specifically around handling the trades’ phone calls', vireek: 'yes', competitor: 'no' },
      { feature: 'Sends automated SMS confirmations after booking', vireek: 'yes', competitor: 'partial' },
      { feature: 'Simple, published pricing', vireek: 'yes', competitor: 'yes' },
    ],
    worksWellTogether:
      'Jobber is a favorite for small crews that want simple scheduling. Vireek pairs well with it by making sure calls get answered and booked in the first place — especially nights, weekends, and busy job-site hours when nobody’s free to pick up.',
    faq: [
      {
        q: 'Is Jobber an AI phone receptionist?',
        a: 'No. Jobber is scheduling, quoting, and invoicing software. It helps you manage jobs once they’re booked, but it doesn’t answer the phone or hold a conversation with a caller — that’s the part Vireek is built for.',
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
      'A traditional answering service routes your business calls to a live, off-site operator (or a call center) who answers using a generic script, takes down a message or basic details, and forwards it to you — typically billed per minute or per call handled.',
    builtFor:
      'Businesses that want a human voice picking up the phone when staff can’t, without needing the call itself to result in a booked job.',
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
        q: 'What’s the actual difference between an AI receptionist and an answering service?',
        a: 'An answering service routes your call to a live human operator, usually reading from a general script, who takes a message or basic details and passes it along — the booking still has to happen after the call. Vireek is an AI voice receptionist that has a live conversation with the caller, understands the trade-specific problem they’re describing, and books the appointment directly onto your calendar before the call even ends.',
      },
      {
        q: 'Is a live human always better than an AI voice receptionist?',
        a: 'Not necessarily for this use case. Answering-service operators typically handle calls for many different businesses and follow a generic script, so they can’t triage a trade-specific emergency or book directly into your calendar. Vireek is trained specifically on HVAC, plumbing, electrical, and similar trades, and connects directly to your scheduling system — so callers get a more specific, more useful conversation, not just a human voice.',
      },
      {
        q: 'How does pricing typically compare?',
        a: 'Traditional answering services commonly bill per minute or per call handled, so costs rise directly with call volume. Vireek is built to answer unlimited calls without that per-call math. Exact pricing for any answering service varies by provider — check their current rates directly — but the billing model itself is worth comparing before you commit.',
      },
      {
        q: 'Can Vireek handle a true emergency call the way a person would?',
        a: 'Vireek is built to recognize emergency language — things like a burst pipe, no heat in winter, or a gas smell — and route or flag those calls immediately, the same job a live answering-service operator is trained to do. The difference is Vireek can also move straight into booking the emergency appointment on the spot, without a separate callback.',
      },
      {
        q: 'Do I need to switch everything over at once?',
        a: 'No. Many businesses start Vireek on overflow or after-hours calls — the ones an answering service usually charges the most to cover — and expand from there once they see how many get booked automatically.',
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
        body: 'If you need CSR performance coaching and outbound campaigns at large, multi-location scale, Avoca is built for that. If you want every inbound call answered, triaged, and booked — plus simple outbound follow-up on quotes, reminders, and reviews — without a large platform commitment, that’s what Vireek is built to solve first.'
      },
    ],
    faq: [
      {
        q: 'Is Vireek the same kind of product as Avoca?',
        a: 'Both are AI voice agents built for home-service businesses, so they solve an overlapping problem. Avoca is built as a broader AI front office spanning inbound, outbound, and CSR coaching, and is commonly used by larger, ServiceTitan-based operations. Vireek is focused specifically on answering and booking the inbound call, aimed at businesses that want that solved first without a bigger platform commitment.',
      },
      {
        q: 'Does Vireek integrate with the CRM or field-service tool I already use?',
        a: 'Vireek syncs call, lead, and job data to your dashboard so nothing needs manual entry. If you have a specific integration in mind, reach out and we’ll confirm compatibility before you switch anything.',
      },
      {
        q: 'Can I see how Vireek handles my real calls before deciding?',
        a: 'Yes — start a free trial and let Sarah answer your calls for a week. You’ll see exactly how many get answered, triaged, and booked before committing to anything.',
      },
    ],
  },
  {
    slug: 'sameday-ai',
    name: 'Sameday AI',
    icon: Zap,
    category: 'AI phone answering & scheduling platform for home services',
    seoTitle: 'Vireek vs Sameday AI: Two AI Answering Services for Home Services Compared | Vireek',
    seoDescription:
      'Vireek and Sameday AI are both AI-powered phone answering platforms built for home-service contractors. See how they differ in focus, setup, and who each is built for.',
    summary:
      'Sameday AI is an AI-powered phone answering and scheduling platform built specifically for home-service contractors — plumbing, HVAC, electrical, roofing, and similar trades — with integrations into field-service platforms like ServiceTitan, Jobber, and Housecall Pro.',
    builtFor:
      'Home-service contractors, often already running a field-service platform, who want an AI agent to answer overflow and after-hours calls and book jobs directly onto the schedule.',
    isVoiceAICompetitor: true,
    positioning: [
      {
        title: 'Focus',
        body: 'Both Vireek and Sameday AI are built around the same core job: answering the phone and booking the appointment for home-service businesses. Sameday also layers in texting, a shared inbox, and CSR call-coaching tools. Vireek keeps the workflow centered on answering, triaging, and booking the call itself — plus simple outbound follow-up on quotes, reminders, and reviews — with less to configure to get started.',
      },
      {
        title: 'Setup and integrations',
        body: 'Both platforms connect to common field-service tools such as ServiceTitan, Jobber, and Housecall Pro. Vireek is built to get a single-location or growing home-service business live quickly, independent of which CRM or field-service tool you already use.',
      },
      {
        title: 'Who each one fits best',
        body: 'Both are aimed at the same core buyer — a home-service business tired of losing calls to voicemail. The right fit usually comes down to which one’s onboarding, pricing model, and extra features (CSR coaching, texting, outbound campaigns) match how your team actually works. Trying both on your real call volume is the most reliable way to compare them.',
      },
    ],
    faq: [
      {
        q: 'Is Vireek basically the same product as Sameday AI?',
        a: 'They solve the same core problem — an AI voice agent that answers and books calls for home-service businesses — so they’re direct competitors in that sense. The differences come down to setup, pricing model, and which extra features (CSR coaching, texting, outbound campaigns) each platform bundles in.',
      },
      {
        q: 'Does Vireek integrate with the same tools Sameday AI does?',
        a: 'Vireek syncs call, lead, and job data to your dashboard, and can connect to common field-service and CRM tools. If you have a specific platform in mind, reach out and we’ll confirm compatibility before you switch anything.',
      },
      {
        q: 'How do I know which one actually works better for my business?',
        a: 'The most reliable test is your own call volume, not marketing claims from either company. Start a free trial and let Vireek answer your real calls for a week — you’ll see exactly how many get answered, triaged, and booked before deciding.',
      },
    ],
  },
  {
    slug: 'smith-ai',
    name: 'Smith.ai',
    icon: UserCheck,
    category: 'AI + live-human hybrid virtual receptionist for professional services',
    seoTitle: 'Vireek vs Smith.ai: AI Voice Receptionist vs AI + Human Hybrid Answering | Vireek',
    seoDescription:
      'Smith.ai blends AI with live North America-based receptionists for law firms, agencies, and professional services. Vireek is a pure-AI voice receptionist built specifically for home-service trades. See how they compare.',
    summary:
      'Smith.ai offers virtual receptionist services that combine AI call handling with live, North America-based human agents, serving a broad range of professional-service businesses — law firms, agencies, consultants, real estate, and more — rather than one specific industry.',
    builtFor:
      'Professional-service businesses across many industries that want a receptionist blending AI with live human backup, priced per call handled.',
    isVoiceAICompetitor: true,
    positioning: [
      {
        title: 'Focus',
        body: 'Smith.ai is built as a general-purpose virtual receptionist for professional services broadly — law firms, agencies, consultants — combining an AI layer with live human agents for calls that need it. Vireek is purpose-built for home-service trades specifically, trained on plumbing, HVAC, and electrical terminology, and books appointments directly into the trade tools you already use.',
      },
      {
        title: 'Pricing model',
        body: 'Smith.ai’s virtual receptionist plans are commonly billed per call handled, so cost scales with call volume. Vireek is built to answer high call volumes without that per-call math — worth comparing directly against your own expected volume before committing to either.',
      },
      {
        title: 'Who each one fits best',
        body: 'If your business is a law firm, agency, or professional-services company that wants a human voice available as backup on complex calls, Smith.ai’s hybrid model is built for that. If you’re a home-service contractor that wants an AI agent trained specifically on trade-specific emergencies and booking, that’s the problem Vireek is built to solve first.',
      },
    ],
    faq: [
      {
        q: 'Is Smith.ai an AI receptionist or a human answering service?',
        a: 'Both — Smith.ai’s core offering blends an AI layer with live, North America-based human receptionists who can step in on calls that need a human touch. Vireek is a pure-AI voice receptionist purpose-built for home-service trades, with no live-agent layer to configure or pay for.',
      },
      {
        q: 'Is Vireek trained on the trades the way Smith.ai is trained on legal intake?',
        a: 'Yes — Vireek is built specifically around HVAC, plumbing, electrical, and similar trade-specific language and emergencies, rather than general-purpose professional-services intake. That focus is the main reason home-service businesses often start with Vireek over a broader, multi-industry receptionist platform.',
      },
      {
        q: 'Can I try Vireek before switching from an existing answering service?',
        a: 'Yes — start a free trial and let Vireek answer your real calls for a week. You’ll see exactly how many get answered, triaged, and booked before committing to anything.',
      },
    ],
  },
  {
    slug: 'podium',
    name: 'Podium',
    icon: MessageSquare,
    category: 'Customer communication, reviews & payments platform with an AI add-on',
    seoTitle: 'Vireek vs Podium: AI Phone Receptionist vs Messaging & Reviews Platform | Vireek',
    seoDescription:
      'Podium is a customer-communication platform for texting, reviews, and payments, with an AI Employee add-on. Vireek is an AI voice receptionist built specifically to answer and book every call. See how they compare.',
    summary:
      'Podium is a customer-communication and reputation-management platform built for local businesses — a unified inbox for texts, webchat, reviews, and payments across channels — with an “AI Employee” add-on that can also handle calls and messages.',
    builtFor:
      'Local businesses across many verticals (auto, home services, retail) that want one inbox for messaging, review requests, and payments, with AI call and text handling available as an add-on.',
    isVoiceAICompetitor: false,
    featureRows: [
      { feature: 'Answers and holds a live phone conversation, 24/7', vireek: 'yes', competitor: 'partial' },
      { feature: 'Books appointments directly from the call itself', vireek: 'yes', competitor: 'partial' },
      { feature: 'Built specifically around the trades’ phone calls', vireek: 'yes', competitor: 'no' },
      { feature: 'Unified inbox for texts, webchat & social messages', vireek: 'no', competitor: 'yes' },
      { feature: 'Automated review-request campaigns', vireek: 'no', competitor: 'yes' },
      { feature: 'Text-to-pay / in-app payments', vireek: 'no', competitor: 'yes' },
      { feature: 'Transparent, published pricing', vireek: 'yes', competitor: 'no' },
    ],
    worksWellTogether:
      'Many businesses run Podium for reviews, texting, and payments while using Vireek specifically to make sure every inbound call gets answered and booked — the two solve different halves of the same front-office problem.',
    faq: [
      {
        q: 'Is Podium an AI phone receptionist?',
        a: 'Podium’s core product is a communication and reputation-management platform — texting, reviews, webchat, and payments in one inbox. It offers an “AI Employee” as an add-on that can also handle calls and messages. Vireek is focused specifically on the phone call: answering it, triaging it, and booking it, trained on trade-specific language.',
      },
      {
        q: 'I already use Podium — do I still need Vireek?',
        a: 'If Podium’s AI Employee is already answering and booking every call reliably, maybe not. If calls are still going to voicemail after hours or during busy periods, Vireek is built to catch exactly those calls and book them directly onto your calendar — while you keep Podium for reviews, texting, and payments.',
      },
      {
        q: 'Does Vireek replace Podium?',
        a: 'No — they cover different parts of the front office. Vireek focuses on the phone call itself; Podium focuses on messaging, reputation, and payments across channels. Most businesses that use Vireek keep whatever review or texting platform they already run.',
      },
    ],
  },
  {
    slug: 'numa',
    name: 'Numa',
    icon: Car,
    category: 'AI voice & customer-operations platform for auto dealerships',
    seoTitle: 'Vireek vs Numa: AI Receptionist for Home Services vs Auto Dealership AI | Vireek',
    seoDescription:
      'Numa is an AI voice and customer-operations platform built primarily for car dealership service departments. Vireek is an AI voice receptionist built specifically for home-service trades. See how they compare.',
    summary:
      'Numa is a full-stack AI customer-operations platform built primarily for car dealership service departments — voice AI call answering paired with repair-order tracking, proactive status updates, and dealer-group dashboards, integrated directly into dealership DMS systems.',
    builtFor:
      'Car dealerships and dealer groups, particularly fixed-ops and service departments, rather than independent home-service trade businesses.',
    isVoiceAICompetitor: true,
    positioning: [
      {
        title: 'Focus',
        body: 'Numa is built around the automotive dealership service lane specifically — repair-order status, DMS integration, and dealer-group reporting alongside its voice AI. Vireek is built around home-service trades specifically — HVAC, plumbing, electrical — with the call, the booking, and trade-specific emergency triage as the core focus.',
      },
      {
        title: 'Industry fit',
        body: 'If your business is a car dealership managing a service lane and repair orders through a DMS, Numa’s dealership-specific workflows are built for that context. If your business is an independent home-service contractor, Vireek’s trade-specific training and field-service integrations are the closer fit.',
      },
      {
        title: 'Who each one fits best',
        body: 'These two rarely compete head-to-head for the same buyer — Numa is aimed at dealership fixed-ops teams, while Vireek is aimed at HVAC, plumbing, electrical, and similar trade businesses. Choosing between them usually comes down to which industry your business is actually in.',
      },
    ],
    faq: [
      {
        q: 'Is Numa built for home-service businesses like Vireek is?',
        a: 'Not primarily. Numa’s core product and integrations are built around car dealership service departments — repair orders, DMS systems, and fixed-ops reporting. Vireek is built specifically for HVAC, plumbing, electrical, and similar home-service trades.',
      },
      {
        q: 'Could a home-service business use Numa instead of Vireek?',
        a: 'It’s possible in theory, but Numa’s workflows, integrations, and terminology are optimized for automotive dealerships rather than trade-specific emergencies like a burst pipe or a gas smell — the kind of calls Vireek is trained to triage and book directly.',
      },
      {
        q: 'Can I see how Vireek handles calls for my specific trade before switching?',
        a: 'Yes — start a free trial and let Vireek answer your real calls for a week. You’ll see exactly how many get answered, triaged, and booked for your specific trade before committing to anything.',
      },
    ],
  },
  {
    slug: 'goodcall',
    name: 'Goodcall',
    icon: PhoneCall,
    category: 'General-purpose AI phone agent for small businesses',
    seoTitle: 'Vireek vs Goodcall: Trade-Specific AI Receptionist vs General AI Phone Agent | Vireek',
    seoDescription:
      'Goodcall is a general-purpose AI phone agent built to serve small businesses across many industries. Vireek is an AI voice receptionist trained specifically on the trades. See how they compare.',
    summary:
      'Goodcall (originally incubated at Google as “CallJoy”) is a general-purpose AI phone agent built to serve small businesses across many industries — not trade-specific — using configurable conversation flows for FAQs, booking, and lead capture, priced per agent based on call volume.',
    builtFor:
      'Solo owners and small businesses across many verticals (salons, restaurants, retail, home services, and more) who want a flat-rate, easy-to-set-up AI phone agent without deep industry-specific customization.',
    isVoiceAICompetitor: true,
    positioning: [
      {
        title: 'Focus',
        body: 'Goodcall is designed as a general-purpose AI phone agent that works reasonably well across many industries using configurable, pre-defined conversation flows. Vireek is purpose-built for home-service trades specifically — trained on plumbing, HVAC, and electrical language and emergencies — rather than a one-size-fits-all script.',
      },
      {
        title: 'Setup and pricing',
        body: 'Goodcall is commonly priced per agent based on unique callers, with self-service, no-code setup. Vireek is built to get a home-service business live quickly with a workflow already tuned to trade-specific calls, rather than a flow you configure from a blank template.',
      },
      {
        title: 'Who each one fits best',
        body: 'If you run a small business in a non-trade industry and want a flat-rate, general-purpose AI phone agent, Goodcall’s broad approach can be a fit. If you’re a home-service contractor that needs trade-specific emergency triage and direct booking into field-service tools, that’s what Vireek is built to solve first.',
      },
    ],
    faq: [
      {
        q: 'Is Goodcall trained specifically on home-service trades?',
        a: 'No — Goodcall is a general-purpose AI phone agent designed to work across many industries using configurable conversation flows. Vireek is trained specifically on HVAC, plumbing, electrical, and similar trade-specific language and emergencies.',
      },
      {
        q: 'Why would a home-service business pick Vireek over a general AI phone agent like Goodcall?',
        a: 'Trade-specific businesses often need the AI to recognize real emergencies (a burst pipe, no heat in winter, a gas smell) and book directly into the scheduling tools they already run. A general-purpose platform can be configured to approximate this, but Vireek is built around it from the start.',
      },
      {
        q: 'Can I test Vireek on my own calls before switching from Goodcall?',
        a: 'Yes — start a free trial and let Vireek answer your real calls for a week. You’ll see exactly how many get answered, triaged, and booked before committing to anything.',
      },
    ],
  },
  {
    slug: 'rosie-my-ai-front-desk',
    name: 'Rosie & My AI Front Desk',
    icon: Sparkles,
    category: 'Budget AI phone-answering services for small businesses & trades',
    seoTitle: 'Vireek vs Rosie & My AI Front Desk: Budget AI Answering vs Trade-Built Receptionist | Vireek',
    seoDescription:
      'Rosie and My AI Front Desk are budget-oriented AI answering services for small businesses. Vireek is an AI voice receptionist built specifically for home-service trades. See how they compare.',
    summary:
      'Rosie and My AI Front Desk are two budget-oriented, pure-AI answering services aimed at small businesses and trades. Rosie focuses tightly on call answering, booking, and summaries with a mobile app; My AI Front Desk bundles a broader front-office suite — CRM, chatbot, SMS agent, and outbound calling — into one platform.',
    builtFor:
      'Cost-conscious solo owners and small trade businesses looking for a low entry-price way to stop missing calls, with fewer built-in integrations than a dedicated field-service AI platform.',
    isVoiceAICompetitor: true,
    positioning: [
      {
        title: 'Focus',
        body: 'Rosie keeps its scope narrow — answer the call, book the appointment, send a summary. My AI Front Desk goes broader with a bundled CRM, chatbot, and outbound calling. Vireek sits between the two in scope: focused on answering, triaging, and booking the call — plus simple outbound follow-up on quotes, reminders, and reviews — while staying built specifically around home-service trade language and emergencies.',
      },
      {
        title: 'Pricing model',
        body: 'Both Rosie and My AI Front Desk commonly bill by the minute or by plan tier, with entry-level plans priced for very low call volume. Vireek is built to answer higher call volumes without that per-minute math becoming the deciding factor — worth comparing directly against your own expected call volume.',
      },
      {
        title: 'Who each one fits best',
        body: 'If you’re a very low-call-volume solo operator wanting the cheapest possible entry point, Rosie’s narrow focus or My AI Front Desk’s bundle can make sense. If you already run a field-service tool and want an AI receptionist trained specifically on trade emergencies that syncs directly into your existing workflow, that’s what Vireek is built to solve first.',
      },
    ],
    faq: [
      {
        q: 'What’s the difference between Rosie and My AI Front Desk?',
        a: 'Rosie is a focused AI answering service — it answers calls, books appointments, and sends summaries, with a mobile app. My AI Front Desk bundles a broader suite (CRM, chatbot, SMS agent, outbound calling, and more voice options) into one platform. Vireek is built specifically around home-service trade calls and integrates directly with the field-service tools contractors already use.',
      },
      {
        q: 'Are these good options if I already use a CRM or field-service platform?',
        a: 'If you already run a tool like Jobber, ServiceTitan, or Housecall Pro, a bundled platform can mean duplicate data entry between two systems. Vireek is built to sync call, lead, and job data into your existing dashboard and field-service tool rather than replacing it.',
      },
      {
        q: 'How do I know which AI answering service actually fits my trade?',
        a: 'The most reliable way is testing on your own calls. Start a free trial and let Vireek answer your real calls for a week — you’ll see exactly how many get answered, triaged, and booked for your specific trade before committing to anything.',
      },
    ],
  },
];

export function getCompetitorBySlug(slug?: string): Competitor | undefined {
  if (!slug) return undefined;
  return COMPETITORS.find((c) => c.slug === slug);
}
