import type { DeepContentData } from './types';

const R = [
  { label: 'All resources', href: '/resources' },
  { label: 'ROI calculator', href: '/calculator' },
  { label: 'Pricing', href: '/pricing' },
];

export const RESOURCE_DEEP: Record<string, DeepContentData> = {
  'missed-call-revenue-calculator': {
    eyebrow: 'Using the calculator well',
    title: 'How to get a realistic number from the missed-call calculator',
    intro:
      'A calculator returns whatever you put into it, so the inputs matter more than the arithmetic. This guide explains where to find honest inputs, how to read the result and how to avoid fooling yourself.',
    related: [...R, { label: 'Missed calls', href: '/use-cases/missed-calls' }],
    sections: [
      {
        id: 'inputs',
        title: 'Finding honest inputs',
        blocks: [
          {
            kind: 'list',
            items: [
              'Missed calls: check your phone carrier’s call log for a few typical weeks and count the unanswered inbound calls, excluding obvious spam.',
              'Share that are real customers: sample a handful of missed numbers by calling back, and see how many were genuine enquiries.',
              'Average job value: use your actual average from recent invoices, not your best job.',
              'Close rate: use the share of enquiries you really convert today, not an aspiration.',
            ],
          },
          {
            kind: 'callout',
            title: 'Use conservative numbers',
            text: 'If you are unsure, pick the lower figure. A cautious estimate you believe is more useful than an impressive one you do not.',
          },
        ],
      },
      {
        id: 'reading',
        title: 'Reading the result',
        blocks: [
          {
            kind: 'p',
            text: 'The result is an estimate of work that may be going elsewhere. It is not a forecast of what you will recover. Some callers will have called a competitor already, some would never have booked, and some will be won back only with good follow-up.',
          },
          {
            kind: 'steps',
            items: [
              { title: 'Run a cautious case', text: 'Use the lower values for every input.' },
              { title: 'Run a likely case', text: 'Use your best honest estimates.' },
              { title: 'Compare both with the plan cost', text: 'If even the cautious case clearly exceeds the cost, the decision is easier. If only the optimistic case does, be careful.' },
            ],
          },
        ],
      },
      {
        id: 'pitfalls',
        title: 'Common mistakes',
        blocks: [
          {
            kind: 'list',
            items: [
              'Counting every missed call as a lost job, including wrong numbers and repeat attempts from the same person.',
              'Using revenue instead of the margin you actually keep.',
              'Ignoring the time you spend today returning missed calls.',
              'Forgetting that recovery depends on your follow-up, not only on answering.',
            ],
          },
        ],
      },
      {
        id: 'next',
        title: 'What to do with the number',
        blocks: [
          {
            kind: 'p',
            text: 'Treat the figure as a reason to test, not as proof. Try answering or recovering calls for a few weeks, then measure how many extra bookings really arrived and compare that with your estimate.',
          },
        ],
      },
    ],
    faqs: [
      { q: 'Is the result a promise of savings?', a: 'No. It is an estimate based on your inputs, and real results depend on your calls and follow-up.' },
      { q: 'How often should I rerun it?', a: 'Whenever your call volume or average job value changes noticeably, and after a few weeks of real data.' },
    ],
  },

  'estimate-follow-up-roi-calculator': {
    eyebrow: 'Using the calculator well',
    title: 'How to estimate the value of following up on quotes',
    intro:
      'Quotes that go quiet are hard to see, because nothing records the job you did not win. This guide shows how to find your real numbers and read the result without overstating it.',
    related: [...R, { label: 'Estimate follow-up', href: '/use-cases/estimate-follow-up' }],
    sections: [
      {
        id: 'inputs',
        title: 'Where the inputs come from',
        blocks: [
          {
            kind: 'list',
            items: [
              'Quotes sent: count estimates issued in a typical month from your quoting or invoicing system.',
              'Quotes accepted: count how many of those became jobs, to get your current win rate.',
              'Quotes with no response: estimate how many never received any answer, accepted or declined.',
              'Average job value: use a recent average from completed work.',
            ],
          },
        ],
      },
      {
        id: 'interpreting',
        title: 'Interpreting the result',
        blocks: [
          {
            kind: 'p',
            text: 'The key assumption is how many silent quotes a follow-up could convert. That share is uncertain, so test it with a small, cautious value. Many quotes are silent because the customer chose someone else, and no message changes that.',
          },
          {
            kind: 'table',
            caption: 'Ways to stress-test the estimate',
            headers: ['Change', 'Why try it'],
            rows: [
              ['Halve the assumed conversion of silent quotes', 'Shows whether the case still holds with a cautious view'],
              ['Use lower job value', 'Protects against one large job skewing the average'],
              ['Include the staff time follow-up requires', 'Checks the true cost of doing it manually'],
            ],
          },
        ],
      },
      {
        id: 'practice',
        title: 'Turning it into practice',
        blocks: [
          {
            kind: 'steps',
            items: [
              { title: 'Pick a starting point', text: 'Begin with quotes that are a few days old and still unanswered.' },
              { title: 'Send one helpful message', text: 'Reference the job and offer a clear next step.' },
              { title: 'Measure replies and bookings', text: 'Compare against the quotes you did not follow up on.' },
              { title: 'Adjust the timing and wording', text: 'Small changes often matter more than adding messages.' },
            ],
          },
        ],
      },
      {
        id: 'limits',
        title: 'Limits',
        blocks: [
          {
            kind: 'list',
            items: [
              'The calculator cannot know why a customer went quiet.',
              'Follow-up does not help an uncompetitive quote.',
              'Messaging needs the right consent in your region.',
            ],
          },
        ],
      },
    ],
    faqs: [
      { q: 'What is a reasonable conversion assumption?', a: 'Use a small, cautious number and replace it with your own measured result after a trial.' },
      { q: 'Does the estimate include staff time?', a: 'Consider it separately, since manual follow-up costs time that automation can save.' },
    ],
  },

  'missed-call-text-back-scripts': {
    eyebrow: 'Using the scripts well',
    title: 'Adapting text-back scripts so they sound like your business',
    intro:
      'A text sent to someone who just tried to reach you is a rare chance to make a good impression. These notes explain what makes such a message work and how to adapt the template rather than send it unchanged.',
    related: [...R, { label: 'Missed calls', href: '/use-cases/missed-calls' }],
    sections: [
      {
        id: 'principles',
        title: 'What a good text-back does',
        blocks: [
          {
            kind: 'list',
            items: [
              'It arrives quickly, while the caller is still looking for help.',
              'It says who you are, so the caller recognises the number.',
              'It acknowledges the missed call without making excuses.',
              'It offers one clear next step, such as replying or choosing a time.',
              'It is short enough to read in a few seconds.',
            ],
          },
        ],
      },
      {
        id: 'adapting',
        title: 'Adapting a template',
        blocks: [
          {
            kind: 'steps',
            items: [
              { title: 'Use your business name', text: 'Replace generic wording so the message is clearly from you.' },
              { title: 'Match your tone', text: 'A friendly neighbourhood firm and a formal commercial contractor should not sound alike.' },
              { title: 'Offer real availability', text: 'Point to a booking link or reply option that actually works.' },
              { title: 'Read it as the caller', text: 'Check it makes sense from someone who knows nothing about your process.' },
            ],
          },
        ],
      },
      {
        id: 'timing',
        title: 'Timing and consent',
        blocks: [
          {
            kind: 'p',
            text: 'Speed matters, but so does permission. Rules about contacting people by text vary by country and region, so check what applies to you, include a way to opt out and honour opt-outs immediately.',
          },
          {
            kind: 'callout',
            title: 'Keep a human in the loop',
            text: 'If a caller replies with something urgent, make sure a person sees it quickly. An automatic text is a first step, not a replacement for a response.',
          },
        ],
      },
      {
        id: 'avoid',
        title: 'What to avoid',
        blocks: [
          {
            kind: 'list',
            items: [
              'Long messages with several links.',
              'Promises of response times you cannot keep.',
              'Sending the same message repeatedly to someone who has not replied.',
              'Using urgent language when the call was routine.',
            ],
          },
        ],
      },
    ],
    faqs: [
      { q: 'Should I change the template?', a: 'Yes. A message that sounds like your business performs better than one that sounds generic.' },
      { q: 'Can I test two versions?', a: 'Yes. Compare reply rates for each over a few weeks before settling on one.' },
    ],
  },

  'new-call-intake-checklist': {
    eyebrow: 'Using the checklist well',
    title: 'Why each intake question exists, and how to train your team on it',
    intro:
      'An intake checklist works only when the people using it understand why each item is there. This guide explains the reasoning behind the questions and how to apply them without making callers feel interrogated.',
    related: [...R, { label: 'Features', href: '/features' }],
    sections: [
      {
        id: 'purpose',
        title: 'What the checklist is for',
        blocks: [
          {
            kind: 'p',
            text: 'The goal is to collect the minimum information that lets the next person act without calling back. Every extra question costs the caller patience, so the list should contain only what changes the job, the schedule or the price.',
          },
        ],
      },
      {
        id: 'fields',
        title: 'The reasoning behind the fields',
        blocks: [
          {
            kind: 'table',
            caption: 'Why each field matters',
            headers: ['Information', 'Why it is collected'],
            rows: [
              ['Name and phone number', 'So someone can call back, and so repeat customers can be recognised'],
              ['Service address', 'Decides whether you can serve the location and how to schedule travel'],
              ['What is wrong', 'Decides the type of visit and the skills needed'],
              ['How long and how bad', 'Separates urgent problems from routine ones'],
              ['Equipment or property details', 'Lets the technician prepare parts and expectations'],
              ['Preferred timing and access', 'Avoids a wasted trip'],
            ],
          },
        ],
      },
      {
        id: 'training',
        title: 'Training your team',
        blocks: [
          {
            kind: 'steps',
            items: [
              { title: 'Explain the why', text: 'People follow a checklist better when they know what each question prevents.' },
              { title: 'Role-play a few calls', text: 'Practise a routine call and an urgent one.' },
              { title: 'Review real calls together', text: 'Look for questions that were skipped or that confused callers.' },
              { title: 'Trim regularly', text: 'Remove questions that never change what you do.' },
            ],
          },
        ],
      },
      {
        id: 'ai',
        title: 'Using the same list with an AI receptionist',
        blocks: [
          {
            kind: 'p',
            text: 'The same checklist can define what an AI receptionist asks. Write the questions you actually need, in the order you want them, and review summaries to see which answers are missing.',
          },
        ],
      },
    ],
    faqs: [
      { q: 'How long should an intake call take?', a: 'As short as the needed information allows. If it feels long, remove questions that do not change the job.' },
      { q: 'Should the checklist differ by trade?', a: 'Yes. The urgent signals and the equipment details are different for each trade.' },
    ],
  },

  'estimate-follow-up-sequence': {
    eyebrow: 'Using the sequence well',
    title: 'The thinking behind a three-touch estimate follow-up',
    intro:
      'The template sequence uses a message around day three, another around day seven and a polite close around day fourteen. This guide explains why that rhythm works, and when to change it.',
    related: [...R, { label: 'Estimate follow-up', href: '/use-cases/estimate-follow-up' }],
    sections: [
      {
        id: 'rhythm',
        title: 'Why this rhythm',
        blocks: [
          {
            kind: 'table',
            caption: 'The three touches',
            headers: ['Touch', 'Purpose'],
            rows: [
              ['Around day 3', 'Check the estimate arrived and invite questions'],
              ['Around day 7', 'Offer concrete availability to make saying yes easy'],
              ['Around day 14', 'Close the loop politely and leave the door open'],
            ],
          },
          {
            kind: 'p',
            text: 'The pattern moves from checking in, to making action easy, to closing gracefully. Each message asks for less pressure than the last, which keeps the tone respectful.',
          },
        ],
      },
      {
        id: 'changing',
        title: 'When to change it',
        blocks: [
          {
            kind: 'list',
            items: [
              'Shorten the gaps for urgent work, such as a repair the customer needs soon.',
              'Lengthen them for large projects where decisions take weeks.',
              'Skip a touch if the customer has already replied.',
              'Stop immediately when the customer books, declines or asks you to stop.',
            ],
          },
        ],
      },
      {
        id: 'writing',
        title: 'Writing each message',
        blocks: [
          {
            kind: 'list',
            items: [
              'Mention the specific job so the message never reads like a mass text.',
              'Offer a next step, such as a call or two possible dates, instead of only asking whether there are questions.',
              'Keep it short and in your own voice.',
              'Make it easy to decline, which builds trust.',
            ],
          },
        ],
      },
      {
        id: 'measure',
        title: 'Measuring and improving',
        blocks: [
          {
            kind: 'p',
            text: 'Track which touch produces replies and bookings, and how many people ask to stop. If most responses come after the first message, a third may add little. If many opt out, the messages are too frequent or too generic.',
          },
          {
            kind: 'callout',
            title: 'Consent still applies',
            text: 'Check the messaging rules that apply to you, and only contact people through channels they have agreed to.',
          },
        ],
      },
    ],
    faqs: [
      { q: 'Is three messages the right number?', a: 'It is a reasonable starting point. Adjust based on your job size and what your results show.' },
      { q: 'Should every quote receive all three?', a: 'No. Stop as soon as the customer responds, books or declines.' },
    ],
  },
};
