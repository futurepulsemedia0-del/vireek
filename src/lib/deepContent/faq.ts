import type { DeepContentData } from './types';

export const FAQ_DEEP: DeepContentData = {
  eyebrow: 'Deeper answers',
  title: 'Longer answers to the questions people ask before they switch',
  intro:
    'The quick answers above are intentionally short. These sections go further on the topics that most affect a buying decision: reliability, cost, setup, risk and what happens when something goes wrong.',
  sections: [
    {
      id: 'how-accurate',
      title: 'How reliable is an AI receptionist?',
      blocks: [
        {
          kind: 'p',
          text: 'No AI receptionist is perfect, and we do not claim otherwise. Reliability depends on the quality of the information you give it and on how clearly you define your rules. The most useful way to judge it is to listen to real calls.',
        },
        {
          kind: 'list',
          items: [
            'Use the trial with your own call types before relying on it.',
            'Read call summaries and quality scores during the first weeks.',
            'Fix gaps in your knowledge base rather than working around them.',
            'Keep an escalation path to a person for anything outside your rules.',
          ],
        },
      ],
    },
    {
      id: 'cost-thinking',
      title: 'How to think about cost',
      blocks: [
        {
          kind: 'p',
          text: 'The pricing page lists each plan, its included minutes and its overage rate. To judge whether a plan fits, estimate your monthly call minutes and compare them with the included amount. Then consider what a missed call costs you.',
        },
        {
          kind: 'steps',
          items: [
            { title: 'Estimate your call volume', text: 'Count how many calls you receive in a typical week and how long they last.' },
            { title: 'Estimate what you lose today', text: 'Estimate how many calls go unanswered and the average value of a job.' },
            { title: 'Compare with the plan', text: 'Use the pricing page and the ROI calculator to compare plan cost with recovered work.' },
          ],
        },
        {
          kind: 'p',
          text: 'We do not quote savings figures here because they depend entirely on your volume and job value.',
        },
      ],
    },
    {
      id: 'setup-expectations',
      title: 'What setup actually involves',
      blocks: [
        {
          kind: 'list',
          items: [
            'Provide your business details, services, hours and service area.',
            'Choose how calls reach Vireek: forwarding, overflow or a new number.',
            'Set your escalation contacts and rules.',
            'Connect your calendar and, if you want them, your CRM and messaging.',
            'Test with a few calls before routing live traffic.',
          ],
        },
        {
          kind: 'p',
          text: 'The system requirements page covers browser and device details, and the onboarding guide walks through the first steps.',
        },
      ],
    },
    {
      id: 'when-wrong',
      title: 'What happens when something goes wrong',
      blocks: [
        {
          kind: 'p',
          text: 'Problems fall into a few categories, and each has a place to look first.',
        },
        {
          kind: 'table',
          caption: 'Where to look first',
          headers: ['Problem', 'First thing to check'],
          rows: [
            ['Sarah gave wrong business information', 'Your knowledge base and business profile'],
            ['A call was not escalated', 'Your escalation rules and contact list'],
            ['A booking looks wrong', 'Your calendar connection and availability settings'],
            ['A message was not delivered', 'Your messaging settings and the customer’s consent status'],
            ['Service seems unavailable', 'The status page'],
          ],
        },
        {
          kind: 'p',
          text: 'If the answer is not there, contact support. The help center and status page are linked in the footer.',
        },
      ],
    },
    {
      id: 'privacy-data',
      title: 'Customer data and privacy questions',
      blocks: [
        {
          kind: 'p',
          text: 'How Vireek handles personal data, call recordings, subprocessors and your rights is covered in the legal and trust pages, which are the authoritative source. We keep those details out of this FAQ so that there is one accurate version of each policy.',
        },
      ],
    },
    {
      id: 'leaving',
      title: 'Can I leave, and what happens to my data?',
      blocks: [
        {
          kind: 'p',
          text: 'Plans are published without hidden fees, and the pricing page describes billing terms. Questions about exporting data, cancelling or deleting data are best answered by the current terms and your account settings, so check those or contact support before you commit if this matters to you.',
        },
      ],
    },
  ],
};
