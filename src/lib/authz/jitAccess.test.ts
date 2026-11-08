import { describe, it, expect } from 'vitest';
import {
  BREAK_GLASS_REVIEW_HOURS,
  GRANT_LIMITS_MINUTES,
  breakGlass,
  canStartImpersonation,
  cancelGrant,
  decideGrant,
  effectivePermissions,
  grantState,
  requestGrant,
  revokeGrant,
  type AccessGrant,
  type Approver,
  type PermissionKey,
  type RequestGrantInput,
} from './jitAccess';

const T0 = '2026-11-05T09:00:00.000Z';
const at = (m: number): string => new Date(Date.parse(T0) + m * 60_000).toISOString();
const REASON = 'Quarter-end refund backlog needs billing access';

const input = (over: Partial<RequestGrantInput> = {}): RequestGrantInput => ({
  id: 'g1', kind: 'permission', requesterId: 'u1', permissions: ['can_issue_refunds'], tenantId: null, reason: REASON, minutes: 60, now: T0, ...over,
});
const owner: Approver = { userId: 'own', isOwner: true, permissions: {} };
const manager = (perms: Partial<Record<PermissionKey, boolean>>): Approver => ({ userId: 'mgr', isOwner: false, permissions: perms });

function pending(over: Partial<RequestGrantInput> = {}): AccessGrant {
  const r = requestGrant(input(over));
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('requestGrant validation', () => {
  it('requires a real reason, an in-range duration and valid permissions', () => {
    expect(requestGrant(input({ reason: 'too short' }))).toEqual({ ok: false, error: 'reason_too_short' });
    expect(requestGrant(input({ minutes: 4 }))).toEqual({ ok: false, error: 'duration_out_of_range' });
    expect(requestGrant(input({ minutes: GRANT_LIMITS_MINUTES.permission.max + 1 }))).toEqual({ ok: false, error: 'duration_out_of_range' });
    expect(requestGrant(input({ minutes: 30.5 }))).toEqual({ ok: false, error: 'duration_out_of_range' });
    expect(requestGrant(input({ permissions: [] }))).toEqual({ ok: false, error: 'no_permissions' });
    expect(requestGrant(input({ permissions: ['can_fly' as PermissionKey] }))).toEqual({ ok: false, error: 'unknown_permission' });
  });
  it('staff support needs a tenant and ignores permission lists', () => {
    expect(requestGrant(input({ kind: 'staff_support', tenantId: null, permissions: [] }))).toEqual({ ok: false, error: 'tenant_required' });
    const r = requestGrant(input({ kind: 'staff_support', tenantId: 't1', permissions: ['can_manage_security'], minutes: 60 }));
    expect(r.ok && r.value.permissions).toEqual([]);
  });
  it('de-duplicates permissions and starts pending', () => {
    const g = pending({ permissions: ['can_issue_refunds', 'can_issue_refunds'] });
    expect(g.permissions).toEqual(['can_issue_refunds']);
    expect(grantState(g, T0)).toBe('pending');
  });
});

describe('decideGrant', () => {
  it('forbids self approval and approvers who lack the permission being granted', () => {
    const g = pending();
    expect(decideGrant(g, { ...owner, userId: 'u1' }, true, at(1))).toEqual({ ok: false, error: 'self_approval_forbidden' });
    expect(decideGrant(g, manager({ can_view_billing: true }), true, at(1))).toEqual({ ok: false, error: 'approver_lacks_permission' });
    expect(decideGrant(g, manager({ can_issue_refunds: true }), true, at(1)).ok).toBe(true);
  });
  it('time-boxes the grant from the moment of approval, not request', () => {
    const res = decideGrant(pending(), owner, true, at(10));
    if (!res.ok) throw new Error(res.error);
    expect(res.value.startsAt).toBe(at(10));
    expect(res.value.expiresAt).toBe(at(70));
    expect(grantState(res.value, at(69))).toBe('active');
    expect(grantState(res.value, at(70))).toBe('expired');
  });
  it('deny is terminal and a decided grant cannot be decided again', () => {
    const denied = decideGrant(pending(), owner, false, at(1));
    if (!denied.ok) throw new Error(denied.error);
    expect(grantState(denied.value, at(2))).toBe('denied');
    expect(decideGrant(denied.value, owner, true, at(3))).toEqual({ ok: false, error: 'not_pending' });
  });
  it('staff support can only be approved by an owner of the tenant', () => {
    const g = pending({ kind: 'staff_support', tenantId: 't1', permissions: [], minutes: 60 });
    expect(decideGrant(g, manager({ can_manage_security: true }), true, at(1))).toEqual({ ok: false, error: 'approver_not_owner' });
    expect(decideGrant(g, owner, true, at(1)).ok).toBe(true);
  });
});

describe('revoke and cancel', () => {
  it('revokes only active grants and takes effect immediately', () => {
    const active = decideGrant(pending(), owner, true, at(1));
    if (!active.ok) throw new Error(active.error);
    expect(revokeGrant(pending(), at(1))).toEqual({ ok: false, error: 'not_active' });
    const r = revokeGrant(active.value, at(5));
    if (!r.ok) throw new Error(r.error);
    expect(grantState(r.value, at(5))).toBe('revoked');
    expect(grantState(r.value, at(4))).toBe('active');
  });
  it('only the requester cancels, only while pending', () => {
    const g = pending();
    expect(cancelGrant(g, 'other', at(1))).toEqual({ ok: false, error: 'not_requester' });
    const c = cancelGrant(g, 'u1', at(1));
    expect(c.ok && grantState(c.value, at(2))).toBe('cancelled');
  });
});

describe('break-glass', () => {
  it('is owner-only, short, needs another owner to notify, and is immediately active with a review deadline', () => {
    const bg = input({ kind: 'break_glass', requesterId: 'own', permissions: ['can_manage_security'], minutes: 30 });
    expect(breakGlass(bg, { isOwner: false }, ['o2'])).toEqual({ ok: false, error: 'owner_required' });
    expect(breakGlass(bg, { isOwner: true }, ['own'])).toEqual({ ok: false, error: 'no_other_owner_to_notify' });
    expect(breakGlass({ ...bg, minutes: 61 }, { isOwner: true }, ['o2'])).toEqual({ ok: false, error: 'duration_out_of_range' });
    expect(breakGlass({ ...bg, reason: 'short' }, { isOwner: true }, ['o2'])).toEqual({ ok: false, error: 'reason_too_short' });
    const ok = breakGlass(bg, { isOwner: true }, ['o2']);
    if (!ok.ok) throw new Error(ok.error);
    expect(grantState(ok.value, T0)).toBe('active');
    expect(ok.value.reviewDueAt).toBe(new Date(Date.parse(at(30)) + BREAK_GLASS_REVIEW_HOURS * 3_600_000).toISOString());
    expect(decideGrant(ok.value, owner, true, at(1))).toEqual({ ok: false, error: 'not_pending' });
  });
});

describe('effectivePermissions and impersonation tie-in', () => {
  const base: Record<PermissionKey, boolean> = {
    can_view_billing: false, can_manage_numbers: false, can_manage_team: false, can_edit_business_profile: false,
    can_view_all_jobs: false, can_view_audit_log: false, can_manage_security: false, can_issue_refunds: false, can_export_data: false,
  };
  it('adds only active grants of the same user and never mutates base', () => {
    const active = decideGrant(pending(), owner, true, at(1));
    if (!active.ok) throw new Error(active.error);
    expect(effectivePermissions(base, [active.value], 'u1', at(5)).can_issue_refunds).toBe(true);
    expect(effectivePermissions(base, [active.value], 'u1', at(100)).can_issue_refunds).toBe(false);
    expect(effectivePermissions(base, [active.value], 'someone-else', at(5)).can_issue_refunds).toBe(false);
    expect(base.can_issue_refunds).toBe(false);
  });
  it('impersonation requires an active customer-approved grant for that staff member and tenant', () => {
    const pend = pending({ kind: 'staff_support', requesterId: 'staff1', tenantId: 't1', permissions: [], minutes: 60 });
    expect(canStartImpersonation([pend], 'staff1', 't1', at(1))).toBeNull();
    const act = decideGrant(pend, owner, true, at(1));
    if (!act.ok) throw new Error(act.error);
    expect(canStartImpersonation([act.value], 'staff1', 't1', at(2))?.id).toBe('g1');
    expect(canStartImpersonation([act.value], 'staff2', 't1', at(2))).toBeNull();
    expect(canStartImpersonation([act.value], 'staff1', 't2', at(2))).toBeNull();
    expect(canStartImpersonation([act.value], 'staff1', 't1', at(62))).toBeNull();
  });
});
