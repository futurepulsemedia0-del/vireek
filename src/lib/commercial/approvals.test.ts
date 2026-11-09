import { describe, it, expect } from 'vitest';
import { applyDecision, DEFAULT_TIERS, newApproval, nextRole, nteCheck, requiredSteps, validateTiers } from './approvals';

describe('tiers', () => {
  it('default policy is valid and picks steps by amount', () => {
    expect(validateTiers(DEFAULT_TIERS)).toEqual([]);
    expect(requiredSteps(DEFAULT_TIERS, 250_000)).toEqual(['manager']);
    expect(requiredSteps(DEFAULT_TIERS, 250_001)).toEqual(['manager', 'owner']);
    expect(requiredSteps(DEFAULT_TIERS, 0)).toEqual(['manager']);
  });
  it('rejects malformed policies and bad amounts', () => {
    expect(validateTiers([])).toContain('At least one tier is required');
    expect(validateTiers([{ upToCents: 100, steps: ['manager'] }]).length).toBeGreaterThan(0); // last tier not open-ended
    expect(validateTiers([{ upToCents: 500, steps: ['manager'] }, { upToCents: 100, steps: ['owner'] }, { upToCents: null, steps: ['owner'] }]).length).toBeGreaterThan(0);
    expect(() => requiredSteps(DEFAULT_TIERS, 1.5)).toThrow(RangeError);
    expect(() => requiredSteps(DEFAULT_TIERS, -1)).toThrow(RangeError);
  });
});

describe('nteCheck', () => {
  it('no cap is always ok', () => expect(nteCheck(null, 1_000_000, 5).ok).toBe(true));
  it('exactly at the cap is ok; one cent over is not', () => {
    expect(nteCheck(10_000, 6_000, 4_000)).toEqual({ ok: true, remainingCents: 4_000, overByCents: 0, usedPct: 100 });
    const over = nteCheck(10_000, 6_000, 4_001);
    expect(over.ok).toBe(false);
    expect(over.overByCents).toBe(1);
  });
  it('rejects fractional cents', () => expect(() => nteCheck(100, 0.5, 1)).toThrow(RangeError));
});

describe('approval state machine', () => {
  const start = () => newApproval('req', ['manager', 'owner']);
  it('walks manager → owner to approved', () => {
    let s = start();
    expect(nextRole(s)).toBe('manager');
    let r = applyDecision(s, { userId: 'm1', role: 'manager', decision: 'approve' });
    expect('state' in r && r.state.status).toBe('pending');
    s = (r as { state: typeof s }).state;
    expect(nextRole(s)).toBe('owner');
    r = applyDecision(s, { userId: 'o1', role: 'owner', decision: 'approve' });
    expect('state' in r && r.state.status).toBe('approved');
  });
  it('blocks self-approval, low roles, repeat approvers and decisions after a terminal state', () => {
    const s = start();
    expect(applyDecision(s, { userId: 'req', role: 'owner', decision: 'approve' })).toEqual({ error: 'self_approval' });
    const afterMgr = (applyDecision(s, { userId: 'm1', role: 'manager', decision: 'approve' }) as { state: typeof s }).state;
    expect(applyDecision(afterMgr, { userId: 'm2', role: 'manager', decision: 'approve' })).toEqual({ error: 'insufficient_role' });
    expect(applyDecision(afterMgr, { userId: 'm1', role: 'owner', decision: 'approve' })).toEqual({ error: 'already_decided' });
    const rejected = (applyDecision(s, { userId: 'm1', role: 'manager', decision: 'reject' }) as { state: typeof s }).state;
    expect(rejected.status).toBe('rejected');
    expect(applyDecision(rejected, { userId: 'o1', role: 'owner', decision: 'approve' })).toEqual({ error: 'not_pending' });
  });
  it('an owner may satisfy a manager step', () => {
    const r = applyDecision(newApproval('req', ['manager']), { userId: 'o1', role: 'owner', decision: 'approve' });
    expect('state' in r && r.state.status).toBe('approved');
  });
  it('does not mutate the input state', () => {
    const s = start();
    applyDecision(s, { userId: 'm1', role: 'manager', decision: 'approve' });
    expect(s.approvals).toHaveLength(0);
  });
});
