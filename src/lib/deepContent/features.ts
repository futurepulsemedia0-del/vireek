import type { DeepContentData } from './types';

export const FEATURES_DEEP: DeepContentData = {
  eyebrow: 'Feature guide',
  title: 'How the features fit together, and which ones matter first',
  intro:
    'A long feature list is hard to evaluate. This guide explains what each group of features is for, how they connect across a single job, and a sensible order to switch them on.',
  related: [
    { label: 'Platform', href: '/platform' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'Integrations', href: '/integrations' },
    { label: 'Missed calls', href: '/use-cases/missed-calls' },
  ],
  sections: [
    {
      id: 'one-job',
      title: 'Follow one job through the product',
      blocks: [
        {
          kind: 'p',
          text: 'The easiest way to understand the features is to follow a single customer. Most of what Vireek does is one chain of steps, and each feature hands information to the next.',
        },
        {
          kind: 'steps',
          items: [
            { title: 'A call comes in', text: '24/7 AI answering picks up, and intent detection works out whether it is a new request, a reschedule or an urgent problem.' },
            { title: 'The lead is captured and qualified', text: 'Customer capture logs name, number and issue. Lead qualification asks trade-relevant questions, and deduplication recognises repeat callers.' },
            { title: 'An appointment is booked', text: 'Smart booking checks your calendar and offers real slots. Google Calendar sync keeps the booking visible without double-booking.' },
            { title: 'The customer is told', text: 'SMS confirmations and reminders reduce confusion and no-shows. If the caller reschedules by text, reschedule handling updates the booking.' },
            { title: 'The job is dispatched', text: 'On plans that include it, the dispatch board and job board help match the right technician, and parts checks look at truck stock before the visit.' },
            { title: 'The loop closes', text: 'Review requests go out after completion, and quotes that go quiet receive a follow-up. Analytics and call QA show what actually happened.' },
          ],
        },
      ],
    },
    {
      id: 'call-intelligence',
      title: 'Call Intelligence: what Sarah hears and does',
      blocks: [
        {
          kind: 'p',
          text: 'This group is the front door. It decides what happens to a call in its first seconds, and the quality of everything after it depends on getting this right.',
        },
        {
          kind: 'list',
          items: [
            '24/7 AI Answering: calls are answered at any hour, including weekends and holidays, so after-hours calls are not lost to voicemail.',
            'Call Summaries: each conversation is recapped for your inbox and CRM, so nobody needs to listen to a recording to know what happened.',
            'Intent Detection: the reason for the call determines the route, whether that is booking, escalation or a callback.',
            'Live Escalation: on plans that include it, Sarah brings a team member into the call, either as a warm transfer with context or through live barge-in.',
          ],
        },
        {
          kind: 'callout',
          title: 'Start here',
          text: 'If you only switch on one thing first, make it answering plus your escalation rules. Everything else assumes the call was handled well.',
        },
      ],
    },
    {
      id: 'lead-management',
      title: 'Lead Management: turning a call into a record',
      blocks: [
        {
          kind: 'p',
          text: 'A call that is not turned into structured data is a call someone has to re-type later. Lead management captures the essentials during the conversation, so the lead exists before the caller hangs up.',
        },
        {
          kind: 'list',
          items: [
            'Customer Capture records name, number and issue at the moment of contact.',
            'Lead Qualification uses your trade’s questions to separate routine service from urgent work.',
            'Deduplication recognises repeat callers and enriches the existing profile, which keeps your customer list clean.',
          ],
        },
      ],
    },
    {
      id: 'scheduling',
      title: 'Scheduling: from conversation to calendar slot',
      blocks: [
        {
          kind: 'p',
          text: 'Booking is the point where a conversation becomes revenue. Scheduling features exist to make that step happen during the call and to keep the calendar trustworthy afterwards.',
        },
        {
          kind: 'list',
          items: [
            'Smart Booking proposes real openings based on your availability.',
            'Google Calendar Sync reflects bookings live and avoids double-booking.',
            'Reschedule Handling lets a customer text a change and receive new options without a phone call to your office.',
          ],
        },
      ],
    },
    {
      id: 'communication',
      title: 'Customer Communication: keeping people informed',
      blocks: [
        {
          kind: 'p',
          text: 'Most no-shows and angry callbacks come from uncertainty about when someone is arriving. Messaging features answer that question before the customer has to ask it.',
        },
        {
          kind: 'table',
          caption: 'Messaging features and the problem each one solves',
          headers: ['Feature', 'Problem it addresses'],
          rows: [
            ['SMS Confirmations', 'Customer is unsure the booking happened or what the details are'],
            ['Appointment Reminders', 'No-shows and forgotten appointments'],
            ['Missed-Call Text-Back', 'A caller who could not reach you moves on to a competitor'],
            ['WhatsApp & Instagram DMs', 'Leads who message instead of calling are answered slowly'],
          ],
        },
        {
          kind: 'p',
          text: 'Messaging is regulated in many places. Vireek provides SMS terms and compliance pages, and you remain responsible for having the right consent for the people you contact.',
        },
      ],
    },
    {
      id: 'crm-data',
      title: 'CRM and data: one record, not five',
      blocks: [
        {
          kind: 'p',
          text: 'The cost of disconnected tools is re-entering the same information. CRM features exist so that what was captured on the call appears where your office already works.',
        },
        {
          kind: 'list',
          items: [
            'CRM Sync sends call details, lead information and bookings to ServiceTitan, Housecall Pro and Jobber on plans that include those integrations.',
            'Knowledge Base Sync pushes changes to your business information into Sarah’s live prompt, so updating hours or services takes effect without a rebuild.',
            'Unified Inbox brings channels such as Facebook, Angi, Thumbtack and Google chat into one thread per customer.',
          ],
        },
      ],
    },
    {
      id: 'analytics',
      title: 'Analytics: knowing what really happened',
      blocks: [
        {
          kind: 'p',
          text: 'An answered call is not necessarily a good call. Analytics are there to show outcomes and quality, so you can improve your setup based on evidence.',
        },
        {
          kind: 'list',
          items: [
            'Call Analytics shows volume, outcomes, lead scores and booking rates.',
            'Sentiment Scoring rates every call and raises alerts on negative interactions.',
            'Call QA grades sampled calls on professionalism, empathy and accuracy.',
          ],
        },
        {
          kind: 'callout',
          title: 'Use QA to tune your setup',
          text: 'When a sampled call scores poorly, check the knowledge base and escalation rules first. Most weak calls trace back to missing business information rather than to the conversation itself.',
        },
      ],
    },
    {
      id: 'operations',
      title: 'Operations: what happens behind the call',
      blocks: [
        {
          kind: 'p',
          text: 'Larger teams need more than a receptionist. Operations features cover assigning the right technician, making sure the truck has the part, and running more than one location without mixing the data.',
        },
        {
          kind: 'list',
          items: [
            'Multi-Location gives each location its own workspace, technician roster and isolated analytics.',
            'Dynamic Dispatch matches a technician by skill, truck stock and live GPS.',
            'Parts Intelligence checks truck inventory before dispatch and can reorder missing parts.',
          ],
        },
      ],
    },
    {
      id: 'automation',
      title: 'Automation: the work nobody remembers to do',
      blocks: [
        {
          kind: 'p',
          text: 'Follow-up is where small businesses lose the most money and the least visibly. Automation features exist so that the follow-up happens even in a busy week.',
        },
        {
          kind: 'list',
          items: [
            'Follow-Up Engine nudges quotes that have gone quiet by email and SMS.',
            'Review Generation sends a review link after a job is completed.',
            'Abandoned Call Recovery texts a caller who hung up or was missed, with an invitation to book.',
          ],
        },
      ],
    },
    {
      id: 'switch-on-order',
      title: 'A sensible order to switch things on',
      blocks: [
        {
          kind: 'steps',
          items: [
            { title: 'Answering, summaries and escalation rules', text: 'Get the front door right and confirm the summaries match what you would have heard.' },
            { title: 'Booking and calendar sync', text: 'Connect your calendar and confirm that real availability is offered.' },
            { title: 'Text confirmations and missed-call text-back', text: 'Add messaging once you are confident in bookings and have consent practices in place.' },
            { title: 'CRM sync', text: 'Connect your field-service tool so the data flows where your team works.' },
            { title: 'Analytics and QA review', text: 'Use outcomes and quality scores to refine your knowledge base.' },
            { title: 'Dispatch, parts and automation', text: 'Add operations and follow-up features as your volume and team size justify them.' },
          ],
        },
        {
          kind: 'p',
          text: 'Some features depend on your plan. The pricing page lists what each plan includes.',
        },
      ],
    },
  ],
  faqs: [
    {
      q: 'Do I need every feature?',
      a: 'No. Most businesses begin with answering, booking and summaries and add the rest as they grow. Each group works on its own.',
    },
    {
      q: 'Which features depend on my plan?',
      a: 'Live escalation, dispatch, CRM syncs, accounting syncs and multi-location features vary by plan. The pricing page is the up-to-date list.',
    },
    {
      q: 'How does a feature get new information about my business?',
      a: 'Through your business profile and knowledge base. Updates are pushed into what Sarah knows, so changes to hours or services apply to later calls.',
    },
  ],
};
