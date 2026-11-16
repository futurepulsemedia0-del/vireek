import type { DeepContentData } from './types';

export const SERVICES_DEEP: DeepContentData = {
  eyebrow: 'In practice',
  title: 'What Sarah does on a real call, and where her limits are',
  intro:
    'The headline capabilities are easy to list. This section shows how they behave in situations contractors actually face, including the ones where a human should take over.',
  sections: [
    {
      id: 'call-types',
      title: 'How different calls are handled',
      blocks: [
        {
          kind: 'table',
          caption: 'Common call types and the intended handling',
          headers: ['Call type', 'What Sarah does', 'What you receive'],
          rows: [
            ['New service request', 'Asks trade questions, captures details, offers a booking slot', 'Booked appointment or queued lead, plus a summary'],
            ['Emergency', 'Recognises urgency signals and flags the call per your rules', 'Priority alert to the people you named'],
            ['Reschedule or cancel', 'Identifies the existing booking and offers new options', 'Updated calendar entry'],
            ['Existing job question', 'Captures the question and the job reference', 'A message for your team with context'],
            ['Quote follow-up', 'Takes the customer’s response and notes the next step', 'Updated lead status'],
            ['Wrong number or sales call', 'Ends politely without booking', 'A logged call, not a lead'],
          ],
        },
      ],
    },
    {
      id: 'trade-language',
      title: 'Why trade vocabulary matters',
      blocks: [
        {
          kind: 'p',
          text: 'Callers describe problems in their own words: “the unit is icing up”, “the toilet keeps running”, “a breaker keeps tripping”. A receptionist who needs those translated wastes time and loses trust. Sarah is set up with trade-specific terminology so she can ask the next sensible question instead of asking the caller to start over.',
        },
        {
          kind: 'list',
          items: [
            'She distinguishes routine requests from urgent ones using your definitions.',
            'She asks about equipment and symptoms that change how the job is scheduled.',
            'She uses your business’s service area, hours and services as stated in your knowledge base.',
          ],
        },
      ],
    },
    {
      id: 'emergencies',
      title: 'Emergencies: what is flagged, and what is not promised',
      blocks: [
        {
          kind: 'p',
          text: 'Urgent signals include active flooding, a gas smell, no heat in cold weather and live electrical hazards. When those appear, the call is flagged and routed to the contacts and on-call staff you configured, with the details she has gathered.',
        },
        {
          kind: 'callout',
          title: 'Important',
          text: 'Sarah is not an emergency service. If a caller describes immediate danger, the right instruction is to contact local emergency services. Vireek helps your business respond quickly to the call. It does not replace emergency response.',
        },
        {
          kind: 'p',
          text: 'Your escalation rules are the control. Review them before you route live calls, and revisit them after the first weeks of real use.',
        },
      ],
    },
    {
      id: 'booking-followup',
      title: 'Booking and follow-up in detail',
      blocks: [
        {
          kind: 'steps',
          items: [
            { title: 'Capture', text: 'Name, number, address and issue are recorded while the caller is on the line.' },
            { title: 'Offer', text: 'Where booking is enabled, Sarah offers openings from your real calendar rather than inventing times.' },
            { title: 'Confirm', text: 'The caller confirms a slot, and the booking is written to your calendar.' },
            { title: 'Notify', text: 'The customer can receive an SMS confirmation and your team receives the summary.' },
            { title: 'Remind and recover', text: 'Reminders reduce no-shows, and a missed or abandoned call can trigger a text with a booking link.' },
          ],
        },
      ],
    },
    {
      id: 'setup',
      title: 'What you configure, and what you do not have to',
      blocks: [
        {
          kind: 'list',
          items: [
            'You provide: business name, services, hours, service area, greeting, escalation contacts and booking preferences.',
            'You decide: which calls Sarah answers, which she only handles after hours, and which always go to a person.',
            'You do not need to: write call scripts from scratch, train a model, or hire anyone to manage the phone system.',
          ],
        },
        {
          kind: 'p',
          text: 'The better your business information, the better the calls. If a call goes poorly, the first thing to check is whether the knowledge base had the answer.',
        },
      ],
    },
    {
      id: 'good-fit',
      title: 'When Sarah is a good fit, and when she is not',
      blocks: [
        {
          kind: 'table',
          caption: 'Fit guide',
          headers: ['Good fit', 'Be cautious'],
          rows: [
            ['Scheduled service work booked by phone', 'Businesses that need complex custom negotiation on every call'],
            ['After-hours and overflow coverage', 'Situations where every call must be handled by a licensed person'],
            ['Lead capture and qualification', 'Regulated advice that must come from a human professional'],
            ['Routine confirmations and reschedules', 'Highly sensitive disputes that need personal judgement'],
          ],
        },
      ],
    },
  ],
  faqs: [
    {
      q: 'Will callers know they are talking to AI?',
      a: 'Sarah is AI and is not presented as a human. Disclosure requirements vary by region, and Vireek publishes an AI disclosure page that explains how this works.',
    },
    {
      q: 'Can I limit which calls Sarah handles?',
      a: 'Yes. You can route all calls, only after-hours or unanswered calls, or specific call types, and you control what always goes to a person.',
    },
    {
      q: 'What happens if she cannot answer a question?',
      a: 'She captures the caller’s details and the question and passes it to your team for a callback, rather than guessing.',
    },
  ],
};
