import { describe, it, expect } from 'vitest';
import {
  canActOn,
  cancel,
  createRequest,
  decide,
  dueEscalations,
  escalate,
  expireIfDue,
  selectPolicy,
  type ApprovalPolicy,
  type ApprovalRequest,
  type ApprovalSubject,
  type Delegation,
} from './approvalEngine';

const T0 = '2026-11-05T09:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const policy = (over: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  id: 'p1',
  subjectType: 'refund',
  minAmountCents: 0,
  maxAmountCents: null,
  minRisk: 'low',
  steps: [{ id: 's1', label: 'Manager', mode: 'any', approvers: ['mgr1', 'mgr2'] }],
  requireReason: false,
  requireSignature: false,
  expireAfterMinutes: null,
  priority: 0,
  enabled: true,
  ...over,
});

const subject = (over: Partial<ApprovalSubject> = {}): ApprovalSubject => ({
  subjectType: 'refund',
  subjectId: 'r1',
  amountCents: 10_000,
  risk: 'low',
  requesterId: 'req',
  ...over,
});

function make(p: ApprovalPolicy, s: ApprovalSubject = subject()): ApprovalRequest {
  const r = createRequest(p, s, { id: 'a1', now: T0 });
  if (!r.ok) throw new Error(`setup failed: ${r.error}`);
  return r.value;
}

const approve = (r: ApprovalRequest, userId: string, now = at(1), extra: { reason?: string | null; sig?: string; d?: Delegation[] } = {}) =>
  decide(r, { userId, kind: 'approve', reason: extra.reason ?? null, signatureRef: extra.sig ?? null, now, delegations: extra.d ?? [] });

describe('selectPolicy', () => {
  it('matches by type, amount band and risk, and prefers priority then amount floor', () => {
    const small = policy({ id: 'small', maxAmountCents: 49_999 });
    const big = policy({ id: 'big', minAmountCents: 50_000, priority: 0 });
    const critical = policy({ id: 'crit', minAmountCents: 0, minRisk: 'critical', priority: 5 });
    expect(selectPolicy([small, big], subject({ amountCents: 100 }))?.id).toBe('small');
    expect(selectPolicy([small, big], subject({ amountCents: 60_000 }))?.id).toBe('big');
    expect(selectPolicy([small, big, critical], subject({ amountCents: 100, risk: 'critical' }))?.id).toBe('crit');
    expect(selectPolicy([small, big, critical], subject({ amountCents: 100, risk: 'high' }))?.id).toBe('small');
  });
  it('ignores disabled policies and other subject types, returns null when nothing matches', () => {
    expect(selectPolicy([policy({ enabled: false })], subject())).toBeNull();
    expect(selectPolicy([policy({ subjectType: 'discount' })], subject())).toBeNull();
    expect(selectPolicy([policy({ maxAmountCents: 5 })], subject({ amountCents: 6 }))).toBeNull();
  });
  it('is deterministic on full ties', () => {
    const a = policy({ id: 'a' });
    const b = policy({ id: 'b' });
    expect(selectPolicy([b, a], subject())?.id).toBe('a');
  });
});

describe('createRequest validation', () => {
  it('rejects empty chains and disabled policies', () => {
    expect(createRequest(policy({ steps: [] }), subject(), { id: 'x', now: T0 })).toEqual({ ok: false, error: 'empty_chain' });
    expect(createRequest(policy({ enabled: false }), subject(), { id: 'x', now: T0 })).toEqual({ ok: false, error: 'policy_disabled' });
  });
  it('rejects a chain the requester would be the only approver of (separation of duties)', () => {
    const p = policy({ steps: [{ id: 's1', label: 'Self', mode: 'any', approvers: ['req'] }] });
    expect(createRequest(p, subject(), { id: 'x', now: T0 })).toEqual({ ok: false, error: 'unsatisfiable_chain' });
  });
  it('validates quorum bounds against eligible (non-requester) approvers', () => {
    const base = { id: 's1', label: 'Q', mode: 'quorum' as const, approvers: ['a', 'b', 'req'] };
    expect(createRequest(policy({ steps: [{ ...base, quorum: 3 }] }), subject(), { id: 'x', now: T0 })).toEqual({ ok: false, error: 'unsatisfiable_chain' });
    expect(createRequest(policy({ steps: [{ ...base, quorum: 0 }] }), subject(), { id: 'x', now: T0 })).toEqual({ ok: false, error: 'invalid_quorum' });
    expect(createRequest(policy({ steps: [{ ...base }] }), subject(), { id: 'x', now: T0 })).toEqual({ ok: false, error: 'invalid_quorum' });
    expect(createRequest(policy({ steps: [{ ...base, quorum: 2 }] }), subject(), { id: 'x', now: T0 }).ok).toBe(true);
  });
  it('activates the first step, snapshots policy flags and records history', () => {
    const r = make(policy({ requireReason: true, expireAfterMinutes: 60 }));
    expect(r.status).toBe('pending');
    expect(r.stepStates[0]?.status).toBe('active');
    expect(r.requireReason).toBe(true);
    expect(r.expiresAt).toBe(at(60));
    expect(r.history.map((h) => h.type)).toEqual(['created', 'step_activated']);
  });
});

describe('decide: separation of duties and eligibility', () => {
  it('never lets the requester approve or reject', () => {
    const p = policy({ steps: [{ id: 's1', label: 'M', mode: 'any', approvers: ['req', 'mgr1'] }] });
    const r = make(p);
    expect(approve(r, 'req')).toEqual({ ok: false, error: 'self_approval_forbidden' });
    expect(decide(r, { userId: 'req', kind: 'reject', reason: 'nope', now: at(1), delegations: [] })).toEqual({ ok: false, error: 'self_approval_forbidden' });
  });
  it('never lets the requester act through a delegation, nor a delegate fill the requester slot', () => {
    const p = policy({ steps: [{ id: 's1', label: 'M', mode: 'any', approvers: ['req', 'mgr1'] }] });
    const r = make(p);
    const toRequester: Delegation = { id: 'd1', delegatorId: 'mgr1', delegateId: 'req', startsAt: T0, endsAt: at(600), subjectTypes: null, revokedAt: null };
    expect(approve(r, 'req', at(1), { d: [toRequester] })).toEqual({ ok: false, error: 'self_approval_forbidden' });
    const forRequesterSlot: Delegation = { id: 'd2', delegatorId: 'req', delegateId: 'zed', startsAt: T0, endsAt: at(600), subjectTypes: null, revokedAt: null };
    expect(approve(r, 'zed', at(1), { d: [forRequesterSlot] })).toEqual({ ok: false, error: 'not_an_approver' });
  });
  it('rejects non-approvers and double decisions', () => {
    const r = make(policy({ steps: [{ id: 's1', label: 'A', mode: 'all', approvers: ['a', 'b'] }] }));
    expect(approve(r, 'stranger')).toEqual({ ok: false, error: 'not_an_approver' });
    const once = approve(r, 'a');
    expect(once.ok).toBe(true);
    if (once.ok) expect(approve(once.value, 'a', at(2))).toEqual({ ok: false, error: 'already_decided' });
  });
});

describe('decide: step modes and chains', () => {
  it('any: one approval completes a single-step chain', () => {
    const done = approve(make(policy()), 'mgr2');
    expect(done.ok && done.value.status).toBe('approved');
  });
  it('all: every approver slot must approve', () => {
    const r = make(policy({ steps: [{ id: 's1', label: 'A', mode: 'all', approvers: ['a', 'b'] }] }));
    const first = approve(r, 'a');
    expect(first.ok && first.value.status).toBe('pending');
    if (first.ok) {
      const second = approve(first.value, 'b', at(2));
      expect(second.ok && second.value.status).toBe('approved');
    }
  });
  it('quorum: n distinct approvers', () => {
    const r = make(policy({ steps: [{ id: 's1', label: 'Q', mode: 'quorum', quorum: 2, approvers: ['a', 'b', 'c'] }] }));
    const one = approve(r, 'a');
    expect(one.ok && one.value.status).toBe('pending');
    if (one.ok) expect((approve(one.value, 'c', at(2)) as { ok: true; value: ApprovalRequest }).value.status).toBe('approved');
  });
  it('sequential steps activate in order and only the active step can be decided', () => {
    const r = make(policy({ steps: [
      { id: 's1', label: 'Lead', mode: 'any', approvers: ['lead'] },
      { id: 's2', label: 'Finance', mode: 'any', approvers: ['fin'] },
    ] }));
    expect(approve(r, 'fin')).toEqual({ ok: false, error: 'not_an_approver' });
    const s1 = approve(r, 'lead');
    expect(s1.ok && s1.value.status).toBe('pending');
    if (s1.ok) {
      expect(s1.value.stepStates.map((s) => s.status)).toEqual(['approved', 'active']);
      const s2 = approve(s1.value, 'fin', at(2));
      expect(s2.ok && s2.value.status).toBe('approved');
      if (s2.ok) expect(s2.value.history.map((h) => h.type).at(-1)).toBe('completed');
    }
  });
  it('a single rejection ends the request and requires a reason', () => {
    const r = make(policy({ steps: [{ id: 's1', label: 'A', mode: 'all', approvers: ['a', 'b'] }] }));
    expect(decide(r, { userId: 'a', kind: 'reject', reason: '  ', now: at(1), delegations: [] })).toEqual({ ok: false, error: 'reason_required' });
    const rejected = decide(r, { userId: 'a', kind: 'reject', reason: 'over budget', now: at(1), delegations: [] });
    expect(rejected.ok && rejected.value.status).toBe('rejected');
    if (rejected.ok) expect(approve(rejected.value, 'b', at(2))).toEqual({ ok: false, error: 'not_pending' });
  });
  it('enforces reason and signature requirements on approval', () => {
    const r = make(policy({ requireReason: true, requireSignature: true }));
    expect(approve(r, 'mgr1')).toEqual({ ok: false, error: 'reason_required' });
    expect(approve(r, 'mgr1', at(1), { reason: 'looks right' })).toEqual({ ok: false, error: 'signature_required' });
    const ok = approve(r, 'mgr1', at(1), { reason: 'looks right', sig: 'sig_123' });
    expect(ok.ok && ok.value.decisions[0]?.signatureRef).toBe('sig_123');
  });
});

describe('delegation / out-of-office', () => {
  const d = (over: Partial<Delegation> = {}): Delegation => ({
    id: 'd', delegatorId: 'mgr1', delegateId: 'deputy', startsAt: at(0), endsAt: at(120), subjectTypes: null, revokedAt: null, ...over,
  });
  it('lets an active delegate decide on the delegator slot, recorded as on-behalf-of', () => {
    const res = approve(make(policy()), 'deputy', at(5), { d: [d()] });
    expect(res.ok && res.value.decisions[0]?.onBehalfOf).toBe('mgr1');
  });
  it('ignores expired, not-yet-started, revoked and out-of-type delegations', () => {
    const r = make(policy());
    expect(approve(r, 'deputy', at(200), { d: [d()] })).toEqual({ ok: false, error: 'not_an_approver' });
    expect(approve(r, 'deputy', at(5), { d: [d({ startsAt: at(60) })] })).toEqual({ ok: false, error: 'not_an_approver' });
    expect(approve(r, 'deputy', at(5), { d: [d({ revokedAt: at(2) })] })).toEqual({ ok: false, error: 'not_an_approver' });
    expect(approve(r, 'deputy', at(5), { d: [d({ subjectTypes: ['discount'] })] })).toEqual({ ok: false, error: 'not_an_approver' });
  });
  it('does not allow re-delegation (single level)', () => {
    const chain = [d(), d({ id: 'd2', delegatorId: 'deputy', delegateId: 'deputy2' })];
    expect(approve(make(policy()), 'deputy2', at(5), { d: chain })).toEqual({ ok: false, error: 'not_an_approver' });
  });
  it('in all-mode, a delegate cannot double-cover a slot the delegator already filled', () => {
    const r = make(policy({ steps: [{ id: 's1', label: 'A', mode: 'all', approvers: ['mgr1', 'mgr2'] }] }));
    const first = approve(r, 'mgr1');
    expect(first.ok).toBe(true);
    if (first.ok) expect(approve(first.value, 'deputy', at(3), { d: [d()] })).toEqual({ ok: false, error: 'slot_already_covered' });
  });
});

describe('escalation, expiry, cancel', () => {
  const esc = policy({ steps: [{ id: 's1', label: 'M', mode: 'all', approvers: ['a', 'b'], escalateAfterMinutes: 30, escalateTo: ['boss'] }] });
  it('only becomes due after the timer and escalates exactly once', () => {
    const r = make(esc);
    expect(dueEscalations(r, at(29))).toEqual([]);
    expect(escalate(r, 's1', at(29))).toEqual({ ok: false, error: 'not_escalatable' });
    expect(dueEscalations(r, at(30))).toEqual(['s1']);
    const e = escalate(r, 's1', at(30));
    expect(e.ok).toBe(true);
    if (e.ok) {
      expect(dueEscalations(e.value, at(90))).toEqual([]);
      expect(escalate(e.value, 's1', at(90))).toEqual({ ok: false, error: 'not_escalatable' });
    }
  });
  it('escalation target is not eligible before escalation, and one approval satisfies the step after', () => {
    const r = make(esc);
    expect(approve(r, 'boss', at(31))).toEqual({ ok: false, error: 'not_an_approver' });
    const e = escalate(r, 's1', at(31));
    if (!e.ok) throw new Error('escalate failed');
    const done = approve(e.value, 'boss', at(32));
    expect(done.ok && done.value.status).toBe('approved');
    expect(done.ok && done.value.decisions[0]?.viaEscalation).toBe(true);
  });
  it('expires, blocks decisions after expiry, and never expires non-pending requests', () => {
    const r = make(policy({ expireAfterMinutes: 10 }));
    expect(approve(r, 'mgr1', at(11))).toEqual({ ok: false, error: 'expired' });
    expect(expireIfDue(r, at(9)).status).toBe('pending');
    const ex = expireIfDue(r, at(10));
    expect(ex.status).toBe('expired');
    expect(ex.history.at(-1)?.type).toBe('expired');
    const done = approve(make(policy({ expireAfterMinutes: 10 })), 'mgr1', at(1));
    if (done.ok) expect(expireIfDue(done.value, at(99)).status).toBe('approved');
  });
  it('only the requester can cancel, only while pending', () => {
    const r = make(policy());
    expect(cancel(r, 'mgr1', at(1), null)).toEqual({ ok: false, error: 'not_requester' });
    const c = cancel(r, 'req', at(1), 'mistake');
    expect(c.ok && c.value.status).toBe('cancelled');
    if (c.ok) expect(cancel(c.value, 'req', at(2), null)).toEqual({ ok: false, error: 'not_pending' });
  });
});

describe('canActOn and immutability', () => {
  it('agrees with decide for inbox filtering', () => {
    const r = make(policy());
    expect(canActOn(r, 'mgr1', [], at(1))).toBe(true);
    expect(canActOn(r, 'req', [], at(1))).toBe(false);
    expect(canActOn(r, 'stranger', [], at(1))).toBe(false);
    const done = approve(r, 'mgr1');
    if (done.ok) expect(canActOn(done.value, 'mgr2', [], at(2))).toBe(false);
  });
  it('never mutates its input', () => {
    const r = make(policy());
    const snapshot = JSON.stringify(r);
    approve(r, 'mgr1');
    decide(r, { userId: 'mgr1', kind: 'reject', reason: 'no', now: at(1), delegations: [] });
    expect(JSON.stringify(r)).toBe(snapshot);
  });
});
