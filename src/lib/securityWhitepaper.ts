/**
 * Vireek Security Whitepaper — content.
 *
 * Single source of truth for BOTH the public page (/security/whitepaper) and the
 * downloadable PDF, so the two can never drift apart.
 *
 * Writing rules (same as /security): every statement describes how the platform
 * is built today. Do NOT add a certification, attestation or compliance claim
 * (SOC 2, ISO 27001, HIPAA, PCI level, ...) unless Vireek actually holds it —
 * `securityWhitepaper.test.ts` fails if such wording appears.
 *
 * Keep text PDF-safe: Latin-1 characters plus en/em dash and curly quotes only
 * (jsPDF's built-in Helvetica cannot render other glyphs). The test enforces it.
 */

export const SITE_ORIGIN = 'https://vireek.com';

export const WHITEPAPER = {
  title: 'Vireek Security Whitepaper',
  shortTitle: 'Security Whitepaper',
  version: '1.0',
  /** ISO date of the last content review. Bump together with `version` when content changes. */
  updated: '2026-10-08',
  path: '/security/whitepaper',
  description:
    'How Vireek protects business data: architecture and data flow, encryption, account isolation, access control, application security, AI data handling and responsible disclosure.',
} as const;

export const WHITEPAPER_FILENAME = `Vireek-Security-Whitepaper-v${WHITEPAPER.version}.pdf`;

export type WhitepaperBlock =
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'dl'; items: { term: string; text: string }[] };

export interface WhitepaperSection {
  id: string;
  title: string;
  blocks: WhitepaperBlock[];
}

export const SECTIONS: WhitepaperSection[] = [
  {
    id: 'overview',
    title: 'Executive summary',
    blocks: [
      {
        type: 'p',
        text: 'Vireek is an AI voice receptionist and operations platform for home service businesses. This whitepaper explains how the platform is built to protect the call, customer and job data that businesses entrust to it. It is written for security reviewers, IT teams and procurement.',
      },
      {
        type: 'p',
        text: 'It describes the platform as it is built today. It is not a compliance certification, an audit report or a contract. Binding terms are in the Terms of Service, the Privacy Policy and the Data Processing Agreement.',
      },
      {
        type: 'ul',
        items: [
          'Data is encrypted in transit with TLS, and encrypted at rest by our infrastructure provider.',
          "Each business's data is isolated inside the database with row-level security policies, so one account cannot query another account's data.",
          'Team access is role-based, down to the individual permission, and security-relevant account actions are written to an audit log.',
          'The web application is served with hardened browser security headers, including HSTS and a strict Content Security Policy.',
          'Only the call transcript is sent to AI models. Raw call audio is not sent to the AI model layer.',
          'Security issues can be reported through a published responsible disclosure process.',
        ],
      },
    ],
  },
  {
    id: 'architecture',
    title: 'Architecture and data flow',
    blocks: [
      {
        type: 'p',
        text: 'When a customer calls a business that uses Vireek, data moves through the following components. The same flow is shown on the Trust Center.',
      },
      {
        type: 'dl',
        items: [
          {
            term: 'Caller',
            text: "A customer calls the business's Vireek phone number. The call is handled by our voice and telephony provider.",
          },
          {
            term: 'Voice and telephony (Vapi)',
            text: 'Answers the call and converts speech to text in real time.',
          },
          {
            term: 'AI model layer',
            text: 'Understands the transcript and produces the assistant\u2019s reply. Gemini is the primary model, with Groq, Cerebras, Workers AI and OpenRouter as fallbacks. Only transcript text is sent; raw audio is not.',
          },
          {
            term: 'Database and authentication (Supabase)',
            text: "The conversation, lead and job details are saved to the business's own account, protected by row-level security.",
          },
          {
            term: 'Customer dashboard',
            text: 'The business owner and the team members they permit can see calls, transcripts, leads and jobs.',
          },
          {
            term: 'Optional integrations',
            text: 'Stripe (billing), Google Calendar (appointments), QuickBooks (accounting) and Zapier (automation) receive data only when the account owner connects them.',
          },
        ],
      },
      {
        type: 'p',
        text: 'This infrastructure runs in the United States today. The full list of third parties that may touch customer data is published as the sub-processor list.',
      },
    ],
  },
  {
    id: 'data-protection',
    title: 'Data protection',
    blocks: [
      {
        type: 'dl',
        items: [
          {
            term: 'Encryption in transit',
            text: 'Traffic between the browser, the Vireek dashboard and the database runs over TLS. The site is served with HTTP Strict Transport Security so browsers refuse to downgrade to plain HTTP.',
          },
          {
            term: 'Encryption at rest',
            text: 'Data at rest is encrypted by our infrastructure provider.',
          },
          {
            term: 'Account isolation',
            text: "Calls, leads, jobs and other account data are protected by row-level security policies in the database. Access is resolved to the account owner's identity, so a team member sees their employer's account and nothing else, and one business cannot query another business's data. The boundary is enforced by the database, not only by application code.",
          },
          {
            term: 'Payment information',
            text: 'Billing is handled by a dedicated payment processor. Vireek does not store raw card details on its own servers.',
          },
          {
            term: 'What is stored',
            text: 'Call transcripts and summaries, and the names, phone numbers and job details captured on calls, are stored under the business\u2019s account so the team can review and follow up. The Privacy Policy describes what is collected, why, and how long it is kept.',
          },
        ],
      },
    ],
  },
  {
    id: 'access-control',
    title: 'Identity and access control',
    blocks: [
      {
        type: 'p',
        text: 'Account owners decide who on their team can do what. Permissions are granted individually rather than as a single all-or-nothing role:',
      },
      {
        type: 'ul',
        items: [
          'View billing',
          'Manage phone numbers',
          'Manage the team',
          'Edit the business profile',
          'View all jobs (technicians without this permission only receive jobs assigned to them)',
          'View the audit log',
          'Manage security settings',
        ],
      },
      {
        type: 'p',
        text: 'Enterprise accounts have additional controls in the dashboard:',
      },
      {
        type: 'ul',
        items: [
          'Single sign-on with SAML.',
          'SCIM provisioning for automated user lifecycle management.',
          'Custom roles that override the base permission set.',
          'IP allowlisting.',
          'A configurable session policy for idle time and maximum session age.',
        ],
      },
      {
        type: 'p',
        text: 'Security-relevant account actions are recorded in an account audit log. It is visible only to the owner and to team members who have been granted the audit log permission.',
      },
    ],
  },
  {
    id: 'application-security',
    title: 'Application and network security',
    blocks: [
      {
        type: 'p',
        text: 'The Vireek web application is served with the following security headers on every page:',
      },
      {
        type: 'ul',
        items: [
          'Strict-Transport-Security with a two-year max-age, includeSubDomains and preload.',
          'Content-Security-Policy that restricts scripts, frames and network connections to named origins, disables plugins (object-src none), restricts base-uri and form targets to the site itself, and upgrades insecure requests.',
          'frame-ancestors none and X-Frame-Options DENY, which prevent the dashboard from being embedded in other sites (clickjacking protection).',
          'X-Content-Type-Options nosniff.',
          'Referrer-Policy strict-origin-when-cross-origin.',
          'Permissions-Policy that disables geolocation, payment, USB and motion sensors, and allows microphone and camera access only for the site itself.',
        ],
      },
      {
        type: 'p',
        text: 'Front-end errors are reported to an error-monitoring service so that defects can be found and fixed quickly.',
      },
    ],
  },
  {
    id: 'ai-systems',
    title: 'AI systems and data handling',
    blocks: [
      {
        type: 'ul',
        items: [
          'Only transcript text is sent to the AI model layer. Raw call audio is not.',
          'The business configures what the assistant says and does: greeting, business details and escalation rules. Nothing is shared with a caller that the business has not configured.',
          'Calls can be escalated or transferred to a person according to rules the business sets.',
          'The in-product AI Security Center lets administrators with the security permission review AI security events and agent sandbox policies.',
          'Every AI model provider is listed in the sub-processor list.',
        ],
      },
      {
        type: 'p',
        text: 'How Vireek discloses, oversees and governs AI is described in the Responsible AI Policy.',
      },
    ],
  },
  {
    id: 'transparency',
    title: 'Transparency and availability',
    blocks: [
      {
        type: 'p',
        text: 'Vireek publishes the documents most often requested during vendor reviews:',
      },
      {
        type: 'ul',
        items: [
          'Trust Center: data flow, data location and policy index.',
          'Sub-processor list: every third party that touches customer data.',
          'Data Processing Agreement: the standard DPA for enterprise procurement.',
          'System status: live uptime and incident history.',
          'Service Level Agreement: the uptime commitment and service credits.',
        ],
      },
    ],
  },
  {
    id: 'disclosure',
    title: 'Vulnerability disclosure',
    blocks: [
      {
        type: 'p',
        text: 'Vireek welcomes responsible disclosure. Report a suspected vulnerability to ali@vireek.com with enough detail to reproduce it. A machine-readable contact file (RFC 9116) is published at vireek.com/.well-known/security.txt, and the full Vulnerability Disclosure Policy is at vireek.com/vulnerability-disclosure.',
      },
    ],
  },
  {
    id: 'scope',
    title: 'Compliance scope and limitations',
    blocks: [
      {
        type: 'p',
        text: 'This whitepaper makes factual statements about how the platform is built. It does not claim any third-party certification or attestation, and none should be inferred from it. If Vireek obtains a certification or attestation in the future, it will be stated explicitly on the Trust Center and in a new version of this document.',
      },
      {
        type: 'p',
        text: 'Businesses with specific security or compliance requirements are encouraged to raise them before connecting any systems. Contact ali@vireek.com or book a demo at vireek.com/demo.',
      },
    ],
  },
];

export interface RelatedDoc {
  label: string;
  description: string;
  href: string;
}

export const RELATED_DOCS: RelatedDoc[] = [
  { label: 'Security overview', description: 'A plain-language summary of how data is protected.', href: '/security' },
  { label: 'Trust Center', description: 'Data flow, data location and policy index.', href: '/trust' },
  { label: 'Sub-processor list', description: 'Every third party that touches your data.', href: '/subprocessors' },
  { label: 'Data Processing Agreement', description: 'Our standard DPA for enterprise procurement.', href: '/dpa' },
  { label: 'Vulnerability Disclosure Policy', description: 'How to report a security issue.', href: '/vulnerability-disclosure' },
  { label: 'Responsible AI Policy', description: 'How AI is disclosed, overseen and governed.', href: '/responsible-ai' },
];

export const SECTION_IDS: readonly string[] = SECTIONS.map((s) => s.id);

/** "2026-10-08" -> "October 8, 2026" (timezone-independent). */
export function formatWhitepaperDate(iso: string = WHITEPAPER.updated): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Every string in the document, in reading order (used for read-time and content checks). */
export function allWhitepaperText(): string[] {
  const out: string[] = [];
  for (const s of SECTIONS) {
    out.push(s.title);
    for (const b of s.blocks) {
      if (b.type === 'p') out.push(b.text);
      else if (b.type === 'ul') out.push(...b.items);
      else for (const i of b.items) out.push(i.term, i.text);
    }
  }
  return out;
}

export function estimateReadMinutes(): number {
  const words = allWhitepaperText().join(' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}
