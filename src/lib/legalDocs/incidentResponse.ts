import { LEGAL_UPDATED, type LegalDoc } from './types';

export const incidentResponseDoc: LegalDoc = {
  slug: 'incident-response',
  path: '/incident-response',
  title: 'Incident Response & Data Breach Policy',
  metaTitle: 'Incident Response & Data Breach Policy | Vireek',
  description:
    'How Vireek detects, triages, contains and communicates security incidents and personal-data breaches, and how to report a vulnerability or suspected incident.',
  summary:
    'What we do when something goes wrong, how and when customers and authorities are told, and how to report a concern to us.',
  updated: LEGAL_UPDATED,
  reviewStatus: 'pending-counsel',
  sections: [
    {
      id: 'scope',
      title: 'Scope and definitions',
      paragraphs: [
        'A **security incident** is an event that compromises or threatens the confidentiality, integrity or availability of Vireek systems or data. A **personal-data breach** is a confirmed breach of security leading to the accidental or unlawful destruction, loss, alteration or unauthorized disclosure of, or access to, personal data that Vireek processes.',
      ],
    },
    {
      id: 'lifecycle',
      title: 'Response lifecycle',
      bullets: [
        '**Detect:** monitoring, alerts, audit logs, customer reports and security researcher reports.',
        '**Triage:** assign an owner, classify severity and decide whether personal data or customers are affected.',
        '**Contain:** isolate affected systems, revoke or rotate credentials and keys, block malicious access.',
        '**Eradicate and recover:** remove the cause, patch, restore from known-good state and verify.',
        '**Communicate:** notify affected customers and, where required, regulators and individuals.',
        '**Learn:** post-incident review with corrective actions tracked to completion.',
      ],
    },
    {
      id: 'severity',
      title: 'Severity levels',
      paragraphs: [
        'Incidents are rated by impact on customers, data sensitivity and scope. The highest-severity incidents are handled first and escalated to company leadership. We do not publish internal time targets as commitments; contractual commitments, if any, are in the [SLA](/sla) or a signed agreement.',
      ],
    },
    {
      id: 'customer-notice',
      title: 'Notifying customers',
      paragraphs: [
        'Vireek will notify the affected Customer without undue delay after becoming aware of a personal-data breach affecting data processed on that Customer’s behalf, consistent with the [DPA](/dpa). The notice will describe, as far as known, the nature of the breach, the categories and approximate volume of data and people affected, likely consequences, and the measures taken or proposed. Information may be provided in stages as the investigation progresses.',
        'The Customer, as controller, is responsible for deciding whether to notify regulators and individuals. For reference, the GDPR generally requires a controller to notify the supervisory authority within 72 hours of becoming aware of a reportable breach, and U.S. state breach-notification laws set their own timing and content rules.',
      ],
    },
    {
      id: 'regulators',
      title: 'Regulators and individuals',
      paragraphs: [
        'Where Vireek is itself the controller of the affected data, it will notify the competent authority and affected individuals as the law requires and will cooperate with regulators.',
      ],
    },
    {
      id: 'status',
      title: 'Status communications',
      paragraphs: [
        'Service-impacting events are posted on the [status page](/status), and we may email account owners when an incident materially affects their service.',
      ],
    },
    {
      id: 'reporting',
      title: 'How to report a concern',
      bullets: [
        'To report a suspected security vulnerability, follow the [Vulnerability Disclosure](/vulnerability-disclosure) policy.',
        'To report a suspected incident affecting your account, email [ali@vireek.com](mailto:ali@vireek.com) with the subject “Security incident” and include what you saw, when, and how to reach you.',
        'Please do not include passwords, full card numbers or other secrets in your email.',
      ],
    },
    {
      id: 'customer-duties',
      title: 'What customers should do',
      bullets: [
        'Use strong, unique credentials and enable multi-factor authentication where available.',
        'Remove users who no longer need access and rotate API keys if you suspect exposure.',
        'Tell us promptly if you suspect unauthorized access to your account.',
      ],
    },
    {
      id: 'records',
      title: 'Records and improvement',
      paragraphs: [
        'We keep records of incidents, their effects and our response, and use them to improve controls. See the [Security](/security) page and the [Trust Center](/trust) for current security practices.',
      ],
    },
  ],
  related: [
    { label: 'Security', href: '/security' },
    { label: 'Vulnerability Disclosure', href: '/vulnerability-disclosure' },
    { label: 'Data Processing Agreement', href: '/dpa' },
    { label: 'Status', href: '/status' },
  ],
};
