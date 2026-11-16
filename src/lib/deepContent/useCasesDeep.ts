import type { DeepContentData } from './types';

const RELATED_USE_CASES = [
  { label: 'Features', href: '/features' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'ROI calculator', href: '/calculator' },
  { label: 'All industries', href: '/industries' },
];

export const USE_CASE_DEEP: Record<string, DeepContentData> = {
  'missed-calls': {
    eyebrow: 'Missed calls in depth',
    title: 'Why calls get missed, and how to recover the ones that matter',
    intro:
      'Every home-service business misses calls. The goal is not to reach zero, which is unrealistic, but to make sure a missed call becomes a recovered lead instead of a lost one. This guide breaks down why calls are missed, what recovery layers exist and how to tell whether they are working.',
    related: [...RELATED_USE_CASES, { label: 'After-hours coverage', href: '/use-cases/after-hours' }],
    sections: [
      {
        id: 'causes',
        title: 'Why calls are missed',
        blocks: [
          {
            kind: 'p',
            text: 'Missed calls cluster around a small number of causes, and each one needs a slightly different answer. Knowing which applies to you tells you where to start.',
          },
          {
            kind: 'table',
            caption: 'Common causes of missed calls',
            headers: ['Cause', 'When it happens', 'What helps'],
            rows: [
              ['Everyone is on a job', 'Mid-morning and afternoon peaks', 'Answering while the team works, then a summary afterwards'],
              ['A second call arrives while on the first', 'Busy periods and storms', 'Answering several calls at once without a queue'],
              ['After hours and weekends', 'Evenings, weekends and holidays', 'Round-the-clock answering with clear urgency rules'],
              ['Breaks and lunch', 'Predictable gaps in the day', 'Overflow routing when no one picks up'],
              ['Caller hangs up before anyone answers', 'Any time the phone rings too long', 'A follow-up text that invites the caller to book'],
            ],
          },
        ],
      },
      {
        id: 'layers',
        title: 'The recovery layers',
        blocks: [
          {
            kind: 'p',
            text: 'Recovery works best as layers, because no single step catches everything. Each layer assumes the previous one did not fully work.',
          },
          {
            kind: 'steps',
            items: [
              { title: 'Answer first', text: 'The best recovery is not needing one. When Sarah answers the call, the details are captured immediately and the caller never experiences a miss.' },
              { title: 'Text back immediately', text: 'If a call is still missed, a missed-call text-back goes out right away with a booking link, while the caller is still looking for a provider.' },
              { title: 'Recover the abandoned call', text: 'A later message, sent some minutes after the call, reaches callers who hung up without leaving anything and invites them to book.' },
              { title: 'Follow up on quotes and leads', text: 'Leads that did not book on the first contact are followed up by your team or by automation, depending on your plan.' },
            ],
          },
        ],
      },
      {
        id: 'measure',
        title: 'How to tell whether it is working',
        blocks: [
          {
            kind: 'list',
            items: [
              'Compare the number of calls received with the number answered, and look at the trend over several weeks rather than a single day.',
              'Check call outcomes in the analytics view to see how many calls ended in a booking, a captured lead or a message.',
              'Read a sample of call summaries to confirm the details captured are the ones your office actually needs.',
              'Track how many missed-call texts lead to a reply or a booking, remembering that many callers will not respond.',
            ],
          },
          {
            kind: 'callout',
            title: 'Be realistic about recovery',
            text: 'Some callers will have booked elsewhere before your text arrives, and some will never reply. Recovery narrows the gap. It does not close it.',
          },
        ],
      },
      {
        id: 'setup',
        title: 'Setting it up well',
        blocks: [
          {
            kind: 'list',
            items: [
              'Decide which calls Sarah answers directly and which only when your team does not pick up.',
              'Write the text-back message in your own voice, and keep it short and useful.',
              'Make sure the booking link points to real availability.',
              'Check your consent practices for messaging before enabling text-back, since rules vary by region.',
            ],
          },
        ],
      },
      {
        id: 'limits',
        title: 'Limits to know',
        blocks: [
          {
            kind: 'list',
            items: [
              'Text-back depends on being able to message the caller number, which is not possible for blocked or unsupported numbers.',
              'Recovery cannot help a caller who needs an immediate emergency response and has already called someone else.',
              'The quality of recovered leads depends on your follow-up. A booked slot nobody honours loses the lead anyway.',
            ],
          },
        ],
      },
    ],
    faqs: [
      { q: 'Should I answer everything with Sarah, or only overflow?', a: 'Many teams start with overflow and after-hours calls, review the summaries and then widen coverage once they trust the results.' },
      { q: 'Will a text-back annoy callers?', a: 'A short, useful message that offers a way to book is usually welcome, but wording and consent matter. Keep it brief and honour opt-outs.' },
      { q: 'How do I know the recovered calls are real leads?', a: 'Read the summaries and outcomes. Wrong numbers and spam are logged as calls, not leads.' },
    ],
  },

  'emergency-dispatch': {
    eyebrow: 'Emergency handling in depth',
    title: 'How urgent calls are recognised, routed and handed to a person',
    intro:
      'An emergency call is judged in the first minute, and delays matter. This guide explains how urgency is defined, how a flagged call reaches your team, and what you should configure and review so the process works when it counts.',
    related: [...RELATED_USE_CASES, { label: 'Missed calls', href: '/use-cases/missed-calls' }],
    sections: [
      {
        id: 'define',
        title: 'Start by defining what counts as an emergency',
        blocks: [
          {
            kind: 'p',
            text: 'There is no single definition. A no-heat call is an emergency in winter and routine in spring, and a leak is urgent only if water is flowing. The system follows your definition, so the first task is to write it down clearly.',
          },
          {
            kind: 'table',
            caption: 'Examples to adapt to your trade',
            headers: ['Trade', 'Examples treated as urgent', 'Examples treated as routine'],
            rows: [
              ['HVAC', 'No heat in cold weather, burning smell from equipment', 'Tune-ups, filter questions'],
              ['Plumbing', 'Burst pipe, sewage backup', 'Dripping faucet, slow drain'],
              ['Electrical', 'Sparks, smoke, a hot panel', 'Outlet replacement, lighting'],
              ['Restoration', 'Active water intrusion, fire damage', 'Mould inspection with no active source'],
            ],
          },
        ],
      },
      {
        id: 'path',
        title: 'What happens when a call is flagged',
        blocks: [
          {
            kind: 'steps',
            items: [
              { title: 'Recognise', text: 'Sarah listens for the signals you defined and treats the call as urgent when they appear.' },
              { title: 'Capture', text: 'She collects the caller’s name, number, address and the key facts about the problem before anything else is lost.' },
              { title: 'Route', text: 'The call is routed to the contacts or on-call staff you set. On plans that include live escalation, a person can be brought into the call as a warm transfer with context.' },
              { title: 'Confirm', text: 'The caller is told what will happen next, according to what your system can support, rather than being given promises the team cannot keep.' },
              { title: 'Record', text: 'The summary and urgency classification are saved so you can review what happened afterwards.' },
            ],
          },
          {
            kind: 'callout',
            title: 'Plan note and limits',
            text: 'Emergency detection and live dispatch are included on Professional and above. Sarah flags and routes urgent calls. She does not replace 911 or any emergency service.',
          },
        ],
      },
      {
        id: 'on-call',
        title: 'Designing the on-call chain',
        blocks: [
          {
            kind: 'list',
            items: [
              'Name a primary contact and at least one fallback for each time window.',
              'Keep the contact list current, because a stale number defeats the whole process.',
              'Decide how long a contact has to respond before the next person is tried.',
              'Make sure the people on the list know they are on it and what a flagged call looks like.',
            ],
          },
        ],
      },
      {
        id: 'review',
        title: 'Reviewing the process',
        blocks: [
          {
            kind: 'p',
            text: 'Treat the first weeks as a test. Read every urgent call summary and ask three questions: was it really urgent, did the right person get it, and was the caller told something accurate.',
          },
          {
            kind: 'list',
            items: [
              'Too many false alarms means the urgency rules are too broad.',
              'A missed real emergency means they are too narrow, or the wording of a signal is missing.',
              'Slow response points to the on-call chain rather than to the call handling.',
            ],
          },
        ],
      },
      {
        id: 'limits',
        title: 'What this does not do',
        blocks: [
          {
            kind: 'list',
            items: [
              'It does not provide emergency response. Callers in immediate danger should contact local emergency services.',
              'It does not diagnose the problem remotely.',
              'It cannot dispatch a technician who is not available. Response time still depends on your staffing.',
            ],
          },
        ],
      },
    ],
    faqs: [
      { q: 'Can I change what counts as urgent?', a: 'Yes. The rules are yours, and you can adjust them after reviewing real calls.' },
      { q: 'What if nobody on the list answers?', a: 'That is why a fallback contact and a review of response times matter. Test the chain before relying on it.' },
      { q: 'Does she give safety instructions?', a: 'Only what you have approved in your knowledge base. For immediate danger the caller is directed to emergency services.' },
    ],
  },

  'after-hours': {
    eyebrow: 'After-hours coverage in depth',
    title: 'Designing your after-hours coverage so nothing urgent slips through',
    intro:
      'After hours is where many businesses lose their highest-value calls, and it is also where the right policy depends most on your own situation. This guide shows the choices available and how to pick among them.',
    related: [...RELATED_USE_CASES, { label: 'Emergency dispatch', href: '/use-cases/emergency-dispatch' }],
    sections: [
      {
        id: 'windows',
        title: 'What “after hours” really means',
        blocks: [
          {
            kind: 'table',
            caption: 'Time windows to plan for',
            headers: ['Window', 'Typical call profile', 'Planning question'],
            rows: [
              ['Evenings', 'Urgent problems found after work', 'Who is on call, and until when?'],
              ['Overnight', 'True emergencies only', 'Which calls justify waking someone?'],
              ['Weekends', 'Mix of urgent and routine requests', 'Do you book weekend visits or queue for Monday?'],
              ['Holidays', 'Fewer calls, often high urgency', 'Is there a holiday on-call arrangement?'],
              ['Lunch and short gaps', 'Normal daytime calls', 'Should unanswered calls roll over to Sarah?'],
            ],
          },
        ],
      },
      {
        id: 'policies',
        title: 'Three policies to choose from',
        blocks: [
          {
            kind: 'steps',
            items: [
              { title: 'Answer and book for the next business day', text: 'Sarah captures the lead and books a daytime slot. This suits businesses that do not offer after-hours service.' },
              { title: 'Answer, sort and flag the urgent', text: 'Routine calls are booked or queued, while calls that match your urgency rules are flagged to the on-call contact.' },
              { title: 'Answer and transfer', text: 'Urgent calls are transferred to an on-call person as a warm handoff, where your plan includes live escalation.' },
            ],
          },
          {
            kind: 'callout',
            title: 'Plan note',
            text: '24/7 AI call answering is on every plan. Custom after-hours routing is included on Professional and above.',
          },
        ],
      },
      {
        id: 'rules',
        title: 'Writing the rules',
        blocks: [
          {
            kind: 'list',
            items: [
              'State your hours clearly so callers are told the truth about when someone will respond.',
              'List the situations that justify an overnight alert, and keep that list short.',
              'Decide what routine callers are told about timing, and make sure the promise is one you can keep.',
              'Set a fallback contact, since a single on-call person is a single point of failure.',
            ],
          },
        ],
      },
      {
        id: 'morning',
        title: 'The morning handoff',
        blocks: [
          {
            kind: 'p',
            text: 'The value of after-hours coverage is realised in the morning. Your team should open the dashboard to a clear list of what came in, which items were urgent and what has already been booked.',
          },
          {
            kind: 'list',
            items: [
              'Call summaries grouped by urgency.',
              'Bookings already placed on the calendar.',
              'Leads waiting for a callback, with the details already captured.',
            ],
          },
        ],
      },
      {
        id: 'limits',
        title: 'Limits to know',
        blocks: [
          {
            kind: 'list',
            items: [
              'Coverage depends on the people you name. Answering at night does not create technicians.',
              'Overpromising response times is the most common mistake, so state only what you can deliver.',
              'Sarah is not an emergency service. Callers in immediate danger should contact local emergency services.',
            ],
          },
        ],
      },
    ],
    faqs: [
      { q: 'Do I have to offer emergency service to use after-hours coverage?', a: 'No. You can choose the simplest policy, which answers and books for the next business day.' },
      { q: 'Can the policy differ by day?', a: 'Plans with custom after-hours routing let you set different behaviour for different times.' },
      { q: 'What do callers hear about timing?', a: 'What you configure. Keep it accurate to avoid disappointed callers.' },
    ],
  },

  'estimate-follow-up': {
    eyebrow: 'Estimate follow-up in depth',
    title: 'Why quotes go quiet, and how to follow up without being pushy',
    intro:
      'Many quotes are not rejected. They are simply forgotten while the customer gets on with life. A short, well-timed follow-up often decides whether the job is won. This guide explains how to design one that is helpful rather than pushy.',
    related: [...RELATED_USE_CASES, { label: 'Missed calls', href: '/use-cases/missed-calls' }],
    sections: [
      {
        id: 'why-quiet',
        title: 'Why quotes go quiet',
        blocks: [
          {
            kind: 'list',
            items: [
              'The customer is comparing several quotes and has not decided.',
              'A question came up and nobody answered it.',
              'The quote was sent and then buried in a busy inbox.',
              'Your team meant to follow up and the week got away from them.',
            ],
          },
        ],
      },
      {
        id: 'sequence',
        title: 'Designing a sequence',
        blocks: [
          {
            kind: 'p',
            text: 'The follow-up engine can nudge quotes that have gone quiet, for example after a few days, by email and SMS. The timing and number of messages are decisions you should make deliberately.',
          },
          {
            kind: 'steps',
            items: [
              { title: 'Send the quote promptly', text: 'Speed on the first quote sets the tone. A slow quote is already a weak start.' },
              { title: 'Nudge once when it goes quiet', text: 'A friendly message after a few quiet days checks whether the customer has questions.' },
              { title: 'Offer a clear next step', text: 'Make it easy to accept, ask a question or request a call.' },
              { title: 'Know when to stop', text: 'After a small number of attempts, a quote should rest. More contact becomes pressure.' },
            ],
          },
        ],
      },
      {
        id: 'message',
        title: 'What a good nudge contains',
        blocks: [
          {
            kind: 'list',
            items: [
              'The job in plain words, so the message makes sense on its own.',
              'An open question, such as whether anything in the quote needs clarifying.',
              'A single simple action, such as replying or booking a call.',
              'A tone that sounds like your business, not a template.',
            ],
          },
        ],
      },
      {
        id: 'measure',
        title: 'Measuring results',
        blocks: [
          {
            kind: 'p',
            text: 'Track how many quotes receive a reply after a nudge, how many convert, and how many ask to stop. A high opt-out rate means the messages are too frequent or too generic.',
          },
        ],
      },
      {
        id: 'limits',
        title: 'Limits and care',
        blocks: [
          {
            kind: 'list',
            items: [
              'Follow-up messages need the right consent for the channels you use, and rules vary by region.',
              'Automation cannot fix an uncompetitive quote or slow service.',
              'Respect opt-outs immediately.',
            ],
          },
        ],
      },
    ],
    faqs: [
      { q: 'How many follow-ups are too many?', a: 'Few. One or two well-timed messages are usually appropriate. Beyond that, the risk of annoying the customer rises.' },
      { q: 'Can I edit the messages?', a: 'You should, so they sound like your business and reflect the job.' },
      { q: 'Does this work for large projects?', a: 'It can, but large projects often benefit from a personal call from your estimator in addition.' },
    ],
  },
};
