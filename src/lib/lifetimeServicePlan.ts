import type { Equipment, EquipmentMaintenanceAlert } from '@/lib/supabase';
import type { PropertyTwin } from '@/lib/propertyTwin';
import {
  CATEGORY_LABELS,
  HEALTH_CATEGORIES,
  classifyEquipment,
  monthsOverdue,
  type HealthCategoryKey,
} from '@/lib/homeHealthScore';
import { CLIMATE_LABELS, DEFAULT_COSTS, climateForState, type ClimateClass, type CostProfile } from '@/lib/homeBudget';

/**
 * Vireek Lifetime Service Plan — a per-property, 10-year service roadmap.
 *
 * Pure, deterministic and explainable: no network, no randomness. The same twin,
 * the same year built and the same `now` always produce the same plan.
 *
 * Model (per system, using the same Weibull wear-out family as homeBudget.ts):
 *   - Survival: S(a) = exp(−(a/L)^k), conditioned on the current age a.
 *   - Timing: the replacement window is the 20th–80th percentile of remaining life
 *     (10th–90th when the age is only assumed from the home's age). The roadmap
 *     schedules the median (50th percentile).
 *   - Modifiers scale the cumulative hazard: climate × property usage × repair history
 *     × overdue service × open predictive alerts.
 *   - After a replacement the new unit restarts at age 0 and only climate/property
 *     apply (its history is clean), so short-lived systems can recur inside 10 years.
 *
 * Two evidence levels, always labelled in the output:
 *   - 'equipment': the system has active equipment on record (real install date,
 *     lifespan, service and repair history).
 *   - 'home_age': nothing on record, so the system is estimated from the home's age
 *     (year built), assuming the original component was replaced on a typical cycle.
 *     These are wider, lower-confidence estimates and are never presented as measured.
 *
 * All costs are in today's dollars (no inflation). US planning defaults come from
 * homeBudget.DEFAULT_COSTS and can be overridden with `options.costs`.
 */

// ---------------------------------------------------------------------- config

export const PLAN_HORIZON_YEARS = 10;

type SystemKind = 'replacement' | 'inspection';

interface SystemModel {
  /** Typical service life in years (used when equipment has no lifespan, or for home-age estimates). */
  life: number;
  /** Weibull shape: higher = more sharply concentrated around end of life. */
  shape: number;
  /** What the headline for this system is about. */
  kind: SystemKind;
  /** Can this system be estimated from the home's age alone? */
  estimableFromHomeAge: boolean;
}

const SYSTEM_MODEL: Readonly<Record<HealthCategoryKey, SystemModel>> = {
  hvac: { life: 15, shape: 4, kind: 'replacement', estimableFromHomeAge: true },
  water_heater: { life: 11, shape: 4, kind: 'replacement', estimableFromHomeAge: true },
  roof: { life: 22, shape: 4, kind: 'replacement', estimableFromHomeAge: true },
  electrical: { life: 35, shape: 3.5, kind: 'inspection', estimableFromHomeAge: true },
  plumbing: { life: 30, shape: 3, kind: 'inspection', estimableFromHomeAge: true },
  safety: { life: 10, shape: 5, kind: 'replacement', estimableFromHomeAge: false },
};

/** Constant yearly hazard floor: random failures exist at any age. Matches homeBudget.ts. */
const BASE_HAZARD = 0.02;
const MAX_PROBABILITY = 0.95;
/** Manufacturer warranties are typically parts-only: share of event cost covered. */
const WARRANTY_COVERAGE = 0.5;
/** Unknown install date on a real unit: assume it is this far through its expected life. */
const UNKNOWN_AGE_RATIO = 0.6;
const RISK_HIGH_5Y = 0.5;
const RISK_MEDIUM_5Y = 0.2;
const MIN_MULTIPLIER = 0.5;
const MAX_MULTIPLIER = 4;
const ALERT_HAZARD = { high: 1.5, medium: 1.25, low: 1.08 } as const;
const MAINTENANCE_VISIT = /maint|tune|inspect|clean|flush|check|service\s*plan|seasonal|filter|annual|install/i;
const REPAIR_WINDOW_MS = 24 * 30.4375 * 24 * 60 * 60 * 1000;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const MS_PER_MONTH = 30.4375 * 24 * 60 * 60 * 1000;

/** Hazard multipliers by climate stress. Mirrors the climate model in homeBudget.ts. */
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

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const cents = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------- output

export type PlanBasis = 'equipment' | 'home_age';
export type PlanRisk = 'low' | 'medium' | 'high';
export type PlanConfidence = 'low' | 'medium' | 'high';

export const RISK_LABELS: Record<PlanRisk, string> = { low: 'Low', medium: 'Medium', high: 'High' };
export const BASIS_LABELS: Record<PlanBasis, string> = {
  equipment: 'From equipment records',
  home_age: 'Estimated from home age',
};

export interface ReplacementWindow {
  /** Whole years from now: earliest plausible replacement (0 = now). */
  fromYears: number;
  /** Whole years from now: latest plausible replacement; always > fromYears. */
  toYears: number;
  /** Months until the early end of the window (0 = already due). */
  fromMonths: number;
}

export interface SystemOutlook {
  categoryKey: HealthCategoryKey;
  label: string;
  basis: PlanBasis;
  /** Equipment units behind this outlook (0 for home-age estimates). */
  unitCount: number;
  /** Age of the soonest-to-fail unit, or the assumed component age. */
  ageYears: number;
  ageAssumed: boolean;
  lifespanYears: number;
  risk: PlanRisk;
  /** 0–1 chance of at least one failure/serious issue in the next five years. */
  risk5y: number;
  replacement: ReplacementWindow | null;
  replacementCost: number | null;
  /** Months until the next recommended inspection (0 = due now); inspection-type systems only. */
  inspectionInMonths: number | null;
  inspectionIntervalMonths: number | null;
  /** Median years of extra life from keeping the system on schedule, 0 if nothing to gain. */
  serviceGainYears: number;
  /** One-line headline, e.g. "Expected replacement: 1–3 years". */
  headline: string;
  rationale: string;
}

export interface RoadmapEvent {
  categoryKey: HealthCategoryKey;
  label: string;
  kind: 'replacement' | 'inspection';
  basis: PlanBasis;
  cost: number;
}

export interface RoadmapYear {
  /** 1-based year of the roadmap (1 = next 12 months). */
  year: number;
  calendarYear: number;
  events: RoadmapEvent[];
  replacements: number;
  inspections: number;
  /** Routine maintenance for units in service (not itemised as events). */
  maintenance: number;
  total: number;
}

export interface PlanAction {
  categoryKey: HealthCategoryKey;
  label: string;
  title: string;
  dueInMonths: number;
  detail: string;
}

export interface LifetimeServicePlan {
  yearBuilt: number | null;
  homeAgeYears: number | null;
  climate: ClimateClass;
  systems: SystemOutlook[];
  roadmap: RoadmapYear[];
  nextActions: PlanAction[];
  /** Replacements + inspections + routine maintenance across the roadmap. */
  tenYearTotal: number;
  tenYearReplacements: number;
  /** Inspections + routine maintenance across the roadmap. */
  tenYearMaintenance: number;
  /** Year-1 inspections + routine maintenance: what a service plan would actually deliver. */
  year1ServiceValue: number;
  /** Monthly set-aside that would fund every scheduled replacement over the roadmap. */
  suggestedMonthlyReserve: number;
  confidence: PlanConfidence;
  equipmentBackedCount: number;
  estimatedCount: number;
  assumptions: string[];
}

export interface PlanOptions {
  now?: number;
  /** Per-category overrides of the default cost profile (e.g. from the price book). */
  costs?: Partial<Record<HealthCategoryKey, Partial<CostProfile>>>;
}

// ------------------------------------------------------------------ year built

/** Valid = whole year between 1700 and next year (pre-construction records are common). */
export function isValidYearBuilt(value: number, now: number = Date.now()): boolean {
  return Number.isInteger(value) && value >= 1700 && value <= new Date(now).getFullYear() + 1;
}

export function homeAgeFromYearBuilt(yearBuilt: number | null | undefined, now: number = Date.now()): number | null {
  if (yearBuilt == null || !isValidYearBuilt(yearBuilt, now)) return null;
  return Math.max(0, new Date(now).getFullYear() - yearBuilt);
}

// ------------------------------------------------------------------ hazard math

/** Years until the conditional failure probability reaches `q`, given the current age. */
export function yearsToQuantile(age: number, life: number, shape: number, q: number, multiplier: number): number {
  const m = clamp(multiplier, MIN_MULTIPLIER, MAX_MULTIPLIER);
  const base = Math.pow(Math.max(0, age) / life, shape);
  const total = life * Math.pow(base + -Math.log(1 - q) / m, 1 / shape);
  return Math.max(0, total - age);
}

/** Probability of at least one failure within `years`, from the current age. */
export function failureProbability(age: number, life: number, shape: number, multiplier: number, years: number): number {
  const m = clamp(multiplier, MIN_MULTIPLIER, MAX_MULTIPLIER);
  const wear = Math.pow((Math.max(0, age) + years) / life, shape) - Math.pow(Math.max(0, age) / life, shape);
  return Math.min(MAX_PROBABILITY, 1 - Math.exp(-(wear * m + BASE_HAZARD * years)));
}

function riskLevel(risk5y: number): PlanRisk {
  if (risk5y >= RISK_HIGH_5Y) return 'high';
  if (risk5y >= RISK_MEDIUM_5Y) return 'medium';
  return 'low';
}

function historyFactor(repairVisits: number): number {
  if (repairVisits >= 3) return 1.6;
  if (repairVisits === 2) return 1.3;
  if (repairVisits === 1) return 1.1;
  return 1;
}

function maintenanceFactor(overdueMonths: number | null): number {
  if (overdueMonths === null) return 1.1;
  if (overdueMonths <= 0) return 1;
  return 1 + Math.min(0.6, 0.03 * overdueMonths);
}

function alertFactor(alerts: EquipmentMaintenanceAlert[]): number {
  return alerts.reduce((max, a) => Math.max(max, ALERT_HAZARD[a.risk_level] ?? 1), 1);
}

function ageYears(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / MS_PER_YEAR);
}

// ------------------------------------------------------------------ formatting

export function formatWindow(w: ReplacementWindow): string {
  if (w.fromYears >= PLAN_HORIZON_YEARS) return `${PLAN_HORIZON_YEARS}+ years`;
  if (w.fromYears === 0 && w.toYears <= 1) return 'Within 12 months';
  if (w.fromYears === 0) return `Now–${w.toYears} years`;
  return `${w.fromYears}–${w.toYears} years`;
}

export function formatMonths(months: number): string {
  if (months <= 0) return 'now';
  if (months < 24) return `${months} month${months === 1 ? '' : 's'}`;
  return `${Math.round(months / 12)} years`;
}

// ------------------------------------------------------------- internal model

interface Unit {
  key: HealthCategoryKey;
  label: string;
  basis: PlanBasis;
  age: number;
  ageAssumed: boolean;
  life: number;
  shape: number;
  /** Multiplier for the unit as it is today. */
  mNow: number;
  /** Multiplier if service is kept on schedule and alerts are resolved. */
  mServiced: number;
  /** Multiplier for a future replacement unit (environment only). */
  mEnv: number;
  warrantyUntil: number | null;
  annualMaintenance: number;
  costs: CostProfile;
  /** Widen the timing window when the age is a guess. */
  wide: boolean;
}

function readRepairVisits(twin: PropertyTwin, now: number): Map<string, number> {
  const jobsById = new Map(twin.jobs.map((j) => [j.id, j]));
  const visits = new Map<string, number>();
  for (const link of twin.jobEquipmentLinks) {
    const job = jobsById.get(link.job_id);
    if (!job || job.job_status === 'cancelled' || job.job_status === 'no_show') continue;
    const when = job.scheduled_datetime ? new Date(job.scheduled_datetime).getTime() : null;
    if (when !== null && when < now - REPAIR_WINDOW_MS) continue;
    const kind = link.service_type ?? job.service_type ?? '';
    if (kind && MAINTENANCE_VISIT.test(kind)) continue;
    visits.set(link.equipment_id, (visits.get(link.equipment_id) ?? 0) + 1);
  }
  return visits;
}

function inspectionIntervalMonths(key: HealthCategoryKey, age: number): number {
  if (key === 'electrical') {
    if (age < 10) return 60;
    if (age < 25) return 36;
    if (age < 40) return 24;
    return 12;
  }
  // plumbing
  if (age < 15) return 36;
  if (age < 30) return 24;
  return 12;
}

function monthsSince(iso: string, now: number): number {
  return Math.max(0, (now - new Date(iso).getTime()) / MS_PER_MONTH);
}

interface TimedEvent {
  yearOffset: number;
  unit: Unit;
  cost: number;
}

/** Replacement timeline for one unit: median first event, then median cycles for the new unit. */
function replacementTimeline(u: Unit, now: number): TimedEvent[] {
  const events: TimedEvent[] = [];
  let t = yearsToQuantile(u.age, u.life, u.shape, 0.5, u.mNow);
  const cycle = yearsToQuantile(0, u.life, u.shape, 0.5, u.mEnv);
  const safeCycle = Math.max(1, cycle);
  for (let guard = 0; guard < 12; guard++) {
    const yearOffset = Math.max(1, Math.ceil(t));
    if (yearOffset > PLAN_HORIZON_YEARS) break;
    const covered = u.warrantyUntil !== null && u.warrantyUntil > now + (yearOffset - 0.5) * MS_PER_YEAR;
    events.push({ yearOffset, unit: u, cost: u.costs.replacement * (covered ? 1 - WARRANTY_COVERAGE : 1) });
    t += safeCycle;
  }
  return events;
}

function buildWindow(u: Unit): ReplacementWindow {
  const [qLow, qHigh] = u.wide ? [0.1, 0.9] : [0.2, 0.8];
  const early = yearsToQuantile(u.age, u.life, u.shape, qLow, u.mNow);
  const late = yearsToQuantile(u.age, u.life, u.shape, qHigh, u.mNow);
  const fromYears = Math.floor(early);
  return {
    fromYears,
    toYears: Math.max(fromYears + 1, Math.ceil(late)),
    fromMonths: Math.round(early * 12),
  };
}

function unitRisk5y(u: Unit): number {
  return failureProbability(u.age, u.life, u.shape, u.mNow, 5);
}

// ------------------------------------------------------------------- the model

export function computeLifetimeServicePlan(
  twin: PropertyTwin,
  yearBuilt: number | null,
  options: PlanOptions = {},
): LifetimeServicePlan | null {
  const now = options.now ?? Date.now();
  const validYear = yearBuilt != null && isValidYearBuilt(yearBuilt, now) ? yearBuilt : null;
  const homeAge = homeAgeFromYearBuilt(validYear, now);
  const climate = climateForState(twin.site?.state);
  const siteType = twin.site?.site_type ?? null;
  const propertyFactor = PROPERTY_HAZARD[siteType ?? 'other'] ?? 1;
  const envFactor = (key: HealthCategoryKey) => (CLIMATE_HAZARD[climate][key] ?? 1) * propertyFactor;
  const costFor = (key: HealthCategoryKey): CostProfile => ({ ...DEFAULT_COSTS[key], ...options.costs?.[key] });

  const visits = readRepairVisits(twin, now);
  const alertsByUnit = new Map<string, EquipmentMaintenanceAlert[]>();
  for (const a of twin.maintenanceAlerts) {
    if (a.is_dismissed) continue;
    const list = alertsByUnit.get(a.equipment_id) ?? [];
    list.push(a);
    alertsByUnit.set(a.equipment_id, list);
  }

  // ---- units from real equipment ----
  const unitsByKey = new Map<HealthCategoryKey, Unit[]>();
  const lastServiceByKey = new Map<HealthCategoryKey, string>();
  let unknownAge = 0;
  let unclassified = 0;

  for (const item of twin.equipment as Equipment[]) {
    if (item.status !== 'active') continue;
    const key = classifyEquipment(item);
    if (!key) {
      unclassified += 1;
      continue;
    }
    const model = SYSTEM_MODEL[key];
    const life = item.expected_lifespan_years > 0 ? item.expected_lifespan_years : model.life;
    const known = ageYears(item.install_date, now);
    if (known === null) unknownAge += 1;
    const base = costFor(key);
    const interval = item.service_interval_months > 0 ? clamp(item.service_interval_months, 3, 24) : 12;
    const warranty = item.warranty_expires_at ? new Date(item.warranty_expires_at).getTime() : NaN;
    const env = envFactor(key);
    const serviceNow = maintenanceFactor(monthsOverdue(item, now));
    const alerts = alertFactor(alertsByUnit.get(item.id) ?? []);
    const history = historyFactor(visits.get(item.id) ?? 0);

    const unit: Unit = {
      key,
      label: [item.make, item.model].filter(Boolean).join(' ') || item.equipment_type,
      basis: 'equipment',
      age: known ?? life * UNKNOWN_AGE_RATIO,
      ageAssumed: known === null,
      life,
      shape: model.shape,
      mNow: env * history * serviceNow * alerts,
      mServiced: env * history,
      mEnv: env,
      warrantyUntil: Number.isNaN(warranty) ? null : warranty,
      // Inspection-type systems are costed as inspection events, never as routine maintenance too.
      annualMaintenance: model.kind === 'replacement' ? (base.maintenance * 12) / interval : 0,
      costs: base,
      wide: known === null,
    };
    const list = unitsByKey.get(key) ?? [];
    list.push(unit);
    unitsByKey.set(key, list);

    if (item.last_service_date) {
      const prev = lastServiceByKey.get(key);
      if (!prev || item.last_service_date > prev) lastServiceByKey.set(key, item.last_service_date);
    }
  }

  // ---- home-age estimates for systems with nothing on record ----
  if (homeAge !== null) {
    for (const key of HEALTH_CATEGORIES) {
      const model = SYSTEM_MODEL[key];
      if (!model.estimableFromHomeAge || unitsByKey.has(key)) continue;
      const componentAge = homeAge <= model.life ? homeAge : homeAge % model.life;
      const base = costFor(key);
      const env = envFactor(key);
      unitsByKey.set(key, [
        {
          key,
          label: CATEGORY_LABELS[key],
          basis: 'home_age',
          age: componentAge,
          ageAssumed: true,
          life: model.life,
          shape: model.shape,
          mNow: env,
          mServiced: env,
          mEnv: env,
          warrantyUntil: null,
          annualMaintenance: model.kind === 'replacement' ? base.maintenance : 0,
          costs: base,
          wide: true,
        },
      ]);
    }
  }

  if (unitsByKey.size === 0) return null;

  // ---- per-system outlook + roadmap events ----
  const systems: SystemOutlook[] = [];
  const events: Array<{ yearOffset: number; event: RoadmapEvent }> = [];
  const maintenancePerYear = new Array<number>(PLAN_HORIZON_YEARS).fill(0);

  for (const key of HEALTH_CATEGORIES) {
    const units = unitsByKey.get(key);
    if (!units || units.length === 0) continue;
    const model = SYSTEM_MODEL[key];
    const basis: PlanBasis = units[0].basis;

    // Soonest unit drives the headline.
    const timed = units.map((u) => ({ u, median: yearsToQuantile(u.age, u.life, u.shape, 0.5, u.mNow) }));
    timed.sort((a, b) => a.median - b.median);
    const lead = timed[0].u;
    const window = buildWindow(lead);
    const risk5y = cents(1 - units.reduce((acc, u) => acc * (1 - unitRisk5y(u)), 1));
    const risk = riskLevel(risk5y);

    const gain = Math.max(
      0,
      ...units.map((u) => yearsToQuantile(u.age, u.life, u.shape, 0.5, u.mServiced) - yearsToQuantile(u.age, u.life, u.shape, 0.5, u.mNow)),
    );

    // Roadmap: replacements per unit. Home-age estimates of inspection-type systems
    // (electrical, plumbing) are never scheduled for replacement — only inspected.
    const schedulesReplacement = model.kind === 'replacement' || basis === 'equipment';
    for (const u of units) {
      for (const e of schedulesReplacement ? replacementTimeline(u, now) : []) {
        events.push({ yearOffset: e.yearOffset, event: { categoryKey: key, label: u.label, kind: 'replacement', basis: u.basis, cost: cents(e.cost) } });
      }
      for (let y = 0; y < PLAN_HORIZON_YEARS; y++) maintenancePerYear[y] += u.annualMaintenance;
    }

    // Roadmap + headline: inspections for inspection-type systems.
    let inspectionInMonths: number | null = null;
    let inspectionInterval: number | null = null;
    if (model.kind === 'inspection') {
      const refAge = homeAge ?? lead.age;
      inspectionInterval = inspectionIntervalMonths(key, refAge);
      const last = lastServiceByKey.get(key);
      inspectionInMonths = last
        ? Math.max(0, Math.round(inspectionInterval - monthsSince(last, now)))
        : refAge < 10
          ? 12
          : 6;
      const cost = costFor(key).maintenance;
      for (let m = inspectionInMonths; m <= PLAN_HORIZON_YEARS * 12; m += inspectionInterval) {
        events.push({
          yearOffset: Math.max(1, Math.ceil(m / 12)),
          event: { categoryKey: key, label: `${CATEGORY_LABELS[key]} inspection`, kind: 'inspection', basis, cost },
        });
      }
    }

    const showsReplacement = schedulesReplacement;
    const headline =
      model.kind === 'inspection'
        ? key === 'plumbing'
          ? `Risk: ${RISK_LABELS[risk]} · inspection in ${formatMonths(inspectionInMonths ?? 0)}`
          : `Inspection recommended ${inspectionInMonths === 0 ? 'now' : `in ${formatMonths(inspectionInMonths ?? 0)}`}`
        : `Expected replacement: ${formatWindow(window)}`;

    const ageText = `${lead.age.toFixed(lead.age < 10 ? 1 : 0)}-year-old`;
    const rationale =
      basis === 'equipment'
        ? `${ageText} ${lead.label}${lead.ageAssumed ? ' (install date missing — age assumed)' : ''} against a ${lead.life}-year expected life${units.length > 1 ? `; ${units.length} units on record, soonest shown` : ''}.`
        : `No ${CATEGORY_LABELS[key].toLowerCase()} equipment on record. Estimated from a ${homeAge}-year-old home${homeAge !== null && homeAge > model.life ? ', assuming the original was replaced on a typical cycle' : ''}.`;

    systems.push({
      categoryKey: key,
      label: CATEGORY_LABELS[key],
      basis,
      unitCount: basis === 'equipment' ? units.length : 0,
      ageYears: Math.round(lead.age * 10) / 10,
      ageAssumed: lead.ageAssumed,
      lifespanYears: lead.life,
      risk,
      risk5y,
      replacement: showsReplacement ? window : null,
      replacementCost: showsReplacement ? cents(lead.costs.replacement) : null,
      inspectionInMonths,
      inspectionIntervalMonths: inspectionInterval,
      serviceGainYears: Math.round(gain * 10) / 10,
      headline,
      rationale,
    });
  }

  // ---- roadmap ----
  const roadmap: RoadmapYear[] = Array.from({ length: PLAN_HORIZON_YEARS }, (_, i) => {
    const yearEvents = events.filter((e) => e.yearOffset === i + 1).map((e) => e.event);
    yearEvents.sort((a, b) => b.cost - a.cost);
    const replacements = cents(sum(yearEvents.filter((e) => e.kind === 'replacement').map((e) => e.cost)));
    const inspections = cents(sum(yearEvents.filter((e) => e.kind === 'inspection').map((e) => e.cost)));
    const maintenance = cents(maintenancePerYear[i]);
    return {
      year: i + 1,
      // Calendar year the middle of this 12-month period falls in.
      calendarYear: new Date(now + (i + 0.5) * MS_PER_YEAR).getFullYear(),
      events: yearEvents,
      replacements,
      inspections,
      maintenance,
      total: cents(replacements + inspections + maintenance),
    };
  });

  const tenYearReplacements = cents(sum(roadmap.map((y) => y.replacements)));
  const tenYearMaintenance = cents(sum(roadmap.map((y) => y.inspections + y.maintenance)));

  // ---- next actions (next 12 months) ----
  const nextActions: PlanAction[] = [];
  for (const s of systems) {
    if (s.replacement && s.replacement.fromMonths <= 12) {
      nextActions.push({
        categoryKey: s.categoryKey,
        label: s.label,
        title: `Plan ${s.label.toLowerCase()} replacement`,
        dueInMonths: s.replacement.fromMonths,
        detail: `${s.headline}. Budget about ${s.replacementCost !== null ? `$${Math.round(s.replacementCost).toLocaleString('en-US')}` : 'the replacement cost'} and get quotes early.`,
      });
    }
    if (s.inspectionInMonths !== null && s.inspectionInMonths <= 12) {
      nextActions.push({
        categoryKey: s.categoryKey,
        label: s.label,
        title: `Book ${s.label.toLowerCase()} inspection`,
        dueInMonths: s.inspectionInMonths,
        detail: s.basis === 'equipment' && lastServiceByKey.has(s.categoryKey)
          ? `Recommended every ${formatMonths(s.inspectionIntervalMonths ?? 0)} for a property of this age.`
          : 'No service record on file, so a baseline inspection is recommended.',
      });
    }
  }
  nextActions.sort((a, b) => a.dueInMonths - b.dueInMonths);

  // ---- confidence ----
  const backed = systems.filter((s) => s.basis === 'equipment');
  const equipmentUnits = [...unitsByKey.values()].flat().filter((u) => u.basis === 'equipment');
  const dateCoverage = equipmentUnits.length ? equipmentUnits.filter((u) => !u.ageAssumed).length / equipmentUnits.length : 0;
  const points =
    (validYear !== null ? 1 : 0) + (backed.length >= 3 ? 1 : 0) + (dateCoverage >= 0.75 ? 1 : 0) + (climate !== 'unknown' ? 1 : 0);
  const confidence: PlanConfidence = points >= 4 ? 'high' : points >= 2 ? 'medium' : 'low';

  // ---- assumptions ----
  const assumptions: string[] = [];
  if (validYear === null) assumptions.push('No year built on the property record, so systems without equipment are not estimated.');
  const estimated = systems.filter((s) => s.basis === 'home_age');
  if (estimated.length > 0) {
    assumptions.push(`${estimated.map((s) => s.label).join(', ')} ${estimated.length === 1 ? 'is' : 'are'} estimated from the home's age and use wider timing windows.`);
    assumptions.push('Home-age estimates assume one unit per system.');
  }
  if (climate === 'unknown') assumptions.push('No US state on the property record, so no climate adjustment was applied.');
  else assumptions.push(`${CLIMATE_LABELS[climate]} adjustment applied to weather-exposed systems.`);
  if (unknownAge > 0) assumptions.push(`${unknownAge} unit${unknownAge === 1 ? ' has' : 's have'} no install date and ${unknownAge === 1 ? 'is' : 'are'} assumed to be ${Math.round(UNKNOWN_AGE_RATIO * 100)}% through expected life.`);
  if (unclassified > 0) assumptions.push(`${unclassified} item${unclassified === 1 ? '' : 's'} could not be matched to a system and ${unclassified === 1 ? 'is' : 'are'} excluded.`);
  if (!HEALTH_CATEGORIES.every((k) => systems.some((s) => s.categoryKey === k))) {
    const missing = HEALTH_CATEGORIES.filter((k) => !systems.some((s) => s.categoryKey === k));
    assumptions.push(`Not included (nothing on record, and not estimable from home age): ${missing.map((k) => CATEGORY_LABELS[k]).join(', ')}.`);
  }
  assumptions.push('Roadmap schedules the median expected timing of each replacement; real timing varies. Costs are US planning defaults in today’s dollars, calibrated only by overrides you supply.');

  return {
    yearBuilt: validYear,
    homeAgeYears: homeAge,
    climate,
    systems,
    roadmap,
    nextActions,
    tenYearTotal: cents(sum(roadmap.map((y) => y.total))),
    tenYearReplacements,
    tenYearMaintenance,
    year1ServiceValue: cents(roadmap[0].inspections + roadmap[0].maintenance),
    suggestedMonthlyReserve: cents(tenYearReplacements / (PLAN_HORIZON_YEARS * 12)),
    confidence,
    equipmentBackedCount: backed.length,
    estimatedCount: estimated.length,
    assumptions,
  };
}

// Shared with src/lib/homeIntelligenceGraph.ts so both models use one set of constants.
export { SYSTEM_MODEL, CLIMATE_HAZARD, PROPERTY_HAZARD, UNKNOWN_AGE_RATIO, WARRANTY_COVERAGE, historyFactor, maintenanceFactor, alertFactor, readRepairVisits };
