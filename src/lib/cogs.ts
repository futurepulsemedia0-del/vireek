/**
 * COGS and gross-margin view-models for the staff "Realised COGS" tab (pure, no I/O).
 *
 * Source: staff_cogs_by_plan / staff_cogs_tenants / staff_cogs_ai_actions (20290305000100_cogs_margin_views.sql).
 * Money arrives as micro-USD (1e-6 USD) for cost and integer cents for list-price revenue.
 * Rule kept from planMargins.ts: a missing figure is `null` ("—"), never 0, so nothing looks profitable by omission.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** PostgREST returns bigint / numeric as number or numeric string; anything else is "unknown". */
const numOrNull = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const num = (v: unknown): number => numOrNull(v) ?? 0;
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/** A plan whose realised margin is below this at list price is flagged (same floor as planMargins.ts). */
export const COGS_MARGIN_FLOOR_PCT = 45;
/** Below this share of costed calls, per-minute figures are shown with a coverage warning. */
export const COGS_MIN_COVERAGE_PCT = 90;

export interface CogsPlanRow {
  month: string;
  planTier: string;
  tenantsTotal: number;
  tenantsBilled: number;
  activeTenants: number;
  listPriceCents: number | null;
  priceIsQuoted: boolean;
  minutesTotal: number;
  minutesCosted: number;
  callsTotal: number;
  callsCosted: number;
  voiceCostMicro: number;
  aiActions: number;
  aiCostMicro: number;
  otherCostMicro: number;
  totalCostMicro: number;
  voiceCostPerMinMicro: number | null;
  aiCostPerActionMicro: number | null;
  subscriptionRevenueCents: number | null;
  grossMarginCents: number | null;
  grossMarginPct: number | null;
  callCostCoveragePct: number | null;
}

export interface CogsTenantRow {
  accountId: string;
  month: string;
  planTier: string;
  isBilled: boolean;
  callsTotal: number;
  callsCosted: number;
  minutesCosted: number;
  voiceCostMicro: number;
  voiceCostPerMinMicro: number | null;
  aiActions: number;
  aiCostMicro: number;
  aiCostPerActionMicro: number | null;
  otherCostMicro: number;
  totalCostMicro: number;
  callCostCoveragePct: number | null;
}

export interface CogsAiActionRow {
  planTier: string;
  taskType: string;
  aiActions: number;
  tenants: number;
  costMicro: number;
  costPerActionMicro: number | null;
  estimatedCostMicro: number;
}

export function parseCogsPlans(raw: unknown): CogsPlanRow[] {
  if (!isObj(raw) || !Array.isArray(raw.plans)) return [];
  return raw.plans.filter(isObj).map((p) => ({
    month: str(p.month),
    planTier: str(p.plan_tier, 'unknown'),
    tenantsTotal: num(p.tenants_total),
    tenantsBilled: num(p.tenants_billed),
    activeTenants: num(p.active_tenants),
    listPriceCents: numOrNull(p.list_price_cents),
    priceIsQuoted: p.price_is_quoted === true,
    minutesTotal: num(p.minutes_total),
    minutesCosted: num(p.minutes_costed),
    callsTotal: num(p.calls_total),
    callsCosted: num(p.calls_costed),
    voiceCostMicro: num(p.voice_cost_micro),
    aiActions: num(p.ai_actions),
    aiCostMicro: num(p.ai_cost_micro),
    otherCostMicro: num(p.other_cost_micro),
    totalCostMicro: num(p.total_cost_micro),
    voiceCostPerMinMicro: numOrNull(p.voice_cost_per_min_micro),
    aiCostPerActionMicro: numOrNull(p.ai_cost_per_action_micro),
    subscriptionRevenueCents: numOrNull(p.subscription_revenue_cents),
    grossMarginCents: numOrNull(p.gross_margin_cents),
    grossMarginPct: numOrNull(p.gross_margin_pct),
    callCostCoveragePct: numOrNull(p.call_cost_coverage_pct),
  }));
}

export function parseCogsTenants(raw: unknown): { rows: CogsTenantRow[]; truncated: boolean } {
  if (!isObj(raw) || !Array.isArray(raw.tenants)) return { rows: [], truncated: false };
  const rows = raw.tenants.filter(isObj).map((t) => ({
    accountId: str(t.account_id),
    month: str(t.month),
    planTier: str(t.plan_tier, 'unknown'),
    isBilled: t.is_billed === true,
    callsTotal: num(t.calls_total),
    callsCosted: num(t.calls_costed),
    minutesCosted: num(t.minutes_costed),
    voiceCostMicro: num(t.voice_cost_micro),
    voiceCostPerMinMicro: numOrNull(t.voice_cost_per_min_micro),
    aiActions: num(t.ai_actions),
    aiCostMicro: num(t.ai_cost_micro),
    aiCostPerActionMicro: numOrNull(t.ai_cost_per_action_micro),
    otherCostMicro: num(t.other_cost_micro),
    totalCostMicro: num(t.total_cost_micro),
    callCostCoveragePct: numOrNull(t.call_cost_coverage_pct),
  }));
  return { rows, truncated: raw.truncated === true };
}

export function parseCogsAiActions(raw: unknown): CogsAiActionRow[] {
  if (!isObj(raw) || !Array.isArray(raw.actions)) return [];
  return raw.actions.filter(isObj).map((a) => ({
    planTier: str(a.plan_tier, 'unknown'),
    taskType: str(a.task_type, 'unattributed'),
    aiActions: num(a.ai_actions),
    tenants: num(a.tenants),
    costMicro: num(a.cost_micro),
    costPerActionMicro: numOrNull(a.cost_per_action_micro),
    estimatedCostMicro: num(a.estimated_cost_micro),
  }));
}

/** micro-USD -> USD number (null stays null). */
export const microToUsd = (micro: number | null | undefined): number | null =>
  micro === null || micro === undefined || !Number.isFinite(micro) ? null : micro / 1_000_000;

/** Per-unit costs are small, so show up to 4 decimals under $1 (matches formatUsd in staffUsage.ts). */
export function formatMicroUsd(micro: number | null | undefined, opts: { digits?: number } = {}): string {
  const usd = microToUsd(micro);
  if (usd === null) return '—';
  const abs = Math.abs(usd);
  const digits = opts.digits ?? (abs > 0 && abs < 1 ? 4 : 2);
  return `${usd < 0 ? '-' : ''}$${abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  const abs = Math.abs(cents) / 100;
  return `${cents < 0 ? '-' : ''}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPct1(pct: number | null | undefined): string {
  return pct === null || pct === undefined || !Number.isFinite(pct) ? '—' : `${pct.toFixed(1)}%`;
}

export type CogsPlanStatus = 'ok' | 'below_floor' | 'no_price' | 'no_revenue' | 'low_coverage';

/**
 * Status of one plan row. Order matters: a row without a fixed price is never judged on margin, and a row with
 * incomplete cost coverage is never called "ok" (a missing cost would overstate the margin).
 */
export function planStatus(row: CogsPlanRow, floorPct = COGS_MARGIN_FLOOR_PCT, minCoveragePct = COGS_MIN_COVERAGE_PCT): CogsPlanStatus {
  if (row.listPriceCents === null || row.priceIsQuoted) return 'no_price';
  if (row.tenantsBilled === 0) return 'no_revenue';
  if (row.callCostCoveragePct !== null && row.callCostCoveragePct < minCoveragePct) return 'low_coverage';
  if (row.grossMarginPct !== null && row.grossMarginPct + 1e-9 < floorPct) return 'below_floor';
  return 'ok';
}

/** First day of the month `offset` months before `now`, as YYYY-MM-DD (UTC). */
export function monthStart(now: Date, offset = 0): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1)).toISOString().slice(0, 10);
}

/** Last `count` month starts, newest first (current month first). */
export function recentMonths(now: Date, count = 12): string[] {
  return Array.from({ length: Math.max(1, count) }, (_, i) => monthStart(now, i));
}
