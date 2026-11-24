/**
 * Sales pipeline — pure logic (no I/O). Extends the existing CRM module (`crm_deals`, see src/lib/crmSync.ts):
 * stage weights, forecast roll-up and deal-desk discount rules. The database enforces the rules
 * (supabase/migrations/20290306000100_sales_pipeline.sql); the functions here mirror them so the UI can explain and pre-check.
 * Money is handled in integer cents to avoid floating-point drift. Dates are UTC.
 */

export const FORECAST_CATEGORIES = ['pipeline', 'best_case', 'commit', 'omitted'] as const;
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number];

export const APPROVAL_LEVELS = ['auto', 'manager', 'owner'] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

export const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const LIMITS = { reasonMin: 10, reasonMax: 1000, noteMax: 1000, stageLabelMax: 60, matchNamesMax: 20 } as const;

export interface PipelineStage {
  id: string;
  stage_key: string;
  label: string;
  position: number;
  win_probability_pct: number;
  forecast_category: ForecastCategory;
  match_names: string[];
}

export interface PipelineDeal {
  id: string;
  title: string;
  amount: number | null;
  currency: string | null;
  status: 'open' | 'won' | 'lost';
  stage: string | null;
  close_date: string | null; // YYYY-MM-DD
  discount_pct: number;
  updated_at: string;
}

export interface DealDeskSettings {
  enabled: boolean;
  auto_approve_max_pct: number;
  manager_max_pct: number;
}

export interface DiscountRequest {
  id: string;
  deal_id: string;
  requested_pct: number;
  reason: string;
  required_level: ApprovalLevel;
  status: RequestStatus;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

// ---- stage matching ---------------------------------------------------------

export const normalizeName = (s: string | null | undefined): string => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Finds the configured stage for a deal's free-text stage (key, label or any `match_names` entry; case-insensitive). */
export function resolveStage(dealStage: string | null | undefined, stages: readonly PipelineStage[]): PipelineStage | null {
  const n = normalizeName(dealStage);
  if (!n) return null;
  for (const s of stages) {
    if (normalizeName(s.stage_key) === n || normalizeName(s.label) === n || s.match_names.some((m) => normalizeName(m) === n)) return s;
  }
  return null;
}

// ---- deal desk rules (mirror of the database) -------------------------------

/** Which approval a discount needs. Mirrors crm_discount_request_before_insert(). */
export function requiredApprovalLevel(pct: number, s: Pick<DealDeskSettings, 'auto_approve_max_pct' | 'manager_max_pct'>): ApprovalLevel {
  if (pct <= s.auto_approve_max_pct) return 'auto';
  return pct <= s.manager_max_pct ? 'manager' : 'owner';
}

export type DraftErrors = Partial<Record<'pct' | 'reason' | 'note', 'required' | 'invalid' | 'range' | 'too_short' | 'too_long'>>;

/** Accepts "12", "12.5", "12,5" (max 2 decimals), 0 < pct <= 100. Returns NaN for junk, null for blank. */
export function parsePct(input: string): number | null {
  const t = input.trim().replace(',', '.');
  if (!t) return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return Number.NaN;
  return Number(t);
}

export function validateDiscountDraft(pctInput: string, reason: string):
  { ok: true; pct: number; reason: string } | { ok: false; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const pct = parsePct(pctInput);
  if (pct === null) errors.pct = 'required';
  else if (Number.isNaN(pct)) errors.pct = 'invalid';
  else if (pct <= 0 || pct > 100) errors.pct = 'range';
  const r = reason.trim();
  if (!r) errors.reason = 'required';
  else if (r.length < LIMITS.reasonMin) errors.reason = 'too_short';
  else if (r.length > LIMITS.reasonMax) errors.reason = 'too_long';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, pct: pct as number, reason: r };
}

export interface DeciderContext { userId: string | null; isOwner: boolean; canManage: boolean }

/** UI hint only (the trigger is the authority). Mirrors crm_discount_request_guard(). */
export function canDecide(req: Pick<DiscountRequest, 'status' | 'required_level' | 'requested_by'>, ctx: DeciderContext): boolean {
  if (req.status !== 'pending' || !ctx.userId) return false;
  if (req.required_level === 'owner') return ctx.isOwner;
  if (!ctx.canManage) return false;
  return req.requested_by !== ctx.userId || ctx.isOwner;
}

export function canWithdraw(req: Pick<DiscountRequest, 'status' | 'requested_by'>, ctx: DeciderContext): boolean {
  return req.status === 'pending' && !!ctx.userId && (req.requested_by === ctx.userId || ctx.isOwner);
}

/** Highest approved percentage for a deal: the ceiling the database lets a user apply. */
export function approvedCeiling(dealId: string, requests: readonly DiscountRequest[], settings: Pick<DealDeskSettings, 'auto_approve_max_pct'>): number {
  let max = settings.auto_approve_max_pct;
  for (const r of requests) if (r.deal_id === dealId && r.status === 'approved' && r.requested_pct > max) max = r.requested_pct;
  return max;
}

// ---- forecast ----------------------------------------------------------------

export const toCents = (amount: number): number => Math.round(amount * 100);

export interface CategoryTotals { count: number; amountCents: number; weightedCents: number }
export interface StageTotals extends CategoryTotals { stage: PipelineStage }
export interface MonthTotals { month: string; commit: number; best_case: number; pipeline: number; weightedCents: number; count: number }

export interface Forecast {
  currency: string | null;
  open: CategoryTotals;
  byCategory: Record<Exclude<ForecastCategory, 'omitted'>, CategoryTotals>;
  byStage: StageTotals[];
  byMonth: MonthTotals[];
  overdue: CategoryTotals;
  noCloseDate: CategoryTotals;
  later: CategoryTotals;
  /** Open deals left out of every total, with the reason. Shown in the UI; never silently dropped. */
  excluded: { unmappedStage: number; omittedStage: number; noAmount: number; otherCurrency: number };
}

const empty = (): CategoryTotals => ({ count: 0, amountCents: 0, weightedCents: 0 });
const add = (t: CategoryTotals, cents: number, weighted: number) => { t.count += 1; t.amountCents += cents; t.weightedCents += weighted; };

export function monthKey(date: string): string { return date.slice(0, 7); }

/** Month keys starting at `now`'s month, `count` long (YYYY-MM, UTC). */
export function monthWindow(now: Date, count: number): string[] {
  const out: string[] = [];
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return out;
}

/** Currency with the most open deals; ties break alphabetically. Null when no open deal has a currency. */
export function dominantCurrency(deals: readonly PipelineDeal[]): string | null {
  const counts = new Map<string, number>();
  for (const d of deals) {
    if (d.status !== 'open' || !d.currency) continue;
    const c = d.currency.trim().toUpperCase();
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [c, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) if (n > bestN) { best = c; bestN = n; }
  return best;
}

/**
 * Weighted forecast of OPEN deals in one currency. weighted = amount x stage win probability.
 * Deals whose stage is not configured, whose stage is `omitted`, without amount, or in another currency are excluded
 * and counted in `excluded`. Closed deals (won/lost) never contribute.
 */
export function buildForecast(
  deals: readonly PipelineDeal[],
  stages: readonly PipelineStage[],
  opts: { now: Date; horizonMonths?: number; currency?: string | null },
): Forecast {
  const horizon = Math.min(Math.max(opts.horizonMonths ?? 6, 1), 24);
  const currency = opts.currency === undefined ? dominantCurrency(deals) : opts.currency;
  const window = monthWindow(opts.now, horizon);
  const today = opts.now.toISOString().slice(0, 10);

  const f: Forecast = {
    currency,
    open: empty(),
    byCategory: { pipeline: empty(), best_case: empty(), commit: empty() },
    byStage: [...stages].sort((a, b) => a.position - b.position).map((stage) => ({ stage, ...empty() })),
    byMonth: window.map((month) => ({ month, commit: 0, best_case: 0, pipeline: 0, weightedCents: 0, count: 0 })),
    overdue: empty(), noCloseDate: empty(), later: empty(),
    excluded: { unmappedStage: 0, omittedStage: 0, noAmount: 0, otherCurrency: 0 },
  };
  const stageRow = new Map(f.byStage.map((r) => [r.stage.id, r]));
  const monthRow = new Map(f.byMonth.map((r) => [r.month, r]));

  for (const d of deals) {
    if (d.status !== 'open') continue;
    const stage = resolveStage(d.stage, stages);
    if (!stage) { f.excluded.unmappedStage += 1; continue; }
    if (stage.forecast_category === 'omitted') { f.excluded.omittedStage += 1; continue; }
    if (d.amount === null || !Number.isFinite(d.amount) || d.amount < 0) { f.excluded.noAmount += 1; continue; }
    if ((d.currency ?? '').trim().toUpperCase() !== (currency ?? '')) { f.excluded.otherCurrency += 1; continue; }

    const cents = toCents(d.amount);
    const weighted = Math.round((cents * stage.win_probability_pct) / 100);
    add(f.open, cents, weighted);
    add(f.byCategory[stage.forecast_category], cents, weighted);
    const sr = stageRow.get(stage.id);
    if (sr) add(sr, cents, weighted);

    if (!d.close_date) { add(f.noCloseDate, cents, weighted); continue; }
    if (d.close_date < today) { add(f.overdue, cents, weighted); continue; }
    const row = monthRow.get(monthKey(d.close_date));
    if (!row) { add(f.later, cents, weighted); continue; }
    row[stage.forecast_category] += cents;
    row.weightedCents += weighted;
    row.count += 1;
  }
  return f;
}

// ---- deal desk metrics ---------------------------------------------------------

/** Elapsed weekdays (Mon-Fri, UTC, no holidays) between two instants, as a fraction of a day. */
export function elapsedBusinessDays(from: Date, to: Date): number {
  if (to <= from) return 0;
  let total = 0;
  let cursor = from.getTime();
  const end = to.getTime();
  const DAY = 86_400_000;
  while (cursor < end) {
    const dayStart = Math.floor(cursor / DAY) * DAY;
    const segEnd = Math.min(dayStart + DAY, end);
    const dow = new Date(dayStart).getUTCDay();
    if (dow !== 0 && dow !== 6) total += (segEnd - cursor) / DAY;
    cursor = segEnd;
  }
  return total;
}

/** Nearest-rank percentile (p in 0..100). Null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export interface DealDeskMetrics {
  pending: number;
  oldestPendingBusinessDays: number | null;
  /** Manager/owner decisions only (auto-approved rows are not a human decision). */
  decided: number;
  decisionP50BusinessDays: number | null;
  decisionP90BusinessDays: number | null;
  autoApproved: number;
}

export function dealDeskMetrics(requests: readonly DiscountRequest[], now: Date): DealDeskMetrics {
  const pendingAges: number[] = [];
  const latencies: number[] = [];
  let autoApproved = 0;
  for (const r of requests) {
    if (r.status === 'pending') pendingAges.push(elapsedBusinessDays(new Date(r.created_at), now));
    else if (r.required_level === 'auto' && r.status === 'approved') autoApproved += 1;
    else if ((r.status === 'approved' || r.status === 'rejected') && r.decided_at) {
      latencies.push(elapsedBusinessDays(new Date(r.created_at), new Date(r.decided_at)));
    }
  }
  return {
    pending: pendingAges.length,
    oldestPendingBusinessDays: pendingAges.length ? Math.max(...pendingAges) : null,
    decided: latencies.length,
    decisionP50BusinessDays: percentile(latencies, 50),
    decisionP90BusinessDays: percentile(latencies, 90),
    autoApproved,
  };
}

/** Settings are valid when 0 <= auto <= manager <= 100 (mirrors the table constraints). */
export function validateThresholds(auto: number, manager: number): 'ok' | 'range' | 'order' {
  if (![auto, manager].every((n) => Number.isFinite(n) && n >= 0 && n <= 100)) return 'range';
  return manager >= auto ? 'ok' : 'order';
}

// ---- form parsing helpers ------------------------------------------------------

/** Money input: "1200", "1,200.50" (max 2 decimals). null = blank, NaN = invalid. Amount must be <= 999,999,999,999.99. */
export function parseAmount(input: string): number | null {
  const t = input.trim().replace(/,/g, '');
  if (!t) return null;
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(t)) return Number.NaN;
  return Number(t);
}

/** Win probability 0..100 (0 allowed), max 2 decimals. null = blank, NaN = invalid. */
export function parseProbability(input: string): number | null {
  const t = input.trim().replace(',', '.');
  if (!t) return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return Number.NaN;
  const n = Number(t);
  return n > 100 ? Number.NaN : n;
}

/** Comma-separated CRM stage names: trimmed, blanks dropped, case-insensitive de-duplication, max 20 names of <= 80 chars. */
export function parseMatchNames(input: string): { ok: true; names: string[] } | { ok: false; error: 'too_many' | 'too_long' } {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of input.split(',')) {
    const v = raw.trim().replace(/\s+/g, ' ');
    if (!v) continue;
    if (v.length > 80) return { ok: false, error: 'too_long' };
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    names.push(v);
  }
  if (names.length > LIMITS.matchNamesMax) return { ok: false, error: 'too_many' };
  return { ok: true, names };
}

export const isCurrencyCode = (s: string): boolean => /^[A-Za-z]{3}$/.test(s.trim());
