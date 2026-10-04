// Outcome-Based Pricing Engine — pure pricing core (no I/O, no imports).
//
// Turns "keep this equipment up X% of the time" into a contract price:
//   expected failures -> downtime -> maintenance plan -> cost -> SLA-credit risk -> price.
//
// Method (all deterministic — same input always gives the same quote):
//  1. Failure rate per asset: Gamma-Poisson (empirical Bayes). An equipment-type
//     prior is blended with the asset's own repair history; thin history keeps the
//     prior and widens the risk band.
//  2. Preventive-maintenance (PM) plan: PM visits/year reduce the failure rate
//     with diminishing returns. The engine searches the cheapest plan per asset.
//  3. Monte Carlo (common random numbers): 12 months x N trials of failures and
//     repair durations -> monthly uptime -> tiered SLA credits (capped) + cost.
//  4. Price = (expected cost + risk margin) / (1 - overhead - margin - credit load).
//     Credit exposure is a % of the fee, so it is solved algebraically, not guessed.
//  5. Guardrails: Vireek refuses (or flags for review) guarantees it cannot deliver
//     with enough probability, or that rest on too little data.
//
// IMPORTANT: EQUIPMENT_PRIORS are conservative starting points, not measured facts.
// Calibrate them with your own history (they are blended away as real data arrives).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreditTier {
  /** Tier applies while monthly uptime shortfall (points below target) is <= upToPts. */
  upToPts: number;
  /** Credit as a percent of that month's fee. */
  creditPct: number;
}

export interface PricingAssumptions {
  laborCostPerHour: number;
  truckRollCost: number;
  consumablesPerVisit: number;
  overheadPct: number; // 0..1 of price
  targetMarginPct: number; // 0..1 of price
  riskAversionZ: number; // price at expected + z * stdev
  partsOnTruckRate: number; // 0..1 share of repairs finished on the first visit
  partsLeadHours: number; // extra downtime when the part is not on the truck
  responseHours: number; // time to arrive after a failure
  billRatePerHour: number; // for the T&M comparison only
  tripCharge: number; // T&M trip charge, comparison only
  partsMarkupPct: number; // T&M parts markup, comparison only
  durationCv: number; // variability of repair duration
  minPMeetProbability: number; // required P(annual uptime >= target)
  minDataConfidence: number; // below this -> human review
  minExpectedMarginPct: number; // below this -> human review
}

export const DEFAULT_ASSUMPTIONS: PricingAssumptions = {
  laborCostPerHour: 58,
  truckRollCost: 42,
  consumablesPerVisit: 15,
  overheadPct: 0.12,
  targetMarginPct: 0.22,
  riskAversionZ: 0.5,
  partsOnTruckRate: 0.78,
  partsLeadHours: 30,
  responseHours: 4,
  billRatePerHour: 135,
  tripCharge: 89,
  partsMarkupPct: 0.35,
  durationCv: 0.6,
  minPMeetProbability: 0.8,
  minDataConfidence: 0.3,
  minExpectedMarginPct: 0.12,
};

export const DEFAULT_CREDIT_SCHEDULE: CreditTier[] = [
  { upToPts: 0.5, creditPct: 5 },
  { upToPts: 1.5, creditPct: 15 },
  { upToPts: 3, creditPct: 30 },
  { upToPts: 100, creditPct: 50 },
];

export const DEFAULT_ANNUAL_CREDIT_CAP_PCT = 25;
export const MAX_ASSETS = 60;
export const MAX_PM_VISITS = 12;
export const PM_CANDIDATES = [0, 1, 2, 3, 4, 6, 8, 12];
export const DEFAULT_CURVE_TARGETS = [95, 97, 98, 99, 99.5, 99.9];
export const PR
