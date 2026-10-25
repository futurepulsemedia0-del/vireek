/**
 * Vireek Seasonal Revenue Stabilizer — pure engine.
 *
 * No I/O. Takes the aggregated history the `seasonal_stabilizer_history()` RPC returns and produces:
 *   - a 52-week demand forecast per service line (seasonality from the business's own history, a regional
 *     near-term nudge, weather-event volatility, already-booked work as a floor),
 *   - peak / valley windows, a capacity-constrained "without actions" curve and a stability score,
 *   - smoothing actions with revenue + margin impact, margin-guardrail verdicts and measurable windows,
 *   - a membership target that covers fixed costs in the valley and a cash-reserve plan.
 *
 * Deterministic and explainable by design: every number traces to a stated assumption (see `notes`).
 */

export const ENGINE_VERSION = 'seasonal-1.0';
export const HORIZON_WEEKS = 52;
/** Share of a technician's paid hours that is billable on-site time (the rest is travel, admin, shop time). */
export const BILLABLE_SHARE = 0.75;
const DEFAULT_TECH_HOURLY_CENTS = 4500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Confidence = 'high' | 'medium' | 'low';
export type WeekStatus = 'peak' | 'valley' | 'normal';
export type ActionType =
  | 'pre_season_campaign'
  | 'early_booking_incentive'
  | 'membership_push'
  | 'defer_to_valley'
  | 'valley_pricing'
  | 'peak_surge_staffing';
export type ActionStatus = 'proposed' | 'approved' | 'rejected' | 'launched' | 'measured' | 'cancelled';
export type GuardrailStatus = 'not_applicable' | 'within_floor' | 'blocked' | 'overridden';

export interface HistoryWeekRow {
  w: string;
  line: string;
  jobs: number;
  revenue_cents: number;
  minutes: number;
}

export interface StabilizerSettings {
  valley_threshold_pct: number;
  peak_threshold_pct: number;
  max_valley_discount_pct: number;
  incentive_pct: number;
  shift_share_pct: number;
  valley_sunk_labor_pct: number;
  subcontractor_margin_share_pct: number;
  temp_help_cost_multiplier: number;
  overtime_multiplier: number;
  tech_hourly_cost_cents: number | null;
  paid_hours_per_tech_week: number;
  reserve_buffer_weeks: number;
  deferrable_service_lines: string[];
}

export const DEFAULT_SETTINGS: StabilizerSettings = {
  valley_threshold_pct: 85,
  peak_threshold_pct: 115,
  max_valley_discount_pct: 10,
  incentive_pct: 5,
  shift_share_pct: 20,
  valley_sunk_labor_pct: 40,
  subcontractor_margin_share_pct: 30,
  temp_help_cost_multiplier: 1.3,
  overtime_multiplier: 1.5,
  tech_hourly_cost_cents: null,
  paid_hours_per_tech_week: 40,
  reserve_buffer_weeks: 6,
  deferrable_service_lines: [],
};

export interface HistoryPayload {
  timezone: string;
  today: string;
  week_start: string;
  industry: string | null;
  service_area: string | null;
  weekly: HistoryWeekRow[];
  booked_ahead: HistoryWeekRow[];
  line_margin: { line: string; margin_pct: number | null; sample: number }[];
  margin_floor_pct: number;
  default_cost_ratio_pct: number;
  weather_monthly: { m: number; events: number; years: number }[];
  regional: { change_pct: number | null; sample_size: number; label: string } | null;
  tech: { headcount: number; capacity_jobs_per_day: number; avg_hourly_cost_cents: number | null };
  memberships: { active: number; offered: number; mrr_cents: number };
  membership_plans: { id: string; name: string; price_cents: number; billing_interval: 'monthly' | 'yearly' }[];
  fixed_monthly_cents: number;
  cash: { starting_balance_cents: number; default_cost_ratio_pct: number | null } | null;
  cash_snapshot: { created_at: string; weeks: unknown } | null;
  settings: Partial<StabilizerSettings>;
}

export interface ExistingAction {
  action_type: ActionType;
  service_line: string;
  window_start: string;
  window_end: string;
  status: ActionStatus;
}

export interface TwinCalibration {
  /** Learned multiplier for marketing-driven demand (Digital Twin `marketing_spend`). */
  marketing_factor: number;
  /** Learned multiplier for price response (Digital Twin `price_change`). */
  price_factor: number;
}

/** One week's change an action is expected to cause. Dates are Monday week-starts (ISO yyyy-mm-dd). */
export interface Effect {
  w: string;
  line: string;
  revenue_cents: number;
  hours: number;
  extra_hours: number;
  recurring_cents: number;
}

export interface MeasureWindow {
  role: 'target' | 'source' | 'peak' | 'valley';
  start: string;
  end: string;
  expected_baseline_cents: number;
  expected_with_action_cents: number;
}

export interface ProposedAction {
  fingerprint: string;
  action_type: ActionType;
  service_line: string;
  title: string;
  rationale: string;
  window_start: string;
  window_end: string;
  est_revenue_cents: number;
  est_margin_cents: number;
  shifted_revenue_cents: number;
  est_labor_hours: number;
  margin_pct_after: number | null;
  margin_floor_pct: number | null;
  guardrail_status: GuardrailStatus;
  details: Record<string, unknown> & { effects: Effect[] };
  measure_windows: MeasureWindow[];
}

export interface WindowSpan {
  kind: 'peak' | 'valley';
  start_k: number;
  end_k: number;
  start: string;
  end: string;
  weeks: number;
  avg_ratio: number;
}

export interface LineGuardrail {
  margin_pct: number;
  margin_source: 'actual' | 'default';
  margin_floor_pct: number;
  /** Largest discount that keeps the margin at or above the floor. */
  max_discount_for_floor_pct: number;
  /** Discount actually allowed in valleys = min(setting cap, floor cap). */
  allowed_valley_discount_pct: number;
  /** Volume lift per 1% discount needed for a valley discount to break even on margin (null = never). */
  break_even_elasticity: number | null;
}

export interface LineForecast {
  line: string;
  label: string;
  share_pct: number;
  weeks_of_history: number;
  seasonality: 'measured' | 'insufficient_history';
  rel_noise_pct: number;
  avg_job_value_cents: number;
  rev_cents: number[];
  hours: number[];
  windows: WindowSpan[];
  guardrail: LineGuardrail;
}

export interface HorizonWeek {
  k: number;
  w: string;
  month: number;
  demand_revenue_cents: number;
  p10_revenue_cents: number;
  p90_revenue_cents: number;
  demand_load: number;
  booked_revenue_cents: number;
  ratio: number;
  status: WeekStatus;
  weather_risk: boolean;
}

export interface CurveCore {
  weeks: string[];
  demand_revenue_cents: number[];
  demand_hours: number[] | null;
  hours_available: boolean;
  cap_load: number;
  gm_pct: number;
  weekly_fixed_cents: number;
  start_cash_cents: number | null;
}

export interface CurvePoint {
  w: string;
  month: number;
  baseline_revenue_cents: number;
  revenue_cents: number;
  baseline_hours: number | null;
  hours: number | null;
  cap_load: number;
  overloaded: boolean;
  unmet_revenue_cents: number;
  net_cash_cents: number;
  cum_cash_cents: number;
}

export interface StabilityScore {
  score: number;
  cv: number;
  valley_depth: number;
  overload_weeks: number;
}

export interface MembershipPlanTarget {
  id: string;
  name: string;
  monthly_cents: number;
  annual_cents: number;
  additional_needed: number;
  total_target: number;
  mrr_at_target_cents: number;
}

export interface MembershipTarget {
  weekly_fixed_cents: number;
  valley_weeks: number;
  valley_gross_profit_per_week_cents: number;
  weekly_gap_cents: number;
  active_members: number;
  existing_contribution_per_week_cents: number;
  plans: MembershipPlanTarget[];
  note: string | null;
}

export interface CashPlan {
  starting_balance_cents: number | null;
  starting_balance_known: boolean;
  weekly_fixed_cents: number;
  lowest_cum_cash_cents: number;
  lowest_week: string | null;
  first_negative_week: string | null;
  buffer_cents: number;
  reserve_needed_cents: number;
  shortfall_cents: number;
  surplus_weeks_cents: number;
  self_funded: boolean;
  monthly_set_aside_cents: { month: string; cents: number }[];
  compare_13_weeks: { w: string; existing_cents: number; stabilizer_cents: number }[];
}

export interface StabilizerReport {
  engine_version: string;
  generated_for: string;
  status: 'ok' | 'insufficient_data';
  confidence: Confidence;
  notes: string[];
  capacity: { cap_load: number; unit: 'hours' | 'revenue'; source: 'team' | 'assumed' };
  horizon: HorizonWeek[];
  lines: LineForecast[];
  windows: WindowSpan[];
  core: CurveCore;
  stability: StabilityScore;
  stability_with_actions: StabilityScore | null;
  actions: ProposedAction[];
  membership: MembershipTarget | null;
  cash: CashPlan | null;
  headline: {
    peak_weeks: number;
    valley_weeks: number;
    revenue_swing_pct: number;
    annual_revenue_cents: number;
    gross_margin_pct: number;
    actions: number;
    est_revenue_cents: number;
    est_margin_cents: number;
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const parseIso = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
export const addDays = (iso: string, n: number): string => new Date(parseIso(iso) + n * DAY).toISOString().slice(0, 10);
export const diffDays = (a: string, b: string): number => Math.round((parseIso(b) - parseIso(a)) / DAY);
const weekOfYear = (iso: string): number => {
  const d = new Date(parseIso(iso));
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.min(51, Math.floor((d.getTime() - start) / DAY / 7));
};
const monthOf = (iso: string): number => new Date(parseIso(addDays(iso, 3))).getUTCMonth() + 1;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const sum = (a: number[]): number => a.reduce((s, v) => s + v, 0);
const mean = (a: number[]): number => (a.length ? sum(a) / a.length : 0);
const sd = (a: number[]): number => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(sum(a.map((v) => (v - m) ** 2)) / a.length);
};
const r0 = (v: number): number => Math.round(Number.isFinite(v) ? v : 0);
const r1 = (v: number): number => Math.round((Number.isFinite(v) ? v : 0) * 10) / 10;

export const titleCase = (s: string): string =>
  s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ') || 'Other';

// ---------------------------------------------------------------------------
// Margin guardrails (same floor the quote guardrail uses)
// ---------------------------------------------------------------------------

/** Margin % after giving `discountPct` off a price whose current margin is `marginPct`. */
export function marginAfterDiscount(marginPct: number, discountPct: number): number {
  const cost = 1 - marginPct / 100;
  const price = 1 - discountPct / 100;
  if (price <= 0) return -100;
  return (1 - cost / price) * 100;
}

/** Largest discount that still leaves `floorPct` margin. */
export function maxDiscountForFloor(marginPct: number, floorPct: number): number {
  if (marginPct <= floorPct) return 0;
  const cost = 1 - marginPct / 100;
  return clamp(100 * (1 - cost / (1 - floorPct / 100)), 0, 100);
}

export interface GuardrailVerdict {
  applied_pct: number;
  status: GuardrailStatus;
  margin_after_pct: number;
  capped: boolean;
}

export function guardrailFor(marginPct: number, floorPct: number, desiredPct: number): GuardrailVerdict {
  if (desiredPct <= 0) return { applied_pct: 0, status: 'not_applicable', margin_after_pct: marginPct, capped: false };
  const maxAllowed = maxDiscountForFloor(marginPct, floorPct);
  if (desiredPct <= maxAllowed + 1e-9) {
    return { applied_pct: desiredPct, status: 'within_floor', margin_after_pct: marginAfterDiscount(marginPct, desiredPct), capped: false };
  }
  const stepped = Math.floor(maxAllowed * 2 - 1e-9) / 2;
  if (stepped >= 0.5) {
    return { applied_pct: stepped, status: 'within_floor', margin_after_pct: marginAfterDiscount(marginPct, stepped), capped: true };
  }
  return { applied_pct: desiredPct, status: 'blocked', margin_after_pct: marginAfterDiscount(marginPct, desiredPct), capped: false };
}

/** Volume lift (per 1% discount) at which a valley discount stops costing margin; null = never breaks even. */
export function breakEvenElasticity(marginPct: number, discountPct: number, sunkLaborPct: number): number | null {
  const d = discountPct / 100;
  const c = 1 - marginPct / 100;
  const s = sunkLaborPct / 100;
  const denom = 1 - d - c * (1 - s);
  return denom > 0 ? 1 / denom : null;
}

// ---------------------------------------------------------------------------
// Seasonality + level
// ---------------------------------------------------------------------------

interface Seasonality {
  index: number[];
  sigma: number;
  measured: boolean;
}

function seasonality(values: number[], firstWeek: string): Seasonality {
  const n = values.length;
  const flat = (sigma: number): Seasonality => ({ index: new Array<number>(52).fill(1), sigma, measured: false });
  if (n < 52) {
    const m = mean(values);
    return flat(n >= 8 && m > 0 ? clamp(sd(values) / m, 0.08, 0.6) : 0.3);
  }

  const groups = Math.ceil(n / 52);
  const groupMean = new Map<number, number>();
  for (let g = 0; g < groups; g++) {
    const hi = n - g * 52;
    const lo = Math.max(0, hi - 52);
    const slice = values.slice(lo, hi);
    if (slice.length >= 26) groupMean.set(g, mean(slice));
  }

  const num = new Array<number>(52).fill(0);
  const den = new Array<number>(52).fill(0);
  const samples: { b: number; r: number }[] = [];
  const kernel = [0.25, 0.5, 1, 0.5, 0.25];
  for (let i = 0; i < n; i++) {
    const gm = groupMean.get(Math.floor((n - 1 - i) / 52));
    if (!gm || gm <= 0) continue;
    const r = values[i] / gm;
    const b0 = weekOfYear(addDays(firstWeek, i * 7));
    samples.push({ b: b0, r });
    for (let off = -2; off <= 2; off++) {
      const b = (b0 + off + 52) % 52;
      num[b] += kernel[off + 2] * r;
      den[b] += kernel[off + 2];
    }
  }
  if (!samples.length) return flat(0.3);

  let idx = num.map((v, b) => (den[b] > 0 ? v / den[b] : 1));
  const im = mean(idx);
  idx = idx.map((v) => (im > 0 ? v / im : 1));
  if (groupMean.size < 2) idx = idx.map((v) => 1 + (v - 1) * 0.85); // one season observed: shrink toward flat
  const residuals = samples.map(({ b, r }) => r / Math.max(0.05, idx[b]) - 1);
  return { index: idx, sigma: clamp(Math.sqrt(mean(residuals.map((e) => e * e))), 0.05, 0.6), measured: true };
}

function levelOf(values: number[]): number {
  const n = values.length;
  if (!n) return 0;
  const base = mean(n >= 52 ? values.slice(-52) : values);
  if (n >= 65) {
    const recent = mean(values.slice(-13));
    const ago = mean(values.slice(n - 65, n - 52));
    if (ago > 0) {
      const g = clamp(recent / ago, 0.8, 1.25);
      return base * (1 + (g - 1) * 0.5);
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export function detectWindows(
  ratios: number[],
  weeks: string[],
  loPct: number,
  hiPct: number,
  minLen = 2,
): WindowSpan[] {
  const lo = loPct / 100;
  const hi = hiPct / 100;
  const st: WeekStatus[] = ratios.map((r) => (r >= hi ? 'peak' : r <= lo ? 'valley' : 'normal'));
  const runs: { kind: 'peak' | 'valley'; a: number; b: number }[] = [];
  let i = 0;
  while (i < st.length) {
    if (st[i] === 'normal') {
      i++;
      continue;
    }
    const kind = st[i] as 'peak' | 'valley';
    let j = i;
    while (j + 1 < st.length && (st[j + 1] === kind || (st[j + 1] === 'normal' && st[j + 2] === kind))) j++;
    runs.push({ kind, a: i, b: j });
    i = j + 1;
  }
  const out: WindowSpan[] = [];
  for (const run of runs) {
    const slice = ratios.slice(run.a, run.b + 1);
    const avg = mean(slice);
    const len = run.b - run.a + 1;
    const extreme = run.kind === 'peak' ? avg >= 1.25 : avg <= 0.7;
    if (len < minLen && !extreme) continue;
    out.push({
      kind: run.kind,
      start_k: run.a,
      end_k: run.b,
      start: weeks[run.a],
      end: addDays(weeks[run.b], 6),
      weeks: len,
      avg_ratio: Math.round(avg * 100) / 100,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Curve composition (shared by the baseline and the "with actions" view)
// ---------------------------------------------------------------------------

export function buildCurve(core: CurveCore, effects: Effect[]): CurvePoint[] {
  const idx = new Map<string, number>();
  core.weeks.forEach((w, i) => idx.set(w, i));
  const n = core.weeks.length;
  const dRev = [...core.demand_revenue_cents];
  const dHrs = core.demand_hours ? [...core.demand_hours] : null;
  const extra = new Array<number>(n).fill(0);
  const rec = new Array<number>(n).fill(0);
  for (const e of effects) {
    const i = idx.get(e.w);
    if (i === undefined) continue;
    dRev[i] += e.revenue_cents;
    if (dHrs) dHrs[i] += e.hours;
    extra[i] += e.extra_hours;
    rec[i] += e.recurring_cents;
  }

  const realize = (rev: number, hrs: number | null, cap: number): { rev: number; hrs: number | null; over: boolean; f: number } => {
    const load = hrs !== null ? hrs : rev;
    const f = load > cap && load > 0 ? cap / load : 1;
    return { rev: rev * f, hrs: hrs !== null ? hrs * f : null, over: load > cap, f };
  };

  const out: CurvePoint[] = [];
  let cum = core.start_cash_cents ?? 0;
  for (let k = 0; k < n; k++) {
    const base = realize(core.demand_revenue_cents[k], core.demand_hours ? core.demand_hours[k] : null, core.cap_load);
    const rev = Math.max(0, dRev[k]);
    const hrs = dHrs ? Math.max(0, dHrs[k]) : null;
    const cap = core.cap_load + (core.hours_available ? extra[k] : 0);
    const withA = realize(rev, hrs, cap);
    const revenue = withA.rev + rec[k];
    const net = (revenue * core.gm_pct) / 100 - core.weekly_fixed_cents;
    cum += net;
    out.push({
      w: core.weeks[k],
      month: monthOf(core.weeks[k]),
      baseline_revenue_cents: r0(base.rev),
      revenue_cents: r0(revenue),
      baseline_hours: base.hrs !== null ? r1(base.hrs) : null,
      hours: withA.hrs !== null ? r1(withA.hrs) : null,
      cap_load: r1(cap),
      overloaded: withA.over,
      unmet_revenue_cents: r0(rev * (1 - withA.f)),
      net_cash_cents: r0(net),
      cum_cash_cents: r0(cum),
    });
  }
  return out;
}

export function stabilityScore(points: { revenue_cents: number; overloaded: boolean }[]): StabilityScore {
  const rev = points.map((p) => p.revenue_cents);
  const m = mean(rev);
  const cv = m > 0 ? sd(rev) / m : 0;
  let min4 = m;
  for (let i = 0; i + 4 <= rev.length; i++) min4 = Math.min(min4, mean(rev.slice(i, i + 4)));
  const depth = m > 0 ? clamp(1 - min4 / m, 0, 1) : 0;
  const overload = points.filter((p) => p.overloaded).length;
  const frac = points.length ? overload / points.length : 0;
  const score = 100 - 45 * Math.min(1, cv / 0.5) - 35 * Math.min(1, depth / 0.6) - 20 * Math.min(1, frac / 0.25);
  return {
    score: Math.round(clamp(score, 0, 100)),
    cv: Math.round(cv * 1000) / 1000,
    valley_depth: Math.round(depth * 1000) / 1000,
    overload_weeks: overload,
  };
}

/** Curve + score with the given actions' effects applied (used by the page for the with/without toggle). */
export function applyActions(
  report: StabilizerReport,
  actions: { status: string; details?: { effects?: Effect[] } | null }[],
  include: ReadonlySet<string>,
): { curve: CurvePoint[]; score: StabilityScore } {
  const effects: Effect[] = [];
  for (const a of actions) {
    if (!include.has(a.status)) continue;
    const eff = a.details?.effects;
    if (Array.isArray(eff)) effects.push(...eff);
  }
  const curve = buildCurve(report.core, effects);
  return { curve, score: stabilityScore(curve) };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface Ctx {
  s: StabilizerSettings;
  cal: TwinCalibration;
  floor: number;
  weeks: string[];
  load: number[];
  capLoad: number;
  hoursAvailable: boolean;
  gmPct: number;
  rateCents: number;
  existing: ExistingAction[];
  today: string;
  aggRev: number[];
  aggHrs: number[];
}

const weekEnd = (w: string): string => addDays(w, 6);

function overlapsExisting(ctx: Ctx, type: ActionType, line: string, start: string, end: string): boolean {
  return ctx.existing.some(
    (e) =>
      e.action_type === type &&
      e.service_line === line &&
      e.status !== 'rejected' &&
      e.status !== 'cancelled' &&
      e.window_start <= end &&
      e.window_end >= start,
  );
}

function overflowFrac(ctx: Ctx, k: number): number {
  const load = ctx.load[k];
  return load > ctx.capLoad && load > 0 ? 1 - ctx.capLoad / load : 0;
}

function sumRange(a: number[], from: number, to: number): number {
  let t = 0;
  for (let k = Math.max(0, from); k <= Math.min(a.length - 1, to); k++) t += a[k];
  return t;
}

function windowFor(
  role: MeasureWindow['role'],
  weeks: string[],
  from: number,
  to: number,
  base: number[],
  effects: Effect[],
  line: string,
): MeasureWindow {
  const a = Math.max(0, from);
  const b = Math.min(weeks.length - 1, to);
  const inRange = new Set(weeks.slice(a, b + 1));
  const delta = sum(effects.filter((e) => (line === '*' || e.line === line) && inRange.has(e.w)).map((e) => e.revenue_cents));
  const baseline = sumRange(base, a, b);
  return {
    role,
    start: weeks[a],
    end: weekEnd(weeks[b]),
    expected_baseline_cents: r0(baseline),
    expected_with_action_cents: r0(baseline + delta),
  };
}

function lineMargin(history: HistoryPayload, line: string): { pct: number; source: 'actual' | 'default' } {
  const row = history.line_margin.find((m) => m.line === line);
  if (row && row.margin_pct !== null && row.sample >= 3 && Number.isFinite(row.margin_pct)) {
    return { pct: clamp(row.margin_pct, -50, 95), source: 'actual' };
  }
  return { pct: clamp(100 - history.default_cost_ratio_pct, 0, 95), source: 'default' };
}

function buildLineActions(ctx: Ctx, line: LineForecast, margin: number): ProposedAction[] {
  const out: ProposedAction[] = [];
  const { s, floor, weeks } = ctx;
  const mean_ = mean(line.rev_cents);
  if (mean_ <= 0) return out;
  const costShare = 1 - margin / 100;
  const sunk = s.valley_sunk_labor_pct / 100;
  const hrsPerRev = (k: number): number => (line.rev_cents[k] > 0 ? line.hours[k] / line.rev_cents[k] : 0);
  const peaks = line.windows.filter((w) => w.kind === 'peak');
  const valleys = line.windows.filter((w) => w.kind === 'valley');
  const hi = s.peak_threshold_pct / 100;

  for (const P of peaks) {
    // Shoulder = up to four weeks before the peak that still have headroom (and are in the future).
    const shoulder: number[] = [];
    for (let k = Math.max(1, P.start_k - 4); k < P.start_k; k++) if (line.rev_cents[k] < mean_ * hi) shoulder.push(k);
    const excess: number[] = [];
    for (let k = P.start_k; k <= P.end_k; k++) excess.push(Math.max(0, line.rev_cents[k] - mean_));
    const totalExcess = sum(excess);
    if (P.start_k < 3 || totalExcess <= 0) continue;

    // ---- Pre-season campaign (adds demand to the shoulder) -------------------------------------------
    if (shoulder.length && !overlapsExisting(ctx, 'pre_season_campaign', line.line, weeks[shoulder[0]], weekEnd(weeks[shoulder[shoulder.length - 1]]))) {
      const uplift = 0.06 * ctx.cal.marketing_factor;
      const effects: Effect[] = [];
      let incr = 0;
      for (const k of shoulder) {
        const room = Math.max(0, mean_ * 1.05 - line.rev_cents[k]);
        const add = Math.min(line.rev_cents[k] * uplift, room);
        if (add <= 0) continue;
        incr += add;
        effects.push({ w: weeks[k], line: line.line, revenue_cents: r0(add), hours: r1(add * hrsPerRev(k)), extra_hours: 0, recurring_cents: 0 });
      }
      const cost = incr * 0.1;
      const estMargin = incr * (1 - costShare * (1 - sunk)) - cost;
      if (incr >= 50_000 && estMargin > 0) {
        const a = shoulder[0];
        const b = shoulder[shoulder.length - 1];
        out.push({
          fingerprint: `pre_season_campaign|${line.line}|${weeks[a]}`,
          action_type: 'pre_season_campaign',
          service_line: line.line,
          title: `${line.label}: pre-season campaign before the ${P.start} peak`,
          rationale: `Demand for ${line.label} climbs to ${Math.round(P.avg_ratio * 100)}% of average from ${P.start}. Book the 4 weeks before it now (past customers, tune-up / prep offer) so slower weeks fill and the peak starts with work already scheduled.`,
          window_start: weeks[a],
          window_end: weekEnd(weeks[b]),
          est_revenue_cents: r0(incr),
          est_margin_cents: r0(estMargin),
          shifted_revenue_cents: 0,
          est_labor_hours: r1(sum(effects.map((e) => e.hours))),
          margin_pct_after: r1(margin),
          margin_floor_pct: r1(floor),
          guardrail_status: 'not_applicable',
          details: {
            assumptions: { uplift_pct: r1(uplift * 100), campaign_cost_pct_of_incremental: 10, sunk_labor_pct: s.valley_sunk_labor_pct, marketing_factor: ctx.cal.marketing_factor },
            line_margin_pct: r1(margin),
            effects,
          },
          measure_windows: [windowFor('target', weeks, a, b, line.rev_cents, effects, line.line)],
        });
      }
    }

    // ---- Early-booking incentive (pulls peak demand forward into the shoulder) ------------------------
    const earlyFp = `early_booking_incentive|${line.line}|${weeks[shoulder[0] ?? P.start_k]}`;
    if (shoulder.length && !overlapsExisting(ctx, 'early_booking_incentive', line.line, weeks[shoulder[0]], weekEnd(weeks[P.end_k]))) {
      const g = guardrailFor(margin, floor, s.incentive_pct);
      const d = g.applied_pct;
      const shift = (s.shift_share_pct / 100) * totalExcess;
      const room = shoulder.map((k) => Math.max(0.05 * mean_, mean_ - line.rev_cents[k]));
      const roomSum = sum(room);
      const effects: Effect[] = [];
      let recovered = 0;
      excess.forEach((ex, i) => {
        const k = P.start_k + i;
        const moved = (shift * ex) / totalExcess;
        recovered += Math.min(moved, line.rev_cents[k] * overflowFrac(ctx, k));
        effects.push({ w: weeks[k], line: line.line, revenue_cents: -r0(moved), hours: -r1(moved * hrsPerRev(k)), extra_hours: 0, recurring_cents: 0 });
      });
      shoulder.forEach((k, i) => {
        const landed = (shift * room[i]) / roomSum;
        effects.push({ w: weeks[k], line: line.line, revenue_cents: r0(landed * (1 - d / 100)), hours: r1(landed * hrsPerRev(P.start_k)), extra_hours: 0, recurring_cents: 0 });
      });
      const discountCost = shift * (d / 100);
      const estRevenue = recovered - discountCost;
      const estMargin = recovered * (margin / 100) - discountCost;
      if (recovered > 0 && estMargin > 0) {
        out.push({
          fingerprint: earlyFp,
          action_type: 'early_booking_incentive',
          service_line: line.line,
          title: `${line.label}: early-booking offer (${d}% off) ahead of the ${P.start} peak`,
          rationale: `Over capacity in the peak: roughly ${fmtMoney(recovered)} of demand would otherwise be turned away or run on premium labor. Offer ${d}% to book ${Math.round(s.shift_share_pct)}% of peak demand into the weeks before it.${g.capped ? ' Discount capped to protect the margin floor.' : ''}`,
          window_start: weeks[shoulder[0]],
          window_end: weekEnd(weeks[P.end_k]),
          est_revenue_cents: r0(estRevenue),
          est_margin_cents: r0(estMargin),
          shifted_revenue_cents: r0(shift),
          est_labor_hours: r1(sum(effects.filter((e) => e.revenue_cents < 0).map((e) => -e.hours))),
          margin_pct_after: r1(g.margin_after_pct),
          margin_floor_pct: r1(floor),
          guardrail_status: g.status,
          details: { incentive_pct: d, recovered_revenue_cents: r0(recovered), discount_cost_cents: r0(discountCost), line_margin_pct: r1(margin), effects },
          measure_windows: [
            windowFor('source', weeks, P.start_k, P.end_k, line.rev_cents, effects, line.line),
            windowFor('target', weeks, shoulder[0], shoulder[shoulder.length - 1], line.rev_cents, effects, line.line),
          ],
        });
      }
    }

    // ---- Defer to valley (customer opt-in offers; only for lines marked deferrable) -------------------
    const nextValley = valleys.find((v) => v.start_k > P.end_k && v.start_k - P.end_k <= 26);
    if (nextValley && s.deferrable_service_lines.includes(line.line) && !overlapsExisting(ctx, 'defer_to_valley', line.line, P.start, P.end)) {
      const n = Math.max(1, Math.round((nextValley.start_k + nextValley.end_k) / 2 - (P.start_k + P.end_k) / 2));
      const landsOk = excess.every((_, i) => P.start_k + i + n < weeks.length && line.rev_cents[P.start_k + i + n] < mean_ * hi);
      if (landsOk) {
        const g = guardrailFor(margin, floor, s.incentive_pct);
        const d = g.applied_pct;
        const shift = (s.shift_share_pct / 100) * totalExcess;
        const effects: Effect[] = [];
        let recovered = 0;
        const landedWeeks: number[] = [];
        excess.forEach((ex, i) => {
          const k = P.start_k + i;
          const moved = (shift * ex) / totalExcess;
          recovered += Math.min(moved, line.rev_cents[k] * overflowFrac(ctx, k));
          effects.push({ w: weeks[k], line: line.line, revenue_cents: -r0(moved), hours: -r1(moved * hrsPerRev(k)), extra_hours: 0, recurring_cents: 0 });
          effects.push({ w: weeks[k + n], line: line.line, revenue_cents: r0(moved * (1 - d / 100)), hours: r1(moved * hrsPerRev(k)), extra_hours: 0, recurring_cents: 0 });
          landedWeeks.push(k + n);
        });
        const discountCost = shift * (d / 100);
        const estRevenue = recovered - discountCost;
        const estMargin = recovered * (margin / 100) - discountCost;
        if (recovered > 0 && estMargin > 0) {
          const avgJob = Math.max(1, line.avg_job_value_cents);
          out.push({
            fingerprint: `defer_to_valley|${line.line}|${P.start}`,
            action_type: 'defer_to_valley',
            service_line: line.line,
            title: `${line.label}: offer ${d}% to move deferrable jobs ${n} week${n === 1 ? '' : 's'} into the valley`,
            rationale: `Customers with flexible ${line.label} jobs booked in the ${P.start} peak get a ${d}% opt-in offer to move ${n} week${n === 1 ? '' : 's'} later, into a quiet stretch. Nothing moves unless the customer accepts.${g.capped ? ' Discount capped to protect the margin floor.' : ''}`,
            window_start: P.start,
            window_end: weekEnd(weeks[landedWeeks[landedWeeks.length - 1]]),
            est_revenue_cents: r0(estRevenue),
            est_margin_cents: r0(estMargin),
            shifted_revenue_cents: r0(shift),
            est_labor_hours: r1(sum(effects.filter((e) => e.revenue_cents < 0).map((e) => -e.hours))),
            margin_pct_after: r1(g.margin_after_pct),
            margin_floor_pct: r1(floor),
            guardrail_status: g.status,
            details: {
              incentive_pct: d,
              shift_days: n * 7,
              source_start: P.start,
              source_end: P.end,
              max_jobs: Math.max(1, Math.ceil(shift / avgJob)),
              recovered_revenue_cents: r0(recovered),
              discount_cost_cents: r0(discountCost),
              line_margin_pct: r1(margin),
              effects,
            },
            measure_windows: [
              windowFor('source', weeks, P.start_k, P.end_k, line.rev_cents, effects, line.line),
              windowFor('target', weeks, landedWeeks[0], landedWeeks[landedWeeks.length - 1], line.rev_cents, effects, line.line),
            ],
          });
        }
      }
    }
  }

  // ---- Valley pricing (guardrailed; only proposed when it pays back on margin) -----------------------
  const eps = 1.2 * ctx.cal.price_factor;
  for (const V of valleys) {
    if (V.start_k < 1 || overlapsExisting(ctx, 'valley_pricing', line.line, V.start, V.end)) continue;
    const cap = Math.min(s.max_valley_discount_pct, maxDiscountForFloor(margin, floor));
    if (cap < 1) continue;
    const R = sumRange(line.rev_cents, V.start_k, V.end_k);
    if (R <= 0) continue;
    let best: { d: number; delta: number } | null = null;
    for (let d = 1; d <= cap + 1e-9; d += d < 5 ? 1 : 2.5) {
      const dd = d / 100;
      const delta = R * ((1 - dd) * (1 + eps * dd) - 1) - R * costShare * eps * dd * (1 - sunk);
      if (delta > 0 && (!best || delta > best.delta)) best = { d, delta };
    }
    if (!best) continue;
    const dd = best.d / 100;
    const effects: Effect[] = [];
    for (let k = V.start_k; k <= V.end_k; k++) {
      effects.push({
        w: weeks[k],
        line: line.line,
        revenue_cents: r0(line.rev_cents[k] * ((1 - dd) * (1 + eps * dd) - 1)),
        hours: r1(line.hours[k] * eps * dd),
        extra_hours: 0,
        recurring_cents: 0,
      });
    }
    const g = guardrailFor(margin, floor, best.d);
    out.push({
      fingerprint: `valley_pricing|${line.line}|${V.start}`,
      action_type: 'valley_pricing',
      service_line: line.line,
      title: `${line.label}: ${best.d}% valley rate for ${V.start} – ${V.end}`,
      rationale: `${line.label} runs at ${Math.round(V.avg_ratio * 100)}% of average in this stretch, so technicians are idle and part of the labor cost is already paid. A ${best.d}% rate lifts volume enough to add margin; margin after discount stays at ${r1(g.margin_after_pct)}% (floor ${r1(floor)}%).`,
      window_start: V.start,
      window_end: V.end,
      est_revenue_cents: r0(sum(effects.map((e) => e.revenue_cents))),
      est_margin_cents: r0(best.delta),
      shifted_revenue_cents: 0,
      est_labor_hours: r1(sum(effects.map((e) => e.hours))),
      margin_pct_after: r1(g.margin_after_pct),
      margin_floor_pct: r1(floor),
      guardrail_status: g.status,
      details: {
        discount_pct: best.d,
        assumed_volume_lift_per_1pct: r1(eps * 10) / 10,
        sunk_labor_pct: s.valley_sunk_labor_pct,
        line_margin_pct: r1(margin),
        effects,
      },
      measure_windows: [windowFor('valley', weeks, V.start_k, V.end_k, line.rev_cents, effects, line.line)],
    });
  }
  return out;
}

function fmtMoney(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

export function buildStabilizerReport(
  history: HistoryPayload,
  opts: { existing?: ExistingAction[]; calibration?: TwinCalibration } = {},
): StabilizerReport {
  const s: StabilizerSettings = { ...DEFAULT_SETTINGS, ...history.settings };
  s.deferrable_service_lines = Array.isArray(history.settings?.deferrable_service_lines) ? history.settings.deferrable_service_lines! : [];
  const cal: TwinCalibration = opts.calibration ?? { marketing_factor: 1, price_factor: 1 };
  const notes: string[] = [];
  const weekStart = history.week_start;
  const weeks = Array.from({ length: HORIZON_WEEKS }, (_, k) => addDays(weekStart, 7 * k));

  const emptyCore: CurveCore = {
    weeks,
    demand_revenue_cents: new Array<number>(HORIZON_WEEKS).fill(0),
    demand_hours: null,
    hours_available: false,
    cap_load: 0,
    gm_pct: 0,
    weekly_fixed_cents: 0,
    start_cash_cents: null,
  };
  const insufficient = (why: string): StabilizerReport => {
    const curve = buildCurve(emptyCore, []);
    return {
      engine_version: ENGINE_VERSION,
      generated_for: history.today,
      status: 'insufficient_data',
      confidence: 'low',
      notes: [why],
      capacity: { cap_load: 0, unit: 'revenue', source: 'assumed' },
      horizon: [],
      lines: [],
      windows: [],
      core: emptyCore,
      stability: stabilityScore(curve),
      stability_with_actions: null,
      actions: [],
      membership: null,
      cash: null,
      headline: { peak_weeks: 0, valley_weeks: 0, revenue_swing_pct: 0, annual_revenue_cents: 0, gross_margin_pct: 0, actions: 0, est_revenue_cents: 0, est_margin_cents: 0 },
    };
  };

  // ---- History -> per-line weekly series --------------------------------------------------------------
  if (!history.weekly.length) return insufficient('No scheduled or completed jobs with an invoice amount were found yet. Come back after a few weeks of job history.');
  const firstWeek = history.weekly.reduce((m, r) => (r.w < m ? r.w : m), history.weekly[0].w);
  const lastWeek = addDays(weekStart, -7);
  const nHist = Math.floor(diffDays(firstWeek, lastWeek) / 7) + 1;
  if (nHist < 8) return insufficient('Fewer than 8 weeks of job history. The stabilizer needs at least 8 weeks (12 months for true seasonality).');

  const lineTotals = new Map<string, number>();
  for (const r of history.weekly) {
    if (diffDays(r.w, lastWeek) / 7 < 52) lineTotals.set(r.line, (lineTotals.get(r.line) ?? 0) + r.revenue_cents);
  }
  const totalRecent = sum([...lineTotals.values()]);
  if (totalRecent <= 0) return insufficient('No invoiced revenue found in the last 12 months. Invoice amounts on jobs are needed to forecast revenue.');

  const ranked = [...lineTotals.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  const keep = new Set(ranked.slice(0, 7));
  const lineOf = (l: string): string => (ranked.length <= 8 || keep.has(l) ? l : 'other');
  const linesOrdered = [...new Set(history.weekly.map((r) => lineOf(r.line)))];

  const fill = (rows: HistoryWeekRow[], field: 'revenue_cents' | 'minutes' | 'jobs', line: string, from: string, n: number): number[] => {
    const arr = new Array<number>(n).fill(0);
    for (const r of rows) {
      if (lineOf(r.line) !== line) continue;
      const i = Math.round(diffDays(from, r.w) / 7);
      if (i >= 0 && i < n) arr[i] += r[field];
    }
    return arr;
  };
  const fillFuture = (field: 'revenue_cents' | 'minutes', line: string): number[] => {
    const arr = new Array<number>(HORIZON_WEEKS).fill(0);
    for (const r of history.booked_ahead) {
      if (lineOf(r.line) !== line) continue;
      const i = Math.round(diffDays(weekStart, r.w) / 7);
      if (i >= 0 && i < HORIZON_WEEKS) arr[i] += r[field];
    }
    return arr;
  };

  const weatherVol = new Array<number>(13).fill(0);
  for (const m of history.weather_monthly) weatherVol[m.m] = Math.min(0.12, (m.events / Math.max(1, m.years)) * 0.03);
  const regionalPct = history.regional && history.regional.change_pct !== null ? clamp(history.regional.change_pct, -25, 25) : null;
  const ext = weeks.map((_, k) => (regionalPct === null ? 1 : 1 + (regionalPct / 100) * 0.5 * Math.max(0, (6 - k) / 6)));

  const totalMinutes = sum(history.weekly.filter((r) => diffDays(r.w, lastWeek) / 7 < 52).map((r) => r.minutes));
  const hoursAvailable = totalMinutes > 0;
  if (!hoursAvailable) notes.push('Jobs have no duration recorded, so labor hours and technician overload use revenue as the load measure.');

  const lines: LineForecast[] = [];
  const sigmaByLine = new Map<string, number>();
  let anyMeasured = false;
  for (const line of linesOrdered) {
    const revHist = fill(history.weekly, 'revenue_cents', line, firstWeek, nHist);
    const minHist = fill(history.weekly, 'minutes', line, firstWeek, nHist);
    const jobsHist = fill(history.weekly, 'jobs', line, firstWeek, nHist);
    const revSea = seasonality(revHist, firstWeek);
    const minSea = seasonality(minHist, firstWeek);
    anyMeasured = anyMeasured || revSea.measured;
    const revLevel = levelOf(revHist);
    const minLevel = levelOf(minHist);
    const bookedRev = fillFuture('revenue_cents', line);
    const bookedMin = fillFuture('minutes', line);
    const rev = weeks.map((w, k) => Math.max(bookedRev[k], revLevel * revSea.index[weekOfYear(w)] * ext[k]));
    const hrs = weeks.map((w, k) => Math.max(bookedMin[k] / 60, ((minLevel * minSea.index[weekOfYear(w)] * ext[k]) / 60)));
    const m = lineMargin(history, line);
    const maxFloor = maxDiscountForFloor(m.pct, history.margin_floor_pct);
    const recentRev = sum(revHist.slice(-52));
    const recentJobs = sum(jobsHist.slice(-52));
    sigmaByLine.set(line, revSea.sigma);
    lines.push({
      line,
      label: titleCase(line),
      share_pct: r1((recentRev / totalRecent) * 100),
      weeks_of_history: nHist,
      seasonality: revSea.measured ? 'measured' : 'insufficient_history',
      rel_noise_pct: r1(revSea.sigma * 100),
      avg_job_value_cents: recentJobs > 0 ? r0(recentRev / recentJobs) : 0,
      rev_cents: rev.map(r0),
      hours: hrs.map(r1),
      windows: [],
      guardrail: {
        margin_pct: r1(m.pct),
        margin_source: m.source,
        margin_floor_pct: r1(history.margin_floor_pct),
        max_discount_for_floor_pct: r1(maxFloor),
        allowed_valley_discount_pct: r1(Math.min(s.max_valley_discount_pct, maxFloor)),
        break_even_elasticity: (() => {
          const d = Math.min(s.max_valley_discount_pct, maxFloor);
          const be = d > 0 ? breakEvenElasticity(m.pct, d, s.valley_sunk_labor_pct) : null;
          return be === null ? null : Math.round(be * 10) / 10;
        })(),
      },
    });
  }
  lines.sort((a, b) => b.share_pct - a.share_pct);
  if (!anyMeasured) notes.push('Under 12 months of history: seasonality cannot be measured yet, so the forecast is flat and peaks/valleys will mostly be absent. It improves automatically as history grows.');
  if (lines.some((l) => l.guardrail.margin_source === 'default')) notes.push(`Lines without recorded job costs use the default ${r0(history.default_cost_ratio_pct)}% cost ratio from Margin Guardrails.`);
  if (regionalPct !== null) notes.push(`Regional demand trend (${history.regional?.label ?? 'your area'}, ${regionalPct > 0 ? '+' : ''}${r1(regionalPct)}% weekly calls) nudges the next 6 weeks at half weight.`);
  if (history.weather_monthly.length) notes.push('Weather: months with recorded severe-weather surges get wider forecast ranges and a weather-risk flag; they do not change the expected value.');

  // ---- Aggregate demand + capacity -------------------------------------------------------------------
  const aggRev = weeks.map((_, k) => sum(lines.map((l) => l.rev_cents[k])));
  const aggHrs = weeks.map((_, k) => sum(lines.map((l) => l.hours[k])));
  const load = hoursAvailable ? aggHrs : aggRev;
  const meanLoad = mean(load);
  const hi = s.peak_threshold_pct / 100;
  let capLoad: number;
  let capSource: 'team' | 'assumed';
  if (hoursAvailable && history.tech.headcount > 0) {
    capLoad = history.tech.headcount * s.paid_hours_per_tech_week * BILLABLE_SHARE;
    capSource = 'team';
    notes.push(`Capacity = ${history.tech.headcount} dispatch-enabled technician${history.tech.headcount === 1 ? '' : 's'} × ${s.paid_hours_per_tech_week} paid hours × ${Math.round(BILLABLE_SHARE * 100)}% billable.`);
  } else {
    capLoad = meanLoad * hi;
    capSource = 'assumed';
    notes.push('No dispatch-enabled technicians with job durations found: capacity is assumed to be sized for your peak threshold. Set up Technician Capacity for an exact overload view.');
  }

  const meanRev = mean(aggRev);
  const ratios = aggRev.map((v) => (meanRev > 0 ? v / meanRev : 1));
  const windows = detectWindows(ratios, weeks, s.valley_threshold_pct, s.peak_threshold_pct);
  for (const l of lines) {
    const m = mean(l.rev_cents);
    l.windows = m > 0 ? detectWindows(l.rev_cents.map((v) => v / m), weeks, s.valley_threshold_pct, s.peak_threshold_pct) : [];
  }

  const bandRel = (k: number): number => {
    const parts = lines.map((l) => (l.rev_cents[k] * 1.28 * Math.sqrt((sigmaByLine.get(l.line) ?? 0.3) ** 2 + weatherVol[monthOf(weeks[k])] ** 2)) ** 2);
    return Math.sqrt(sum(parts));
  };
  const bookedAgg = weeks.map((_, k) => sum(history.booked_ahead.filter((r) => Math.round(diffDays(weekStart, r.w) / 7) === k).map((r) => r.revenue_cents)));
  const horizon: HorizonWeek[] = weeks.map((w, k) => {
    const band = bandRel(k);
    return {
      k,
      w,
      month: monthOf(w),
      demand_revenue_cents: r0(aggRev[k]),
      p10_revenue_cents: r0(Math.max(0, aggRev[k] - band)),
      p90_revenue_cents: r0(aggRev[k] + band),
      demand_load: r1(load[k]),
      booked_revenue_cents: r0(bookedAgg[k]),
      ratio: Math.round(ratios[k] * 100) / 100,
      status: ratios[k] >= hi ? 'peak' : ratios[k] <= s.valley_threshold_pct / 100 ? 'valley' : 'normal',
      weather_risk: weatherVol[monthOf(w)] >= 0.03,
    };
  });

  // ---- Margin, fixed costs, cash ---------------------------------------------------------------------
  const gmPct = clamp(sum(lines.map((l) => l.guardrail.margin_pct * mean(l.rev_cents))) / Math.max(1, sum(lines.map((l) => mean(l.rev_cents)))), 0, 95);
  const weeklyFixed = (history.fixed_monthly_cents * 12) / 52;
  if (history.fixed_monthly_cents <= 0) notes.push('No fixed expenses found. Add rent, insurance, payroll base and software in Cash Flow Forecast to get membership targets and a cash-reserve plan.');
  const startCash = history.cash ? history.cash.starting_balance_cents : null;

  const core: CurveCore = {
    weeks,
    demand_revenue_cents: aggRev.map(r0),
    demand_hours: hoursAvailable ? aggHrs.map(r1) : null,
    hours_available: hoursAvailable,
    cap_load: capLoad,
    gm_pct: gmPct,
    weekly_fixed_cents: weeklyFixed,
    start_cash_cents: startCash,
  };
  const baseCurve = buildCurve(core, []);
  const stability = stabilityScore(baseCurve);

  // ---- Membership target ------------------------------------------------------------------------------
  const rateCents = s.tech_hourly_cost_cents ?? history.tech.avg_hourly_cost_cents ?? DEFAULT_TECH_HOURLY_CENTS;
  const valleyIdx = (() => {
    const v = baseCurve.map((p, k) => ({ k, v: p.baseline_revenue_cents })).filter((p) => horizon[p.k].status === 'valley').map((p) => p.k);
    if (v.length) return v;
    return baseCurve.map((p, k) => ({ k, v: p.baseline_revenue_cents })).sort((a, b) => a.v - b.v).slice(0, 8).map((p) => p.k);
  })();
  const valleyGp = mean(valleyIdx.map((k) => (baseCurve[k].baseline_revenue_cents * gmPct) / 100));
  const gapGross = Math.max(0, weeklyFixed - valleyGp);
  const activeMembers = history.memberships.active;
  const existingContribution = (history.memberships.mrr_cents * 12 * (gmPct / 100)) / 52;
  const gap = Math.max(0, gapGross - existingContribution);
  let membership: MembershipTarget | null = null;
  if (weeklyFixed > 0) {
    const plans: MembershipPlanTarget[] = history.membership_plans.map((p) => {
      const monthly = p.billing_interval === 'yearly' ? Math.round(p.price_cents / 12) : p.price_cents;
      const annual = monthly * 12;
      const perMemberWeek = (annual * (gmPct / 100)) / 52;
      const additional = gap > 0 && perMemberWeek > 0 ? Math.ceil(gap / perMemberWeek) : 0;
      return { id: p.id, name: p.name, monthly_cents: monthly, annual_cents: annual, additional_needed: additional, total_target: activeMembers + additional, mrr_at_target_cents: (activeMembers + additional) * monthly };
    });
    membership = {
      weekly_fixed_cents: r0(weeklyFixed),
      valley_weeks: valleyIdx.length,
      valley_gross_profit_per_week_cents: r0(valleyGp),
      weekly_gap_cents: r0(gap),
      active_members: activeMembers,
      existing_contribution_per_week_cents: r0(existingContribution),
      plans,
      note: !plans.length ? 'Create an active membership plan to get member targets.' : gap <= 0 ? 'Valley gross profit plus current members already cover fixed costs.' : null,
    };
  }

  // ---- Actions ----------------------------------------------------------------------------------------
  const ctx: Ctx = { s, cal, floor: history.margin_floor_pct, weeks, load, capLoad, hoursAvailable, gmPct, rateCents, existing: opts.existing ?? [], today: history.today, aggRev, aggHrs };
  const actions: ProposedAction[] = [];
  for (const l of lines) {
    if (l.share_pct < 5) continue;
    actions.push(...buildLineActions(ctx, l, l.guardrail.margin_pct));
  }

  // Membership push: one action per deep valley window while members are still needed.
  if (membership && membership.plans.length) {
    const sorted = [...membership.plans].sort((a, b) => a.annual_cents - b.annual_cents);
    const plan = sorted[Math.floor((sorted.length - 1) / 2)];
    const vWins = windows.filter((w) => w.kind === 'valley' && w.start_k >= 1).sort((a, b) => a.avg_ratio - b.avg_ratio).slice(0, 3).sort((a, b) => a.start_k - b.start_k);
    if (plan.additional_needed > 0 && vWins.length) {
      const per = Math.ceil(plan.additional_needed / vWins.length);
      for (const V of vWins) {
        const a = Math.max(1, V.start_k - 2);
        if (overlapsExisting(ctx, 'membership_push', '*', weeks[a], V.end)) continue;
        const weekly = (per * plan.annual_cents) / 52;
        const effects: Effect[] = [];
        for (let k = V.start_k + 1; k < weeks.length; k++) effects.push({ w: weeks[k], line: '*', revenue_cents: 0, hours: 0, extra_hours: 0, recurring_cents: r0(weekly) });
        const estRevenue = per * plan.annual_cents;
        actions.push({
          fingerprint: `membership_push|*|${weeks[a]}`,
          action_type: 'membership_push',
          service_line: '*',
          title: `Sell ${per} "${plan.name}" memberships during the ${V.start} slow stretch`,
          rationale: `Fixed costs are about ${fmtMoney(weeklyFixed)}/week but valley gross profit is only ${fmtMoney(valleyGp)}/week. ${plan.additional_needed} more members would cover the gap; spread over ${vWins.length} slow stretch${vWins.length === 1 ? '' : 'es'}. Members also book tune-ups into quiet weeks.`,
          window_start: weeks[a],
          window_end: V.end,
          est_revenue_cents: r0(estRevenue),
          est_margin_cents: r0(estRevenue * (gmPct / 100)),
          shifted_revenue_cents: 0,
          est_labor_hours: 0,
          margin_pct_after: null,
          margin_floor_pct: null,
          guardrail_status: 'not_applicable',
          details: { plan_id: plan.id, plan_name: plan.name, target_new_members: per, annual_value_cents: plan.annual_cents, line_margin_pct: r1(gmPct), effects },
          measure_windows: [{ role: 'valley', start: weeks[a], end: V.end, expected_baseline_cents: r0(sumRange(aggRev, a, V.end_k)), expected_with_action_cents: r0(sumRange(aggRev, a, V.end_k)) }],
        });
      }
    }
  }

  // Peak surge staffing: aggregate overload windows (needs real hours to price labor).
  if (hoursAvailable) {
    const overRatios = load.map((v) => (capLoad > 0 ? v / capLoad : 0));
    const over = detectWindows(overRatios, weeks, 0, 100 + 1e-6, 1).filter((w) => w.kind === 'peak');
    for (const O of over) {
      const gapHrs: number[] = [];
      let gapRev = 0;
      for (let k = O.start_k; k <= O.end_k; k++) {
        const g = Math.max(0, aggHrs[k] - capLoad);
        gapHrs.push(g);
        gapRev += aggHrs[k] > 0 ? (g / aggHrs[k]) * aggRev[k] : 0;
      }
      const totalGap = sum(gapHrs);
      if (totalGap < 4 || gapRev <= 0) continue;
      const revPerHr = gapRev / totalGap;
      const gmFrac = gmPct / 100;
      const options = [
        { key: 'overtime', label: 'Overtime', perHr: revPerHr * gmFrac - ctx.rateCents * (s.overtime_multiplier - 1), capPerWeek: capLoad * 0.25 },
        { key: 'temp_help', label: 'Temporary help', perHr: revPerHr * gmFrac - ctx.rateCents * (s.temp_help_cost_multiplier - 1), capPerWeek: capLoad * 0.25 },
        { key: 'subcontractor', label: 'Subcontractor handoff', perHr: revPerHr * gmFrac * (s.subcontractor_margin_share_pct / 100), capPerWeek: Number.POSITIVE_INFINITY },
      ]
        .filter((o) => o.perHr > 0)
        .sort((a, b) => b.perHr - a.perHr);
      if (!options.length) continue;
      const alloc: Record<string, number> = {};
      const effects: Effect[] = [];
      let covered = 0;
      let margin = 0;
      for (let i = 0; i < gapHrs.length; i++) {
        let left = gapHrs[i];
        for (const o of options) {
          if (left <= 0) break;
          const take = Math.min(left, o.capPerWeek);
          alloc[o.key] = (alloc[o.key] ?? 0) + take;
          margin += take * o.perHr;
          covered += take;
          left -= take;
        }
        const take = gapHrs[i] - left;
        const k = O.start_k + i;
        effects.push({ w: weeks[k], line: '*', revenue_cents: 0, hours: 0, extra_hours: r1(take), recurring_cents: 0 });
      }
      if (covered <= 0 || margin <= 0) continue;
      const a = Math.max(1, O.start_k - 3);
      if (overlapsExisting(ctx, 'peak_surge_staffing', '*', weeks[a], O.end)) continue;
      const alertDate = addDays(weeks[O.start_k], -21);
      const coveredRev = covered * revPerHr;
      // The revenue this action recovers is already in the demand curve but unmet; measure it against realized baseline.
      actions.push({
        fingerprint: `peak_surge_staffing|*|${weeks[a]}`,
        action_type: 'peak_surge_staffing',
        service_line: '*',
        title: `Peak ${O.start} – ${O.end}: add ${r0(covered)} labor hours (${options.map((o) => o.label.toLowerCase()).join(' → ')})`,
        rationale: `Demand exceeds technician capacity by ${r0(totalGap)} hours across ${O.weeks} week${O.weeks === 1 ? '' : 's'} (≈ ${fmtMoney(gapRev)} of work). Cheapest coverage first: ${options.map((o) => `${o.label} ${r0(alloc[o.key] ?? 0)}h`).join(', ')}. Alert goes out ${alertDate}.`,
        window_start: weeks[a],
        window_end: O.end,
        est_revenue_cents: r0(coveredRev),
        est_margin_cents: r0(margin),
        shifted_revenue_cents: 0,
        est_labor_hours: r1(covered),
        margin_pct_after: null,
        margin_floor_pct: null,
        guardrail_status: 'not_applicable',
        details: {
          alert_date: alertDate,
          gap_hours: r1(totalGap),
          gap_revenue_cents: r0(gapRev),
          options: options.map((o) => ({ key: o.key, label: o.label, hours: r1(alloc[o.key] ?? 0), margin_per_hour_cents: r0(o.perHr) })),
          tech_hourly_cost_cents: r0(ctx.rateCents),
          tech_rate_is_default: s.tech_hourly_cost_cents === null && history.tech.avg_hourly_cost_cents === null,
          line_margin_pct: r1(gmPct),
          effects,
        },
        measure_windows: [
          {
            role: 'peak',
            start: weeks[O.start_k],
            end: O.end,
            expected_baseline_cents: r0(sum(baseCurve.slice(O.start_k, O.end_k + 1).map((p) => p.baseline_revenue_cents))),
            expected_with_action_cents: r0(sum(baseCurve.slice(O.start_k, O.end_k + 1).map((p) => p.baseline_revenue_cents)) + coveredRev),
          },
        ],
      });
    }
  }
  if (hoursAvailable && s.tech_hourly_cost_cents === null && history.tech.avg_hourly_cost_cents === null) {
    notes.push(`Technician cost per hour is not set; staffing math uses ${fmtMoney(DEFAULT_TECH_HOURLY_CENTS)}/hour. Set the real rate in the stabilizer settings.`);
  }

  actions.sort((a, b) => b.est_margin_cents - a.est_margin_cents);

  // ---- With-actions score (all proposed actions) ------------------------------------------------------
  const withCurve = buildCurve(core, actions.flatMap((a) => a.details.effects));
  const withScore = actions.length ? stabilityScore(withCurve) : null;

  // ---- Cash-reserve plan -----------------------------------------------------------------------------
  let cash: CashPlan | null = null;
  if (weeklyFixed > 0) {
    const cums = baseCurve.map((p) => p.cum_cash_cents);
    const minCum = Math.min(...cums);
    const minK = cums.indexOf(minCum);
    const firstNeg = baseCurve.findIndex((p) => p.cum_cash_cents < 0);
    const buffer = weeklyFixed * s.reserve_buffer_weeks;
    const start0 = startCash ?? 0;
    // Reserve = deepest dip of cash *relative to the starting balance* + operating buffer.
    const dip = Math.max(0, start0 - minCum);
    const reserveNeeded = dip + buffer;
    const shortfall = Math.max(0, reserveNeeded - Math.max(0, start0));
    const before = baseCurve.slice(0, Math.max(1, minK + 1));
    const surplus = sum(before.map((p) => Math.max(0, p.net_cash_cents)));
    const pct = surplus > 0 ? Math.min(1, shortfall / surplus) : 0;
    const byMonth = new Map<string, number>();
    for (const p of before) {
      const amt = Math.max(0, p.net_cash_cents) * pct;
      if (amt <= 0) continue;
      const key = p.w.slice(0, 7);
      byMonth.set(key, (byMonth.get(key) ?? 0) + amt);
    }
    const compare: CashPlan['compare_13_weeks'] = [];
    const snapWeeks = history.cash_snapshot?.weeks;
    if (Array.isArray(snapWeeks) && startCash !== null) {
      let cumStab = startCash;
      for (let i = 0; i < Math.min(13, snapWeeks.length, baseCurve.length); i++) {
        cumStab += baseCurve[i].net_cash_cents;
        const row = snapWeeks[i] as { week_start?: string; projected_balance_committed?: number } | null;
        if (row && typeof row.projected_balance_committed === 'number' && typeof row.week_start === 'string') {
          compare.push({ w: row.week_start, existing_cents: r0(row.projected_balance_committed * 100), stabilizer_cents: r0(cumStab) });
        }
      }
    }
    cash = {
      starting_balance_cents: startCash,
      starting_balance_known: startCash !== null,
      weekly_fixed_cents: r0(weeklyFixed),
      lowest_cum_cash_cents: r0(minCum),
      lowest_week: weeks[minK] ?? null,
      first_negative_week: firstNeg >= 0 ? weeks[firstNeg] : null,
      buffer_cents: r0(buffer),
      reserve_needed_cents: r0(reserveNeeded),
      shortfall_cents: r0(shortfall),
      surplus_weeks_cents: r0(surplus),
      self_funded: shortfall <= surplus,
      monthly_set_aside_cents: [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, cents]) => ({ month, cents: r0(cents) })),
      compare_13_weeks: compare,
    };
    if (startCash === null) notes.push('Starting cash balance is not set in Cash Flow Forecast, so cash is shown relative to zero.');
  }

  const nHistWeeks = nHist;
  const confidence: Confidence = !anyMeasured ? 'low' : nHistWeeks >= 104 && mean([...sigmaByLine.values()]) < 0.3 ? 'high' : 'medium';
  const m4 = (a: number[]): number[] => a.map((_, i) => (i + 4 <= a.length ? mean(a.slice(i, i + 4)) : NaN)).filter((v) => !Number.isNaN(v));
  const rolling = m4(baseCurve.map((p) => p.baseline_revenue_cents));
  const swing = meanRev > 0 && rolling.length ? ((Math.max(...rolling) - Math.min(...rolling)) / mean(baseCurve.map((p) => p.baseline_revenue_cents))) * 100 : 0;

  return {
    engine_version: ENGINE_VERSION,
    generated_for: history.today,
    status: 'ok',
    confidence,
    notes,
    capacity: { cap_load: r1(capLoad), unit: hoursAvailable ? 'hours' : 'revenue', source: capSource },
    horizon,
    lines,
    windows,
    core,
    stability,
    stability_with_actions: withScore,
    actions,
    membership,
    cash,
    headline: {
      peak_weeks: horizon.filter((h) => h.status === 'peak').length,
      valley_weeks: horizon.filter((h) => h.status === 'valley').length,
      revenue_swing_pct: r1(swing),
      annual_revenue_cents: r0(sum(baseCurve.map((p) => p.baseline_revenue_cents))),
      gross_margin_pct: r1(gmPct),
      actions: actions.length,
      est_revenue_cents: r0(sum(actions.map((a) => a.est_revenue_cents))),
      est_margin_cents: r0(sum(actions.map((a) => a.est_margin_cents))),
    },
  };
}

// ---------------------------------------------------------------------------
// Display metadata
// ---------------------------------------------------------------------------

export const ACTION_LABEL: Record<ActionType, string> = {
  pre_season_campaign: 'Pre-season campaign',
  early_booking_incentive: 'Early-booking offer',
  membership_push: 'Membership push',
  defer_to_valley: 'Shift to valley (opt-in)',
  valley_pricing: 'Valley pricing',
  peak_surge_staffing: 'Peak staffing alert',
};

export const STATUS_LABEL: Record<ActionStatus, string> = {
  proposed: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  launched: 'Launched',
  measured: 'Measured',
  cancelled: 'Cancelled',
};

export const STATUS_TONE: Record<ActionStatus, string> = {
  proposed: 'bg-warning-500/10 text-warning-500',
  approved: 'bg-accent/10 text-accent',
  rejected: 'bg-bg-tertiary text-text-secondary',
  launched: 'bg-accent/10 text-accent',
  measured: 'bg-success-500/10 text-success-500',
  cancelled: 'bg-bg-tertiary text-text-secondary',
};

export const GUARDRAIL_LABEL: Record<GuardrailStatus, string> = {
  not_applicable: 'No discount involved',
  within_floor: 'Within margin floor',
  blocked: 'Below margin floor',
  overridden: 'Overridden by owner',
};

export const GUARDRAIL_TONE: Record<GuardrailStatus, string> = {
  not_applicable: 'bg-bg-tertiary text-text-secondary',
  within_floor: 'bg-success-500/10 text-success-500',
  blocked: 'bg-danger/10 text-danger',
  overridden: 'bg-warning-500/10 text-warning-500',
};

/** Where each action is carried out, using routes that already exist in the app. */
export const ACTION_LINK: Record<ActionType, { href: string; label: string }> = {
  pre_season_campaign: { href: '/dashboard/email-campaigns', label: 'Open Email Campaigns' },
  early_booking_incentive: { href: '/dashboard/email-campaigns', label: 'Open Email Campaigns' },
  membership_push: { href: '/dashboard/memberships', label: 'Open Memberships' },
  defer_to_valley: { href: '/dashboard/capacity-demand', label: 'Open Capacity Demand Control' },
  valley_pricing: { href: '/dashboard/margin-guardrails', label: 'Open Margin Guardrails' },
  peak_surge_staffing: { href: '/dashboard/technician-capacity', label: 'Open Technician Capacity' },
};

export const CONFIDENCE_TONE: Record<Confidence, string> = {
  high: 'bg-success-500/10 text-success-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};

export const fmtMoneyCents = (cents: number | null | undefined): string =>
  cents === null || cents === undefined ? '—' : `${cents < 0 ? '-' : ''}$${Math.abs(Math.round(cents / 100)).toLocaleString('en-US')}`;

export const fmtPct = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}%`;

export const fmtWeek = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Rolls the weekly curve into 12 calendar-month buckets (for the 12-month chart). */
export function monthlyRollup(curve: CurvePoint[]): {
  key: string;
  label: string;
  baseline_revenue_cents: number;
  revenue_cents: number;
  baseline_hours: number;
  hours: number;
}[] {
  const map = new Map<string, { key: string; label: string; baseline_revenue_cents: number; revenue_cents: number; baseline_hours: number; hours: number }>();
  for (const p of curve) {
    const key = addDays(p.w, 3).slice(0, 7);
    const cur = map.get(key) ?? {
      key,
      label: `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]}${key.slice(2, 4) !== curve[0].w.slice(2, 4) ? ` ’${key.slice(2, 4)}` : ''}`,
      baseline_revenue_cents: 0,
      revenue_cents: 0,
      baseline_hours: 0,
      hours: 0,
    };
    cur.baseline_revenue_cents += p.baseline_revenue_cents;
    cur.revenue_cents += p.revenue_cents;
    cur.baseline_hours += p.baseline_hours ?? 0;
    cur.hours += p.hours ?? 0;
    map.set(key, cur);
  }
  return [...map.values()].slice(0, 12);
}
