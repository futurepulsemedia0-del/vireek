/**
 * Outcome Learning — pure, deterministic, explainable.
 *
 * Same philosophy as margin guardrails / underpriced-job detection: a price or
 * a checklist rule must be a number and a reason the owner can inspect, never an
 * opaque model guess. This file has no I/O; tradePlaybooks.ts persists results.
 *
 * Statistical rules (all thresholds live in LEARNING):
 *  - Small samples are shrunk toward the catalog benchmark (Bayesian-style
 *    shrinkage), so 3 lucky jobs never rewrite a playbook.
 *  - Callback statistics only use "matured" outcomes (callbacks lag the job).
 *  - Rework jobs are excluded from rates: they are the fix, not new demand.
 *  - Price analysis only uses outcomes recorded after the last accepted price
 *    change for that job type, so an accepted increase is never re-suggested
 *    from data that predates it.
 *  - Every suggestion is human-approved; nothing is applied automatically.
 */

import type { JobTypeBenchmark, TradeJobType, TradePlaybook } from '@/lib/tradePlaybookCatalog';

export type Resolution = 'fixed_first_visit' | 'fixed_followup' | 'parts_pending' | 'quote_declined' | 'unresolved';

export interface JobOutcome {
  id: string;
  job_id: string;
  playbook_slug: string;
  job_type_key: string;
  root_cause_key: string | null;
  resolution: Resolution;
  checklist_done: string[];
  checklist_total: number;
  parts_used: string[];
  notes: string | null;
  revenue_cents: number | null;
  cost_cents: number | null;
  duration_minutes: number | null;
  is_rework: boolean;
  caused_callback: boolean;
  technician_id: string | null;
  customer_rating: number | null;
  recorded_at: string;
}

export type SuggestionKind = 'price_adjust' | 'duration_adjust' | 'root_cause_article' | 'checklist_critical';
export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed';

export interface DraftSuggestion {
  playbook_slug: string;
  job_type_key: string;
  suggestion_key: string;
  kind: SuggestionKind;
  title: string;
  rationale: string;
  evidence: Record<string, number | string>;
  payload: Record<string, unknown>;
}

export interface TuningRow {
  playbook_slug: string;
  job_type_key: string;
  target_duration_minutes: number | null;
  critical_item_ids: string[];
}

export interface PriceRef {
  id: string;
  service_name: string;
  price_cents: number;
  price_max_cents: number | null;
}

export interface DecisionRef {
  kind: SuggestionKind;
  job_type_key: string;
  status: SuggestionStatus;
  decided_at: string | null;
}

export const LEARNING = {
  minSuggestionSamples: 8,
  minMarginSamples: 6,
  minChecklistGroup: 3,
  priorStrength: 6,
  maturityDays: 14,
  maxPriceStepPct: 15,
  minPriceStepPct: 3,
  marginToleranceRatio: 0.05,
  durationDeviationRatio: 0.2,
  checklistLiftThreshold: 0.25,
  causeShareThreshold: 0.3,
  minCauseCount: 3,
} as const;

const DAY_MS = 86_400_000;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Blend an observed rate with a prior, weighting the prior as `k` pseudo-observations. */
export function shrink(observed: number, n: number, prior: number, k: number = LEARNING.priorStrength): number {
  if (n <= 0) return prior;
  return (observed * n + prior * k) / (n + k);
}

export function confidenceOf(n: number): 'low' | 'medium' | 'high' {
  if (n < 5) return 'low';
  if (n < 15) return 'medium';
  return 'high';
}

const round5 = (x: number) => Math.round(x / 5) * 5;
const isMature = (o: JobOutcome, now: number) => now - Date.parse(o.recorded_at) >= LEARNING.maturityDays * DAY_MS;

export interface JobTypeStats {
  n: number;
  confidence: 'low' | 'medium' | 'high';
  firstTimeFixPct: number | null;
  callbackPct: number | null;
  medianTicketCents: number | null;
  medianDurationMinutes: number | null;
  marginPct: number | null;
  marginSamples: number;
  diagnosed: number;
  topCauses: { key: string; count: number; share: number }[];
}

export function summarize(all: JobOutcome[], benchmark: JobTypeBenchmark, now: number = Date.now()): JobTypeStats {
  const rows = all.filter((o) => !o.is_rework);
  const n = rows.length;
  const empty: JobTypeStats = {
    n: 0, confidence: 'low', firstTimeFixPct: null, callbackPct: null, medianTicketCents: null,
    medianDurationMinutes: null, marginPct: null, marginSamples: 0, diagnosed: 0, topCauses: [],
  };
  if (n === 0) return empty;

  const ftf = rows.filter((o) => o.resolution === 'fixed_first_visit').length / n;
  const mature = rows.filter((o) => isMature(o, now));
  const cb = mature.length > 0 ? mature.filter((o) => o.caused_callback).length / mature.length : null;

  const withMargin = rows.filter((o) => (o.revenue_cents ?? 0) > 0 && o.cost_cents !== null);
  const sumRev = withMargin.reduce((s, o) => s + (o.revenue_cents ?? 0), 0);
  const sumCost = withMargin.reduce((s, o) => s + (o.cost_cents ?? 0), 0);
  const marginRaw = sumRev > 0 ? 1 - sumCost / sumRev : null;

  const causeCounts = new Map<string, number>();
  for (const o of rows) if (o.root_cause_key) causeCounts.set(o.root_cause_key, (causeCounts.get(o.root_cause_key) ?? 0) + 1);
  const diagnosed = [...causeCounts.values()].reduce((s, v) => s + v, 0);

  return {
    n,
    confidence: confidenceOf(n),
    firstTimeFixPct: shrink(ftf, n, benchmark.firstTimeFixPct / 100) * 100,
    callbackPct: cb === null ? null : shrink(cb, mature.length, benchmark.maxCallbackPct / 100) * 100,
    medianTicketCents: median(rows.map((o) => o.revenue_cents ?? 0).filter((v) => v > 0)),
    medianDurationMinutes: median(rows.map((o) => o.duration_minutes ?? 0).filter((v) => v > 0)),
    marginPct: marginRaw === null ? null : shrink(marginRaw, withMargin.length, benchmark.targetMarginPct / 100) * 100,
    marginSamples: withMargin.length,
    diagnosed,
    topCauses: [...causeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key, count]) => ({ key, count, share: diagnosed > 0 ? count / diagnosed : 0 })),
  };
}

export interface DeriveInput {
  playbook: TradePlaybook;
  outcomes: JobOutcome[];
  priceItems: PriceRef[];
  tuning: TuningRow[];
  decisions: DecisionRef[];
  now?: number;
}

export function deriveSuggestions(input: DeriveInput): DraftSuggestion[] {
  const { playbook, outcomes, priceItems, tuning, decisions } = input;
  const now = input.now ?? Date.now();
  const out: DraftSuggestion[] = [];

  for (const jt of playbook.jobTypes) {
    const rows = outcomes.filter((o) => o.playbook_slug === playbook.slug && o.job_type_key === jt.key && !o.is_rework);
    if (rows.length === 0) continue;
    const tune = tuning.find((t) => t.playbook_slug === playbook.slug && t.job_type_key === jt.key);
    const lastPriceChange = decisions
      .filter((d) => d.kind === 'price_adjust' && d.job_type_key === jt.key && d.status === 'accepted' && d.decided_at)
      .map((d) => Date.parse(d.decided_at as string))
      .reduce((m, v) => Math.max(m, v), 0);

    const item = priceItems.find((p) => p.service_name.toLowerCase() === jt.price.serviceName.toLowerCase());
    const push = (s: DraftSuggestion | null) => { if (s) out.push(s); };

    if (item) push(priceSuggestion(playbook.slug, jt, rows, item, lastPriceChange));
    push(durationSuggestion(playbook.slug, jt, rows, tune));
    push(checklistSuggestion(playbook.slug, jt, rows, tune, now));
    push(causeSuggestion(playbook.slug, jt, rows));
  }
  return out;
}

function priceSuggestion(slug: string, jt: TradeJobType, rows: JobOutcome[], item: PriceRef, sinceMs: number): DraftSuggestion | null {
  const usable = rows.filter((o) => Date.parse(o.recorded_at) > sinceMs && (o.revenue_cents ?? 0) > 0 && o.cost_cents !== null);
  const m = usable.length;
  if (m < LEARNING.minMarginSamples) return null;

  const rev = usable.reduce((s, o) => s + (o.revenue_cents ?? 0), 0);
  const cost = usable.reduce((s, o) => s + (o.cost_cents ?? 0), 0);
  const target = jt.benchmark.targetMarginPct / 100;
  const observed = shrink(1 - cost / rev, m, target);
  if (observed >= target - LEARNING.marginToleranceRatio) return null;

  const factor = Math.min(1 + LEARNING.maxPriceStepPct / 100, (1 - observed) / (1 - target));
  const newPrice = Math.round((item.price_cents * factor) / 100) * 100;
  if (newPrice < item.price_cents * (1 + LEARNING.minPriceStepPct / 100)) return null;
  const newMax = item.price_max_cents === null ? null : Math.max(newPrice, Math.round((item.price_max_cents * factor) / 100) * 100);
  const pct = Math.round((newPrice / item.price_cents - 1) * 100);

  return {
    playbook_slug: slug,
    job_type_key: jt.key,
    suggestion_key: `price:${slug}:${jt.key}:${item.price_cents}`,
    kind: 'price_adjust',
    title: `Raise “${item.service_name}” by ${pct}%`,
    rationale: `Across ${m} recent jobs your realized gross margin is about ${Math.round(observed * 100)}% against a ${jt.benchmark.targetMarginPct}% target. Each step is capped at ${LEARNING.maxPriceStepPct}%. This changes the Price Book entry only; quotes already sent are unchanged.`,
    evidence: { samples: m, margin_pct: Math.round(observed * 1000) / 10, target_margin_pct: jt.benchmark.targetMarginPct, step_pct: pct },
    payload: { price_book_item_id: item.id, old_price_cents: item.price_cents, new_price_cents: newPrice, old_price_max_cents: item.price_max_cents, new_price_max_cents: newMax },
  };
}

function durationSuggestion(slug: string, jt: TradeJobType, rows: JobOutcome[], tune: TuningRow | undefined): DraftSuggestion | null {
  const durations = rows.map((o) => o.duration_minutes ?? 0).filter((d) => d > 0);
  if (durations.length < LEARNING.minSuggestionSamples) return null;
  const med = median(durations) as number;
  const current = tune?.target_duration_minutes ?? jt.benchmark.durationMinutes;
  if (Math.abs(med - current) / current < LEARNING.durationDeviationRatio) return null;
  const next = round5(shrink(med, durations.length, current, 4));
  if (next <= 0 || next === current) return null;

  return {
    playbook_slug: slug,
    job_type_key: jt.key,
    suggestion_key: `duration:${slug}:${jt.key}:${Math.round(next / 15) * 15}`,
    kind: 'duration_adjust',
    title: `Set ${jt.label} time to ${next} min`,
    rationale: `The median of ${durations.length} completed jobs is ${Math.round(med)} min versus a ${current} min target (${med > current ? 'longer' : 'shorter'} than planned). Booking to the real duration reduces overruns and idle gaps.`,
    evidence: { samples: durations.length, median_minutes: Math.round(med), current_target_minutes: current },
    payload: { target_duration_minutes: next },
  };
}

function checklistSuggestion(slug: string, jt: TradeJobType, rows: JobOutcome[], tune: TuningRow | undefined, now: number): DraftSuggestion | null {
  const mature = rows.filter((o) => isMature(o, now) && o.checklist_total > 0);
  if (mature.length < LEARNING.minSuggestionSamples) return null;
  const already = new Set([...jt.checklist.filter((i) => i.critical).map((i) => i.id), ...(tune?.critical_item_ids ?? [])]);
  const rate = (list: JobOutcome[]) => list.filter((o) => o.caused_callback).length / list.length;

  let best: { id: string; label: string; lift: number; skipped: number; done: number; rs: number; rd: number } | null = null;
  for (const item of jt.checklist) {
    if (already.has(item.id)) continue;
    const done = mature.filter((o) => o.checklist_done.includes(item.id));
    const skipped = mature.filter((o) => !o.checklist_done.includes(item.id));
    if (done.length < LEARNING.minChecklistGroup || skipped.length < LEARNING.minChecklistGroup) continue;
    const rs = rate(skipped);
    const rd = rate(done);
    const lift = rs - rd;
    if (lift >= LEARNING.checklistLiftThreshold && (!best || lift > best.lift)) best = { id: item.id, label: item.label, lift, skipped: skipped.length, done: done.length, rs, rd };
  }
  if (!best) return null;

  return {
    playbook_slug: slug,
    job_type_key: jt.key,
    suggestion_key: `checklist:${slug}:${jt.key}:${best.id}`,
    kind: 'checklist_critical',
    title: `Make “${best.label}” a required step`,
    rationale: `When this step was skipped, ${Math.round(best.rs * 100)}% of ${jt.label} jobs needed a callback, versus ${Math.round(best.rd * 100)}% when it was completed (${best.skipped} skipped, ${best.done} completed). Marking it critical highlights it for every technician.`,
    evidence: { skipped_jobs: best.skipped, completed_jobs: best.done, callback_pct_skipped: Math.round(best.rs * 100), callback_pct_done: Math.round(best.rd * 100) },
    payload: { item_id: best.id },
  };
}

function causeSuggestion(slug: string, jt: TradeJobType, rows: JobOutcome[]): DraftSuggestion | null {
  if (!jt.troubleshooting) return null;
  const s = summarize(rows, jt.benchmark);
  if (s.diagnosed < LEARNING.minSuggestionSamples) return null;
  const top = s.topCauses[0];
  if (!top || top.share < LEARNING.causeShareThreshold || top.count < LEARNING.minCauseCount) return null;
  const cause = jt.troubleshooting.causes.find((c) => c.key === top.key);
  if (!cause) return null;

  const pct = Math.round(top.share * 100);
  const parts = cause.parts.length > 0 ? ` Typical parts: ${cause.parts.join(', ')}.` : '';
  const summary = `For ${jt.label.toLowerCase()} calls at this business, the most common diagnosed cause is ${cause.label.toLowerCase()} (${pct}% of diagnosed jobs). Use it only to prepare the right technician and parts; never diagnose or promise a fix by phone.`;
  return {
    playbook_slug: slug,
    job_type_key: jt.key,
    suggestion_key: `cause:${slug}:${jt.key}:${cause.key}`,
    kind: 'root_cause_article',
    title: `Teach the AI your top ${jt.label.toLowerCase()} cause`,
    rationale: `${top.count} of ${s.diagnosed} diagnosed ${jt.label.toLowerCase()} jobs (${pct}%) ended in “${cause.label}”. Adding this to the knowledge base helps dispatch and the AI receptionist prepare the right skills and parts.`,
    evidence: { diagnosed_jobs: s.diagnosed, cause_jobs: top.count, share_pct: pct },
    payload: {
      title: `Your data: most common ${jt.label.toLowerCase()} cause`,
      summary,
      body: `${summary}\n\nSymptom: ${jt.troubleshooting.symptom}.\nTypical test: ${cause.test}\nTypical fix: ${cause.fix}${parts}`,
      keywords: [jt.label.toLowerCase(), cause.label.toLowerCase(), ...jt.price.keywords].slice(0, 8),
      category: 'Learned from your jobs',
    },
  };
}
