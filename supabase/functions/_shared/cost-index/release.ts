// supabase/functions/_shared/cost-index/release.ts
// Frozen public release document + CSV for the Vireek Cost Index. Pure; consumes ONLY finished PublishedCell[].

import { assertCostIndexPublishable, type DisclosureReport } from "./disclosure.ts";
import { DOMINANCE_MAX_SHARE, K_MIN_PUBLIC, METHOD_VERSION, MIN_EVENTS_PER_CELL, PARAMS, type PublishedCell } from "./schema.ts";

export const REVIEW_ITEMS = [
  "consent_ledger_checked",      // only organisations with an active 'granted' consent were included
  "thresholds_confirmed",        // k, dominance and volume floors match docs/cost-index/METHODOLOGY.md
  "service_map_reviewed",        // service_type -> repair/install mapping reviewed for this period
  "spot_check_recomputed",       // at least 3 cells independently recomputed and matched
  "methodology_page_current",    // methodology wording matches this method_version
  "legal_review_complete",       // TODO(counsel): wording of the public page and terms
] as const;
export type ReviewItem = (typeof REVIEW_ITEMS)[number];

export interface ReviewState {
  items?: Partial<Record<ReviewItem, boolean>>;
  reviewer?: string;
  second_reviewer?: string;
  reviewed_at?: string;
}

/** Same rule the SQL publish function enforces: every item ticked, two different named reviewers. */
export function reviewComplete(r: ReviewState | null | undefined): { ok: boolean; missing: string[] } {
  const missing: string[] = REVIEW_ITEMS.filter((k) => r?.items?.[k] !== true);
  const a = (r?.reviewer ?? "").trim().toLowerCase(), b = (r?.second_reviewer ?? "").trim().toLowerCase();
  if (!a) missing.push("reviewer");
  if (!b) missing.push("second_reviewer");
  if (a && b && a === b) missing.push("reviewers_must_differ");
  return { ok: missing.length === 0, missing };
}

export interface CostIndexDocument {
  schema: "vireek.cost-index/1";
  slug: string;
  title: string;
  release_seq: number;
  period_key: string;
  period_start: string;
  period_end: string;
  as_of: string;
  method_version: string;
  thresholds: { k_min: number; dominance_max: number; min_jobs_per_cell: number; min_jobs_per_org: number };
  rounding: string;
  currency: "USD";
  statistic: string;
  changelog: string;
  disclosure_report: DisclosureReport;
  cells: PublishedCell[];
}

export function buildCostIndexDocument(i: {
  slug: string; title: string; releaseSeq: number; periodKey: string; periodStart: string; periodEnd: string; asOf: string;
  changelog: string; cells: PublishedCell[]; report: DisclosureReport;
}): CostIndexDocument {
  assertCostIndexPublishable(i.cells); // never freeze a document the gate would refuse
  return {
    schema: "vireek.cost-index/1", slug: i.slug, title: i.title, release_seq: i.releaseSeq,
    period_key: i.periodKey, period_start: i.periodStart, period_end: i.periodEnd, as_of: i.asOf, method_version: METHOD_VERSION,
    thresholds: { k_min: K_MIN_PUBLIC, dominance_max: DOMINANCE_MAX_SHARE, min_jobs_per_cell: MIN_EVENTS_PER_CELL, min_jobs_per_org: PARAMS.minJobsPerOrg },
    rounding: "Prices to the nearest $10 below $1,000, $50 below $10,000, otherwise $100. Counts are rounded (organisations to 5; jobs to 10, or 100 from 1,000).",
    currency: "USD",
    statistic: "25th, 50th and 75th percentile across participating organisations of each organisation's own median invoiced amount",
    changelog: i.changelog.slice(0, 1000),
    disclosure_report: i.report, cells: i.cells,
  };
}

const usd = (cents: number | null) => (cents === null ? "" : String(cents / 100));

export function costIndexToCsv(doc: Pick<CostIndexDocument, "slug" | "cells" | "method_version">): string {
  const head = "release,method_version,job_kind,trade,region,period,suppressed,suppression_reason,organisations,jobs,p25_usd,p50_usd,p75_usd";
  const lines = doc.cells.map((c) => [
    doc.slug, doc.method_version, c.job_kind, c.trade, c.region, c.period_key, c.suppressed ? "true" : "false", c.suppression_reason ?? "",
    c.n_orgs ?? "", c.n_jobs ?? "", usd(c.p25_cents), usd(c.p50_cents), usd(c.p75_cents),
  ].join(","));
  return [head, ...lines].join("\n") + "\n";
}
