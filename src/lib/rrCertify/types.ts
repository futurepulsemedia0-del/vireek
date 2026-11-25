/**
 * rrCertify — risk-control layer for the Remote Resolution Engine (RRE). Pure TypeScript, no I/O.
 *
 * IMPORTANT (read before changing anything):
 *  - This layer is RESTRICT-ONLY. It can turn "attempt remotely" into "dispatch". It can never turn a
 *    dispatch into a remote attempt, and it can never touch the deterministic safety screen.
 *  - Every import in this folder uses an explicit ".ts" suffix and only relative paths, because
 *    Supabase edge functions (Deno) import this folder directly (see supabase/functions/remote-resolution).
 */

export const RR_CERTIFY_MODEL_VERSION = 1;

/** Per-account rollout state. 'off' is the default and means: nothing is logged, nothing changes. */
export type CertifyMode = 'off' | 'shadow' | 'enforce';

export interface CertifySettings {
  /** Target bound on the false-resolution rate (0..1). Used for BOTH statements, see ltt.ts / crc.ts. */
  alpha: number;
  /** Confidence parameter of the conditional statement: it holds with probability >= 1 - delta. */
  delta: number;
  /** Observation window W in days, starting when the customer confirms the fix. */
  windowDays: number;
  /** Minimum matured cases in a segment before the segment gets its own guarantee. */
  minSegmentN: number;
  /** Minimum matured cases overall before ANY guarantee can exist. Below it: always dispatch. */
  minPooledN: number;
}

/** Conservative defaults. Stricter than the loosest allowed values on purpose. */
export const DEFAULT_CERTIFY_SETTINGS: CertifySettings = {
  alpha: 0.05,
  delta: 0.1,
  windowDays: 30,
  minSegmentN: 150,
  minPooledN: 100,
};

export const CERTIFY_BOUNDS = {
  alpha: [0.005, 0.25],
  delta: [0.01, 0.2],
  windowDays: [7, 90],
  minSegmentN: [30, 5000],
  minPooledN: [60, 20000],
} as const;

/** One attempted case as read from the database (see rr_certify_case_outcomes). */
export interface CaseOutcomeRow {
  case_id: string;
  /** 'tradeGroup:category', see segments.ts */
  segment: string;
  /** attempt_probability, integer 0..100, frozen when the attempt started. */
  score: number;
  /** The account's attempt_threshold at decision time, or null when it was never logged. */
  threshold: number | null;
  thresholdSource: 'logged' | 'assumed_current';
  /** remote_resolution_cases.status */
  status: string;
  resolvedAt: string | null;
  reopenedAt: string | null;
  /** created_at of the earliest later job linked to this job through rework_of_job_id. */
  repeatJobAt: string | null;
}

export type LabelState = 'mature' | 'censored' | 'active';

export interface LabeledCase {
  caseId: string;
  segment: string;
  score: number;
  /** 1 = false resolution inside the window, 0 = no failure observed inside the window. */
  loss: 0 | 1;
  /** End of the observation window (ISO). Null for cases that never closed as resolved. */
  observedUntil: string | null;
  threshold: number;
  thresholdSource: 'logged' | 'assumed_current';
}

export type SegmentStatus =
  /** Own guarantee for this segment (exchangeability within the segment assumed). */
  | 'segment_valid'
  /** Segment too small: uses the pooled threshold. The bound holds for the POOLED average only. */
  | 'pooled_only'
  /** No valid guarantee: always dispatch. */
  | 'abstain';

export type AbstainReason =
  | 'not_enough_cases'
  | 'no_threshold_meets_bound'
  | 'ok';

export interface SegmentCalibration {
  segment: string;
  status: SegmentStatus;
  /** Gate allows a remote attempt only when score >= lambda. 101 = never allow. */
  lambda: number;
  /** Matured cases the decision rests on (segment cases, or pooled cases for pooled_only). */
  n: number;
  /** Observed false resolutions among those cases with score >= lambda. */
  k: number;
  /** How many of those n cases the gate would have allowed (score >= lambda). */
  nAllowed: number;
  /** (k + 1) / (n + 1): the finite-sample-corrected per-attempt risk at lambda (CRC). Null when abstaining. */
  correctedRisk: number | null;
  /** k / nAllowed: observed rate among allowed cases. Descriptive only, NOT the guarantee. */
  conditionalRate: number | null;
  /** Exact binomial p-value behind the conditional statement. */
  pValue: number | null;
  abstainReason: AbstainReason;
}

export interface CalibrationSnapshot {
  /** Assigned by the database when the snapshot is stored. */
  id: string | null;
  modelVersion: number;
  createdAt: string;
  settings: CertifySettings;
  /** Lowest lambda that was evaluated (the largest decision-time threshold in the data). */
  lambdaMin: number;
  nMature: number;
  nCensored: number;
  nActive: number;
  /** Share of matured cases whose decision-time threshold was assumed instead of logged. */
  assumedThresholdShare: number;
  pooled: SegmentCalibration;
  segments: Record<string, SegmentCalibration>;
  /** Over all matured cases: how many the per-segment gate would have allowed, and how many of those failed. */
  allowedN: number;
  allowedK: number;
  /** Deterministic fingerprint of the calibration data. NOT cryptographic. */
  fingerprint: string;
}

export const LAMBDA_NEVER = 101;
