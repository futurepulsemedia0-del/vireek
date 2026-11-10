/**
 * Solar pack — pure workflow + warranty logic (no I/O). The database enforces the same rules
 * (supabase/migrations/20290301000000_solar_pack.sql); solar.test.ts keeps the two in sync.
 * All dates are ISO `YYYY-MM-DD` strings and all date maths is UTC, so results never depend on the viewer's timezone.
 */

/* ------------------------------------------------------------------ */
/* Pipeline stages                                                      */
/* ------------------------------------------------------------------ */

export const SOLAR_STAGE_KEYS = ['design', 'permit', 'interconnection', 'inspection', 'pto'] as const;
export type SolarStageKey = (typeof SOLAR_STAGE_KEYS)[number];

export const SOLAR_STAGE_LABELS: Record<SolarStageKey, string> = {
  design: 'Design',
  permit: 'Permit',
  interconnection: 'Interconnection',
  inspection: 'Inspection',
  pto: 'Permission to operate (PTO)',
};

export const STAGE_STATUSES = ['not_started', 'in_progress', 'submitted', 'corrections_required', 'approved', 'rejected', 'skipped'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  submitted: 'Submitted',
  corrections_required: 'Corrections required',
  approved: 'Approved',
  rejected: 'Rejected',
  skipped: 'Skipped',
};

/** Legal moves. `approved` and `skipped` are terminal. */
export const STAGE_TRANSITIONS: Record<StageStatus, readonly StageStatus[]> = {
  not_started: ['in_progress', 'skipped'],
  in_progress: ['submitted'],
  submitted: ['approved', 'corrections_required', 'rejected'],
  corrections_required: ['in_progress', 'submitted'],
  rejected: ['in_progress'],
  approved: [],
  skipped: [],
};

/** A stage may only be started once every stage it depends on is approved or skipped. */
export const STAGE_DEPENDENCIES: Record<SolarStageKey, readonly SolarStageKey[]> = {
  design: [],
  permit: ['design'],
  interconnection: ['design'],
  inspection: ['permit'],
  pto: ['inspection', 'interconnection'],
};

/** Moves that need a written reason (kept in the append-only event log). */
export const STAGE_NOTE_REQUIRED: readonly StageStatus[] = ['skipped', 'rejected', 'corrections_required'];
export const MIN_NOTE_LENGTH = 5;

export interface StageLike {
  stage_key: SolarStageKey;
  status: StageStatus;
  due_date?: string | null;
}

const satisfied = (s: StageStatus) => s === 'approved' || s === 'skipped';

export function canTransitionStage(from: StageStatus, to: StageStatus): boolean {
  return STAGE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function unmetDependencies(stageKey: SolarStageKey, stages: StageLike[]): SolarStageKey[] {
  return STAGE_DEPENDENCIES[stageKey].filter((dep) => {
    const s = stages.find((x) => x.stage_key === dep);
    return !s || !satisfied(s.status);
  });
}

/** Returns a human-readable reason the move is not allowed, or null when it is. */
export function stageTransitionError(stage: StageLike, to: StageStatus, stages: StageLike[], note?: string | null): string | null {
  if (!canTransitionStage(stage.status, to)) {
    return `${STAGE_STATUS_LABELS[stage.status]} cannot move to ${STAGE_STATUS_LABELS[to]}`;
  }
  if (stage.status === 'not_started') {
    const unmet = unmetDependencies(stage.stage_key, stages);
    if (unmet.length) return `Waiting on: ${unmet.map((k) => SOLAR_STAGE_LABELS[k]).join(', ')}`;
  }
  if (STAGE_NOTE_REQUIRED.includes(to) && (note ?? '').trim().length < MIN_NOTE_LENGTH) {
    return `A reason of at least ${MIN_NOTE_LENGTH} characters is required`;
  }
  return null;
}

/** Moves currently available for a stage (dependency gate applied, note requirement not). */
export function availableStageMoves(stage: StageLike, stages: StageLike[]): StageStatus[] {
  return STAGE_TRANSITIONS[stage.status].filter((to) => {
    const err = stageTransitionError(stage, to, stages, 'x'.repeat(MIN_NOTE_LENGTH));
    return err === null;
  });
}

export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Open stage whose due date has passed (strictly before `today`). */
export function isStageOverdue(stage: Pick<StageLike, 'status' | 'due_date'>, today: string): boolean {
  return !!stage.due_date && stage.due_date < today && !satisfied(stage.status);
}

/**
 * Suggested due date = start + the jurisdiction's configured review days. This is only a prefill:
 * review times are set by the AHJ / utility and are configured by the tenant (REQUIRES AHJ verification).
 */
export function suggestDueDate(stageKey: SolarStageKey, fromISO: string, reviewDays: Partial<Record<SolarStageKey, number>> | null | undefined): string | null {
  const n = reviewDays?.[stageKey];
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 365 ? addDaysISO(fromISO, n) : null;
}

export interface PipelineSummary {
  total: number;
  done: number;
  /** First stage that is not approved/skipped, in pipeline order. */
  current: SolarStageKey | null;
  overdue: SolarStageKey[];
  blocked: SolarStageKey[];
}

export function summarizePipeline(stages: StageLike[], today: string): PipelineSummary {
  const ordered = SOLAR_STAGE_KEYS.map((k) => stages.find((s) => s.stage_key === k)).filter((s): s is StageLike => !!s);
  const open = ordered.filter((s) => !satisfied(s.status));
  return {
    total: ordered.length,
    done: ordered.length - open.length,
    current: open[0]?.stage_key ?? null,
    overdue: ordered.filter((s) => isStageOverdue(s, today)).map((s) => s.stage_key),
    blocked: ordered.filter((s) => s.status === 'not_started' && unmetDependencies(s.stage_key, stages).length > 0).map((s) => s.stage_key),
  };
}

/** A project may complete only when every stage is approved or skipped. */
export function canCompleteProject(stages: StageLike[]): boolean {
  return stages.length === SOLAR_STAGE_KEYS.length && stages.every((s) => satisfied(s.status));
}

/* ------------------------------------------------------------------ */
/* Jurisdiction configuration                                           */
/* ------------------------------------------------------------------ */

export const REQUIRES_COUNSEL_NOTICE =
  'REQUIRES COUNSEL / AHJ VERIFICATION: review times, required steps and document rules vary by jurisdiction and utility. Vireek does not assert code, permit or interconnection compliance. Everything on this profile is your own configuration.';

export interface JurisdictionLike {
  stage_review_days: Partial<Record<SolarStageKey, number>>;
  verified_at: string | null;
}

export const jurisdictionNeedsVerification = (p: Pick<JurisdictionLike, 'verified_at'> | null | undefined): boolean => !p || !p.verified_at;

/** Mirrors solar_jurisdiction_guard(): keys must be pipeline stages, values whole days 0–365. */
export function validateReviewDays(input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (!(SOLAR_STAGE_KEYS as readonly string[]).includes(k)) errors.push(`Unknown stage "${k}"`);
    else if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 365) errors.push(`${SOLAR_STAGE_LABELS[k as SolarStageKey]} must be a whole number of days from 0 to 365`);
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Warranty                                                             */
/* ------------------------------------------------------------------ */

/** start + N calendar years; Feb 29 clamps to Feb 28 (same as PostgreSQL date + interval). */
export function addYearsISO(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y + years, m - 1, d));
  if (t.getUTCMonth() !== m - 1) return new Date(Date.UTC(y + years, m, 0)).toISOString().slice(0, 10);
  return t.toISOString().slice(0, 10);
}

/**
 * Last covered day of an N-year warranty = anniversary − 1 day (inclusive end).
 * ASSUMPTION: manufacturers word this differently — the per-unit `expires_override` always wins.
 */
export function warrantyEnd(startISO: string | null | undefined, years: number | null | undefined): string | null {
  if (!startISO || years == null || !Number.isInteger(years) || years <= 0) return null;
  return addDaysISO(addYearsISO(startISO, years), -1);
}

export interface WarrantyUnitLike {
  warranty_start: string | null;
  product_warranty_years: number | null;
  warranty_expires_override: string | null;
}

/** Override (manufacturer certificate) wins over the computed product-warranty end. */
export function effectiveWarrantyEnd(u: WarrantyUnitLike): string | null {
  return u.warranty_expires_override ?? warrantyEnd(u.warranty_start, u.product_warranty_years);
}

export type WarrantyState = 'unknown' | 'active' | 'expiring_soon' | 'expired';

const utcMs = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/** Whole days from `onISO` to `endISO` (negative once passed). */
export function daysUntil(endISO: string, onISO: string): number {
  return Math.round((utcMs(endISO) - utcMs(onISO)) / 86_400_000);
}

export function warrantyState(endISO: string | null, onISO: string, soonDays = 90): WarrantyState {
  if (!endISO) return 'unknown';
  const left = daysUntil(endISO, onISO);
  if (left < 0) return 'expired';
  return left <= soonDays ? 'expiring_soon' : 'active';
}

export type ClaimCoverage = 'in_warranty' | 'expired' | 'unknown';

/** Was the unit covered on the failure date? (Mirrors solar_claim_guard().) */
export function claimCoverage(u: WarrantyUnitLike, failureISO: string): ClaimCoverage {
  const end = effectiveWarrantyEnd(u);
  if (!end) return 'unknown';
  if (u.warranty_start && failureISO < u.warranty_start) return 'unknown';
  return failureISO <= end ? 'in_warranty' : 'expired';
}

/* ------------------------------------------------------------------ */
/* Warranty claim workflow                                              */
/* ------------------------------------------------------------------ */

export const CLAIM_STATUSES = ['draft', 'submitted', 'under_review', 'info_requested', 'approved', 'denied', 'resolved', 'closed', 'withdrawn'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under review',
  info_requested: 'More info requested',
  approved: 'Approved',
  denied: 'Denied',
  resolved: 'Resolved',
  closed: 'Closed',
  withdrawn: 'Withdrawn',
};

export const CLAIM_TRANSITIONS: Record<ClaimStatus, readonly ClaimStatus[]> = {
  draft: ['submitted', 'withdrawn'],
  submitted: ['under_review', 'info_requested', 'approved', 'denied', 'withdrawn'],
  under_review: ['info_requested', 'approved', 'denied', 'withdrawn'],
  info_requested: ['submitted', 'withdrawn'],
  approved: ['resolved'],
  denied: ['closed', 'under_review'],
  resolved: ['closed'],
  closed: [],
  withdrawn: [],
};

export const CLAIM_RESOLUTIONS = ['repair', 'replace', 'credit', 'refund'] as const;
export type ClaimResolution = (typeof CLAIM_RESOLUTIONS)[number];

export interface ClaimLike {
  status: ClaimStatus;
  warranty_state: ClaimCoverage;
  goodwill: boolean;
  resolution: ClaimResolution | null;
}

export function claimTransitionError(claim: ClaimLike, to: ClaimStatus, note?: string | null, resolution?: ClaimResolution | null): string | null {
  if (!CLAIM_TRANSITIONS[claim.status]?.includes(to)) return `${CLAIM_STATUS_LABELS[claim.status]} cannot move to ${CLAIM_STATUS_LABELS[to]}`;
  if (to === 'submitted' && claim.status === 'draft') {
    if (claim.warranty_state === 'unknown' && !claim.goodwill) return 'Register the unit’s warranty terms, or mark this claim as goodwill';
    if (claim.warranty_state === 'expired' && !claim.goodwill) return 'The warranty had expired on the failure date — mark as goodwill to submit anyway';
  }
  if ((to === 'denied' || to === 'withdrawn') && (note ?? '').trim().length < MIN_NOTE_LENGTH) return `A reason of at least ${MIN_NOTE_LENGTH} characters is required`;
  if (to === 'resolved' && !(resolution ?? claim.resolution)) return 'Choose a resolution (repair, replace, credit or refund)';
  return null;
}
