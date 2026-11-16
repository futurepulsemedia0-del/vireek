import type { DeepContentData } from './types';

export const PLATFORM_DEEP: DeepContentData = {
  eyebrow: 'Platform overview',
  title: 'How the platform is organised, and how to adopt it without disruption',
  intro:
    'Vireek began as an AI receptionist and has grown into a connected operating layer for home-service businesses. This page explains the layers, how data moves between them and a low-risk way to adopt them.',
  sections: [
    {
      id: 'layers',
      title: 'The layers, from the phone to the back office',
      blocks: [
        {
          kind: 'table',
          caption: 'Platform layers',
          headers: ['Layer', 'What it does', 'Examples'],
          rows: [
            ['Conversation', 'Answers and understands calls and messages', 'AI answering, intent detection, SMS, WhatsApp and Instagram DMs'],
            ['Capture and qualify', 'Turns conversations into structured records', 'Customer capture, lead qualification, deduplication'],
            ['Schedule and dispatch', 'Gets the right person to the right job', 'Booking, calendar sync, dispatch board, technician job board'],
            ['Money', 'Moves a job from quote to payment', 'Quotes, invoices, payments, memberships, service agreements'],
            ['Operations', 'Keeps field work running', 'Inventory and parts, multi-location, reports'],
            ['Intelligence', 'Shows what happened and why', 'Call analytics, sentiment, QA, outcome reporting'],
            ['Connect', 'Moves data to the tools you already use', 'CRM sync, accounting sync, webhooks, API'],
          ],
        },
        {
          kind: 'p',
          text: 'The layers are designed to share one customer and job record, so that a detail captured on a call is available to the dispatcher, the technician and the invoice without being typed again.',
        },
      ],
    },
    {
      id: 'data-flow',
      title: 'How data moves',
      blocks: [
        {
          kind: 'steps',
          items: [
            { title: 'Capture at the edge', text: 'Calls, texts and chats create or update a customer record.' },
            { title: 'Enrich and deduplicate', text: 'Repeat contacts are matched, so history accumulates in one place.' },
            { title: 'Act on the record', text: 'Booking, dispatch, quoting and follow-up all read the same record.' },
            { title: 'Sync outward', text: 'Changes are sent to connected CRM, accounting and calendar tools.' },
            { title: 'Measure', text: 'Outcomes feed analytics and quality reviews, which inform your next configuration changes.' },
          ],
        },
      ],
    },
    {
      id: 'automation-engines',
      title: 'How to think about automation engines',
      blocks: [
        {
          kind: 'p',
          text: 'The platform includes a large set of automation engines, each aimed at a specific operational problem such as follow-up, scheduling or recovery of missed revenue. You do not need to understand them all. The practical rule is to switch on the ones that map to a problem you can already name, and leave the rest.',
        },
        {
          kind: 'list',
          items: [
            'Pick a measurable problem first, such as missed after-hours calls or quotes that never get answered.',
            'Enable the engine that targets it and observe the outcome for a few weeks.',
            'Keep humans in the approval path wherever money or customer commitments are involved.',
          ],
        },
        {
          kind: 'callout',
          title: 'Automation is a tool, not a replacement for judgement',
          text: 'Automations follow your configuration. Review what they do regularly, especially after you change prices, hours or service areas.',
        },
      ],
    },
    {
      id: 'security-isolation',
      title: 'Data separation and access',
      blocks: [
        {
          kind: 'p',
          text: 'Each business has its own workspace, and multi-location accounts keep locations’ analytics separate. Access is role-based on plans that include it. Specific security measures and their current status are described on the security and trust pages, which are the authoritative source rather than this overview.',
        },
      ],
    },
    {
      id: 'adoption',
      title: 'A low-risk adoption path',
      blocks: [
        {
          kind: 'steps',
          items: [
            { title: 'Phase 1: answering', text: 'Route after-hours or overflow calls and review summaries for two weeks.' },
            { title: 'Phase 2: booking and messaging', text: 'Connect your calendar and enable confirmations and reminders.' },
            { title: 'Phase 3: connect your tools', text: 'Sync with your field-service or accounting system.' },
            { title: 'Phase 4: operations', text: 'Add dispatch, parts and multi-location features as your team grows.' },
            { title: 'Phase 5: optimise', text: 'Use analytics and QA to tune your knowledge base and rules.' },
          ],
        },
      ],
    },
    {
      id: 'integration-model',
      title: 'Integrations, API and webhooks',
      blocks: [
        {
          kind: 'p',
          text: 'Integrations vary by plan. Common connections include Google Calendar, ServiceTitan, Housecall Pro and Jobber, and accounting tools such as QuickBooks and Xero on plans that include them. For custom needs, developer documentation, an API reference and webhooks are available, with the extent depending on your plan.',
        },
      ],
    },
  ],
  faqs: [
    {
      q: 'Do I have to use the whole platform?',
      a: 'No. Each layer can be adopted on its own, and most teams start with answering and add more over time.',
    },
    {
      q: 'Can it replace my field-service software?',
      a: 'It can run alongside it through syncs, and some teams use more of Vireek’s own scheduling and job tools. The choice depends on your needs and plan.',
    },
  ],
};
