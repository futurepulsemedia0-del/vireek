/**
 * The gate. Deterministic, restrict-only, and structurally unable to override safety.
 *
 * Order of evaluation (first match wins), by design:
 *   1. hard exclusions / safety hold   -> dispatch   (no snapshot, setting, lambda or alpha is even read)
 *   2. invalid score                   -> dispatch
 *   3. existing engine did not allow a remote attempt -> dispatch   (this layer never EXPANDS remote use)
 *   4. drift alarm                     -> dispatch
 *   5. no snapshot / abstain           -> dispatch
 *   6. score < lambda                  -> dispatch
 *   7. otherwise                       -> allow_remote
 *
 * The LLM never reaches this function: its inputs are the integer score, the segment key, the safety
 * result of the deterministic screen and a stored snapshot.
 */
import { calibrationFor } from './calibrate.ts';
import { LAMBDA_NEVER, type CalibrationSnapshot, type SegmentStatus } from './types.ts';

export type GateAction = 'allow_remote' | 'dispatch';
export type GateReason =
  | 'hard_exclusion'
  | 'invalid_score'
  | 'existing_decision_not_remote'
  | 'drift_alarm'
  | 'no_snapshot'
  | 'abstain'
  | 'below_lambda'
  | 'allowed';

export interface GateInput {
  /** True when the existing engine's decision is to continue remotely (troubleshoot). */
  existingAllowsRemote: boolean;
  /** Deterministic screen output (screenSafety().hold) and its reasons. */
  safetyHold: boolean;
  safetyReasons: readonly string[];
  score: number;
  segment: string;
  snapshot: CalibrationSnapshot | null;
  driftAlarm: boolean;
}

export interface GateResult {
  action: GateAction;
  reason: GateReason;
  lambda: number | null;
  segmentStatus: SegmentStatus | null;
}

const dispatch = (reason: GateReason, lambda: number | null = null, segmentStatus: SegmentStatus | null = null): GateResult => ({
  action: 'dispatch',
  reason,
  lambda,
  segmentStatus,
});

export function gateDecision(i: GateInput): GateResult {
  if (i.safetyHold || i.safetyReasons.length > 0) return dispatch('hard_exclusion');
  if (!Number.isFinite(i.score) || i.score < 0 || i.score > 100) return dispatch('invalid_score');
  if (!i.existingAllowsRemote) return dispatch('existing_decision_not_remote');
  if (i.driftAlarm) return dispatch('drift_alarm');
  if (!i.snapshot) return dispatch('no_snapshot');
  const cal = calibrationFor(i.snapshot, i.segment);
  if (cal.status === 'abstain' || cal.lambda >= LAMBDA_NEVER) return dispatch('abstain', cal.lambda, cal.status);
  if (Math.round(i.score) < cal.lambda) return dispatch('below_lambda', cal.lambda, cal.status);
  return { action: 'allow_remote', reason: 'allowed', lambda: cal.lambda, segmentStatus: cal.status };
}

export type ExistingAction = 'ask' | 'troubleshoot' | 'dispatch';

/**
 * Applies the rollout mode to the existing decision. This is the ONLY place where the layer can change
 * live behaviour:
 *   off / shadow -> the existing action is returned untouched (flag-off === before, by construction)
 *   enforce      -> only 'troubleshoot' can become 'dispatch', and only when the gate says dispatch
 * 'ask' is never changed: asking the customer another question cannot close a case as resolved.
 */
export function effectiveAction(mode: 'off' | 'shadow' | 'enforce', existing: ExistingAction, gate: GateResult | null): ExistingAction {
  if (mode !== 'enforce' || !gate) return existing;
  if (existing === 'troubleshoot' && gate.action === 'dispatch') return 'dispatch';
  return existing;
}
