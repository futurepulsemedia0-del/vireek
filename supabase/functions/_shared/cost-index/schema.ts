// supabase/functions/_shared/cost-index/schema.ts
//
// Vireek Cost Index (item 140): anonymized repair / install price index by region and trade, built ONLY from
// organisations that opted in to the aggregate-report programme (report_contribution_settings).
// Thresholds are the SAME constants as the State of Home Service Calls pipeline (reuse, never fork):
// they may be raised per release but never lowered below these floors.

import { DOMINANCE_MAX_SHARE, K_MIN_PUBLIC, MIN_EVENTS_PER_CELL, PERIOD_KEY_RE, REGIONS } from "../state-of-calls/schema.ts";

export { DOMINANCE_MAX_SHARE, K_MIN_PUBLIC, MIN_EVENTS_PER_CELL, PERIOD_KEY_RE, REGIONS };

export const METHOD_VERSION = "cost-index-1.0.0";

export const JOB_KINDS = ["repair", "install"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Rollup across all census regions for a trade + job kind. Never a finer geography than a census region. */
export const ALL_REGIONS = "all";
export type RegionValue = (typeof REGIONS)[number] | typeof ALL_REGIONS;

export const TRADE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

/**
 * Engineering parameters of the aggregation (documented in docs/cost-index/METHODOLOGY.md).
 * TODO(owner): confirm these values before the first real release; they are conservative defaults, not company facts.
 */
export const PARAMS = {
  /** A job counts only if its invoiced amount is inside this band (removes $0 placeholders and data-entry errors). */
  priceFloorCents: 2_500,
  priceCeilingCents: 25_000_000,
  /** An organisation contributes to a cell only with at least this many qualifying jobs in it. */
  minJobsPerOrg: 3,
} as const;

export type SuppressionReason = "k_anonymity" | "dominance" | "low_volume" | "complementary" | "no_data";

export interface DisclosureOptions { kMin?: number; dominanceMax?: number; minEvents?: number }

/** One aggregate row as returned by cost_index_build_raw_cells(). Carries no organisation identifier. */
export interface RawCell {
  trade: string;
  region: RegionValue;
  job_kind: JobKind;
  period_key: string;
  n_orgs: number;
  n_jobs: number;
  org_p25_cents: number | null;
  org_p50_cents: number | null;
  org_p75_cents: number | null;
  /** Largest single organisation's share of the cell's jobs, 0..1. */
  max_org_share: number;
}
export const RAW_CELL_FIELDS = [
  "trade", "region", "job_kind", "period_key", "n_orgs", "n_jobs", "org_p25_cents", "org_p50_cents", "org_p75_cents", "max_org_share",
] as const;

/** The only shape that can ever be stored in cost_index_cells or served publicly. */
export interface PublishedCell {
  trade: string;
  region: RegionValue;
  job_kind: JobKind;
  period_key: string;
  suppressed: boolean;
  suppression_reason: SuppressionReason | null;
  n_orgs: number | null;
  n_jobs: number | null;
  p25_cents: number | null;
  p50_cents: number | null;
  p75_cents: number | null;
}
export const PUBLISHED_CELL_FIELDS = [
  "trade", "region", "job_kind", "period_key", "suppressed", "suppression_reason", "n_orgs", "n_jobs", "p25_cents", "p50_cents", "p75_cents",
] as const;

export const cellKey = (c: { trade: string; region: string; job_kind: string; period_key: string }) =>
  `${c.job_kind}|${c.trade}|${c.region}|${c.period_key}`;

/**
 * Price coarsening. Prices are never published exactly:
 *   < $1,000 -> nearest $10;  < $10,000 -> nearest $50;  otherwise nearest $100.
 * Mirrored by public.cost_index_step_cents() which backs a CHECK constraint on cost_index_cells.
 */
export function priceStepCents(cents: number): number {
  if (cents < 100_000) return 1_000;
  if (cents < 1_000_000) return 5_000;
  return 10_000;
}
export function roundPriceCents(cents: number): number {
  const s = priceStepCents(cents);
  return Math.round(cents / s) * s;
}
export const isRoundedPrice = (cents: number) => Number.isInteger(cents) && cents >= 0 && cents % priceStepCents(cents) === 0;
