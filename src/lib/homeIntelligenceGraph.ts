import type { Equipment, EquipmentMaintenanceAlert } from '@/lib/supabase';
import type { PropertyTwin } from '@/lib/propertyTwin';
import {
  CATEGORY_LABELS,
  HEALTH_CATEGORIES,
  classifyEquipment,
  computeHomeHealth,
  monthsOverdue,
  type HealthCategoryKey,
  type HomeHealth,
} from '@/lib/homeHealthScore';
import { CLIMATE_LABELS, DEFAULT_COSTS, climateForState, type ClimateClass, type CostProfile } from '@/lib/homeBudget';
import {
  CLIMATE_HAZARD,
  PROPERTY_HAZARD,
  SYSTEM_MODEL,
  UNKNOWN_AGE_RATIO,
  WARRANTY_COVERAGE,
  alertFactor,
  computeLifetimeServicePlan,
  failureProbability,
  formatMonths,
  historyFactor,
  homeAgeFromYearBuilt,
  isValidYearBuilt,
  maintenanceFactor,
  readRepairVisits,
  yearsToQuantile,
} from '@/lib/lifetimeServicePlan';

/**
 * Vireek Home Intelligence Graph — the digital history of one home, as a graph.
 *
 *   HOME ─┬─ system (HVAC, Water heater, Plumbing, Electrical, Roof, Safety)
 *         │     └─ component (the actual furnace / AC / panel on record)
 *
 * Pure, deterministic and explainable: no network, no randomness. The same twin,
 * the same year built, the same energy readings and the same `now` always produce
 * the same graph. It reuses the exact hazard model of the Lifetime Service Plan
 * (Weibull wear-out + climate × property × repair history × overdue service ×
 * predictive alerts), so every Vireek surface tells the homeowner the same story.
 *
 * What it adds on top of the plan:
 *   1. Near-term risk: chance of a failure or serious issue in the next 6 and 12
 *      months for every node, plus the risk a year from now if nothing is done.
 *   2. Attribution: how many percentage points each driver (age, repairs, overdue
 *      service, alerts, energy, climate) adds to the 12-month risk.
 *   3. "Act now" what-if: if the service-fixable issues were resolved today, how
 *      much risk and expected cost goes away, net of the service price.
 *   4. Energy behaviour as a weak early-warning signal for HVAC.
 *   5. Data coverage: which of the nine inputs are connected, so the graph is
 *      honest about how much of it is measured and how much is assumed.
 *
 * All money is in today's US dollars and is an EXPECTED value (probability ×
 * cost), never a quote or a promise. Probabilities describe "at least one failure
 * or serious issue" for the node, not a specific named fault.
 */

// ---------------------------------------------------------------------- config

export const GRAPH_RISK_HIGH_12M = 0.25;
export const GRAPH_RISK_MEDIUM_12M = 0.1;
/** Minimum 12-month net saving (USD) before a service is called "recommended". */
export const MIN_NET_BENEFIT = 25;
const MAX_COMBINED = 0.97;
/** A driver must move the 12-month risk by at least this much to be listed. */
const MIN_DRIVER_IMPACT = 0.005;
const MAX_DRIVERS = 4;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Energy: year-over-year change in the latest three months vs the same months a year earlier. */
const ENERGY_PAIRS_NEEDED = 3;
const ENERGY_ELEVATED_YOY = 0.1;
const ENERGY_HIGH_YOY = 0.25;
const ENERGY_STALE_MONTHS = 6;
const ENERGY_HAZARD = { normal: 1, elevated: 1.08, high: 1.18 } as const;

const SERVICE_NAME: Record<HealthCategoryKey, string> = {
  hvac: 'HVAC tune-up & inspection',
  water_heater: 'Water heater flush & inspection',
  plumbing: 'Plumbing inspection',
  electrical: 'Electrical safety inspection',
  roof: 'Roof inspection',
  safety: 'Safety device test',
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** Chance of at least one event across independent items. */
const combine = (ps: number[]) => r4(Math.min(MAX_COMBINED, 1 - ps.reduce((acc, p) => acc * (1 - p), 1)));
const pct = (p: number) => `${Math.round(p * 100)}%`;
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

// ---------------------------------------------------------------------- output

export type GraphNodeKind = 'home' | 'system' | 'component';
export type GraphRiskLevel = 'low' | 'medium' | 'high';
export type GraphConfidence = 'low' | 'medium' | 'high';
export type GraphBasis = 'aggregate' | 'equipment' | 'home_age';
export type DriverKey = 'age' | 'repairs' | 'maintenance' | 'alerts' | 'energy' | 'environment';

export const GRAPH_RISK_LABELS: Record<GraphRiskLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' };
export const GRAPH_BASIS_LABELS: Record<GraphBasis, string> = {
  aggregate: 'Whole home',
  equipment: 'From equipment records',
  home_age: 'Estimated from home age',
};
export const DRIVER_LABELS: Record<DriverKey, string> = {
  age: 'Age vs expected life',
  repairs: 'Repair history',
  maintenance: 'Service schedule',
  alerts: 'Predictive alerts',
  energy: 'Energy behaviour',
  environment: 'Climate & property use',
};

export interface GraphDriver {
  key: DriverKey;
  label: string;
  /** Percentage points (0–1 scale) this driver adds to the 12-month failure risk. */
  impact: number;
  detail: string;
}

export interface MaintenanceWhatIf {
  title: string;
  detail: string;
  serviceCost: number;
  riskBefore12m: number;
  riskAfter12m: number;
  /** riskBefore12m − riskAfter12m (0–1 scale). */
  riskReduction: number;
  expectedLossBefore: number;
  expectedLossAfter: number;
  /** Expected repair/replacement cost avoided over 12 months, before the service price. */
  expectedAvoided: number;
  /** expectedAvoided − serviceCost. Can be negative: the graph says so honestly. */
  netBenefit: number;
  /** Median extra years of life from resolving the service-fixable issues. */
  extraLifeYears: number;
  recommended: boolean;
}

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  parentId: string | null;
  categoryKey: HealthCategoryKey | null;
  basis: GraphBasis;
  confidence: GraphConfidence;
  ageYears: number | null;
  ageAssumed: boolean;
  lifespanYears: number | null;
  risk6m: number;
  risk12m: number;
  /** Chance of a failure in the 12 months after the next 12, if nothing is done. */
  riskNextYear: number;
  /** 12-month risk for a typical unit of the same age (climate/property only). */
  baselineRisk12m: number;
  level: GraphRiskLevel;
  /** Expected repair/replacement cost over the next 12 months if nothing is done. */
  expectedLoss12m: number;
  /** Median months until a replacement is likely needed; null when not meaningful. */
  replaceInMonths: number | null;
  drivers: GraphDriver[];
  warranty: { active: boolean; expiresAt: string | null } | null;
  maintenance: MaintenanceWhatIf | null;
  headline: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphAction {
  nodeId: string;
  categoryKey: HealthCategoryKey;
  label: string;
  title: string;
  detail: string;
  serviceCost: number;
  expectedAvoided: number;
  netBenefit: number;
  riskBefore12m: number;
  riskAfter12m: number;
  recommended: boolean;
}

export interface ActNowSummary {
  actionCount: number;
  serviceCost: number;
  expectedAvoided: number;
  netBenefit: number;
  riskBefore12m: number;
  riskAfter12m: number;
  riskReduction: number;
}

export interface GraphInsight {
  id: string;
  nodeId: string;
  severity: GraphRiskLevel;
  title: string;
  body: string;
}

export type SignalState = 'connected' | 'partial' | 'missing';
export type SignalKey =
  | 'home_age'
  | 'equipment_age'
  | 'repair_history'
  | 'energy'
  | 'climate'
  | 'failure_patterns'
  | 'maintenance'
  | 'warranty'
  | 'property';

export interface DataSignal {
  key: SignalKey;
  label: string;
  state: SignalState;
  detail: string;
  /** What to add to sharpen the graph; null when already connected. */
  improve: string | null;
}

export type EnergyState = 'none' | 'insufficient' | 'normal' | 'elevated' | 'high';

export interface EnergyReading {
  /** ISO date; only the year and month are used. */
  period_start: string;
  energy_kwh: number;
  cost_usd?: number | null;
}

export interface EnergySignal {
  state: EnergyState;
  /** Year-over-year change of the latest three months, e.g. 0.18 = +18%. */
  yoyChange: number | null;
  readingCount: number;
  /** Hazard multiplier applied to HVAC (1 = no effect). */
  hvacMultiplier: number;
  summary: string;
}

export interface HomeIntelligenceGraph {
  yearBuilt: number | null;
  homeAgeYears: number | null;
  climate: ClimateClass;
  climateLabel: string;
  health: HomeHealth;
  nodes: GraphNode[];
  edges: GraphEdge[];
  risk6m: number;
  risk12m: number;
  level: GraphRiskLevel;
  expectedLoss12m: number;
  actions: GraphAction[];
  actNow: ActNowSummary | null;
  insights: GraphInsight[];
  signals: DataSignal[];
  /** 0–100: share of the nine inputs that are connected (partial counts half). */
  completenessPct: number;
  confidence: GraphConfidence;
  energy: EnergySignal;
  outlook: { tenYearTotal: number; suggestedMonthlyReserve: number } | null;
  assumptions: string[];
}

export interface GraphOptions {
  now?: number;
  yearBuilt?: number | null;
  energyReadings?: EnergyReading[];
  /** Per-category overrides of the default cost profile (e.g. from the price book). */
  costs?: Partial<Record<HealthCategoryKey, Partial<CostProfile>>>;
}

// --------------------------------------------------------------------- energy

const monthKey = (iso: string) => iso.slice(0, 7);
const monthIndex = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return y * 12 + (m - 1);
};

/**
 * Energy behaviour as a weak early-warning signal. Compares the latest three months
 * that have a reading exactly one year earlier. It is NOT weather-normalised, so it
 * can only nudge HVAC risk (at most +18%) and is always labelled as a weak signal.
 */
export function analyzeEnergy(readings: EnergyReading[], now: number = Date.now()): EnergySignal {
  const nowIdx = monthIndex(new Date(now).toISOString().slice(0, 7));
  const byMonth = new Map<string, number>();
  for (const r of readings) {
    if (!/^\d{4}-\d{2}/.test(r.period_start)) continue;
    if (!Number.isFinite(r.energy_kwh) || r.energy_kwh < 0) continue;
    const key = monthKey(r.period_start);
    if (monthIndex(key) > nowIdx) continue; // future months are not readings
    byMonth.set(key, r.energy_kwh);
  }
  const base = { yoyChange: null, readingCount: byMonth.size, hvacMultiplier: 1 } as const;
  if (byMonth.size === 0) {
    return { ...base, state: 'none', summary: 'No energy readings recorded for this property.' };
  }

  const pairs: Array<{ recent: number; prior: number; idx: number }> = [];
  for (const key of [...byMonth.keys()].sort().reverse()) {
    const [y, m] = key.split('-').map(Number);
    const prior = byMonth.get(`${y - 1}-${String(m).padStart(2, '0')}`);
    if (prior !== undefined && prior > 0) pairs.push({ recent: byMonth.get(key) as number, prior, idx: monthIndex(key) });
    if (pairs.length === ENERGY_PAIRS_NEEDED) break;
  }

  if (pairs.length < ENERGY_PAIRS_NEEDED) {
    return {
      ...base,
      state: 'insufficient',
      summary: `${byMonth.size} reading${byMonth.size === 1 ? '' : 's'} recorded — three months with a matching month a year earlier are needed to read a trend.`,
    };
  }
  if (nowIdx - pairs[0].idx > ENERGY_STALE_MONTHS) {
    return { ...base, state: 'insufficient', summary: 'Energy readings are more than six months old, so they are not used.' };
  }

  const yoy = sum(pairs.map((p) => p.recent)) / sum(pairs.map((p) => p.prior)) - 1;
  const change = r4(yoy);
  const signed = `${yoy >= 0 ? '+' : ''}${Math.round(yoy * 100)}%`;
  if (yoy >= ENERGY_HIGH_YOY) {
    return { state: 'high', yoyChange: change, readingCount: byMonth.size, hvacMultiplier: ENERGY_HAZARD.high, summary: `Energy use is ${signed} vs the same months last year — a possible efficiency loss (weak signal, not weather-adjusted).` };
  }
  if (yoy >= ENERGY_ELEVATED_YOY) {
    return { state: 'elevated', yoyChange: change, readingCount: byMonth.size, hvacMultiplier: ENERGY_HAZARD.elevated, summary: `Energy use is ${signed} vs the same months last year (weak signal, not weather-adjusted).` };
  }
  return { state: 'normal', yoyChange: change, readingCount: byMonth.size, hvacMultiplier: ENERGY_HAZARD.normal, summary: `Energy use is ${signed} vs the same months last year — within the normal range.` };
}

export type EnergyInputResult =
  | { ok: true; periodStart: string; energyKwh: number; costUsd: number | null }
  | { ok: false; error: string };

/** Validates the add-a-reading form: a YYYY-MM month that is not in the future, kWh ≥ 0, optional cost. */
export function validateEnergyInput(month: string, kwh: string, cost: string, now: number = Date.now()): EnergyInputResult {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { ok: false, error: 'Choose the month this reading covers.' };
  if (monthIndex(month) > monthIndex(new Date(now).toISOString().slice(0, 7))) return { ok: false, error: 'That month has not happened yet.' };
  if (monthIndex(month) < monthIndex(new Date(now).toISOString().slice(0, 7)) - 12 * 15) return { ok: false, error: 'That month is too far in the past.' };
  const energy = Number(kwh.trim());
  if (kwh.trim() === '' || !Number.isFinite(energy) || energy < 0 || energy > 1_000_000) return { ok: false, error: 'Enter the kWh used that month (0 to 1,000,000).' };
  let costUsd: number | null = null;
  if (cost.trim() !== '') {
    const c = Number(cost.trim());
    if (!Number.isFinite(c) || c < 0 || c > 10_000_000) return { ok: false, error: 'Enter the cost as a positive amount, or leave it blank.' };
    costUsd = r2(c);
  }
  return { ok: true, periodStart: `${month}-01`, energyKwh: r2(energy), costUsd };
}

// --------------------------------------------------------------------- units

interface Factors {
  env: number;
  history: number;
  service: number;
  alert: number;
  energy: number;
}

const product = (f: Factors) => f.env * f.history * f.service * f.alert * f.energy;

interface GraphUnit {
  id: string;
  key: HealthCategoryKey;
  label: string;
  basis: 'equipment' | 'home_age';
  age: number;
  ageAssumed: boolean;
  life: number;
  shape: number;
  f: Factors;
  /** Factors after service-fixable issues (overdue service, open alerts) are resolved. */
  fAfter: Factors;
  fixable: boolean;
  costs: CostProfile;
  warrantyUntil: number | null;
  visits: number;
  overdueMonths: number | null;
  alerts: EquipmentMaintenanceAlert[];
}

function ageYears(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / MS_PER_YEAR);
}

const prob = (u: GraphUnit, f: Factors, years: number, age: number = u.age) =>
  failureProbability(age, u.life, u.shape, product(f), years);

const warrantyActive = (u: GraphUnit, now: number) => u.warrantyUntil !== null && u.warrantyUntil > now + 0.5 * MS_PER_YEAR;

/**
 * Cost of one failure event. Young units mostly need a repair; units at the end of
 * their life mostly need a replacement: linear blend between 60% and 100% of life.
 * An active manufacturer warranty covers a share (parts-only), as in homeBudget.ts.
 */
function eventCost(u: GraphUnit, now: number): number {
  const blend = clamp((u.age / u.life - 0.6) / 0.4, 0, 1);
  const base = u.costs.repair + (u.costs.replacement - u.costs.repair) * blend;
  return base * (warrantyActive(u, now) ? 1 - WARRANTY_COVERAGE : 1);
}

function buildUnits(twin: PropertyTwin, yearBuilt: number | null, energy: EnergySignal, costFor: (k: HealthCategoryKey) => CostProfile, now: number): GraphUnit[] {
  const climate = climateForState(twin.site?.state);
  const propertyFactor = PROPERTY_HAZARD[twin.site?.site_type ?? 'other'] ?? 1;
  const envFactor = (key: HealthCategoryKey) => (CLIMATE_HAZARD[climate][key] ?? 1) * propertyFactor;
  const energyFactor = (key: HealthCategoryKey) => (key === 'hvac' ? energy.hvacMultiplier : 1);

  const visits = readRepairVisits(twin, now);
  const alertsByUnit = new Map<string, EquipmentMaintenanceAlert[]>();
  for (const a of twin.maintenanceAlerts) {
    if (a.is_dismissed) continue;
    const list = alertsByUnit.get(a.equipment_id) ?? [];
    list.push(a);
    alertsByUnit.set(a.equipment_id, list);
  }

  const units: GraphUnit[] = [];
  const covered = new Set<HealthCategoryKey>();

  for (const item of twin.equipment as Equipment[]) {
    if (item.status !== 'active') continue;
    const key = classifyEquipment(item);
    if (!key) continue;
    covered.add(key);
    const model = SYSTEM_MODEL[key];
    const life = item.expected_lifespan_years > 0 ? item.expected_lifespan_years : model.life;
    const known = ageYears(item.install_date, now);
    const overdue = monthsOverdue(item, now);
    const alerts = alertsByUnit.get(item.id) ?? [];
    const warranty = item.warranty_expires_at ? new Date(item.warranty_expires_at).getTime() : NaN;
    const f: Factors = {
      env: envFactor(key),
      history: historyFactor(visits.get(item.id) ?? 0),
      service: maintenanceFactor(overdue),
      alert: alertFactor(alerts),
      energy: energyFactor(key),
    };
    units.push({
      id: `eq:${item.id}`,
      key,
      label: [item.make, item.model].filter(Boolean).join(' ') || item.equipment_type,
      basis: 'equipment',
      age: known ?? life * UNKNOWN_AGE_RATIO,
      ageAssumed: known === null,
      life,
      shape: model.shape,
      f,
      fAfter: { ...f, service: 1, alert: 1 },
      fixable: f.service > 1 || f.alert > 1,
      costs: costFor(key),
      warrantyUntil: Number.isNaN(warranty) ? null : warranty,
      visits: visits.get(item.id) ?? 0,
      overdueMonths: overdue,
      alerts,
    });
  }

  const homeAge = homeAgeFromYearBuilt(yearBuilt, now);
  if (homeAge !== null) {
    for (const key of HEALTH_CATEGORIES) {
      const model = SYSTEM_MODEL[key];
      if (!model.estimableFromHomeAge || covered.has(key)) continue;
      const f: Factors = { env: envFactor(key), history: 1, service: 1, alert: 1, energy: energyFactor(key) };
      units.push({
        id: `est:${key}`,
        key,
        label: CATEGORY_LABELS[key],
        basis: 'home_age',
        age: homeAge <= model.life ? homeAge : homeAge % model.life,
        ageAssumed: true,
        life: model.life,
        shape: model.shape,
        f,
        fAfter: f,
        fixable: false,
        costs: costFor(key),
        warrantyUntil: null,
        visits: 0,
        overdueMonths: null,
        alerts: [],
      });
    }
  }
  return units;
}

// ------------------------------------------------------------- per-unit model

const levelFor = (p12: number): GraphRiskLevel => (p12 >= GRAPH_RISK_HIGH_12M ? 'high' : p12 >= GRAPH_RISK_MEDIUM_12M ? 'medium' : 'low');

function unitConfidence(u: GraphUnit): GraphConfidence {
  if (u.basis === 'home_age') return 'low';
  return u.ageAssumed ? 'medium' : 'high';
}

function unitDrivers(u: GraphUnit, energy: EnergySignal): GraphDriver[] {
  const all = prob(u, u.f, 1);
  const without = (patch: Partial<Factors>) => all - prob(u, { ...u.f, ...patch }, 1);
  const drivers: GraphDriver[] = [];

  if (u.basis === 'equipment') {
    const young = failureProbability(0, u.life, u.shape, product(u.f), 1);
    const ratio = Math.round((u.age / u.life) * 100);
    drivers.push({
      key: 'age',
      label: DRIVER_LABELS.age,
      impact: r4(Math.max(0, all - young)),
      detail: `${u.ageAssumed ? 'Assumed ' : ''}${u.age.toFixed(1)} of ${u.life} expected years (${ratio}% of life).${u.ageAssumed ? ' No install date on record.' : ''}`,
    });
  }
  if (u.f.history > 1) {
    drivers.push({ key: 'repairs', label: DRIVER_LABELS.repairs, impact: r4(without({ history: 1 })), detail: `${u.visits} repair visit${u.visits === 1 ? '' : 's'} in the last 24 months.` });
  }
  if (u.f.service > 1) {
    drivers.push({
      key: 'maintenance',
      label: DRIVER_LABELS.maintenance,
      impact: r4(without({ service: 1 })),
      detail: u.overdueMonths === null ? 'No service record on file.' : `Service overdue by about ${Math.max(1, Math.round(u.overdueMonths))} months.`,
    });
  }
  if (u.f.alert > 1) {
    const top = [...u.alerts].sort((a, b) => ({ high: 3, medium: 2, low: 1 })[b.risk_level] - ({ high: 3, medium: 2, low: 1 })[a.risk_level])[0];
    drivers.push({ key: 'alerts', label: DRIVER_LABELS.alerts, impact: r4(without({ alert: 1 })), detail: top?.predicted_issue ?? 'Open predictive maintenance alert.' });
  }
  if (u.f.energy > 1) {
    drivers.push({ key: 'energy', label: DRIVER_LABELS.energy, impact: r4(without({ energy: 1 })), detail: energy.summary });
  }
  if (u.f.env > 1) {
    drivers.push({ key: 'environment', label: DRIVER_LABELS.environment, impact: r4(without({ env: 1 })), detail: 'Local climate and how hard this property works its systems raise wear.' });
  }
  return drivers.filter((d) => d.key === 'age' || d.impact >= MIN_DRIVER_IMPACT).sort((a, b) => b.impact - a.impact).slice(0, MAX_DRIVERS);
}

function unitWhatIf(u: GraphUnit, now: number): MaintenanceWhatIf | null {
  if (!u.fixable) return null;
  const cost = eventCost(u, now);
  const before = prob(u, u.f, 1);
  const after = prob(u, u.fAfter, 1);
  const lossBefore = before * cost;
  const lossAfter = after * cost;
  const avoided = Math.max(0, lossBefore - lossAfter);
  const net = avoided - u.costs.maintenance;
  const top = [...u.alerts].sort((a, b) => ({ high: 3, medium: 2, low: 1 })[b.risk_level] - ({ high: 3, medium: 2, low: 1 })[a.risk_level])[0];
  const title = top ? `Resolve: ${top.predicted_issue.slice(0, 80)}` : u.overdueMonths !== null && u.overdueMonths > 0 ? `Overdue ${SERVICE_NAME[u.key]}` : `Baseline ${SERVICE_NAME[u.key]}`;
  const detail = top?.recommended_action ?? (u.overdueMonths === null ? 'A first service visit establishes the unit’s condition and starts its service record.' : 'Bringing service back on schedule removes the extra wear risk from deferred maintenance.');
  const gain = yearsToQuantile(u.age, u.life, u.shape, 0.5, product(u.fAfter)) - yearsToQuantile(u.age, u.life, u.shape, 0.5, product(u.f));
  return {
    title,
    detail,
    serviceCost: r2(u.costs.maintenance),
    riskBefore12m: r4(before),
    riskAfter12m: r4(after),
    riskReduction: r4(Math.max(0, before - after)),
    expectedLossBefore: r2(lossBefore),
    expectedLossAfter: r2(lossAfter),
    expectedAvoided: r2(avoided),
    netBenefit: r2(net),
    extraLifeYears: r2(Math.max(0, gain)),
    recommended: net >= MIN_NET_BENEFIT,
  };
}

interface UnitResult {
  u: GraphUnit;
  p6: number;
  p12: number;
  pNext: number;
  baseline: number;
  loss: number;
  median: number;
  whatIf: MaintenanceWhatIf | null;
}

function evaluate(u: GraphUnit, now: number): UnitResult {
  const p12 = prob(u, u.f, 1);
  const baselineFactors: Factors = { env: u.f.env, history: 1, service: 1, alert: 1, energy: 1 };
  return {
    u,
    p6: r4(prob(u, u.f, 0.5)),
    p12: r4(p12),
    // Conditional risk in the year after next, given the unit survives the coming year.
    pNext: r4(prob(u, u.f, 1, u.age + 1)),
    baseline: r4(prob(u, baselineFactors, 1)),
    loss: r2(p12 * eventCost(u, now)),
    median: yearsToQuantile(u.age, u.life, u.shape, 0.5, product(u.f)),
    whatIf: unitWhatIf(u, now),
  };
}

// ------------------------------------------------------------------- the graph

function headlineFor(label: string, p12: number, baseline: number): string {
  const excess = Math.round((p12 - baseline) * 100);
  const tail = excess >= 3 ? ` — ${excess} points above typical for its age` : '';
  return `${pct(p12)} chance of a failure or serious issue in the next 12 months${tail}`;
}

function warrantyInfo(results: UnitResult[], now: number): GraphNode['warranty'] {
  const dated = results.filter((r) => r.u.warrantyUntil !== null);
  if (dated.length === 0) return null;
  const latest = Math.max(...dated.map((r) => r.u.warrantyUntil as number));
  return { active: dated.some((r) => warrantyActive(r.u, now)), expiresAt: new Date(latest).toISOString() };
}

function systemWhatIf(key: HealthCategoryKey, results: UnitResult[], risk12m: number): MaintenanceWhatIf | null {
  const fixable = results.filter((r) => r.whatIf !== null);
  if (fixable.length === 0) return null;
  const w = fixable.map((r) => r.whatIf as MaintenanceWhatIf);
  const after = combine(results.map((r) => (r.whatIf ? r.whatIf.riskAfter12m : r.p12)));
  const cost = sum(w.map((x) => x.serviceCost));
  const avoided = sum(w.map((x) => x.expectedAvoided));
  const net = avoided - cost;
  const lead = w.length === 1 ? w[0] : null;
  return {
    title: lead ? lead.title : `${SERVICE_NAME[key]} (${w.length} units)`,
    detail: lead ? lead.detail : 'Resolve the overdue service and open alerts on each unit in this system.',
    serviceCost: r2(cost),
    riskBefore12m: risk12m,
    riskAfter12m: after,
    riskReduction: r4(Math.max(0, risk12m - after)),
    expectedLossBefore: r2(sum(w.map((x) => x.expectedLossBefore))),
    expectedLossAfter: r2(sum(w.map((x) => x.expectedLossAfter))),
    expectedAvoided: r2(avoided),
    netBenefit: r2(net),
    extraLifeYears: r2(Math.max(...w.map((x) => x.extraLifeYears))),
    recommended: net >= MIN_NET_BENEFIT,
  };
}

function buildSignals(twin: PropertyTwin, yearBuilt: number | null, energy: EnergySignal, climate: ClimateClass, now: number): DataSignal[] {
  const active = (twin.equipment as Equipment[]).filter((e) => e.status === 'active' && classifyEquipment(e) !== null);
  const share = (n: number) => (active.length === 0 ? 0 : n / active.length);
  const state = (s: number): SignalState => (s >= 1 ? 'connected' : s > 0 ? 'partial' : 'missing');
  const hasYear = yearBuilt !== null && isValidYearBuilt(yearBuilt, now);
  const dated = active.filter((e) => ageYears(e.install_date, now) !== null).length;
  const serviced = active.filter((e) => e.last_service_date).length;
  const warranted = active.filter((e) => e.warranty_expires_at).length;
  const hasLinks = twin.jobEquipmentLinks.length > 0;
  const hasJobs = twin.jobs.length > 0;
  const siteType = twin.site?.site_type;
  const propertyKnown = (siteType && siteType !== 'other' ? 1 : 0) + (climate !== 'unknown' ? 1 : 0);

  const mk = (key: SignalKey, label: string, s: SignalState, detail: string, improve: string): DataSignal => ({ key, label, state: s, detail, improve: s === 'connected' ? null : improve });

  const repairState: SignalState = hasLinks ? 'connected' : hasJobs ? 'partial' : 'missing';
  const patternState: SignalState = hasLinks || twin.maintenanceAlerts.length > 0 ? 'connected' : active.length > 0 ? 'partial' : 'missing';
  const energyState: SignalState = energy.state === 'none' ? 'missing' : energy.state === 'insufficient' ? 'partial' : 'connected';

  return [
    mk('home_age', 'Home age', hasYear ? 'connected' : 'missing', hasYear ? `Built in ${yearBuilt}.` : 'Year built is not recorded.', 'Add the year the property was built.'),
    mk('equipment_age', 'Equipment age', state(share(dated)), active.length === 0 ? 'No equipment recorded.' : `${dated} of ${active.length} units have an install date.`, 'Add install dates to every unit.'),
    mk('repair_history', 'Repair history', repairState, hasLinks ? `${twin.jobEquipmentLinks.length} service visits linked to equipment.` : hasJobs ? 'Jobs exist but none are linked to a specific unit.' : 'No jobs recorded for this property.', 'Link each job to the unit it touched.'),
    mk('energy', 'Energy behaviour', energyState, energy.summary, 'Add monthly kWh readings, including the same months last year.'),
    mk('climate', 'Weather exposure', climate === 'unknown' ? 'missing' : 'partial', climate === 'unknown' ? 'No US state on the property record.' : `${CLIMATE_LABELS[climate]} (climate zone by state, not live weather).`, 'Add the property’s US state.'),
    mk('failure_patterns', 'Failure patterns', patternState, hasLinks || twin.maintenanceAlerts.length > 0 ? 'Repair visits and predictive alerts are tracked per unit.' : active.length > 0 ? 'Equipment is recorded but no failures or alerts yet.' : 'Nothing to detect patterns from.', 'Record equipment and link repair visits to it.'),
    mk('maintenance', 'Maintenance', state(share(serviced)), active.length === 0 ? 'No equipment recorded.' : `${serviced} of ${active.length} units have a last-service date.`, 'Record the last service date of every unit.'),
    mk('warranty', 'Warranty', state(share(warranted)), active.length === 0 ? 'No equipment recorded.' : `${warranted} of ${active.length} units have a warranty date.`, 'Add warranty expiry dates where they exist.'),
    mk('property', 'Property characteristics', propertyKnown === 2 ? 'connected' : propertyKnown === 1 ? 'partial' : 'missing', `Property type ${siteType && siteType !== 'other' ? 'known' : 'unknown'}; state ${climate !== 'unknown' ? 'known' : 'unknown'}.`, 'Set the property type and state.'),
  ];
}

function buildInsights(systems: GraphNode[]): GraphInsight[] {
  const ranked = systems
    .filter((s) => s.level !== 'low' || (s.maintenance?.recommended ?? false))
    .sort((a, b) => b.expectedLoss12m - a.expectedLoss12m || b.risk12m - a.risk12m)
    .slice(0, 3);
  return ranked.map((s) => {
    const w = s.maintenance;
    let body = `${pct(s.risk12m)} chance of a failure or serious issue in the next 12 months, and ${pct(s.riskNextYear)} in the year after if nothing changes. Expected cost if ignored: ${usd(s.expectedLoss12m)}.`;
    if (w && w.riskReduction >= 0.005) {
      body += w.recommended
        ? ` ${w.title} now is expected to cut the risk to ${pct(w.riskAfter12m)} and avoid about ${usd(w.expectedAvoided)} in expected repair cost, ${usd(w.netBenefit)} net of the ${usd(w.serviceCost)} service.`
        : ` ${w.title} would cut the risk to ${pct(w.riskAfter12m)}, but the expected saving does not exceed its ${usd(w.serviceCost)} cost — do it for peace of mind, not for the numbers.`;
    } else if (s.replaceInMonths !== null) {
      body += ` Service cannot change this much: plan for replacement ${s.replaceInMonths <= 0 ? 'now' : `in about ${formatMonths(s.replaceInMonths)}`}.`;
    }
    if (s.basis === 'home_age') body += ' This is estimated from the home’s age — add equipment records to confirm it.';
    return { id: `insight:${s.id}`, nodeId: s.id, severity: s.level, title: `${s.label} needs attention`, body };
  });
}

export function computeHomeIntelligenceGraph(twin: PropertyTwin, options: GraphOptions = {}): HomeIntelligenceGraph | null {
  const now = options.now ?? Date.now();
  const yearBuilt = options.yearBuilt != null && isValidYearBuilt(options.yearBuilt, now) ? options.yearBuilt : null;
  const energy = analyzeEnergy(options.energyReadings ?? [], now);
  const costFor = (key: HealthCategoryKey): CostProfile => ({ ...DEFAULT_COSTS[key], ...options.costs?.[key] });

  const units = buildUnits(twin, yearBuilt, energy, costFor, now);
  if (units.length === 0) return null;

  const climate = climateForState(twin.site?.state);
  const results = units.map((u) => evaluate(u, now));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const systems: GraphNode[] = [];
  const systemResults = new Map<string, { node: GraphNode; whatIf: MaintenanceWhatIf | null }>();

  for (const key of HEALTH_CATEGORIES) {
    const group = results.filter((r) => r.u.key === key);
    if (group.length === 0) continue;
    const lead = [...group].sort((a, b) => a.median - b.median)[0];
    const risk12m = combine(group.map((r) => r.p12));
    const baseline = combine(group.map((r) => r.baseline));
    const basis: GraphBasis = lead.u.basis;
    const whatIf = systemWhatIf(key, group, risk12m);
    const model = SYSTEM_MODEL[key];
    const meaningfulReplacement = model.kind === 'replacement' || basis === 'equipment';
    const sysId = `sys:${key}`;
    const node: GraphNode = {
      id: sysId,
      kind: 'system',
      label: CATEGORY_LABELS[key],
      parentId: 'home',
      categoryKey: key,
      basis,
      confidence: unitConfidence(lead.u),
      ageYears: r2(lead.u.age),
      ageAssumed: lead.u.ageAssumed,
      lifespanYears: lead.u.life,
      risk6m: combine(group.map((r) => r.p6)),
      risk12m,
      riskNextYear: combine(group.map((r) => r.pNext)),
      baselineRisk12m: baseline,
      level: levelFor(risk12m),
      expectedLoss12m: r2(sum(group.map((r) => r.loss))),
      replaceInMonths: meaningfulReplacement ? Math.max(0, Math.round(lead.median * 12)) : null,
      drivers: unitDrivers(lead.u, energy),
      warranty: warrantyInfo(group, now),
      maintenance: whatIf,
      headline: headlineFor(CATEGORY_LABELS[key], risk12m, baseline),
    };
    systems.push(node);
    nodes.push(node);
    edges.push({ from: 'home', to: sysId });
    systemResults.set(sysId, { node, whatIf });

    for (const r of group) {
      if (r.u.basis !== 'equipment') continue;
      nodes.push({
        id: r.u.id,
        kind: 'component',
        label: r.u.label,
        parentId: sysId,
        categoryKey: key,
        basis: 'equipment',
        confidence: unitConfidence(r.u),
        ageYears: r2(r.u.age),
        ageAssumed: r.u.ageAssumed,
        lifespanYears: r.u.life,
        risk6m: r.p6,
        risk12m: r.p12,
        riskNextYear: r.pNext,
        baselineRisk12m: r.baseline,
        level: levelFor(r.p12),
        expectedLoss12m: r.loss,
        replaceInMonths: Math.max(0, Math.round(r.median * 12)),
        drivers: unitDrivers(r.u, energy),
        warranty: warrantyInfo([r], now),
        maintenance: r.whatIf,
        headline: headlineFor(r.u.label, r.p12, r.baseline),
      });
      edges.push({ from: sysId, to: r.u.id });
    }
  }

  // ---- home-level roll-up ----
  const risk6m = combine(systems.map((s) => s.risk6m));
  const risk12m = combine(systems.map((s) => s.risk12m));
  const expectedLoss12m = r2(sum(systems.map((s) => s.expectedLoss12m)));

  const actions: GraphAction[] = systems
    .filter((s) => s.maintenance !== null && s.maintenance.riskReduction > 0)
    .map((s) => {
      const w = s.maintenance as MaintenanceWhatIf;
      return {
        nodeId: s.id,
        categoryKey: s.categoryKey as HealthCategoryKey,
        label: s.label,
        title: w.title,
        detail: w.detail,
        serviceCost: w.serviceCost,
        expectedAvoided: w.expectedAvoided,
        netBenefit: w.netBenefit,
        riskBefore12m: w.riskBefore12m,
        riskAfter12m: w.riskAfter12m,
        recommended: w.recommended,
      };
    })
    .sort((a, b) => Number(b.recommended) - Number(a.recommended) || b.netBenefit - a.netBenefit);

  const chosen = actions.filter((a) => a.recommended);
  const afterRisk = combine(systems.map((s) => (chosen.some((a) => a.nodeId === s.id) ? (s.maintenance as MaintenanceWhatIf).riskAfter12m : s.risk12m)));
  const actNow: ActNowSummary | null =
    chosen.length === 0
      ? null
      : {
          actionCount: chosen.length,
          serviceCost: r2(sum(chosen.map((a) => a.serviceCost))),
          expectedAvoided: r2(sum(chosen.map((a) => a.expectedAvoided))),
          netBenefit: r2(sum(chosen.map((a) => a.netBenefit))),
          riskBefore12m: risk12m,
          riskAfter12m: afterRisk,
          riskReduction: r4(Math.max(0, risk12m - afterRisk)),
        };

  const signals = buildSignals(twin, yearBuilt, energy, climate, now);
  const completenessPct = Math.round((sum(signals.map((s) => (s.state === 'connected' ? 1 : s.state === 'partial' ? 0.5 : 0))) / signals.length) * 100);
  const confidence: GraphConfidence = completenessPct >= 70 ? 'high' : completenessPct >= 40 ? 'medium' : 'low';

  const homeNode: GraphNode = {
    id: 'home',
    kind: 'home',
    label: twin.site?.name ?? 'Home',
    parentId: null,
    categoryKey: null,
    basis: 'aggregate',
    confidence,
    ageYears: homeAgeFromYearBuilt(yearBuilt, now),
    ageAssumed: false,
    lifespanYears: null,
    risk6m,
    risk12m,
    riskNextYear: combine(systems.map((s) => s.riskNextYear)),
    baselineRisk12m: combine(systems.map((s) => s.baselineRisk12m)),
    level: levelFor(risk12m),
    expectedLoss12m,
    replaceInMonths: null,
    drivers: [],
    warranty: null,
    maintenance: actNow
      ? {
          title: `${actNow.actionCount} recommended service${actNow.actionCount === 1 ? '' : 's'}`,
          detail: 'Resolve the overdue service and open alerts that are expected to pay for themselves.',
          serviceCost: actNow.serviceCost,
          riskBefore12m: actNow.riskBefore12m,
          riskAfter12m: actNow.riskAfter12m,
          riskReduction: actNow.riskReduction,
          expectedLossBefore: expectedLoss12m,
          expectedLossAfter: r2(Math.max(0, expectedLoss12m - actNow.expectedAvoided)),
          expectedAvoided: actNow.expectedAvoided,
          netBenefit: actNow.netBenefit,
          extraLifeYears: 0,
          recommended: true,
        }
      : null,
    headline: headlineFor('home', risk12m, combine(systems.map((s) => s.baselineRisk12m))),
  };

  const plan = computeLifetimeServicePlan(twin, yearBuilt, { now, costs: options.costs });
  const homeAge = homeAgeFromYearBuilt(yearBuilt, now);

  const assumptions: string[] = [
    'Probabilities mean “at least one failure or serious issue” for the node within the window — not a specific named fault.',
    'Dollar figures are expected values (probability × typical repair or replacement cost, in today’s dollars). They are planning estimates, not quotes or guarantees.',
    'The “act now” what-if only removes risk that service can fix: overdue maintenance and open predictive alerts. Age and repair history are never assumed away.',
  ];
  if (yearBuilt === null) assumptions.push('No year built on record, so systems without equipment are not estimated.');
  if (units.some((u) => u.basis === 'home_age')) assumptions.push('Systems estimated from the home’s age assume one original component replaced on a typical cycle, and carry the widest uncertainty.');
  if (units.some((u) => u.basis === 'equipment' && u.ageAssumed)) assumptions.push(`Units with no install date are assumed to be ${Math.round(UNKNOWN_AGE_RATIO * 100)}% through their expected life.`);
  assumptions.push(climate === 'unknown' ? 'No US state on the property record, so no climate adjustment was applied.' : `${CLIMATE_LABELS[climate]} adjustment applied to weather-exposed systems; this is a climate zone, not a live weather feed.`);
  if (energy.state === 'none' || energy.state === 'insufficient') assumptions.push('No usable energy history, so energy behaviour did not affect any risk.');
  else assumptions.push('Energy behaviour is a weak, not weather-adjusted signal and can raise HVAC risk by at most 18%.');

  return {
    yearBuilt,
    homeAgeYears: homeAge,
    climate,
    climateLabel: CLIMATE_LABELS[climate],
    health: computeHomeHealth(twin, now),
    nodes: [homeNode, ...nodes],
    edges,
    risk6m,
    risk12m,
    level: levelFor(risk12m),
    expectedLoss12m,
    actions,
    actNow,
    insights: buildInsights(systems),
    signals,
    completenessPct,
    confidence,
    energy,
    outlook: plan ? { tenYearTotal: plan.tenYearTotal, suggestedMonthlyReserve: plan.suggestedMonthlyReserve } : null,
    assumptions,
  };
}

/** Children of a node, in graph order. */
export function childrenOf(graph: HomeIntelligenceGraph, nodeId: string): GraphNode[] {
  const ids = new Set(graph.edges.filter((e) => e.from === nodeId).map((e) => e.to));
  return graph.nodes.filter((n) => ids.has(n.id));
}
