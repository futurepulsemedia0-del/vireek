/**
 * Public Trust Center claims — shown as "Evidenced" ONLY when the database gate
 * (`public_trust_claims()` → every gating control is `met` AND has fresh, non-failing evidence)
 * says so. Everything else, including any error, is "In progress". Fail closed.
 *
 * The wording of each claim is i18n (compliance:claims.<key>.*). A claim key not listed here is
 * never rendered, so adding a gate in the database cannot publish text that was never reviewed.
 */

export const CLAIM_KEYS = [
  'tenant_isolation_rls',
  'automated_security_scanning',
  'automated_ci_checks',
  'availability_monitoring',
  'vulnerability_disclosure',
  'backup_and_restore_testing',
  'enforced_mfa_for_staff',
  'independent_penetration_test',
] as const;

export type ClaimKey = (typeof CLAIM_KEYS)[number];
export type ClaimState = 'evidenced' | 'in_progress';

export interface ClaimView {
  key: ClaimKey;
  state: ClaimState;
  /** ISO date (YYYY-MM-DD, UTC) of the OLDEST latest evidence behind the claim; only when evidenced. */
  lastVerified: string | null;
}

export interface ClaimRow {
  claim_key: unknown;
  status: unknown;
  last_verified: unknown;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Reduces whatever the RPC returned to the reviewed claim list. Unknown/garbled input => in_progress. */
export function resolveClaims(rows: readonly ClaimRow[] | null | undefined): ClaimView[] {
  const byKey = new Map<string, ClaimRow>();
  for (const r of rows ?? []) if (typeof r?.claim_key === 'string') byKey.set(r.claim_key, r);
  return CLAIM_KEYS.map((key) => {
    const r = byKey.get(key);
    const evidenced = r?.status === 'evidenced' && typeof r.last_verified === 'string' && DATE_RE.test(r.last_verified);
    return { key, state: evidenced ? 'evidenced' : 'in_progress', lastVerified: evidenced ? (r!.last_verified as string) : null };
  });
}

export const allInProgress = (): ClaimView[] => resolveClaims(null);
