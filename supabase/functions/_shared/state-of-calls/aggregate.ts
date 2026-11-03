// supabase/functions/_shared/state-of-calls/aggregate.ts
//
// Reference ("oracle") implementation of the aggregation semantics that the SQL function
// public.report_build_raw_cells() implements in Postgres. Production numbers come from SQL; this module:
//   * defines the per-organisation fact shape (OrgFacts) and the exact aggregation rules in readable code,
//   * generates the labelled SYNTHETIC sample edition (synthetic.ts),
//   * is the oracle the pgTAP fixture test compares the SQL output against.
// It handles one organisation row at a time and never needs identifiers: OrgFacts has no id field by design.

import { MONTHS_KEYS, NATIONAL_VALUE, SEASON_NAMES, SEASON_OF_MONTH, type RawCell } from "./schema.ts";

export interface OrgFacts {
  trade: string;                 // normalised slug, 'other' when unmapped
  region: string | null;         // census region, null when the state is unknown
  // additive, 12 entries each, index 0 = January (zeros outside the edition period)
  calls: number[];               // inbound, non-spam
  missed: number[];              // missed or voicemail (subset of calls)
  hours_eligible: number[];      // calls from orgs with hours + time zone configured
  after_hours: number[];         // subset of hours_eligible
  emergency: number[];
  booked: number[];              // subset of answered
  lang_known: number[];          // calls with a detected language
  lang_counts: Record<string, number>; // whole-period counts per normalised language
  lead_resp_n: number;
  lead_resp_median_min: number | null;
  ticket_jobs: number;
  ticket_sum: number;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const sumMonths = (a: number[], months: number[]) => months.reduce((x, m) => x + a[m], 0);

/** Same as Postgres percentile_cont (linear interpolation on the sorted values). */
export function percentileCont(values: number[], p: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

interface Contribution { num: number; den: number }

function buildRateCell(
  metric: string, dim: RawCell["dim"], dimValue: string, period: string, contributions: Contribution[],
  countOrgsBy: "den" | "num" = "den",
): RawCell | null {
  // All organisations with a denominator define the rate distribution. For language cells the k-test and the
  // dominance test use only the organisations that actually contributed to the NUMERATOR, because those are
  // the businesses whose calls the figure reveals something about.
  const all = contributions.filter((c) => c.den > 0);
  if (!all.length) return null;
  const contributing = countOrgsBy === "num" ? all.filter((c) => c.num > 0) : all;
  if (!contributing.length) return null;
  const events = all.reduce((s, c) => s + c.den, 0);
  const rates = all.map((c) => (c.num / c.den) * 100);
  const numTotal = all.reduce((s, c) => s + c.num, 0);
  const share = countOrgsBy === "num"
    ? Math.max(...contributing.map((c) => c.num)) / numTotal
    : Math.max(...all.map((c) => c.den)) / events;
  return {
    metric_key: metric, dim, dim_value: dimValue, period_key: period,
    n_orgs: contributing.length, n_events: events,
    pooled_value: (numTotal / events) * 100,
    org_p25: percentileCont(rates, 0.25), org_p50: percentileCont(rates, 0.5), org_p75: percentileCont(rates, 0.75),
    max_org_share: share,
  };
}

/** Raw (pre-disclosure-control) cells for one period. kMin only controls language grouping, not publication. */
export function aggregateOrgFacts(orgs: readonly OrgFacts[], period: string, kMin: number): RawCell[] {
  const out: RawCell[] = [];
  const push = (c: RawCell | null) => { if (c) out.push(c); };

  const groups: { dim: RawCell["dim"]; value: string; members: OrgFacts[]; months: number[] }[] = [];
  const all = [...Array(12).keys()];
  groups.push({ dim: "national", value: NATIONAL_VALUE, members: [...orgs], months: all });
  for (const t of [...new Set(orgs.map((o) => o.trade))]) groups.push({ dim: "trade", value: t, members: orgs.filter((o) => o.trade === t), months: all });
  for (const r of [...new Set(orgs.map((o) => o.region).filter((x): x is string => !!x))]) groups.push({ dim: "region", value: r, members: orgs.filter((o) => o.region === r), months: all });
  SEASON_NAMES.forEach((s) => groups.push({ dim: "season", value: s, members: [...orgs], months: SEASON_OF_MONTH.map((n, i) => (n === s ? i : -1)).filter((i) => i >= 0) }));

  const CALL_METRICS: { key: string; num: (o: OrgFacts, m: number[]) => number; den: (o: OrgFacts, m: number[]) => number }[] = [
    { key: "answer_rate", num: (o, m) => sumMonths(o.calls, m) - sumMonths(o.missed, m), den: (o, m) => sumMonths(o.calls, m) },
    { key: "missed_call_rate", num: (o, m) => sumMonths(o.missed, m), den: (o, m) => sumMonths(o.calls, m) },
    { key: "after_hours_share", num: (o, m) => sumMonths(o.after_hours, m), den: (o, m) => sumMonths(o.hours_eligible, m) },
    { key: "emergency_share", num: (o, m) => sumMonths(o.emergency, m), den: (o, m) => sumMonths(o.calls, m) },
    { key: "booking_conversion", num: (o, m) => sumMonths(o.booked, m), den: (o, m) => sumMonths(o.calls, m) - sumMonths(o.missed, m) },
  ];
  for (const g of groups) for (const cm of CALL_METRICS) {
    push(buildRateCell(cm.key, g.dim, g.value, period, g.members.map((o) => ({ num: cm.num(o, g.months), den: cm.den(o, g.months) }))));
  }

  // leads speed + ticket: national / trade / region only (period-level, non-additive over months)
  for (const g of groups.filter((x) => x.dim === "national" || x.dim === "trade" || x.dim === "region")) {
    const withLeads = g.members.filter((o) => o.lead_resp_n > 0 && o.lead_resp_median_min !== null);
    if (withLeads.length) {
      const med = withLeads.map((o) => o.lead_resp_median_min as number);
      const events = withLeads.reduce((s, o) => s + o.lead_resp_n, 0);
      push({ metric_key: "lead_first_response_minutes", dim: g.dim, dim_value: g.value, period_key: period, n_orgs: withLeads.length, n_events: events,
        pooled_value: null, org_p25: percentileCont(med, 0.25), org_p50: percentileCont(med, 0.5), org_p75: percentileCont(med, 0.75),
        max_org_share: Math.max(...withLeads.map((o) => o.lead_resp_n)) / events });
    }
    const withJobs = g.members.filter((o) => o.ticket_jobs > 0);
    if (withJobs.length) {
      const means = withJobs.map((o) => o.ticket_sum / o.ticket_jobs);
      const jobs = withJobs.reduce((s, o) => s + o.ticket_jobs, 0);
      push({ metric_key: "avg_ticket_usd", dim: g.dim, dim_value: g.value, period_key: period, n_orgs: withJobs.length, n_events: jobs,
        pooled_value: withJobs.reduce((s, o) => s + o.ticket_sum, 0) / jobs, org_p25: percentileCont(means, 0.25), org_p50: percentileCont(means, 0.5), org_p75: percentileCont(means, 0.75),
        max_org_share: Math.max(...withJobs.map((o) => o.ticket_jobs)) / jobs });
    }
  }

  // seasonality index: annual editions only, orgs with calls in all 12 months
  if (/^\d{4}$/.test(period)) {
    const full = orgs.filter((o) => o.calls.every((c) => c > 0));
    MONTHS_KEYS.forEach((mk, i) => {
      const idx = full.map((o) => (o.calls[i] / (sum(o.calls) / 12)) * 100);
      if (!idx.length) return;
      const events = full.reduce((s, o) => s + o.calls[i], 0);
      push({ metric_key: "seasonality_index", dim: "season", dim_value: mk, period_key: period, n_orgs: full.length, n_events: events,
        pooled_value: null, org_p25: percentileCont(idx, 0.25), org_p50: percentileCont(idx, 0.5), org_p75: percentileCont(idx, 0.75),
        max_org_share: Math.max(...full.map((o) => o.calls[i])) / events });
    });
  }

  // language mix: languages used by fewer than kMin orgs are grouped into 'other'
  const langOrgCount = new Map<string, number>();
  for (const o of orgs) for (const [l, n] of Object.entries(o.lang_counts)) if (n > 0) langOrgCount.set(l, (langOrgCount.get(l) ?? 0) + 1);
  const bucket = (l: string) => ((langOrgCount.get(l) ?? 0) >= kMin ? l : "other");
  const langs = [...new Set([...langOrgCount.keys()].map(bucket))];
  for (const l of langs) {
    const contribs = orgs.map((o) => {
      let num = 0;
      for (const [k, n] of Object.entries(o.lang_counts)) if (bucket(k) === l) num += n;
      return { num, den: sum(o.lang_known) };
    });
    push(buildRateCell("language_share", "language", l, period, contribs, "num"));
  }
  return out;
}
