// supabase/functions/_shared/executive-report/commentaryCore.ts
// Pure commentary logic: deterministic fallback + grounding validation of
// AI output. Kept free of AI imports so it is unit-testable.

import type { Commentary, ExecutiveMetrics } from "./types.ts";
import { money, pct } from "./format.ts";

const NUM_RE = /\d[\d,]*(?:\.\d+)?/g;

function numbersIn(text: string): number[] {
  return (text.match(NUM_RE) ?? []).map((s) => Number(s.replace(/,/g, ""))).filter(Number.isFinite);
}

/** True if every number in `text` appears in `facts` (small ordinals 1–10 are allowed). */
export function isGrounded(text: string, facts: string[]): boolean {
  const allowed = new Set(numbersIn(facts.join(" ")));
  return numbersIn(text).every((n) => allowed.has(n) || (Number.isInteger(n) && n >= 1 && n <= 10));
}

const clean = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** Parse + validate the model's JSON. Returns null when too little survives. */
export function validateAiCommentary(raw: string, facts: string[]): Commentary | null {
  let parsed: Record<string, unknown>;
  try {
    const stripped = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const list = (v: unknown): string[] =>
    (Array.isArray(v) ? v : [])
      .map((x) => clean(x, 260))
      .filter((x): x is string => !!x && isGrounded(x, facts))
      .slice(0, 4);
  const headline = clean(parsed.headline, 120);
  const out: Commentary = {
    source: "ai",
    headline: headline && isGrounded(headline, facts) ? headline : "",
    highlights: list(parsed.highlights),
    risks: list(parsed.risks),
    actions: list(parsed.actions),
  };
  const total = out.highlights.length + out.risks.length + out.actions.length;
  return total >= 2 && out.headline ? out : null;
}

export function deterministicCommentary(m: ExecutiveMetrics): Commentary {
  const c = m.current;
  const d = m.deltas;
  const highlights: string[] = [];
  const risks: string[] = [];
  const actions: string[] = [];

  if (c.revenue > 0) {
    if (d.revenuePct !== null && d.revenuePct >= 0) highlights.push(`Revenue reached ${money(c.revenue)}, up ${d.revenuePct}% on the prior month.`);
    else if (d.revenuePct !== null) risks.push(`Revenue was ${money(c.revenue)}, down ${Math.abs(d.revenuePct)}% on the prior month.`);
    else highlights.push(`Revenue reached ${money(c.revenue)} from ${c.jobsCompleted} completed jobs.`);
  } else {
    risks.push("No billed revenue was recorded this month — confirm invoices are being attached to completed jobs.");
  }
  if (c.closeRatePct !== null) {
    (c.closeRatePct >= 50 ? highlights : risks).push(`Close rate was ${pct(c.closeRatePct)} (${c.quotesAccepted} of ${c.quotesDecided} decided quotes).`);
  }
  if (c.missedCallEvents > 0) {
    if ((c.recoveryRatePct ?? 0) >= 50) highlights.push(`Recovered ${c.recoveredCount} of ${c.missedCallEvents} missed calls, worth ${money(c.recoveredValue)}.`);
    else {
      risks.push(`Only ${c.recoveredCount} of ${c.missedCallEvents} missed calls were recovered.`);
      actions.push("Work the open missed-call recovery queue within 24 hours of each call.");
    }
  }
  if (c.marginPct !== null) {
    (c.marginPct >= 30 ? highlights : risks).push(`Gross margin on costed jobs was ${pct(c.marginPct)}.`);
  }
  if ((c.reworkRatePct ?? 0) >= 10) {
    risks.push(`Rework affected ${pct(c.reworkRatePct)} of completed jobs.`);
    actions.push("Review the causes of rework jobs with the lead technicians.");
  }
  const top = m.topTechnicians[0];
  if (top) highlights.push(`${top.name} led the team with ${money(top.revenue)} across ${top.jobs} jobs.`);
  m.goals.filter((g) => g.status === "behind").forEach((g) => risks.push(`${g.label} is behind goal.`));
  if (m.dataQuality.costCoveragePct !== null && m.dataQuality.costCoveragePct < 70) {
    actions.push("Record job costs on more jobs so margin reporting reflects the whole month.");
  }
  if (!actions.length) actions.push("Keep following up on open quotes and recovery items to protect next month's pipeline.");

  const headline = d.revenuePct === null
    ? `${m.period.label}: ${money(c.revenue)} in revenue`
    : d.revenuePct >= 0
      ? `${m.period.label}: revenue up ${d.revenuePct}% to ${money(c.revenue)}`
      : `${m.period.label}: revenue down ${Math.abs(d.revenuePct)}% to ${money(c.revenue)}`;

  return { source: "deterministic", headline, highlights: highlights.slice(0, 4), risks: risks.slice(0, 4), actions: actions.slice(0, 3) };
}
