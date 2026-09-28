import type { Equipment, EquipmentMaintenanceAlert } from '@/lib/supabase';
import type { PropertyTwin } from '@/lib/propertyTwin';

/**
 * Vireek Home Health Score — deterministic, explainable, 0–100.
 *
 * Pure functions over an already-fetched PropertyTwin: no network, no new
 * schema, no randomness. The same twin always produces the same score, and
 * every number can be traced back to a concrete fact (age vs. lifespan,
 * overdue service, repair-visit history, predictive alerts).
 *
 * Runtime imports: none (types only), so it is safe to unit test and to reuse
 * in a customer-facing surface later.
 */

// ---------------------------------------------------------------- categories

export type HealthCategoryKey = 'hvac' | 'plumbing' | 'electrical' | 'water_heater' | 'roof' | 'safety';

export const HEALTH_CATEGORIES: readonly HealthCategoryKey[] = [
  'hvac',
  'water_heater',
  'plumbing',
  'electrical',
  'roof',
  'safety',
];

export const CATEGORY_LABELS: Record<HealthCategoryKey, string> = {
  hvac: 'HVAC',
  water_heater: 'Water Heater',
  plumbing: 'Plumbing',
  electrical: 'Electrical',
  roof: 'Roof',
  safety: 'Safety',
};

/** Share of the overall score. Renormalised over categories that actually have data. */
const CATEGORY_WEIGHT: Record<HealthCategoryKey, number> = {
  hvac: 0.22,
  electrical: 0.18,
  water_heater: 0.16,
  plumbing: 0.16,
  roof: 0.14,
  safety: 0.14,
};

/** 1–5: how costly/dangerous a failure is. Used only to rank risks, never shown as money. */
const CATEGORY_IMPACT: Record<HealthCategoryKey, number> = {
  roof: 5,
  electrical: 5,
  safety: 5,
  hvac: 4,
  water_heater: 4,
  plumbing: 4,
};

const CATEGORY_DEFAULT_ACTION: Record<HealthCategoryKey, string> = {
  hvac: 'Schedule a full HVAC inspection and tune-up.',
  water_heater: 'Flush and inspect the water heater; plan a replacement quote.',
  plumbing: 'Inspect supply lines, valves and shut-offs for leaks and corrosion.',
  electrical: 'Have a licensed electrician inspect the panel and protective devices.',
  roof: 'Book a roof inspection before the next storm season.',
  safety: 'Test and replace safety devices that are expired or failing.',
};

// Order matters: first match wins. Water heater before plumbing/HVAC ("hot water
// boiler"), safety before electrical ("GFCI"), and equipment_type is free text so
// patterns are deliberately broad.
const CLASSIFIERS: ReadonlyArray<readonly [HealthCategoryKey, RegExp]> = [
  ['water_heater', /water\s*heater|tankless|hot\s*water\s*(tank|heater|system)|\bwh\b/i],
  ['safety', /smoke|carbon\s*monoxide|\bco\s*(detector|alarm)|detector|fire\s*(alarm|extinguisher|sprinkler|panel)|sprinkler|gfci|afci|arc[\s-]?fault|radon|alarm/i],
  ['roof', /roof|shingle|gutter|chimney|flashing|skylight|soffit|fascia/i],
  ['electrical', /electric|panel|breaker|generator|ev\s*charger|charger|surge|wiring|transformer|inverter|solar|meter\s*base/i],
  ['hvac', /hvac|furnace|a\/c|\bac\b|air\s*condition|heat\s*pump|boiler|condenser|air\s*handler|evaporator|thermostat|mini[\s-]?split|ductless|ventilat|humidifier|dehumidifier|heating|cooling/i],
  ['plumbing', /plumb|pipe|sump|pump|softener|septic|faucet|toilet|drain|sewer|well|backflow|prv|pressure\s*(tank|regulator)|water\s*(filter|treatment|line|main)|fixture|valve/i],
];

export function classifyEquipment(item: Pick<Equipment, 'equipment_type' | 'make' | 'model'>): HealthCategoryKey | null {
  const haystack = `${item.equipment_type ?? ''} ${item.make ?? ''} ${item.model ?? ''}`;
  for (const [key, pattern] of CLASSIFIERS) {
    if (pattern.test(haystack)) return key;
  }
  return null;
}

// ------------------------------------------------------------------- helpers

const MS_PER_MONTH = 30.4375 * 24 * 60 * 60 * 1000;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Repair-type visits only: routine maintenance must not read as "recurring failure". */
const MAINTENANCE_VISIT = /maint|tune|inspect|clean|flush|check|service\s*plan|seasonal|filter|annual|install/i;
const REPAIR_WINDOW_MONTHS = 24;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const round = (n: number) => Math.round(n);

function addMonths(iso: string, months: number): Date {
  const d = new Date(iso);
  d.setMonth(d.getMonth() + months);
  return d;
}

function ageYears(install: string | null, now: number): number | null {
  if (!install) return null;
  const t = new Date(install).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, (now - t) / MS_PER_YEAR);
}

/** Months past due (0 if not due). null when there is no baseline date to judge by. */
export function monthsOverdue(
  item: Pick<Equipment, 'last_service_date' | 'service_interval_months' | 'install_date'>,
  now: number = Date.now(),
): number | null {
  const base = item.last_service_date ?? item.install_date;
  if (!base || !(item.service_interval_months > 0)) return null;
  const due = addMonths(base, item.service_interval_months).getTime();
  return due < now ? (now - due) / MS_PER_MONTH : 0;
}

// -------------------------------------------------------------- per-equipment

export interface EquipmentHealth {
  equipmentId: string;
  label: string;
  category: HealthCategoryKey;
  score: number;
  /** Score if all service-fixable issues (overdue service, open alerts) were resolved. */
  scoreIfServiced: number;
  ageYears: number | null;
  lifespanRatio: number | null;
  repairVisits: number;
  monthsOverdue: number;
  alert: EquipmentMaintenanceAlert | null;
  hasInstallDate: boolean;
}

interface ScoreContext {
  now: number;
  repairVisits: number;
  alerts: EquipmentMaintenanceAlert[];
}

const ALERT_PENALTY = { high: 25, medium: 12, low: 5 } as const;

function scoreEquipment(item: Equipment, ctx: ScoreContext, resolveServiceIssues: boolean): number {
  let penalty = 0;

  // Age vs. expected lifespan: free until 50% of life, then linear up to -45 at 125%.
  const age = ageYears(item.install_date, ctx.now);
  if (age === null) {
    penalty += 10; // unknown age is itself a risk signal
  } else if (item.expected_lifespan_years > 0) {
    const ratio = age / item.expected_lifespan_years;
    penalty += clamp((ratio - 0.5) / 0.75, 0, 1) * 45;
  }

  // Repeat repair visits (recent window only).
  if (ctx.repairVisits >= 3) penalty += clamp(15 + (ctx.repairVisits - 3) * 5, 15, 25);
  else if (ctx.repairVisits === 2) penalty += 5;

  if (!resolveServiceIssues) {
    const overdue = monthsOverdue(item, ctx.now) ?? 0;
    if (overdue > 0) penalty += clamp(8 + overdue * 1.5, 8, 22);

    const alertPenalty = ctx.alerts.reduce((sum, a) => sum + ALERT_PENALTY[a.risk_level], 0);
    penalty += Math.min(alertPenalty, 35);
  }

  return round(clamp(100 - penalty, 0, 100));
}

// --------------------------------------------------------------------- output

export type HealthTier = 'excellent' | 'good' | 'fair' | 'at_risk' | 'critical';

export const TIER_LABELS: Record<HealthTier, string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  at_risk: 'At risk',
  critical: 'Critical',
};

export function tierForScore(score: number): HealthTier {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 60) return 'fair';
  if (score >= 40) return 'at_risk';
  return 'critical';
}

export interface CategoryHealth {
  key: HealthCategoryKey;
  label: string;
  /** null = no equipment recorded for this system, so we do not guess. */
  score: number | null;
  tier: HealthTier | null;
  equipmentCount: number;
}

export type RiskLevel = 'high' | 'medium' | 'low';

export interface HomeRisk {
  equipmentId: string;
  label: string;
  category: HealthCategoryKey;
  categoryLabel: string;
  /** 0–1 estimated chance of a failure/serious issue within 12 months. */
  probability12m: number;
  level: RiskLevel;
  reason: string;
  action: string;
  /** ISO date when the model expects it to matter, if known. */
  dueBy: string | null;
}

export type ScoreConfidence = 'low' | 'medium' | 'high';

export interface HomeHealth {
  score: number | null;
  tier: HealthTier | null;
  /** Overall score if the top service-fixable issues were resolved. */
  projectedScore: number | null;
  categories: CategoryHealth[];
  topRisks: HomeRisk[];
  confidence: ScoreConfidence;
  scoredEquipmentCount: number;
  unclassifiedCount: number;
  coveredCategories: number;
  /** True when a critical system capped the headline number. */
  capped: boolean;
}

// ------------------------------------------------------------------- the model

function equipmentLabel(e: Equipment): string {
  return [e.make, e.model].filter(Boolean).join(' ') || e.equipment_type;
}

function repairVisitsByEquipment(twin: PropertyTwin, now: number): Map<string, number> {
  const cutoff = addMonths(new Date(now).toISOString(), -REPAIR_WINDOW_MONTHS).getTime();
  const jobsById = new Map(twin.jobs.map((j) => [j.id, j]));
  const counts = new Map<string, number>();
  for (const link of twin.jobEquipmentLinks) {
    const job = jobsById.get(link.job_id);
    if (!job || job.job_status === 'cancelled' || job.job_status === 'no_show') continue;
    if (job.scheduled_datetime && new Date(job.scheduled_datetime).getTime() < cutoff) continue;
    const kind = link.service_type ?? job.service_type ?? '';
    if (kind && MAINTENANCE_VISIT.test(kind)) continue;
    counts.set(link.equipment_id, (counts.get(link.equipment_id) ?? 0) + 1);
  }
  return counts;
}

function failureProbability12m(h: EquipmentHealth, item: Equipment, alerts: EquipmentMaintenanceAlert[]): number {
  // Age: shape rises from ~3% (early life) to 85% once well past expected lifespan.
  let pAge = 0.03;
  if (h.ageYears !== null && item.expected_lifespan_years > 0) {
    const ratioAhead = (h.ageYears + 1) / item.expected_lifespan_years;
    pAge = 0.03 + clamp((ratioAhead - 0.6) / 0.7, 0, 1) * 0.82;
  }
  const pAlert = alerts.reduce((m, a) => Math.max(m, a.risk_level === 'high' ? 0.35 : a.risk_level === 'medium' ? 0.18 : 0.06), 0);
  const pRepeat = h.repairVisits >= 3 ? 0.25 : h.repairVisits === 2 ? 0.1 : 0;
  const pOverdue = h.monthsOverdue > 0 ? clamp(0.08 + h.monthsOverdue * 0.01, 0.08, 0.2) : 0;
  const survive = (1 - pAge) * (1 - pAlert) * (1 - pRepeat) * (1 - pOverdue);
  return clamp(1 - survive, 0, 0.95);
}

function riskReason(h: EquipmentHealth, item: Equipment): string {
  if (h.alert) return h.alert.predicted_issue;
  if (h.lifespanRatio !== null && h.lifespanRatio >= 0.9 && h.ageYears !== null) {
    const yrs = Math.floor(h.ageYears);
    return h.lifespanRatio >= 1
      ? `${yrs} years old — past its expected ${item.expected_lifespan_years}-year lifespan.`
      : `${yrs} years old — nearing its expected ${item.expected_lifespan_years}-year lifespan.`;
  }
  if (h.repairVisits >= 2) return `${h.repairVisits} repair visits in the last ${REPAIR_WINDOW_MONTHS} months.`;
  if (h.monthsOverdue > 0) return `Service overdue by about ${Math.max(1, Math.round(h.monthsOverdue))} months.`;
  if (!h.hasInstallDate) return 'Install date unknown — age and remaining life cannot be verified.';
  return 'Combined age and service history raise the odds of a failure.';
}

function riskDueBy(h: EquipmentHealth, item: Equipment, now: number): string | null {
  if (h.alert?.predicted_service_due) return h.alert.predicted_service_due;
  if (item.install_date && item.expected_lifespan_years > 0) {
    const eol = new Date(item.install_date);
    eol.setFullYear(eol.getFullYear() + item.expected_lifespan_years);
    if (eol.getTime() < now + MS_PER_YEAR) return eol.getTime() < now ? null : eol.toISOString();
  }
  return null;
}

function weightedOverall(perCategory: Map<HealthCategoryKey, number>): number | null {
  let weighted = 0;
  let total = 0;
  for (const [key, score] of perCategory) {
    weighted += score * CATEGORY_WEIGHT[key];
    total += CATEGORY_WEIGHT[key];
  }
  return total > 0 ? weighted / total : null;
}

/** A failing unit must not hide behind healthy ones: 60% worst, 40% average. */
function categoryScore(scores: number[]): number {
  const min = Math.min(...scores);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return round(min * 0.6 + mean * 0.4);
}

export function computeHomeHealth(twin: PropertyTwin, now: number = Date.now()): HomeHealth {
  const repairs = repairVisitsByEquipment(twin, now);
  const alertsByEquipment = new Map<string, EquipmentMaintenanceAlert[]>();
  for (const a of twin.maintenanceAlerts) {
    if (a.is_dismissed) continue;
    const list = alertsByEquipment.get(a.equipment_id) ?? [];
    list.push(a);
    alertsByEquipment.set(a.equipment_id, list);
  }

  const health: Array<{ item: Equipment; h: EquipmentHealth; alerts: EquipmentMaintenanceAlert[] }> = [];
  let unclassified = 0;

  for (const item of twin.equipment) {
    if (item.status !== 'active') continue; // replaced/removed units are history, not health
    const category = classifyEquipment(item);
    if (!category) {
      unclassified += 1;
      continue;
    }
    const alerts = alertsByEquipment.get(item.id) ?? [];
    const ctx: ScoreContext = { now, repairVisits: repairs.get(item.id) ?? 0, alerts };
    const age = ageYears(item.install_date, now);
    const top = alerts.slice().sort((a, b) => ALERT_PENALTY[b.risk_level] - ALERT_PENALTY[a.risk_level])[0] ?? null;
    health.push({
      item,
      alerts,
      h: {
        equipmentId: item.id,
        label: equipmentLabel(item),
        category,
        score: scoreEquipment(item, ctx, false),
        scoreIfServiced: scoreEquipment(item, ctx, true),
        ageYears: age,
        lifespanRatio: age !== null && item.expected_lifespan_years > 0 ? age / item.expected_lifespan_years : null,
        repairVisits: ctx.repairVisits,
        monthsOverdue: monthsOverdue(item, now) ?? 0,
        alert: top,
        hasInstallDate: age !== null,
      },
    });
  }

  const byCategory = new Map<HealthCategoryKey, typeof health>();
  for (const entry of health) {
    const list = byCategory.get(entry.h.category) ?? [];
    list.push(entry);
    byCategory.set(entry.h.category, list);
  }

  const categories: CategoryHealth[] = HEALTH_CATEGORIES.map((key) => {
    const list = byCategory.get(key) ?? [];
    if (list.length === 0) return { key, label: CATEGORY_LABELS[key], score: null, tier: null, equipmentCount: 0 };
    const score = categoryScore(list.map((e) => e.h.score));
    return { key, label: CATEGORY_LABELS[key], score, tier: tierForScore(score), equipmentCount: list.length };
  });

  const current = new Map<HealthCategoryKey, number>();
  const projected = new Map<HealthCategoryKey, number>();
  for (const [key, list] of byCategory) {
    current.set(key, categoryScore(list.map((e) => e.h.score)));
    projected.set(key, categoryScore(list.map((e) => e.h.scoreIfServiced)));
  }

  const rawOverall = weightedOverall(current);
  const rawProjected = weightedOverall(projected);
  // A single critical system (<40) caps the headline at 69: averages must not mask a hazard.
  const hasCritical = [...current.values()].some((s) => s < 40);
  const overall = rawOverall === null ? null : round(hasCritical ? Math.min(rawOverall, 69) : rawOverall);
  const projectedOverall =
    rawProjected === null || overall === null
      ? null
      : Math.max(overall, round(hasCritical && [...projected.values()].some((s) => s < 40) ? Math.min(rawProjected, 69) : rawProjected));

  const topRisks: HomeRisk[] = health
    .map(({ item, h, alerts }) => {
      const p = failureProbability12m(h, item, alerts);
      return { item, h, p, rank: p * CATEGORY_IMPACT[h.category] };
    })
    .filter((r) => r.p >= 0.15)
    .sort((a, b) => b.rank - a.rank || b.p - a.p)
    .slice(0, 3)
    .map(({ item, h, p }) => ({
      equipmentId: h.equipmentId,
      label: h.label,
      category: h.category,
      categoryLabel: CATEGORY_LABELS[h.category],
      probability12m: Math.round(p * 100) / 100,
      level: (p >= 0.5 ? 'high' : p >= 0.3 ? 'medium' : 'low') as RiskLevel,
      reason: riskReason(h, item),
      action: h.alert?.recommended_action || CATEGORY_DEFAULT_ACTION[h.category],
      dueBy: riskDueBy(h, item, now),
    }));

  const covered = categories.filter((c) => c.score !== null).length;
  const withDates = health.filter((e) => e.h.hasInstallDate).length;
  const dateCoverage = health.length ? withDates / health.length : 0;
  const confidence: ScoreConfidence =
    covered >= 4 && dateCoverage >= 0.75 ? 'high' : covered >= 2 && dateCoverage >= 0.5 ? 'medium' : 'low';

  return {
    score: overall,
    tier: overall === null ? null : tierForScore(overall),
    projectedScore: projectedOverall,
    categories,
    topRisks,
    confidence,
    scoredEquipmentCount: health.length,
    unclassifiedCount: unclassified,
    coveredCategories: covered,
    capped: rawOverall !== null && overall !== null && overall < round(rawOverall),
  };
}
