import type { Equipment, EquipmentMaintenanceAlert } from '@/lib/supabase';
import type { PropertyTwin } from '@/lib/propertyTwin';
import {
  CATEGORY_LABELS,
  HEALTH_CATEGORIES,
  classifyEquipment,
  monthsOverdue,
  type HealthCategoryKey,
} from '@/lib/homeHealthScore';

/**
 * Vireek Home Operating Budget — the financial layer on top of the Property Twin.
 *
 * Pure, deterministic and explainable: no network, no new schema, no randomness.
 * The same twin + the same `now` always yields the same budget, and every dollar
 * traces back to a concrete fact (age vs. lifespan, overdue service, repair
 * history, climate, warranty, property type).
 *
 * Model (per active, classifiable unit, per year t = 0..4):
 *   1. Wear-out hazard: Weibull (shape 4) with characteristic life = expected
 *      lifespan, conditioned on the unit's current age, plus a small base hazard
 *      for random failures. Yearly increment: ΔH(t) = ((a+1)/L)^k − (a/L)^k + base.
 *   2. Proportional-hazards modifiers: p(t) = 1 − exp(−ΔH(t) · m), where
 *      m = climate × property/usage × repair history × maintenance/alerts.
 *   3. Event cost: blend of repair and replacement cost that shifts toward
 *      replacement as the unit passes its expected life. Repair cost is
 *      calibrated with this property's real invoices when they exist.
 *   4. Manufacturer warranty removes a share of the event cost while active.
 *   5. Scheduled maintenance spend is added (only when the unit is on schedule).
 *
 * Scenario "serviced": overdue service is caught up and stays on schedule, and
 * open predictive alerts are resolved. The delta vs. the baseline is what the
 * recommendations report — net of the added maintenance spend.
 *
 * Deliberately NOT modelled: brand reliability priors (we only use the owner's own
 * warranty data for the manufacturer signal) and regional labor rates. Cost
 * defaults are US planning figures and can be overridden via `options.costs`.
 */

// ---------------------------------------------------------------------- config

export const BUDGET_HORIZON_YEARS = 5;

export interface CostProfile {
  /** One scheduled service visit. */
  maintenance: number;
  /** Typical repair event. */
  repair: number;
  /** Full replacement of the unit. */
  replacement: number;
}

export const DEFAULT_COSTS: Readonly<Record<HealthCategoryKey, CostProfile>> = {
  hvac: { maintenance: 180, repair: 650, replacement: 7500 },
  water_heater: { maintenance: 120, repair: 420, replacement: 1800 },
  plumbing: { maintenance: 150, repair: 480, replacement: 1400 },
  electrical: { maintenance: 130, repair: 380, replacement: 3200 },
  roof: { maintenance: 220, repair: 900, replacement: 12000 },
  safety: { maintenance: 45, repair: 120, replacement: 180 },
};

const FALLBACK_LIFESPAN_YEARS: Record<HealthCategoryKey, number> = {
  hvac: 15,
  water_heater: 11,
  plumbing: 20,
  electrical: 30,
  roof: 22,
  safety: 10,
};

const WEIBULL_SHAPE = 4;
/** Cumulative-hazard floor per year: random/early-life failures exist at any age. */
const BASE_HAZARD = 0.02;
const MAX_ANNUAL_PROBABILITY = 0.95;
/** Unknown install date: assume the unit is this far through its expected life. */
const UNKNOWN_AGE_RATIO = 0.6;
/** Manufacturer warranties are typically parts-only: share of event cost covered. */
const WARRANTY_COVERAGE = 0.5;
/** Minimum 5-year net saving (USD) before a service is recommended. */
const MIN_RECOMMENDED_NET_SAVING = 50;

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const cents = (n: number) => Math.round(n * 100) / 100;

// --------------------------------------------------------------------- climate

export type ClimateClass = 'hot' | 'cold' | 'mild' | 'mixed' | 'unknown';

export const CLIMATE_LABELS: Record<ClimateClass, string> = {
  hot: 'Hot climate',
  cold: 'Cold climate',
  mild: 'Mild coastal climate',
  mixed: 'Mixed climate',
  unknown: 'Climate unknown',
};

const US_STATES =
  'AL:Alabama,AK:Alaska,AZ:Arizona,AR:Arkansas,CA:California,CO:Colorado,CT:Connecticut,DE:Delaware,DC:District of Columbia,' +
  'FL:Florida,GA:Georgia,HI:Hawaii,ID:Idaho,IL:Illinois,IN:Indiana,IA:Iowa,KS:Kansas,KY:Kentucky,LA:Louisiana,ME:Maine,' +
  'MD:Maryland,MA:Massachusetts,MI:Michigan,MN:Minnesota,MS:Mississippi,MO:Missouri,MT:Montana,NE:Nebraska,NV:Nevada,' +
  'NH:New Hampshire,NJ:New Jersey,NM:New Mexico,NY:New York,NC:North Carolina,ND:North Dakota,OH:Ohio,OK:Oklahoma,' +
  'OR:Oregon,PA:Pennsylvania,RI:Rhode Island,SC:South Carolina,SD:South Dakota,TN:Tennessee,TX:Texas,UT:Utah,VT:Vermont,' +
  'VA:Virginia,WA:Washington,WV:West Virginia,WI:Wisconsin,WY:Wyoming';

const STATE_CODE_BY_NAME = new Map<string, string>();
const VALID_STATE_CODES = new Set<string>();
for (const entry of US_STATES.split(',')) {
  const [code, name] = entry.split(':');
  VALID_STATE_CODES.add(code);
  STATE_CODE_BY_NAME.set(name.toLowerCase(), code);
}

const CLIMATE_BY_STATE: Record<string, ClimateClass> = {};
for (const code of 'FL LA MS AL GA SC TX AZ NV NM HI'.split(' ')) CLIMATE_BY_STATE[code] = 'hot';
for (const code of 'ME NH VT MA CT RI NY PA MN WI MI ND SD MT WY AK IA NE ID CO'.split(' ')) CLIMATE_BY_STATE[code] = 'cold';
for (const code of 'CA OR WA'.split(' ')) CLIMATE_BY_STATE[code] = 'mild';
for (const code of VALID_STATE_CODES) if (!CLIMATE_BY_STATE[code]) CLIMATE_BY_STATE[code] = 'mixed';

export function climateForState(state: string | null | undefined): ClimateClass {
  const raw = (state ?? '').trim();
  if (!raw) return 'unknown';
  const code = raw.length === 2 ? raw.toUpperCase() : STATE_CODE_BY_NAME.get(raw.toLowerCase());
  return (code && CLIMATE_BY_STATE[code]) || 'unknown';
}

/** Hazard multipliers by climate stress. Categories not listed are unaffected. */
const CLIMATE_HAZARD: Record<ClimateClass, Partial<Record<HealthCategoryKey, number>>> = {
  hot: { hvac: 1.18, roof: 1.12, electrical: 1.05 },
  cold: { hvac: 1.1, roof: 1.15, plumbing: 1.15, water_heater: 1.05 },
  mild: {},
  mixed: {},
  unknown: {},
};

/** Hazard multipliers by how hard the property works its systems. */
const PROPERTY_HAZARD: Record<string, number> = {
  residential_complex: 1.15,
  hospitality: 1.3,
  medical: 1.2,
  industrial: 1.25,
  education: 1.15,
  retail: 1.1,
  office: 1.1,
  other: 1,
};

// ---------------------------------------------------------------------- output

export type BudgetDriverKey = 'age' | 'climate' | 'property' | 'history' | 'maintenance' | 'warranty';

export const DRIVER_LABELS: Record<BudgetDriverKey, string> = {
  age: 'Equipment age',
  climate: 'Climate',
  property: 'Property & usage',
  history: 'Repair history',
  maintenance: 'Maintenance status',
  warranty: 'Manufacturer warranty',
};

export type BudgetConfidence = 'low' | 'medium' | 'high';

export interface BudgetCategory {
  key: HealthCategoryKey;
  label: string;
  annual: number;
  fiveYear: number;
  equipmentCount: number;
}

export interface BudgetYear {
  /** 1-based year of the horizon. */
  year: number;
  maintenance: number;
  expectedFailure: number;
  total: number;
}

export interface BudgetDriver {
  key: BudgetDriverKey;
  label: string;
  /** Signed effect on the year-1 budget vs. a neutral baseline (negative = saves money). */
  annualImpact: number;
  /** Signed effect on the 5-year exposure. */
  fiveYearImpact: number;
  detail: string;
}

export interface BudgetRecommendation {
  categoryKey: HealthCategoryKey;
  categoryLabel: string;
  equipmentIds: string[];
  title: string;
  /** Extra maintenance spend in year 1 vs. today's behaviour. */
  year1Outlay: number;
  /** Expected repair/replacement cost avoided over the horizon. */
  failureCostAvoided5y: number;
  /** Avoided cost minus the added maintenance spend over the horizon. */
  netSaving5y: number;
  /** Chance of at least one failure in the next 12 months, before → after. */
  riskBefore: number;
  riskAfter: number;
}

export interface HomeBudget {
  /** Expected year-1 maintenance + repair/replacement cost. */
  annual: number;
  annualLow: number;
  annualHigh: number;
  /** Sum of years 1–5 (rises as equipment ages). */
  fiveYear: number;
  fiveYearLow: number;
  fiveYearHigh: number;
  years: BudgetYear[];
  categories: BudgetCategory[];
  drivers: BudgetDriver[];
  recommendations: BudgetRecommendation[];
  /** Budget if every recommendation is carried out. */
  withPlan: { annual: number; fiveYear: number };
  /** Suggested monthly set-aside covering expected repair/replacement events. */
  suggestedMonthlyReserve: number;
  confidence: BudgetConfidence;
  scoredEquipmentCount: number;
  unclassifiedCount: number;
  /** Systems with no equipment on record: excluded, never guessed. */
  uncoveredCategories: HealthCategoryKey[];
  climate: ClimateClass;
  /** Plain-language modelling caveats specific to this property's data. */
  assumptions: string[];
}

export interface BudgetOptions {
  now?: number;
  /** Per-category overrides of the default cost profile (e.g. from the price book). */
  costs?: Partial<Record<HealthCategoryKey, Partial<CostProfile>>>;
}

// ---------------------------------------------------------------- internal model

interface Unit {
  equipmentId: string;
  label: string;
  category: HealthCategoryKey;
  lifespan: number;
  /** Age used by the model (assumed when the install date is missing). */
  age: number;
  ageKnown: boolean;
  climate: number;
  property: number;
  historyFactor: number;
  /** null = no baseline date, so service status is unknown. */
  overdueMonths: number | null;
  alertFactor: number;
  warrantyUntil: number | null;
  annualMaintenance: number;
  costs: CostProfile;
}

interface Scenario {
  serviced: boolean;
  neutral?: BudgetDriverKey;
}

interface Projection {
  failure: number[];
  maintenance: number[];
  probability: number[];
}

const ALERT_HAZARD = { high: 1.5, medium: 1.25, low: 1.08 } as const;
const MAINTENANCE_VISIT = /maint|tune|inspect|clean|flush|check|service\s*plan|seasonal|filter|annual|install/i;
const REPAIR_WINDOW_MS = 24 * 30.4375 * 24 * 60 * 60 * 1000;

function ageYears(install: string | null, now: number): number | null {
  if (!install) return null;
  const t = new Date(install).getTime();
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / MS_PER_YEAR);
}

function historyFactor(repairVisits: number): number {
  if (repairVisits >= 3) return 1.6;
  if (repairVisits === 2) return 1.3;
  if (repairVisits === 1) return 1.1;
  return 1;
}

function maintenanceFactor(overdueMonths: number | null, yearIndex: number): number {
  if (overdueMonths === null) return 1.1;
  if (overdueMonths <= 0) return 1;
  return 1 + Math.min(0.6, 0.03 * (overdueMonths + 12 * yearIndex));
}

/** Repair-type visits per unit in the last 24 months, plus invoice samples per category. */
function readHistory(twin: PropertyTwin, now: number) {
  const jobsById = new Map(twin.jobs.map((j) => [j.id, j]));
  const linksPerJob = new Map<string, number>();
  for (const l of twin.jobEquipmentLinks) linksPerJob.set(l.job_id, (linksPerJob.get(l.job_id) ?? 0) + 1);
  const equipmentById = new Map(twin.equipment.map((e) => [e.id, e]));

  const visits = new Map<string, number>();
  const invoices = new Map<HealthCategoryKey, number[]>();

  for (const link of twin.jobEquipmentLinks) {
    const job = jobsById.get(link.job_id);
    if (!job || job.job_status === 'cancelled' || job.job_status === 'no_show') continue;
    const when = job.scheduled_datetime ? new Date(job.scheduled_datetime).getTime() : null;
    if (when !== null && when < now - REPAIR_WINDOW_MS) continue;
    const kind = link.service_type ?? job.service_type ?? '';
    if (kind && MAINTENANCE_VISIT.test(kind)) continue;

    visits.set(link.equipment_id, (visits.get(link.equipment_id) ?? 0) + 1);

    const item = equipmentById.get(link.equipment_id);
    const category = item ? classifyEquipment(item) : null;
    const amount = job.invoice_amount;
    const currencyOk = !job.invoice_currency || job.invoice_currency.toUpperCase() === 'USD';
    if (category && job.job_status === 'completed' && currencyOk && typeof amount === 'number' && amount > 0) {
      const list = invoices.get(category) ?? [];
      list.push(amount / (linksPerJob.get(link.job_id) ?? 1));
      invoices.set(category, list);
    }
  }
  return { visits, invoices };
}

/** Blend the default repair cost with real invoices; more samples → more weight (max 60%). */
function calibratedRepairCost(base: number, samples: number[] | undefined): number {
  if (!samples || samples.length === 0) return base;
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const weight = Math.min(0.6, samples.length / (samples.length + 2));
  return clamp(base * (1 - weight) + avg * weight, base * 0.5, base * 3);
}

function activeAlertFactor(alerts: EquipmentMaintenanceAlert[]): number {
  return alerts.reduce((max, a) => Math.max(max, ALERT_HAZARD[a.risk_level] ?? 1), 1);
}

function project(u: Unit, scenario: Scenario, now: number): Projection {
  const { serviced, neutral } = scenario;
  const failure: number[] = [];
  const maintenance: number[] = [];
  const probability: number[] = [];
  const onSchedule = u.overdueMonths !== null && u.overdueMonths <= 0;

  for (let t = 0; t < BUDGET_HORIZON_YEARS; t++) {
    const age = (neutral === 'age' ? 0 : u.age) + t;
    const delta = Math.pow((age + 1) / u.lifespan, WEIBULL_SHAPE) - Math.pow(age / u.lifespan, WEIBULL_SHAPE) + BASE_HAZARD;

    const service = serviced || neutral === 'maintenance' ? 1 : maintenanceFactor(u.overdueMonths, t);
    const alerts = serviced || neutral === 'maintenance' ? 1 : u.alertFactor;
    const m =
      (neutral === 'climate' ? 1 : u.climate) *
      (neutral === 'property' ? 1 : u.property) *
      (neutral === 'history' ? 1 : u.historyFactor) *
      service *
      alerts;

    const p = Math.min(MAX_ANNUAL_PROBABILITY, 1 - Math.exp(-delta * m));
    const replaceShare = clamp(((age + 0.5) / u.lifespan - 0.6) / 0.6, 0.05, 0.95);
    let eventCost = (1 - replaceShare) * u.costs.repair + replaceShare * u.costs.replacement;
    const covered = neutral !== 'warranty' && u.warrantyUntil !== null && u.warrantyUntil > now + (t + 0.5) * MS_PER_YEAR;
    if (covered) eventCost *= 1 - WARRANTY_COVERAGE;

    probability.push(p);
    failure.push(p * eventCost);
    maintenance.push(serviced || onSchedule ? u.annualMaintenance : 0);
  }
  return { failure, maintenance, probability };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function totals(units: Unit[], scenario: Scenario, now: number) {
  let annual = 0;
  let five = 0;
  for (const u of units) {
    const p = project(u, scenario, now);
    annual += p.failure[0] + p.maintenance[0];
    five += sum(p.failure) + sum(p.maintenance);
  }
  return { annual, five };
}

const CONFIDENCE_SPREAD: Record<BudgetConfidence, number> = { high: 0.2, medium: 0.3, low: 0.45 };

function driverDetail(key: BudgetDriverKey, units: Unit[], climate: ClimateClass, siteType: string | null): string {
  switch (key) {
    case 'age': {
      const aged = units.filter((u) => u.age / u.lifespan >= 0.8).length;
      return aged > 0 ? `${aged} unit${aged === 1 ? ' is' : 's are'} near or past expected life.` : 'Equipment is mostly early or mid-life.';
    }
    case 'climate':
      return climate === 'unknown' ? 'No state on record — no climate adjustment applied.' : `${CLIMATE_LABELS[climate]} stresses some systems.`;
    case 'property':
      return siteType && siteType !== 'other' ? `Usage intensity for a ${siteType.replace(/_/g, ' ')} property.` : 'Standard residential usage assumed.';
    case 'history': {
      const repeat = units.filter((u) => u.historyFactor > 1).length;
      return repeat > 0 ? `${repeat} unit${repeat === 1 ? ' has' : 's have'} repair visits in the last 24 months.` : 'No recent repair visits on record.';
    }
    case 'maintenance': {
      const behind = units.filter((u) => u.overdueMonths === null || u.overdueMonths > 0).length;
      return behind > 0 ? `${behind} unit${behind === 1 ? ' is' : 's are'} overdue or missing a service record.` : 'All units are on their service schedule.';
    }
    case 'warranty': {
      const covered = units.filter((u) => u.warrantyUntil !== null).length;
      return covered > 0 ? `${covered} unit${covered === 1 ? ' has' : 's have'} an active manufacturer warranty.` : 'No active manufacturer warranties on record.';
    }
  }
}

// ------------------------------------------------------------------------ model

export function computeHomeBudget(twin: PropertyTwin, options: BudgetOptions = {}): HomeBudget | null {
  const now = options.now ?? Date.now();
  const climate = climateForState(twin.site?.state);
  const siteType = twin.site?.site_type ?? null;
  const propertyFactor = PROPERTY_HAZARD[siteType ?? 'other'] ?? 1;

  const { visits, invoices } = readHistory(twin, now);
  const alertsByUnit = new Map<string, EquipmentMaintenanceAlert[]>();
  for (const a of twin.maintenanceAlerts) {
    if (a.is_dismissed) continue;
    const list = alertsByUnit.get(a.equipment_id) ?? [];
    list.push(a);
    alertsByUnit.set(a.equipment_id, list);
  }

  const units: Unit[] = [];
  let unclassified = 0;
  let unknownAge = 0;

  for (const item of twin.equipment as Equipment[]) {
    if (item.status !== 'active') continue;
    const category = classifyEquipment(item);
    if (!category) {
      unclassified += 1;
      continue;
    }
    const lifespan = item.expected_lifespan_years > 0 ? item.expected_lifespan_years : FALLBACK_LIFESPAN_YEARS[category];
    const known = ageYears(item.install_date, now);
    if (known === null) unknownAge += 1;

    const base = { ...DEFAULT_COSTS[category], ...options.costs?.[category] };
    const interval = item.service_interval_months > 0 ? clamp(item.service_interval_months, 3, 24) : 12;
    const warranty = item.warranty_expires_at ? new Date(item.warranty_expires_at).getTime() : NaN;

    units.push({
      equipmentId: item.id,
      label: [item.make, item.model].filter(Boolean).join(' ') || item.equipment_type,
      category,
      lifespan,
      age: known ?? lifespan * UNKNOWN_AGE_RATIO,
      ageKnown: known !== null,
      climate: CLIMATE_HAZARD[climate][category] ?? 1,
      property: propertyFactor,
      historyFactor: historyFactor(visits.get(item.id) ?? 0),
      overdueMonths: monthsOverdue(item, now),
      alertFactor: activeAlertFactor(alertsByUnit.get(item.id) ?? []),
      warrantyUntil: Number.isNaN(warranty) ? null : warranty,
      annualMaintenance: (base.maintenance * 12) / interval,
      costs: { ...base, repair: calibratedRepairCost(base.repair, invoices.get(category)) },
    });
  }

  if (units.length === 0) return null;

  // ---- baseline (today's behaviour) ----
  const baseline = units.map((u) => ({ u, p: project(u, { serviced: false }, now) }));
  const years: BudgetYear[] = Array.from({ length: BUDGET_HORIZON_YEARS }, (_, t) => {
    const maintenance = sum(baseline.map((b) => b.p.maintenance[t]));
    const expectedFailure = sum(baseline.map((b) => b.p.failure[t]));
    return { year: t + 1, maintenance: cents(maintenance), expectedFailure: cents(expectedFailure), total: cents(maintenance + expectedFailure) };
  });
  const annual = years[0].total;
  const fiveYear = cents(sum(years.map((y) => y.total)));

  // ---- confidence ----
  const covered = HEALTH_CATEGORIES.filter((k) => units.some((u) => u.category === k));
  const dateCoverage = units.filter((u) => u.ageKnown).length / units.length;
  const points =
    (covered.length >= 4 ? 1 : 0) + (dateCoverage >= 0.75 ? 1 : 0) + (climate !== 'unknown' ? 1 : 0) + (visits.size > 0 ? 1 : 0);
  const confidence: BudgetConfidence = points >= 3 && dateCoverage >= 0.75 ? 'high' : points >= 2 ? 'medium' : 'low';
  const spread = CONFIDENCE_SPREAD[confidence];
  const band = (value: number) => ({ low: cents(value * (1 - spread)), high: cents(value * (1 + spread * 1.5)) });

  // ---- categories ----
  const categories: BudgetCategory[] = covered.map((key) => {
    const rows = baseline.filter((b) => b.u.category === key);
    return {
      key,
      label: CATEGORY_LABELS[key],
      annual: cents(sum(rows.map((r) => r.p.failure[0] + r.p.maintenance[0]))),
      fiveYear: cents(sum(rows.map((r) => sum(r.p.failure) + sum(r.p.maintenance)))),
      equipmentCount: rows.length,
    };
  });

  // ---- drivers (each evaluated against a neutral version of that one factor) ----
  const actual = totals(units, { serviced: false }, now);
  const drivers: BudgetDriver[] = (Object.keys(DRIVER_LABELS) as BudgetDriverKey[])
    .map((key) => {
      const neutral = totals(units, { serviced: false, neutral: key }, now);
      return {
        key,
        label: DRIVER_LABELS[key],
        annualImpact: cents(actual.annual - neutral.annual),
        fiveYearImpact: cents(actual.five - neutral.five),
        detail: driverDetail(key, units, climate, siteType),
      };
    })
    .filter((d) => Math.abs(d.fiveYearImpact) >= 1)
    .sort((a, b) => Math.abs(b.fiveYearImpact) - Math.abs(a.fiveYearImpact));

  // ---- recommendations: "if this service is done this year…" ----
  const recommendations: BudgetRecommendation[] = [];
  const planned = new Set<HealthCategoryKey>();
  for (const key of covered) {
    const rows = baseline.filter((b) => b.u.category === key);
    const fixable = rows.filter(({ u }) => u.overdueMonths === null || u.overdueMonths > 0 || u.alertFactor > 1);
    if (fixable.length === 0) continue;

    const after = fixable.map(({ u }) => project(u, { serviced: true }, now));
    const before = fixable.map(({ p }) => p);
    const avoided = sum(before.map((p) => sum(p.failure))) - sum(after.map((p) => sum(p.failure)));
    const added = sum(after.map((p) => sum(p.maintenance))) - sum(before.map((p) => sum(p.maintenance)));
    const net = avoided - added;
    if (net < MIN_RECOMMENDED_NET_SAVING) continue;

    const atLeastOne = (ps: Projection[]) => 1 - ps.reduce((acc, p) => acc * (1 - p.probability[0]), 1);
    planned.add(key);
    recommendations.push({
      categoryKey: key,
      categoryLabel: CATEGORY_LABELS[key],
      equipmentIds: fixable.map(({ u }) => u.equipmentId),
      title: `${CATEGORY_LABELS[key]} maintenance this year`,
      year1Outlay: cents(sum(after.map((p) => p.maintenance[0])) - sum(before.map((p) => p.maintenance[0]))),
      failureCostAvoided5y: cents(avoided),
      netSaving5y: cents(net),
      riskBefore: Math.round(atLeastOne(before) * 100) / 100,
      riskAfter: Math.round(atLeastOne(after) * 100) / 100,
    });
  }
  recommendations.sort((a, b) => b.netSaving5y - a.netSaving5y);

  const withPlanTotals = totals(
    units.filter((u) => planned.has(u.category)),
    { serviced: true },
    now,
  );
  const untouched = totals(
    units.filter((u) => !planned.has(u.category)),
    { serviced: false },
    now,
  );

  const failure5y = sum(years.map((y) => y.expectedFailure));
  const assumptions: string[] = [];
  if (climate === 'unknown') assumptions.push('No US state on the property record, so no climate adjustment was applied.');
  if (unknownAge > 0) {
    assumptions.push(`${unknownAge} unit${unknownAge === 1 ? ' has' : 's have'} no install date and ${unknownAge === 1 ? 'is' : 'are'} assumed to be ${Math.round(UNKNOWN_AGE_RATIO * 100)}% through expected life.`);
  }
  const missing = HEALTH_CATEGORIES.filter((k) => !covered.includes(k));
  if (missing.length > 0) assumptions.push(`Not included (no equipment on record): ${missing.map((k) => CATEGORY_LABELS[k]).join(', ')}.`);
  if (unclassified > 0) assumptions.push(`${unclassified} item${unclassified === 1 ? '' : 's'} could not be matched to a system and ${unclassified === 1 ? 'is' : 'are'} excluded.`);
  assumptions.push('Costs use US planning defaults, calibrated with this property’s own invoices where available.');

  const annualBand = band(annual);
  const fiveBand = band(fiveYear);

  return {
    annual,
    annualLow: annualBand.low,
    annualHigh: annualBand.high,
    fiveYear,
    fiveYearLow: fiveBand.low,
    fiveYearHigh: fiveBand.high,
    years,
    categories,
    drivers,
    recommendations,
    withPlan: { annual: cents(withPlanTotals.annual + untouched.annual), fiveYear: cents(withPlanTotals.five + untouched.five) },
    suggestedMonthlyReserve: cents(failure5y / (BUDGET_HORIZON_YEARS * 12)),
    confidence,
    scoredEquipmentCount: units.length,
    unclassifiedCount: unclassified,
    uncoveredCategories: missing,
    climate,
    assumptions,
  };
}

// ---------------------------------------------------------------------- display

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/**
 * Budget figures are estimates, so they are shown at honest precision:
 * nearest $10 below $10k, nearest $100 above (e.g. $4,870 · $23,400).
 */
export function formatBudgetUsd(value: number): string {
  const step = Math.abs(value) >= 10000 ? 100 : 10;
  return USD.format(Math.round(value / step) * step);
}
