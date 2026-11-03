// supabase/functions/_shared/state-of-calls/schema.ts
//
// Single source of truth for the "State of Home Service Calls" report:
// metric definitions, allowed dimensions, privacy thresholds and the cell shapes.
// Pure TypeScript (no Deno / DOM APIs) so the edge functions, the React page and the
// tests can all import it.
//
// ANYTHING that can leave the building must be expressible as a PublishedCell below.
// A field that is not in PUBLISHED_CELL_FIELDS cannot be exported (see disclosure.ts).

export const METHOD_VERSION = "soc-1.0.0";

/** Privacy thresholds. They can be raised per edition, never lowered below these floors. */
export const K_MIN_PUBLIC = 10;            // minimum distinct contributing organisations per published cell
export const DOMINANCE_MAX_SHARE = 0.35;   // no single org may account for more than 35% of a cell's events
export const MIN_EVENTS_PER_CELL = 100;    // minimum pooled events (calls, jobs, leads) behind a cell
/** Minimum non-suppressed national metrics before we publish a narrative report instead of a methodology preview. */
export const MIN_NATIONAL_METRICS_FOR_REPORT = 4;

export type Unit = "percent" | "minutes" | "usd";
export type Dimension = "national" | "trade" | "region" | "season" | "language";
export type ValueKind = "pooled" | "org_median";

export interface MetricDef {
  key: string;
  label: string;
  unit: Unit;
  /** Rounding step applied before publication (percent: 1 = whole percentage points). */
  step: number;
  valueKind: ValueKind;
  /** Which dimensions this metric is published for. Never a cross of two dimensions. */
  dimensions: readonly Dimension[];
  eventLabel: string;
  definition: string;
}

export const METRICS: readonly MetricDef[] = [
  {
    key: "answer_rate", label: "Answer rate", unit: "percent", step: 1, valueKind: "pooled",
    dimensions: ["national", "trade", "region", "season"], eventLabel: "calls",
    definition: "Share of inbound, non-spam calls that were answered (not missed and not sent to voicemail).",
  },
  {
    key: "missed_call_rate", label: "Missed-call rate", unit: "percent", step: 1, valueKind: "pooled",
    dimensions: ["national", "trade", "region", "season"], eventLabel: "calls",
    definition: "Share of inbound, non-spam calls recorded as missed or sent to voicemail. Equals 100% minus the answer rate.",
  },
  {
    key: "after_hours_share", label: "After-hours share", unit: "percent", step: 1, valueKind: "pooled",
    dimensions: ["national", "trade", "region", "season"], eventLabel: "calls",
    definition: "Share of inbound, non-spam calls that arrived outside the business's own configured opening hours, in the business's own time zone. Holidays are not modelled.",
  },
  {
    key: "emergency_share", label: "Emergency share", unit: "percent", step: 1, valueKind: "pooled",
    dimensions: ["national", "trade", "region", "season"], eventLabel: "calls",
    definition: "Share of inbound, non-spam calls flagged as an emergency by the business's call handling rules.",
  },
  {
    key: "booking_conversion", label: "Booking conversion", unit: "percent", step: 1, valueKind: "pooled",
    dimensions: ["national", "trade", "region", "season"], eventLabel: "answered calls",
    definition: "Share of answered, non-spam calls whose status is 'booked'.",
  },
  {
    key: "lead_first_response_minutes", label: "Speed to first response (leads)", unit: "minutes", step: 1, valueKind: "org_median",
    dimensions: ["national", "trade", "region"], eventLabel: "leads",
    definition: "Median across businesses of each business's median minutes from lead creation to first response. Call answer latency is not recorded per call, so this is NOT speed-to-answer.",
  },
  {
    key: "avg_ticket_usd", label: "Average ticket", unit: "usd", step: 25, valueKind: "pooled",
    dimensions: ["national", "trade", "region"], eventLabel: "completed jobs",
    definition: "Average invoice amount of completed jobs with an invoice, rounded to the nearest $25.",
  },
  {
    key: "seasonality_index", label: "Seasonality index", unit: "percent", step: 1, valueKind: "org_median",
    dimensions: ["season"], eventLabel: "calls",
    definition: "Median across businesses of (that business's calls in the month ÷ its monthly average), ×100. 100 = an average month. Only businesses with a full 12-month history are included.",
  },
  {
    key: "language_share", label: "Language mix", unit: "percent", step: 1, valueKind: "pooled",
    dimensions: ["language"], eventLabel: "calls with a detected language",
    definition: "Share of calls with a detected language that were in the given language. Languages used by too few businesses are grouped into 'other'.",
  },
] as const;

export const METRIC_KEYS: readonly string[] = METRICS.map((m) => m.key);
export const metricByKey = (key: string): MetricDef | undefined => METRICS.find((m) => m.key === key);

/** US Census regions. Coarse by design: finer geography is never published. */
export const REGIONS = ["northeast", "midwest", "south", "west"] as const;
/** Calendar months (seasonality index) and meteorological seasons (rate metrics: winter = Dec-Feb ...). */
export const MONTHS_KEYS = Array.from({ length: 12 }, (_, i) => `m${String(i + 1).padStart(2, "0")}`);
export const SEASON_NAMES = ["winter", "spring", "summer", "fall"] as const;
export const SEASONS: string[] = [...MONTHS_KEYS, ...SEASON_NAMES];
/** 0-based month index -> season name. */
export const SEASON_OF_MONTH: readonly (typeof SEASON_NAMES)[number][] = ["winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "fall", "fall", "fall", "winter"];
export const DIM_VALUE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const PERIOD_KEY_RE = /^\d{4}(?:-Q[1-4])?$/;
export const NATIONAL_VALUE = "all";

/** What the SQL aggregator hands to the TypeScript disclosure-control layer. */
export interface RawCell {
  metric_key: string;
  dim: Dimension;
  dim_value: string;
  period_key: string;
  n_orgs: number;
  n_events: number;
  pooled_value: number | null;
  org_p25: number | null;
  org_p50: number | null;
  org_p75: number | null;
  /** Largest single-organisation share of n_events in this cell (0..1). */
  max_org_share: number;
}
export const RAW_CELL_FIELDS = [
  "metric_key", "dim", "dim_value", "period_key", "n_orgs", "n_events",
  "pooled_value", "org_p25", "org_p50", "org_p75", "max_org_share",
] as const;

export type SuppressionReason = "k_anonymity" | "dominance" | "low_volume" | "complementary" | "no_data";

/** The ONLY shape that is stored in report_cells and exported (JSON, CSV, charts, PDF). */
export interface PublishedCell {
  metric_key: string;
  dim: Dimension;
  dim_value: string;
  period_key: string;
  unit: Unit;
  suppressed: boolean;
  suppression_reason: SuppressionReason | null;
  /** Rounded; null when suppressed. */
  n_orgs: number | null;
  n_events: number | null;
  value: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
}
export const PUBLISHED_CELL_FIELDS = [
  "metric_key", "dim", "dim_value", "period_key", "unit", "suppressed", "suppression_reason",
  "n_orgs", "n_events", "value", "p25", "p50", "p75",
] as const;

export interface DisclosureOptions {
  kMin?: number;
  dominanceMax?: number;
  minEvents?: number;
}

export const cellKey = (c: { metric_key: string; dim: string; dim_value: string; period_key: string }) =>
  `${c.metric_key}|${c.dim}|${c.dim_value}|${c.period_key}`;
