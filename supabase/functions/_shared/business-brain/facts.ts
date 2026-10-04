// supabase/functions/_shared/business-brain/facts.ts
//
// Builds the compact "fact pack" the LLM reasons over, then verifies the
// model's answer against it:
//   1. every cited evidence path must exist in the pack,
//   2. every dollar / percent / large number in the prose must match a
//      number in the pack (or a sum/difference of two of them),
//   3. a yes/no verdict computed by the engine can never be overridden.
// If the model fails verification badly — or fails at all — the engine's
// own deterministic answer is returned instead, so the owner never gets
// an invented number and never gets an empty screen.

import type {
  AnswerAction,
  AnswerFinding,
  BrainAnswer,
  EvidenceRef,
  QuestionPlan,
  RawData,
  Topic,
  Verdict,
} from "./types.ts";
import {
  buildContext,
  capacityWhatIf,
  customerOutreach,
  hiringWhatIf,
  moneyLeaks,
  profitDrivers,
  recommendations,
  serviceLines,
  technicianFit,
} from "./analytics.ts";
import { dayKey, normalizeDigits, round, safeText, usd } from "./util.ts";

// deno-lint-ignore no-explicit-any
export type Json = any;

const MAX_FACT_CHARS = 9000;

// =====================================================================
// Fact pack
// =====================================================================

export function buildFacts(raw: RawData, plan: QuestionPlan): Json {
  const ctx = buildContext(raw);
  const facts: Json = {};
  const topics = new Set<Topic>(plan.topics);
  const overview = topics.has("overview");

  const leaks = topics.has("money_leaks") || topics.has("recommendations") || overview ? moneyLeaks(ctx) : null;

  if (topics.has("profit_drivers") || overview) facts.profit_drivers = profitDrivers(ctx, plan.period);
  if (topics.has("money_leaks") || overview) facts.money_leaks = leaks;
  if (topics.has("technician_fit")) facts.technician_fit = technicianFit(ctx, plan);
  if (topics.has("customer_outreach")) facts.customer_outreach = customerOutreach(ctx);
  if (topics.has("capacity_whatif")) facts.capacity_whatif = capacityWhatIf(ctx, plan);
  if (topics.has("hiring_whatif")) facts.hiring_whatif = hiringWhatIf(ctx, plan);
  if ((topics.has("recommendations") || overview) && leaks) {
    facts.recommendations = recommendations(ctx, leaks);
    facts.service_lines_90d = serviceLines(ctx, 90, 5);
  }
  if (overview) {
    facts.capacity_next_7_days = capacityWhatIf(ctx, { ...plan, trade: null, extraJobs: null });
  }

  facts.meta = {
    as_of: dayKey(raw.now, raw.timeZone),
    timezone: raw.timeZone,
    currency: "USD",
    coverage: ctx.coverage,
    data_gaps: raw.gaps,
  };
  return shrinkToFit(facts);
}

function shrink(value: Json, maxArr: number, maxStr: number): Json {
  if (Array.isArray(value)) return value.slice(0, maxArr).map((v) => shrink(v, maxArr, maxStr));
  if (value && typeof value === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) out[k] = shrink(v, maxArr, maxStr);
    return out;
  }
  if (typeof value === "string" && value.length > maxStr) return `${value.slice(0, maxStr - 1)}…`;
  return value;
}

function shrinkToFit(facts: Json): Json {
  const levels: [number, number][] = [
    [100, 400],
    [5, 220],
    [3, 160],
    [2, 120],
  ];
  let out = facts;
  for (const [a, s] of levels) {
    out = shrink(facts, a, s);
    if (JSON.stringify(out).length <= MAX_FACT_CHARS) return out;
  }
  return out;
}

// =====================================================================
// Flattening (evidence index + number index)
// =====================================================================

export function flatten(value: Json, prefix = "facts", out = new Map<string, string | number | boolean | null>()) {
  if (Array.isArray(value)) value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) flatten(v, `${prefix}.${k}`, out);
  else out.set(prefix, (value ?? null) as string | number | boolean | null);
  return out;
}

const NUM_RX = /(?<![\w.])-?\$?\d[\d,]*(?:\.\d+)?%?/g;

function parseNum(token: string): number {
  return parseFloat(token.replace(/[$,%]/g, "").replace(/,/g, ""));
}

function knownNumbers(facts: Json, plan: QuestionPlan, question: string): number[] {
  const nums: number[] = [];
  for (const v of flatten(facts).values()) {
    if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
    else if (typeof v === "string") for (const m of v.match(NUM_RX) ?? []) nums.push(parseNum(m));
  }
  for (const m of normalizeDigits(question).match(NUM_RX) ?? []) nums.push(parseNum(m));
  if (plan.extraJobs) nums.push(plan.extraJobs);
  nums.push(plan.hires);
  // Sums and differences of the first N numbers (the model may total two figures).
  const base = nums.slice(0, 90);
  const derived: number[] = [];
  for (let i = 0; i < base.length; i++) {
    for (let j = i + 1; j < base.length; j++) {
      derived.push(base[i] + base[j], Math.abs(base[i] - base[j]));
    }
  }
  return [...nums, ...derived];
}

function matches(v: number, known: number[]): boolean {
  const a = Math.abs(v);
  return known.some((k) => {
    const b = Math.abs(k);
    return Math.abs(a - b) <= Math.max(0.51, b * 0.005);
  });
}

function checkNumbersIn(text: string, known: number[]): { checked: number; matched: number } {
  let checked = 0;
  let matched = 0;
  for (const token of text.match(NUM_RX) ?? []) {
    const v = parseNum(token);
    if (!Number.isFinite(v)) continue;
    const significant = token.includes("$") || token.includes("%") || Math.abs(v) >= 100;
    if (!significant) continue;
    checked++;
    if (matches(v, known)) matched++;
  }
  return { checked, matched };
}

// =====================================================================
// Normalising + verifying the model's JSON
// =====================================================================

const URGENCY = ["now", "today", "this_week", "this_month"] as const;
const OWNERS = ["owner", "dispatcher", "technician", "office", "finance"] as const;
const VERDICTS = ["yes", "no", "conditional", "info"] as const;

const str = (v: unknown, max: number): string => safeText(v, max);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function normalizeModelAnswer(
  parsed: unknown,
  facts: Json,
  plan: QuestionPlan,
  question: string,
  now: Date,
): BrainAnswer | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Json;
  const headline = str(p.headline, 220);
  const answer = String(p.answer ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim()
    .slice(0, 2200);
  if (!headline || !answer) return null;

  const known = knownNumbers(facts, plan, question);
  const index = flatten(facts);
  let checked = 0;
  let matched = 0;
  const tally = (text: string) => {
    const r = checkNumbersIn(text, known);
    checked += r.checked;
    matched += r.matched;
  };
  tally(headline);
  tally(answer);

  const impact = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : NaN;
    return Number.isFinite(n) && matches(n, known) ? round(n) : null;
  };

  const evidence = new Map<string, EvidenceRef>();
  const findings: AnswerFinding[] = arr(p.findings)
    .slice(0, 5)
    .map((f): AnswerFinding | null => {
      const o = f as Json;
      const title = str(o?.title, 140);
      const detail = str(o?.detail, 420);
      if (!title || !detail) return null;
      tally(detail);
      const refs = arr(o.evidence)
        .map((r) => String(r))
        .filter((r) => index.has(r))
        .slice(0, 4);
      for (const r of refs) if (!evidence.has(r) && evidence.size < 14) evidence.set(r, { ref: r, value: index.get(r) ?? null });
      return { title, detail, impact_usd: impact(o.impact_usd), evidence: refs };
    })
    .filter((f): f is AnswerFinding => f !== null);

  const actions: AnswerAction[] = arr(p.actions)
    .slice(0, 5)
    .map((a): AnswerAction | null => {
      const o = a as Json;
      const action = str(o?.action, 260);
      if (!action) return null;
      tally(action);
      return {
        action,
        owner: (OWNERS as readonly string[]).includes(o.owner) ? o.owner : "owner",
        urgency: (URGENCY as readonly string[]).includes(o.urgency) ? o.urgency : "this_week",
        expected_impact_usd: impact(o.expected_impact_usd),
      };
    })
    .filter((a): a is AnswerAction => a !== null);

  const ratio = checked ? matched / checked : 1;

  // A verdict computed by the engine is authoritative.
  let verdict: Verdict | null = (VERDICTS as readonly string[]).includes(p.verdict) ? p.verdict : null;
  const engineVerdict = facts?.capacity_whatif?.verdict;
  if (plan.topics.includes("capacity_whatif") && (VERDICTS as readonly string[]).includes(engineVerdict)) verdict = engineVerdict;

  const coverage = facts.meta.coverage;
  const needsCost = plan.topics.some((t) => ["profit_drivers", "money_leaks", "recommendations", "overview"].includes(t));
  let level: "low" | "medium" | "high" = ["low", "medium", "high"].includes(p.confidence?.level) ? p.confidence.level : "medium";
  if (ratio < 0.85 && level === "high") level = "medium";
  if (needsCost && !coverage.has_cost_data && level === "high") level = "medium";
  if (coverage.completed_jobs < 10) level = "low";

  const gaps = [...new Set([...arr(p.data_gaps).map((g) => str(g, 200)), ...(facts.meta.data_gaps as string[])])].filter(Boolean).slice(0, 6);

  return {
    headline,
    answer,
    verdict,
    findings,
    actions,
    confidence: { level, reason: str(p.confidence?.reason, 240) || "Based on your recorded jobs, costs and calls." },
    assumptions: arr(p.assumptions).map((a) => str(a, 220)).filter(Boolean).slice(0, 5),
    data_gaps: gaps,
    follow_ups: arr(p.follow_ups).map((q) => str(q, 120)).filter(Boolean).slice(0, 3),
    evidence: [...evidence.values()],
    topics: plan.topics,
    source: "ai",
    grounding: { checked, matched, ratio: round(ratio, 2) },
    as_of: now.toISOString(),
    timezone: facts.meta.timezone,
    coverage,
  };
}

/** True when the model's prose is too ungrounded to show. */
export function isTooUngrounded(a: BrainAnswer): boolean {
  return a.grounding.checked >= 3 && a.grounding.ratio < 0.7;
}

// =====================================================================
// Deterministic fallback answer (also the safety net for LLM outages)
// =====================================================================

function base(facts: Json, plan: QuestionPlan, now: Date): Omit<BrainAnswer, "headline" | "answer" | "findings" | "actions" | "verdict" | "follow_ups"> {
  const coverage = facts.meta.coverage;
  return {
    confidence: {
      level: coverage.completed_jobs < 10 ? "low" : coverage.has_cost_data ? "medium" : "low",
      reason: "Computed directly from your records; the AI explanation layer was unavailable or could not be verified.",
    },
    assumptions: [],
    data_gaps: (facts.meta.data_gaps as string[]).slice(0, 6),
    evidence: [],
    topics: plan.topics,
    source: "engine",
    grounding: { checked: 0, matched: 0, ratio: 1 },
    as_of: now.toISOString(),
    timezone: facts.meta.timezone,
    coverage,
  };
}

export function engineAnswer(facts: Json, plan: QuestionPlan, now: Date): BrainAnswer {
  const common = base(facts, plan, now);
  const topic = plan.topics[0];
  const empty = (headline: string, answer: string): BrainAnswer => ({
    ...common,
    headline,
    answer,
    verdict: "info",
    findings: [],
    actions: [],
    follow_ups: [],
  });

  if (topic === "profit_drivers" && facts.profit_drivers) {
    const pd = facts.profit_drivers;
    if (!pd.change || !pd.drivers) return empty("Not enough history to explain the change.", (pd.notes as string[]).join(" "));
    const metric = pd.basis === "profit" ? "Profit" : "Revenue";
    const dir = pd.change.amount_usd >= 0 ? "rose" : "fell";
    const names: Record<string, string> = { job_volume: "fewer or more jobs completed", price_and_job_mix: "ticket size and job mix", job_cost: "job cost" };
    const d = pd.drivers;
    return {
      ...common,
      headline: `${metric} ${dir} ${usd(Math.abs(pd.change.amount_usd))} ${pd.period} versus ${pd.compared_with}.`,
      answer: `${metric} for ${pd.period} was ${usd(pd.basis === "profit" ? pd.target.profit : pd.target.revenue)} on ${pd.target.jobs} job(s), against ${usd(pd.basis === "profit" ? pd.comparison.profit : pd.comparison.revenue)} for ${pd.compared_with}. The biggest driver was ${names[d.primary_driver] ?? d.primary_driver}.`,
      verdict: "info",
      findings: [
        { title: "Job volume", detail: `Volume effect: ${usd(d.volume_effect)}.`, impact_usd: d.volume_effect, evidence: ["facts.profit_drivers.drivers.volume_effect"] },
        { title: "Ticket size and mix", detail: `Price/mix effect: ${usd(d.price_mix_effect)}.`, impact_usd: d.price_mix_effect, evidence: ["facts.profit_drivers.drivers.price_mix_effect"] },
        ...(pd.basis === "profit"
          ? [{ title: "Job cost", detail: `Cost effect: ${usd(d.cost_effect)}.`, impact_usd: d.cost_effect, evidence: ["facts.profit_drivers.drivers.cost_effect"] }]
          : []),
      ],
      actions: [],
      follow_ups: ["Where am I losing money?", "What should I change?"],
    };
  }

  if (topic === "money_leaks" && facts.money_leaks) {
    const leaks = facts.money_leaks.leaks as Json[];
    if (!leaks.length) return empty("No significant money leaks were found in the last 30 days.", "Nothing in your records crossed the thresholds used for this check.");
    return {
      ...common,
      headline: `Biggest leak: ${leaks[0].label.toLowerCase()} — ${usd(leaks[0].amount)}.`,
      answer: `${usd(facts.money_leaks.total_measured)} is measured directly from your records and ${usd(facts.money_leaks.total_estimated)} is estimated.`,
      verdict: "info",
      findings: leaks.slice(0, 4).map((l, i) => ({
        title: l.label,
        detail: `${usd(l.amount)} (${l.basis}) across ${l.count} item(s). ${l.examples?.[0] ?? ""}`.trim(),
        impact_usd: l.amount,
        evidence: [`facts.money_leaks.leaks[${i}].amount`],
      })),
      actions: [],
      follow_ups: ["What should I change?"],
    };
  }

  if (topic === "technician_fit" && facts.technician_fit) {
    const tf = facts.technician_fit;
    const job = tf.jobs?.[0];
    const ranking = job?.ranking ?? tf.ranking;
    if (!ranking?.length) return empty("I could not rank technicians.", tf.note ?? "No technician data available.");
    const best = ranking[0];
    return {
      ...common,
      headline: `${best.technician} is the best fit${job ? ` for ${job.customer}` : ""}.`,
      answer: `${best.technician} scores ${best.score}/100: ${(best.reasons as string[]).join("; ")}.`,
      verdict: "info",
      findings: (ranking as Json[]).slice(0, 3).map((r) => ({ title: `${r.technician} — ${r.score}/100`, detail: (r.reasons as string[]).join("; "), impact_usd: null, evidence: [] })),
      actions: [{ action: `Assign ${best.technician}${job ? ` to ${job.customer}` : ""}`, owner: "dispatcher", urgency: "today", expected_impact_usd: null }],
      follow_ups: [],
    };
  }

  if (topic === "customer_outreach" && facts.customer_outreach) {
    const c = facts.customer_outreach.candidates as Json[];
    if (!c.length) return empty("Nobody urgently needs a call today.", "No open quotes, new leads, overdue invoices or maintenance reminders crossed the thresholds.");
    return {
      ...common,
      headline: `${c.length} customer${c.length === 1 ? "" : "s"} worth contacting today (about ${usd(facts.customer_outreach.total_value)} in play).`,
      answer: `Start with ${c[0].who}: ${c[0].reason}.`,
      verdict: "info",
      findings: c.slice(0, 5).map((x) => ({ title: x.who, detail: `${x.reason}. ${x.action}.`, impact_usd: x.value, evidence: [] })),
      actions: c.slice(0, 3).map((x) => ({ action: `${x.action}: ${x.who}`, owner: "office" as const, urgency: "today" as const, expected_impact_usd: x.value })),
      follow_ups: [],
    };
  }

  if (topic === "capacity_whatif" && facts.capacity_whatif?.capacity_jobs !== undefined) {
    const c = facts.capacity_whatif;
    const req = c.requested_extra_jobs;
    return {
      ...common,
      headline:
        req === null
          ? `You can take about ${c.comfortably_acceptable_jobs} more ${c.trade} jobs this week without touching the emergency reserve.`
          : c.verdict === "yes"
            ? `Yes — ${req} more ${c.trade} jobs fit this week.`
            : c.verdict === "conditional"
              ? `Only by using your emergency reserve — ${req} jobs exceed the ${c.comfortably_acceptable_jobs} that fit comfortably.`
              : `No — only ${c.supported_extra_jobs} more ${c.trade} jobs fit; ${c.shortfall_jobs} would not.`,
      answer: `Capacity is ${c.capacity_jobs} jobs this week with ${c.already_booked_jobs} already booked (${c.utilization_pct}% utilization). The binding limit is ${c.binding_constraint}.`,
      verdict: c.verdict,
      findings: [],
      actions: [],
      follow_ups: ["What happens if I hire another technician?"],
    };
  }

  if (topic === "hiring_whatif" && facts.hiring_whatif?.scenarios) {
    const h = facts.hiring_whatif;
    const base = h.scenarios[1];
    return {
      ...common,
      headline: `Demand pressure is ${h.demand_pressure}; a new technician would add about ${base.extra_jobs_per_week} jobs per week in the base case.`,
      answer: `Current utilization is ${h.current.utilization_pct}%. Base case adds ${base.extra_revenue_per_week === null ? "an unknown amount of" : usd(base.extra_revenue_per_week)} revenue per week.`,
      verdict: "conditional",
      findings: [],
      actions: [],
      follow_ups: [],
    };
  }

  const recs = (facts.recommendations ?? []) as Json[];
  if (recs.length) {
    return {
      ...common,
      headline: `Top change: ${recs[0].title} (about ${usd(recs[0].est_impact_usd)}).`,
      answer: recs.map((r, i) => `${i + 1}. ${r.title}. ${r.why}`).join(" "),
      verdict: "info",
      findings: [],
      actions: recs.slice(0, 4).map((r) => ({ action: r.title, owner: "owner" as const, urgency: "this_week" as const, expected_impact_usd: r.est_impact_usd })),
      follow_ups: [],
    };
  }

  return empty("I need more data to answer that reliably.", "There is not enough recorded activity yet for this question.");
}

/** Compact, injection-safe rendering of the fact pack for the prompt. */
export function factsToPrompt(facts: Json): string {
  return JSON.stringify(facts);
}
