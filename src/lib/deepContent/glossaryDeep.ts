import type { DeepContentData } from './types';

export const GLOSSARY_DEEP: DeepContentData = {
  eyebrow: 'Reading guide',
  title: 'How the terms fit together, and the confusions worth clearing up',
  intro:
    'A list of definitions is easy to skim and hard to use. This guide groups the vocabulary into the six areas of the glossary, explains how the ideas connect, and clears up the pairs of terms that people most often mix up.',
  related: [
    { label: 'Features', href: '/features' },
    { label: 'Platform', href: '/platform' },
    { label: 'Security', href: '/security' },
    { label: 'Pricing', href: '/pricing' },
  ],
  sections: [
    {
      id: 'ai-voice',
      title: 'AI and voice technology',
      blocks: [
        {
          kind: 'p',
          text: 'An AI voice receptionist is a chain of steps: speech is converted to text, a language model decides what to say, and the reply is converted back to speech. Quality depends on every link. A fast reply feels natural, a slow one feels broken, which is why delay, often called latency, is a common measure of voice systems.',
        },
        {
          kind: 'p',
          text: 'Two behaviours distinguish a good conversation from a clumsy one. The first is handling interruptions, where the caller speaks over the system and it stops and listens. The second is knowing its limits, which means handing off to a person when the situation requires it.',
        },
      ],
    },
    {
      id: 'telephony',
      title: 'Call handling and telephony',
      blocks: [
        {
          kind: 'p',
          text: 'Most small businesses do not replace their phone system. They change where unanswered or all calls are forwarded. Forwarding can apply to every call, only when the line is busy or only when nobody answers, and the choice shapes how much coverage you get.',
        },
        {
          kind: 'list',
          items: [
            'A warm transfer introduces the caller to a person with context. A cold transfer simply connects them.',
            'A missed call is one nobody answered. An abandoned call is one where the caller hung up before it was answered.',
            'Moving a number between providers is called porting, and it is separate from simply forwarding calls.',
          ],
        },
      ],
    },
    {
      id: 'growth',
      title: 'Leads and revenue',
      blocks: [
        {
          kind: 'p',
          text: 'These terms describe the path from a first contact to money. A lead is a possible customer. Qualification is deciding how likely and how valuable that lead is. A booking is a scheduled visit, and a job is the work itself. Confusing them hides where you are losing business.',
        },
        {
          kind: 'p',
          text: 'Conversion rates describe how many leads move to the next stage. The useful habit is to measure each stage separately, so you can tell whether you are losing calls, losing bookings or losing quotes.',
        },
      ],
    },
    {
      id: 'industry',
      title: 'Home service industry',
      blocks: [
        {
          kind: 'p',
          text: 'Trade vocabulary exists because the work is specific. Terms for equipment, service types and job stages decide which questions to ask and which crew to send. A receptionist that knows them asks better questions and makes fewer scheduling mistakes.',
        },
      ],
    },
    {
      id: 'integrations',
      title: 'CRM and integrations',
      blocks: [
        {
          kind: 'p',
          text: 'A CRM stores customer and sales history. Field-service software runs dispatch, jobs and invoices. They overlap but are not the same, and many businesses use both. An integration moves specific data between tools, and an API or a webhook is the technical channel it uses.',
        },
        {
          kind: 'callout',
          title: 'Always check the scope',
          text: 'Two products can both say they integrate and still move very different data. Ask exactly which records are read, which are written and in which direction.',
        },
      ],
    },
    {
      id: 'security',
      title: 'Security and compliance',
      blocks: [
        {
          kind: 'p',
          text: 'Encryption in transit protects data while it moves, and encryption at rest protects it while stored. Isolation keeps one customer’s data apart from another’s. Role-based access limits what each person can see. A data processing agreement is the written commitment about how a processor handles personal data.',
        },
        {
          kind: 'p',
          text: 'Compliance terms describe obligations that differ by country and region. A glossary can explain what a term means, but it cannot tell you what applies to your business, so take that question to a qualified adviser.',
        },
      ],
    },
    {
      id: 'confusions',
      title: 'Pairs of terms people mix up',
      blocks: [
        {
          kind: 'table',
          caption: 'Common confusions',
          headers: ['Term A', 'Term B', 'The difference'],
          rows: [
            ['Voicemail', 'AI receptionist', 'Voicemail records a message. An AI receptionist holds a conversation and arranges a next step'],
            ['Answering service', 'AI receptionist', 'An answering service uses human agents. An AI receptionist is software following your rules'],
            ['Lead', 'Booking', 'A lead is interest. A booking is a scheduled visit'],
            ['CRM', 'Field-service software', 'A CRM tracks relationships. Field-service software runs jobs and dispatch'],
            ['Forwarding', 'Porting', 'Forwarding redirects calls. Porting moves the number itself'],
            ['Missed call', 'Abandoned call', 'Missed means unanswered. Abandoned means the caller gave up'],
          ],
        },
      ],
    },
  ],
};
