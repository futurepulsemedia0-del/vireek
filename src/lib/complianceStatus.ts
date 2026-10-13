/**
 * Vireek compliance status — content for /trust/compliance.
 *
 * RULE: state only what is actually true. Today Vireek holds NO SOC 2 report,
 * offers NO HIPAA BAA and has NO PCI DSS attestation of its own (same position as
 * SecurityPage.tsx, TrustCenterPage.tsx and brandFacts.ts).
 *
 * To record a real certification later: set `status: 'held'` AND fill `attestation`
 * (issuer, report type, period). `complianceStatus.test.ts` fails a 'held' entry
 * without an attestation, so a badge can never be added without its evidence.
 * Bump COMPLIANCE_UPDATED whenever anything here changes.
 */

export const COMPLIANCE_UPDATED = '2026-10-08';
export const COMPLIANCE_PATH = '/trust/compliance';

export type ComplianceStatusKind = 'not_held' | 'held';

export interface Attestation {
  issuer: string;
  reportType: string;
  /** e.g. "Oct 1, 2026 – Sep 30, 2027" */
  period: string;
}

export interface ComplianceFramework {
  id: 'soc2' | 'hipaa' | 'pci';
  name: string;
  /** Short noun phrase used in the summary sentence, e.g. "a SOC 2 report". */
  heldLabel: string;
  /** Neutral, factual description of the framework itself. */
  what: string;
  status: ComplianceStatusKind;
  statusLabel: string;
  /** Vireek's plain statement of its own position. */
  statement: string;
  /** What this means for a customer's review. */
  meaning: string;
  attestation?: Attestation;
}

export const FRAMEWORKS: ComplianceFramework[] = [
  {
    id: 'soc2',
    name: 'SOC 2',
    heldLabel: 'a SOC 2 report',
    what: "An independent auditor's report on a company's controls for security, availability, confidentiality, processing integrity or privacy.",
    status: 'not_held',
    statusLabel: 'Not held',
    statement: 'Vireek has not completed a SOC 2 audit and does not hold a SOC 2 report (Type I or Type II).',
    meaning:
      'There is no SOC 2 report to share. Your review can rely on the controls described in our security whitepaper and the facts on the Trust Center, and you can ask us specific questions below. If a SOC 2 report is a hard requirement, tell us before you sign up and we will give you a straight answer.',
  },
  {
    id: 'hipaa',
    name: 'HIPAA',
    heldLabel: 'a HIPAA Business Associate Agreement',
    what: 'A US federal law that sets rules for protecting health information. There is no official HIPAA certification; vendors that handle protected health information for a covered entity sign a Business Associate Agreement (BAA).',
    status: 'not_held',
    statusLabel: 'Not held',
    statement: 'Vireek does not claim HIPAA compliance and does not currently offer a Business Associate Agreement.',
    meaning:
      'If your organization is a HIPAA covered entity or business associate, contact us before using Vireek for anything that involves protected health information.',
  },
  {
    id: 'pci',
    name: 'PCI DSS',
    heldLabel: 'its own PCI DSS attestation',
    what: 'The Payment Card Industry Data Security Standard: requirements for organizations that store, process or transmit payment card data.',
    status: 'not_held',
    statusLabel: 'Not held',
    statement:
      'Vireek does not hold its own PCI DSS attestation. Card payments are handled by Stripe, and Vireek does not store raw card details on its own servers.',
    meaning:
      "Stripe maintains its own PCI DSS compliance; that is Stripe's attestation, not Vireek's. See the sub-processor list for the parties involved in payment processing.",
  },
];

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** One sentence that is always derived from the data above, never hand-written. */
export function statusSummary(frameworks: ComplianceFramework[] = FRAMEWORKS): string {
  const missing = frameworks.filter((f) => f.status === 'not_held').map((f) => f.heldLabel);
  const held = frameworks.filter((f) => f.status === 'held');
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`Vireek does not currently hold ${joinList(missing)}.`);
  for (const f of held) {
    const a = f.attestation;
    parts.push(a ? `${f.name}: ${a.reportType} issued by ${a.issuer} (${a.period}).` : `${f.name}: see table.`);
  }
  return parts.join(' ');
}

/** "2026-10-08" -> "October 8, 2026" (timezone-independent). */
export function formatComplianceDate(iso: string = COMPLIANCE_UPDATED): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
