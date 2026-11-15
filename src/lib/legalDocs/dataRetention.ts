import { LEGAL_UPDATED, type LegalDoc } from './types';

export const dataRetentionDoc: LegalDoc = {
  slug: 'data-retention',
  path: '/data-retention',
  title: 'Data Retention & Deletion Policy',
  metaTitle: 'Data Retention & Deletion Policy | Vireek',
  description:
    'How long Vireek keeps call recordings, transcripts, account and billing data, how deletion works after cancellation, and how to request erasure.',
  summary:
    'What we keep, for how long, why, and how it is deleted or anonymized when the time is up or when you ask.',
  updated: LEGAL_UPDATED,
  reviewStatus: 'pending-counsel',
  sections: [
    {
      id: 'principles',
      title: 'Principles',
      bullets: [
        '**Minimization:** we keep personal data only as long as it is needed for the purpose it was collected for, or as the law requires.',
        '**Customer control:** for data we process on a Customer’s behalf, the Customer decides what is kept and for how long, within the limits of this policy.',
        '**Defined end of life:** data is deleted or irreversibly anonymized at the end of its retention period.',
      ],
    },
    {
      id: 'schedule',
      title: 'Retention schedule',
      paragraphs: ['Unless a Customer configures a shorter period or the law requires a longer one:'],
      bullets: [
        '**Call recordings and transcripts:** 12 months from the date of the call, then deleted or anonymized.',
        '**Call summaries, lead, job and appointment records:** for the life of the Customer’s subscription, because they are part of the Customer’s business records, and then as described in “After cancellation”.',
        '**Account and profile data:** for the life of the account.',
        '**Billing and tax records:** as long as required by tax, accounting and payment-network rules, which is commonly several years after the transaction.',
        '**Security and audit logs:** kept for a limited period needed for security, abuse prevention and incident investigation.',
        '**Support correspondence:** kept while needed to resolve the request and for a reasonable period afterwards to handle follow-ups and disputes.',
        '**Marketing and consent records:** until you unsubscribe, plus the minimum period needed to prove consent or honor your opt-out.',
      ],
      callout: {
        label: 'Call data',
        text: 'The 12-month period for call recordings and transcripts matches the [Privacy Policy](/privacy). See the [Call Recording & Consent Policy](/call-recording-consent) for how recording works.',
      },
    },
    {
      id: 'after-cancellation',
      title: 'After cancellation',
      paragraphs: [
        'When a subscription ends, the Customer keeps access through the end of the paid period and can export its data. After the account closes, Vireek deletes or anonymizes Customer data within a reasonable period, except for data we must keep for legal, tax, fraud-prevention or dispute purposes. On termination, the [DPA](/dpa) governs deletion or return of personal data processed on the Customer’s behalf.',
        'Deleted data may persist in encrypted backups for a limited time until those backups are overwritten in the normal cycle. Backup copies are not used for any other purpose and are not restored except for disaster recovery.',
      ],
    },
    {
      id: 'requests',
      title: 'Deletion and erasure requests',
      paragraphs: [
        'Individuals can ask to access, correct or delete their personal data using the [data request form](/data-request). If the data relates to a call to a Vireek Customer, we may refer the request to that Customer, who is the controller of that data, and will help them respond.',
        'We verify identity before acting, to protect the data from false requests.',
      ],
      bullets: [
        'We respond within the time required by applicable law (for example one month under the GDPR and 45 days under the CCPA, each subject to permitted extensions).',
        'We may decline or limit a request where an exception applies, for example a legal obligation to retain, the establishment or defense of legal claims, or the rights of other people.',
        'California residents can find further details on the [CCPA Rights](/ccpa) page.',
      ],
    },
    {
      id: 'legal-holds',
      title: 'Legal holds',
      paragraphs: [
        'If we receive a valid legal process or reasonably anticipate litigation or a regulatory investigation, we may suspend deletion of the relevant data until the matter is resolved. Holds are narrowly scoped and documented.',
      ],
    },
    {
      id: 'deletion-method',
      title: 'How deletion is carried out',
      bullets: [
        'Production records are deleted or de-identified so that they can no longer be linked to an individual.',
        'Sub-processors that hold copies are instructed to delete them or delete them under their own schedules, as listed on the [Sub-processors](/subprocessors) page.',
        'Aggregated or de-identified statistics that cannot reasonably identify a person or a Customer may be retained.',
      ],
    },
    {
      id: 'contact',
      title: 'Contact',
      paragraphs: ['Questions about retention: [ali@vireek.com](mailto:ali@vireek.com).'],
    },
  ],
  related: [
    { label: 'Privacy Policy', href: '/privacy' },
    { label: 'Data Processing Agreement', href: '/dpa' },
    { label: 'Call Recording & Consent Policy', href: '/call-recording-consent' },
    { label: 'Data requests', href: '/data-request' },
  ],
};
