/**
 * Ownership & org lifecycle (pure domain logic).
 *
 * Covers the decision rules only: transfer request -> target acceptance -> cooling-off
 * -> ready, owner-count invariants, org deletion hold, and the offboarding checklist.
 * The transfer state machine intentionally ends at `ready`: re-pointing tenant ownership
 * touches the owner-only RLS policies (see docs/security/identity-authz-audit.md, F1)
 * and is not implemented until that migration is verified against the live database.
 */

export const REAUTH_MAX_AGE_MINUTES = 5;
export const TRANSFER_COOLING_OFF_HOURS = 72;
export const TRANSFER_READY_WINDOW_DAYS = 7;
export const DELETION_HOLD_DAYS = 14;

const mins = (m: number): number => m * 60_000;
const hours = (h: number): number => h * 3_600_000;
const days = (d: number): number => d * 86_400_000;

export interface MemberRef {
  userId: string;
  isOwner: boolean;
  isActive: boolean;
  isGuest: boolean;
}

export interface OwnershipTransfer {
  id: string;
  tenantId: string;
  fromUserId: string;
  toUserId: string;
  requestedAt: string;
  acceptedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
}

export type TransferState = 'awaiting_target' | 'cooling_off' | 'ready' | 'expired' | 'cancelled';

export type TransferError =
  | 'not_owner'
  | 'reauth_required'
  | 'target_not_eligible'
  | 'self_transfer'
  | 'not_target'
  | 'not_awaiting_target'
  | 'not_cancellable';

export type TransferResult = { ok: true; value: OwnershipTransfer } | { ok: false; error: TransferError };

export function requestTransfer(
  id: string,
  tenantId: string,
  from: MemberRef,
  to: MemberRef,
  lastReauthAt: string | null,
  now: string,
): TransferResult {
  if (!from.isOwner || !from.isActive) return { ok: false, error: 'not_owner' };
  if (from.userId === to.userId) return { ok: false, error: 'self_transfer' };
  if (!to.isActive || to.isGuest) return { ok: false, error: 'target_not_eligible' };
  if (lastReauthAt === null || Date.parse(now) - Date.parse(lastReauthAt) > mins(REAUTH_MAX_AGE_MINUTES)) {
    return { ok: false, error: 'reauth_required' };
  }
  return {
    ok: true,
    value: { id, tenantId, fromUserId: from.userId, toUserId: to.userId, requestedAt: now, acceptedAt: null, cancelledAt: null, cancelledBy: null },
  };
}

export function transferState(t: OwnershipTransfer, now: string): TransferState {
  if (t.cancelledAt !== null) return 'cancelled';
  if (t.acceptedAt === null) return 'awaiting_target';
  const ready = Date.parse(t.acceptedAt) + hours(TRANSFER_COOLING_OFF_HOURS);
  if (Date.parse(now) < ready) return 'cooling_off';
  return Date.parse(now) >= ready + days(TRANSFER_READY_WINDOW_DAYS) ? 'expired' : 'ready';
}

export function acceptTransfer(t: OwnershipTransfer, userId: string, lastReauthAt: string | null, now: string): TransferResult {
  if (userId !== t.toUserId) return { ok: false, error: 'not_target' };
  if (transferState(t, now) !== 'awaiting_target') return { ok: false, error: 'not_awaiting_target' };
  if (lastReauthAt === null || Date.parse(now) - Date.parse(lastReauthAt) > mins(REAUTH_MAX_AGE_MINUTES)) {
    return { ok: false, error: 'reauth_required' };
  }
  return { ok: true, value: { ...t, acceptedAt: now } };
}

/** Either party, or any other owner, can cancel until the transfer is ready/expired. */
export function cancelTransfer(t: OwnershipTransfer, actor: MemberRef, now: string): TransferResult {
  const state = transferState(t, now);
  if (state === 'ready' || state === 'expired' || state === 'cancelled') return { ok: false, error: 'not_cancellable' };
  const allowed = actor.isActive && (actor.userId === t.fromUserId || actor.userId === t.toUserId || actor.isOwner);
  if (!allowed) return { ok: false, error: 'not_owner' };
  return { ok: true, value: { ...t, cancelledAt: now, cancelledBy: actor.userId } };
}

/** Everyone who must be notified at each transfer event (never empty for the owner set). */
export function transferRecipients(t: OwnershipTransfer, owners: readonly string[]): string[] {
  return [...new Set([...owners, t.fromUserId, t.toUserId])];
}

// ---------------------------------------------------------------- owner invariants

export type OwnerRemovalError = 'last_owner' | 'not_an_owner';

/** An org must always keep at least one active owner; co-owners make recovery possible. */
export function canRemoveOwner(owners: readonly MemberRef[], userId: string): OwnerRemovalError | null {
  const target = owners.find((o) => o.userId === userId && o.isOwner);
  if (!target) return 'not_an_owner';
  const activeOwners = owners.filter((o) => o.isOwner && o.isActive);
  return activeOwners.length <= 1 ? 'last_owner' : null;
}

export function hasRecoveryOwner(owners: readonly MemberRef[]): boolean {
  return owners.filter((o) => o.isOwner && o.isActive).length >= 2;
}

// ---------------------------------------------------------------- org deletion hold

export interface DeletionRequest {
  id: string;
  tenantId: string;
  requestedBy: string;
  requestedAt: string;
  cancelledAt: string | null;
}

export type DeletionState = 'on_hold' | 'purge_eligible' | 'cancelled';
export type DeletionError = 'not_owner' | 'reauth_required' | 'not_on_hold';

export function requestDeletion(
  id: string,
  tenantId: string,
  actor: MemberRef,
  lastReauthAt: string | null,
  now: string,
): { ok: true; value: DeletionRequest } | { ok: false; error: DeletionError } {
  if (!actor.isOwner || !actor.isActive) return { ok: false, error: 'not_owner' };
  if (lastReauthAt === null || Date.parse(now) - Date.parse(lastReauthAt) > mins(REAUTH_MAX_AGE_MINUTES)) {
    return { ok: false, error: 'reauth_required' };
  }
  return { ok: true, value: { id, tenantId, requestedBy: actor.userId, requestedAt: now, cancelledAt: null } };
}

export function deletionState(d: DeletionRequest, now: string): DeletionState {
  if (d.cancelledAt !== null) return 'cancelled';
  return Date.parse(now) >= Date.parse(d.requestedAt) + days(DELETION_HOLD_DAYS) ? 'purge_eligible' : 'on_hold';
}

/** Any active owner (not only the requester) can cancel during the hold. */
export function cancelDeletion(
  d: DeletionRequest,
  actor: MemberRef,
  now: string,
): { ok: true; value: DeletionRequest } | { ok: false; error: DeletionError } {
  if (!actor.isOwner || !actor.isActive) return { ok: false, error: 'not_owner' };
  if (deletionState(d, now) !== 'on_hold') return { ok: false, error: 'not_on_hold' };
  return { ok: true, value: { ...d, cancelledAt: now } };
}

// ---------------------------------------------------------------- offboarding

export interface OffboardingInventory {
  isOwner: boolean;
  openJobs: number;
  ownedRecords: number;
  apiKeys: number;
  activeSessions: number;
  activeGrants: number;
  guestInvitesCreated: number;
  /** Approval-chain steps where this member is the ONLY eligible approver. */
  soleApproverSteps: number;
  approverSlots: number;
  delegationsGiven: number;
  delegationsReceived: number;
}

export type OffboardingStepKey =
  | 'transfer_ownership'
  | 'fix_sole_approver_chains'
  | 'reassign_jobs'
  | 'reassign_records'
  | 'remove_from_approval_chains'
  | 'end_delegations'
  | 'revoke_guest_invites'
  | 'revoke_grants'
  | 'revoke_api_keys'
  | 'revoke_sessions'
  | 'deactivate';

export interface OffboardingStep {
  key: OffboardingStepKey;
  count: number;
  /** Blocks every later step until done. */
  blocking: boolean;
  done: boolean;
}

/**
 * Ordered checklist. Ownership and sole-approver chains block everything else
 * (deactivating them first would orphan the org or make an approval chain unsatisfiable).
 * `deactivate` is always last and only appears once everything else is resolvable.
 */
export function buildOffboardingPlan(inv: OffboardingInventory): OffboardingStep[] {
  const step = (key: OffboardingStepKey, count: number, blocking = false): OffboardingStep => ({ key, count, blocking, done: count === 0 });
  const plan: OffboardingStep[] = [];
  if (inv.isOwner) plan.push({ key: 'transfer_ownership', count: 1, blocking: true, done: false });
  plan.push(step('fix_sole_approver_chains', inv.soleApproverSteps, true));
  plan.push(step('reassign_jobs', inv.openJobs));
  plan.push(step('reassign_records', inv.ownedRecords));
  plan.push(step('remove_from_approval_chains', Math.max(0, inv.approverSlots - inv.soleApproverSteps)));
  plan.push(step('end_delegations', inv.delegationsGiven + inv.delegationsReceived));
  plan.push(step('revoke_guest_invites', inv.guestInvitesCreated));
  plan.push(step('revoke_grants', inv.activeGrants));
  plan.push(step('revoke_api_keys', inv.apiKeys));
  plan.push(step('revoke_sessions', inv.activeSessions));
  plan.push({ key: 'deactivate', count: 1, blocking: false, done: false });
  return plan;
}

/** The next step the UI should enable: first unfinished step; blocking steps stop the walk. */
export function nextOffboardingStep(plan: readonly OffboardingStep[]): OffboardingStep | null {
  for (const s of plan) if (!s.done) return s;
  return null;
}

export function canDeactivate(plan: readonly OffboardingStep[]): boolean {
  return plan.filter((s) => s.key !== 'deactivate').every((s) => s.done);
}
