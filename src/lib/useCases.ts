import { PhoneMissed, Siren, Moon, ClipboardCheck, type LucideIcon } from 'lucide-react';

export type UseCaseSlug = 'missed-calls' | 'emergency-dispatch' | 'after-hours' | 'estimate-follow-up';

export interface UseCaseStep {
  title: string;
  detail: string;
}

export interface UseCaseOutcome {
  title: string;
  body: string;
}

export interface UseCaseLink {
  label: string;
  href: string;
  blurb: string;
}

export interface UseCaseFAQ {
  q: string;
  a: string;
}

export interface UseCase {
  slug: UseCaseSlug;
  /** Short name used in nav chips and breadcrumbs. */
  name: string;
  icon: LucideIcon;
  /** <h1> */
  headline: string;
  tagline: string;
  metaTitle: string;
  metaDescription: string;
  /** A short, illustrative scenario that opens the page. */
  situation: string;
  withoutVireek: string[];
  withVireek: string[];
  steps: UseCaseStep[];
  outcomes: UseCaseOutcome[];
  /** Shown when the scenario depends on a specific plan. */
  planNote?: string;
  related: UseCaseLink[];
  faq: UseCaseFAQ[];
  ctaHeadline: string;
}

export const USE_CASES: UseCase[] = [
  {
    slug: 'missed-calls',
    name: 'Missed Calls',
    icon: PhoneMissed,
    headline: 'Turn missed calls into booked jobs',
    tagline:
      'Every call you can’t pick up is answered, qualified and followed up — before the caller dials the next company on the list.',
    metaTitle: 'Missed Call Recovery for Home Services | Vireek',
    metaDescription:
      'Vireek answers the calls you miss, captures the lead and texts a booking link, so callers book with you instead of the next company on the list.',
    situation:
      'It’s mid-afternoon and your whole crew is on a job. A homeowner with a leaking water heater calls, reaches voicemail and moves on to the next search result. You find out hours later — if at all.',
    withoutVireek: [
      'Callers hang up on voicemail and call a competitor.',
      'You spend your evening returning calls to people who already booked elsewhere.',
      'There is no record of who called, what they needed or how urgent it was.',
    ],
    withVireek: [
      'Sarah answers instantly and finds out what the caller needs.',
      'If the call drops, the caller gets a text with your booking link.',
      'Every call becomes a structured lead in your dashboard.',
    ],
    steps: [
      { title: 'A call comes in while you’re busy', detail: 'Sarah, your AI receptionist, answers the calls you can’t take.' },
      { title: 'The lead is qualified', detail: 'Name, address, service needed and urgency are captured, with a service-area check.' },
      { title: 'A text goes out automatically', detail: 'If the caller hangs up early, a branded text with your booking link is sent within seconds.' },
      { title: 'You get the full picture', detail: 'A call summary and the lead record land in your dashboard, ready for your CRM.' },
    ],
    outcomes: [
      { title: 'Fewer lost leads', body: 'Callers reach someone every time, so fewer of them turn into a competitor’s customer.' },
      { title: 'Less phone tag', body: 'You call back with context instead of starting from “who is this and what do they need?”' },
      { title: 'A record of every call', body: 'See who called, why and what happened next, without digging through voicemail.' },
    ],
    related: [
      { label: 'SMS Text-Back', href: '/features/sms-text-back', blurb: 'How the automatic follow-up text works.' },
      { label: 'AI Lead Qualification', href: '/features/lead-qualification', blurb: 'What Sarah asks every caller.' },
      { label: 'Pricing', href: '/pricing', blurb: 'Plans start with a free tier.' },
    ],
    faq: [
      {
        q: 'What happens if the caller hangs up before Sarah finishes?',
        a: 'Vireek sends an automatic text with your booking link, so the lead isn’t lost just because the call ended early.',
      },
      {
        q: 'Can Sarah book the job directly?',
        a: 'Yes. Sarah checks your calendar for real availability and books the appointment during the call.',
      },
      {
        q: 'Do I see what was said on each call?',
        a: 'Every call is logged with a summary and the lead details, so you can follow up with full context.',
      },
    ],
    ctaHeadline: 'Stop losing jobs to voicemail.',
  },
  {
    slug: 'emergency-dispatch',
    name: 'Emergency Dispatch',
    icon: Siren,
    headline: 'Get real emergencies to a real person, fast',
    tagline:
      'Vireek spots urgent calls the moment they come in and transfers them live to your on-call team, instead of letting them sit in a queue.',
    metaTitle: 'Emergency Call Dispatch for Home Services | Vireek',
    metaDescription:
      'Vireek detects emergency calls, warm-transfers them to your on-call technician and falls back gracefully if nobody answers, so urgent jobs never wait.',
    situation:
      'A pipe bursts at 9 pm. The homeowner calls three companies, and the first one that connects them with a real person gets the job.',
    withoutVireek: [
      'Urgent calls and routine calls wait in the same voicemail box.',
      'Your on-call tech finds out about the emergency long after the customer called someone else.',
      'Nobody can tell a burst pipe from a dripping faucet until they call back.',
    ],
    withVireek: [
      'Sarah triages every call against the emergency triggers you define.',
      'Matching calls are transferred live to your on-call number or ring group.',
      'If nobody picks up, Sarah stays with the caller and flags the lead as urgent.',
    ],
    steps: [
      { title: 'Sarah detects the emergency', detail: 'Language that matches your trigger conditions, like no heat or a burst pipe, marks the call as urgent.' },
      { title: 'The call is transferred live', detail: 'A warm transfer connects the caller to your on-call number or ring group, with context.' },
      { title: 'Barge-in when it helps', detail: 'Optionally join a call in progress when a second set of ears is useful.' },
      { title: 'A safe fallback', detail: 'If no one answers, Sarah keeps the caller, captures the details and flags the job as urgent.' },
    ],
    outcomes: [
      { title: 'Speed where it counts', body: 'The calls that can’t wait reach a person first.' },
      { title: 'Rules you control', body: 'You decide what counts as an emergency and who gets the call.' },
      { title: 'Nothing falls through', body: 'Even unanswered transfers end with a captured, flagged lead.' },
    ],
    planNote: 'Emergency detection and live dispatch are included on Professional and above.',
    related: [
      { label: 'Live Escalation', href: '/features/live-escalation', blurb: 'Warm transfer, barge-in and fallback rules.' },
      { label: 'AI Lead Qualification', href: '/features/lead-qualification', blurb: 'How urgency triage works.' },
      { label: 'Pricing', href: '/pricing', blurb: 'Compare plans and what each includes.' },
    ],
    faq: [
      {
        q: 'How does Sarah know a call is an emergency?',
        a: 'You set the trigger conditions, such as no heat, a burst pipe or a gas smell. Calls that match are flagged and escalated.',
      },
      {
        q: 'What if my on-call tech doesn’t answer the transfer?',
        a: 'Sarah gracefully falls back: she stays with the caller, captures the details and marks the lead urgent for follow-up.',
      },
      {
        q: 'Can the transfer go to more than one person?',
        a: 'Yes. You can escalate to a single number or to a ring group.',
      },
    ],
    ctaHeadline: 'Make sure emergencies always reach someone.',
  },
  {
    slug: 'after-hours',
    name: 'After-Hours Calls',
    icon: Moon,
    headline: 'Answer every call after hours, without being on call',
    tagline:
      'Nights, weekends and holidays are covered. Sarah handles the call your way and has everything ready for you in the morning.',
    metaTitle: 'After-Hours Call Answering for Home Services | Vireek',
    metaDescription:
      'Vireek answers after-hours calls 24/7, routes them by your rules and gives you a morning-ready list of leads, so you stay open without staying up.',
    situation:
      'It’s 11 pm on a Saturday. A customer wants a quote for a repair they’ve been putting off. Nobody is in the office, and by Monday they’ve booked someone else.',
    withoutVireek: [
      'After-hours calls go to voicemail, and most callers don’t leave a message.',
      'Owners carry the phone everywhere just in case.',
      'Monday starts with a pile of callbacks and no idea which ones matter.',
    ],
    withVireek: [
      'Sarah answers every after-hours call, day or night.',
      'Calls are routed by the rules you set for your hours.',
      'Messages to callers reflect whether you’re open or closed.',
    ],
    steps: [
      { title: 'Set your hours', detail: 'Tell Vireek when you’re open and how you want closed hours handled.' },
      { title: 'Sarah answers when you’re closed', detail: 'Callers get a real conversation instead of a voicemail beep.' },
      { title: 'Calls are routed by urgency', detail: 'Routine requests are booked or queued; true emergencies can escalate to your on-call team.' },
      { title: 'A morning-ready handoff', detail: 'Every overnight call is logged with a summary, so you start the day knowing who to call first.' },
    ],
    outcomes: [
      { title: 'Open around the clock', body: 'Your business sounds available even when your office isn’t.' },
      { title: 'Rest without risk', body: 'Routine calls wait for morning; emergencies can still reach your on-call team.' },
      { title: 'A calmer Monday', body: 'Callbacks are organized with context instead of a pile of voicemails.' },
    ],
    planNote: '24/7 AI call answering is on every plan. Custom after-hours routing is included on Professional and above.',
    related: [
      { label: 'SMS Text-Back', href: '/features/sms-text-back', blurb: 'Hours-aware follow-up messages.' },
      { label: 'Live Escalation', href: '/features/live-escalation', blurb: 'Send true emergencies to on-call staff.' },
      { label: 'Pricing', href: '/pricing', blurb: 'See which plan fits your hours.' },
    ],
    faq: [
      {
        q: 'Will callers know they’re talking to an AI?',
        a: 'Sarah is an AI receptionist and introduces herself as your business’s assistant. She handles the call, captures the details and books or routes it.',
      },
      {
        q: 'What if an after-hours call is a real emergency?',
        a: 'On plans with emergency dispatch, Sarah can detect urgent calls and transfer them live to your on-call number or ring group.',
      },
      {
        q: 'Can I choose different handling for nights and weekends?',
        a: 'Custom after-hours routing lets you decide how closed hours are handled. It’s included on Professional and above.',
      },
    ],
    ctaHeadline: 'Stay open without staying up.',
  },
  {
    slug: 'estimate-follow-up',
    name: 'Estimate Follow-Up',
    icon: ClipboardCheck,
    headline: 'Close more estimates without chasing them',
    tagline:
      'Quotes that go quiet don’t have to die. Vireek keeps customers answered, informed and nudged toward a decision while you work.',
    metaTitle: 'Estimate Follow-Up for Home Services | Vireek',
    metaDescription:
      'Vireek answers customer questions about estimates and follows up automatically, so more quotes turn into booked jobs without you chasing them.',
    situation:
      'You sent an estimate on Tuesday. By Thursday the customer is “still thinking about it,” and you’re too busy bidding the next job to chase it.',
    withoutVireek: [
      'Follow-up depends on you remembering between jobs.',
      'Customers with a quick question reach voicemail and cool off.',
      'You can’t tell which estimates are still alive.',
    ],
    withVireek: [
      'Customers who call about an estimate reach Sarah, not voicemail.',
      'Follow-up goes out automatically instead of waiting on you.',
      'Accepted estimates are easy to move onto the schedule.',
    ],
    steps: [
      { title: 'The estimate goes out', detail: 'Customers receive a quote they can review and accept online.' },
      { title: 'Questions get answered', detail: 'When a customer calls with a question, Sarah answers and logs the conversation to the lead record.' },
      { title: 'Follow-up happens automatically', detail: 'A timely nudge keeps the estimate from going cold while you’re on another job.' },
      { title: 'Accepted work gets scheduled', detail: 'Once the customer says yes, booking the job takes one step, not a game of phone tag.' },
    ],
    outcomes: [
      { title: 'More estimates answered', body: 'Customers get a response while they’re still deciding.' },
      { title: 'Less manual chasing', body: 'Follow-up stops depending on your memory between jobs.' },
      { title: 'A clear pipeline', body: 'See which estimates are open, discussed or accepted.' },
    ],
    related: [
      { label: 'AI Lead Qualification', href: '/features/lead-qualification', blurb: 'Capture the details behind every estimate.' },
      { label: 'SMS Text-Back', href: '/features/sms-text-back', blurb: 'Text follow-up that keeps leads warm.' },
      { label: 'Pricing', href: '/pricing', blurb: 'Plans for every size of team.' },
    ],
    faq: [
      {
        q: 'Does follow-up go out without me doing anything?',
        a: 'Yes. Follow-up is automatic, so a quote doesn’t depend on you remembering to chase it between jobs.',
      },
      {
        q: 'What if the customer calls with a question about the estimate?',
        a: 'Sarah answers the call, captures the question and logs it to the lead record so you can respond with context.',
      },
      {
        q: 'Can customers accept an estimate online?',
        a: 'Yes. Estimates can be reviewed and accepted online, which makes the next step as simple as possible.',
      },
    ],
    ctaHeadline: 'Turn quiet estimates into booked jobs.',
  },
];

export function getUseCaseBySlug(slug: string | undefined): UseCase | undefined {
  return USE_CASES.find((useCase) => useCase.slug === slug);
}

export function useCasePath(slug: UseCaseSlug): string {
  return `/use-cases/${slug}`;
}
