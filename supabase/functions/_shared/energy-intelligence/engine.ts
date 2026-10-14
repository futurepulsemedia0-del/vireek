// supabase/functions/_shared/energy-intelligence/engine.ts
//
// Vireek Energy Intelligence - pure, deterministic engine (no I/O, no LLM).
//
//   utility usage (bills) + climate normals -> weather-response model (base / cooling / heating)
//   -> anomalies -> equipment impact -> upgrade opportunities -> savings projection
//   -> 12-month demand forecast under scenarios.
//
// Honesty rules baked in:
//   * Every number is tagged with its basis (bills / EIA fallback / planning assumption).
//   * The weather model uses CLIMATE NORMALS (monthly means), not the actual weather of each
//     billing period. It explains seasonality; it does not claim to explain a specific storm.
//   * Planning assumptions are listed in report.assumptions so the UI can show them.
//   * Nothing is invented: no data -> a null + a data_quality warning, never a guess.

export const ENGINE_VERSION = "energy-intel-1.0.0";

const DAY_MS = 86_400_000;
const KBTU_PER_KWH = 3.412;
const KBTU_PER_THERM = 100;
const KWH_PER_THERM = 29.307;

export type Fuel = "electric" | "gas";
export type Confidence = "low" | "medium" | "high";
export type Severity = "low" | "medium" | "high";
export type EquipCategory = "cooling" | "heat_pump" | "heating" | "water_heating" | "controls" | "other";
export type Stage = "unknown" | "early" | "mid" | "late" | "past_life";
/** Mirrors the Rebate Intelligence measure keys so an opportunity can be fed straight into it. */
export type OpportunityMeasure =
  | "central_ac"
  | "heat_pump_hvac"
  | "furnace"
  | "smart_thermostat"
  | "insulation_air_sealing";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** One billing period. electric = kWh, gas = therms. period_end is the next meter-read date. */
export interface UsagePeriod {
  id: string;
  fuel: Fuel;
  period_start: string; // YYYY-MM-DD
  period_end: string; // YYYY-MM-DD (> start)
  usage: number;
  cost_cents: number | null;
}

export interface PropertyInput {
  living_sqft: number | null;
  year_built: number | null;
  /** 12 monthly mean temperatures in deg C, Jan..Dec (Property Intelligence / NASA POWER). */
  monthly_mean_c: number[] | null;
  /** EIA state residential average, cents/kWh - fallback only when bills carry no cost. */
  eia_cents_per_kwh: number | null;
}

export interface EquipmentInput {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_date: string | null;
  expected_lifespan_years: number | null;
  last_service_date: string | null;
  service_interval_months: number | null;
}

export interface TelemetryAnomalyInput {
  id: string;
  equipment_id: string | null;
  metric: string;
  kind: string;
  severity: Severity;
  direction: "high" | "low";
  explanation: string;
  detected_at: string;
}

export interface PredictionInput {
  equipment_id: string;
  failure_label: string;
  probability: number; // 0..1
  horizon_days: number;
}

export interface WeatherEventInput {
  event_type: string;
  severity: string | null;
  effective_at: string | null;
}

export interface EnergyInput {
  now: string; // ISO
  usage: UsagePeriod[];
  property: PropertyInput;
  equipment: EquipmentInput[];
  telemetry_anomalies: TelemetryAnomalyInput[];
  predictions: PredictionInput[];
  weather_events: WeatherEventInput[];
  /** equipment_id -> measured kWh over the last 30 days (from telemetry rollups). */
  measured_kwh_30d: Record<string, number>;
  /** Planning assumption for annual price escalation, %. */
  escalation_pct: number;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface FuelModel {
  fuel: Fuel;
  mode: "weather_regression" | "flat" | "none";
  periods: number;
  base_per_day: number;
  cdd_coef: number; // units per cooling degree-day
  hdd_coef: number; // units per heating degree-day
  r2: number;
  sigma_ratio: number; // robust relative residual scale
  median_ratio: number;
  excluded_outliers: number;
}

export interface FuelSummary {
  fuel: Fuel;
  unit: "kWh" | "therms";
  trailing_12m_usage: number | null;
  trailing_12m_cost_cents: number | null;
  coverage_pct: number; // of the last 365 days covered by bills
  annualized: boolean;
  normalized_annual_usage: number | null; // weather-normalized (model) or annualized actual
  rate_per_unit_cents: number | null;
  rate_source: "bills" | "eia" | "none";
  components: { base: number; cooling: number; heating: number } | null; // annual, in unit
  months: { key: string; actual: number | null; modeled: number | null }[];
  model: FuelModel;
}

export type AnomalyKind =
  | "usage_spike"
  | "usage_drop"
  | "yoy_increase"
  | "baseload_creep"
  | "rate_increase"
  | "equipment_signal";

export interface EnergyAnomaly {
  id: string;
  kind: AnomalyKind;
  severity: Severity;
  fuel: Fuel | null;
  equipment_id: string | null;
  period_start: string | null;
  period_end: string | null;
  observed: number | null;
  expected: number | null;
  deviation_pct: number | null;
  z: number | null;
  est_excess_cost_cents: number | null;
  title: string;
  explanation: string;
}

export interface EquipmentEnergyRow {
  id: string;
  label: string;
  equipment_type: string;
  category: EquipCategory;
  age_years: number | null;
  life_used_pct: number | null;
  stage: Stage;
  maintenance_overdue_months: number;
  efficiency: { metric: "SEER2" | "HSPF2" | "AFUE"; nominal: number; effective: number } | null;
  efficiency_loss_pct: number | null;
  attributed_kwh: number | null;
  attributed_therms: number | null;
  attributed_cost_cents: number | null;
  waste_cost_cents: number | null;
  basis: "weather_model" | "not_modelled";
  measured_kwh_30d: number | null;
  failure_risk: { label: string; probability: number; horizon_days: number } | null;
  signal_count: number;
  note: string | null;
}

export interface Opportunity {
  id: string;
  measure: OpportunityMeasure;
  title: string;
  equipment_id: string | null;
  rationale: string;
  kwh_saved: number; // negative = added electricity (fuel switching)
  therms_saved: number;
  effect: { cooling_kwh: number; heat_elec_kwh: number; heat_gas_therms: number };
  savings_cents: { low: number; expected: number; high: number } | null;
  confidence: Confidence;
  urgency: number; // 0..1
  priority: number;
  basis: string[];
  target_efficiency: { seer2?: number; hspf2?: number; afue?: number };
}

export interface Portfolio {
  savings_cents: { low: number; expected: number; high: number } | null;
  kwh_saved: number;
  therms_saved: number;
  pct_of_annual_cost: number | null;
  overlap_discount_pct: number;
}

export interface ForecastMonth {
  month: string; // YYYY-MM
  kwh: number;
  therms: number;
  cost_cents: number | null;
  kwh_low: number;
  kwh_high: number;
}

export interface ForecastScenario {
  key: "baseline" | "hot_summer" | "cold_winter" | "upgraded";
  label: string;
  months: ForecastMonth[];
  total_kwh: number;
  total_therms: number;
  total_cost_cents: number | null;
}

export interface EnergyReport {
  engine_version: string;
  generated_at: string;
  as_of: string | null; // last meter-read date
  totals: {
    annual_cost_cents: number | null;
    annual_kwh: number | null;
    annual_therms: number | null;
    eui_kbtu_sqft: number | null;
    reference_eui_kbtu_sqft: number | null;
    efficiency_score: number | null;
    grade: "A" | "B" | "C" | "D" | "E" | null;
    cost_per_sqft_cents: number | null;
    weather_sensitive_pct: number | null;
  };
  fuels: FuelSummary[];
  anomalies: EnergyAnomaly[];
  equipment: EquipmentEnergyRow[];
  opportunities: Opportunity[];
  portfolio: Portfolio;
  forecast: { scenarios: ForecastScenario[]; yoy_trend_pct: number; weather_risk_cents: number | null };
  weather: { heat_events: number; cold_events: number; storm_events: number; other_events: number; notes: string[] };
  assumptions: { id: string; label: string; value: string }[];
  confidence: Confidence;
  data_quality: { months_covered: number; r2_electric: number | null; r2_gas: number | null; warnings: string[] };
  actions: string[];
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, d = 0) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

export function parseDate(s: string | null | undefined): number | null {
  if (!s || typeof s !== "string") return null;
  const ms = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isFinite(ms) ? ms : null;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const daysInMonth = (year: number, month0: number) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
const NORMAL_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mad = (xs: number[], med = median(xs)) => median(xs.map((x) => Math.abs(x - med)));

// ---------------------------------------------------------------------------
// Climate -> degree days (mean-temperature method, base 65F)
// ---------------------------------------------------------------------------

const toF = (c: number) => (c * 9) / 5 + 32;

function validClimate(m: number[] | null): number[] | null {
  return Array.isArray(m) && m.length === 12 && m.every(num) ? m : null;
}

interface DD {
  hdd: number;
  cdd: number;
}
function ddForMonth(monthly: number[], month0: number, shiftC = 0): DD {
  const f = toF(monthly[month0] + shiftC);
  return { hdd: Math.max(0, 65 - f), cdd: Math.max(0, f - 65) };
}

/** Average per-day degree days across a date range (inclusive start, exclusive end). */
function periodDD(monthly: number[], startMs: number, days: number): DD {
  let h = 0;
  let c = 0;
  for (let i = 0; i < days; i++) {
    const d = ddForMonth(monthly, new Date(startMs + i * DAY_MS).getUTCMonth());
    h += d.hdd;
    c += d.cdd;
  }
  return { hdd: h / days, cdd: c / days };
}

export function normalDegreeDays(monthly: number[], shiftC = 0): { hdd: number; cdd: number } {
  let hdd = 0;
  let cdd = 0;
  for (let m = 0; m < 12; m++) {
    const d = ddForMonth(monthly, m, shiftC);
    hdd += d.hdd * NORMAL_DAYS[m];
    cdd += d.cdd * NORMAL_DAYS[m];
  }
  return { hdd, cdd };
}

// ---------------------------------------------------------------------------
// Period validation
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  startMs: number;
  endMs: number;
  days: number;
  usage: number;
  perDay: number;
  cost: number | null;
  dd: DD | null;
}

export function cleanPeriods(periods: UsagePeriod[], fuel: Fuel, monthly: number[] | null) {
  const warnings: string[] = [];
  const raw: Row[] = [];
  for (const p of periods) {
    if (p.fuel !== fuel) continue;
    const s = parseDate(p.period_start);
    const e = parseDate(p.period_end);
    if (s === null || e === null || e <= s || !num(p.usage) || p.usage < 0) continue;
    const days = Math.round((e - s) / DAY_MS);
    if (days < 1 || days > 70) continue;
    raw.push({
      id: p.id,
      startMs: s,
      endMs: e,
      days,
      usage: p.usage,
      perDay: p.usage / days,
      cost: num(p.cost_cents) && p.cost_cents >= 0 ? p.cost_cents : null,
      dd: monthly ? periodDD(monthly, s, days) : null,
    });
  }
  raw.sort((a, b) => a.startMs - b.startMs);
  const out: Row[] = [];
  let dropped = 0;
  for (const r of raw) {
    const prev = out[out.length - 1];
    if (prev && r.startMs < prev.endMs - 3 * DAY_MS) {
      dropped += 1;
      continue;
    }
    out.push(r);
  }
  if (dropped > 0) warnings.push(`${dropped} overlapping ${fuel} billing period(s) were ignored.`);
  return { rows: out, warnings };
}

// ---------------------------------------------------------------------------
// Weighted least squares + weather-response model
// ---------------------------------------------------------------------------

function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-9) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let k = r + 1; k < n; k++) s -= m[r][k] * x[k];
    x[r] = s / m[r][r];
  }
  return x;
}

function wls(X: number[][], y: number[], w: number[]): number[] | null {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const B = new Array<number>(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      B[a] += w[i] * X[i][a] * y[i];
      for (let b = 0; b < k; b++) A[a][b] += w[i] * X[i][a] * X[i][b];
    }
  }
  return solve(A, B);
}

interface Fit {
  base: number;
  cdd: number;
  hdd: number;
}

function fitRows(rows: Row[], allowCdd: boolean, allowHdd: boolean): Fit | null {
  if (rows.length < 6) return null;
  const range = (f: (r: Row) => number) => {
    const v = rows.map(f);
    return Math.max(...v) - Math.min(...v);
  };
  let useC = allowCdd && range((r) => r.dd?.cdd ?? 0) > 1e-6;
  let useH = allowHdd && range((r) => r.dd?.hdd ?? 0) > 1e-6;
  let intercept = true;
  for (let guard = 0; guard < 5; guard++) {
    const X = rows.map((r) => {
      const v: number[] = [];
      if (intercept) v.push(1);
      if (useC) v.push(r.dd!.cdd);
      if (useH) v.push(r.dd!.hdd);
      return v;
    });
    if (X[0].length === 0) return null;
    const beta = wls(X, rows.map((r) => r.perDay), rows.map((r) => r.days));
    if (!beta) return null;
    let i = 0;
    const base = intercept ? beta[i++] : 0;
    const cdd = useC ? beta[i++] : 0;
    const hdd = useH ? beta[i++] : 0;
    if (useC && cdd < 0) {
      useC = false;
      continue;
    }
    if (useH && hdd < 0) {
      useH = false;
      continue;
    }
    if (intercept && base < 0) {
      intercept = false;
      continue;
    }
    return { base, cdd, hdd };
  }
  return null;
}

const predPerDay = (f: Fit, r: Row) => f.base + f.cdd * (r.dd?.cdd ?? 0) + f.hdd * (r.dd?.hdd ?? 0);

function weightedR2(rows: Row[], f: Fit): number {
  const sw = rows.reduce((s, r) => s + r.days, 0);
  const mean = rows.reduce((s, r) => s + r.perDay * r.days, 0) / sw;
  let ssr = 0;
  let sst = 0;
  for (const r of rows) {
    ssr += r.days * (r.perDay - predPerDay(f, r)) ** 2;
    sst += r.days * (r.perDay - mean) ** 2;
  }
  return sst <= 1e-12 ? 0 : clamp(1 - ssr / sst, 0, 1);
}

export function buildModel(rows: Row[], fuel: Fuel, hasClimate: boolean) {
  const empty: FuelModel = {
    fuel, mode: "none", periods: rows.length, base_per_day: 0, cdd_coef: 0, hdd_coef: 0,
    r2: 0, sigma_ratio: 0.12, median_ratio: 0, excluded_outliers: 0,
  };
  if (rows.length === 0) return { model: empty, fit: null as Fit | null };

  let fit: Fit | null = hasClimate ? fitRows(rows, fuel === "electric", true) : null;
  let mode: FuelModel["mode"] = "weather_regression";
  if (!fit) {
    const sw = rows.reduce((s, r) => s + r.days, 0);
    fit = { base: rows.reduce((s, r) => s + r.usage, 0) / sw, cdd: 0, hdd: 0 };
    mode = "flat";
  }

  const ratios = (f: Fit, rs: Row[]) =>
    rs.map((r) => {
      const p = predPerDay(f, r);
      return p > 1e-9 ? r.perDay / p - 1 : 0;
    });
  const stats = (f: Fit) => {
    const rt = ratios(f, rows);
    const med = median(rt);
    return { rt, med, sigma: Math.max(0.08, 1.4826 * mad(rt, med)) };
  };

  // One robust pass: drop gross outliers and refit so a spike cannot hide itself in the fit.
  let st = stats(fit);
  let excluded = 0;
  if (mode === "weather_regression") {
    const keep = rows.filter((_, i) => Math.abs(st.rt[i] - st.med) / st.sigma <= 3.5);
    if (keep.length < rows.length && keep.length >= 6) {
      const refit = fitRows(keep, fuel === "electric", true);
      if (refit) {
        excluded = rows.length - keep.length;
        fit = refit;
        st = stats(fit);
      }
    }
  }
  const model: FuelModel = {
    fuel, mode, periods: rows.length, base_per_day: fit.base, cdd_coef: fit.cdd, hdd_coef: fit.hdd,
    r2: mode === "flat" ? 0 : weightedR2(rows, fit), sigma_ratio: st.sigma, median_ratio: st.med,
    excluded_outliers: excluded,
  };
  return { model, fit };
}

// ---------------------------------------------------------------------------
// Trailing window, rates, annual normalization
// ---------------------------------------------------------------------------

function overlap(r: Row, fromMs: number, toMs: number): number {
  const o = Math.min(r.endMs, toMs) - Math.max(r.startMs, fromMs);
  return o <= 0 ? 0 : o / DAY_MS;
}

function trailing(rows: Row[], asOfMs: number) {
  const from = asOfMs - 365 * DAY_MS;
  let usage = 0;
  let cost = 0;
  let costDays = 0;
  let usageDays = 0;
  for (const r of rows) {
    const d = overlap(r, from, asOfMs);
    if (d <= 0) continue;
    usageDays += d;
    usage += r.perDay * d;
    if (r.cost !== null) {
      cost += (r.cost / r.days) * d;
      costDays += d;
    }
  }
  return { usage, usageDays, cost, costDays };
}

function annualFromModel(model: FuelModel, monthly: number[] | null) {
  if (model.mode === "none") return null;
  if (!monthly || model.mode === "flat") {
    const base = model.base_per_day * 365;
    return { base, cooling: 0, heating: 0 };
  }
  let cooling = 0;
  let heating = 0;
  for (let m = 0; m < 12; m++) {
    const d = ddForMonth(monthly, m);
    cooling += model.cdd_coef * d.cdd * NORMAL_DAYS[m];
    heating += model.hdd_coef * d.hdd * NORMAL_DAYS[m];
  }
  return { base: model.base_per_day * 365, cooling, heating };
}

// ---------------------------------------------------------------------------
// Anomalies
// ---------------------------------------------------------------------------

const MIN_UNITS: Record<Fuel, number> = { electric: 100, gas: 8 };
const UNIT: Record<Fuel, string> = { electric: "kWh", gas: "therms" };
const FUEL_LABEL: Record<Fuel, string> = { electric: "Electric", gas: "Gas" };
const sevFor = (z: number, dev: number): Severity => (z >= 5 || dev >= 0.5 ? "high" : z >= 3.5 ? "medium" : "low");

function billAnomalies(fuel: Fuel, rows: Row[], model: FuelModel, fit: Fit | null, rate: number | null, asOfMs: number): EnergyAnomaly[] {
  const out: EnergyAnomaly[] = [];
  if (!fit || rows.length < 6) return out;
  const flagged = new Set<string>();

  for (const r of rows) {
    const p = predPerDay(fit, r);
    const expected = p * r.days * (1 + model.median_ratio);
    if (p <= 0 || expected < MIN_UNITS[fuel]) continue;
    const dev = r.usage / (p * r.days) - 1 - model.median_ratio;
    const z = dev / model.sigma_ratio;
    if (Math.abs(z) < 3 || Math.abs(dev) < 0.15) continue;
    const up = dev > 0;
    flagged.add(r.id);
    out.push({
      id: `${fuel}-${up ? "spike" : "drop"}-${isoDay(r.startMs)}`,
      kind: up ? "usage_spike" : "usage_drop",
      severity: sevFor(Math.abs(z), Math.abs(dev)),
      fuel, equipment_id: null,
      period_start: isoDay(r.startMs), period_end: isoDay(r.endMs),
      observed: round(r.usage), expected: round(expected),
      deviation_pct: round(dev * 100, 1), z: round(z, 1),
      est_excess_cost_cents: up && rate !== null ? Math.round((r.usage - expected) * rate) : null,
      title: `${FUEL_LABEL[fuel]} use ${up ? "above" : "below"} the seasonal pattern`,
      explanation: `${isoDay(r.startMs)} to ${isoDay(r.endMs)}: ${round(r.usage).toLocaleString("en-US")} ${UNIT[fuel]} billed vs about ${round(expected).toLocaleString("en-US")} expected for that time of year (${up ? "+" : ""}${round(dev * 100)}%). ${up ? "Look for a failing or stuck-on unit, a thermostat or schedule change, new load, or an estimated/mis-read bill." : "Look for vacancy, an estimated bill, or equipment that stopped running."}`,
    });
  }

  // Year-over-year (climate normals are identical year to year, so a jump is non-weather by construction).
  const from12 = asOfMs - 365 * DAY_MS;
  for (const r of rows) {
    if (r.endMs < from12 || flagged.has(r.id)) continue;
    const prior = rows.find((q) => Math.abs(q.startMs - (r.startMs - 365 * DAY_MS)) <= 20 * DAY_MS);
    if (!prior || prior.perDay * r.days < MIN_UNITS[fuel]) continue;
    const dev = r.perDay / prior.perDay - 1;
    if (dev < 0.25) continue;
    const delta = (r.perDay - prior.perDay) * r.days;
    out.push({
      id: `${fuel}-yoy-${isoDay(r.startMs)}`,
      kind: "yoy_increase",
      severity: dev >= 0.5 ? "high" : dev >= 0.35 ? "medium" : "low",
      fuel, equipment_id: null,
      period_start: isoDay(r.startMs), period_end: isoDay(r.endMs),
      observed: round(r.usage), expected: round(prior.perDay * r.days),
      deviation_pct: round(dev * 100, 1), z: null,
      est_excess_cost_cents: rate !== null ? Math.round(delta * rate) : null,
      title: `${FUEL_LABEL[fuel]} use up ${round(dev * 100)}% vs the same period last year`,
      explanation: `Same season, same climate normals, ${round(dev * 100)}% more ${UNIT[fuel]} than a year earlier. That points to equipment performance, behavior, or added load rather than weather.`,
    });
  }

  // Baseload creep: the lowest-use months drift up year over year.
  const lowest = (fromMs: number, toMs: number) =>
    rows.filter((r) => r.startMs >= fromMs && r.endMs <= toMs).map((r) => r.perDay).sort((a, b) => a - b).slice(0, 3);
  const cur = lowest(from12, asOfMs + DAY_MS);
  const prev = lowest(from12 - 365 * DAY_MS, from12 + 5 * DAY_MS);
  if (cur.length === 3 && prev.length === 3) {
    const a = cur.reduce((s, v) => s + v, 0) / 3;
    const b = prev.reduce((s, v) => s + v, 0) / 3;
    if (b > 0 && a / b - 1 >= 0.15 && a * 30 >= MIN_UNITS[fuel]) {
      out.push({
        id: `${fuel}-baseload-creep`,
        kind: "baseload_creep",
        severity: a / b - 1 >= 0.3 ? "medium" : "low",
        fuel, equipment_id: null, period_start: null, period_end: null,
        observed: round(a, 1), expected: round(b, 1), deviation_pct: round((a / b - 1) * 100, 1), z: null,
        est_excess_cost_cents: rate !== null ? Math.round((a - b) * 365 * rate) : null,
        title: `${FUEL_LABEL[fuel]} baseload is creeping up`,
        explanation: `Your three lowest-use months now average ${round(a, 1)} ${UNIT[fuel]}/day vs ${round(b, 1)} a year ago. Always-on loads (standby equipment, a failing water heater element, pool/well pumps, added devices) are the usual cause.`,
      });
    }
  }

  // Billed rate jumps (tariff / plan / fees), not a usage problem.
  const costed = rows.filter((r) => r.cost !== null && r.usage >= MIN_UNITS[fuel] / 2);
  for (let i = 3; i < costed.length; i++) {
    const hist = costed.slice(Math.max(0, i - 6), i).map((r) => r.cost! / r.usage);
    const base = median(hist);
    const now = costed[i].cost! / costed[i].usage;
    if (base <= 0 || costed[i].endMs < from12) continue;
    const dev = now / base - 1;
    if (dev < 0.2) continue;
    out.push({
      id: `${fuel}-rate-${isoDay(costed[i].startMs)}`,
      kind: "rate_increase",
      severity: dev >= 0.35 ? "medium" : "low",
      fuel, equipment_id: null,
      period_start: isoDay(costed[i].startMs), period_end: isoDay(costed[i].endMs),
      observed: round(now, 2), expected: round(base, 2), deviation_pct: round(dev * 100, 1), z: null,
      est_excess_cost_cents: Math.round((now - base) * costed[i].usage),
      title: `${FUEL_LABEL[fuel]} price per ${fuel === "electric" ? "kWh" : "therm"} jumped ${round(dev * 100)}%`,
      explanation: `Billed ${round(now, 2)} cents per ${UNIT[fuel]} vs a median of ${round(base, 2)} over the prior bills. Check for a rate-plan change, a seasonal/tiered tariff, demand or one-off fees.`,
    });
  }

  const sevRank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || (b.period_start ?? "").localeCompare(a.period_start ?? ""));
}

const ENERGY_METRICS = new Set([
  "power_kw", "energy_kwh", "compressor_current", "fan_current", "delta_t", "superheat", "subcooling",
  "filter_dp", "discharge_pressure", "suction_pressure", "runtime_hours", "supply_air_temp", "return_air_temp",
]);

export function energyImpactHint(metric: string, direction: "high" | "low"): string {
  switch (metric) {
    case "filter_dp": return "Restricted airflow makes the blower and compressor work harder and cuts capacity.";
    case "delta_t": return direction === "low" ? "Low temperature split usually means lost capacity (charge, airflow or coil) and longer run time." : "High temperature split can mean restricted airflow.";
    case "superheat": case "subcooling": return "Off-spec refrigerant charge typically costs efficiency and shortens compressor life.";
    case "compressor_current": case "fan_current": return direction === "high" ? "Higher motor draw than baseline means more kWh for the same output." : "Lower draw can mean reduced airflow or a failing component.";
    case "power_kw": case "energy_kwh": return direction === "high" ? "Measured consumption is above this unit's own baseline." : "Measured consumption fell below baseline: confirm it is still delivering.";
    case "runtime_hours": return "Run time outside baseline changes energy use directly.";
    default: return "This reading can degrade efficiency if it persists.";
  }
}

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

export function categorize(type: string): EquipCategory {
  const t = type.toLowerCase();
  if (/heat\s*pump|mini[\s-]?split/.test(t)) return "heat_pump";
  if (/water\s*heater|hot\s*water/.test(t)) return "water_heating";
  if (/thermostat|controller|zoning/.test(t)) return "controls";
  if (/furnace|boiler|air\s*handler.*heat|heater|heating/.test(t)) return "heating";
  if (/a\/c|\bac\b|air\s*cond|condens|cooling|chiller|rtu|rooftop|split/.test(t)) return "cooling";
  return "other";
}

/** Federal-minimum SEER2-equivalent by install year (conservative assumption for an unlabelled unit). */
function nominalSeer2(year: number): number {
  return year < 2006 ? 9.5 : year < 2015 ? 12.4 : year < 2023 ? 13.3 : 13.4;
}
function nominalHspf2(year: number): number {
  return year < 2006 ? 5.5 : year < 2023 ? 6.5 : 7.5;
}
function nominalAfue(year: number): number {
  return year < 1992 ? 65 : 80;
}

const AGE_LOSS_PER_YEAR = 0.01;
const AGE_LOSS_CAP = 0.25;
const SERVICE_LOSS_PER_YEAR_OVERDUE = 0.04;
const SERVICE_LOSS_CAP = 0.1;
const TARGET_SEER2 = 16;
const TARGET_AFUE = 96;
const TARGET_HSPF2 = 8.5;
const THERMOSTAT_SAVING = 0.08;
const ENVELOPE_SAVING = 0.15;
const BAND_LOW = 0.65;
const BAND_HIGH = 1.25;

function assessUnit(eq: EquipmentInput, nowMs: number) {
  const installMs = parseDate(eq.install_date);
  const life = num(eq.expected_lifespan_years) && eq.expected_lifespan_years > 0 ? eq.expected_lifespan_years : null;
  const age = installMs === null ? null : Math.max(0, (nowMs - installMs) / (365.25 * DAY_MS));
  const used = age !== null && life !== null ? age / life : null;
  const stage: Stage = used === null ? "unknown" : used >= 1 ? "past_life" : used >= 0.8 ? "late" : used >= 0.5 ? "mid" : "early";
  const interval = num(eq.service_interval_months) && eq.service_interval_months > 0 ? eq.service_interval_months : 12;
  const lastMs = parseDate(eq.last_service_date);
  const sinceMs = lastMs ?? installMs;
  const overdue = sinceMs === null ? 0 : Math.max(0, (nowMs - sinceMs) / (30.44 * DAY_MS) - interval);
  return { installMs, age, used, stage, overdueMonths: Math.round(overdue), life };
}

// ---------------------------------------------------------------------------
// Public: projection helpers (also used by the dashboard once a rebate net cost is known)
// ---------------------------------------------------------------------------

export function projectSavings(annualCents: number, years: number, escalationPct: number, discountPct = 0) {
  const out: { year: number; annual_cents: number; cumulative_cents: number }[] = [];
  let cum = 0;
  for (let y = 1; y <= years; y++) {
    const a = (annualCents * (1 + escalationPct / 100) ** (y - 1)) / (1 + discountPct / 100) ** y;
    cum += a;
    out.push({ year: y, annual_cents: Math.round(a), cumulative_cents: Math.round(cum) });
  }
  return out;
}

/** Years until cumulative (escalating) savings cover netCostCents; interpolated; null if > 30y. */
export function paybackYears(netCostCents: number, annualCents: number, escalationPct: number): number | null {
  if (netCostCents <= 0) return 0;
  if (annualCents <= 0) return null;
  let cum = 0;
  for (let y = 1; y <= 30; y++) {
    const a = annualCents * (1 + escalationPct / 100) ** (y - 1);
    if (cum + a >= netCostCents) return round(y - 1 + (netCostCents - cum) / a, 1);
    cum += a;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function gradeFor(ratio: number): "A" | "B" | "C" | "D" | "E" {
  return ratio <= 0.7 ? "A" : ratio <= 0.9 ? "B" : ratio <= 1.1 ? "C" : ratio <= 1.4 ? "D" : "E";
}

export function analyzeEnergy(input: EnergyInput): EnergyReport {
  const nowMs = parseDate(input.now) ?? Date.now();
  const monthly = validClimate(input.property.monthly_mean_c);
  const warnings: string[] = [];
  const esc = clamp(num(input.escalation_pct) ? input.escalation_pct : 2.5, 0, 15);

  const el = cleanPeriods(input.usage, "electric", monthly);
  const gs = cleanPeriods(input.usage, "gas", monthly);
  warnings.push(...el.warnings, ...gs.warnings);

  const lastEnd = Math.max(0, ...el.rows.map((r) => r.endMs), ...gs.rows.map((r) => r.endMs));
  const asOfMs = lastEnd > 0 ? lastEnd : nowMs;
  const firstStart = Math.min(...[...el.rows, ...gs.rows].map((r) => r.startMs), asOfMs);
  const monthsCovered = lastEnd > 0 ? Math.round(((asOfMs - firstStart) / DAY_MS / 30.44) * 10) / 10 : 0;

  if (el.rows.length === 0 && gs.rows.length === 0) {
    warnings.push("No billing history yet. Add at least 12 monthly electric (and gas) bills to unlock the analysis.");
  }
  if (lastEnd > 0 && nowMs - lastEnd > 75 * DAY_MS) warnings.push("Latest bill is more than 75 days old. Add recent bills to keep the analysis current.");
  if (!monthly && lastEnd > 0) warnings.push("No climate data for this site, so seasonality is not modelled. Run Property Intelligence on the site to enable weather normalization.");
  if (input.property.living_sqft === null) warnings.push("Square footage is unknown, so efficiency scoring (kBtu/sq ft) is unavailable.");

  const E = buildModel(el.rows, "electric", monthly !== null);
  const G = buildModel(gs.rows, "gas", monthly !== null);
  const models = { electric: E, gas: G };
  const rowsBy = { electric: el.rows, gas: gs.rows };

  // Rates
  const rateOf = (fuel: Fuel): { rate: number | null; src: "bills" | "eia" | "none" } => {
    const rs = rowsBy[fuel].filter((r) => r.cost !== null && r.usage > 0 && r.endMs >= asOfMs - 400 * DAY_MS);
    const u = rs.reduce((s, r) => s + r.usage, 0);
    if (u > 0 && rs.length >= 3) return { rate: rs.reduce((s, r) => s + r.cost!, 0) / u, src: "bills" };
    if (fuel === "electric" && num(input.property.eia_cents_per_kwh)) return { rate: input.property.eia_cents_per_kwh, src: "eia" };
    return { rate: null, src: "none" };
  };
  const rates = { electric: rateOf("electric"), gas: rateOf("gas") };
  if (el.rows.length > 0 && rates.electric.src === "eia") warnings.push("Electric bills carry no cost, so the state average rate (EIA) is used for dollar figures.");
  if (el.rows.length > 0 && rates.electric.src === "none") warnings.push("No electric cost data. Enter bill amounts to get dollar figures.");
  if (gs.rows.length > 0 && rates.gas.src === "none") warnings.push("No gas cost data. Enter gas bill amounts to value gas savings.");

  // Fuel summaries
  const summarize = (fuel: Fuel): FuelSummary => {
    const rows = rowsBy[fuel];
    const { model } = models[fuel];
    const t = trailing(rows, asOfMs);
    const coverage = rows.length ? clamp(t.usageDays / 365, 0, 1) : 0;
    const annualized = coverage > 0 && coverage < 0.9;
    const comps = annualFromModel(model, monthly);
    const actual12 = rows.length && t.usageDays > 0 ? (t.usage / t.usageDays) * 365 : null;
    const normalized = comps && model.mode !== "none" && model.mode !== "flat" && model.periods >= 9
      ? comps.base + comps.cooling + comps.heating
      : actual12;
    const cost12 = t.costDays > 0 ? (t.cost / t.costDays) * 365 : null;
    // 12 calendar months ending at as-of: actual vs modeled
    const months: FuelSummary["months"] = [];
    const end = new Date(asOfMs - DAY_MS);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
      const from = d.getTime();
      const to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      let a = 0;
      let covered = 0;
      for (const r of rows) {
        const o = overlap(r, from, to);
        a += r.perDay * o;
        covered += o;
      }
      const dim = (to - from) / DAY_MS;
      const dd = monthly ? ddForMonth(monthly, d.getUTCMonth()) : { hdd: 0, cdd: 0 };
      const modeled = model.mode === "none" ? null : (model.base_per_day + model.cdd_coef * dd.cdd + model.hdd_coef * dd.hdd) * dim;
      months.push({ key: monthKey(from), actual: covered >= dim * 0.6 ? round((a / covered) * dim) : null, modeled: modeled === null ? null : round(modeled) });
    }
    return {
      fuel, unit: fuel === "electric" ? "kWh" : "therms",
      trailing_12m_usage: actual12 === null ? null : round(actual12),
      trailing_12m_cost_cents: cost12 === null ? null : Math.round(cost12),
      coverage_pct: round(coverage * 100), annualized,
      normalized_annual_usage: normalized === null ? null : round(normalized),
      rate_per_unit_cents: rates[fuel].rate === null ? null : round(rates[fuel].rate!, 3),
      rate_source: rates[fuel].src,
      components: comps ? { base: round(comps.base), cooling: round(comps.cooling), heating: round(comps.heating) } : null,
      months, model,
    };
  };
  const fuels = [summarize("electric"), summarize("gas")].filter((f) => f.model.mode !== "none");
  const fe = fuels.find((f) => f.fuel === "electric") ?? null;
  const fg = fuels.find((f) => f.fuel === "gas") ?? null;
  if (fe && fe.coverage_pct < 90) warnings.push(`Electric bills cover ${fe.coverage_pct}% of the last 12 months, so annual figures are extrapolated.`);
  if (fg && fg.coverage_pct < 90) warnings.push(`Gas bills cover ${fg.coverage_pct}% of the last 12 months, so annual figures are extrapolated.`);

  // Annual dollars
  const costOf = (f: FuelSummary | null) => {
    if (!f) return 0;
    if (f.trailing_12m_cost_cents !== null && f.coverage_pct >= 90) return f.trailing_12m_cost_cents;
    const u = f.normalized_annual_usage;
    const r = f.rate_per_unit_cents;
    return u !== null && r !== null ? Math.round(u * r) : f.trailing_12m_cost_cents ?? 0;
  };
  const knownCost = (fe && (fe.rate_per_unit_cents !== null || fe.trailing_12m_cost_cents !== null)) || (fg && (fg.rate_per_unit_cents !== null || fg.trailing_12m_cost_cents !== null));
  const annualCost = knownCost ? costOf(fe) + costOf(fg) : null;

  const annualKwh = fe?.normalized_annual_usage ?? null;
  const annualTherms = fg?.normalized_annual_usage ?? null;
  const sqft = input.property.living_sqft;
  const hasUsage = annualKwh !== null || annualTherms !== null;
  const eui = hasUsage && sqft ? ((annualKwh ?? 0) * KBTU_PER_KWH + (annualTherms ?? 0) * KBTU_PER_THERM) / sqft : null;
  const nd = monthly ? normalDegreeDays(monthly) : null;
  const refEui = nd ? 30 + 0.0035 * nd.hdd + 0.004 * nd.cdd : sqft ? 45 : null;
  const ratio = eui !== null && refEui ? eui / refEui : null;
  const score = ratio === null ? null : clamp(Math.round(110 - 50 * ratio), 0, 100);

  const sensKwh = fe?.components ? fe.components.cooling + fe.components.heating : 0;
  const sensTherms = fg?.components ? fg.components.heating : 0;
  const totalKwhEq = (annualKwh ?? 0) + (annualTherms ?? 0) * KWH_PER_THERM;
  const weatherSensitivePct = totalKwhEq > 0 ? round(((sensKwh + sensTherms * KWH_PER_THERM) / totalKwhEq) * 100) : null;

  // Anomalies
  const anomalies: EnergyAnomaly[] = [
    ...billAnomalies("electric", el.rows, E.model, E.fit, rates.electric.rate, asOfMs),
    ...billAnomalies("gas", gs.rows, G.model, G.fit, rates.gas.rate, asOfMs),
  ];
  const eqById = new Map(input.equipment.map((e) => [e.id, e]));
  for (const t of input.telemetry_anomalies) {
    if (!ENERGY_METRICS.has(t.metric) || !t.equipment_id || !eqById.has(t.equipment_id)) continue;
    const eq = eqById.get(t.equipment_id)!;
    anomalies.push({
      id: `tele-${t.id}`, kind: "equipment_signal", severity: t.severity, fuel: null, equipment_id: t.equipment_id,
      period_start: t.detected_at.slice(0, 10), period_end: null, observed: null, expected: null, deviation_pct: null, z: null,
      est_excess_cost_cents: null,
      title: `${[eq.make, eq.model].filter(Boolean).join(" ") || eq.equipment_type}: ${t.metric.replace(/_/g, " ")} ${t.direction === "high" ? "high" : "low"}`,
      explanation: `${t.explanation} ${energyImpactHint(t.metric, t.direction)}`,
    });
  }
  const sevRank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  anomalies.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  // Equipment impact ------------------------------------------------------
  const active = input.equipment;
  const cat = new Map(active.map((e) => [e.id, categorize(e.equipment_type)]));
  const coolers = active.filter((e) => ["cooling", "heat_pump"].includes(cat.get(e.id)!));
  const hps = active.filter((e) => cat.get(e.id) === "heat_pump");
  const gasHeaters = active.filter((e) => cat.get(e.id) === "heating");
  const heatElecLoad = fe?.model.mode === "weather_regression" && fe.components ? fe.components.heating : 0;
  const coolLoad = fe?.model.mode === "weather_regression" && fe.components ? fe.components.cooling : 0;
  const heatGasLoad = fg?.model.mode === "weather_regression" && fg.components ? fg.components.heating : 0;
  const heatElecOwners = hps.length > 0 ? hps : gasHeaters.length > 0 && heatGasLoad === 0 ? gasHeaters : [];
  const gasOwners = gasHeaters;

  const rowsOut: EquipmentEnergyRow[] = active.map((eq) => {
    const c = cat.get(eq.id)!;
    const a = assessUnit(eq, nowMs);
    const year = a.installMs === null ? null : new Date(a.installMs).getUTCFullYear();
    let eff: EquipmentEnergyRow["efficiency"] = null;
    let kwh: number | null = null;
    let therms: number | null = null;
    let note: string | null = null;
    const loss = a.age === null ? null : clamp(a.age * AGE_LOSS_PER_YEAR, 0, AGE_LOSS_CAP) + clamp((a.overdueMonths / 12) * SERVICE_LOSS_PER_YEAR_OVERDUE, 0, SERVICE_LOSS_CAP);
    const mkEff = (metric: "SEER2" | "HSPF2" | "AFUE", nominal: number) => {
      if (loss === null) return null;
      return { metric, nominal, effective: round(nominal * (1 - loss), metric === "AFUE" ? 0 : 1) };
    };
    if (year !== null) {
      if (c === "cooling" || c === "heat_pump") eff = mkEff("SEER2", nominalSeer2(year));
      else if (c === "heating") eff = mkEff("AFUE", nominalAfue(year));
    }
    if (c === "cooling" || c === "heat_pump") {
      if (coolLoad > 0 && coolers.length > 0) kwh = (kwh ?? 0) + coolLoad / coolers.length;
    }
    if (heatElecOwners.some((e) => e.id === eq.id) && heatElecLoad > 0) kwh = (kwh ?? 0) + heatElecLoad / heatElecOwners.length;
    if (gasOwners.some((e) => e.id === eq.id) && heatGasLoad > 0) therms = heatGasLoad / gasOwners.length;
    if (c === "water_heating") note = "Water heating is baseload, which a weather model cannot isolate. Add telemetry or a sub-meter for measured impact.";
    else if (c === "controls") note = "Controls shape the weather-driven load; see the smart-thermostat opportunity.";
    else if (c === "other") note = "Not modelled: no weather response to attribute.";
    const rE = rates.electric.rate;
    const rG = rates.gas.rate;
    const cost = (kwh !== null && rE !== null ? kwh * rE : 0) + (therms !== null && rG !== null ? therms * rG : 0);
    const hasCost = (kwh !== null && rE !== null) || (therms !== null && rG !== null);
    const wasteFrac = eff ? 1 - eff.effective / eff.nominal : null;
    const preds = input.predictions.filter((p) => p.equipment_id === eq.id).sort((x, y) => y.probability - x.probability);
    return {
      id: eq.id,
      label: [eq.make, eq.model].filter(Boolean).join(" ").trim() || eq.equipment_type,
      equipment_type: eq.equipment_type, category: c,
      age_years: a.age === null ? null : round(a.age, 1),
      life_used_pct: a.used === null ? null : Math.round(a.used * 100),
      stage: a.stage, maintenance_overdue_months: a.overdueMonths,
      efficiency: eff, efficiency_loss_pct: loss === null ? null : round(loss * 100, 1),
      attributed_kwh: kwh === null ? null : round(kwh), attributed_therms: therms === null ? null : round(therms),
      attributed_cost_cents: hasCost ? Math.round(cost) : null,
      waste_cost_cents: hasCost && wasteFrac !== null ? Math.round(cost * wasteFrac) : null,
      basis: (kwh !== null || therms !== null ? "weather_model" : "not_modelled") as EquipmentEnergyRow["basis"],
      measured_kwh_30d: num(input.measured_kwh_30d[eq.id]) ? round(input.measured_kwh_30d[eq.id]) : null,
      failure_risk: preds[0] ? { label: preds[0].failure_label, probability: round(preds[0].probability, 2), horizon_days: preds[0].horizon_days } : null,
      signal_count: anomalies.filter((x) => x.equipment_id === eq.id).length,
      note,
    };
  }).sort((a, b) => (b.attributed_cost_cents ?? -1) - (a.attributed_cost_cents ?? -1));

  // Confidence ------------------------------------------------------------
  const r2e = fe && fe.model.mode === "weather_regression" ? fe.model.r2 : null;
  const r2g = fg && fg.model.mode === "weather_regression" ? fg.model.r2 : null;
  const bestR2 = Math.max(r2e ?? 0, r2g ?? 0);
  const billsRate = rates.electric.src === "bills" || rates.gas.src === "bills";
  const confidence: Confidence = monthsCovered >= 11.5 && bestR2 >= 0.8 && billsRate ? "high" : monthsCovered >= 8.5 && bestR2 >= 0.5 ? "medium" : "low";
  if (r2e !== null && r2e < 0.5) warnings.push("Electric use is only loosely explained by weather (R2 under 0.5). Savings estimates are lower confidence.");

  // Opportunities ---------------------------------------------------------
  const rE = rates.electric.rate;
  const rG = rates.gas.rate;
  const valueCents = (kwh: number, therms: number): number | null => {
    if (kwh !== 0 && rE === null) return null;
    if (therms !== 0 && rG === null) return null;
    return Math.round(kwh * (rE ?? 0) + therms * (rG ?? 0));
  };
  const band = (expected: number | null) =>
    expected === null ? null : { low: Math.round(expected * BAND_LOW), expected, high: Math.round(expected * BAND_HIGH) };
  const urgencyOf = (id: string | null) => {
    if (!id) return 0.2;
    const row = rowsOut.find((r) => r.id === id);
    if (!row) return 0.2;
    return clamp(Math.max((row.life_used_pct ?? 0) / 100, row.failure_risk?.probability ?? 0, row.signal_count > 0 ? 0.5 : 0), 0, 1);
  };
  const opps: Opportunity[] = [];
  const push = (o: Omit<Opportunity, "savings_cents" | "priority" | "urgency" | "confidence"> & { urgency?: number }) => {
    const exp = valueCents(o.kwh_saved, o.therms_saved);
    const urgency = o.urgency ?? urgencyOf(o.equipment_id);
    opps.push({
      ...o, savings_cents: band(exp), urgency: round(urgency, 2),
      confidence, priority: round((exp ?? o.kwh_saved * 12) * (1 + 0.5 * urgency), 0),
    });
  };
  const planBasis = ["Weather-response model of your bills", "Published program averages for planning"];
  for (const row of rowsOut) {
    if (!row.efficiency || row.basis !== "weather_model") continue;
    if (row.category === "cooling" || row.category === "heat_pump") {
      const share = row.attributed_kwh ?? 0;
      const coolPart = coolLoad > 0 && coolers.length > 0 ? coolLoad / coolers.length : 0;
      const f = clamp(1 - row.efficiency.effective / TARGET_SEER2, 0, 0.6);
      if (f >= 0.12 && coolPart > 0) {
        const saved = coolPart * f;
        push({
          id: `cooling-${row.id}`, measure: row.category === "heat_pump" ? "heat_pump_hvac" : "central_ac",
          title: `Replace ${row.label} with a ${TARGET_SEER2}+ SEER2 system`,
          equipment_id: row.id,
          rationale: `Est. ${row.efficiency.effective} SEER2 today (${row.efficiency.nominal} nominal for its install year, minus age and service losses). Moving to ${TARGET_SEER2} cuts about ${round(f * 100)}% of its cooling energy (${round(coolPart).toLocaleString("en-US")} kWh/yr modelled${share > coolPart ? ", plus heating" : ""}).`,
          kwh_saved: round(saved), therms_saved: 0,
          effect: { cooling_kwh: saved, heat_elec_kwh: 0, heat_gas_therms: 0 },
          basis: [...planBasis, "Federal-minimum efficiency assumed for install year"],
          target_efficiency: { seer2: TARGET_SEER2 },
        });
      }
    }
    if (row.category === "heating" && row.attributed_therms) {
      const afueEff = row.efficiency.effective;
      const f = clamp(1 - afueEff / TARGET_AFUE, 0, 0.4);
      if (f >= 0.1 && afueEff < 90) {
        const saved = row.attributed_therms * f;
        push({
          id: `furnace-${row.id}`, measure: "furnace",
          title: `Replace ${row.label} with a ${TARGET_AFUE}% AFUE furnace`,
          equipment_id: row.id,
          rationale: `Est. ${round(afueEff)}% efficient today. A ${TARGET_AFUE}% unit saves about ${round(f * 100)}% of its ${round(row.attributed_therms).toLocaleString("en-US")} therms/yr.`,
          kwh_saved: 0, therms_saved: round(saved),
          effect: { cooling_kwh: 0, heat_elec_kwh: 0, heat_gas_therms: saved },
          basis: [...planBasis, "Federal-minimum efficiency assumed for install year"],
          target_efficiency: { afue: TARGET_AFUE },
        });
      }
      // Fuel switch: gas heat -> heat pump, only when both rates are known and it actually saves money.
      if (rE !== null && rG !== null) {
        const deliveredKwh = row.attributed_therms * KWH_PER_THERM * (afueEff / 100);
        const added = deliveredKwh / (TARGET_HSPF2 / KBTU_PER_KWH);
        const net = row.attributed_therms * rG - added * rE;
        if (net > 0) {
          push({
            id: `hp-switch-${row.id}`, measure: "heat_pump_hvac",
            title: `Switch ${row.label} heating to a heat pump`,
            equipment_id: row.id,
            rationale: `Removes ${round(row.attributed_therms).toLocaleString("en-US")} therms/yr of gas and adds about ${round(added).toLocaleString("en-US")} kWh at ${TARGET_HSPF2} HSPF2. At your current rates this is cost-saving.`,
            kwh_saved: -round(added), therms_saved: round(row.attributed_therms),
            effect: { cooling_kwh: 0, heat_elec_kwh: -added, heat_gas_therms: row.attributed_therms },
            basis: [...planBasis, "Seasonal heat-pump efficiency taken as HSPF2 / 3.412"],
            target_efficiency: { hspf2: TARGET_HSPF2, seer2: TARGET_SEER2 },
          });
        }
      }
    }
  }
  const hasThermostat = active.some((e) => cat.get(e.id) === "controls");
  if (!hasThermostat && sensKwh + sensTherms > 0) {
    push({
      id: "smart-thermostat", measure: "smart_thermostat", title: "Install a smart thermostat with scheduling",
      equipment_id: null,
      rationale: `Program averages put thermostat savings near ${round(THERMOSTAT_SAVING * 100)}% of heating and cooling energy. Applied to this property's modelled weather-driven load.`,
      kwh_saved: round((coolLoad + heatElecLoad) * THERMOSTAT_SAVING), therms_saved: round(heatGasLoad * THERMOSTAT_SAVING),
      effect: { cooling_kwh: coolLoad * THERMOSTAT_SAVING, heat_elec_kwh: heatElecLoad * THERMOSTAT_SAVING, heat_gas_therms: heatGasLoad * THERMOSTAT_SAVING },
      basis: planBasis, target_efficiency: {}, urgency: 0.3,
    });
  }
  const yb = input.property.year_built;
  if ((yb === null || yb < 2000) && (weatherSensitivePct ?? 0) >= 25 && sensKwh + sensTherms > 0) {
    push({
      id: "envelope", measure: "insulation_air_sealing", title: "Air sealing and insulation upgrade",
      equipment_id: null,
      rationale: `${yb ? `Built ${yb}; ` : ""}${weatherSensitivePct}% of energy is weather-driven. Program averages show about ${round(ENVELOPE_SAVING * 100)}% savings on heating and cooling.`,
      kwh_saved: round((coolLoad + heatElecLoad) * ENVELOPE_SAVING), therms_saved: round(heatGasLoad * ENVELOPE_SAVING),
      effect: { cooling_kwh: coolLoad * ENVELOPE_SAVING, heat_elec_kwh: heatElecLoad * ENVELOPE_SAVING, heat_gas_therms: heatGasLoad * ENVELOPE_SAVING },
      basis: [...planBasis, yb === null ? "Build year unknown" : `Built ${yb}`], target_efficiency: {}, urgency: 0.25,
    });
  }
  opps.sort((a, b) => b.priority - a.priority);

  // Portfolio: combine multiplicatively per load so overlapping measures are never double counted.
  const comb = (key: "cooling_kwh" | "heat_elec_kwh" | "heat_gas_therms", load: number) => {
    if (load <= 0) return 0;
    const pos = opps.map((o) => clamp(o.effect[key] / load, 0, 0.9));
    return load * (1 - pos.reduce((p, f) => p * (1 - f), 1));
  };
  const added = opps.reduce((s, o) => s + Math.max(0, -o.effect.heat_elec_kwh), 0);
  const heatElecSaved = comb("heat_elec_kwh", heatElecLoad);
  const pf = {
    cooling: comb("cooling_kwh", coolLoad),
    heatE: heatElecSaved - added,
    heatG: comb("heat_gas_therms", heatGasLoad),
  };
  const pfExpected = valueCents(pf.cooling + pf.heatE, pf.heatG);
  const sumExpected = opps.reduce((s, o) => s + (o.savings_cents?.expected ?? 0), 0);
  const overlapFrac = sumExpected > 0 && pfExpected !== null ? clamp(1 - pfExpected / sumExpected, 0, 1) : 0;
  const portfolio: Portfolio = {
    savings_cents: pfExpected === null || opps.length === 0 ? null : {
      expected: pfExpected,
      low: Math.round(opps.reduce((s, o) => s + (o.savings_cents?.low ?? 0), 0) * (1 - overlapFrac)),
      high: Math.round(opps.reduce((s, o) => s + (o.savings_cents?.high ?? 0), 0) * (1 - overlapFrac)),
    },
    kwh_saved: round(pf.cooling + pf.heatE), therms_saved: round(pf.heatG),
    pct_of_annual_cost: pfExpected !== null && annualCost ? round((pfExpected / annualCost) * 100, 1) : null,
    overlap_discount_pct: round(overlapFrac * 100, 1),
  };

  // Forecast --------------------------------------------------------------
  const trendOf = () => {
    const cur = trailing(el.rows, asOfMs);
    const prev = trailing(el.rows, asOfMs - 365 * DAY_MS);
    if (cur.usageDays < 330 || prev.usageDays < 330 || prev.usage <= 0) return 0;
    return clamp(cur.usage / prev.usage - 1, -0.15, 0.15);
  };
  const yoy = trendOf();
  const startM = new Date(asOfMs - DAY_MS);
  const fcMonth = (k: number) => new Date(Date.UTC(startM.getUTCFullYear(), startM.getUTCMonth() + k, 1));
  const sigma = clamp(E.model.sigma_ratio, 0.05, 0.35);
  const totalsOf = (months: ForecastMonth[]) => ({
    kwh: months.reduce((s, m) => s + m.kwh, 0),
    therms: months.reduce((s, m) => s + m.therms, 0),
    cost: months.every((m) => m.cost_cents !== null) ? months.reduce((s, m) => s + (m.cost_cents ?? 0), 0) : null,
  });
  const scenario = (key: ForecastScenario["key"], label: string, shiftC: number, upgraded: boolean): ForecastScenario => {
    const months: ForecastMonth[] = [];
    for (let k = 1; k <= 12; k++) {
      const d = fcMonth(k);
      const dim = daysInMonth(d.getUTCFullYear(), d.getUTCMonth());
      const dd = monthly ? ddForMonth(monthly, d.getUTCMonth(), shiftC) : { hdd: 0, cdd: 0 };
      const growth = (1 + yoy) ** (k / 12);
      const escF = (1 + esc / 100) ** (k / 12);
      const mE = E.model;
      const mG = G.model;
      let cool = mE.cdd_coef * dd.cdd * dim;
      let heatE = mE.hdd_coef * dd.hdd * dim;
      let heatG = mG.hdd_coef * dd.hdd * dim;
      let baseE = mE.base_per_day * dim;
      const baseG = mG.base_per_day * dim;
      if (mE.mode === "flat") baseE = mE.base_per_day * dim;
      if (upgraded) {
        const nd0 = monthly ? normalDegreeDays(monthly) : null;
        const coolW = nd0 && nd0.cdd > 0 ? (dd.cdd * dim) / nd0.cdd : 0;
        const heatW = nd0 && nd0.hdd > 0 ? (dd.hdd * dim) / nd0.hdd : 0;
        cool = Math.max(0, cool - pf.cooling * coolW);
        heatE = Math.max(0, heatE - pf.heatE * heatW);
        heatG = Math.max(0, heatG - pf.heatG * heatW);
      }
      const kwh = (baseE + cool + heatE) * growth;
      const therms = (baseG + heatG) * growth;
      const cost = (kwh > 0 && rE === null) || (therms > 0 && rG === null) ? null : Math.round((kwh * (rE ?? 0) + therms * (rG ?? 0)) * escF);
      months.push({
        month: monthKey(d.getTime()), kwh: round(kwh), therms: round(therms, 1), cost_cents: cost,
        kwh_low: round(kwh * (1 - 1.28 * sigma)), kwh_high: round(kwh * (1 + 1.28 * sigma)),
      });
    }
    const t = totalsOf(months);
    return { key, label, months, total_kwh: round(t.kwh), total_therms: round(t.therms), total_cost_cents: t.cost };
  };
  const hasForecast = (E.model.mode !== "none" || G.model.mode !== "none") && (monthly !== null || E.model.mode === "flat" || G.model.mode === "flat");
  const scenarios: ForecastScenario[] = hasForecast
    ? [
        scenario("baseline", "Normal weather", 0, false),
        ...(monthly ? [scenario("hot_summer", "Hotter year (+1.5 C)", 1.5, false), scenario("cold_winter", "Colder year (-1.5 C)", -1.5, false)] : []),
        ...(opps.length > 0 ? [scenario("upgraded", "After recommended upgrades", 0, true)] : []),
      ]
    : [];
  const base = scenarios.find((s) => s.key === "baseline");
  const hot = scenarios.find((s) => s.key === "hot_summer");
  const cold = scenarios.find((s) => s.key === "cold_winter");
  const worst = Math.max(hot?.total_cost_cents ?? 0, cold?.total_cost_cents ?? 0);
  const weatherRisk = base?.total_cost_cents != null && worst > 0 ? Math.max(0, worst - base.total_cost_cents) : null;

  // Weather Intelligence ---------------------------------------------------
  const from12 = nowMs - 365 * DAY_MS;
  const wx = { heat_events: 0, cold_events: 0, storm_events: 0, other_events: 0, notes: [] as string[] };
  for (const w of input.weather_events) {
    const t = parseDate(w.effective_at);
    if (t !== null && t < from12) continue;
    const e = w.event_type.toLowerCase();
    if (/heat/.test(e)) wx.heat_events += 1;
    else if (/freeze|frost|cold|chill|winter|ice|snow|blizzard/.test(e)) wx.cold_events += 1;
    else if (/storm|wind|hurricane|tornado|flood|thunder|hail/.test(e)) wx.storm_events += 1;
    else wx.other_events += 1;
  }
  if (wx.heat_events > 0 && coolLoad > 0) wx.notes.push(`${wx.heat_events} heat alert(s) in the last 12 months and ${round(coolLoad).toLocaleString("en-US")} kWh/yr of modelled cooling load: peak-demand and breakdown exposure is elevated in summer.`);
  if (wx.cold_events > 0 && (heatGasLoad > 0 || heatElecLoad > 0)) wx.notes.push(`${wx.cold_events} cold alert(s) in the last 12 months: heating systems carried peak load. Resistance back-up heat on a heat pump is the biggest bill risk.`);
  if (weatherRisk !== null && weatherRisk > 0) wx.notes.push(`A year 1.5 C off normal moves the energy bill by about ${(weatherRisk / 100).toFixed(0)} dollars.`);

  // Actions -----------------------------------------------------------------
  const actions: string[] = [];
  const hi = anomalies.filter((a) => a.severity === "high");
  if (hi.length > 0) actions.push(`Investigate ${hi.length} high-severity anomal${hi.length === 1 ? "y" : "ies"} first: ${hi[0].title}.`);
  if (opps[0]) actions.push(`Top opportunity: ${opps[0].title}${opps[0].savings_cents ? ` (about $${Math.round(opps[0].savings_cents.expected / 100).toLocaleString("en-US")}/yr)` : ""}. Run the rebate check to get net cost and payback.`);
  const late = rowsOut.filter((r) => r.stage === "late" || r.stage === "past_life");
  if (late.length > 0) actions.push(`${late.length} unit(s) are in the last 20% of their life or past it: plan replacement around incentives before a failure forces it.`);
  const overdue = rowsOut.filter((r) => r.maintenance_overdue_months > 0 && (r.category === "cooling" || r.category === "heat_pump" || r.category === "heating"));
  if (overdue.length > 0) actions.push(`${overdue.length} HVAC unit(s) are overdue for service. Overdue maintenance quietly costs efficiency.`);
  if (ratio !== null && ratio >= 1.25) actions.push("Energy intensity is well above the planning reference: consider a home energy audit.");
  if (el.rows.length > 0 && el.rows.length < 12) actions.push("Add more monthly bills (12+ recommended) to tighten the model.");

  const assumptions = [
    { id: "model", label: "Weather model", value: "Weighted regression on climate-normal degree days (base 65 F); not actual weather of each period" },
    { id: "escalation", label: "Energy price escalation", value: `${esc}% per year (planning assumption)` },
    { id: "age_loss", label: "Efficiency loss with age", value: `${AGE_LOSS_PER_YEAR * 100}% per year, capped at ${AGE_LOSS_CAP * 100}%` },
    { id: "service_loss", label: "Efficiency loss when service is overdue", value: `${SERVICE_LOSS_PER_YEAR_OVERDUE * 100}% per year overdue, capped at ${SERVICE_LOSS_CAP * 100}%` },
    { id: "baseline_eff", label: "Existing efficiency", value: "Federal minimum for the install year (nameplate not read)" },
    { id: "targets", label: "Replacement targets", value: `${TARGET_SEER2} SEER2, ${TARGET_AFUE}% AFUE, ${TARGET_HSPF2} HSPF2` },
    { id: "programs", label: "Thermostat / envelope savings", value: `${THERMOSTAT_SAVING * 100}% / ${ENVELOPE_SAVING * 100}% of heating and cooling (program averages)` },
    { id: "band", label: "Savings range", value: `${BAND_LOW}x to ${BAND_HIGH}x of expected` },
    { id: "reference", label: "Efficiency reference", value: "Planning reference EUI adjusted for degree days; not a certified benchmark" },
  ];

  return {
    engine_version: ENGINE_VERSION,
    generated_at: new Date(nowMs).toISOString(),
    as_of: lastEnd > 0 ? isoDay(lastEnd) : null,
    totals: {
      annual_cost_cents: annualCost,
      annual_kwh: annualKwh, annual_therms: annualTherms,
      eui_kbtu_sqft: eui === null ? null : round(eui, 1),
      reference_eui_kbtu_sqft: refEui === null || !sqft ? null : round(refEui, 1),
      efficiency_score: score, grade: ratio === null ? null : gradeFor(ratio),
      cost_per_sqft_cents: annualCost !== null && sqft ? round(annualCost / sqft, 1) : null,
      weather_sensitive_pct: weatherSensitivePct,
    },
    fuels, anomalies: anomalies.slice(0, 25), equipment: rowsOut, opportunities: opps, portfolio,
    forecast: { scenarios, yoy_trend_pct: round(yoy * 100, 1), weather_risk_cents: weatherRisk },
    weather: wx, assumptions, confidence,
    data_quality: { months_covered: monthsCovered, r2_electric: r2e === null ? null : round(r2e, 2), r2_gas: r2g === null ? null : round(r2g, 2), warnings },
    actions: actions.slice(0, 6),
  };
}
