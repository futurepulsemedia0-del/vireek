import { describe, it, expect } from 'vitest';
import {
  DELETION_HOLD_DAYS,
  REAUTH_MAX_AGE_MINUTES,
  TRANSFER_COOLING_OFF_HOURS,
  TRANSFER_READY_WINDOW_DAYS,
  acceptTransfer,
  buildOffboardingPlan,
  canDeactivate,
  canRemoveOwner,
  cancelDeletion,
  cancelTransfer,
  deletionState,
  hasRecoveryOwner,
  nextOffboardingStep,
  requestDeletion,
  requestTransfer,
  transferRecipients,
  transferState,
  type MemberRef,
  type OffboardingInventory,
  type OwnershipTransfer,
} from './ownership';

const T0 = '2026-11-05T09:00:00.000Z';
const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
const H = 3_600_000;
const D = 24 * H;

const owner: MemberRef = { userId: 'own', isOwner: true, isActive: true, isGuest: false };
const member: MemberRef = { userId: 'mem', isOwner: false, isActive: true, isGuest: false };
const fresh = plus(T0, -60_000);

function requested(): OwnershipTransfer {
  const r = requestTransfer('t1', 'tenant', owner, member, fresh, T0);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
function accepted(at = T0): OwnershipTransfer {
  const r = acceptTransfer(requested(), 'mem', plus(at, -1000), at);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('requestTransfer', () => {
  it('requires an active owner, a different eligible target, and a fresh re-auth', () => {
    expect(requestTransfer('t', 'x', member, owner, fresh, T0)).toEqual({ ok: false, error: 'not_owner' });
    expect(requestTransfer('t', 'x', { ...owner, isActive: false }, member, fresh, T0)).toEqual({ ok: false, error: 'not_owner' });
    expect(requestTransfer('t', 'x', owner, owner, fresh, T0)).toEqual({ ok: false, error: 'self_transfer' });
    expect(requestTransfer('t', 'x', owner, { ...member, isGuest: true }, fresh, T0)).toEqual({ ok: false, error: 'target_not_eligible' });
    expect(requestTransfer('t', 'x', owner, { ...member, isActive: false }, fresh, T0)).toEqual({ ok: false, error: 'target_not_eligible' });
    expect(requestTransfer('t', 'x', owner, member, null, T0)).toEqual({ ok: false, error: 'reauth_required' });
    expect(requestTransfer('t', 'x', owner, member, plus(T0, -(REAUTH_MAX_AGE_MINUTES * 60_000 + 1)), T0)).toEqual({ ok: false, error: 'reauth_required' });
    expect(requestTransfer('t', 'x', owner, member, plus(T0, -REAUTH_MAX_AGE_MINUTES * 60_000), T0).ok).toBe(true);
  });
});

describe('transfer lifecycle', () => {
  it('awaiting target -> cooling off -> ready -> expired', () => {
    expect(transferState(requested(), T0)).toBe('awaiting_target');
    const t = accepted();
    expect(transferState(t, plus(T0, TRANSFER_COOLING_OFF_HOURS * H - 1))).toBe('cooling_off');
    expect(transferState(t, plus(T0, TRANSFER_COOLING_OFF_HOURS * H))).toBe('ready');
    expect(transferState(t, plus(T0, TRANSFER_COOLING_OFF_HOURS * H + TRANSFER_READY_WINDOW_DAYS * D))).toBe('expired');
  });
  it('only the target accepts, once, with a fresh re-auth', () => {
    const t = requested();
    expect(acceptTransfer(t, 'own', fresh, T0)).toEqual({ ok: false, error: 'not_target' });
    expect(acceptTransfer(t, 'mem', null, T0)).toEqual({ ok: false, error: 'reauth_required' });
    expect(acceptTransfer(accepted(), 'mem', fresh, plus(T0, H))).toEqual({ ok: false, error: 'not_awaiting_target' });
  });
  it('either party or any active owner can cancel before ready; nobody after', () => {
    const t = accepted();
    const during = plus(T0, H);
    expect(cancelTransfer(t, owner, during).ok).toBe(true);
    expect(cancelTransfer(t, member, during).ok).toBe(true);
    expect(cancelTransfer(t, { userId: 'o2', isOwner: true, isActive: true, isGuest: false }, during).ok).toBe(true);
    expect(cancelTransfer(t, { userId: 'rando', isOwner: false, isActive: true, isGuest: false }, during)).toEqual({ ok: false, error: 'not_owner' });
    expect(cancelTransfer(t, owner, plus(T0, TRANSFER_COOLING_OFF_HOURS * H))).toEqual({ ok: false, error: 'not_cancellable' });
    const c = cancelTransfer(t, owner, during);
    if (c.ok) {
      expect(transferState(c.value, during)).toBe('cancelled');
      expect(cancelTransfer(c.value, owner, during)).toEqual({ ok: false, error: 'not_cancellable' });
    }
  });
  it('notifies every owner plus both parties, without duplicates', () => {
    expect(transferRecipients(requested(), ['own', 'o2']).sort()).toEqual(['mem', 'o2', 'own']);
  });
});

describe('owner invariants', () => {
  it('never allows removing the last active owner; allows it with a co-owner', () => {
    expect(canRemoveOwner([owner], 'own')).toBe('last_owner');
    expect(canRemoveOwner([owner, { ...owner, userId: 'o2', isActive: false }], 'own')).toBe('last_owner');
    expect(canRemoveOwner([owner, { ...owner, userId: 'o2' }], 'own')).toBeNull();
    expect(canRemoveOwner([owner], 'mem')).toBe('not_an_owner');
  });
  it('recovery requires a second active owner', () => {
    expect(hasRecoveryOwner([owner])).toBe(false);
    expect(hasRecoveryOwner([owner, { ...owner, userId: 'o2' }])).toBe(true);
    expect(hasRecoveryOwner([owner, { ...owner, userId: 'o2', isActive: false }])).toBe(false);
  });
});

describe('org deletion hold', () => {
  it('needs an active owner and fresh re-auth, then holds before purge eligibility', () => {
    expect(requestDeletion('d', 't', member, fresh, T0)).toEqual({ ok: false, error: 'not_owner' });
    expect(requestDeletion('d', 't', owner, null, T0)).toEqual({ ok: false, error: 'reauth_required' });
    const r = requestDeletion('d', 't', owner, fresh, T0);
    if (!r.ok) throw new Error(r.error);
    expect(deletionState(r.value, plus(T0, DELETION_HOLD_DAYS * D - 1))).toBe('on_hold');
    expect(deletionState(r.value, plus(T0, DELETION_HOLD_DAYS * D))).toBe('purge_eligible');
  });
  it('any active owner can cancel during the hold, but not after it ends or once cancelled', () => {
    const r = requestDeletion('d', 't', owner, fresh, T0);
    if (!r.ok) throw new Error(r.error);
    expect(cancelDeletion(r.value, member, T0)).toEqual({ ok: false, error: 'not_owner' });
    const c = cancelDeletion(r.value, { ...owner, userId: 'o2' }, plus(T0, D));
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(deletionState(c.value, plus(T0, 30 * D))).toBe('cancelled');
      expect(cancelDeletion(c.value, owner, plus(T0, 2 * D))).toEqual({ ok: false, error: 'not_on_hold' });
    }
    expect(cancelDeletion(r.value, owner, plus(T0, DELETION_HOLD_DAYS * D))).toEqual({ ok: false, error: 'not_on_hold' });
  });
});

describe('offboarding plan', () => {
  const inv = (over: Partial<OffboardingInventory> = {}): OffboardingInventory => ({
    isOwner: false, openJobs: 0, ownedRecords: 0, apiKeys: 0, activeSessions: 0, activeGrants: 0, guestInvitesCreated: 0,
    soleApproverSteps: 0, approverSlots: 0, delegationsGiven: 0, delegationsReceived: 0, ...over,
  });
  it('puts ownership first for owners and always ends with deactivate', () => {
    const plan = buildOffboardingPlan(inv({ isOwner: true }));
    expect(plan[0]?.key).toBe('transfer_ownership');
    expect(plan.at(-1)?.key).toBe('deactivate');
    expect(buildOffboardingPlan(inv())[0]?.key).toBe('fix_sole_approver_chains');
  });
  it('a clean member can be deactivated immediately; blockers and counts prevent it', () => {
    expect(canDeactivate(buildOffboardingPlan(inv()))).toBe(true);
    expect(nextOffboardingStep(buildOffboardingPlan(inv()))?.key).toBe('deactivate');
    const busy = buildOffboardingPlan(inv({ openJobs: 3, apiKeys: 1, soleApproverSteps: 1, approverSlots: 2 }));
    expect(canDeactivate(busy)).toBe(false);
    expect(nextOffboardingStep(busy)?.key).toBe('fix_sole_approver_chains');
    expect(busy.find((s) => s.key === 'reassign_jobs')?.count).toBe(3);
    expect(busy.find((s) => s.key === 'remove_from_approval_chains')?.count).toBe(1);
  });
  it('blocks deactivation for owners until ownership is transferred', () => {
    const plan = buildOffboardingPlan(inv({ isOwner: true }));
    expect(canDeactivate(plan)).toBe(false);
    expect(plan[0]?.blocking).toBe(true);
  });
  it('counts delegations in both directions', () => {
    const plan = buildOffboardingPlan(inv({ delegationsGiven: 1, delegationsReceived: 2 }));
    expect(plan.find((s) => s.key === 'end_delegations')?.count).toBe(3);
  });
});
