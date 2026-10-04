/**
 * Business Forecast engine — Revenue, Gross Profit, Capacity and Cash for 7 / 30 / 90 days,
 * each with an honest confidence rating.
 *
 * Pure functions only (no React, no Supabase) so every number is unit-testable.
 * All money here is in dollars. All dates are handled on UTC day boundaries.
 *
 * Method (one shared "expected job revenue" series feeds all four forecasts):
 *   booked    = scheduled/en-route/in-progress jobs x smoothed completion rate
 *   pipeline  = open (sent, unexpired) quotes x smoothed win rate, landing PIPELINE_LAG_DAYS out
 *   run-rate  = recency-weighted trailing-12-week average; expected job revenue is
 *               max(booked + pipeline, run-rate x days) so a thin booking book never
 *               under-forecasts a business that normally books same-day work
 *   recurring = active auto-renew memberships on their real renewal dates
 *   range     = 80% band from trailing weekly volatility, widened with sqrt(weeks)
 */

export const FORECAST_HORIZONS = [7, 30, 90] as const;
export type ForecastHorizon = (typeof FORECAST_HORIZONS)[number];
export type ForecastKind = 'revenue' | 'gross_profit' | 'capacity' | 'cash';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export const FORECAST_KIND_LABELS: Record<ForecastKind, string> = {
  revenue: 'Revenue',
  gross_profit: 'Gross profit',
  capacity: 'Capacity',
  cash: 'Cash',
};

// ---------- Inputs ----------

export interface ForecastJob {
  id: string;
  invoice_amount: number | null;
  invoice_status: string | null;
  job_status: string;
  scheduled_datetime: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ForecastPayment {
  amount: number;
  status: string;
  job_id: string | null;
  created_at: string;
  paid_at: string | null;
}

export interface ForecastMembership {
  status: string;
  auto_renew: boolean;
  current_period_end: string | null;
  price_cents: number;
  interval: 'monthly' | 'yearly';
}

export interface ForecastQuote {
  status: string;
  total: number;
  valid_until: string | null;
}

export interface ForecastFixedExpense {
  amount: number;
  frequency: 'one_time' | 'weekly' | 'biweekly' | 'monthly';
  next_due_date: string;
}

export interface ForecastTechnician {
  id: string;
  max_jobs_per_day: number;
}

export interface ForecastProfitRow {
  revenue_cents: number;
  total_cost_cents: number;
}

export interface ForecastInput {
  jobs: ForecastJob[];
  payments: ForecastPayment[];
  memberships: ForecastMembership[];
  quotes: ForecastQuote[];
  expenses: ForecastFixedExpense[];
  technicians: ForecastTechnician[];
  profitability: ForecastProfitRow[];
  settings: {
    startingCash: number;
    defaultCostRatioPct: number;
    quoteWinRatePct: number;
    /** true when the owner has a saved cash-flow settings row */
    configured: boolean;
  };
  /** true when a query hit its row limit, so history may be incomplete */
  truncated?: boolean;
}

// ---------- Outputs ----------

export interface ForecastConfidence {
  level: ConfidenceLevel;
  /** 0–100 */
  score: number;
  /** "High confidence" | "Medium confidence" | "Low confidence — insufficient historical data." */
  label: string;
  /** e.g. "Revenue forecast: High confidence" */
  headline: string;
  reasons: string[];
}

export interface RevenueForecast {
  horizon: ForecastHorizon;
  low: number;
  base: number;
  high: number;
  booked: number;
  pipeline: number;
  recurring: number;
  runRateFill: number;
  confidence: ForecastConfidence;
}

export interface GrossProfitForecast {
  horizon: ForecastHorizon;
  low: number;
  base: number;
  high: number;
  marginPct: number;
  marginSource: 'actual' | 'default';
  confidence: ForecastConfidence;
}

export type CapacityStatus = 'no_capacity_data' | 'underused' | 'healthy' | 'tight' | 'over';

export interface CapacityForecast {
  horizon: ForecastHorizon;
  capacityJobs: number;
  demandLow: number;
  demandBase: number;
  demandHigh: number;
  utilizationPct: number;
  status: CapacityStatus;
  peakDay: { date: string; booked: number; capacity: number } | null;
  overbookedDays: number;
  gapJobs: number;
  techniciansNeeded: number;
  revenueAtRisk: number;
  confidence: ForecastConfidence;
}

export type CashRisk = 'safe' | 'watch' | 'critical';

export interface CashForecast {
  horizon: ForecastHorizon;
  startingBalance: number;
  inflows: number;
  outflows: number;
  endingLow: number;
  endingBase: number;
  endingHigh: number;
  minBalance: number;
  minBalanceDate: string;
  minBalanceLow: number;
  risk: CashRisk;
  confidence: ForecastConfidence;
}

export interface ForecastMeta {
  completedJobs90: number;
  activeWeeks: number;
  weeklyRevenueAvg: number;
  volatilityPct: number;
  avgTicket: number;
  completionRatePct: number;
  winRatePct: number;
  collectionRatePct: number;
  daysToPay: number;
  workingDays: number[];
}

export interface BusinessForecast {
  generatedAt: string;
  revenue: Record<ForecastHorizon, RevenueForecast>;
  grossProfit: Record<ForecastHorizon, GrossProfitForecast>;
  capacity: Record<ForecastHorizon, CapacityForecast>;
  cash: Record<ForecastHorizon, CashForecast>;
  meta: ForecastMeta;
}

// ---------- Constants (documented assumptions) ----------

const DAY = 86_400_000;
const MAX_DAYS = 90;
const HISTORY_WEEKS = 12;
const Z80 = 1.2816;
const PIPELINE_LAG_DAYS = 8;
const OVERDUE_COLLECTION_FACTOR = 0.6;
const OVERDUE_LANDING_DAY = 3;
const ACTIVE_JOB = new Set(['scheduled', 'en_route', 'in_progress']);

// ---------- Small helpers ----------

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function dayIndex(iso: string | null | undefined, today: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isFinite(t) ? Math.floor((t - today) / DAY) : null;
}

function isoDay(today: number, offset: number): string {
  return new Date(today + offset * DAY).toISOString().slice(0, 10);
}

/** Add months without day overflow (Jan 31 + 1 month = Feb 28/29, never Mar 3). */
function addMonthsClamped(ms: number, months: number): number {
  const d = new Date(ms);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), dim));
}

/** Every day-offset in [0, MAX_DAYS) on which a recurring item lands. Past occurrences are skipped. */
function recurringOffsets(
  anchorMs: number,
  step: { days: number } | { months: number },
  today: number,
): number[] {
  const out: number[] = [];
  for (let n = 0; n < 400; n++) {
    const at = 'days' in step ? anchorMs + n * step.days * DAY : addMonthsClamped(anchorMs, n * step.months);
    const idx = Math.floor((at - today) / DAY);
    if (idx >= MAX_DAYS) break;
    if (idx >= 0) out.push(idx);
  }
  return out;
}

/** Best-effort dollar total of a quote's jsonb line items (unit_price_cents first, legacy keys as fallback). */
export function quoteTotalDollars(items: unknown, taxPercent = 0): number {
  if (!Array.isArray(items)) return 0;
  let sub = 0;
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const it = raw as Record<string, unknown>;
    const qty = Number(it.quantity ?? 1);
    const q = Number.isFinite(qty) && qty > 0 ? qty : 1;
    if (typeof it.unit_price_cents === 'number') sub += (it.unit_price_cents / 100) * q;
    else if (typeof it.total === 'number') sub += it.total;
    else if (typeof it.amount === 'number') sub += it.amount;
    else {
      const unit = Number(it.unit_price ?? it.price ?? it.rate);
      if (Number.isFinite(unit)) sub += unit * q;
    }
  }
  return round2(sub * (1 + Math.max(0, taxPercent) / 100));
}

/** Beta-style shrinkage: pull a small-sample rate toward a prior. */
function smoothRate(success: number, total: number, prior: number, strength = 10): number {
  return (success + prior * strength) / (total + strength);
}

// ---------- Confidence ----------

interface ConfidenceInput {
  kind: ForecastKind;
  horizon: ForecastHorizon;
  completedJobs: number;
  activeWeeks: number;
  cv: number;
  /** share of the forecast already backed by booked work / contracts, 0–1 */
  coverage: number;
  /** 0–10 data-quality points specific to this forecast */
  dataQuality: number;
  /** hard-cap the level when a critical input is missing */
  capAtMedium?: boolean;
  /** if set, forces Low with this reason */
  forceLow?: string;
  truncated?: boolean;
  extraReasons?: string[];
}

function buildConfidence(i: ConfidenceInput): ForecastConfidence {
  const history = 50 * (0.5 * Math.min(1, i.completedJobs / 40) + 0.5 * Math.min(1, i.activeWeeks / 10));
  const stability = 25 * (1 - clamp((i.cv - 0.2) / 0.6, 0, 1));
  const coverage = 15 * Math.min(1, i.coverage / 0.6);
  let score = history + stability + coverage + clamp(i.dataQuality, 0, 10);
  if (i.truncated) score -= 10;
  score = Math.round(clamp(score, 0, 100));

  const insufficient = i.completedJobs < 10 || i.activeWeeks < 3;
  const highBar = i.horizon === 7 ? 70 : i.horizon === 30 ? 75 : 80;

  let level: ConfidenceLevel = score >= highBar ? 'high' : score >= 45 ? 'medium' : 'low';
  if (i.capAtMedium && level === 'high') level = 'medium';
  let lowReason: string | null = null;
  if (i.forceLow) {
    level = 'low';
    lowReason = i.forceLow;
  } else if (insufficient) {
    level = 'low';
    lowReason = 'insufficient historical data';
  } else if (level === 'low') {
    lowReason = i.cv > 0.6 ? 'highly volatile demand' : 'limited supporting data';
  }

  const reasons: string[] = [
    `${i.completedJobs} completed jobs across ${i.activeWeeks} of the last ${HISTORY_WEEKS} weeks`,
    i.cv <= 0.25
      ? `Weekly results are stable (±${Math.round(i.cv * 100)}%)`
      : `Weekly results swing by ±${Math.round(i.cv * 100)}%`,
    `Booked work and contracts back ${Math.round(clamp(i.coverage, 0, 1) * 100)}% of this ${i.horizon}-day forecast`,
    ...(i.extraReasons ?? []),
  ];
  if (i.truncated) reasons.push('History was truncated at the query limit');

  const label =
    level === 'low'
      ? `Low confidence — ${lowReason ?? 'limited supporting data'}.`
      : level === 'high'
        ? 'High confidence'
        : 'Medium confidence';
  return { level, score, label, headline: `${FORECAST_KIND_LABELS[i.kind]} forecast: ${label}`, reasons };
}

// ---------- Engine ----------

export function buildBusinessForecast(input: ForecastInput, now: Date = new Date()): BusinessForecast {
  const today = startOfUtcDay(now);
  const { settings } = input;

  // ----- History: completed jobs in the trailing 12 weeks -----
  const weeklyRevenue = new Array<number>(HISTORY_WEEKS).fill(0);
  const weeklyJobs = new Array<number>(HISTORY_WEEKS).fill(0);
  const weekdayDates: Set<string>[] = Array.from({ length: 7 }, () => new Set<string>());
  let completedJobs90 = 0;
  let priced = 0;
  let pricedSum = 0;
  let decidedJobs = 0;
  let completedDecided = 0;

  for (const j of input.jobs) {
    const when = dayIndex(j.completed_at ?? j.scheduled_datetime ?? j.created_at, today);
    const sched = dayIndex(j.scheduled_datetime, today);
    if (sched !== null && sched < 0 && sched >= -90 && j.job_status !== 'cancelled') {
      weekdayDates[new Date(today + sched * DAY).getUTCDay()].add(isoDay(today, sched));
    }
    if (sched !== null && sched < 0 && sched >= -90) {
      if (j.job_status === 'completed') { decidedJobs++; completedDecided++; }
      else if (j.job_status === 'cancelled' || j.job_status === 'no_show') decidedJobs++;
    }
    if (j.job_status !== 'completed' || when === null || when >= 0 || when < -(HISTORY_WEEKS * 7)) continue;
    const age = Math.floor((-when - 1) / 7);
    weeklyJobs[age] += 1;
    completedJobs90 += 1;
    const amt = num(j.invoice_amount);
    if (amt > 0) {
      weeklyRevenue[age] += amt;
      priced += 1;
      pricedSum += amt;
    }
  }

  const activeWeeks = weeklyJobs.filter((n) => n > 0).length;
  let oldestActive = -1;
  weeklyJobs.forEach((n, age) => { if (n > 0) oldestActive = Math.max(oldestActive, age); });
  const observedWeeks = oldestActive + 1;
  const avgTicket = priced > 0 ? pricedSum / priced : 0;

  const weightedMean = (arr: number[]) => {
    if (observedWeeks === 0) return 0;
    let w = 0, s = 0;
    for (let age = 0; age < observedWeeks; age++) {
      const wt = observedWeeks - age;
      w += wt;
      s += arr[age] * wt;
    }
    return s / w;
  };
  const weeklyRevMean = weightedMean(weeklyRevenue);
  const weeklyJobsMean = weightedMean(weeklyJobs);
  const revSlice = weeklyRevenue.slice(0, observedWeeks);
  const plainMean = observedWeeks ? revSlice.reduce((a, b) => a + b, 0) / observedWeeks : 0;
  const std = observedWeeks > 1
    ? Math.sqrt(revSlice.reduce((a, b) => a + (b - plainMean) ** 2, 0) / (observedWeeks - 1))
    : 0;
  const cv = observedWeeks >= 4 && plainMean > 0 ? clamp(std / plainMean, 0.05, 1.5) : 0.5;
  const sigmaWeekly = cv * weeklyRevMean;
  const sigmaJobsWeekly = cv * weeklyJobsMean;
  const runRateDaily = weeklyRevMean / 7;
  const runRateJobsDaily = weeklyJobsMean / 7;

  const completionRate = smoothRate(completedDecided, decidedJobs, 0.9);

  // ----- Working weekdays (a weekday counts when jobs ran on >= 3 distinct dates in 90 days) -----
  let workingDays = weekdayDates.map((s, d) => (s.size >= 3 ? d : -1)).filter((d) => d >= 0);
  if (workingDays.length < 2) workingDays = [1, 2, 3, 4, 5];
  const isWorkingDay = (offset: number) => workingDays.includes(new Date(today + offset * DAY).getUTCDay());

  // ----- Collections -----
  const paidDays: number[] = [];
  let paidN = 0, lostN = 0;
  for (const p of input.payments) {
    if (p.status === 'paid' && p.paid_at) {
      paidN++;
      const a = Date.parse(p.created_at), b = Date.parse(p.paid_at);
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) paidDays.push((b - a) / DAY);
    } else if (p.status === 'failed') lostN++;
    else if (p.status === 'overdue') {
      const age = dayIndex(p.created_at, today);
      if (age !== null && age < -30) lostN++;
    }
  }
  paidDays.sort((a, b) => a - b);
  const daysToPay = paidDays.length >= 5 ? Math.round(clamp(paidDays[Math.floor(paidDays.length / 2)], 0, 45)) : 7;
  const collectionRate = smoothRate(paidN, paidN + lostN, 0.92);

  // ----- Quotes (pipeline) -----
  let accepted = 0, lost = 0;
  const openQuotes: number[] = [];
  for (const q of input.quotes) {
    if (q.status === 'accepted') accepted++;
    else if (q.status === 'declined' || q.status === 'expired') lost++;
    else if (q.status === 'sent' && q.total > 0) {
      const vi = dayIndex(q.valid_until, today);
      if (vi === null || vi >= 0) openQuotes.push(q.total);
    }
  }
  const winRate = smoothRate(accepted, accepted + lost, clamp(settings.quoteWinRatePct / 100, 0, 1));
  const pipelineValue = openQuotes.reduce((a, b) => a + b, 0) * winRate;
  const pipelineJobs = openQuotes.length * winRate;

  // ----- Booked work (next 90 days) -----
  const bookedRev = new Array<number>(MAX_DAYS).fill(0);
  const bookedCount = new Array<number>(MAX_DAYS).fill(0);
  let bookedTotalJobs = 0, bookedUnpriced = 0;
  for (const j of input.jobs) {
    if (!ACTIVE_JOB.has(j.job_status)) continue;
    const idx = dayIndex(j.scheduled_datetime, today);
    if (idx === null || idx < 0 || idx >= MAX_DAYS) continue;
    const amt = num(j.invoice_amount);
    bookedCount[idx] += 1;
    bookedTotalJobs += 1;
    if (amt > 0) bookedRev[idx] += amt * completionRate;
    else { bookedRev[idx] += avgTicket * completionRate; bookedUnpriced += 1; }
  }
  const unpricedShare = bookedTotalJobs ? bookedUnpriced / bookedTotalJobs : 0;

  // ----- Recurring membership billings -----
  const recurringRev = new Array<number>(MAX_DAYS).fill(0);
  for (const m of input.memberships) {
    if (m.status !== 'active' || !m.auto_renew || m.price_cents <= 0) continue;
    const end = dayIndex(m.current_period_end, today);
    if (end === null) continue;
    const anchor = today + end * DAY;
    const step = m.interval === 'yearly' ? { months: 12 } : { months: 1 };
    for (const off of recurringOffsets(anchor, step, today)) recurringRev[off] += m.price_cents / 100;
  }

  // ----- Margin -----
  const rows = input.profitability.filter((r) => num(r.revenue_cents) > 0);
  const rowRev = rows.reduce((a, r) => a + r.revenue_cents, 0);
  const rowCost = rows.reduce((a, r) => a + num(r.total_cost_cents), 0);
  const marginSource: 'actual' | 'default' = rows.length >= 5 && rowRev > 0 ? 'actual' : 'default';
  const margin = marginSource === 'actual'
    ? clamp(1 - rowCost / rowRev, -0.5, 0.95)
    : clamp(1 - settings.defaultCostRatioPct / 100, -0.5, 0.95);
  let marginSE = 0.1;
  if (marginSource === 'actual') {
    const ms = rows.map((r) => 1 - num(r.total_cost_cents) / r.revenue_cents);
    const mm = ms.reduce((a, b) => a + b, 0) / ms.length;
    const sd = Math.sqrt(ms.reduce((a, b) => a + (b - mm) ** 2, 0) / Math.max(1, ms.length - 1));
    marginSE = Math.max(0.02, sd / Math.sqrt(ms.length));
  }

  // ----- Shared per-horizon expected job revenue -----
  const sum = (arr: number[], h: number) => arr.slice(0, h).reduce((a, b) => a + b, 0);
  const pipelineLanding = (h: number) => (PIPELINE_LAG_DAYS < h ? pipelineValue : 0);
  const pipelineJobsIn = (h: number) => (PIPELINE_LAG_DAYS < h ? pipelineJobs : 0);

  const jobTargets = (h: ForecastHorizon) => {
    const weeks = h / 7;
    const booked = sum(bookedRev, h);
    const pipeline = pipelineLanding(h);
    const base = Math.max(booked + pipeline, runRateDaily * h);
    const unbookedShare = base > 0 ? (base - booked - pipeline) / base : 1;
    const sigma = sigmaWeekly * Math.sqrt(weeks) * (0.4 + 0.6 * clamp(unbookedShare, 0, 1));
    return {
      booked,
      pipeline,
      base,
      low: Math.max(booked, base - Z80 * sigma),
      high: base + Z80 * sigma,
    };
  };

  // ----- Confidence shared inputs -----
  const conf = (
    kind: ForecastKind,
    horizon: ForecastHorizon,
    coverage: number,
    dataQuality: number,
    extra: Partial<ConfidenceInput> = {},
  ) =>
    buildConfidence({
      kind, horizon, coverage, dataQuality,
      completedJobs: completedJobs90, activeWeeks, cv,
      truncated: input.truncated,
      ...extra,
    });

  const revenue = {} as Record<ForecastHorizon, RevenueForecast>;
  const grossProfit = {} as Record<ForecastHorizon, GrossProfitForecast>;
  const capacity = {} as Record<ForecastHorizon, CapacityForecast>;
  const cash = {} as Record<ForecastHorizon, CashForecast>;

  // ----- Capacity setup -----
  const techs = input.technicians.filter((t) => num(t.max_jobs_per_day) > 0);
  const dailyCapacity = techs.reduce((a, t) => a + t.max_jobs_per_day, 0);
  const avgMaxJobs = techs.length ? dailyCapacity / techs.length : 0;

  // ----- Open receivables (already earned, not yet paid) -----
  const receivableByDay = new Array<number>(MAX_DAYS).fill(0);
  const paymentJobIds = new Set<string>();
  const landReceivable = (amount: number, dueIdx: number, overdue: boolean) => {
    if (amount <= 0) return;
    const day = overdue || dueIdx < 0 ? OVERDUE_LANDING_DAY : dueIdx;
    if (day >= MAX_DAYS) return;
    const prob = overdue || dueIdx < 0 ? collectionRate * OVERDUE_COLLECTION_FACTOR : collectionRate;
    receivableByDay[day] += amount * prob;
  };
  for (const p of input.payments) {
    if (!['pending', 'sent', 'overdue'].includes(p.status)) continue;
    if (p.job_id) paymentJobIds.add(p.job_id);
    const created = dayIndex(p.created_at, today) ?? 0;
    landReceivable(num(p.amount), created + daysToPay, p.status === 'overdue');
  }
  for (const j of input.jobs) {
    if (j.job_status !== 'completed' || j.invoice_status === 'paid' || paymentJobIds.has(j.id)) continue;
    const amt = num(j.invoice_amount);
    const done = dayIndex(j.completed_at ?? j.scheduled_datetime ?? j.created_at, today);
    if (amt <= 0 || done === null || done < -120) continue;
    const lag = j.invoice_status === 'sent' ? daysToPay : daysToPay + 1;
    landReceivable(amt, done + lag, false);
  }

  // ----- Fixed expenses per day -----
  const fixedByDay = new Array<number>(MAX_DAYS).fill(0);
  for (const e of input.expenses) {
    const anchorIdx = dayIndex(e.next_due_date, today);
    if (anchorIdx === null || e.amount <= 0) continue;
    const anchor = today + anchorIdx * DAY;
    if (e.frequency === 'one_time') {
      if (anchorIdx < MAX_DAYS) fixedByDay[Math.max(0, anchorIdx)] += e.amount;
      continue;
    }
    const step = e.frequency === 'weekly' ? { days: 7 } : e.frequency === 'biweekly' ? { days: 14 } : { months: 1 };
    for (const off of recurringOffsets(anchor, step, today)) fixedByDay[off] += e.amount;
  }

  const cashSimulate = (h: ForecastHorizon, jobTarget: number) => {
    const t = jobTargets(h);
    const pipelineDay = PIPELINE_LAG_DAYS < h ? PIPELINE_LAG_DAYS : -1;
    const fillPerDay = Math.max(0, jobTarget - t.booked - t.pipeline) / h;
    const inflow = new Array<number>(h).fill(0);
    const outflow = new Array<number>(h).fill(0);
    const addRevenue = (day: number, rev: number, collected: boolean) => {
      outflow[day] += rev * (1 - margin);
      const landing = day + (collected ? daysToPay : 0);
      if (landing < h) inflow[landing] += rev * collectionRate;
    };
    for (let d = 0; d < h; d++) {
      addRevenue(d, bookedRev[d] + fillPerDay, true);
      if (d === pipelineDay) addRevenue(d, pipelineValue, true);
      if (recurringRev[d] > 0) { inflow[d] += recurringRev[d] * collectionRate; outflow[d] += recurringRev[d] * (1 - margin); }
      inflow[d] += receivableByDay[d];
      outflow[d] += fixedByDay[d];
    }
    let bal = settings.startingCash, min = bal, minDay = 0, totalIn = 0, totalOut = 0;
    for (let d = 0; d < h; d++) {
      bal += inflow[d] - outflow[d];
      totalIn += inflow[d];
      totalOut += outflow[d];
      if (bal < min) { min = bal; minDay = d; }
    }
    return { ending: bal, min, minDay, totalIn, totalOut };
  };

  for (const h of FORECAST_HORIZONS) {
    const t = jobTargets(h);
    const recurring = sum(recurringRev, h);
    const fill = Math.max(0, t.base - t.booked - t.pipeline);
    const revBase = t.base + recurring;
    const revLow = t.low + recurring;
    const revHigh = t.high + recurring;
    const coverage = revBase > 0 ? (t.booked + recurring) / revBase : 0;

    revenue[h] = {
      horizon: h,
      low: round2(revLow), base: round2(revBase), high: round2(revHigh),
      booked: round2(t.booked), pipeline: round2(t.pipeline), recurring: round2(recurring), runRateFill: round2(fill),
      confidence: conf('revenue', h, coverage, 10 * (1 - unpricedShare), {
        extraReasons: unpricedShare > 0.2 ? [`${Math.round(unpricedShare * 100)}% of booked jobs have no price yet`] : [],
      }),
    };

    const mq = rows.length >= 20 ? 10 : rows.length >= 5 ? 6 : 0;
    grossProfit[h] = {
      horizon: h,
      low: round2(revLow * (margin - Z80 * marginSE)),
      base: round2(revBase * margin),
      high: round2(revHigh * (margin + Z80 * marginSE)),
      marginPct: round2(margin * 100),
      marginSource,
      confidence: conf('gross_profit', h, coverage, mq, {
        capAtMedium: marginSource === 'default',
        extraReasons: [
          marginSource === 'actual'
            ? `Margin measured from ${rows.length} costed jobs`
            : 'Margin uses your default cost ratio — no costed jobs yet',
        ],
      }),
    };

    // Capacity
    let capacityJobs = 0, overbooked = 0, workDays = 0;
    let peak: { idx: number; booked: number } | null = null;
    for (let d = 0; d < h; d++) {
      if (!isWorkingDay(d)) continue;
      workDays++;
      capacityJobs += dailyCapacity;
      if (bookedCount[d] > dailyCapacity) overbooked++;
      if (!peak || bookedCount[d] > peak.booked) peak = { idx: d, booked: bookedCount[d] };
    }
    const bookedJobsH = bookedCount.slice(0, h).reduce((a, b) => a + b, 0);
    const demandBase = Math.max(bookedJobsH + pipelineJobsIn(h), runRateJobsDaily * h);
    const unbookedShareJobs = demandBase > 0 ? (demandBase - bookedJobsH - pipelineJobsIn(h)) / demandBase : 1;
    const sigmaJobs = sigmaJobsWeekly * Math.sqrt(h / 7) * (0.4 + 0.6 * clamp(unbookedShareJobs, 0, 1));
    const demandLow = Math.max(bookedJobsH, demandBase - Z80 * sigmaJobs);
    const demandHigh = demandBase + Z80 * sigmaJobs;
    const util = capacityJobs > 0 ? (demandBase / capacityJobs) * 100 : 0;
    const gap = Math.max(0, demandBase - capacityJobs);
    const status: CapacityStatus =
      capacityJobs === 0 ? 'no_capacity_data' : util > 100 ? 'over' : util >= 85 ? 'tight' : util >= 50 ? 'healthy' : 'underused';

    capacity[h] = {
      horizon: h,
      capacityJobs: Math.round(capacityJobs),
      demandLow: Math.round(demandLow), demandBase: Math.round(demandBase), demandHigh: Math.round(demandHigh),
      utilizationPct: Math.round(util),
      status,
      peakDay: peak && dailyCapacity > 0 ? { date: isoDay(today, peak.idx), booked: peak.booked, capacity: dailyCapacity } : null,
      overbookedDays: overbooked,
      gapJobs: Math.ceil(gap),
      techniciansNeeded: gap > 0 && avgMaxJobs > 0 && workDays > 0 ? Math.ceil(gap / (avgMaxJobs * workDays)) : 0,
      revenueAtRisk: round2(Math.ceil(gap) * avgTicket),
      confidence: conf('capacity', h, demandBase > 0 ? (bookedJobsH + pipelineJobsIn(h)) / demandBase : 0, techs.length > 0 ? 10 : 0, {
        forceLow: techs.length === 0 ? 'no dispatch-enabled technicians configured' : undefined,
        extraReasons: techs.length ? [`${techs.length} technician${techs.length === 1 ? '' : 's'} · ${dailyCapacity} jobs/day`] : [],
      }),
    };

    // Cash
    const base = cashSimulate(h, t.base);
    // Costs are paid when work happens but cash lands ~daysToPay later, so more revenue can
    // temporarily mean LESS cash. Low/high are therefore the worst/best of the three scenarios.
    const scenarios = [base, cashSimulate(h, t.low), cashSimulate(h, t.high)];
    const low = { ending: Math.min(...scenarios.map((x) => x.ending)), min: Math.min(...scenarios.map((x) => x.min)) };
    const high = { ending: Math.max(...scenarios.map((x) => x.ending)) };
    const decided = paidN + lostN;
    const cq = (settings.configured ? 5 : 0) + (input.expenses.length > 0 ? 3 : 0) + (decided >= 10 ? 2 : 0);
    cash[h] = {
      horizon: h,
      startingBalance: round2(settings.startingCash),
      inflows: round2(base.totalIn),
      outflows: round2(base.totalOut),
      endingLow: round2(low.ending), endingBase: round2(base.ending), endingHigh: round2(high.ending),
      minBalance: round2(base.min),
      minBalanceDate: isoDay(today, base.minDay),
      minBalanceLow: round2(low.min),
      risk: base.min < 0 ? 'critical' : low.min < 0 ? 'watch' : 'safe',
      confidence: conf('cash', h, coverage, cq, {
        capAtMedium: !settings.configured || input.expenses.length === 0,
        extraReasons: [
          ...(settings.configured ? [] : ['Opening cash balance has not been set']),
          ...(input.expenses.length === 0 ? ['No fixed expenses entered — outflows may be understated'] : []),
          `Customers pay in ~${daysToPay} days, ${Math.round(collectionRate * 100)}% collected`,
        ],
      }),
    };
  }

  return {
    generatedAt: now.toISOString(),
    revenue, grossProfit, capacity, cash,
    meta: {
      completedJobs90,
      activeWeeks,
      weeklyRevenueAvg: round2(weeklyRevMean),
      volatilityPct: Math.round(cv * 100),
      avgTicket: round2(avgTicket),
      completionRatePct: Math.round(completionRate * 100),
      winRatePct: Math.round(winRate * 100),
      collectionRatePct: Math.round(collectionRate * 100),
      daysToPay,
      workingDays,
    },
  };
}
