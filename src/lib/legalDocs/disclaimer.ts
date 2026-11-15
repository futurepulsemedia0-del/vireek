import { LEGAL_UPDATED, type LegalDoc } from './types';

export const disclaimerDoc: LegalDoc = {
  slug: 'disclaimer',
  path: '/disclaimer',
  title: 'Disclaimer',
  metaTitle: 'Disclaimer | Vireek',
  description:
    'Important limits on what Vireek’s AI voice employee, website content and third-party integrations can promise: no legal, financial or emergency advice, AI accuracy and results.',
  summary:
    'The service and this website are provided to help run a home-service business, with the limits and expectations described here.',
  updated: LEGAL_UPDATED,
  reviewStatus: 'pending-counsel',
  sections: [
    {
      id: 'general',
      title: 'General information',
      paragraphs: [
        'Content on vireek.com, in the dashboard, in help articles, blog posts, calculators and reports is provided for general information. We work to keep it accurate and current but do not promise that it is complete, error-free or suitable for your situation.',
      ],
    },
    {
      id: 'no-advice',
      title: 'Not professional advice',
      paragraphs: [
        'Nothing on the site or produced by the service is legal, tax, accounting, financial, insurance, safety or engineering advice. Compliance topics such as call-recording laws, licensing, warranties, refrigerant handling or consumer protection depend on your location and facts. Consult a qualified professional.',
      ],
    },
    {
      id: 'ai-output',
      title: 'AI-generated output',
      paragraphs: [
        'Vireek uses artificial intelligence to answer calls, capture details, suggest next steps and generate text, summaries and recommendations. AI can mishear, misunderstand or produce incorrect, incomplete or unexpected output. Customers are responsible for reviewing consequential output, such as quotes, appointment commitments and diagnoses, before relying on it. See the [Responsible AI Policy](/responsible-ai) for the safeguards we apply.',
      ],
      callout: {
        label: 'Emergencies',
        text: 'Vireek is not an emergency service. If someone is in danger, or there is a gas leak, fire, electrical hazard or flooding, contact local emergency services immediately.',
      },
    },
    {
      id: 'results',
      title: 'Results and projections',
      paragraphs: [
        'Calculators, benchmarks, case studies and estimates, including ROI tools, show illustrative outcomes based on the inputs and assumptions stated. They are not guarantees. Results vary with call volume, market, staffing, pricing, seasonality and how the service is configured and used.',
      ],
    },
    {
      id: 'third-party',
      title: 'Third-party services and links',
      paragraphs: [
        'The service integrates with and links to third-party products such as telephony, payment, calendar, accounting and CRM providers. We do not control them, and their availability, accuracy and policies are their own. Using them is subject to their terms.',
      ],
    },
    {
      id: 'availability',
      title: 'Availability and changes',
      paragraphs: [
        'We aim for high availability as described in the [SLA](/sla), but the service may be interrupted by maintenance, network or carrier failures or events outside our control. Features may change or be retired with reasonable notice where practical.',
      ],
    },
    {
      id: 'warranty',
      title: 'No warranties',
      paragraphs: [
        'To the fullest extent permitted by law, the service and site are provided “as is” and “as available”, and Vireek disclaims all warranties not expressly stated in a signed agreement, including implied warranties of merchantability, fitness for a particular purpose and non-infringement. Some jurisdictions do not allow certain disclaimers, so parts of this section may not apply to you. Liability is addressed in the [Limitation of Liability](/limitation-of-liability) page.',
      ],
    },
    {
      id: 'trademarks',
      title: 'Names and marks',
      paragraphs: [
        'Third-party names and trademarks mentioned belong to their owners and are used only to identify them. No affiliation or endorsement is implied unless stated. See the [Trademark Policy](/trademark-policy).',
      ],
    },
  ],
  related: [
    { label: 'Terms of Service', href: '/terms' },
    { label: 'Limitation of Liability', href: '/limitation-of-liability' },
    { label: 'Responsible AI Policy', href: '/responsible-ai' },
    { label: 'AI Call Disclosure', href: '/ai-disclosure' },
  ],
};
