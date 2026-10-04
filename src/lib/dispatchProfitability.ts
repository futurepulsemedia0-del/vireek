/**
 * Job Profitability BEFORE Dispatch — client library.
 *
 * Extends the existing skill/service-area/capacity ranking in `dispatch.ts`
 * with an actual expected-gross-profit estimate per candidate technician,
 * computed BEFORE the job is assigned:
 *
 *   Expected Revenue  − Labor − Parts − Travel − Risk  =  Expected Gross Profit
 *
 * Data lineage (no new tables, no new edge function — same philosophy as
 * technicianPerformance.ts / dispatch.ts):
 *   - Revenue      → jobs.invoice_amount (DOLLARS in the row — see
 *                    tradePlaybooks.ts:264 for the same *100 conversion)
 *                    if set, else a tunable flat fallback.
 *   - Labor        → team_members.hourly_cost_rate_cents × estimated duration.
 *   - Parts        → truckStock.ts StockFitRow (parts_required vs
 *                    parts_on_van) for the missing-parts surcharge, plus a
 *                    flat parts-to-ticket ratio for baseline materials.
 *   - Travel       → haversineMiles() (routing.ts) between the technician's
 *                    current/home location and the job, converted to drive
 *                    time (opportunity cost) + a per-mile fuel/wear cost.
 *   - Risk         → technician_scorecards.first_time_fix_rate (via
 *                    fetchTechnicianScorecards() in technicianPerformance.ts)
 *                    — probability-weighted cost of a callback redoing part
 *                    of the job.
 *
 * All the constants below are explicit, named and safe to tune once real
 * numbers are known — they're deliberately NOT hidden inside the math.
 * Pure functions only, no I/O, so this is trivially unit-testable the same
 * way dispatch.test.ts already tests suggestTechnicians().
 */

import type { Job, TeamMember } from '@/lib/supabase';
import type { StockFitRow } from '@/lib/truckStock';
import { haversineMiles } from '@/lib/routing';

// ============================================================
// TUNABLE ASSUMPTIONS — adjust to match real book-of-business numbers.
// Every one of these is a fallback used only when the real data point
// (job, technician, or scorecard) doesn't have a value yet.
// ============================================================

/** Used when a job has no invoice_amount yet (typical pre-completion state). */
export const DEFAULT_JOB_REVENUE_CENTS = 45_000; // $450 generic ticket

/** Used when a job has no duration_minutes set. */
export const DEFAULT_JOB_DURATION_MINUTES = 90;

/** Used when a technician has no hourly_cost_rate_cents set. */
export const DEFAULT_HOURLY_COST_CENTS = 3_500; // $35/hr loaded technician cost

/** Baseline materials cost as a fraction of expected revenue. */
export const PARTS_COST_RATIO = 0.12;

/** Extra cost per missing required part (delay, second trip, rush order). */
export const MISSING_PART_SURCHARGE_CENTS = 1_500;

/** Blended urban/suburban driving speed used to turn distance into time. */
export const AVG_TRAVEL_SPEED_MPH = 28;

/** Fuel + wear cost per mile (roughly IRS-mileage-rate range). */
export const MILEAGE_COST_CENTS_PER_MILE = 67;

/** Used when neither technician nor job has usable coordinates. */
export const DEFAULT_TRAVEL_MILES = 8;

/** Probability of a callback when the technician has no scorecard history yet. */
export const DEFAULT_RISK_FRACTION = 0.15;

/**
 * A callback doesn't repeat the whole job — the diagnosis is already known —
 * so this is the fraction of (labor + travel) a rework is assumed to cost.
 */
export const REWORK_COST_FACTOR = 0.6;

/** Sanity bounds so one bad GPS day can never wreck a ranking. */
export const FLEET_MIN_SPEED_MPH = 12;
export const FLEET_MAX_SPEED_MPH = 55;
export const FLEET_MIN_COST_CENTS_PER_MILE = 20;
export const FLEET_MAX_COST_CENTS_PER_MILE = 300;
export const FLEET_MIN_ON_SITE_MINUTES = 20;
export const FLEET_MAX_ON_SITE_MINUTES = 480;
/** A truck GPS fix older than this is no longer "where the truck is". */
export const FLEET_LIVE_POSITION_MAX_AGE_MINUTES = 20;

// ============================================================
// TYPES
// ============================================================

/**
 * What real telematics history says about a technician + their truck
 * (built from fleet_intelligence_profiles by src/lib/fleetIntelligence.ts).
 * Every field is optional-by-null: a missing value simply falls back to the
 * tunable defaults above, so dispatch keeps working with zero fleet data.
 */
export interface FleetDispatchSignal {
  technicianId: string;
  /** Live truck position; null when the truck has not reported recently. */
  vehicleLocation: { lat: number; lng: number; ageMinutes: number } | null;
  /** Average moving speed over recent trips. */
  avgSpeedMph: number | null;
  /** Marginal cost of one more mile (fuel + wear), in cents. */
  costPerMileCents: number | null;
  /** Average fuel burned idling per trip, in cents. */
  idleCostPerTripCents: number | null;
  /** service_type → typical on-site minutes for THIS technician. */
  onSiteMinutesByService: Record<string, number>;
  onTimePct: number | null;
  sampleSize: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface TechnicianProfitabilityEstimate {
  technician: TeamMember;
  atCapacity: boolean;
  expectedRevenueCents: number;
  expectedLaborCents: number;
  expectedPartsCents: number;
  expectedTravelCents: number;
  expectedRiskCents: number;
  expectedGrossProfitCents: number;
  expectedMarginPct: number | null;
  distanceMiles: number | null;
  firstTimeFixRate: number | null;
  missingPartsCount: number;
  /** True when real telematics history changed at least one input of this estimate. */
  usedFleetData: boolean;
  onTimePct: number | null;
  reasons: string[];
}

// ============================================================
// HELPERS
// ============================================================

function isSameDay(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** jobs.invoice_amount is stored in DOLLARS — this returns CENTS. */
export function estimateJobRevenueCents(job: Job, fallbackCents = DEFAULT_JOB_REVENUE_CENTS): number {
  if (typeof job.invoice_amount === 'number' && job.invoice_amount > 0) {
    return Math.round(job.invoice_amount * 100);
  }
  return fallbackCents;
}

function technicianLocation(tech: TeamMember): { lat: number; lng: number } | null {
  if (tech.current_latitude != null && tech.current_longitude != null) {
    return { lat: tech.current_latitude, lng: tech.current_longitude };
  }
  if (tech.home_latitude != null && tech.home_longitude != null) {
    return { lat: tech.home_latitude, lng: tech.home_longitude };
  }
  return null;
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

// ============================================================
// CORE ESTIMATE (single technician × job)
// ============================================================

export function estimateTechnicianProfitability(
  job: Job,
  tech: TeamMember,
  jobsByTechnician: Record<string, Job[]>,
  stockFit: StockFitRow | undefined,
  firstTimeFixRate: number | null,
  fleet: FleetDispatchSignal | null = null,
): TechnicianProfitabilityEstimate {
  const reasons: string[] = [];
  let usedFleetData = false;

  const todaysJobs = (jobsByTechnician[tech.id] ?? []).filter((j) => isSameDay(j.scheduled_datetime, job.scheduled_datetime));
  const load = todaysJobs.length;
  const capacity = tech.max_jobs_per_day || 6;
  const atCapacity = load >= capacity;
  reasons.push(`${load}/${capacity} jobs today`);

  const fleetOnSite = job.service_type ? fleet?.onSiteMinutesByService[job.service_type] : undefined;
  let durationMinutes = job.duration_minutes ?? DEFAULT_JOB_DURATION_MINUTES;
  if (job.duration_minutes == null && fleetOnSite != null) {
    durationMinutes = Math.min(FLEET_MAX_ON_SITE_MINUTES, Math.max(FLEET_MIN_ON_SITE_MINUTES, Math.round(fleetOnSite)));
    usedFleetData = true;
    reasons.push(`Typical ${job.service_type} time ${durationMinutes} min (fleet history)`);
  }
  const hourlyCostCents = tech.hourly_cost_rate_cents ?? DEFAULT_HOURLY_COST_CENTS;

  // Revenue
  const expectedRevenueCents = estimateJobRevenueCents(job);

  // Labor
  const expectedLaborCents = Math.round((hourlyCostCents * durationMinutes) / 60);

  // Parts
  const missingPartsCount = stockFit ? Math.max(0, stockFit.parts_required - stockFit.parts_on_van) : 0;
  const expectedPartsCents =
    Math.round(expectedRevenueCents * PARTS_COST_RATIO) + missingPartsCount * MISSING_PART_SURCHARGE_CENTS;
  if (missingPartsCount > 0) {
    reasons.push(`${missingPartsCount} required part(s) missing from truck`);
  }

  // Travel
  const truck =
    fleet?.vehicleLocation && fleet.vehicleLocation.ageMinutes <= FLEET_LIVE_POSITION_MAX_AGE_MINUTES
      ? fleet.vehicleLocation
      : null;
  const loc = truck ?? technicianLocation(tech);
  let distanceMiles: number | null = null;
  if (loc && job.latitude != null && job.longitude != null) {
    distanceMiles = Math.round(haversineMiles(loc.lat, loc.lng, job.latitude, job.longitude) * 10) / 10;
    reasons.push(truck ? `${distanceMiles} mi away (live truck GPS)` : `${distanceMiles} mi away`);
    if (truck) usedFleetData = true;
  } else {
    reasons.push('Location unknown — using default travel estimate');
  }
  const milesForCost = distanceMiles ?? DEFAULT_TRAVEL_MILES;
  const speedMph =
    fleet?.avgSpeedMph != null
      ? Math.min(FLEET_MAX_SPEED_MPH, Math.max(FLEET_MIN_SPEED_MPH, fleet.avgSpeedMph))
      : AVG_TRAVEL_SPEED_MPH;
  const centsPerMile =
    fleet?.costPerMileCents != null
      ? Math.min(FLEET_MAX_COST_CENTS_PER_MILE, Math.max(FLEET_MIN_COST_CENTS_PER_MILE, fleet.costPerMileCents))
      : MILEAGE_COST_CENTS_PER_MILE;
  const idleCents = fleet?.idleCostPerTripCents != null ? Math.max(0, Math.round(fleet.idleCostPerTripCents)) : 0;
  if (fleet && (fleet.avgSpeedMph != null || fleet.costPerMileCents != null)) {
    usedFleetData = true;
    reasons.push(`Real avg speed ${Math.round(speedMph)} mph · ${Math.round(centsPerMile)}¢/mi (${fleet.sampleSize} trips)`);
  }
  const travelMinutes = (milesForCost / speedMph) * 60;
  const expectedTravelCents =
    Math.round((hourlyCostCents * travelMinutes) / 60) + Math.round(milesForCost * centsPerMile) + idleCents;

  // Risk (expected cost of a callback)
  const riskFraction = firstTimeFixRate != null ? (100 - firstTimeFixRate) / 100 : DEFAULT_RISK_FRACTION;
  if (firstTimeFixRate != null) {
    reasons.push(`First-time-fix ${firstTimeFixRate}%`);
  } else {
    reasons.push('No first-time-fix history yet — using default risk');
  }
  const expectedRiskCents = Math.round(riskFraction * REWORK_COST_FACTOR * (expectedLaborCents + expectedTravelCents));

  const expectedGrossProfitCents =
    expectedRevenueCents - expectedLaborCents - expectedPartsCents - expectedTravelCents - expectedRiskCents;
  const expectedMarginPct =
    expectedRevenueCents > 0 ? Math.round((expectedGrossProfitCents / expectedRevenueCents) * 1000) / 10 : null;

  if (job.service_type && tech.skills.includes(job.service_type)) {
    reasons.push(`Skilled in ${job.service_type}`);
  }
  if (fleet?.onTimePct != null) reasons.push(`On-time arrival ${Math.round(fleet.onTimePct)}%`);

  return {
    technician: tech,
    atCapacity,
    expectedRevenueCents,
    expectedLaborCents,
    expectedPartsCents,
    expectedTravelCents,
    expectedRiskCents,
    expectedGrossProfitCents,
    expectedMarginPct,
    distanceMiles,
    firstTimeFixRate,
    missingPartsCount,
    usedFleetData,
    onTimePct: fleet?.onTimePct ?? null,
    reasons,
  };
}

// ============================================================
// RANKING (all candidates × one job)
// ============================================================

/**
 * Ranks dispatch-enabled technicians for a job by EXPECTED GROSS PROFIT,
 * not just skill/capacity/travel fit — those three are folded into the
 * estimate itself (capacity gates eligibility, skill and travel drive the
 * labor/travel/risk lines). At-capacity technicians are excluded, same as
 * suggestTechnicians() in dispatch.ts.
 *
 * @param firstTimeFixByTechnician  technician_id → most recent
 *   first_time_fix_rate from technician_scorecards (null if none saved yet).
 * @param fleetByTechnician  technician_id → real telematics signal (live truck
 *   GPS, real speed, real cost/mile, typical on-site time). Optional: with no
 *   entry the estimate uses the tunable defaults exactly as before.
 */
export function rankTechniciansByProfitability(
  job: Job,
  technicians: TeamMember[],
  jobsByTechnician: Record<string, Job[]>,
  stockFit: Record<string, StockFitRow>,
  firstTimeFixByTechnician: Record<string, number | null>,
  fleetByTechnician: Record<string, FleetDispatchSignal> = {},
): TechnicianProfitabilityEstimate[] {
  return technicians
    .filter((t) => t.role === 'technician' && t.dispatch_enabled)
    .map((tech) =>
      estimateTechnicianProfitability(
        job,
        tech,
        jobsByTechnician,
        stockFit[tech.id],
        firstTimeFixByTechnician[tech.id] ?? null,
        fleetByTechnician[tech.id] ?? null,
      ),
    )
    .filter((e) => !e.atCapacity)
    .sort((a, b) => b.expectedGrossProfitCents - a.expectedGrossProfitCents);
}

export { formatMoney as formatProfitabilityCents };
