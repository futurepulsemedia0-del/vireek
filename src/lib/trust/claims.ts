/**
 * Vireek public claims registry — the single source of truth for every
 * certification, SLA, uptime, compliance, customer-count and social-proof
 * claim made on public pages or marketing copy.
 *
 * RULES
 *  - A claim may be written as FACT in public copy only while status === 'verified'.
 *  - 'verified'    → evidence + owner + a review date no older than MAX_REVIEW_AGE_DAYS.
 *  - 'in_progress' → work has really started; copy must say "in progress", never "we are X".
 *  - 'planned'     → intent only; copy must say "planned" / "we intend to".
 *  - 'not_held'    → we do not have it; copy may say so plainly.
 *  - `assertive` regexes (source strings) describe wording that asserts the claim as fact.
 *    scripts/check-claims.mjs (npm run claims:check) fails CI if such wording appears in
 *    public source while the claim is not 'verified'. Add `// claim-ok: <id>` on a line
 *    to allow a deliberate negative statement the scanner cannot tell apart.
 *  - Never fabricate evidence. If you cannot link proof, the claim is not 'verified'.
 *
 * Keep this file free of React and path aliases: the CI script loads it directly.
 */

export type ClaimStatus = 'verified' | 'in_progress' | 'planned' | 'not_held';
export type ClaimKind = 'fact' | 'commitment';
export type ClaimCategory =
  | 'certification'
  | 'compliance'
  | 'security'
  | 'sla'
  | 'uptime'
  | 'customers'
  | 'social_proof'
  | 'integration';

export interface ClaimEvidence {
  label: string;
  /** Internal path ("/sla") or https URL. */
  href: string;
}

export interface Claim {
  id: string;
  category: ClaimCategory;
  /** The exact wording public copy may use for this claim at its current status. */
  statement: string;
  status: ClaimStatus;
  /** 'commitment' = a promise (e.g. SLA); it is not proof of measured performance. */
  kind: ClaimKind;
  evidence?: ClaimEvidence;
  /** ISO date (YYYY-MM-DD) the owner last confirmed the status and wording. */
  reviewedOn: string;
  /** Person accountable for keeping this claim true. */
  owner: string;
  /** Regex sources matching wording that asserts the claim as fact. */
  assertive?: string[];
  /** What the owner must provide to move the claim forward. */
  needs?: string;
}

export const MAX_REVIEW_AGE_DAYS = 180;

export const CLAIMS: Claim[] = [
  {
    id: 'cert.soc2',
    category: 'certification',
    statement: 'Vireek has not completed a SOC 2 audit and holds no SOC 2 report.',
    status: 'not_held',
    kind: 'fact',
    evidence: { label: 'Compliance status', href: '/trust/compliance' },
    reviewedOn: '2026-10-08',
    owner: 'ali',
    assertive: ['SOC ?2(?:\\s+Type\\s+(?:I|II|1|2))?\\s+(?:certified|compliant|attested|audited|ready|report available)'],
    needs: 'An auditor-issued SOC 2 report (issuer, type, period) before this can become verified.',
  },
  {
    id: 'cert.hipaa',
    category: 'certification',
    statement: 'Vireek does not claim HIPAA compliance and does not offer a Business Associate Agreement.',
    status: 'not_held',
    kind: 'fact',
    evidence: { label: 'Compliance status', href: '/trust/compliance' },
    reviewedOn: '2026-10-08',
    owner: 'ali',
    assertive: ['HIPAA[- ](?:compliant|certified|ready|aligned)', 'signs? (?:a )?BAAs?'],
  },
  {
    id: 'cert.pci',
    category: 'certification',
    statement: 'Vireek holds no PCI DSS attestation of its own; card payments are handled by Stripe.',
    status: 'not_held',
    kind: 'fact',
    evidence: { label: 'Compliance status', href: '/trust/compliance' },
    reviewedOn: '2026-10-08',
    owner: 'ali',
    assertive: ['PCI(?:[- ]?DSS)?[- ](?:compliant|certified|level 1)'],
  },
  {
    id: 'cert.iso27001',
    category: 'certification',
    statement: 'Vireek holds no ISO 27001 certification.',
    status: 'not_held',
    kind: 'fact',
    reviewedOn: '2026-11-01',
    owner: 'ali',
    assertive: ['ISO[ /-]?(?:IEC )?27001(?:[- ]certified|[- ]compliant|[- ]aligned)?(?=[^.]*\\b(?:certified|compliant|aligned)\\b)'],
  },
  {
    id: 'security.pentest',
    category: 'security',
    statement:
      'A third-party penetration test is planned at least once a year. No completed report has been published yet.',
    status: 'planned',
    kind: 'commitment',
    evidence: { label: 'Trust Center', href: '/trust' },
    reviewedOn: '2026-11-01',
    owner: 'ali',
    assertive: [
      '(?:pen(?:etration)?[- ]?test(?:ed)?|pentest(?:ed)?)\\s+(?:passed|completed|clean|report available)',
      '(?:independently|third-party)\\s+(?:pen(?:etration)?[- ]?)?tested',
    ],
    needs: 'Engagement letter, scope, date and remediation status of a completed test (publish a summary, not raw findings).',
  },
  {
    id: 'sla.uptime-commitment',
    category: 'sla',
    statement: 'The Service Level Agreement commits to 99.9% monthly uptime, with service credits when it is missed.',
    status: 'verified',
    kind: 'commitment',
    evidence: { label: 'Service Level Agreement', href: '/sla' },
    reviewedOn: '2026-11-01',
    owner: 'ali',
  },
  {
    id: 'uptime.measured-history',
    category: 'uptime',
    statement: 'The status page shows measured availability from automated test calls when enough samples exist; no uptime percentage is shown otherwise.',
    status: 'in_progress',
    kind: 'fact',
    evidence: { label: 'Status page', href: '/status' },
    reviewedOn: '2026-11-01',
    owner: 'ali',
    assertive: ['\\b100(?:\\.0+)?\\s?%\\s+uptime', '\\b99\\.\\d+\\s?%\\s+(?:measured|actual|last)\\s+uptime'],
    needs: 'Synthetic probes running in production (probe targets configured) and at least 20 samples in 30 days; or a connected status provider (VITE_STATUS_API_URL).',
  },
  {
    id: 'customers.counts',
    category: 'customers',
    statement: 'Vireek is early-stage and publishes no customer counts.',
    status: 'not_held',
    kind: 'fact',
    evidence: { label: 'Customer stories', href: '/customers' },
    reviewedOn: '2026-11-01',
    owner: 'ali',
    assertive: [
      '\\b(?!1099\\b)(?:[1-9]\\d{2,}|\\d{1,3},\\d{3}|\\d+\\+)\\s+(?:happy |active |paying |trusted )?(?:customers|contractors|home[- ]service (?:businesses|companies))\\b',
      'trusted by (?:hundreds|thousands|\\d)',
    ],
    needs: 'A count you can substantiate from billing data, with the as-of date.',
  },
  {
    id: 'social.review-sites',
    category: 'social_proof',
    statement: 'Vireek shows no G2, Capterra or Google review ratings.',
    status: 'not_held',
    kind: 'fact',
    reviewedOn: '2026-11-01',
    owner: 'ali',
    assertive: ['\\b(?:G2|Capterra|Trustpilot)\\b[^.\\n]{0,40}\\b(?:rated|stars?|leader|award)\\b', '\\b[1-5]\\.\\d\\s?(?:\\/\\s?5|stars?)\\b'],
    needs: 'Live profile URLs and an API/embed that returns the real rating.',
  },
];

export const CLAIM_BY_ID: Record<string, Claim> = Object.fromEntries(CLAIMS.map((c) => [c.id, c]));

export function getClaim(id: string): Claim {
  const c = CLAIM_BY_ID[id];
  if (!c) throw new Error(`Unknown claim id: ${id}`);
  return c;
}

const DAY_MS = 86_400_000;

export function reviewAgeDays(claim: Claim, now: Date = new Date()): number {
  const t = Date.parse(`${claim.reviewedOn}T00:00:00Z`);
  return Math.floor((now.getTime() - t) / DAY_MS);
}

export function isStale(claim: Claim, now: Date = new Date()): boolean {
  return reviewAgeDays(claim, now) > MAX_REVIEW_AGE_DAYS;
}

/** Structural problems; empty array means the registry is internally consistent. */
export function validateClaims(claims: Claim[] = CLAIMS, now: Date = new Date()): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const c of claims) {
    if (seen.has(c.id)) errors.push(`${c.id}: duplicate id`);
    seen.add(c.id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.reviewedOn) || Number.isNaN(Date.parse(c.reviewedOn))) {
      errors.push(`${c.id}: reviewedOn must be a valid YYYY-MM-DD date`);
    } else if (Date.parse(`${c.reviewedOn}T00:00:00Z`) > now.getTime() + DAY_MS) {
      errors.push(`${c.id}: reviewedOn is in the future`);
    }
    if (!c.owner.trim()) errors.push(`${c.id}: owner is required`);
    if (!c.statement.trim()) errors.push(`${c.id}: statement is required`);
    if (c.status === 'verified') {
      if (!c.evidence?.href) errors.push(`${c.id}: verified claims need evidence.href`);
      if (isStale(c, now)) errors.push(`${c.id}: verified claim not reviewed in ${MAX_REVIEW_AGE_DAYS} days`);
    }
    for (const src of c.assertive ?? []) {
      try {
        new RegExp(src, 'i');
      } catch {
        errors.push(`${c.id}: invalid assertive regex ${src}`);
      }
    }
  }
  return errors;
}

export interface ClaimViolation {
  claimId: string;
  line: number;
  text: string;
}

const NEGATION = /\b(?:not|no|never|without|nor|neither|n't|until|unless|once|if|when|planned|intend|whether|ask|asks|asked)\b/i;

/**
 * Scans text for wording that asserts a non-verified claim as fact.
 * Lines containing negation/conditional words, or `claim-ok: <id>`, are skipped.
 * Heuristic by design: it blocks the common accidental cases; it is not a legal review.
 */
export function findClaimViolations(text: string, claims: Claim[] = CLAIMS): ClaimViolation[] {
  const out: ClaimViolation[] = [];
  const lines = text.split(/\r?\n/);
  for (const c of claims) {
    if (c.status === 'verified' || !c.assertive?.length) continue;
    const regs = c.assertive.map((s) => new RegExp(s, 'i'));
    lines.forEach((line, i) => {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return; // comment-only lines are not public copy
      if (line.includes(`claim-ok: ${c.id}`)) return;
      if (NEGATION.test(line)) return;
      if (regs.some((r) => r.test(line))) out.push({ claimId: c.id, line: i + 1, text: line.trim().slice(0, 160) });
    });
  }
  return out;
}
