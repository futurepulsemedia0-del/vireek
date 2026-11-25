/**
 * What the UI may say. Structured on purpose: the UI turns these into i18n keys, so a translator can never
 * add a stronger claim than the one computed here.
 *
 * Rules (enforced by copy.test.ts):
 *   - The words "guarantee(d)", "certified", "safe", "proven" never appear in generated English text.
 *   - A bounded statement exists ONLY when state === 'valid' (an own-segment guarantee) or the narrower
 *     'pooled_only' statement. Otherwise the only text is "not enough outcome data".
 */
import { LAMBDA_NEVER, type CalibrationSnapshot, type SegmentCalibration } from './types.ts';

export type GuaranteeState = 'valid' | 'pooled_only' | 'none';

export interface GuaranteeView {
  state: GuaranteeState;
  alphaPct: number;
  deltaPct: number;
  windowDays: number;
  nMature: number;
  segmentsValid: string[];
  segmentsPooled: string[];
  segmentsAbstain: string[];
}

export function guaranteeView(snapshot: CalibrationSnapshot | null): GuaranteeView | null {
  if (!snapshot) return null;
  const valid: string[] = [];
  const pooled: string[] = [];
  const abstain: string[] = [];
  for (const [seg, cal] of Object.entries(snapshot.segments)) {
    if (cal.status === 'segment_valid' && cal.lambda < LAMBDA_NEVER) valid.push(seg);
    else if (cal.status === 'pooled_only' && cal.lambda < LAMBDA_NEVER) pooled.push(seg);
    else abstain.push(seg);
  }
  const state: GuaranteeState = valid.length ? 'valid' : pooled.length || (snapshot.pooled.status === 'segment_valid' && snapshot.pooled.lambda < LAMBDA_NEVER) ? 'pooled_only' : 'none';
  return {
    state,
    alphaPct: Math.round(snapshot.settings.alpha * 1000) / 10,
    deltaPct: Math.round(snapshot.settings.delta * 1000) / 10,
    windowDays: snapshot.settings.windowDays,
    nMature: snapshot.nMature,
    segmentsValid: valid,
    segmentsPooled: pooled,
    segmentsAbstain: abstain,
  };
}

/**
 * The plain-English statement (also the fallback text for i18n keys). Never stronger than the maths.
 * Primary statement = conditional rate among ALLOWED attempts, holds with confidence 1 - delta (ltt.ts).
 */
export function statementFor(cal: SegmentCalibration, alphaPct: number, windowDays: number, deltaPct = 10): string {
  if (cal.status === 'abstain' || cal.lambda >= LAMBDA_NEVER) return 'Not enough outcome data. Every case in this segment is dispatched.';
  const conf = 100 - deltaPct;
  if (cal.status === 'segment_valid') {
    return `Under the stated assumptions, with ${conf}% confidence, at most ${alphaPct}% of the remote attempts allowed in this segment end as a false resolution (${cal.nAllowed} allowed of ${cal.n} closed cases, ${windowDays}-day window).`;
  }
  return `Under the stated assumptions, with ${conf}% confidence, at most ${alphaPct}% of the remote attempts allowed across all segments combined end as a false resolution (${cal.nAllowed} allowed of ${cal.n} closed cases, ${windowDays}-day window). This segment is too small for its own bound.`;
}

/** The assumptions, in plain language. Shown next to every statement; keys mirror these ids. */
export const ASSUMPTION_IDS = ['exchangeable', 'detectable', 'window', 'restrict_only', 'safety_first'] as const;
export const ASSUMPTIONS_EN: Record<(typeof ASSUMPTION_IDS)[number], string> = {
  exchangeable: 'Future cases behave statistically like the closed cases used for calibration (same customers, same engine version, no sudden change).',
  detectable: 'A failed fix shows up as a reopened case or a linked repeat job. Problems that come back and are never reported are not counted.',
  window: 'Only failures inside the observation window are counted. Cases whose window is still open are left out, never counted as successes.',
  restrict_only: 'This layer can only send more jobs to a technician. It never allows a remote fix that the existing engine would not have allowed.',
  safety_first: 'Gas, carbon monoxide, electrical, fire, flooding, sewage, structural and vulnerable-person temperature cases always get a technician. No setting changes that.',
};

export const FORBIDDEN_CLAIM_WORDS = /\b(guarantee[sd]?|certified|proven|risk[- ]free|safe)\b/i;
