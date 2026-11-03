import type { ClaimStatus } from '@/lib/trust/claims';

/**
 * Evidence library: every document a buyer may ask for, with its REAL availability.
 * Rules (enforced by evidence.test.ts):
 *  - 'public'        → status 'verified' and href is an existing internal route.
 *  - 'on_request'    → obtainable through the request form; href is that form's page.
 *  - 'not_available' → no href. Never link a placeholder or sample as if it were the real document.
 */
export type EvidenceAvailability = 'public' | 'on_request' | 'not_available';

export interface EvidenceItem {
  id: string;
  title: string;
  description: string;
  availability: EvidenceAvailability;
  status: ClaimStatus;
  href?: string;
  /** Claim in claims.ts this item proves (or explains the absence of). */
  claimId?: string;
  reviewedOn: string;
  owner: string;
}

export const REQUEST_ACCESS_HREF = '/trust/compliance';

export const EVIDENCE_ITEMS: EvidenceItem[] = [
  { id: 'whitepaper', title: 'Security whitepaper', description: 'How Vireek is built and how call and customer data is protected.', availability: 'public', status: 'verified', href: '/security/whitepaper', reviewedOn: '2026-11-01', owner: 'ali' },
  { id: 'dpa', title: 'Data Processing Agreement', description: 'Terms covering personal data processed on your behalf.', availability: 'public', status: 'verified', href: '/dpa', reviewedOn: '2026-11-01', owner: 'ali' },
  { id: 'subprocessors', title: 'Sub-processor list', description: 'Third parties that process data, what they do and where.', availability: 'public', status: 'verified', href: '/subprocessors', reviewedOn: '2026-11-01', owner: 'ali' },
  { id: 'sla', title: 'Service Level Agreement', description: 'Uptime commitment and service credits.', availability: 'public', status: 'verified', href: '/sla', claimId: 'sla.uptime-commitment', reviewedOn: '2026-11-01', owner: 'ali' },
  { id: 'vdp', title: 'Vulnerability disclosure policy', description: 'How to report a security issue and what to expect.', availability: 'public', status: 'verified', href: '/vulnerability-disclosure', reviewedOn: '2026-11-01', owner: 'ali' },
  { id: 'compliance-status', title: 'Compliance status', description: 'Which certifications Vireek does and does not hold.', availability: 'public', status: 'verified', href: '/trust/compliance', reviewedOn: '2026-11-01', owner: 'ali' },
  { id: 'questionnaire', title: 'Security questionnaire response', description: 'Send us your vendor assessment and we will answer it.', availability: 'on_request', status: 'verified', href: REQUEST_ACCESS_HREF, reviewedOn: '2026-11-01', owner: 'ali' },
  { id: 'pentest-summary', title: 'Penetration-test summary', description: 'No third-party test has been completed yet, so there is no summary to share.', availability: 'not_available', status: 'planned', claimId: 'security.pentest', reviewedOn: '2026-11-01', owner: 'ali' },
  { id: 'soc2-report', title: 'SOC 2 report', description: 'Vireek has not completed a SOC 2 audit. If a report matters for your purchase, tell us on the request form.', availability: 'not_available', status: 'not_held', claimId: 'cert.soc2', reviewedOn: '2026-11-01', owner: 'ali' },
];
