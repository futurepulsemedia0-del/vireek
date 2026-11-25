// supabase/functions/_shared/cost-index/disclosure.ts
//
// Statistical disclosure control for the Vireek Cost Index. Pure + deterministic (no clock, no randomness):
// the same RawCell[] and options always yield the same PublishedCell[] and therefore the same hash.
// Reuses the State of Calls primitives (DisclosureError, resolveOptions, roundCount, roundOrgs, canonicalJson, sha256Hex)
// so thresholds and rounding rules cannot drift between the two publications.
//
// Layers:  1 allowlist -> 2 suppression (k, dominance, volume) -> 3 complementary suppression -> 4 rounding -> 5 release gate.
// This is practical disclosure control, NOT a differential-privacy guarantee.

import { DisclosureError, canonicalJson, resolveOptions, roundCount, roundOrgs, sha256Hex } from "../state-of-calls/disclosure.ts";
import {
  ALL_REGIONS, JOB_KINDS, PERIOD_KEY_RE, PUBLISHED_CELL_FIELDS, RAW_CELL_FIELDS, REGIONS, TRADE_RE, cellKey, isRoundedPrice, roundPriceCents,
  type DisclosureOptions, type JobKind, type PublishedCell, type RawCell, type SuppressionReason,
} from "./schema.ts";

export { DisclosureError };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNumOrNull = (v: unknown) => v === null || isNum(v);

/** Layer 1. Throws on anything that is not exactly the reviewed shape (unknown field, ZIP-level geography, bad trade...). */
export function validateRawCell(c: unknown, index = 0): RawCell {
  if (typeof c !== "object" || c === null || Array.isArray(c)) throw new DisclosureError(`row ${index}: not an object`);
  const o = c as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !(RAW_CELL_FIELDS as readonly string[]).includes(k));
  if (extra.length) throw new DisclosureError(`row ${index}: field(s) not in the reviewed allowlist: ${extra.join(", ")}`);
  const missing = RAW_CELL_FIELDS.filter((k) => !(k in o));
  if (missing.length) throw new DisclosureError(`row ${index}: missing field(s): ${missing.join(", ")}`);
  if (typeof o.trade !== "string" || !TRADE_RE.test(o.trade)) throw new DisclosureError(`row ${index}: malformed trade`);
  if (o.region !== ALL_REGIONS && !(REGIONS as readonly string[]).includes(o.region as string)) {
    throw new DisclosureError(`row ${index}: region "${String(o.region)}" is not an allowed coarse region`);
  }
  if (!(JOB_KINDS as readonly string[]).includes(o.job_kind as string)) throw new DisclosureError(`row ${index}: unknown job kind`);
  if (typeof o.period_key !== "string" || !PERIOD_KEY_RE.test(o.period_key)) throw new DisclosureError(`row ${index}: malformed period_key`);
  if (!Number.isInteger(o.n_orgs) || (o.n_orgs as number) < 0) throw new DisclosureError(`row ${index}: n_orgs`);
  if (!Number.isInteger(o.n_jobs) || (o.n_jobs as number) < 0) throw new DisclosureError(`row ${index}: n_jobs`);
  for (const k of ["org_p25_cents", "org_p50_cents", "org_p75_cents"] as const) {
    if (!isNumOrNull(o[k]) || (isNum(o[k]) && (o[k] as number) < 0)) throw new DisclosureError(`row ${index}: ${k} must be a non-negative number or null`);
  }
  if (!isNum(o.max_org_share) || o.max_org_share < 0 || o.max_org_share > 1) throw new DisclosureError(`row ${index}: max_org_share must be within 0..1`);
  return o as unknown as RawCell;
}

function suppressed(c: RawCell, reason: SuppressionReason): PublishedCell {
  return {
    trade: c.trade, region: c.region, job_kind: c.job_kind, period_key: c.period_key,
    suppressed: true, suppression_reason: reason, n_orgs: null, n_jobs: null, p25_cents: null, p50_cents: null, p75_cents: null,
  };
}

function publish(c: RawCell, kMin: number): PublishedCell {
  if (c.org_p25_cents === null || c.org_p50_cents === null || c.org_p75_cents === null) return suppressed(c, "no_data");
  return {
    trade: c.trade, region: c.region, job_kind: c.job_kind, period_key: c.period_key, suppressed: false, suppression_reason: null,
    n_orgs: roundOrgs(c.n_orgs, kMin), n_jobs: roundCount(c.n_jobs),
    p25_cents: roundPriceCents(c.org_p25_cents), p50_cents: roundPriceCents(c.org_p50_cents), p75_cents: roundPriceCents(c.org_p75_cents),
  };
}

export interface DisclosureReport {
  input_cells: number;
  published: number;
  suppressed: Record<SuppressionReason, number>;
}

export function applyCostIndexDisclosure(
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

  // Layer 2 — suppression, in a fixed precedence so the reason is deterministic.
  const out = new Map<string, PublishedCell>();
  const rawByKey = new Map<string, RawCell>();
  for (const r of raws) {
    rawByKey.set(cellKey(r), r);
    let reason: SuppressionReason | null = null;
    if (r.n_orgs < opt.kMin) reason = "k_anonymity";
    else if (r.max_org_share > opt.dominanceMax) reason = "dominance";
    else if (r.n_jobs < opt.minEvents) reason = "low_volume";
    out.set(cellKey(r), reason ? suppressed(r, reason) : publish(r, opt.kMin));
  }

  // Layer 3 — complementary suppression. For one (job kind, trade, period) the regional cells partition the 'all' rollup.
  // If the rollup is published and exactly ONE regional cell is hidden, its n_orgs / n_jobs could be backed out from
  // (rollup - others); also hide the smallest published regional cell.
  const groups = new Map<string, PublishedCell[]>();
  for (const c of out.values()) {
    if (c.region === ALL_REGIONS) continue;
    const g = `${c.job_kind}|${c.trade}|${c.period_key}`;
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  for (const [g, cells] of groups) {
    const [kind, trade, period] = g.split("|");
    const rollup = out.get(cellKey({ job_kind: kind, trade, region: ALL_REGIONS, period_key: period }));
    if (!rollup || rollup.suppressed) continue;
    const hidden = cells.filter((c) => c.suppressed && c.suppression_reason !== "no_data");
    const shown = cells.filter((c) => !c.suppressed);
    if (hidden.length === 1 && shown.length > 0) {
      const victim = [...shown].sort((a, b) =>
        (rawByKey.get(cellKey(a))!.n_orgs - rawByKey.get(cellKey(b))!.n_orgs) ||
        (rawByKey.get(cellKey(a))!.n_jobs - rawByKey.get(cellKey(b))!.n_jobs) ||
        cellKey(a).localeCompare(cellKey(b)))[0];
      out.set(cellKey(victim), suppressed(rawByKey.get(cellKey(victim))!, "complementary"));
    }
  }

  const cells = [...out.values()].sort((a, b) => cellKey(a).localeCompare(cellKey(b)));
  const reasons: Record<SuppressionReason, number> = { k_anonymity: 0, dominance: 0, low_volume: 0, complementary: 0, no_data: 0 };
  for (const c of cells) if (c.suppression_reason) reasons[c.suppression_reason]++;
  assertCostIndexPublishable(cells, opt);
  return { cells, report: { input_cells: raws.length, published: cells.filter((c) => !c.suppressed).length, suppressed: reasons } };
}

/**
 * Layer 5 — release gate on FINISHED cells. Used by applyCostIndexDisclosure AND independently by the publish action
 * (cells read back from the database), so a bug or manual edit in either place cannot leak a small or exact cell.
 */
export function assertCostIndexPublishable(cells: readonly PublishedCell[], options: DisclosureOptions = {}): void {
  const opt = resolveOptions(options);
  const seen = new Set<string>();
  for (const [i, c] of cells.entries()) {
    const extra = Object.keys(c).filter((k) => !(PUBLISHED_CELL_FIELDS as readonly string[]).includes(k));
    if (extra.length) throw new DisclosureError(`cell ${i}: non-allowlisted field(s): ${extra.join(", ")}`);
    const missing = PUBLISHED_CELL_FIELDS.filter((k) => !(k in c));
    if (missing.length) throw new DisclosureError(`cell ${i}: missing field(s): ${missing.join(", ")}`);
    if (!TRADE_RE.test(c.trade) || !PERIOD_KEY_RE.test(c.period_key)) throw new DisclosureError(`cell ${i}: malformed key`);
    if (c.region !== ALL_REGIONS && !(REGIONS as readonly string[]).includes(c.region)) throw new DisclosureError(`cell ${i}: region is not a coarse region`);
    if (!(JOB_KINDS as readonly string[]).includes(c.job_kind as JobKind)) throw new DisclosureError(`cell ${i}: unknown job kind`);
    const k = cellKey(c);
    if (seen.has(k)) throw new DisclosureError(`cell ${i}: duplicate ${k}`);
    seen.add(k);
    if (c.suppressed) {
      if ([c.n_orgs, c.n_jobs, c.p25_cents, c.p50_cents, c.p75_cents].some((v) => v !== null)) throw new DisclosureError(`cell ${i}: suppressed cell carries numbers`);
      if (!c.suppression_reason) throw new DisclosureError(`cell ${i}: suppressed cell has no reason`);
      continue;
    }
    if (c.suppression_reason !== null) throw new DisclosureError(`cell ${i} (${k}): published cell carries a suppression reason`);
    if (!isNum(c.n_orgs) || c.n_orgs < opt.kMin) throw new DisclosureError(`cell ${i} (${k}): n_orgs below k=${opt.kMin}`);
    if (!isNum(c.n_jobs) || c.n_jobs < opt.minEvents) throw new DisclosureError(`cell ${i} (${k}): n_jobs below minimum volume`);
    const p = [c.p25_cents, c.p50_cents, c.p75_cents];
    if (p.some((v) => v === null || !isNum(v))) throw new DisclosureError(`cell ${i} (${k}): published cell has no price`);
    if (p.some((v) => !isRoundedPrice(v as number))) throw new DisclosureError(`cell ${i} (${k}): price is not rounded to its step`);
    if (!(c.p25_cents! <= c.p50_cents! && c.p50_cents! <= c.p75_cents!)) throw new DisclosureError(`cell ${i} (${k}): percentiles out of order`);
  }
}

/** Canonical hash of the finished cells: the value reviewers sign off on and publish re-verifies. */
export const costCellsHash = (cells: readonly PublishedCell[]) => sha256Hex(canonicalJson(cells));
