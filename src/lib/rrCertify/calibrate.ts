/**
 * Builds a CalibrationSnapshot from labeled (matured) cases.
 *
 * Fallback ladder: segment (n >= minSegmentN) -> pooled (n >= minPooledN) -> ABSTAIN (always dispatch).
 * A snapshot is a pure function of its inputs: same cases + settings + `now` => identical snapshot.
 */
import { selectThreshold } from './ltt.ts';
import { labelAll } from './outcomes.ts';
import {
  LAMBDA_NEVER,
  RR_CERTIFY_MODEL_VERSION,
  type CalibrationSnapshot,
  type CaseOutcomeRow,
  type CertifySettings,
  type LabeledCase,
  type SegmentCalibration,
} from './types.ts';

/** FNV-1a (32 bit) over the sorted calibration data. A change detector for audit, not a security hash. */
export function fingerprintCases(cases: readonly LabeledCase[]): string {
  const rows = [...cases].map((c) => `${c.caseId}|${c.segment}|${c.score}|${c.loss}`).sort();
  let h = 0x811c9dc5;
  for (const r of rows) {
    for (let i = 0; i < r.length; i++) {
      h ^= r.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 10;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a32:${h.toString(16).padStart(8, '0')}:n${rows.length}`;
}

function calibrateGroup(segment: string, cases: LabeledCase[], settings: CertifySettings, lambdaMin: number): SegmentCalibration {
  const r = selectThreshold(cases, settings.alpha, settings.delta, lambdaMin);
  if (r.abstain) {
    return { segment, status: 'abstain', lambda: LAMBDA_NEVER, n: r.n, k: 0, nAllowed: 0, correctedRisk: null, conditionalRate: null, pValue: null, abstainReason: 'no_threshold_meets_bound' };
  }
  return {
    segment, status: 'segment_valid', lambda: r.lambda, n: r.n, k: r.k, nAllowed: r.nAllowed,
    correctedRisk: (r.k + 1) / (r.n + 1), conditionalRate: r.conditionalRate, pValue: r.pValue, abstainReason: 'ok',
  };
}

export function buildSnapshot(args: {
  rows: CaseOutcomeRow[];
  settings: CertifySettings;
  now: Date;
  /** Current account attempt_threshold; stands in for rows whose decision-time threshold was never logged. */
  fallbackThreshold: number;
}): CalibrationSnapshot {
  const { rows, settings, now, fallbackThreshold } = args;
  const sum = labelAll(rows, settings.windowDays, now, fallbackThreshold);
  const mature = sum.mature;
  const lambdaMin = mature.length ? Math.max(...mature.map((c) => c.threshold)) : fallbackThreshold;
  const assumed = mature.filter((c) => c.thresholdSource === 'assumed_current').length;

  // Pooled calibration.
  let pooled: SegmentCalibration;
  if (mature.length < settings.minPooledN) {
    pooled = { segment: '*', status: 'abstain', lambda: LAMBDA_NEVER, n: mature.length, k: 0, nAllowed: 0, correctedRisk: null, conditionalRate: null, pValue: null, abstainReason: 'not_enough_cases' };
  } else {
    pooled = { ...calibrateGroup('*', mature, settings, lambdaMin) };
  }

  const bySegment = new Map<string, LabeledCase[]>();
  for (const c of mature) {
    const list = bySegment.get(c.segment);
    if (list) list.push(c);
    else bySegment.set(c.segment, [c]);
  }

  const segments: Record<string, SegmentCalibration> = {};
  for (const [seg, list] of [...bySegment.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (pooled.status === 'abstain' && pooled.abstainReason === 'not_enough_cases') {
      // Below the pooled minimum nothing is certified, not even a large segment.
      segments[seg] = { segment: seg, status: 'abstain', lambda: LAMBDA_NEVER, n: list.length, k: 0, nAllowed: 0, correctedRisk: null, conditionalRate: null, pValue: null, abstainReason: 'not_enough_cases' };
    } else if (list.length >= settings.minSegmentN) {
      segments[seg] = calibrateGroup(seg, list, settings, lambdaMin);
    } else if (pooled.status === 'segment_valid') {
      // Pooled fallback. The bound then holds for the pooled average only, so the status says so.
      segments[seg] = { ...pooled, segment: seg, status: 'pooled_only' };
    } else {
      segments[seg] = { segment: seg, status: 'abstain', lambda: LAMBDA_NEVER, n: pooled.n, k: 0, nAllowed: 0, correctedRisk: null, conditionalRate: null, pValue: null, abstainReason: pooled.abstainReason };
    }
  }

  let allowedN = 0;
  let allowedK = 0;
  for (const c of mature) {
    const cal = segments[c.segment];
    if (cal && cal.status !== 'abstain' && c.score >= cal.lambda) {
      allowedN += 1;
      allowedK += c.loss;
    }
  }

  return {
    id: null,
    modelVersion: RR_CERTIFY_MODEL_VERSION,
    createdAt: now.toISOString(),
    settings: { ...settings },
    lambdaMin,
    nMature: mature.length,
    nCensored: sum.nCensored,
    nActive: sum.nActive,
    assumedThresholdShare: mature.length ? assumed / mature.length : 0,
    pooled: pooled.status === 'segment_valid' ? { ...pooled, status: 'segment_valid' } : pooled,
    segments,
    allowedN,
    allowedK,
    fingerprint: fingerprintCases(mature),
  };
}

/** Calibration for a segment the snapshot has never seen: pooled when valid, otherwise abstain. */
export function calibrationFor(snapshot: CalibrationSnapshot, segment: string): SegmentCalibration {
  const own = snapshot.segments[segment];
  if (own) return own;
  if (snapshot.pooled.status === 'segment_valid') return { ...snapshot.pooled, segment, status: 'pooled_only' };
  return { ...snapshot.pooled, segment, status: 'abstain', lambda: LAMBDA_NEVER };
}
