import type { DeepContentData } from './types';

const RELATED_SWITCH = [
  { label: 'All switching guides', href: '/switch' },
  { label: 'Compare tools', href: '/compare' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Features', href: '/features' },
];

export const SWITCH_GUIDE_DEEP: Record<string, DeepContentData> = {
  voicemail: {
    eyebrow: 'Switching from voicemail',
    title: 'Moving from voicemail to an AI receptionist without losing a call',
    intro:
      'Voicemail is the simplest thing to replace, because nothing has to be cancelled. The risk is not the switch itself. It is changing how calls are routed without testing first. This guide covers a careful way to do it.',
    related: RELATED_SWITCH,
    sections: [
      {
        id: 'what-changes',
        title: 'What actually changes',
        blocks: [
          {
            kind: 'p',
            text: 'With voicemail, a missed call ends in a recording that someone must listen to and return. With an AI receptionist, the call is answered, the details are captured and a next step is arranged during the call. The phone number your customers know does not need to change.',
          },
          {
            kind: 'table',
            caption: 'Before and after',
            headers: ['Aspect', 'Voicemail', 'AI receptionist'],
            rows: [
              ['Caller experience', 'A beep and a recording', 'A conversation with a defined next step'],
              ['Information captured', 'Whatever the caller chooses to say', 'The details your rules ask for'],
              ['Follow-up work', 'Listening and calling back', 'A summary, and often a booking already made'],
              ['Urgent calls', 'Wait until someone checks', 'Flagged to your on-call contacts by your rules'],
            ],
          },
        ],
      },
      {
        id: 'prepare',
        title: 'Prepare before you route anything',
        blocks: [
          {
            kind: 'list',
            items: [
              'Write down your services, hours and service area, since these become Sarah’s knowledge.',
              'Decide what counts as urgent and who should be alerted.',
              'Connect your calendar if you want bookings made during calls.',
              'Choose a greeting that sounds like your business.',
            ],
          },
        ],
      },
      {
        id: 'staged',
        title: 'A staged rollout',
        blocks: [
          {
            kind: 'steps',
            items: [
              { title: 'Test on a separate number', text: 'Call the new number yourself with typical scenarios, including an emergency and an out-of-area request.' },
              { title: 'Route only unanswered calls', text: 'Forward calls to Vireek when your phone is not answered, so your existing behaviour is untouched during busy hours.' },
              { title: 'Review for a week or two', text: 'Read summaries and fix gaps in your knowledge base.' },
              { title: 'Widen coverage', text: 'Extend to after-hours and busy periods once you are comfortable.' },
              { title: 'Keep a fallback', text: 'Retain voicemail as a backup in case forwarding is ever interrupted.' },
            ],
          },
        ],
      },
      {
        id: 'pitfalls',
        title: 'Common pitfalls',
        blocks: [
          {
            kind: 'list',
            items: [
              'Forwarding set up incorrectly, so calls ring twice or not at all. Test from another phone.',
              'An outdated knowledge base that gives callers wrong hours or services.',
              'No escalation rules, so urgent calls are treated like routine ones.',
              'Not telling your team, who then cannot find the call summaries.',
            ],
          },
        ],
      },
    ],
    faqs: [
      { q: 'Do I need a new phone number?', a: 'Not necessarily. Many businesses keep their number and set up forwarding. Details depend on your carrier, so confirm with them.' },
      { q: 'Can I keep voicemail as a backup?', a: 'Yes, and it is sensible to keep it as a fallback while you build confidence.' },
      { q: 'How long should I test before going fully live?', a: 'A week or two of reviewing real calls is a reasonable starting point.' },
    ],
  },

  'answering-service': {
    eyebrow: 'Switching from an answering service',
    title: 'Replacing a live answering service while keeping coverage continuous',
    intro:
      'A live answering service and an AI receptionist both sit behind call forwarding, which makes the technical change small. The real work is comparing handling quality and timing the cut-over so there is never an uncovered gap. This guide stays at process level, because each provider’s terms and settings differ and change.',
    related: RELATED_SWITCH,
    sections: [
      {
        id: 'compare-first',
        title: 'Compare handling before you decide',
        blocks: [
          {
            kind: 'p',
            text: 'The most reliable way to compare is to put the same scenarios through both. Your own call types will tell you more than any description.',
          },
          {
            kind: 'table',
            caption: 'Scenarios worth testing',
            headers: ['Scenario', 'What to look for'],
            rows: [
              ['An emergency call', 'Is urgency recognised, and does the right person get alerted?'],
              ['A new service request', 'Are the right trade questions asked and the details captured?'],
              ['A reschedule', 'Is the existing booking found and changed correctly?'],
              ['A price question', 'Does the caller hear accurate information, or an honest handoff?'],
              ['An out-of-area call', 'Is the caller handled politely and logged correctly?'],
            ],
          },
        ],
      },
      {
        id: 'contract',
        title: 'Check your current terms first',
        blocks: [
          {
            kind: 'p',
            text: 'Before changing anything, confirm your notice period and cancellation process directly with your current provider. Their account settings or support team are the accurate source, and terms vary.',
          },
        ],
      },
      {
        id: 'cutover',
        title: 'A cut-over without gaps',
        blocks: [
          {
            kind: 'steps',
            items: [
              { title: 'Build Vireek in parallel', text: 'Set up your profile, calendar and escalation rules while the current service keeps answering.' },
              { title: 'Run side-by-side tests', text: 'Send test and sample real calls to Sarah and compare results with what you are used to.' },
              { title: 'Re-point forwarding', text: 'Change the forwarding destination to the number Vireek provides, once you are confident.' },
              { title: 'Watch the first days closely', text: 'Review each summary and fix gaps quickly.' },
              { title: 'Cancel the old service', text: 'Cancel on your own terms, after Vireek is proven live.' },
            ],
          },
        ],
      },
      {
        id: 'human-factor',
        title: 'What you may miss, and what you gain',
        blocks: [
          {
            kind: 'list',
            items: [
              'A human agent may build rapport with repeat callers. Sarah builds context through call history instead, which takes time.',
              'Some callers will prefer a person, so keep a way to reach one for sensitive calls.',
              'In return, coverage does not depend on shift schedules, and details arrive as structured summaries.',
            ],
          },
        ],
      },
    ],
    faqs: [
      { q: 'Will I lose calls during the switch?', a: 'Not if you keep the old service live until Vireek is proven, then change forwarding.' },
      { q: 'Is an AI receptionist the same as a live service?', a: 'No. A live service relays calls using human agents. Sarah is software configured for your business, with escalation to your people when needed.' },
      { q: 'Should I run both for a while?', a: 'Yes. A short overlap is the safest approach, even though it costs a little extra.' },
    ],
  },

  'servicetitan-import': {
    eyebrow: 'Importing from ServiceTitan',
    title: 'Bringing your customer records into Vireek while keeping ServiceTitan',
    intro:
      'Most businesses that add Vireek keep ServiceTitan for dispatch, invoicing and reporting. The goal of an import is narrower: let Sarah recognise returning callers by loading your existing customer records. This guide explains how to prepare a clean file and what to check afterwards.',
    related: [...RELATED_SWITCH, { label: 'Integrations', href: '/integrations' }],
    sections: [
      {
        id: 'scope',
        title: 'What an import is, and is not',
        blocks: [
          {
            kind: 'p',
            text: 'An import loads a one-time snapshot of customer records. It does not replace ServiceTitan and it does not by itself keep the two systems in step afterwards.',
          },
          {
            kind: 'callout',
            title: 'Connection scope',
            text: 'The ServiceTitan connection in Vireek currently syncs your price book so Sarah quotes current prices. Job and customer sync is described as upcoming on the integration page, so check that page for the latest scope before planning around it.',
          },
        ],
      },
      {
        id: 'prepare',
        title: 'Preparing a clean file',
        blocks: [
          {
            kind: 'list',
            items: [
              'Export customers using ServiceTitan’s own export, typically a CSV. Menu locations change between updates, so use their help documentation if you cannot find it.',
              'Keep the fields Sarah needs to recognise a caller: name, phone number and service address.',
              'Remove billing and invoicing data you do not need in Vireek.',
              'Check phone numbers are in a consistent format, since matching depends on them.',
              'Remove obvious duplicates and test records before importing.',
            ],
          },
        ],
      },
      {
        id: 'import',
        title: 'Importing and checking',
        blocks: [
          {
            kind: 'steps',
            items: [
              { title: 'Import the file', text: 'Bring the export into your customer records in the dashboard.' },
              { title: 'Spot-check a sample', text: 'Open several records, including one with unusual formatting, and confirm names, numbers and addresses are correct.' },
              { title: 'Test recognition', text: 'Call from a number in the file and confirm the record is recognised.' },
              { title: 'Decide how new jobs flow back', text: 'Talk to the team about your ServiceTitan setup, so you know what is possible today and what would need custom work.' },
            ],
          },
        ],
      },
      {
        id: 'ongoing',
        title: 'Keeping data current',
        blocks: [
          {
            kind: 'p',
            text: 'A snapshot ages. If your customer list changes frequently, plan a periodic re-import or confirm what ongoing sync is available for your setup, rather than assuming the two systems stay aligned.',
          },
        ],
      },
    ],
    faqs: [
      { q: 'Does this replace ServiceTitan?', a: 'No. ServiceTitan continues to run dispatch, invoicing and reporting.' },
      { q: 'What if my export format is different?', a: 'Send it to the team and ask what will import cleanly before you try, rather than guessing at a format.' },
      { q: 'Do new customers from calls go back into ServiceTitan?', a: 'That depends on your setup and the current integration scope, so ask the team for a direct answer for your account.' },
    ],
  },
};
