import { LEGAL_UPDATED, type LegalDoc } from './types';

export const callRecordingDoc: LegalDoc = {
  slug: 'call-recording-consent',
  path: '/call-recording-consent',
  title: 'Call Recording & Consent Policy',
  metaTitle: 'Call Recording & Consent Policy | Vireek',
  description:
    'How Vireek AI voice employees record, transcribe and disclose calls, how caller consent is requested, and what business customers must do to stay compliant.',
  summary:
    'Calls answered by Vireek may be recorded and processed by AI. This policy explains how callers are told, how consent is handled and who is responsible for what.',
  updated: LEGAL_UPDATED,
  reviewStatus: 'pending-counsel',
  sections: [
    {
      id: 'scope',
      title: 'Scope',
      paragraphs: [
        'This policy applies to inbound and outbound calls that are answered, placed or handled by Vireek’s AI voice employee on behalf of a business customer (the “Customer”), including calls transferred to a human, voicemail and any call audio, transcript, summary or metadata derived from those calls.',
        'It supplements the [Privacy Policy](/privacy), the [AI Call Disclosure](/ai-disclosure), the [Terms of Service](/terms) and, for Customers, the [Data Processing Agreement](/dpa). If there is a conflict about call recording specifically, this policy controls.',
      ],
    },
    {
      id: 'what-we-record',
      title: 'What is recorded and why',
      paragraphs: ['Depending on the Customer’s configuration, Vireek may create and store:'],
      bullets: [
        'Call audio recordings.',
        'Speech-to-text transcripts and AI-generated summaries.',
        'Call metadata such as caller number, call time, duration, routing outcome and any appointment or lead record created from the call.',
      ],
    },
    {
      id: 'purposes',
      title: 'Purposes of recording',
      paragraphs: ['Recordings and transcripts are used only to operate and protect the service:'],
      bullets: [
        'To answer, qualify, route and follow up on calls for the Customer.',
        'To create accurate lead, job and appointment records and to let the Customer review what was said.',
        'Quality review, troubleshooting, security and fraud prevention, and resolving disputes.',
        'Meeting legal, regulatory and contractual obligations.',
      ],
      callout: {
        label: 'No sale of recordings',
        text: 'Vireek does not sell call recordings or transcripts. See the [Privacy Policy](/privacy) for how data may be used to improve the service and the limits that apply.',
      },
    },
    {
      id: 'notice-and-consent',
      title: 'Notice to callers and consent',
      paragraphs: [
        'Where required by applicable law, callers are told at the start of the call that they are speaking with an automated AI system and that the call may be recorded. For callers in jurisdictions recognized as requiring the consent of all parties, Vireek’s AI requests verbal consent at the start of the call before recording begins.',
        'Consent requirements depend on where each party is located and differ between jurisdictions. Several U.S. states (for example California, Florida, Illinois, Maryland, Massachusetts, Montana, New Hampshire, Pennsylvania and Washington) are commonly treated as requiring all-party consent, and other countries, including the United Kingdom, the European Economic Area and Canada, impose their own notice, purpose and lawful-basis requirements. This list is illustrative and not legal advice.',
      ],
    },
    {
      id: 'declining',
      title: 'When a caller declines or objects',
      bullets: [
        'A caller who objects to recording in a jurisdiction that requires consent should not be recorded for that call.',
        'Customers should configure a fallback so that a caller who declines can still reach the business, for example through a callback, a message or a transfer to a person.',
        'A caller may ask at any time to have a recording deleted by using the [data request form](/data-request).',
      ],
    },
    {
      id: 'customer-responsibilities',
      title: 'Customer responsibilities',
      paragraphs: [
        'The Customer is the party that decides to record calls to its business numbers and is responsible for having a lawful basis to do so. As between Vireek and the Customer, the Customer is responsible for:',
      ],
      bullets: [
        'Complying with all call recording, wiretap, telemarketing, privacy and consumer protection laws that apply to its callers and locations, including two-party and all-party consent rules.',
        'Not enabling recording for calls that are legally privileged, confidential by profession (for example attorney–client or medical communications) or otherwise restricted, unless it has taken the legal steps required.',
        'Keeping its own greeting, website privacy notice and employee notices accurate and consistent with this policy.',
        'Responding to requests from callers about the Customer’s own use of recordings.',
      ],
    },
    {
      id: 'security-retention',
      title: 'Security, access and retention',
      paragraphs: [
        'Recordings and transcripts are encrypted in transit and access-controlled per account. Only authorized users of the Customer’s account and Vireek personnel with a defined need can access them, and access by Vireek personnel is limited to support, security and legal purposes.',
        'Unless the Customer sets a different period, call recordings and transcripts are retained for 12 months and then deleted or anonymized, as described in the [Data Retention & Deletion Policy](/data-retention). Third-party providers that process call audio are listed on the [Sub-processors](/subprocessors) page.',
      ],
    },
    {
      id: 'emergencies',
      title: 'Emergency calls',
      paragraphs: [
        'Vireek’s AI voice employee is not an emergency service. A caller who reports an emergency is directed to contact local emergency services. Customers that offer an emergency hotline must make sure their escalation rules are configured and tested.',
      ],
    },
    {
      id: 'contact',
      title: 'Questions and complaints',
      paragraphs: [
        'Callers should first contact the business they called. For questions about this policy or to exercise privacy rights with Vireek, use the [data request form](/data-request) or email [ali@vireek.com](mailto:ali@vireek.com).',
      ],
    },
  ],
  related: [
    { label: 'AI Call Disclosure', href: '/ai-disclosure' },
    { label: 'Privacy Policy', href: '/privacy' },
    { label: 'Data Retention & Deletion Policy', href: '/data-retention' },
    { label: 'Responsible AI Policy', href: '/responsible-ai' },
  ],
};
