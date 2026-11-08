/**
 * Just-in-time elevated access (pure domain logic).
 *
 * request -> approve -> time-boxed grant -> auto-expire -> audit.
 * Also covers owner break-glass and customer-approved staff support access.
 *
 * Rules mirrored in SQL (`authz_access_grants` constraints and the
 * `authz_decide_access_grant` / `authz_has_active_grant` functions).
 */
import type { UserPermissions } from '@/contexts/AuthContext';

export type PermissionKey = keyof UserPermissions;

/** Typed against UserPermissions: a key that no longer exists fails the typecheck. */
export const ELEVATABLE_PERMISSIONS: readonly PermissionKey[] = [
  'can_view_billing',
  'can_manage_numbers',
  'can_manage_team',
  'can_edit_business_profile',
  'can_view_all_jobs',
  'can_view_audit_log',
  'can_manage_security',
  'can_issue_refunds',
  'can_export_data',
];

export type GrantKind = 'permission' | 'staff_support' | 'break_glass';

export const GRANT_LIMITS_MINUTES: Readonly<Record<GrantKind, { min: number; max: number }>> = {
  permission: { min: 5, max: 8 * 60 },
  staff_support: { min: 15, max: 4 * 60 },
  break_glass: { min: 5, max: 60 },
};

export const MIN_REASON_CHARS = 15;
/** Break-glass use must be reviewed by another owner within this window after it ends. */
export const BREAK_GLASS_REVIEW_HOURS = 24;

export type GrantState = 'pending' | 'active' | 'expired' | 'revoked' | 'denied' | 'cancelled';

export interface AccessGrant {
  id: string;
  kind: GrantKind;
  requesterId: string;
  /** For permission/break_glass: the permissions being elevated. For staff_support: empty. */
  permissions: readonly PermissionKey[];
  /** For staff_support: the tenant whose data staff may access. */
  tenantId: string | null;
  reason: string;
  requestedMinutes: number;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  denied: boolean;
  cancelledAt: string | null;
  reviewDueAt: string | null;
}

export type GrantError =
  | 'reason_too_short'
  | 'duration_out_of_range'
  | 'no_permissions'
  | 'unknown_permission'
  | 'tenant_required'
  | 'not_pending'
  | 'self_approval_forbidden'
  | 'approver_lacks_permission'
  | 'approver_not_owner'
  | 'owner_required'
  | 'no_other_owner_to_notify'
  | 'not_requester'
  | 'not_active';

export type GrantResult = { ok: true; value: AccessGrant } | { ok: false; error: GrantError };

export interface RequestGrantInput {
  id: string;
  kind: GrantKind;
  requesterId: string;
  permissions: readonly PermissionKey[];
  tenantId: string | null;
  reason: string;
  minutes: number;
  now: string;
}

const addMinutes = (iso: string, m: number): string => new Date(Date.parse(iso) + m * 60_000).toISOString();

export function validateRequest(input: Omit<RequestGrantInput, 'id' | 'now'>): GrantError | null {
  if (input.reason.trim().length < MIN_REASON_CHARS) return 'reason_too_short';
  const limits = GRANT_LIMITS_MINUTES[input.kind];
  if (!Number.isInteger(input.minutes) || input.minutes < limits.min || input.minutes > limits.max) return 'duration_out_of_range';
  if (input.kind === 'staff_support') {
    if (!input.tenantId) return 'tenant_required';
    return null;
  }
  if (input.permissions.length === 0) return 'no_permissions';
  if (input.permissions.some((p) => !ELEVATABLE_PERMISSIONS.includes(p))) return 'unknown_permission';
  return null;
}

export function requestGrant(input: RequestGrantInput): GrantResult {
  const error = validateRequest(input);
  if (error) return { ok: false, error };
  return {
    ok: true,
    value: {
      id: input.id,
      kind: input.kind,
      requesterId: input.requesterId,
      permissions: input.kind === 'staff_support' ? [] : [...new Set(input.permissions)],
      tenantId: input.tenantId,
      reason: input.reason.trim(),
      requestedMinutes: input.minutes,
      requestedAt: input.now,
      decidedBy: null,
      decidedAt: null,
      startsAt: null,
      expiresAt: null,
      revokedAt: null,
      denied: false,
      cancelledAt: null,
      reviewDueAt: null,
    },
  };
}

export function grantState(g: AccessGrant, now: string): GrantState {
  const t = Date.parse(now);
  if (g.cancelledAt !== null) return 'cancelled';
  if (g.denied) return 'denied';
  if (g.decidedAt === null) return 'pending';
  if (g.revokedAt !== null && Date.parse(g.revokedAt) <= t) return 'revoked';
  if (g.expiresAt !== null && Date.parse(g.expiresAt) <= t) return 'expired';
  if (g.startsAt !== null && Date.parse(g.startsAt) <= t) return 'active';
  return 'pending';
}

export interface Approver {
  userId: string;
  isOwner: boolean;
  permissions: Readonly<Partial<Record<PermissionKey, boolean>>>;
}

/**
 * Approve (or deny) a pending request. The approver must not be the requester and
 * cannot grant what they do not hold themselves; staff support access can only be
 * approved by an owner of the tenant being accessed.
 */
export function decideGrant(g: AccessGrant, approver: Approver, approve: boolean, now: string): GrantResult {
  if (grantState(g, now) !== 'pending' || g.kind === 'break_glass') return { ok: false, error: 'not_pending' };
  if (approver.userId === g.requesterId) return { ok: false, error: 'self_approval_forbidden' };
  if (g.kind === 'staff_support' && !approver.isOwner) return { ok: false, error: 'approver_not_owner' };
  if (g.kind === 'permission' && !approver.isOwner && g.permissions.some((p) => approver.permissions[p] !== true)) {
    return { ok: false, error: 'approver_lacks_permission' };
  }
  if (!approve) return { ok: true, value: { ...g, denied: true, decidedBy: approver.userId, decidedAt: now } };
  return {
    ok: true,
    value: {
      ...g,
      decidedBy: approver.userId,
      decidedAt: now,
      startsAt: now,
      expiresAt: addMinutes(now, g.requestedMinutes),
    },
  };
}

/**
 * Owner break-glass: immediate, short, loudly notified, mandatory post-review.
 * Requires at least one other owner/co-owner to notify (otherwise nobody could ever review it).
 */
export function breakGlass(input: RequestGrantInput, requester: { isOwner: boolean }, otherOwnerIds: readonly string[]): GrantResult {
  if (!requester.isOwner) return { ok: false, error: 'owner_required' };
  const requested = requestGrant({ ...input, kind: 'break_glass' });
  if (!requested.ok) return requested;
  if (otherOwnerIds.filter((id) => id !== input.requesterId).length === 0) return { ok: false, error: 'no_other_owner_to_notify' };
  const expiresAt = addMinutes(input.now, input.minutes);
  return {
    ok: true,
    value: {
      ...requested.value,
      decidedBy: input.requesterId,
      decidedAt: input.now,
      startsAt: input.now,
      expiresAt,
      reviewDueAt: addMinutes(expiresAt, BREAK_GLASS_REVIEW_HOURS * 60),
    },
  };
}

export function revokeGrant(g: AccessGrant, now: string): GrantResult {
  if (grantState(g, now) !== 'active') return { ok: false, error: 'not_active' };
  return { ok: true, value: { ...g, revokedAt: now } };
}

export function cancelGrant(g: AccessGrant, userId: string, now: string): GrantResult {
  if (userId !== g.requesterId) return { ok: false, error: 'not_requester' };
  if (grantState(g, now) !== 'pending') return { ok: false, error: 'not_pending' };
  return { ok: true, value: { ...g, cancelledAt: now } };
}

/** Base permissions plus every permission from this user's currently active grants. */
export function effectivePermissions(
  base: Readonly<Record<PermissionKey, boolean>>,
  grants: readonly AccessGrant[],
  userId: string,
  now: string,
): Record<PermissionKey, boolean> {
  const out: Record<PermissionKey, boolean> = { ...base };
  for (const g of grants) {
    if (g.requesterId !== userId || g.kind === 'staff_support' || grantState(g, now) !== 'active') continue;
    for (const p of g.permissions) out[p] = true;
  }
  return out;
}

/** Staff may only impersonate a tenant while a customer-approved, active grant for that tenant exists. */
export function canStartImpersonation(grants: readonly AccessGrant[], staffId: string, tenantId: string, now: string): AccessGrant | null {
  return (
    grants.find(
      (g) => g.kind === 'staff_support' && g.requesterId === staffId && g.tenantId === tenantId && grantState(g, now) === 'active',
    ) ?? null
  );
}
