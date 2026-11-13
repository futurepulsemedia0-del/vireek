/**
 * Dispatch Optimizer - shared types and defaults.
 *
 * Used by the engine (model.ts, solver.ts), the dispatch-optimizer edge function (Deno) and the
 * client (OptimizerPanel, dispatchOptimizerApi). Keep this file free of runtime dependencies other
 * than type imports, so it loads the same in the browser, vitest and Deno.
 */
import type { GeoPoint } from '../dispatchIntelligence.ts';

export type { GeoPoint };

/** Bump when a change can alter the plan produced for the same input + seed. */
export const OPTIMIZER_ENGINE_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Per-account weights, each 0-10 (clamped by resolveConfig). */
export interface OptWeights {
  revenue: number;
  travel: number;
  slaRisk: number;
  overtimeFairness: number;
}

export type PartsPolicy = 'soft' | 'hard';

export interface OptConfig {
  /** Seed of the deterministic local search. */
  seed: number;
  weights: OptWeights;
  /** 'hard': a van that lacks required parts cannot take the job. 'soft': it only costs points. */
  partsPolicy: PartsPolicy;
  /** true: an SLA deadline is a hard constraint instead of a cost. */
  slaHard: boolean;
  maxIterations: number;
  /** Local search stops after this many iterations without improvement. */
  stagnationLimit: number;
  /** Optional wall-clock valve in ms; null = none. When it fires the result reports truncatedByTime. */
  timeBudgetMs: number | null;
  /** Minutes assumed for a leg whose travel time is unknown (missing coordinates). */
  unknownTravelMin: number;
  /** Minutes before an SLA deadline from which risk starts to cost points. */
  slaBufferMin: number;
  /** Cost of moving a job away from the technician it is currently assigned to. */
  stabilityPenalty: number;
}

export const DEFAULT_WEIGHTS: OptWeights = { revenue: 1, travel: 1, slaRisk: 1, overtimeFairness: 1 };

export const DEFAULT_CONFIG: OptConfig = {
  seed: 1,
  weights: DEFAULT_WEIGHTS,
  partsPolicy: 'soft',
  slaHard: false,
  maxIterations: 20_000,
  stagnationLimit: 3_000,
  timeBudgetMs: null,
  unknownTravelMin: 15,
  slaBufferMin: 30,
  stabilityPenalty: 5,
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface OptShift {
  /** Calendar day of the shift (stable key used for the daily fairness comparison). */
  dayKey: string;
  startMs: number;
  endMs: number;
}

export interface OptTech {
  id: string;
  name: string;
  /** Where the technician starts (home / current position). null = unknown. */
  start: GeoPoint | null;
  /** Working shifts in the planning horizon (time off already removed). Empty = not working. */
  shifts: OptShift[];
  /** Not available before this instant (e.g. still finishing a job). */
  availableFromMs?: number | null;
  /** Allowed overtime past the shift end, in minutes. */
  maxOvertimeMin: number;
  maxJobsPerShift: number;
  skills: string[];
  certifications: string[];
}

/**
 * none: free to move. tech: stays with its current technician but the time may change.
 * full: fixed technician and fixed start time.
 */
export type JobLock = 'none' | 'tech' | 'full';

export interface OptJob {
  id: string;
  /** Human label for suggestions (optional). */
  label?: string;
  point: GeoPoint | null;
  durationMin: number;
  /** Customer arrival window. */
  window?: { startMs: number; endMs: number } | null;
  /** Earliest possible start, independent of the window. */
  earliestMs?: number | null;
  slaDeadlineMs: number | null;
  lock: JobLock;
  current: { techId: string | null; startMs: number | null };
  requiredSkills: string[];
  requiredCerts: string[];
  revenueCents: number;
  /** 1 = normal; larger = more urgent. */
  priority: number;
  emergency: boolean;
}

/** Travel time in minutes between two points, or null when unknown. Must be synchronous and pure. */
export type TravelFn = (a: GeoPoint, b: GeoPoint) => number | null;

/** Parts a van carries vs. what a job needs: partsFit[jobId][techId]. */
export interface PartsFit {
  required: number;
  onVan: number;
}

export interface OptInput {
  /** "Now" in epoch ms. Nothing is scheduled before it. */
  nowMs: number;
  techs: OptTech[];
  jobs: OptJob[];
  config?: Partial<OptConfig>;
  /** Defaults to the offline straight-line estimate. */
  travel?: TravelFn;
  partsFit?: Record<string, Record<string, PartsFit>>;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Schedule quality numbers, compared before / after a suggestion set. */
export interface Metrics {
  assigned: number;
  unassigned: number;
  travelMin: number;
  slaMisses: number;
  slaLateMin: number;
  overtimeMin: number;
  /** Service minutes / available minutes, 0-1. */
  utilization: number;
  revenueScheduledCents: number;
  revenueUnscheduledCents: number;
  fairnessDeviationHours: number;
  hardViolations: number;
  unknownTravelLegs: number;
}

export interface CostBreakdown {
  unassigned: number;
  travel: number;
  sla: number;
  overtime: number;
  fairness: number;
  parts: number;
  stability: number;
  total: number;
}

export interface PlacedJob {
  jobId: string;
  techId: string;
  routeId: string;
  dayKey: string;
  position: number;
  startMs: number;
  endMs: number;
  travelMinFromPrev: number;
  travelKnown: boolean;
  slaLateMin: number;
  overtimeMin: number;
}

export interface UnplacedJob {
  jobId: string;
  reasons: string[];
}

export interface OptResult {
  engineVersion: string;
  seed: number;
  placed: PlacedJob[];
  unplaced: UnplacedJob[];
  /** Fixed jobs that could not be placed in any route (they only block time). */
  unmodeledFixed: string[];
  metrics: Metrics;
  cost: CostBreakdown;
  iterations: number;
  truncatedByTime: boolean;
}
