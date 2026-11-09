/**
 * Commercial pack — PO / not-to-exceed (NTE) checks and the work-order approval state machine (PURE).
 * The database re-enforces the same rules (commercial_pack migration); this mirror gives instant UI feedback.
 */

export type ApproverRole = 'manager' | 'owner';
const RANK: Record<ApproverRole, number> = { manager: 1, owner: 2 };

export interface ApprovalTier {
  /** Inclusive upper bound in cents; null = open-ended top tier. */
  upToCents: number | null;
  /** Ordered approval steps required at this amount. */
  steps: ApproverRole[];
}

/** Default policy: ≤ $2,500 manager; ≤ $25,000 manager then owner; above that manager then owner (same chain, explicit). */
export const DEFAULT_TIERS: ApprovalTier[] = [
  { upToCents: 250_000, steps: ['manager'] },
  { upToCents: null, steps: ['manager', 'owner'] },
];

export function validateTiers(tiers: ApprovalTier[]): string[] {
  const errors: string[] = [];
  if (!tiers.length) return ['At least one tier is required'];
  let prev = -1;
  tiers.forEach((t, i) => {
    if (t.steps.length === 0 || t.steps.length > 3) errors.push(`Tier ${i + 1}: 1–3 steps required`);
    if (t.upToCents === null) {
      if (i !== tiers.length - 1) errors.push('Only the last tier can be open-ended');
    } else {
      if (!Number.isInteger(t.upToCents) || t.upToCents <= prev) errors.push(`Tier ${i + 1}: limits must be increasing whole cents`);
      prev = t.upToCents;
    }
  });
  if (tiers[tiers.length - 1].upToCents !== null) errors.push('The last tier must be open-ended');
  return errors;
}

export function requiredSteps(tiers: ApprovalTier[], amountCents: number): ApproverRole[] {
  if (!Number.isInteger(amountCents) || amountCents < 0) throw new RangeError('amountCents must be a non-negative integer');
  const tier = tiers.find((t) => t.upToCents === null || amountCents <= t.upToCents);
  if (!tier) throw new RangeError('No approval tier matches this amount');
  return [...tier.steps];
}

/* ---------------- NTE ---------------- */

export interface NteCheck {
  ok: boolean;
  /** Cents still available under the cap; null when there is no cap. */
  remainingCents: number | null;
  overByCents: number;
  /** Share of the cap already committed (0–100+), null without a cap. */
  usedPct: number | null;
}

export function nteCheck(nteCents: number | null, committedCents: number, proposedCents: number): NteCheck {
  for (const n of [committedCents, proposedCents]) if (!Number.isInteger(n) || n < 0) throw new RangeError('Amounts must be non-negative whole cents');
  if (nteCents == null) return { ok: true, remainingCents: null, overByCents: 0, usedPct: null };
  const after = committedCents + proposedCents;
  const over = Math.max(0, after - nteCents);
  return {
    ok: over === 0,
    remainingCents: Math.max(0, nteCents - committedCents),
    overByCents: over,
    usedPct: nteCents === 0 ? (after > 0 ? Infinity : 0) : Math.round((after / nteCents) * 1000) / 10,
  };
}

/* ---------------- state machine ---------------- */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ApprovalState {
  requesterId: string;
  required: ApproverRole[];
  approvals: Array<{ role: ApproverRole; userId: string }>;
  status: ApprovalStatus;
}

export interface Decision {
  userId: string;
  /** The highest role the user holds for this account. */
  role: ApproverRole;
  decision: 'approve' | 'reject';
}

export function newApproval(requesterId: string, required: ApproverRole[]): ApprovalState {
  if (!required.length) throw new RangeError('An approval needs at least one step');
  return { requesterId, required, approvals: [], status: 'pending' };
}

export function nextRole(s: ApprovalState): ApproverRole | null {
  return s.status === 'pending' ? s.required[s.approvals.length] ?? null : null;
}

export type DecisionError = 'not_pending' | 'self_approval' | 'insufficient_role' | 'already_decided';

/** Pure reducer: returns the new state or an error code (state untouched). */
export function applyDecision(s: ApprovalState, d: Decision): { state: ApprovalState } | { error: DecisionError } {
  if (s.status !== 'pending') return { error: 'not_pending' };
  if (d.userId === s.requesterId) return { error: 'self_approval' };
  const need = nextRole(s);
  if (!need || RANK[d.role] < RANK[need]) return { error: 'insufficient_role' };
  if (s.approvals.some((a) => a.userId === d.userId)) return { error: 'already_decided' };
  if (d.decision === 'reject') return { state: { ...s, status: 'rejected' } };
  const approvals = [...s.approvals, { role: need, userId: d.userId }];
  return { state: { ...s, approvals, status: approvals.length >= s.required.length ? 'approved' : 'pending' } };
}
