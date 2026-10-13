// supabase/functions/_shared/executive-report/format.ts
// Display formatters shared by the email, the PDF and the AI facts list.

import type { ExecutiveMetrics } from "./types.ts";

export const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`;
export const pct = (n: number | null | undefined): string =>
  n === null || n === undefined ? "n/a" : `${n}%`;
export const signedPct = (n: number | null): string =>
  n === null ? "n/a" : `${n > 0 ? "+" : ""}${n}%`;
export const signedPts = (n: number | null): string =>
  n === null ? "n/a" : `${n > 0 ? "+" : ""}${n} pts`;

/** Plain-text fact lines. The AI may only cite numbers that appear here. */
export function buildFacts(m: ExecutiveMetrics): string[] {
  const c = m.current;
  const f: string[] = [
    `Period: ${m.period.label}`,
    `Revenue: ${money(c.revenue)} (${signedPct(m.deltas.revenuePct)} vs prior month)`,
    `Jobs completed: ${c.jobsCompleted} (${signedPct(m.deltas.jobsCompletedPct)} vs prior month)`,
    `Average ticket: ${money(c.avgTicket)}`,
    `Close rate: ${pct(c.closeRatePct)} (${c.quotesAccepted} of ${c.quotesDecided} decided quotes; ${signedPts(m.deltas.closeRatePts)} vs prior month)`,
    `Missed calls: ${c.missedCalls}; recovered ${c.recoveredCount} of ${c.missedCallEvents} missed-call/voicemail events (${pct(c.recoveryRatePct)}), worth ${money(c.recoveredValue)}`,
    `Gross margin: ${pct(c.marginPct)} (${signedPts(m.deltas.marginPts)} vs prior month)`,
    `Rework rate: ${pct(c.reworkRatePct)}`,
  ];
  m.topTechnicians.slice(0, 3).forEach((t, i) =>
    f.push(`Top technician #${i + 1}: ${t.name} — ${money(t.revenue)} across ${t.jobs} jobs`));
  m.goals.forEach((g) => {
    const fmt = (v: number | null) => (g.unit === "currency" ? money(v) : g.unit === "percent" ? pct(v) : v === null ? "n/a" : String(v));
    f.push(`Goal ${g.label}: actual ${fmt(g.actual)} vs goal ${fmt(g.goal)} (${g.status})`);
  });
  return f;
}
