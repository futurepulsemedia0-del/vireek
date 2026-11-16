import type { DeepContentData } from './types';

export const ABOUT_DEEP: DeepContentData = {
  eyebrow: 'The full picture',
  title: 'What Vireek is, how it works, and what it deliberately is not',
  intro:
    'Vireek is early, and we would rather explain it plainly than oversell it. This section covers the problem we are solving, how a call moves through the product, where the human stays in charge, and the limits you should know before you start.',
  related: [
    { label: 'Features', href: '/features' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'Industries', href: '/industries' },
    { label: 'Manifesto', href: '/manifesto' },
    { label: 'Trust Center', href: '/trust' },
  ],
  sections: [
    {
      id: 'problem',
      title: 'The problem: the phone rings when nobody can answer it',
      blocks: [
        {
          kind: 'p',
          text: 'A home-service business earns money in the field, and the field is exactly where the phone is hardest to answer. A technician under a sink, on a roof or inside an attic cannot pick up a call. An owner who is quoting a job cannot either. The calls keep arriving anyway, and they cluster at the worst moments: the first cold morning of the year, the first heat wave, the hour after a storm.',
        },
        {
          kind: 'p',
          text: 'Most callers who reach voicemail do not leave a message. They call the next company on the list. For a trade business, that caller is often someone with an active problem and a decision already made, which makes a missed call more expensive than a missed marketing impression. The cost is rarely visible, because nothing records the job you never heard about.',
        },
        {
          kind: 'p',
          text: 'The traditional fixes each have a catch. A full-time receptionist costs a salary, covers a fixed shift and still cannot answer three lines at once. A generic answering service can take a message, but it does not know your trade, your service area or your escalation rules, and it rarely books anything. Vireek exists to close that gap with a receptionist that knows the trades and is available at any hour.',
        },
      ],
    },
    {
      id: 'call-journey',
      title: 'What happens to a call, step by step',
      blocks: [
        {
          kind: 'steps',
          items: [
            {
              title: 'The call reaches Sarah',
              text: 'Calls are routed to Vireek, either directly or as overflow when your team does not pick up. Sarah answers with the greeting you configured, in a natural conversational voice rather than a keypad menu.',
            },
            {
              title: 'She works out what the caller needs',
              text: 'Sarah listens for intent: a new service request, a reschedule, a question about an existing job, or an urgent problem. She asks trade-relevant questions, such as what system is affected, what the symptoms are and how long it has been happening.',
            },
            {
              title: 'Urgency is judged against your rules',
              text: 'Language that points to flooding, a gas smell, no heat in winter or a live electrical problem is treated as urgent according to the escalation rules you set. Routine requests follow the normal booking path.',
            },
            {
              title: 'The details are captured',
              text: 'Name, phone number, address and the issue are logged during the call. Repeat callers are recognised, so their profile is enriched instead of duplicated.',
            },
            {
              title: 'A next step is arranged before the caller hangs up',
              text: 'Where booking is enabled, Sarah offers real openings from your calendar and confirms one. Where it is not, the lead is captured and queued for your team. Urgent calls are flagged and routed to the people you chose.',
            },
            {
              title: 'Follow-up happens without anyone remembering to do it',
              text: 'The customer can receive a text confirmation, you receive a call summary, and the record syncs to the tools you connect. Missed-call text-back and quote follow-ups cover the calls and conversations that would otherwise go quiet.',
            },
          ],
        },
      ],
    },
    {
      id: 'human-in-charge',
      title: 'Where a human stays in charge',
      blocks: [
        {
          kind: 'p',
          text: 'We do not think an AI should pretend to handle everything. Sarah is built to recognise when a call needs a person and to hand it over with context, rather than to improvise through a situation she should not be deciding.',
        },
        {
          kind: 'list',
          items: [
            'You define the escalation rules: which situations count as emergencies and who gets alerted.',
            'On plans that include live escalation, Sarah can bring a team member into a call as a warm transfer with the context she has gathered, so the caller does not repeat themselves.',
            'You can review call summaries and outcomes in the dashboard, including sentiment and quality scoring, so problems surface instead of hiding.',
            'Your business information and knowledge base are yours to edit, and changes are pushed into what Sarah knows.',
          ],
        },
        {
          kind: 'callout',
          title: 'Emergency services are not replaced',
          text: 'Sarah can flag and route an urgent call to your team. She does not replace 911 or any emergency service, and no part of Vireek should be relied on as one.',
        },
      ],
    },
    {
      id: 'who-for',
      title: 'Who Vireek is built for',
      blocks: [
        {
          kind: 'p',
          text: 'Vireek is designed for home-service businesses: HVAC, plumbing, roofing, electrical and restoration are the core, with other trades supported through trade-specific setups. It fits best where inbound calls are the main source of new work, where jobs are scheduled rather than sold from a storefront, and where the owner or a small office team currently absorbs the phone.',
        },
        {
          kind: 'table',
          caption: 'Typical situations and what Vireek does about them',
          headers: ['Situation', 'What usually goes wrong', 'What Vireek does'],
          rows: [
            ['Solo owner-operator', 'Calls go to voicemail during jobs', 'Answers, captures the lead, books or queues it, and texts a summary'],
            ['Small office, one dispatcher', 'Phones overwhelm the dispatcher at peak times', 'Takes overflow so the dispatcher keeps working on live jobs'],
            ['Team with on-call technicians', 'After-hours emergencies reach no one', 'Flags urgent calls and routes them to the on-call people you set'],
            ['Multi-location operator', 'Each location handles calls differently', 'Gives each location its own workspace, roster and analytics'],
          ],
        },
      ],
    },
    {
      id: 'beyond-calls',
      title: 'Beyond answering: the connected workflow',
      blocks: [
        {
          kind: 'p',
          text: 'A call is only the start of a job. Vireek also covers what comes after: scheduling and reminders, a dispatch board and technician job board on plans that include them, quotes and follow-ups, invoicing and review requests. The aim is that the information captured on the first call is the same information your technician and your office use later, with no re-typing.',
        },
        {
          kind: 'list',
          items: [
            'Scheduling: booking against your calendar, reminders and reschedule handling.',
            'Customer communication: SMS confirmations, missed-call text-back, and WhatsApp and Instagram DMs where connected.',
            'Field-service connections such as ServiceTitan and Jobber. Today these sync your price book so Sarah can quote current prices; each integration page states its current scope.',
            'Operations: dispatch, parts checks and multi-location management on the plans that include them.',
          ],
        },
        {
          kind: 'p',
          text: 'Which of these you get depends on your plan. The pricing page is the single place where plans and limits are listed, so we do not repeat numbers here.',
        },
      ],
    },
    {
      id: 'limits',
      title: 'Limits you should know before you start',
      blocks: [
        {
          kind: 'list',
          items: [
            'Vireek is early. We are not claiming a large customer base or a large team, and you should evaluate it on a trial with your own calls.',
            'Sarah is AI. She is designed to sound natural, but she is not a person, and callers are never told otherwise where disclosure rules apply.',
            'Quality depends on your inputs. The accuracy of your hours, services, service area and escalation rules directly shapes how well calls are handled.',
            'Integrations vary by plan, and some require a connected account on your side before data syncs.',
            'Some call types should always reach a human. Complex complaints, legal disputes and anything outside your configured rules are better handled by your team.',
          ],
        },
      ],
    },
    {
      id: 'getting-started',
      title: 'How to evaluate Vireek honestly',
      blocks: [
        {
          kind: 'steps',
          items: [
            {
              title: 'Start on the trial',
              text: 'Use the free trial to hear Sarah handle your actual call types before you commit to anything.',
            },
            {
              title: 'Write down your real escalation rules',
              text: 'Decide what counts as an emergency for your business and who should be alerted, then set those rules before routing live calls.',
            },
            {
              title: 'Route overflow first',
              text: 'Many teams begin by sending only after-hours or unanswered calls to Sarah, then widen coverage once they trust the results.',
            },
            {
              title: 'Review the summaries for two weeks',
              text: 'Read the call summaries and quality scores, correct your knowledge base wherever Sarah was unsure, and decide based on what you actually see.',
            },
          ],
        },
      ],
    },
  ],
  faqs: [
    {
      q: 'Is Vireek a person or software?',
      a: 'Software. Sarah is an AI voice receptionist designed to sound natural and to follow the instructions and escalation rules you set.',
    },
    {
      q: 'Why does Vireek focus only on home-service businesses?',
      a: 'The calls are different from generic business calls: urgency matters, jobs are scheduled at an address, and trade vocabulary changes the right questions. Focusing on one industry lets the product be useful out of the box instead of generic.',
    },
    {
      q: 'Does Vireek have customers I can contact?',
      a: 'Vireek is early and we do not publish customer counts or testimonials we cannot stand behind. The free trial lets you judge it on your own calls.',
    },
    {
      q: 'What if Sarah is unsure about something?',
      a: 'She is designed to capture the details and hand the call to your team rather than invent an answer. Updating your knowledge base reduces how often that happens.',
    },
  ],
};
