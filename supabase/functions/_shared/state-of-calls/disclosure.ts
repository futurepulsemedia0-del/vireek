// supabase/functions/_shared/state-of-calls/disclosure.ts
//
// Statistical disclosure control for the "State of Home Service Calls" report.
// Pure + deterministic: the same RawCell[] and options ALWAYS yield the same PublishedCell[]
// (no clock, no randomness), which is what makes editions reproducible and hash-verifiable.
//
// Layers (the SQL aggregator already applies k_min once; this layer is the independent second check
// and is the only code allowed to produce PublishedCell values):
//   1. Allowlist: unknown/missing fields or malformed keys -> hard error (the build fails, nothing is stored).
//   2. Suppression: k-anonymity, dominance (one org too large a share), low event volume.
//   3. Complementary suppression: stops "total minus the other cells" differencing on partitions.
//   4. Coarsening: rounding by metric step, event counts rounded, org counts rounded.
//   5. Final gate assertPublishable(): re-verifies every invariant on the finished cells.
//
// This is practical statistical disclosure control, NOT a formal differential-privacy guarantee.

import {
  DIM_VALUE_RE, DOMINANCE_MAX_SHARE, K_MIN_PUBLIC, METRICS, MIN_EVENTS_PER_CELL, NATIONAL_VALUE, PERIOD_KEY_RE,
  PUBLISHED_CELL_FIELDS, RAW_CELL_FIELDS, REGIONS, SEASONS, cellKey, metricByKey,
  type Dimension, type DisclosureOptions, type MetricDef, type PublishedCell, type RawCell, type SuppressionReason,
} from "./schema.ts";

const DIMENSIONS: readonly Dimension[] = ["national", "trade", "region", "season", "language"];

export class DisclosureError extends Error {
  constructor(message: string) { super(message); this.name = "DisclosureError"; }
}

export function resolveOptions(o: DisclosureOptions = {}): Required<DisclosureOptions> {
  // Thresholds may be raised per edition but never lowered below the public floors.
  return {
    kMin: Math.max(K_MIN_PUBLIC, o.kMin ?? K_MIN_PUBLIC),
    dominanceMax: Math.min(DOMINANCE_MAX_SHARE, o.dominanceMax ?? DOMINANCE_MAX_SHARE),
    minEvents: Math.max(MIN_EVENTS_PER_CELL, o.minEvents ?? MIN_EVENTS_PER_CELL),
  };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNumOrNull = (v: unknown) => v === null || isNum(v);

/** Step 1. Throws on anything that is not exactly the allowlisted shape. */
export function validateRawCell(c: unknown, index = 0): RawCell {
  if (typeof c !== "object" || c === null || Array.isArray(c)) throw new DisclosureError(`row ${index}: not an object`);
  const o = c as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !(RAW_CELL_FIELDS as readonly string[]).includes(k));
  if (extra.length) throw new DisclosureError(`row ${index}: field(s) not in the reviewed allowlist: ${extra.join(", ")}`);
  const missing = RAW_CELL_FIELDS.filter((k) => !(k in o));
  if (missing.length) throw new DisclosureError(`row ${index}: missing field(s): ${missing.join(", ")}`);

  const metric = metricByKey(String(o.metric_key));
  if (!metric) throw new DisclosureError(`row ${index}: unknown metric "${String(o.metric_key)}"`);
  if (!DIMENSIONS.includes(o.dim as Dimension)) throw new DisclosureError(`row ${index}: unknown dimension "${String(o.dim)}"`);
  const dim = o.dim as Dimension;
  if (!metric.dimensions.includes(dim)) throw new DisclosureError(`row ${index}: metric ${metric.key} is not published by ${dim}`);
  const dv = String(o.dim_value);
  if (!DIM_VALUE_RE.test(dv)) throw new DisclosureError(`row ${index}: malformed dim_value`);
  if (dim === "national" && dv !== NATIONAL_VALUE) throw new DisclosureError(`row ${index}: national cell must use "${NATIONAL_VALUE}"`);
  if (dim === "region" && !(REGIONS as readonly string[]).includes(dv)) throw new DisclosureError(`row ${index}: region "${dv}" is not an allowed coarse region`);
  if (dim === "season" && !SEASONS.includes(dv)) throw new DisclosureError(`row ${index}: malformed season`);
  if (!PERIOD_KEY_RE.test(String(o.period_key))) throw new DisclosureError(`row ${index}: malformed period_key`);
  if (!Number.isInteger(o.n_orgs) || (o.n_orgs as number) < 0) throw new DisclosureError(`row ${index}: n_orgs`);
  if (!Number.isInteger(o.n_events) || (o.n_events as number) < 0) throw new DisclosureError(`row ${index}: n_events`);
  if (!isNumOrNull(o.pooled_value) || !isNumOrNull(o.org_p25) || !isNumOrNull(o.org_p50) || !isNumOrNull(o.org_p75)) {
    throw new DisclosureError(`row ${index}: non-numeric statistic`);
  }
  if (!isNum(o.max_org_share) || o.max_org_share < 0 || o.max_org_share > 1) throw new DisclosureError(`row ${index}: max_org_share must be within 0..1`);
  return o as unknown as RawCell;
}

const roundTo = (v: number, step: number) => Math.round(v / step) * step;
const clamp = (v: number, m: MetricDef) => {
  if (m.unit === "percent" && m.key !== "seasonality_index") return Math.min(100, Math.max(0, v));
  return Math.max(0, v);
};
const fixed = (v: number) => Math.round(v * 1e6) / 1e6; // kill float dust so JSON/CSV/hash are stable

/** Counts are never published exactly: < 1,000 -> nearest 10, otherwise nearest 100. */
export function roundCount(n: number): number {
  return n < 1000 ? Math.round(n / 10) * 10 : Math.round(n / 100) * 100;
}
/** Org counts: nearest 5, but never rounded below the k threshold (we only round published cells, which already have n >= k). */
export function roundOrgs(n: number, kMin: number): number {
  return Math.max(kMin, Math.round(n / 5) * 5);
}

function suppressed(c: RawCell, m: MetricDef, reason: SuppressionReason): PublishedCell {
  return {
    metric_key: c.metric_key, dim: c.dim, dim_value: c.dim_value, period_key: c.period_key, unit: m.unit,
    suppressed: true, suppression_reason: reason, n_orgs: null, n_events: null, value: null, p25: null, p50: null, p75: null,
  };
}

function publish(c: RawCell, m: MetricDef, kMin: number): PublishedCell {
  const pick = (v: number | null) => (v === null ? null : fixed(clamp(roundTo(v, m.step), m)));
  const base = m.valueKind === "pooled" ? c.pooled_value : c.org_p50;
  const value = pick(base);
  const p25 = pick(c.org_p25), p50 = pick(c.org_p50), p75 = pick(c.org_p75);
  if (value === null) return suppressed(c, m, "no_data");
  return {
    metric_key: c.metric_key, dim: c.dim, dim_value: c.dim_value, period_key: c.period_key, unit: m.unit,
    suppressed: false, suppression_reason: null,
    n_orgs: roundOrgs(c.n_orgs, kMin), n_events: roundCount(c.n_events), value, p25, p50, p75,
  };
}

/** Dimensions whose cells partition the national total of the same metric+period (differencing risk). */
const PARTITION_DIMS: readonly Dimension[] = ["trade", "region", "language"];

export interface DisclosureReport {
  input_cells: number;
  published: number;
  suppressed: Record<SuppressionReason, number>;
}

export function applyDisclosureControl(
  rows: readonly unknown[],
  options: DisclosureOptions = {},
): { cells: PublishedCell[]; report: DisclosureReport } {
  const opt = resolveOptions(options);
  const raws = rows.map((r, i) => validateRawCell(r, i));

  const seen = new Set<string>();
  for (const r of raws) {
    const k = cellKey(r);
    if (seen.has(k)) throw new DisclosureError(`duplicate cell ${k}`);
    seen.add(k);
  }

  const out = new Map<string, PublishedCell>();
  const rawByKey = new Map<string, RawCell>();
  for (const r of raws) {
    const m = metricByKey(r.metric_key)!;
    rawByKey.set(cellKey(r), r);
    let reason: SuppressionReason | null = null;
    if (r.n_orgs < opt.kMin) reason = "k_anonymity";
    else if (r.max_org_share > opt.dominanceMax) reason = "dominance";
    else if (r.n_events < opt.minEvents) reason = "low_volume";
    out.set(cellKey(r), reason ? suppressed(r, m, reason) : publish(r, m, opt.kMin));
  }

  // Step 3: complementary suppression on partitions. If exactly one cell of a partition is suppressed while the
  // national cell is published, an observer could back it out from (national - sum(others)); also suppress the
  // published cell with the fewest organisations in that partition.
  const groups = new Map<string, PublishedCell[]>();
  for (const c of out.values()) {
    if (!PARTITION_DIMS.includes(c.dim)) continue;
    const g = `${c.metric_key}|${c.dim}|${c.period_key}`;
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  for (const [g, cells] of groups) {
    const [metric, , period] = g.split("|");
    const national = out.get(cellKey({ metric_key: metric, dim: "national", dim_value: NATIONAL_VALUE, period_key: period }));
    if (!national || national.suppressed) continue;
    const hidden = cells.filter((c) => c.suppressed && c.suppression_reason !== "no_data");
    const shown = cells.filter((c) => !c.suppressed);
    if (hidden.length === 1 && shown.length > 0) {
      // deterministic tie-break: fewest orgs, then fewest events, then key
      const victim = [...shown].sort((a, b) =>
        (rawByKey.get(cellKey(a))!.n_orgs - rawByKey.get(cellKey(b))!.n_orgs) ||
        (rawByKey.get(cellKey(a))!.n_events - rawByKey.get(cellKey(b))!.n_events) ||
        cellKey(a).localeCompare(cellKey(b)))[0];
      out.set(cellKey(victim), suppressed(rawByKey.get(cellKey(victim))!, metricByKey(victim.metric_key)!, "complementary"));
    }
  }

  const cells = [...out.values()].sort((a, b) => cellKey(a).localeCompare(cellKey(b)));
  const reasons: Record<SuppressionReason, number> = { k_anonymity: 0, dominance: 0, low_volume: 0, complementary: 0, no_data: 0 };
  for (const c of cells) if (c.suppression_reason) reasons[c.suppression_reason]++;
  const result = { cells, report: { input_cells: raws.length, published: cells.filter((c) => !c.suppressed).length, suppressed: reasons } };
  assertPublishable(result.cells, opt);
  return result;
}

/**
 * Step 5, the release gate on finished cells. Used by applyDisclosureControl AND independently by the publish action
 * (cells read back from the database) so a bug or a manual edit in either place cannot leak a small cell.
 */
export function assertPublishable(cells: readonly PublishedCell[], options: DisclosureOptions = {}): void {
  const opt = resolveOptions(options);
  const seen = new Set<string>();
  for (const [i, c] of cells.entries()) {
    const keys = Object.keys(c);
    const extra = keys.filter((k) => !(PUBLISHED_CELL_FIELDS as readonly string[]).includes(k));
    if (extra.length) throw new DisclosureError(`cell ${i}: non-allowlisted field(s): ${extra.join(", ")}`);
    const missing = PUBLISHED_CELL_FIELDS.filter((k) => !(k in c));
    if (missing.length) throw new DisclosureError(`cell ${i}: missing field(s): ${missing.join(", ")}`);
    const m = METRICS.find((x) => x.key === c.metric_key);
    if (!m) throw new DisclosureError(`cell ${i}: unknown metric`);
    if (!m.dimensions.includes(c.dim)) throw new DisclosureError(`cell ${i}: dimension not allowed for ${m.key}`);
    if (c.unit !== m.unit) throw new DisclosureError(`cell ${i}: unit mismatch`);
    if (!DIM_VALUE_RE.test(c.dim_value) || !PERIOD_KEY_RE.test(c.period_key)) throw new DisclosureError(`cell ${i}: malformed key`);
    const k = cellKey(c);
    if (seen.has(k)) throw new DisclosureError(`cell ${i}: duplicate ${k}`);
    seen.add(k);
    if (c.suppressed) {
      if ([c.n_orgs, c.n_events, c.value, c.p25, c.p50, c.p75].some((v) => v !== null)) throw new DisclosureError(`cell ${i}: suppressed cell carries numbers`);
      if (!c.suppression_reason) throw new DisclosureError(`cell ${i}: suppressed cell has no reason`);
      continue;
    }
    if (!isNum(c.n_orgs) || c.n_orgs < opt.kMin) throw new DisclosureError(`cell ${i} (${k}): n_orgs below k=${opt.kMin}`);
    if (!isNum(c.n_events) || c.n_events < opt.minEvents) throw new DisclosureError(`cell ${i} (${k}): n_events below minimum volume`);
    if (!isNum(c.value)) throw new DisclosureError(`cell ${i} (${k}): published cell has no value`);
    const steps = [c.value, c.p25, c.p50, c.p75].filter((v): v is number => v !== null);
    if (steps.some((v) => !isNum(v) || v < 0 || Math.abs(v / m.step - Math.round(v / m.step)) > 1e-9)) throw new DisclosureError(`cell ${i} (${k}): value is not rounded to its step`);
    if (m.unit === "percent" && m.key !== "seasonality_index" && steps.some((v) => v > 100)) throw new DisclosureError(`cell ${i} (${k}): percentage above 100`);
    if (c.p25 !== null && c.p50 !== null && c.p75 !== null && !(c.p25 <= c.p50 && c.p50 <= c.p75)) throw new DisclosureError(`cell ${i} (${k}): percentiles out of order`);
  }
}

/** Canonical JSON (sorted keys) so the same cells always hash identically. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const cellsHash = (cells: readonly PublishedCell[]) => sha256Hex(canonicalJson(cells));
