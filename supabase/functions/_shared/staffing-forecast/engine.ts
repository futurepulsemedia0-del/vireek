// supabase/functions/_shared/staffing-forecast/engine.ts
//
// Vireek Staffing Forecast engine — PURE and deterministic (no Deno / DOM / network APIs),
// so the same file runs in the Edge Function, in the dashboard and in Vitest.
//
// Model (multiplicative, per daily series of calls and of jobs):
//   forecast(day) = level x weekday[dow] x season[month] x weather(day) x regional(horizon)
//   - weekday   : last 12 weeks, shrunk toward the overall mean (closed days stay at 0)
//   - season    : only with >= ~11 months of history, shrunk by sample size
//   - weather   : ridge regression on temperature anomaly (hot / cold) and precipitation;
//                 only used when >= 90 paired days AND it explains >= 2% of variance
//   - regional  : small, decaying nudge toward the k-anonymous regional call-volume trend
//   - bands     : empirical, from a 28-day hold-out backtest (never a made-up +/- %)
// Jobs are floored by what is ALREADY booked. Capacity / thresholds come from the same
// sources as Capacity Demand Control (technician max_jobs_per_day, capacity policy).

export const ENGINE_VERSION = 'staffing-forecast-1.0.0';

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type CapStatus = 'low' | 'optimal' | 'full' | 'no_capacity' | 'closed';
export type Confidence = 'high' | 'medium' | 'low';

export interface HourlyCallRow { d: string; h: number; calls: number; human: number; emergency: number }
export interface DailyCallRow { d: string; calls: number; human: number; emergency: number }
export interface JobDayRow { d: string; jobs: number; minutes: number }
export interface BookedRow { d: string; jobs: number }
export interface WeatherDay { d: string; mean_f: number | null; precip_in: number | null }
export interface RegionalInput {
  region_label: string;
  sample_size: number;
  call_volume_change_pct: number | null;
  emergency_rate_pct: number | null;
}
export interface StaffingSettings {
  calls_per_csr_hour: number;
  csr_target_occupancy_pct: number;
  avg_job_minutes_override: number | null;
  tech_hourly_cost_cents: number | null;
  csr_hourly_cost_cents: number | null;
  overtime_multiplier: number;
  tech_paid_hours_per_day: number;
  sustained_weeks_to_hire: number;
  csr_concurrent_override: number | null;
}
export interface StaffingInput {
  now: string;
  timezone: string;
  calls_daily: DailyCallRow[];
  calls_hourly: HourlyCallRow[];
  jobs_daily: JobDayRow[];
  booked_ahead: BookedRow[];
  tech: { headcount: number; capacity_jobs_per_day: number };
  csr: { headcount: number };
  hours: Partial<Record<DayKey, { open: string; close: string }>>;
  policy: { low_threshold_pct: number; full_threshold_pct: number; emergency_reserve_slots: number };
  settings: StaffingSettings;
  weather: WeatherDay[] | null;
  regional: RegionalInput | null;
  include_costs: boolean;
}

export interface Band { p10: number; p50: number; p90: number }
export interface DayForecast {
  date: string;
  weekday: DayKey;
  horizon_days: number;
  workday: boolean;
  calls: Band;
  jobs: Band;
  jobs_booked: number;
  tech_capacity_jobs: number;
  utilization_pct: number | null;
  utilization_p90_pct: number | null;
  status: CapStatus;
  headroom_jobs: number;
  deficit_jobs: number;
  deficit_jobs_p90: number;
  human_calls: number;
  human_calls_after_hours: number;
  csr_hours_required: number;
  csr_hours_available: number;
  csr_gap_hours: number;
  weather: { mean_f: number | null; precip_in: number | null; factor: number } | null;
}
export interface HourForecast {
  date: string;
  hour: number;
  open: boolean;
  calls: number;
  human_calls: number;
  csr_required: number;
  csr_available: number;
  gap: number;
}
export interface WeekForecast {
  week_start: string;
  demand: Band;
  capacity_jobs: number;
  utilization_pct: number | null;
  utilization_p10_pct: number | null;
  utilization_p90_pct: number | null;
  deficit_jobs: number;
  status: CapStatus;
}
export type RecommendationKind =
  | 'hire_technician' | 'overtime' | 'rebalance_schedule' | 'generate_demand'
  | 'add_csr_coverage' | 'after_hours_coverage' | 'configure_technicians' | 'configure_csr'
  | 'improve_data' | 'balanced';
export interface Recommendation {
  id: string;
  kind: RecommendationKind;
  severity: 'high' | 'medium' | 'low' | 'info';
  title: string;
  detail: string;
  quantity: number | null;
  unit: 'technicians' | 'overtime_hours' | 'jobs' | 'csr' | 'calls_per_week' | null;
  window: { start: string; end: string } | null;
  est_cost_cents: number | null;
  confidence: Confidence;
  evidence: string[];
}
export interface StaffingReport {
  engine_version: string;
  generated_at: string;
  timezone: string;
  today: string;
  status: 'ok' | 'insufficient_data';
  confidence: Confidence;
  data_quality: {
    calls_days: number;
    jobs_days: number;
    weather: 'used' | 'no_signal' | 'unavailable';
    seasonality: 'used' | 'insufficient_history';
    regional: 'used' | 'unavailable';
    hours_assumed: boolean;
    job_hours: number;
    job_hours_source: 'settings' | 'history' | 'default';
    notes: string[];
  };
  accuracy: {
    calls_wape: number | null; jobs_wape: number | null;
    calls_bias: number | null; jobs_bias: number | null;
    backtest_days: number;
  };
  drivers: {
    weekday_factors_jobs: Record<DayKey, number> | null;
    weekday_factors_calls: Record<DayKey, number> | null;
    season_factors_jobs: number[] | null;
    weather: { r2: number; hot_per_f_pct: number; cold_per_f_pct: number; rain_per_in_pct: number } | null;
    regional: { label: string; sample_size: number; region_change_pct: number | null; local_change_pct: number | null; applied_pct: number } | null;
  };
  capacity: {
    technicians: number;
    jobs_per_day: number;
    csr_concurrent: number;
    low_threshold_pct: number;
    full_threshold_pct: number;
  };
  daily: DayForecast[];
  hourly: HourForecast[];
  weekly: WeekForecast[];
  recommendations: Recommendation[];
  headline: {
    next7_avg_utilization_pct: number | null;
    peak_day: string | null;
    peak_utilization_pct: number | null;
    next14_deficit_jobs: number;
    next7_human_calls: number;
    next7_csr_gap_hours: number;
    next7_calls: number;
    next7_jobs: number;
  };
}

// ---------------------------------------------------------------- date + math helpers

const DAY_KEYS: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DEFAULT_HOURS: StaffingInput['hours'] = {
  mon: { open: '08:00', close: '17:00' }, tue: { open: '08:00', close: '17:00' },
  wed: { open: '08:00', close: '17:00' }, thu: { open: '08:00', close: '17:00' },
  fri: { open: '08:00', close: '17:00' },
};
const HORIZON_DAYS = 56;
const DETAIL_DAYS = 14;
const HOURLY_DAYS = 7;
const MIN_SERIES_DAYS = 21;

const pad = (n: number) => String(n).padStart(2, '0');
const parseYmd = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, dd);
};
const fmtYmd = (ms: number) => {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
};
export const addDays = (d: string, n: number) => fmtYmd(parseYmd(d) + n * 86_400_000);
export const diffDays = (a: string, b: string) => Math.round((parseYmd(b) - parseYmd(a)) / 86_400_000);
const dowOf = (d: string) => new Date(parseYmd(d)).getUTCDay();
const monthOf = (d: string) => Number(d.slice(5, 7));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown, fb = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

export function localDate(nowIso: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(nowIso));
    const g = (t: string) => parts.find((p) => p.type === t)?.value;
    const out = `${g('year')}-${g('month')}-${g('day')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : nowIso.slice(0, 10);
  } catch {
    return nowIso.slice(0, 10);
  }
}

function weekdayRecord(f: number[]): Record<DayKey, number> {
  const out = {} as Record<DayKey, number>;
  DAY_KEYS.forEach((k, i) => { out[k] = r2(f[i]); });
  return out;
}

/** Solve A x = b (small dense system) with partial pivoting. Returns null when singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// ---------------------------------------------------------------- series + model

interface Series { dates: string[]; values: number[] }

function buildSeries(rows: { d: string; v: number }[], today: string): Series {
  const map = new Map<string, number>();
  for (const r of rows) {
    if (typeof r.d === 'string' && r.d < today && Number.isFinite(r.v)) map.set(r.d, (map.get(r.d) ?? 0) + Math.max(0, r.v));
  }
  if (map.size === 0) return { dates: [], values: [] };
  const first = [...map.keys()].sort()[0];
  const end = addDays(today, -1);
  const dates: string[] = [];
  const values: number[] = [];
  for (let d = first; d <= end; d = addDays(d, 1)) {
    dates.push(d);
    values.push(map.get(d) ?? 0);
  }
  return { dates, values };
}

interface WeatherModel {
  coef: { h: number; c: number; p: number };
  mean: { h: number; c: number; p: number };
  r2: number;
  n: number;
}
interface Fit { level: number; W: number[]; M: number[]; wm: WeatherModel | null; seasonal: boolean; n: number }
interface WFeat { h: number; c: number; p: number }

function features(w: WeatherDay | undefined, climo: number[] | null): WFeat | null {
  if (!w || w.mean_f === null || !Number.isFinite(w.mean_f) || !climo) return null;
  const m = climo[monthOf(w.d) - 1];
  if (!Number.isFinite(m)) return null;
  const a = w.mean_f - m;
  return { h: Math.max(0, a), c: Math.max(0, -a), p: clamp(num(w.precip_in), 0, 2) };
}

function weatherFactor(wm: WeatherModel | null, f: WFeat | null): number {
  if (!wm || !f) return 1;
  return clamp(1 + wm.coef.h * (f.h - wm.mean.h) + wm.coef.c * (f.c - wm.mean.c) + wm.coef.p * (f.p - wm.mean.p), 0.6, 1.8);
}

function weekdayFactors(s: Series): number[] {
  const n = s.values.length;
  const start = Math.max(0, n - 84);
  const sum = new Array<number>(7).fill(0);
  const cnt = new Array<number>(7).fill(0);
  let tot = 0;
  let c = 0;
  for (let i = start; i < n; i++) {
    const w = dowOf(s.dates[i]);
    sum[w] += s.values[i];
    cnt[w]++;
    tot += s.values[i];
    c++;
  }
  const overall = c > 0 ? tot / c : 0;
  if (overall <= 0) return new Array<number>(7).fill(1);
  const raw = sum.map((sv, w) => (cnt[w] >= 6 && sv === 0 ? 0 : (sv + 0.25 * overall) / (cnt[w] + 0.25) / overall));
  const m = mean(raw) || 1;
  return raw.map((v) => v / m);
}

function seasonalFactors(s: Series, W: number[]): { M: number[]; seasonal: boolean } {
  const M = new Array<number>(12).fill(1);
  if (s.values.length < 330) return { M, seasonal: false };
  const sumY = new Array<number>(12).fill(0);
  const sumW = new Array<number>(12).fill(0);
  const cnt = new Array<number>(12).fill(0);
  let totY = 0;
  let totW = 0;
  for (let i = 0; i < s.values.length; i++) {
    const w = W[dowOf(s.dates[i])];
    const m = monthOf(s.dates[i]) - 1;
    sumY[m] += s.values[i];
    sumW[m] += w;
    cnt[m]++;
    totY += s.values[i];
    totW += w;
  }
  if (totY <= 0 || totW <= 0) return { M, seasonal: false };
  const overall = totY / totW;
  let used = 0;
  for (let m = 0; m < 12; m++) {
    if (cnt[m] < 10 || sumW[m] <= 0) continue;
    const raw = sumY[m] / sumW[m] / overall;
    const wgt = cnt[m] / (cnt[m] + 30);
    M[m] = clamp(1 + wgt * (raw - 1), 0.4, 2.5);
    used++;
  }
  return { M, seasonal: used >= 9 };
}

function fitWeather(s: Series, W: number[], M: number[], wmap: Map<string, WeatherDay>, climo: number[] | null): WeatherModel | null {
  if (!climo) return null;
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < s.values.length; i++) {
    const w = W[dowOf(s.dates[i])];
    if (w < 0.25) continue;
    const f = features(wmap.get(s.dates[i]), climo);
    if (!f) continue;
    X.push([f.h, f.c, f.p]);
    y.push(s.values[i] / (w * M[monthOf(s.dates[i]) - 1]));
  }
  const n = X.length;
  if (n < 90) return null;
  const L0 = mean(y);
  if (L0 <= 0) return null;
  const z = y.map((v) => v / L0 - 1);
  const mu = [0, 1, 2].map((j) => mean(X.map((r) => r[j])));
  const sd = [0, 1, 2].map((j) => Math.sqrt(mean(X.map((r) => (r[j] - mu[j]) ** 2))));
  const act = [0, 1, 2].filter((j) => sd[j] > 1e-6);
  if (act.length === 0) return null;
  const zbar = mean(z);
  const Xs = X.map((r) => act.map((j) => (r[j] - mu[j]) / sd[j]));
  const zc = z.map((v) => v - zbar);
  const k = act.length;
  const A = Array.from({ length: k }, (_, a) =>
    Array.from({ length: k }, (_, b) => mean(Xs.map((r) => r[a] * r[b])) + (a === b ? 0.15 : 0)));
  const b = Array.from({ length: k }, (_, a) => mean(Xs.map((r, i) => r[a] * zc[i])));
  const beta = solve(A, b);
  if (!beta) return null;
  const bt = beta.map((v) => clamp(v, -0.5, 0.5));
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    const pred = Xs[i].reduce((acc, v, a) => acc + v * bt[a], 0);
    sse += (zc[i] - pred) ** 2;
    sst += zc[i] ** 2;
  }
  const r2v = sst > 0 ? 1 - sse / sst : 0;
  if (r2v < 0.02) return null;
  const coef = [0, 0, 0];
  act.forEach((j, a) => { coef[j] = bt[a] / sd[j]; });
  return { coef: { h: coef[0], c: coef[1], p: coef[2] }, mean: { h: mu[0], c: mu[1], p: mu[2] }, r2: r2v, n };
}

function estimateLevel(s: Series, W: number[], M: number[], wm: WeatherModel | null, wmap: Map<string, WeatherDay>, climo: number[] | null): number {
  // Ratio estimator: sum(y) / sum(expected shape). Near-closed days (tiny weekday factor)
  // contribute little to both sides instead of dragging the level down.
  const n = s.values.length;
  let numr = 0;
  let den = 0;
  for (let i = Math.max(0, n - 56); i < n; i++) {
    const shape = W[dowOf(s.dates[i])] * M[monthOf(s.dates[i]) - 1] * weatherFactor(wm, features(wmap.get(s.dates[i]), climo));
    const wt = Math.pow(0.5, (n - 1 - i) / 21);
    numr += wt * s.values[i];
    den += wt * shape;
  }
  return den > 0 ? numr / den : 0;
}

function fitModel(s: Series, wmap: Map<string, WeatherDay>, climo: number[] | null): Fit | null {
  if (s.values.length < MIN_SERIES_DAYS) return null;
  const W = weekdayFactors(s);
  const { M, seasonal } = seasonalFactors(s, W);
  const wm = fitWeather(s, W, M, wmap, climo);
  return { level: estimateLevel(s, W, M, wm, wmap, climo), W, M, wm, seasonal, n: s.values.length };
}

function predictDay(fit: Fit, date: string, wmap: Map<string, WeatherDay>, climo: number[] | null, adj: number): { value: number; wf: number } {
  const wf = weatherFactor(fit.wm, features(wmap.get(date), climo));
  return { value: Math.max(0, fit.level * fit.W[dowOf(date)] * fit.M[monthOf(date) - 1] * wf * adj), wf };
}

interface Backtest { wape: number | null; bias: number | null; sdz: number; n: number }

function backtest(s: Series, wmap: Map<string, WeatherDay>, climo: number[] | null): Backtest {
  const HOLD = 28;
  const fallback: Backtest = { wape: null, bias: null, sdz: 1.5, n: 0 };
  if (s.values.length < HOLD + 28) return fallback;
  const train: Series = { dates: s.dates.slice(0, -HOLD), values: s.values.slice(0, -HOLD) };
  const fit = fitModel(train, wmap, climo);
  if (!fit) return fallback;
  let abs = 0;
  let sumY = 0;
  let err = 0;
  const zs: number[] = [];
  for (let i = s.values.length - HOLD; i < s.values.length; i++) {
    const pred = predictDay(fit, s.dates[i], wmap, climo, 1).value;
    const y = s.values[i];
    abs += Math.abs(y - pred);
    sumY += y;
    err += pred - y;
    if (fit.W[dowOf(s.dates[i])] >= 0.05) zs.push((y - pred) / Math.sqrt(pred + 1));
  }
  const sdz = zs.length ? Math.sqrt(mean(zs.map((z) => z * z))) : 1.5;
  return { wape: sumY > 0 ? abs / sumY : null, bias: sumY > 0 ? err / sumY : null, sdz: Math.min(4, sdz), n: HOLD };
}

function band(p: number, sdz: number, h: number): Band {
  const spread = 1.2816 * Math.max(1, sdz) * Math.sqrt(p + 1) * (1 + 0.02 * h);
  return { p10: Math.max(0, p - spread), p50: p, p90: p + spread };
}

// ---------------------------------------------------------------- hours + profiles

function parseHm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 24 * 60 ? v : null;
}

function openHourSet(hours: StaffingInput['hours'], dow: number): Set<number> {
  const e = hours[DAY_KEYS[dow]];
  const out = new Set<number>();
  if (!e) return out;
  const o = parseHm(e.open);
  let c = parseHm(e.close);
  if (o === null || c === null) return out;
  if (c <= o) c = 24 * 60;
  for (let h = Math.floor(o / 60); h < Math.ceil(c / 60) && h < 24; h++) out.add(h);
  return out;
}

function hourlyProfile(rows: HourlyCallRow[], today: string) {
  const cutoff = addDays(today, -84);
  const dh = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const totD = new Array<number>(7).fill(0);
  const callsH = new Array<number>(24).fill(0);
  const humanH = new Array<number>(24).fill(0);
  for (const r of rows) {
    if (r.d < cutoff || r.d >= today || r.h < 0 || r.h > 23) continue;
    const w = dowOf(r.d);
    dh[w][r.h] += r.calls;
    totD[w] += r.calls;
    callsH[r.h] += r.calls;
    humanH[r.h] += r.human;
  }
  const totalCalls = callsH.reduce((a, b) => a + b, 0);
  const g = totalCalls > 0 ? humanH.reduce((a, b) => a + b, 0) / totalCalls : 0;
  const share = dh.map((row, w) => row.map((c) => (c + 3 / 24) / (totD[w] + 3)));
  const humanShare = callsH.map((c, h) => (humanH[h] + 10 * g) / (c + 10));
  return { share, humanShare, hasData: totalCalls > 0 };
}

// ---------------------------------------------------------------- analysis

function emptyReport(input: StaffingInput, today: string, notes: string[], callsDays: number, jobsDays: number): StaffingReport {
  return {
    engine_version: ENGINE_VERSION, generated_at: input.now, timezone: input.timezone, today,
    status: 'insufficient_data', confidence: 'low',
    data_quality: {
      calls_days: callsDays, jobs_days: jobsDays, weather: 'unavailable', seasonality: 'insufficient_history',
      regional: 'unavailable', hours_assumed: Object.keys(input.hours).length === 0, job_hours: 1, job_hours_source: 'default', notes,
    },
    accuracy: { calls_wape: null, jobs_wape: null, calls_bias: null, jobs_bias: null, backtest_days: 0 },
    drivers: { weekday_factors_jobs: null, weekday_factors_calls: null, season_factors_jobs: null, weather: null, regional: null },
    capacity: {
      technicians: input.tech.headcount, jobs_per_day: input.tech.capacity_jobs_per_day,
      csr_concurrent: input.settings.csr_concurrent_override ?? input.csr.headcount,
      low_threshold_pct: input.policy.low_threshold_pct, full_threshold_pct: input.policy.full_threshold_pct,
    },
    daily: [], hourly: [], weekly: [],
    recommendations: [{
      id: 'improve-data', kind: 'improve_data', severity: 'info',
      title: 'Not enough history to forecast yet',
      detail: `A forecast needs at least ${MIN_SERIES_DAYS} days of call or job history. ${notes.join(' ')}`.trim(),
      quantity: null, unit: null, window: null, est_cost_cents: null, confidence: 'low', evidence: notes,
    }],
    headline: {
      next7_avg_utilization_pct: null, peak_day: null, peak_utilization_pct: null, next14_deficit_jobs: 0,
      next7_human_calls: 0, next7_csr_gap_hours: 0, next7_calls: 0, next7_jobs: 0,
    },
  };
}

export function analyzeStaffing(input: StaffingInput): StaffingReport {
  const today = localDate(input.now, input.timezone);
  const settings = input.settings;
  const policy = input.policy;

  const callsS = buildSeries(input.calls_daily.map((r) => ({ d: r.d, v: r.calls })), today);
  const jobsS = buildSeries(input.jobs_daily.map((r) => ({ d: r.d, v: r.jobs })), today);

  if (callsS.values.length < MIN_SERIES_DAYS && jobsS.values.length < MIN_SERIES_DAYS) {
    return emptyReport(input, today, [
      `Found ${callsS.values.length} day(s) of calls and ${jobsS.values.length} day(s) of jobs.`,
    ], callsS.values.length, jobsS.values.length);
  }

  // Weather (history + forecast) -> map + monthly climatology from past days only.
  const wmap = new Map<string, WeatherDay>();
  for (const w of input.weather ?? []) if (typeof w.d === 'string') wmap.set(w.d, w);
  let climo: number[] | null = null;
  if (input.weather && input.weather.length > 0) {
    const sums = new Array<number>(12).fill(0);
    const cnts = new Array<number>(12).fill(0);
    for (const w of input.weather) {
      if (w.d >= today || w.mean_f === null || !Number.isFinite(w.mean_f)) continue;
      sums[monthOf(w.d) - 1] += w.mean_f;
      cnts[monthOf(w.d) - 1]++;
    }
    climo = sums.map((s, i) => (cnts[i] >= 5 ? s / cnts[i] : NaN));
    if (climo.every((v) => !Number.isFinite(v))) climo = null;
  }

  const callsFit = fitModel(callsS, wmap, climo);
  const jobsFit = fitModel(jobsS, wmap, climo);
  const callsBt = callsFit ? backtest(callsS, wmap, climo) : { wape: null, bias: null, sdz: 1.5, n: 0 };
  const jobsBt = jobsFit ? backtest(jobsS, wmap, climo) : { wape: null, bias: null, sdz: 1.5, n: 0 };

  // Regional nudge: shared local demand shock the business has not yet "seen" in its own numbers.
  let localWow: number | null = null;
  if (callsS.values.length >= 14) {
    const n = callsS.values.length;
    const last = callsS.values.slice(n - 7).reduce((a, b) => a + b, 0);
    const prev = callsS.values.slice(n - 14, n - 7).reduce((a, b) => a + b, 0);
    if (prev >= 10) localWow = ((last - prev) / prev) * 100;
  }
  let regionalAdj = 0;
  const reg = input.regional;
  if (reg && reg.sample_size >= 5 && reg.call_volume_change_pct !== null && localWow !== null) {
    regionalAdj = clamp(0.25 * ((reg.call_volume_change_pct - localWow) / 100), -0.1, 0.15);
  }

  // Hours, capacity helpers.
  const hoursAssumed = Object.keys(input.hours).length === 0;
  const hoursEff = hoursAssumed ? DEFAULT_HOURS : input.hours;
  const concurrentCsr = Math.max(0, settings.csr_concurrent_override ?? input.csr.headcount);
  const cph = Math.max(0.5, settings.calls_per_csr_hour);
  const occ = clamp(settings.csr_target_occupancy_pct, 30, 95) / 100;
  const profile = hourlyProfile(input.calls_hourly, today);

  // Average on-site job hours: settings > history (last 90 days, >= 20 jobs) > 1 h default.
  let jobHours = 1;
  let jobHoursSource: 'settings' | 'history' | 'default' = 'default';
  if (settings.avg_job_minutes_override && settings.avg_job_minutes_override > 0) {
    jobHours = settings.avg_job_minutes_override / 60;
    jobHoursSource = 'settings';
  } else {
    const cut = addDays(today, -90);
    let jobs = 0;
    let minutes = 0;
    for (const r of input.jobs_daily) if (r.d >= cut && r.d < today) { jobs += r.jobs; minutes += r.minutes; }
    if (jobs >= 20 && minutes > 0) { jobHours = minutes / jobs / 60; jobHoursSource = 'history'; }
  }

  const bookedMap = new Map<string, number>();
  for (const b of input.booked_ahead) bookedMap.set(b.d, (bookedMap.get(b.d) ?? 0) + Math.max(0, b.jobs));

  const statusOf = (util: number | null, cap: number, workday: boolean): CapStatus => {
    if (!workday && cap === 0) return 'closed';
    if (cap === 0 || util === null) return 'no_capacity';
    if (util >= policy.full_threshold_pct) return 'full';
    if (util <= policy.low_threshold_pct) return 'low';
    return 'optimal';
  };

  const daily: DayForecast[] = [];
  const hourly: HourForecast[] = [];
  const all: { date: string; jobs: Band; cap: number; workday: boolean; deficit: number }[] = [];

  for (let h = 0; h < HORIZON_DAYS; h++) {
    const date = addDays(today, h);
    const dow = dowOf(date);
    const key = DAY_KEYS[dow];
    const adj = 1 + regionalAdj * Math.exp(-h / 7);

    const cp = callsFit ? predictDay(callsFit, date, wmap, climo, adj) : null;
    const jp = jobsFit ? predictDay(jobsFit, date, wmap, climo, adj) : null;
    const calls = cp ? band(cp.value, callsBt.sdz, h) : { p10: 0, p50: 0, p90: 0 };
    const booked = bookedMap.get(date) ?? 0;
    const jb = jp ? band(jp.value, jobsBt.sdz, h) : { p10: 0, p50: 0, p90: 0 };
    const jobs: Band = { p10: Math.max(jb.p10, booked), p50: Math.max(jb.p50, booked), p90: Math.max(jb.p90, booked) };

    const workday = Boolean(hoursEff[key]) || (jobsFit ? jobsFit.W[dow] >= 0.35 : false);
    const cap = workday ? input.tech.capacity_jobs_per_day : 0;
    const util = cap > 0 ? (jobs.p50 / cap) * 100 : null;
    const utilP90 = cap > 0 ? (jobs.p90 / cap) * 100 : null;
    const deficit = Math.max(0, jobs.p50 - cap);
    all.push({ date, jobs, cap, workday, deficit });

    if (h >= DETAIL_DAYS) continue;

    // CSR / AI coverage for this day.
    const open = openHourSet(hoursEff, dow);
    let humanTotal = 0;
    let humanAfter = 0;
    let reqHours = 0;
    let availHours = 0;
    let gapHours = 0;
    for (let hr = 0; hr < 24; hr++) {
      const c = calls.p50 * profile.share[dow][hr];
      const human = profile.hasData ? c * profile.humanShare[hr] : 0;
      const isOpen = open.has(hr);
      const req = human / (cph * occ);
      const avail = isOpen ? concurrentCsr : 0;
      humanTotal += human;
      if (!isOpen) humanAfter += human;
      else {
        reqHours += req;
        availHours += avail;
        gapHours += Math.max(0, req - avail);
      }
      if (h < HOURLY_DAYS) {
        hourly.push({
          date, hour: hr, open: isOpen, calls: r2(c), human_calls: r2(human),
          csr_required: r2(req), csr_available: isOpen ? avail : 0, gap: r2(isOpen ? Math.max(0, req - avail) : 0),
        });
      }
    }

    daily.push({
      date, weekday: key, horizon_days: h, workday,
      calls: { p10: r1(calls.p10), p50: r1(calls.p50), p90: r1(calls.p90) },
      jobs: { p10: r1(jobs.p10), p50: r1(jobs.p50), p90: r1(jobs.p90) },
      jobs_booked: booked, tech_capacity_jobs: cap,
      utilization_pct: util === null ? null : r1(util),
      utilization_p90_pct: utilP90 === null ? null : r1(utilP90),
      status: statusOf(util, cap, workday),
      headroom_jobs: r1(Math.max(0, cap - jobs.p50)),
      deficit_jobs: r1(deficit),
      deficit_jobs_p90: r1(Math.max(0, jobs.p90 - cap)),
      human_calls: r1(humanTotal), human_calls_after_hours: r1(humanAfter),
      csr_hours_required: r1(reqHours), csr_hours_available: r1(availHours), csr_gap_hours: r1(gapHours),
      weather: wmap.has(date)
        ? { mean_f: wmap.get(date)!.mean_f, precip_in: wmap.get(date)!.precip_in, factor: r2(jp?.wf ?? cp?.wf ?? 1) }
        : null,
    });
  }

  // 8-week outlook.
  const weekly: WeekForecast[] = [];
  for (let w = 0; w < HORIZON_DAYS / 7; w++) {
    const days = all.slice(w * 7, w * 7 + 7);
    const p50 = days.reduce((a, d) => a + d.jobs.p50, 0);
    const lo = Math.sqrt(days.reduce((a, d) => a + (d.jobs.p50 - d.jobs.p10) ** 2, 0));
    const hi = Math.sqrt(days.reduce((a, d) => a + (d.jobs.p90 - d.jobs.p50) ** 2, 0));
    const cap = days.reduce((a, d) => a + d.cap, 0);
    const util = cap > 0 ? (p50 / cap) * 100 : null;
    weekly.push({
      week_start: days[0].date,
      demand: { p10: r1(Math.max(0, p50 - lo)), p50: r1(p50), p90: r1(p50 + hi) },
      capacity_jobs: cap,
      utilization_pct: util === null ? null : r1(util),
      utilization_p10_pct: cap > 0 ? r1(((p50 - lo) / cap) * 100) : null,
      utilization_p90_pct: cap > 0 ? r1(((p50 + hi) / cap) * 100) : null,
      deficit_jobs: r1(Math.max(0, p50 - cap)),
      status: statusOf(util, cap, cap > 0),
    });
  }

  const recommendations = buildRecommendations({
    input, today, daily, hourly, weekly, all, jobHours, hoursAssumed, jobsFit, concurrentCsr, hasCallData: profile.hasData,
  });

  const confidence: Confidence = (() => {
    const fit = jobsFit ?? callsFit;
    const bt = jobsFit ? jobsBt : callsBt;
    if (!fit) return 'low';
    if (fit.n >= 180 && bt.wape !== null && bt.wape <= 0.25) return 'high';
    if (fit.n >= 56 && bt.wape !== null && bt.wape <= 0.45) return 'medium';
    return 'low';
  })();

  const notes: string[] = [];
  if (!jobsFit) notes.push('Not enough job history — job demand shows only what is already booked.');
  if (!callsFit) notes.push('Not enough call history — call and CSR forecasts are unavailable.');
  if (hoursAssumed) notes.push('No business hours are set — assumed Mon–Fri 08:00–17:00.');
  if (callsFit && !profile.hasData) notes.push('No hourly call history in the last 12 weeks — hourly CSR coverage is not modelled.');
  if (input.weather === null) notes.push('Weather data was unavailable — forecast uses calendar patterns only.');
  if (jobsFit && !jobsFit.seasonal) notes.push('Less than ~11 months of job history — seasonality is not modelled yet.');
  if (jobHoursSource === 'default') notes.push('Average job length unknown — assuming 1 hour on site; set it in settings for accurate overtime hours.');

  const weatherFit = jobsFit?.wm ?? callsFit?.wm ?? null;
  const next7 = daily.slice(0, 7);
  const utils = next7.map((d) => d.utilization_pct).filter((v): v is number => v !== null);
  const peak = daily.filter((d) => d.utilization_pct !== null).sort((a, b) => (b.utilization_pct ?? 0) - (a.utilization_pct ?? 0))[0];

  return {
    engine_version: ENGINE_VERSION, generated_at: input.now, timezone: input.timezone, today,
    status: 'ok', confidence,
    data_quality: {
      calls_days: callsS.values.length, jobs_days: jobsS.values.length,
      weather: input.weather === null ? 'unavailable' : weatherFit ? 'used' : 'no_signal',
      seasonality: jobsFit?.seasonal || callsFit?.seasonal ? 'used' : 'insufficient_history',
      regional: reg && reg.sample_size >= 5 ? 'used' : 'unavailable',
      hours_assumed: hoursAssumed, job_hours: r2(jobHours), job_hours_source: jobHoursSource, notes,
    },
    accuracy: {
      calls_wape: callsBt.wape === null ? null : r2(callsBt.wape), jobs_wape: jobsBt.wape === null ? null : r2(jobsBt.wape),
      calls_bias: callsBt.bias === null ? null : r2(callsBt.bias), jobs_bias: jobsBt.bias === null ? null : r2(jobsBt.bias),
      backtest_days: Math.max(callsBt.n, jobsBt.n),
    },
    drivers: {
      weekday_factors_jobs: jobsFit ? weekdayRecord(jobsFit.W) : null,
      weekday_factors_calls: callsFit ? weekdayRecord(callsFit.W) : null,
      season_factors_jobs: jobsFit?.seasonal ? jobsFit.M.map(r2) : null,
      weather: weatherFit
        ? { r2: r2(weatherFit.r2), hot_per_f_pct: r2(weatherFit.coef.h * 100), cold_per_f_pct: r2(weatherFit.coef.c * 100), rain_per_in_pct: r2(weatherFit.coef.p * 100) }
        : null,
      regional: reg
        ? { label: reg.region_label, sample_size: reg.sample_size, region_change_pct: reg.call_volume_change_pct, local_change_pct: localWow === null ? null : r1(localWow), applied_pct: r1(regionalAdj * 100) }
        : null,
    },
    capacity: {
      technicians: input.tech.headcount, jobs_per_day: input.tech.capacity_jobs_per_day, csr_concurrent: concurrentCsr,
      low_threshold_pct: policy.low_threshold_pct, full_threshold_pct: policy.full_threshold_pct,
    },
    daily, hourly, weekly, recommendations,
    headline: {
      next7_avg_utilization_pct: utils.length ? r1(mean(utils)) : null,
      peak_day: peak?.date ?? null,
      peak_utilization_pct: peak?.utilization_pct ?? null,
      next14_deficit_jobs: r1(daily.reduce((a, d) => a + d.deficit_jobs, 0)),
      next7_human_calls: r1(next7.reduce((a, d) => a + d.human_calls, 0)),
      next7_csr_gap_hours: r1(next7.reduce((a, d) => a + d.csr_gap_hours, 0)),
      next7_calls: r1(next7.reduce((a, d) => a + d.calls.p50, 0)),
      next7_jobs: r1(next7.reduce((a, d) => a + d.jobs.p50, 0)),
    },
  };
}

// ---------------------------------------------------------------- recommendations

interface RecCtx {
  input: StaffingInput;
  today: string;
  daily: DayForecast[];
  hourly: HourForecast[];
  weekly: WeekForecast[];
  all: { date: string; jobs: Band; cap: number; workday: boolean; deficit: number }[];
  jobHours: number;
  hoursAssumed: boolean;
  jobsFit: Fit | null;
  concurrentCsr: number;
  hasCallData: boolean;
}

const SEV_ORDER: Record<Recommendation['severity'], number> = { high: 0, medium: 1, low: 2, info: 3 };
const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
const fmtDay = (d: string) => `${DAY_KEYS[dowOf(d)].replace(/^./, (c) => c.toUpperCase())} ${d.slice(5)}`;

function buildRecommendations(c: RecCtx): Recommendation[] {
  const { input, daily, hourly, weekly, jobHours } = c;
  const { policy, settings, tech } = input;
  const costs = input.include_costs;
  const recs: Recommendation[] = [];
  const techRate = costs ? settings.tech_hourly_cost_cents : null;
  const csrRate = costs ? settings.csr_hourly_cost_cents : null;

  // --- technicians
  if (tech.headcount === 0 || tech.capacity_jobs_per_day <= 0) {
    recs.push({
      id: 'configure-technicians', kind: 'configure_technicians', severity: 'high',
      title: 'No dispatch-enabled technicians configured',
      detail: 'Technician capacity is zero, so utilization cannot be calculated. Add technicians (role "technician", dispatch enabled, max jobs per day) in Team settings.',
      quantity: null, unit: null, window: null, est_cost_cents: null, confidence: 'high', evidence: [],
    });
  } else if (c.jobsFit) {
    const target = Math.max(0.5, (policy.full_threshold_pct - 5) / 100);

    // Near-term: shift first, then overtime (two 7-day blocks).
    for (let w = 0; w < 2; w++) {
      const days = c.all.slice(w * 7, w * 7 + 7);
      const over = days.filter((d) => d.cap > 0 && d.deficit >= 0.25);
      if (over.length === 0) continue;
      const deficit = over.reduce((a, d) => a + d.deficit, 0);
      const room = days.filter((d) => d.cap > 0 && d.deficit < 0.25).map((d) => ({ date: d.date, room: Math.max(0, d.cap - d.jobs.p50) }));
      const shift = Math.min(deficit, room.reduce((a, d) => a + d.room, 0));
      const net = deficit - shift;
      const start = days[0].date;
      const end = days[6].date;
      const p90 = over.reduce((a, d) => a + Math.max(0, d.jobs.p90 - d.cap), 0);
      const overList = over.map((d) => fmtDay(d.date)).join(', ');
      if (shift >= 0.5) {
        const roomList = room.filter((d) => d.room >= 0.5).sort((a, b) => b.room - a.room).slice(0, 3).map((d) => fmtDay(d.date)).join(', ');
        recs.push({
          id: `rebalance-w${w}`, kind: 'rebalance_schedule', severity: net >= 0.5 ? 'medium' : 'high',
          title: `Move ~${Math.ceil(shift)} job${Math.ceil(shift) === 1 ? '' : 's'} off overloaded days before paying overtime`,
          detail: `Forecast exceeds technician capacity on ${overList}. Lighter days (${roomList || 'none'}) have room — steer new bookings and waitlist offers there first.`,
          quantity: r1(shift), unit: 'jobs', window: { start, end }, est_cost_cents: null, confidence: 'medium',
          evidence: [`Overload: ${r1(deficit)} jobs over capacity (p90 case ${r1(p90)})`, `Headroom on other days: ${r1(room.reduce((a, d) => a + d.room, 0))} jobs`],
        });
      }
      if (net >= 0.5) {
        const hours = net * jobHours;
        const perTech = hours / Math.max(1, tech.headcount);
        const cost = techRate ? Math.round(hours * techRate * settings.overtime_multiplier) : null;
        recs.push({
          id: `overtime-w${w}`, kind: 'overtime', severity: perTech > 10 ? 'high' : w === 0 ? 'high' : 'medium',
          title: `Plan ~${Math.ceil(hours)} overtime hour${Math.ceil(hours) === 1 ? '' : 's'} (${fmtDay(start)} – ${fmtDay(end)})`,
          detail: `After rebalancing, ~${r1(net)} jobs still exceed capacity on ${overList}. That is ~${r1(perTech)} h per technician${perTech > 10 ? ' — more than overtime alone should cover; consider a contractor or temporary help.' : '.'}`,
          quantity: r1(hours), unit: 'overtime_hours', window: { start, end }, est_cost_cents: cost, confidence: 'medium',
          evidence: [
            `${r1(net)} jobs x ${r2(jobHours)} h average on-site time`,
            ...(cost !== null ? [`~${money(cost)} at ${settings.overtime_multiplier}x wage`] : []),
          ],
        });
      }
    }

    // Sustained: hire.
    const overWeeks = weekly.filter((w) => w.utilization_pct !== null && w.utilization_pct >= policy.full_threshold_pct);
    const robust = weekly.filter((w) => w.utilization_p10_pct !== null && w.utilization_p10_pct >= policy.full_threshold_pct);
    const lowWeeks = weekly.filter((w) => w.utilization_pct !== null && w.utilization_pct <= policy.low_threshold_pct);
    if (overWeeks.length >= Math.max(1, settings.sustained_weeks_to_hire)) {
      const avgDemand = mean(overWeeks.map((w) => w.demand.p50));
      const avgCap = mean(overWeeks.map((w) => w.capacity_jobs));
      const perTechWeek = avgCap / Math.max(1, tech.headcount);
      const add = Math.max(1, Math.ceil(Math.max(0, avgDemand / target - avgCap) / Math.max(0.1, perTechWeek) - 1e-9));
      const first = overWeeks[0].week_start;
      const workdays = c.all.filter((d) => d.cap > 0).length;
      const hireCost = techRate ? Math.round(add * settings.tech_paid_hours_per_day * workdays * techRate) : null;
      const otJobs = overWeeks.reduce((a, w) => a + w.deficit_jobs, 0);
      const otCost = techRate ? Math.round(otJobs * jobHours * techRate * settings.overtime_multiplier) : null;
      const conf: Confidence = robust.length >= 2 ? 'high' : 'medium';
      recs.push({
        id: 'hire-technician', kind: 'hire_technician', severity: diffDays(c.today, first) <= 14 ? 'high' : 'medium',
        title: `Hire ${add} technician${add === 1 ? '' : 's'} — demand stays above ${policy.full_threshold_pct}% for ${overWeeks.length} of the next 8 weeks`,
        detail: `Projected utilization is ≥${policy.full_threshold_pct}% starting the week of ${first}. Adding ${add} technician${add === 1 ? '' : 's'} brings it to about ${Math.round(target * 100)}%. Allow lead time for recruiting and onboarding — overtime and rebalancing bridge the gap.`,
        quantity: add, unit: 'technicians', window: { start: first, end: overWeeks[overWeeks.length - 1].week_start }, est_cost_cents: hireCost, confidence: conf,
        evidence: [
          `${overWeeks.length} of 8 weeks at/above full threshold (${robust.length} even in the low-demand case)`,
          `Average projected demand ${r1(avgDemand)} jobs/week vs ${r1(avgCap)} capacity`,
          ...(hireCost !== null && otCost !== null
            ? [`8-week wages for the hire ~${money(hireCost)} vs ~${money(otCost)} to cover the same overload with overtime (wages only; excludes benefits, vehicle, recruiting)`]
            : []),
        ],
      });
    } else if (lowWeeks.length >= 3 && overWeeks.length === 0) {
      const avgDemand = mean(lowWeeks.map((w) => w.demand.p50));
      const avgCap = mean(lowWeeks.map((w) => w.capacity_jobs));
      recs.push({
        id: 'generate-demand', kind: 'generate_demand', severity: 'low',
        title: `Spare technician capacity in ${lowWeeks.length} of the next 8 weeks`,
        detail: `Projected utilization is at/below ${policy.low_threshold_pct}% (≈${r1(avgCap - avgDemand)} idle jobs/week). Do not hire; run demand campaigns for those weeks (see Capacity Demand Control).`,
        quantity: r1(avgCap - avgDemand), unit: 'jobs', window: { start: lowWeeks[0].week_start, end: lowWeeks[lowWeeks.length - 1].week_start },
        est_cost_cents: null, confidence: 'medium', evidence: [`Average ${r1(avgDemand)} jobs/week vs ${r1(avgCap)} capacity`],
      });
    }
  }

  // --- CSR / AI coverage (next 7 days)
  const next7 = daily.slice(0, 7);
  const humanTotal = next7.reduce((a, d) => a + d.human_calls, 0);
  const humanAfter = next7.reduce((a, d) => a + d.human_calls_after_hours, 0);
  if (c.hasCallData && humanTotal >= 7) {
    if (c.concurrentCsr === 0) {
      recs.push({
        id: 'configure-csr', kind: 'configure_csr', severity: 'high',
        title: 'Callers asking for a person, but no CSR coverage is configured',
        detail: `About ${Math.round(humanTotal)} calls next week are expected to need a human. Add CSR team members (or set the concurrent-CSR override in settings).`,
        quantity: null, unit: null, window: null, est_cost_cents: null, confidence: 'medium', evidence: [],
      });
    } else {
      const gapByHour = new Array<number>(24).fill(0);
      let reqPeak = 0;
      for (const hr of hourly) {
        if (hr.open && hr.gap > 0.25) gapByHour[hr.hour]++;
        if (hr.open) reqPeak = Math.max(reqPeak, hr.csr_required);
      }
      const gapHours = gapByHour.map((n, h) => (n >= 3 ? h : -1)).filter((h) => h >= 0);
      if (gapHours.length > 0) {
        const add = Math.max(1, Math.ceil(reqPeak - c.concurrentCsr - 1e-9));
        const start = Math.min(...gapHours);
        const end = Math.max(...gapHours) + 1;
        const weekHours = gapHours.length * 5;
        const cost = csrRate ? Math.round(add * weekHours * csrRate) : null;
        recs.push({
          id: 'add-csr-coverage', kind: 'add_csr_coverage', severity: 'medium',
          title: `Add ${add} CSR${add === 1 ? '' : 's'} on the phones ${pad(start)}:00–${pad(end)}:00`,
          detail: `Human-handled call demand exceeds CSR capacity in those hours on at least 3 of the next 7 days (peak need ≈${r1(reqPeak)} CSRs vs ${c.concurrentCsr} scheduled). The AI keeps answering; the gap is callers who ask for a person.`,
          quantity: add, unit: 'csr', window: { start: next7[0].date, end: next7[6].date }, est_cost_cents: cost, confidence: 'medium',
          evidence: [`${gapHours.length} hour(s) with a gap on ≥3 days`, ...(cost !== null ? [`~${money(cost)}/week at the configured CSR wage`] : [])],
        });
      }
    }
    if (humanAfter >= 3 && humanAfter / humanTotal >= 0.25) {
      recs.push({
        id: 'after-hours-coverage', kind: 'after_hours_coverage', severity: 'low',
        title: `~${Math.round(humanAfter)} person-requested calls next week land after hours`,
        detail: `${Math.round((humanAfter / humanTotal) * 100)}% of expected human-handled demand falls outside business hours. Plan a morning callback block or an on-call rota.`,
        quantity: r1(humanAfter), unit: 'calls_per_week', window: { start: next7[0].date, end: next7[6].date }, est_cost_cents: null, confidence: 'medium',
        evidence: [`${r1(humanAfter)} of ${r1(humanTotal)} expected human-handled calls`],
      });
    }
  }

  if (c.hoursAssumed) {
    recs.push({
      id: 'set-hours', kind: 'improve_data', severity: 'info', title: 'Set business hours for sharper coverage numbers',
      detail: 'No business hours are saved, so Mon–Fri 08:00–17:00 was assumed for technician days and CSR coverage.',
      quantity: null, unit: null, window: null, est_cost_cents: null, confidence: 'high', evidence: [],
    });
  }

  if (!recs.some((r) => r.severity !== 'info')) {
    recs.push({
      id: 'balanced', kind: 'balanced', severity: 'info', title: 'Staffing looks balanced for the next 8 weeks',
      detail: 'Projected technician utilization stays inside your capacity thresholds and CSR coverage meets expected human-handled calls. No hiring or overtime needed.',
      quantity: null, unit: null, window: null, est_cost_cents: null, confidence: 'medium', evidence: [],
    });
  }
  return recs.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
}

/** Compact, number-only summary for the narrative layer (never invents; only restates). */
export function summarizeForNarrative(r: StaffingReport): Record<string, unknown> {
  return {
    confidence: r.confidence,
    capacity: r.capacity,
    headline: r.headline,
    weeks_over_full: r.weekly.filter((w) => w.status === 'full').length,
    weeks_low: r.weekly.filter((w) => w.status === 'low').length,
    weather_used: r.data_quality.weather === 'used',
    regional: r.drivers.regional,
    recommendations: r.recommendations.slice(0, 5).map((x) => ({
      kind: x.kind, severity: x.severity, title: x.title, quantity: x.quantity, unit: x.unit, window: x.window,
    })),
  };
}
