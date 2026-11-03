// supabase/functions/_shared/state-of-calls/narrative.ts
//
// Narrative sections written ONLY from published cells. Every statement lists the cells it cites and every
// number in its text must be traceable to those cells (verifyNarrative). If the data does not support a
// statement, the statement is not written. If there is too little data for a report at all, the output is a
// "methodology preview" with no findings. No extrapolation, no invented comparisons, no causal claims.

import {
  METRICS, MIN_NATIONAL_METRICS_FOR_REPORT, MONTHS_KEYS, NATIONAL_VALUE, cellKey,
  type PublishedCell,
} from "./schema.ts";

export interface Statement { id: string; text: string; cites: string[]; derived: number[] }
export interface Section { id: string; title: string; statements: Statement[] }
export interface Narrative {
  mode: "report" | "methodology_preview";
  sections: Section[];
  /** Why the report is a preview (empty when mode = report). */
  reasons: string[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const TRADE_LABEL = (slug: string) => slug.replace(/-/g, " ");

function index(cells: readonly PublishedCell[]) {
  const m = new Map<string, PublishedCell>();
  for (const c of cells) if (!c.suppressed) m.set(cellKey(c), c);
  return m;
}
const fmt = (c: PublishedCell, v: number | null) => {
  if (v === null) return "";
  if (c.unit === "percent") return `${v}%`;
  if (c.unit === "usd") return `$${v}`;
  return `${v} minutes`;
};

export function assessSufficiency(cells: readonly PublishedCell[], periodKey: string): { ok: boolean; reasons: string[] } {
  const core = METRICS.filter((m) => m.dimensions.includes("national") && m.key !== "seasonality_index" && m.key !== "language_share");
  const idx = index(cells);
  const published = core.filter((m) => idx.has(cellKey({ metric_key: m.key, dim: "national", dim_value: NATIONAL_VALUE, period_key: periodKey })));
  const reasons: string[] = [];
  if (published.length < MIN_NATIONAL_METRICS_FOR_REPORT) {
    reasons.push(`Only ${published.length} of ${core.length} headline metrics met the publication thresholds; at least ${MIN_NATIONAL_METRICS_FOR_REPORT} are required for a findings report.`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function buildNarrative(cells: readonly PublishedCell[], periodKey: string): Narrative {
  const suff = assessSufficiency(cells, periodKey);
  if (!suff.ok) {
    return {
      mode: "methodology_preview", reasons: suff.reasons,
      sections: [{
        id: "preview", title: "Methodology preview",
        statements: [{ id: "preview-1", cites: [], derived: [], text: "There is not yet enough contributed data to publish findings without risking the privacy of contributing businesses. This edition therefore publishes the methodology only: what will be measured, how, and the thresholds every figure must meet." }],
      }],
    };
  }
  const idx = index(cells);
  const get = (metric: string, dim: PublishedCell["dim"], value: string) => idx.get(cellKey({ metric_key: metric, dim, dim_value: value, period_key: periodKey }));
  const nat = (metric: string) => get(metric, "national", NATIONAL_VALUE);
  const sections: Section[] = [];

  // ---- Headline
  const head: Statement[] = [];
  const ans = nat("answer_rate");
  if (ans) {
    const range = ans.p25 !== null && ans.p75 !== null ? ` The middle half of businesses answered between ${ans.p25}% and ${ans.p75}% of their calls.` : "";
    head.push({ id: "answer-rate", cites: [cellKey(ans)], derived: [],
      text: `Across roughly ${ans.n_orgs} contributing businesses, ${fmt(ans, ans.value)} of inbound non-spam calls were answered.${range}` });
  }
  const miss = nat("missed_call_rate");
  if (miss) head.push({ id: "missed-rate", cites: [cellKey(miss)], derived: [], text: `${fmt(miss, miss.value)} of those calls were missed or went to voicemail.` });
  const ah = nat("after_hours_share");
  if (ah) head.push({ id: "after-hours", cites: [cellKey(ah)], derived: [], text: `${fmt(ah, ah.value)} of calls arrived outside the business's own opening hours.` });
  const em = nat("emergency_share");
  if (em) head.push({ id: "emergency", cites: [cellKey(em)], derived: [], text: `${fmt(em, em.value)} of calls were flagged as emergencies.` });
  const bk = nat("booking_conversion");
  if (bk) head.push({ id: "booking", cites: [cellKey(bk)], derived: [], text: `${fmt(bk, bk.value)} of answered calls ended in a booking.` });
  const tk = nat("avg_ticket_usd");
  if (tk) head.push({ id: "ticket", cites: [cellKey(tk)], derived: [], text: `The average invoice on completed jobs was ${fmt(tk, tk.value)}.` });
  const fr = nat("lead_first_response_minutes");
  if (fr) head.push({ id: "first-response", cites: [cellKey(fr)], derived: [], text: `The typical business took ${fmt(fr, fr.value)} to first respond to a new lead.` });
  if (head.length) sections.push({ id: "headline", title: "Headline findings", statements: head });

  // ---- By trade (only when >= 2 published trades; ranges are differences of the PUBLISHED rounded values)
  const tradeCells = cells.filter((c) => !c.suppressed && c.metric_key === "missed_call_rate" && c.dim === "trade" && c.dim_value !== "other" && c.period_key === periodKey && c.value !== null);
  if (tradeCells.length >= 2) {
    const sorted = [...tradeCells].sort((a, b) => (a.value! - b.value!) || a.dim_value.localeCompare(b.dim_value));
    const lo = sorted[0], hi = sorted[sorted.length - 1];
    const gap = Math.round((hi.value! - lo.value!) * 1e6) / 1e6;
    sections.push({ id: "trade", title: "By trade", statements: [{
      id: "trade-gap", cites: [cellKey(lo), cellKey(hi)], derived: [gap],
      text: `Among trades with enough data, missed-call rates ranged from ${lo.value}% (${TRADE_LABEL(lo.dim_value)}) to ${hi.value}% (${TRADE_LABEL(hi.dim_value)}), a gap of ${gap} percentage points. Differences may reflect the mix of businesses contributing, not the trade itself.`,
    }] });
  }

  // ---- By region
  const regionCells = cells.filter((c) => !c.suppressed && c.metric_key === "missed_call_rate" && c.dim === "region" && c.period_key === periodKey && c.value !== null);
  if (regionCells.length >= 2) {
    const sorted = [...regionCells].sort((a, b) => (a.value! - b.value!) || a.dim_value.localeCompare(b.dim_value));
    const lo = sorted[0], hi = sorted[sorted.length - 1];
    sections.push({ id: "region", title: "By region", statements: [{
      id: "region-gap", cites: [cellKey(lo), cellKey(hi)], derived: [],
      text: `By US Census region, missed-call rates ranged from ${lo.value}% (${lo.dim_value.replace(/_/g, " ")}) to ${hi.value}% (${hi.dim_value.replace(/_/g, " ")}).`,
    }] });
  }

  // ---- Seasonality (needs >= 6 published months)
  const season = MONTHS_KEYS.map((s) => get("seasonality_index", "season", s)).filter((c): c is PublishedCell => !!c && c.value !== null);
  if (season.length >= 6) {
    const sorted = [...season].sort((a, b) => (a.value! - b.value!) || a.dim_value.localeCompare(b.dim_value));
    const lo = sorted[0], hi = sorted[sorted.length - 1];
    const name = (c: PublishedCell) => MONTHS[Number(c.dim_value.slice(1)) - 1];
    sections.push({ id: "seasonality", title: "Seasonality", statements: [{
      id: "season-peak", cites: [cellKey(hi), cellKey(lo)], derived: [100], // 100 = the index baseline stated in the text
      text: `Among months with enough data, call volume peaked in ${name(hi)} at an index of ${hi.value} and was lowest in ${name(lo)} at ${lo.value} (100 = an average month).`,
    }] });
  }

  // ---- Language
  const langs = cells.filter((c) => !c.suppressed && c.metric_key === "language_share" && c.dim === "language" && c.period_key === periodKey && c.value !== null && c.dim_value !== "other");
  if (langs.length) {
    const top = [...langs].sort((a, b) => (b.value! - a.value!) || a.dim_value.localeCompare(b.dim_value))[0];
    sections.push({ id: "language", title: "Language mix", statements: [{
      id: "language-top", cites: [cellKey(top)], derived: [],
      text: `${top.value}% of calls with a detected language were in ${top.dim_value}.`,
    }] });
  }
  return { mode: "report", sections, reasons: [] };
}

/** Every numeric token in every statement must come from a cited cell or be a declared derived number. */
export function verifyNarrative(n: Narrative, cells: readonly PublishedCell[]): { ok: boolean; problems: string[] } {
  const byKey = new Map(cells.map((c) => [cellKey(c), c]));
  const problems: string[] = [];
  for (const s of n.sections) for (const st of s.statements) {
    const allowed = new Set<number>(st.derived);
    for (const k of st.cites) {
      const c = byKey.get(k);
      if (!c || c.suppressed) { problems.push(`${st.id}: cites missing or suppressed cell ${k}`); continue; }
      for (const v of [c.value, c.p25, c.p50, c.p75, c.n_orgs, c.n_events]) if (v !== null) allowed.add(v);
    }
    // metric-agnostic month names / category words carry no digits; only digits are checked
    const tokens = st.text.replace(/(\d),(\d{3})/g, "$1$2").match(/\d+(?:\.\d+)?/g) ?? [];
    for (const t of tokens) if (!allowed.has(Number(t))) problems.push(`${st.id}: number ${t} is not backed by a cited cell`);
  }
  return { ok: problems.length === 0, problems };
}

export const LIMITATIONS: readonly string[] = [
  "Contributors are Vireek customers who opted in. They are not a random sample of all home service businesses, so figures describe this group only and must not be generalised to an industry or region.",
  "Figures are descriptive. Differences between trades, regions or months are not evidence of cause.",
  "After-hours share uses each business's configured opening hours and time zone; holidays and temporary hours are not modelled, and businesses without both configured are excluded from that metric.",
  "Call answer latency is not recorded per call, so 'speed to answer' is not reported. Speed to first response is measured on leads and only where a first-response time was recorded.",
  "Booking conversion depends on businesses or the AI marking calls as booked and may under-count bookings made outside Vireek.",
  "Average ticket uses invoice amounts on completed jobs; jobs without an invoice are excluded, and amounts are not adjusted for inflation or currency (US businesses, USD only).",
  "Percentages are rounded to whole points, dollar amounts to $25, and counts are rounded. Cells with too few businesses, too few events, or one dominant business are withheld.",
  "Businesses can withdraw consent at any time. Withdrawal applies to future editions; figures already published are aggregates and are not recalculated.",
];

export const EXCLUSIONS: readonly string[] = [
  "Calls marked as spam.",
  "Businesses that have not opted in, or whose opt-in was withdrawn before the edition was built.",
  "Businesses without a mapped trade or US state are included only in national figures.",
];
