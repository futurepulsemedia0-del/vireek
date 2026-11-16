import type { DeepContentData } from './types';

export const ENTERPRISE_DEEP: DeepContentData = {
  eyebrow: 'Evaluating for a larger rollout',
  title: 'How to run a multi-location evaluation without surprises',
  intro:
    'Rolling out across several locations adds questions a single-site purchase never faces: who approves it, what the contract must say and how you will know it works. This guide gives a structure for the evaluation, and lists what to put in writing.',
  related: [
    { label: 'Security', href: '/security' },
    { label: 'Trust Center', href: '/trust' },
    { label: 'Platform', href: '/platform' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'Book a demo', href: '/demo' },
  ],
  sections: [
    {
      id: 'stakeholders',
      title: 'Who usually needs what',
      blocks: [
        {
          kind: 'table',
          caption: 'Typical stakeholders',
          headers: ['Role', 'What they usually need to see'],
          rows: [
            ['Operations leader', 'Evidence the call handling works on real calls across locations'],
            ['Finance', 'A clear pricing structure and how usage and licences are billed'],
            ['IT or security', 'The security overview, the sub-processor list and how access is controlled'],
            ['Legal or procurement', 'The agreement, the data processing terms and the service level terms'],
            ['Location managers', 'How it changes their daily work, and who to call for help'],
          ],
        },
      ],
    },
    {
      id: 'pilot',
      title: 'A pilot that actually tells you something',
      blocks: [
        {
          kind: 'steps',
          items: [
            { title: 'Choose one or two representative locations', text: 'Pick sites that reflect your real call mix, not only the easiest ones.' },
            { title: 'Define success before you start', text: 'Agree the measures in advance, such as answered calls, bookings and the quality of summaries.' },
            { title: 'Write the escalation rules together', text: 'Each location should confirm what counts as urgent and who is on call.' },
            { title: 'Review weekly', text: 'Read summaries, fix knowledge-base gaps and record what changed.' },
            { title: 'Decide with evidence', text: 'Compare results with the success measures, then decide on a wider rollout.' },
          ],
        },
      ],
    },
    {
      id: 'in-writing',
      title: 'What to put in writing',
      blocks: [
        {
          kind: 'p',
          text: 'The enterprise options described on this page, such as per-location licensing, custom seats, a written service level, dedicated infrastructure options and a custom voice, are only as good as the contract that records them. Ask for the specifics in writing rather than relying on a description.',
        },
        {
          kind: 'list',
          items: [
            'The exact scope of each licence and how locations are added or removed.',
            'The service level terms and the remedies if they are missed.',
            'The data processing terms and the list of sub-processors, including how changes are notified.',
            'How data is exported and deleted if you leave.',
            'Support channels and expected response times.',
            'Which features depend on the plan and which are custom work.',
          ],
        },
      ],
    },
    {
      id: 'rollout',
      title: 'Rolling out in waves',
      blocks: [
        {
          kind: 'list',
          items: [
            'Start with locations that have clear owners and cooperative managers.',
            'Keep a short list of lessons from each wave and apply them to the next.',
            'Standardise what should be common, such as greetings and escalation structure, and allow local differences where the work genuinely differs.',
            'Keep a named contact for each location who can change the knowledge base.',
          ],
        },
      ],
    },
    {
      id: 'risks',
      title: 'Risks to plan for',
      blocks: [
        {
          kind: 'list',
          items: [
            'Out-of-date location information, such as hours and service areas, which leads to wrong answers.',
            'Unclear ownership, so nobody updates the setup when something changes.',
            'On-call chains that are not tested before go-live.',
            'Expecting results that depend on staffing, which no call handling can create.',
          ],
        },
      ],
    },
  ],
  faqs: [
    { q: 'Can we pilot at one location first?', a: 'That is the approach we suggest, because it shows how the setup behaves on your real calls before you commit more widely.' },
    { q: 'Where do I find the security and legal documents?', a: 'The Trust Center links to them, and the enterprise team can supply current versions.' },
    { q: 'Who owns the setup after go-live?', a: 'You should name an owner at each location and a central owner, so changes do not fall between roles.' },
  ],
};

export const PRICING_DEEP: DeepContentData = {
  eyebrow: 'Choosing a plan',
  title: 'How to pick a plan without overbuying or running short',
  intro:
    'The prices and limits on this page are the source of truth, and we avoid repeating them here so there is only one version to keep accurate. What follows is a method for deciding which plan fits, and for noticing the costs that sit outside the plan.',
  related: [
    { label: 'ROI calculator', href: '/calculator' },
    { label: 'Features', href: '/features' },
    { label: 'Enterprise', href: '/enterprise' },
    { label: 'Book a demo', href: '/demo' },
  ],
  sections: [
    {
      id: 'method',
      title: 'A simple way to choose',
      blocks: [
        {
          kind: 'steps',
          items: [
            { title: 'Estimate your monthly minutes', text: 'Multiply your calls in a typical week by the average call length in minutes, then by about four for a month. Round up for busy seasons.' },
            { title: 'Compare with the included amount', text: 'Look at how many minutes each plan includes, and what happens beyond that.' },
            { title: 'List the features you must have', text: 'Check which plans include them, rather than choosing on price alone.' },
            { title: 'Start with the Trial', text: 'Use the Trial to hear Sarah handle your calls before you commit to a paid plan.' },
            { title: 'Revisit after a month', text: 'Use your real usage to confirm the plan still fits.' },
          ],
        },
      ],
    },
    {
      id: 'differences',
      title: 'What really differs between plans',
      blocks: [
        {
          kind: 'table',
          caption: 'Dimensions to compare',
          headers: ['Dimension', 'Why it matters'],
          rows: [
            ['Included minutes', 'Decides how much usage the base price covers'],
            ['Overage rate', 'Decides the cost of a busy month'],
            ['Emergency handling and live dispatch', 'Included on Professional and above, which matters if urgent calls are common'],
            ['After-hours routing', '24/7 answering is on every plan, while custom after-hours routing is on Professional and above'],
            ['Integrations and operations features', 'Vary by plan, so check the feature list for the ones you rely on'],
            ['Locations and seats', 'Matter once more than one site or team uses it'],
          ],
        },
      ],
    },
    {
      id: 'outside-plan',
      title: 'Costs to check outside the plan',
      blocks: [
        {
          kind: 'list',
          items: [
            'Charges from your own phone carrier for forwarding calls, which depend on your carrier and plan.',
            'Fees for tools you connect, such as a field-service system or messaging provider.',
            'The staff time to set up and review the first weeks.',
            'Any usage beyond included minutes in a busy season.',
          ],
        },
      ],
    },
    {
      id: 'value',
      title: 'Thinking about value honestly',
      blocks: [
        {
          kind: 'p',
          text: 'The right comparison is not the plan price against zero. It is the plan price against what you lose today and what you would otherwise spend to cover the phone. Use your own numbers for missed calls, job value and conversion, and be conservative.',
        },
        {
          kind: 'callout',
          title: 'No savings claims here',
          text: 'We do not quote savings figures, because they depend entirely on your call volume, job value and follow-up. The calculator lets you test your own numbers.',
        },
      ],
    },
    {
      id: 'moving',
      title: 'Changing plans later',
      blocks: [
        {
          kind: 'p',
          text: 'Usage changes with seasons and growth. The billing and cancellation policy explains how changes and cancellations work, so read it before you commit if flexibility matters to you.',
        },
      ],
    },
  ],
  faqs: [
    { q: 'Which plan should a solo operator start with?', a: 'Use the Trial first, then choose the smallest paid plan that covers your estimated minutes and the features you need.' },
    { q: 'What happens if I go over my included minutes?', a: 'Plans with an overage rate charge for usage beyond the included amount. The plan details on this page show the current terms.' },
    { q: 'Are there costs not shown here?', a: 'Possibly, such as your carrier’s forwarding charges or fees for connected tools, so check those separately.' },
  ],
};
