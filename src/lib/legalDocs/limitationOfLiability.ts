import { LEGAL_UPDATED, type LegalDoc } from './types';

export const limitationOfLiabilityDoc: LegalDoc = {
  slug: 'limitation-of-liability',
  path: '/limitation-of-liability',
  title: 'Limitation of Liability',
  metaTitle: 'Limitation of Liability | Vireek',
  description:
    'Vireek’s liability cap, excluded damages, AI-specific limits and the things that can never be limited, in plain language.',
  summary:
    'A readable statement of how much Vireek can be liable for and what is excluded. It restates the limitation clause of the Terms of Service.',
  updated: LEGAL_UPDATED,
  reviewStatus: 'pending-counsel',
  sections: [
    {
      id: 'relationship',
      title: 'How this page relates to your agreement',
      paragraphs: [
        'This page restates the limitation-of-liability terms in the [Terms of Service](/terms). If you have signed a [Master Services Agreement](/msa) or an order form with different terms, the signed document controls.',
      ],
    },
    {
      id: 'cap',
      title: 'Liability cap',
      paragraphs: [
        'To the maximum extent permitted by law, Vireek’s total liability for all claims arising from or related to the service in any one claim is limited to the amount the Customer paid to Vireek for the service during the 3 months before the event that gave rise to the claim.',
      ],
    },
    {
      id: 'excluded-damages',
      title: 'Excluded damages',
      paragraphs: [
        'To the maximum extent permitted by law, Vireek is not liable for indirect, incidental, special, consequential, exemplary or punitive damages, including:',
      ],
      bullets: [
        'Lost profits, revenue, business opportunities, customers or goodwill, including missed calls or jobs.',
        'Loss of or damage to data, other than as set out in the [DPA](/dpa).',
        'Costs of substitute services.',
      ],
      callout: {
        label: 'Applies even if advised',
        text: 'These limits apply whatever the legal theory (contract, tort, negligence, strict liability or otherwise) and even if Vireek was told that such damages were possible.',
      },
    },
    {
      id: 'ai',
      title: 'AI-specific limits',
      paragraphs: [
        'Vireek’s AI can produce errors. Vireek is not liable for decisions the Customer or its callers make by relying on AI output without appropriate review, for statements the Customer instructs the AI to make, or for the Customer’s failure to meet call-recording, consent, licensing or consumer-law obligations described in the [Call Recording & Consent Policy](/call-recording-consent) and the [Terms of Service](/terms).',
      ],
    },
    {
      id: 'third-parties',
      title: 'Third parties and outside events',
      paragraphs: [
        'Vireek is not liable for failures caused by telephone carriers, internet providers, third-party integrations, payment processors or events beyond its reasonable control, including outages, natural disasters, labor disputes, acts of government or malicious attacks that occur despite reasonable security measures.',
      ],
    },
    {
      id: 'exclusions',
      title: 'What is not limited',
      paragraphs: [
        'Nothing in this page limits liability that cannot be limited by law, including liability for death or personal injury caused by negligence, fraud or fraudulent misrepresentation, willful misconduct, or any liability that applicable consumer-protection or mandatory law does not allow to be excluded. Some jurisdictions do not allow the exclusion or limitation of certain damages, so some limits may not apply to you.',
      ],
    },
    {
      id: 'service-credits',
      title: 'Service credits',
      paragraphs: [
        'Where the [SLA](/sla) provides service credits, they are the Customer’s sole and exclusive remedy for the availability failure they relate to and count towards the liability cap above.',
      ],
    },
    {
      id: 'time-limit',
      title: 'Time limit for claims',
      paragraphs: [
        'To the extent the law allows, a claim must be brought within one year after it arose. Governing law and venue are set out in the [Terms of Service](/terms).',
      ],
    },
  ],
  related: [
    { label: 'Terms of Service', href: '/terms' },
    { label: 'Disclaimer', href: '/disclaimer' },
    { label: 'Service Level Agreement', href: '/sla' },
    { label: 'Master Services Agreement', href: '/msa' },
  ],
};
