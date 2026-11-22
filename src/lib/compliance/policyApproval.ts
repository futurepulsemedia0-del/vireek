/**
 * Presentation + validation logic for the policy approval workflow (/staff/compliance-policies).
 * The review-state rule lives ONCE, in SQL (`compliance_policy_review_state`); this file only validates
 * input, summarises what `staff_policy_overview()` returns and builds exports.
 *
 * READINESS tooling: an approval record is not an attestation that a policy is followed.
 */

export type ReviewState = 'never_approved' | 'content_changed' | 'overdue' | 'review_due' | 'current';

export interface CurrentApproval {
  version_id: string;
  version: string;
  approved_at: string;
  effective_on: string;
  next_review_due: string;
  approver_id: string;
  approver_email: string | null;
  self_approved: boolean;
  ack_count: number;
  i_acknowledged: boolean;
}

export interface PendingVersion {
  version_id: string;
  version: string;
  submitted_at: string;
  submitted_by: string;
  change_summary: string | null;
  hash_matches_repo: boolean;
}

export interface PolicyRow {
  slug: string;
  title: string;
  source_path: string;
  control_ids: string[];
  review_frequency_days: number;
  requires_acknowledgement: boolean;
  repo_synced: boolean;
  review_state: ReviewState;
  current: CurrentApproval | null;
  pending: PendingVersion | null;
}

export interface PolicyOverview {
  generated_at: string;
  active_staff: number;
  me: string;
  policies: PolicyRow[];
}

export interface AckMatrix {
  policy: string;
  version_id: string | null;
  staff: { id: string; email: string; acknowledged_at: string | null }[];
}

export const REVIEW_STATE_ORDER: Record<ReviewState, number> = {
  content_changed: 0,
  overdue: 1,
  never_approved: 2,
  review_due: 3,
  current: 4,
};

const VERSION_RE = /^(\d{1,3})\.(\d{1,3})$/;

export function parseVersion(v: string): [number, number] | null {
  const m = VERSION_RE.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Mirrors the SQL rule: a new version must be strictly greater than the latest existing one. */
export function isNewerVersion(candidate: string, latest: string | null): boolean {
  const c = parseVersion(candidate);
  if (!c) return false;
  if (!latest) return true;
  const l = parseVersion(latest);
  if (!l) return true;
  return c[0] > l[0] || (c[0] === l[0] && c[1] > l[1]);
}

/** Suggest the next minor version (1.0 -> 1.1). First version is 1.0. */
export function suggestNextVersion(latest: string | null): string {
  const l = latest ? parseVersion(latest) : null;
  return l ? `${l[0]}.${Math.min(l[1] + 1, 999)}` : '1.0';
}

export type SubmitError = 'version_format' | 'version_not_newer' | 'summary_too_long' | 'hash_not_synced' | 'already_in_review';

export function validateSubmit(input: { version: string; changeSummary: string }, row: Pick<PolicyRow, 'repo_synced' | 'pending'>, latestVersion: string | null): SubmitError[] {
  const errors: SubmitError[] = [];
  if (!parseVersion(input.version)) errors.push('version_format');
  else if (!isNewerVersion(input.version, latestVersion)) errors.push('version_not_newer');
  if (input.changeSummary.trim().length > 300) errors.push('summary_too_long');
  if (!row.repo_synced) errors.push('hash_not_synced');
  if (row.pending) errors.push('already_in_review');
  return errors;
}

/** Latest known version of a policy (current or pending), used to validate/suggest the next one. */
export function latestKnownVersion(row: Pick<PolicyRow, 'current' | 'pending'>): string | null {
  const vs = [row.current?.version, row.pending?.version].filter((x): x is string => Boolean(x));
  let best: string | null = null;
  for (const v of vs) if (isNewerVersion(v, best)) best = v;
  return best;
}

/** An approver may not be the submitter without it being recorded as self-approval. */
export const isSelfApproval = (pending: Pick<PendingVersion, 'submitted_by'>, me: string): boolean => pending.submitted_by === me;

export function pendingAcknowledgements(row: PolicyRow, activeStaff: number): number {
  if (!row.current || !row.requires_acknowledgement) return 0;
  return Math.max(activeStaff - row.current.ack_count, 0);
}

export interface PolicySummary {
  total: number;
  byState: Record<ReviewState, number>;
  selfApproved: number;
  pendingAcknowledgements: number;
  inReview: number;
}

export function summarizePolicies(o: PolicyOverview): PolicySummary {
  const byState: Record<ReviewState, number> = { never_approved: 0, content_changed: 0, overdue: 0, review_due: 0, current: 0 };
  let selfApproved = 0;
  let pendingAcks = 0;
  let inReview = 0;
  for (const p of o.policies) {
    byState[p.review_state] += 1;
    if (p.current?.self_approved) selfApproved += 1;
    if (p.pending) inReview += 1;
    pendingAcks += pendingAcknowledgements(p, o.active_staff);
  }
  return { total: o.policies.length, byState, selfApproved, pendingAcknowledgements: pendingAcks, inReview };
}

export function sortPolicies(rows: PolicyRow[]): PolicyRow[] {
  return [...rows].sort((a, b) => REVIEW_STATE_ORDER[a.review_state] - REVIEW_STATE_ORDER[b.review_state] || a.slug.localeCompare(b.slug));
}

export const needsAttention = (p: PolicyRow): boolean => p.review_state !== 'current';

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection as well as quoting.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function buildPolicyCsv(o: PolicyOverview): string {
  const head = ['policy', 'review_state', 'version', 'approved_at', 'effective_on', 'next_review_due', 'approver', 'self_approved', 'acknowledged', 'active_staff'];
  const lines = sortPolicies(o.policies).map((p) =>
    [p.slug, p.review_state, p.current?.version, p.current?.approved_at, p.current?.effective_on, p.current?.next_review_due, p.current?.approver_email, p.current?.self_approved, p.current?.ack_count, o.active_staff].map(csvCell).join(','),
  );
  return [head.join(','), ...lines].join('\n') + '\n';
}
