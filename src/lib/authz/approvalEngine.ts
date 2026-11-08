/**
 * Approval chains engine (pure domain logic, no I/O).
 *
 * One engine for every approval in the product: policy selection by amount/risk,
 * sequential steps with any/all/quorum approvers inside a step, delegation,
 * escalation, separation of duties (requester can never approve, directly or as
 * a delegate), reasons, optional e-signature reference, and an append-only history.
 *
 * The database mirrors the same rules in `authz_decide_approval` (see migration
 * 20281103000000_identity_authz_foundation.sql); keep both in step.
 *
 * Every function is pure: it takes `now` as an ISO string and returns new objects.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
const RISK_ORDER: Readonly<Record<RiskLevel, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

export function riskAtLeast(value: RiskLevel, min: RiskLevel): boolean {
  return RISK_ORDER[value] >= RISK_ORDER[min];
}

export type StepMode = 'any' | 'all' | 'quorum';

export interface ApprovalStepSpec {
  id: string;
  label: string;
  mode: StepMode;
  /** Required when mode === 'quorum': distinct approvers needed. */
  quorum?: number;
  approvers: readonly string[];
  /** If set and the step is still active after this long, it becomes escalatable. */
  escalateAfterMinutes?: number;
  /** After escalation, one approval from any of these satisfies the step. */
  escalateTo?: readonly string[];
}

export interface ApprovalPolicy {
  id: string;
  subjectType: string;
  minAmountCents: number;
  maxAmountCents: number | null;
  minRisk: RiskLevel;
  steps: readonly ApprovalStepSpec[];
  requireReason: boolean;
  requireSignature: boolean;
  expireAfterMinutes: number | null;
  priority: number;
  enabled: boolean;
}

export interface ApprovalSubject {
  subjectType: string;
  subjectId: string;
  amountCents: number;
  risk: RiskLevel;
  requesterId: string;
}

export interface Delegation {
  id: string;
  delegatorId: string;
  delegateId: string;
  startsAt: string;
  endsAt: string;
  /** null = all subject types. */
  subjectTypes: readonly string[] | null;
  revokedAt: string | null;
}

export type DecisionKind = 'approve' | 'reject';

export interface ApprovalDecision {
  stepId: string;
  userId: string;
  /** The approver slot this decision fills ('escalation' for an escalation approval). */
  onBehalfOf: string;
  viaEscalation: boolean;
  kind: DecisionKind;
  reason: string | null;
  signatureRef: string | null;
  at: string;
}

export type StepStatus = 'waiting' | 'active' | 'approved' | 'rejected';

export interface StepState {
  stepId: string;
  status: StepStatus;
  activatedAt: string | null;
  escalatedAt: string | null;
}

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';

export type HistoryEventType =
  | 'created'
  | 'step_activated'
  | 'decision'
  | 'escalated'
  | 'step_approved'
  | 'completed'
  | 'cancelled'
  | 'expired';

export interface HistoryEntry {
  type: HistoryEventType;
  at: string;
  actorId: string | null;
  stepId: string | null;
  detail: string | null;
}

export interface ApprovalRequest {
  id: string;
  policyId: string;
  subjectType: string;
  subjectId: string;
  amountCents: number;
  risk: RiskLevel;
  requesterId: string;
  /** Policy settings are snapshotted so editing a policy never alters an in-flight request. */
  requireReason: boolean;
  requireSignature: boolean;
  expiresAt: string | null;
  steps: readonly ApprovalStepSpec[];
  stepStates: readonly StepState[];
  decisions: readonly ApprovalDecision[];
  history: readonly HistoryEntry[];
  status: RequestStatus;
  createdAt: string;
}

export type ApprovalErrorCode =
  | 'policy_disabled'
  | 'empty_chain'
  | 'unsatisfiable_chain'
  | 'invalid_quorum'
  | 'not_pending'
  | 'expired'
  | 'self_approval_forbidden'
  | 'not_an_approver'
  | 'already_decided'
  | 'slot_already_covered'
  | 'reason_required'
  | 'signature_required'
  | 'no_active_step'
  | 'not_escalatable'
  | 'not_requester';

export type Result<T> = { ok: true; value: T } | { ok: false; error: ApprovalErrorCode };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: ApprovalErrorCode): Result<T> => ({ ok: false, error });

const MIN_REASON_LENGTH = 3;

function ms(iso: string): number {
  return Date.parse(iso);
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(ms(iso) + minutes * 60_000).toISOString();
}

/** Highest priority wins; ties go to the policy with the higher amount floor, then by id (stable). */
export function selectPolicy(policies: readonly ApprovalPolicy[], subject: ApprovalSubject): ApprovalPolicy | null {
  const matches = policies.filter(
    (p) =>
      p.enabled &&
      p.subjectType === subject.subjectType &&
      subject.amountCents >= p.minAmountCents &&
      (p.maxAmountCents === null || subject.amountCents <= p.maxAmountCents) &&
      riskAtLeast(subject.risk, p.minRisk),
  );
  if (matches.length === 0) return null;
  const sorted = [...matches].sort(
    (a, b) => b.priority - a.priority || b.minAmountCents - a.minAmountCents || a.id.localeCompare(b.id),
  );
  return sorted[0] ?? null;
}

function delegationApplies(d: Delegation, subjectType: string, now: string): boolean {
  if (d.revokedAt !== null && ms(d.revokedAt) <= ms(now)) return false;
  if (ms(d.startsAt) > ms(now) || ms(d.endsAt) <= ms(now)) return false;
  if (d.delegateId === d.delegatorId) return false;
  return d.subjectTypes === null || d.subjectTypes.includes(subjectType);
}

interface Eligible {
  userId: string;
  onBehalfOf: string;
  viaEscalation: boolean;
}

/**
 * Who may act on a step right now. The requester is excluded everywhere, including
 * as a delegate and as the delegator whose slot a delegate would fill (separation of duties).
 * Delegation is single-level: a delegate cannot re-delegate.
 */
function eligibleActors(
  step: ApprovalStepSpec,
  stepState: StepState,
  req: Pick<ApprovalRequest, 'requesterId' | 'subjectType'>,
  delegations: readonly Delegation[],
  now: string,
): Eligible[] {
  const out: Eligible[] = [];
  const seen = new Set<string>();
  const push = (e: Eligible): void => {
    if (e.userId === req.requesterId || seen.has(e.userId)) return;
    seen.add(e.userId);
    out.push(e);
  };
  for (const a of step.approvers) {
    if (a === req.requesterId) continue;
    push({ userId: a, onBehalfOf: a, viaEscalation: false });
  }
  for (const d of delegations) {
    if (!delegationApplies(d, req.subjectType, now)) continue;
    if (!step.approvers.includes(d.delegatorId) || d.delegatorId === req.requesterId) continue;
    push({ userId: d.delegateId, onBehalfOf: d.delegatorId, viaEscalation: false });
  }
  if (stepState.escalatedAt !== null) {
    for (const e of step.escalateTo ?? []) push({ userId: e, onBehalfOf: 'escalation', viaEscalation: true });
  }
  return out;
}

function slotsFor(step: ApprovalStepSpec, requesterId: string): string[] {
  return [...new Set(step.approvers)].filter((a) => a !== requesterId);
}

function validateChain(steps: readonly ApprovalStepSpec[], requesterId: string): ApprovalErrorCode | null {
  if (steps.length === 0) return 'empty_chain';
  for (const step of steps) {
    const slots = slotsFor(step, requesterId);
    if (slots.length === 0) return 'unsatisfiable_chain';
    if (step.mode === 'quorum') {
      const q = step.quorum;
      if (q === undefined || !Number.isInteger(q) || q < 1) return 'invalid_quorum';
      if (q > slots.length) return 'unsatisfiable_chain';
    }
  }
  return null;
}

function entry(type: HistoryEventType, at: string, actorId: string | null, stepId: string | null, detail: string | null): HistoryEntry {
  return { type, at, actorId, stepId, detail };
}

function activateStep(req: ApprovalRequest, index: number, now: string): ApprovalRequest {
  const step = req.steps[index];
  if (!step) return req;
  return {
    ...req,
    stepStates: req.stepStates.map((s, i) => (i === index ? { ...s, status: 'active', activatedAt: now } : s)),
    history: [...req.history, entry('step_activated', now, null, step.id, step.label)],
  };
}

export function createRequest(
  policy: ApprovalPolicy,
  subject: ApprovalSubject,
  ctx: { id: string; now: string },
): Result<ApprovalRequest> {
  if (!policy.enabled) return fail('policy_disabled');
  const chainError = validateChain(policy.steps, subject.requesterId);
  if (chainError) return fail(chainError);
  const base: ApprovalRequest = {
    id: ctx.id,
    policyId: policy.id,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    amountCents: subject.amountCents,
    risk: subject.risk,
    requesterId: subject.requesterId,
    requireReason: policy.requireReason,
    requireSignature: policy.requireSignature,
    expiresAt: policy.expireAfterMinutes === null ? null : addMinutes(ctx.now, policy.expireAfterMinutes),
    steps: policy.steps,
    stepStates: policy.steps.map((s) => ({ stepId: s.id, status: 'waiting', activatedAt: null, escalatedAt: null })),
    decisions: [],
    history: [entry('created', ctx.now, subject.requesterId, null, null)],
    status: 'pending',
    createdAt: ctx.now,
  };
  return ok(activateStep(base, 0, ctx.now));
}

function activeIndex(req: ApprovalRequest): number {
  return req.stepStates.findIndex((s) => s.status === 'active');
}

function isExpired(req: ApprovalRequest, now: string): boolean {
  return req.expiresAt !== null && ms(now) >= ms(req.expiresAt);
}

export function expireIfDue(req: ApprovalRequest, now: string): ApprovalRequest {
  if (req.status !== 'pending' || !isExpired(req, now)) return req;
  return { ...req, status: 'expired', history: [...req.history, entry('expired', now, null, null, null)] };
}

export interface DecideInput {
  userId: string;
  kind: DecisionKind;
  reason: string | null;
  signatureRef?: string | null;
  now: string;
  delegations: readonly Delegation[];
}

function hasReason(reason: string | null): boolean {
  return reason !== null && reason.trim().length >= MIN_REASON_LENGTH;
}

function stepSatisfied(step: ApprovalStepSpec, approvals: readonly ApprovalDecision[], requesterId: string): boolean {
  if (approvals.some((d) => d.viaEscalation)) return true;
  switch (step.mode) {
    case 'any':
      return approvals.length >= 1;
    case 'quorum':
      return new Set(approvals.map((d) => d.userId)).size >= (step.quorum ?? Number.POSITIVE_INFINITY);
    case 'all': {
      const covered = new Set(approvals.map((d) => d.onBehalfOf));
      return slotsFor(step, requesterId).every((s) => covered.has(s));
    }
  }
}

export function decide(req: ApprovalRequest, input: DecideInput): Result<ApprovalRequest> {
  if (req.status !== 'pending') return fail('not_pending');
  if (isExpired(req, input.now)) return fail('expired');
  if (input.userId === req.requesterId) return fail('self_approval_forbidden');

  const idx = activeIndex(req);
  const step = req.steps[idx];
  const state = req.stepStates[idx];
  if (idx < 0 || !step || !state) return fail('no_active_step');

  const actor = eligibleActors(step, state, req, input.delegations, input.now).find((e) => e.userId === input.userId);
  if (!actor) return fail('not_an_approver');

  const stepDecisions = req.decisions.filter((d) => d.stepId === step.id);
  if (stepDecisions.some((d) => d.userId === input.userId)) return fail('already_decided');

  if (input.kind === 'reject' && !hasReason(input.reason)) return fail('reason_required');
  if (input.kind === 'approve') {
    if (req.requireReason && !hasReason(input.reason)) return fail('reason_required');
    if (req.requireSignature && !input.signatureRef) return fail('signature_required');
    if (!actor.viaEscalation && stepDecisions.some((d) => d.kind === 'approve' && d.onBehalfOf === actor.onBehalfOf)) {
      return fail('slot_already_covered');
    }
  }

  const decision: ApprovalDecision = {
    stepId: step.id,
    userId: input.userId,
    onBehalfOf: actor.onBehalfOf,
    viaEscalation: actor.viaEscalation,
    kind: input.kind,
    reason: input.reason?.trim() || null,
    signatureRef: input.kind === 'approve' ? (input.signatureRef ?? null) : null,
    at: input.now,
  };
  let next: ApprovalRequest = {
    ...req,
    decisions: [...req.decisions, decision],
    history: [...req.history, entry('decision', input.now, input.userId, step.id, input.kind)],
  };

  // Any single rejection ends the request (conservative by design).
  if (input.kind === 'reject') {
    next = {
      ...next,
      status: 'rejected',
      stepStates: next.stepStates.map((s, i) => (i === idx ? { ...s, status: 'rejected' } : s)),
      history: [...next.history, entry('completed', input.now, input.userId, step.id, 'rejected')],
    };
    return ok(next);
  }

  const approvals = next.decisions.filter((d) => d.stepId === step.id && d.kind === 'approve');
  if (!stepSatisfied(step, approvals, req.requesterId)) return ok(next);

  next = {
    ...next,
    stepStates: next.stepStates.map((s, i) => (i === idx ? { ...s, status: 'approved' } : s)),
    history: [...next.history, entry('step_approved', input.now, input.userId, step.id, null)],
  };
  if (idx + 1 < next.steps.length) return ok(activateStep(next, idx + 1, input.now));
  return ok({ ...next, status: 'approved', history: [...next.history, entry('completed', input.now, input.userId, null, 'approved')] });
}

/** Step ids whose escalation timer has elapsed and that have not been escalated yet. */
export function dueEscalations(req: ApprovalRequest, now: string): string[] {
  if (req.status !== 'pending' || isExpired(req, now)) return [];
  const due: string[] = [];
  req.steps.forEach((step, i) => {
    const state = req.stepStates[i];
    if (!state || state.status !== 'active' || state.escalatedAt !== null || state.activatedAt === null) return;
    if (step.escalateAfterMinutes === undefined || !step.escalateTo || step.escalateTo.length === 0) return;
    if (ms(now) >= ms(addMinutes(state.activatedAt, step.escalateAfterMinutes))) due.push(step.id);
  });
  return due;
}

export function escalate(req: ApprovalRequest, stepId: string, now: string): Result<ApprovalRequest> {
  if (req.status !== 'pending') return fail('not_pending');
  if (!dueEscalations(req, now).includes(stepId)) return fail('not_escalatable');
  return ok({
    ...req,
    stepStates: req.stepStates.map((s) => (s.stepId === stepId ? { ...s, escalatedAt: now } : s)),
    history: [...req.history, entry('escalated', now, null, stepId, null)],
  });
}

export function cancel(req: ApprovalRequest, userId: string, now: string, reason: string | null): Result<ApprovalRequest> {
  if (req.status !== 'pending') return fail('not_pending');
  if (userId !== req.requesterId) return fail('not_requester');
  return ok({
    ...req,
    status: 'cancelled',
    history: [...req.history, entry('cancelled', now, userId, null, reason?.trim() || null)],
  });
}

/** Pending requests the user can act on now (used for inboxes). */
export function canActOn(req: ApprovalRequest, userId: string, delegations: readonly Delegation[], now: string): boolean {
  if (req.status !== 'pending' || isExpired(req, now) || userId === req.requesterId) return false;
  const idx = activeIndex(req);
  const step = req.steps[idx];
  const state = req.stepStates[idx];
  if (!step || !state) return false;
  const actor = eligibleActors(step, state, req, delegations, now).find((e) => e.userId === userId);
  if (!actor) return false;
  const stepDecisions = req.decisions.filter((d) => d.stepId === step.id);
  if (stepDecisions.some((d) => d.userId === userId)) return false;
  return actor.viaEscalation || !stepDecisions.some((d) => d.kind === 'approve' && d.onBehalfOf === actor.onBehalfOf);
}
