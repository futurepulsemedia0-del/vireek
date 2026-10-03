/**
 * Vireek Pricing Learning Flywheel.
 *
 *   Job Profitability Autopsy -> Learn -> Owner approves -> Apply to Price Book
 *   -> Measure on real jobs -> next lap learns only from jobs at the NEW price
 *
 * Design rules (same philosophy as improvementLoop):
 *  - Everything above the "DATA LAYER" banner is pure and deterministic.
 *  - Only itemized-cost, non-rework, completed jobs teach the model.
 *  - Jobs link to a Price Book item by explicit link or EXACT name only.
 *  - Only 'flat' items, only price INCREASES, bounded per step, shrunk by sample size.
 *  - Discounting is reported as leakage, never "fixed" with a price rise.
 *  - Learning never uses jobs completed under a previous price of the same item.
 *  - Nothing changes the Price Book without the account owner approving it.
 *
 * Server counterpart: supabase/migrations/20270215000000_pricing_learning_flywheel.sql
 */

import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/priceBook';

// ============================================================
// TYPES
// ============================================================

export type AdjustmentStatus = 'proposed' | 'active' | 'superseded' | 'reverted' | 'dismissed';
export type ItemState =
  | 'proposal'
  | 'healthy'
  | 'discounting'
  | 'mixed'
  | 'cooldown'
  | 'insufficient'
  | 'too_small';
export type ResultVerdict = 'improved' | 'flat' | 'worsened' | 'insufficient';
export type PriceDriver = 'price' | 'cost_overrun';

export interface FlywheelSettings {
  target_margin_pct: number;
  max_step_pct: number;
  min_samples: number;
}

export interface FactRow {
  job_id: string;
  price_book_item_id: string;
  completed_at: string;
  revenue_cents: number;
  total_cost_cents: number;
  has_cost: boolean;
  is_rework: boolean;
}

export interface PriceItem {
  id: string;
  service_name: string;
  pricing_model: 'flat' | 'starting_at' | 'range' | 'hourly';
  price_cents: number;
  price_max_cents: number | null;
  estimated_cost_cents: number | null;
  active: boolean;
}

export interface AdjustmentRow {
  id: string;
  price_book_item_id: string;
  service_name: string;
  price_before_cents: number;
  price_proposed_cents: number;
  applied_price_cents: number | null;
  target_margin_pct: number;
  observed_margin_pct: number;
  avg_cost_cents: number;
  avg_revenue_cents: number;
  sample_size: number;
  evidence: Record<string, unknown>;
  status: AdjustmentStatus;
  proposed_at: string;
  decided_at: string | null;
  activated_at: string | null;
  deactivated_at: string | null;
  decision_reason: string | null;
}

export interface AdjustmentResult {
  adjustment_id: string;
  price_book_item_id: string;
  service_name: string;
  status: AdjustmentStatus;
  activated_at: string;
  price_before_cents: number;
  applied_price_cents: number | null;
  days_after: number;
  jobs_before: number;
  jobs_after: number;
  costed_before: number;
  costed_after: number;
  margin_before: number | null;
  margin_after: number | null;
  verdict: ResultVerdict;
  demand_warning: boolean;
}

export interface ItemAnalysis {
  item: PriceItem;
  state: ItemState;
  n: number;
  marginPct: number | null;
  medianMarginPct: number | null;
  belowTargetShare: number | null;
  avgRevenueCents: number | null;
  avgCostCents: number | null;
  /** 0..1, how far average revenue sits below the book price. */
  discountGap: number | null;
  /** Revenue lost versus book price across the sampled jobs. */
  leakageCents: number;
  driver: PriceDriver | null;
  proposedPriceCents: number | null;
  projectedMarginPct: number | null;
  reason: string;
}

export interface ProposalPayload {
  price_book_item_id: string;
  proposed_price_cents: number;
  observed_margin_pct: number;
  target_margin_pct: number;
  avg_cost_cents: number;
  avg_revenue_cents: number;
  sample_size: number;
  evidence: Record<string, unknown>;
}

export interface FlywheelAnalysis {
  items: ItemAnalysis[];
  proposals: ProposalPayload[];
  totals: {
    itemsWithData: number;
    proposals: number;
    leakageCents: number;
    jobsLearnedFrom: number;
  };
}

// ============================================================
// CONFIG
// ============================================================

export const DEFAULT_SETTINGS: FlywheelSettings = { target_margin_pct: 35, max_step_pct: 10, min_samples: 5 };

export const FLYWHEEL = {
  lookbackDays: 180,
  cooldownDays: 30,
  /** Shrinkage prior: n / (n + k) of the full indicated step is trusted. */
  shrinkK: 5,
  /** Share of sampled jobs that must individually miss the target. */
  minBelowTargetShare: 0.6,
  /** Average revenue this far under book price = discounting, not underpricing. */
  discountGap: 0.08,
  /** Actual avg cost this far over the item's own cost estimate = cost overrun. */
  costOverrun: 0.15,
} as const;

export const STATE_META: Record<ItemState, { label: string; className: string }> = {
  proposal: { label: 'Price rise proposed', className: 'bg-accent/10 text-accent' },
  healthy: { label: 'On target', className: 'bg-emerald-500/10 text-emerald-600' },
  discounting: { label: 'Discount leakage', className: 'bg-red-500/10 text-red-600' },
  mixed: { label: 'Inconsistent', className: 'bg-amber-500/10 text-amber-600' },
  cooldown: { label: 'Being measured', className: 'bg-slate-500/10 text-slate-500' },
  insufficient: { label: 'Learning', className: 'bg-slate-500/10 text-slate-500' },
  too_small: { label: 'Gap too small', className: 'bg-slate-500/10 text-slate-500' },
};

export const VERDICT_META: Record<ResultVerdict, { label: string; className: string }> = {
  improved: { label: 'Margin improved', className: 'bg-emerald-500/10 text-emerald-600' },
  flat: { label: 'No change', className: 'bg-slate-500/10 text-slate-500' },
  worsened: { label: 'Margin worse', className: 'bg-red-500/10 text-red-600' },
  insufficient: { label: 'Not enough jobs yet', className: 'bg-amber-500/10 text-amber-600' },
};

// ============================================================
// PURE LOGIC
// ============================================================

const DAY_MS = 86_400_000;

export const roundTo = (n: number, d = 1) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Revenue-weighted margin %, or null when there is no revenue. */
export function weightedMarginPct(rows: Array<Pick<FactRow, 'revenue_cents' | 'total_cost_cents'>>): number | null {
  const rev = rows.reduce((s, r) => s + r.revenue_cents, 0);
  if (rev <= 0) return null;
  const cost = rows.reduce((s, r) => s + r.total_cost_cents, 0);
  return roundTo(((rev - cost) / rev) * 100, 2);
}

/** Latest moment this item's price changed (apply, revert or supersede). Older jobs reflect a different price. */
export function priceEpochStartMs(itemId: string, adjustments: AdjustmentRow[]): number {
  let latest = 0;
  for (const a of adjustments) {
    if (a.price_book_item_id !== itemId) continue;
    if (a.activated_at) latest = Math.max(latest, Date.parse(a.activated_at));
    if (a.deactivated_at) latest = Math.max(latest, Date.parse(a.deactivated_at));
  }
  return latest;
}

function inCooldown(itemId: string, adjustments: AdjustmentRow[], nowMs: number): boolean {
  const cutoff = nowMs - FLYWHEEL.cooldownDays * DAY_MS;
  return adjustments.some((a) => {
    if (a.price_book_item_id !== itemId) return false;
    if (a.status === 'active' && a.activated_at) return Date.parse(a.activated_at) > cutoff;
    if ((a.status === 'dismissed' || a.status === 'reverted') && a.decided_at) return Date.parse(a.decided_at) > cutoff;
    return false;
  });
}

const blank = (item: PriceItem, state: ItemState, reason: string, n = 0): ItemAnalysis => ({
  item,
  state,
  n,
  marginPct: null,
  medianMarginPct: null,
  belowTargetShare: null,
  avgRevenueCents: null,
  avgCostCents: null,
  discountGap: null,
  leakageCents: 0,
  driver: null,
  proposedPriceCents: null,
  projectedMarginPct: null,
  reason,
});

export function analyzeItem(
  item: PriceItem,
  allFacts: FactRow[],
  adjustments: AdjustmentRow[],
  settings: FlywheelSettings,
  nowMs: number,
): ItemAnalysis {
  const epochStart = priceEpochStartMs(item.id, adjustments);
  const windowStart = Math.max(nowMs - FLYWHEEL.lookbackDays * DAY_MS, epochStart);
  const facts = allFacts.filter(
    (f) =>
      f.price_book_item_id === item.id &&
      f.has_cost &&
      !f.is_rework &&
      f.revenue_cents > 0 &&
      Date.parse(f.completed_at) >= windowStart,
  );
  const n = facts.length;

  if (item.pricing_model !== 'flat') return blank(item, 'insufficient', 'Only flat-price items are learned automatically.', n);
  if (inCooldown(item.id, adjustments, nowMs)) return blank(item, 'cooldown', 'A recent price decision is still being measured.', n);
  if (n < settings.min_samples) {
    return blank(item, 'insufficient', `${n} of ${settings.min_samples} costed jobs at the current price.`, n);
  }

  const marginPct = weightedMarginPct(facts) as number;
  const margins = facts.map((f) => ((f.revenue_cents - f.total_cost_cents) / f.revenue_cents) * 100);
  const medianMarginPct = median(margins);
  const target = settings.target_margin_pct;
  const belowTargetShare = margins.filter((m) => m < target).length / n;
  const avgRevenueCents = Math.round(facts.reduce((s, f) => s + f.revenue_cents, 0) / n);
  const avgCostCents = Math.round(facts.reduce((s, f) => s + f.total_cost_cents, 0) / n);
  const discountGap = item.price_cents > 0 ? Math.max(0, 1 - avgRevenueCents / item.price_cents) : 0;
  const leakageCents = Math.max(0, (item.price_cents - avgRevenueCents) * n);

  const base: ItemAnalysis = {
    ...blank(item, 'healthy', '', n),
    marginPct,
    medianMarginPct: medianMarginPct === null ? null : roundTo(medianMarginPct, 2),
    belowTargetShare: roundTo(belowTargetShare, 2),
    avgRevenueCents,
    avgCostCents,
    discountGap: roundTo(discountGap, 3),
    leakageCents,
  };

  if (marginPct >= target) return { ...base, state: 'healthy', reason: `Margin ${marginPct}% meets the ${target}% target.` };

  if (discountGap > FLYWHEEL.discountGap) {
    return {
      ...base,
      state: 'discounting',
      reason: `Jobs are billed ${Math.round(discountGap * 100)}% under the book price. A higher book price would not be charged — fix the discounts first.`,
    };
  }

  if (belowTargetShare < FLYWHEEL.minBelowTargetShare || (medianMarginPct ?? 0) >= target) {
    return {
      ...base,
      state: 'mixed',
      reason: `Only ${Math.round(belowTargetShare * 100)}% of jobs miss the target — results vary per job, so the price is not the clear cause.`,
    };
  }

  // Price that would hit the target at the observed average cost.
  const indicated = avgCostCents / (1 - target / 100);
  const ratio = indicated / item.price_cents;
  const shrink = n / (n + FLYWHEEL.shrinkK);
  const step = Math.min((ratio - 1) * shrink, settings.max_step_pct / 100);
  const proposedPriceCents = Math.floor((item.price_cents * (1 + step)) / 100) * 100;

  if (step <= 0 || proposedPriceCents <= item.price_cents) {
    return { ...base, state: 'too_small', reason: 'The indicated change is smaller than one whole dollar.' };
  }

  const driver: PriceDriver =
    item.estimated_cost_cents !== null && avgCostCents > item.estimated_cost_cents * (1 + FLYWHEEL.costOverrun)
      ? 'cost_overrun'
      : 'price';
  const projectedMarginPct = roundTo(((proposedPriceCents - avgCostCents) / proposedPriceCents) * 100, 1);

  return {
    ...base,
    state: 'proposal',
    driver,
    proposedPriceCents,
    projectedMarginPct,
    reason:
      driver === 'cost_overrun'
        ? `Real cost runs ${Math.round((avgCostCents / (item.estimated_cost_cents as number) - 1) * 100)}% above the item's cost estimate. A price rise helps, but also review the cost estimate and the jobs behind it.`
        : `Margin ${marginPct}% is under the ${target}% target on ${n} jobs at the current price.`,
  };
}

export function analyzePricing(
  facts: FactRow[],
  items: PriceItem[],
  adjustments: AdjustmentRow[],
  settings: FlywheelSettings,
  nowMs: number = Date.now(),
): FlywheelAnalysis {
  const analyses = items
    .filter((i) => i.active)
    .map((i) => analyzeItem(i, facts, adjustments, settings, nowMs));

  const proposals: ProposalPayload[] = analyses
    .filter((a) => a.state === 'proposal' && a.proposedPriceCents !== null)
    .map((a) => ({
      price_book_item_id: a.item.id,
      proposed_price_cents: a.proposedPriceCents as number,
      observed_margin_pct: a.marginPct as number,
      target_margin_pct: settings.target_margin_pct,
      avg_cost_cents: a.avgCostCents as number,
      avg_revenue_cents: a.avgRevenueCents as number,
      sample_size: a.n,
      evidence: {
        medianMarginPct: a.medianMarginPct,
        belowTargetShare: a.belowTargetShare,
        driver: a.driver,
        projectedMarginPct: a.projectedMarginPct,
        shrink: roundTo(a.n / (a.n + FLYWHEEL.shrinkK), 3),
        lookbackDays: FLYWHEEL.lookbackDays,
      },
    }));

  const withData = analyses.filter((a) => a.marginPct !== null);
  return {
    items: analyses.sort(rankItems),
    proposals,
    totals: {
      itemsWithData: withData.length,
      proposals: proposals.length,
      leakageCents: analyses.reduce((s, a) => s + (a.state === 'discounting' ? a.leakageCents : 0), 0),
      jobsLearnedFrom: withData.reduce((s, a) => s + a.n, 0),
    },
  };
}

const STATE_ORDER: Record<ItemState, number> = {
  proposal: 0,
  discounting: 1,
  mixed: 2,
  cooldown: 3,
  too_small: 4,
  insufficient: 5,
  healthy: 6,
};

function rankItems(a: ItemAnalysis, b: ItemAnalysis): number {
  const s = STATE_ORDER[a.state] - STATE_ORDER[b.state];
  if (s !== 0) return s;
  return b.n - a.n;
}

export interface FlywheelSummary {
  improved: number;
  flat: number;
  worsened: number;
  insufficient: number;
  demandWarnings: number;
  headline: string;
}

export function summarizeResults(results: AdjustmentResult[]): FlywheelSummary {
  const s = { improved: 0, flat: 0, worsened: 0, insufficient: 0, demandWarnings: 0 };
  for (const r of results) {
    s[r.verdict] += 1;
    if (r.demand_warning) s.demandWarnings += 1;
  }
  const judged = s.improved + s.flat + s.worsened;
  let headline: string;
  if (results.length === 0) headline = 'No price change has been applied yet, so there is nothing to measure.';
  else if (judged === 0) headline = 'Price changes are live, but there are not yet enough costed jobs on both sides to judge them.';
  else if (s.worsened > 0) headline = `${s.worsened} of ${judged} judged price changes lowered margin — review and revert them.`;
  else if (s.improved > 0) headline = `${s.improved} of ${judged} judged price changes raised margin.`;
  else headline = 'Judged price changes made no measurable difference yet.';
  if (s.demandWarnings > 0) headline += ` ${s.demandWarnings} show a sharp drop in job volume.`;
  return { ...s, headline };
}

export const pctText = (n: number | null, d = 1) => (n === null ? '—' : `${roundTo(n, d)}%`);
export const centsText = (n: number | null) => (n === null ? '—' : formatCents(n));

// ============================================================
// DATA LAYER
// ============================================================

function msg(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

export interface FlywheelData {
  facts: FactRow[];
  items: PriceItem[];
  adjustments: AdjustmentRow[];
  settings: FlywheelSettings;
  results: AdjustmentResult[];
}

export async function gatherFlywheelData(now: number = Date.now()): Promise<FlywheelData> {
  const since = new Date(now - FLYWHEEL.lookbackDays * DAY_MS).toISOString();
  const [facts, items, adjustments, settings, results] = await Promise.all([
    supabase
      .from('pricing_flywheel_facts')
      .select('job_id, price_book_item_id, completed_at, revenue_cents, total_cost_cents, has_cost, is_rework')
      .gte('completed_at', since)
      .order('completed_at', { ascending: false })
      .limit(5000),
    supabase
      .from('price_book_items')
      .select('id, service_name, pricing_model, price_cents, price_max_cents, estimated_cost_cents, active')
      .eq('active', true)
      .limit(1000),
    supabase.from('pricing_adjustments').select('*').order('proposed_at', { ascending: false }).limit(300),
    supabase.from('pricing_flywheel_settings').select('target_margin_pct, max_step_pct, min_samples').maybeSingle(),
    supabase.rpc('get_pricing_adjustment_results'),
  ]);
  for (const r of [facts, items, adjustments, settings, results]) {
    if (r.error) throw new Error(msg(r.error, 'Could not load pricing data.'));
  }
  const s = settings.data as FlywheelSettings | null;
  return {
    facts: (facts.data as FactRow[]) ?? [],
    items: (items.data as PriceItem[]) ?? [],
    adjustments: (adjustments.data as AdjustmentRow[]) ?? [],
    settings: s
      ? {
          target_margin_pct: Number(s.target_margin_pct),
          max_step_pct: Number(s.max_step_pct),
          min_samples: Number(s.min_samples),
        }
      : DEFAULT_SETTINGS,
    results: ((results.data as AdjustmentResult[]) ?? []).map((r) => ({
      ...r,
      margin_before: r.margin_before === null ? null : Number(r.margin_before),
      margin_after: r.margin_after === null ? null : Number(r.margin_after),
    })),
  };
}

export async function persistProposals(proposals: ProposalPayload[]): Promise<number> {
  if (proposals.length === 0) return 0;
  const { data, error } = await supabase.rpc('record_pricing_proposals', { p_proposals: proposals });
  if (error) throw new Error(msg(error, 'Could not save price proposals.'));
  return typeof data === 'number' ? data : 0;
}

export async function decideAdjustment(id: string, decision: 'approve' | 'dismiss' | 'revert', reason?: string): Promise<void> {
  const { error } = await supabase.rpc('decide_pricing_adjustment', {
    p_id: id,
    p_decision: decision,
    p_reason: reason ?? null,
  });
  if (error) throw new Error(msg(error, 'Could not save the decision.'));
}

export async function saveFlywheelSettings(s: FlywheelSettings): Promise<void> {
  const { error } = await supabase.rpc('set_pricing_flywheel_settings', {
    p_target_margin_pct: s.target_margin_pct,
    p_max_step_pct: s.max_step_pct,
    p_min_samples: s.min_samples,
  });
  if (error) throw new Error(msg(error, 'Could not save settings.'));
}
