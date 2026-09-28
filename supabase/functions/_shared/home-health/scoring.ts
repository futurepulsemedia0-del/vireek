// Deterministic Home Health scoring + failure-window prediction.
// Pure functions (no I/O) so results are consistent, explainable and testable —
// same principle as analyze-equipment-lifecycle. Client code only DISPLAYS what
// the agent stores; it never recomputes, so there is nothing to keep in sync.

export interface EquipmentInput {
  id: string;
  customer_id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_date: string | null;
  last_service_date: string | null;
  expected_lifespan_years: number;
  service_interval_months: number;
}

export interface UsageInput {
  repairs12mo: number;
  repairs36mo: number;
}

export type RiskLevel = "low" | "medium" | "high";
export type ActionType = "maintenance" | "replacement_planning";

export interface Driver {
  key: "age" | "service" | "repairs" | "data";
  label: string;
  impact: "positive" | "negative" | "neutral";
  detail: string;
}

export interface EquipmentHealth {
  equipment_id: string;
  customer_id: string;
  label: string;
  friendly_type: string;
  health: number; // 0-100
  risk: RiskLevel;
  action_type: ActionType | null;
  window_min_months: number | null;
  window_max_months: number | null;
  confidence: number; // 0-1
  age_years: number | null;
  lifespan_years: number;
  lifespan_used_pct: number | null;
  drivers: Driver[];
}

export interface PropertyHealth {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  confidence: number;
  equipment_count: number;
  at_risk_count: number;
  equipment: EquipmentHealth[];
}

// The equipment table defaults expected_lifespan_years to 15. When a unit still
// carries that default we substitute an industry benchmark for its type.
const SCHEMA_DEFAULT_LIFESPAN = 15;
const LIFESPAN_BENCHMARKS: Array<[RegExp, number]> = [
  [/tankless/i, 20],
  [/water\s*heater/i, 11],
  [/boiler/i, 20],
  [/furnace/i, 18],
  [/heat\s*pump/i, 15],
  [/(air\s*condition|\ba\/?c\b|condenser|mini[\s-]?split)/i, 15],
  [/sump\s*pump/i, 10],
  [/garbage\s*disposal|disposal/i, 10],
  [/water\s*softener/i, 12],
  [/dishwasher/i, 10],
  [/thermostat/i, 10],
  [/generator/i, 20],
  [/pool\s*pump/i, 8],
  [/(electrical\s*panel|breaker\s*panel)/i, 30],
];
const CRITICAL_TYPES = /(water\s*heater|boiler|furnace|heat\s*pump|air\s*condition|\ba\/?c\b|condenser|mini[\s-]?split|electrical\s*panel|breaker\s*panel|sump\s*pump)/i;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const YEAR_MS = 365.25 * 86_400_000;

function monthsBetween(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

function resolveLifespan(eq: EquipmentInput): { years: number; benchmarked: boolean } {
  if (eq.expected_lifespan_years !== SCHEMA_DEFAULT_LIFESPAN && eq.expected_lifespan_years > 0) {
    return { years: eq.expected_lifespan_years, benchmarked: true };
  }
  for (const [re, years] of LIFESPAN_BENCHMARKS) {
    if (re.test(eq.equipment_type)) return { years, benchmarked: true };
  }
  return { years: eq.expected_lifespan_years > 0 ? eq.expected_lifespan_years : SCHEMA_DEFAULT_LIFESPAN, benchmarked: false };
}

export function friendlyType(t: string): string {
  return t.trim().replace(/[_-]+/g, " ").toLowerCase() || "equipment";
}

export function scoreEquipment(eq: EquipmentInput, usage: UsageInput, now: Date = new Date()): EquipmentHealth {
  const { years: lifespan, benchmarked } = resolveLifespan(eq);
  const install = eq.install_date ? new Date(eq.install_date) : null;
  const ageYears = install ? Math.max(0, (now.getTime() - install.getTime()) / YEAR_MS) : null;
  const ratio = ageYears === null ? null : ageYears / lifespan;
  const label = [eq.make, eq.model].filter(Boolean).join(" ") || eq.equipment_type;
  const type = friendlyType(eq.equipment_type);
  const drivers: Driver[] = [];

  // --- Age (weight 40): gentle early, steep near end of life -----------------
  let ageScore = 60;
  if (ratio !== null && ageYears !== null) {
    ageScore = 100 * clamp(1 - Math.pow(ratio, 3), 0, 1);
    drivers.push({
      key: "age",
      label: "Age",
      impact: ratio >= 0.75 ? "negative" : ratio >= 0.5 ? "neutral" : "positive",
      detail: ratio >= 1
        ? `${ageYears.toFixed(1)} years old — past its typical ${lifespan}-year lifespan.`
        : `${ageYears.toFixed(1)} of ~${lifespan} typical years used (${Math.round(ratio * 100)}%).`,
    });
  }

  // --- Service compliance (weight 30) ---------------------------------------
  let serviceScore = 50;
  let serviceRatio: number | null = null;
  const lastService = eq.last_service_date ? new Date(eq.last_service_date) : install;
  if (lastService) {
    const months = Math.max(0, monthsBetween(lastService, now));
    const interval = Math.max(1, eq.service_interval_months || 12);
    serviceRatio = months / interval;
    serviceScore = 100 * clamp(1 - (serviceRatio - 1) / 1.5, 0, 1);
    drivers.push({
      key: "service",
      label: "Service history",
      impact: serviceRatio > 1 ? "negative" : "positive",
      detail: serviceRatio > 1
        ? `${months} months since last service (recommended every ${interval}).`
        : `Serviced ${months} month${months === 1 ? "" : "s"} ago — on schedule.`,
    });
  }

  // --- Repair frequency (weight 30) -----------------------------------------
  const r12 = usage.repairs12mo;
  let repairScore = [100, 85, 55, 30][r12] ?? 10;
  if (usage.repairs36mo >= 5) repairScore = Math.max(0, repairScore - 10);
  drivers.push({
    key: "repairs",
    label: "Repair frequency",
    impact: r12 >= 2 ? "negative" : r12 === 1 ? "neutral" : "positive",
    detail: r12 === 0
      ? "No repair visits in the last 12 months."
      : `${r12} repair visit${r12 === 1 ? "" : "s"} in the last 12 months.`,
  });

  let health = Math.round(0.4 * ageScore + 0.3 * serviceScore + 0.3 * repairScore);
  if (ratio !== null && ratio >= 1) health = Math.min(health, 40);
  health = clamp(health, 0, 100);

  // --- Risk level (aligned with analyze-equipment-lifecycle) ----------------
  const overdue = serviceRatio !== null && serviceRatio > 1;
  let risk: RiskLevel = "low";
  if (health < 45 || (ratio !== null && ratio >= 1) || r12 >= 3) risk = "high";
  else if (health < 70 || overdue || r12 >= 2 || (ratio !== null && ratio >= 0.75)) risk = "medium";

  const actionType: ActionType | null =
    risk === "low" ? null : risk === "high" && ((ratio !== null && ratio >= 1) || r12 >= 3) ? "replacement_planning" : "maintenance";

  // --- Failure window (months): remaining life x stress multiplier ----------
  let windowMin: number | null = null;
  let windowMax: number | null = null;
  if (ageYears !== null && ratio !== null) {
    let stress = 1;
    if (r12 >= 3) stress *= 0.5;
    else if (r12 === 2) stress *= 0.7;
    else if (r12 === 1) stress *= 0.9;
    if (serviceRatio !== null && serviceRatio > 2) stress *= 0.7;
    else if (overdue) stress *= 0.85;
    const remainingMonths = Math.max(0, lifespan - ageYears) * 12;
    const expected = ratio >= 1 ? 6 * stress : Math.max(1, remainingMonths * stress);
    windowMin = Math.max(1, Math.round(expected * 0.6));
    windowMax = Math.min(60, Math.max(windowMin + 1, Math.round(expected * 1.4)));
  }

  // --- Confidence: how much real data backs this prediction ------------------
  let confidence = 0.35;
  if (install) confidence += 0.2;
  if (eq.last_service_date) confidence += 0.15;
  if (eq.make && eq.model) confidence += 0.1;
  if (usage.repairs36mo > 0 || eq.last_service_date) confidence += 0.1;
  if (benchmarked) confidence += 0.1;
  confidence = Math.round(clamp(confidence, 0.35, 0.95) * 100) / 100;

  if (!install) {
    drivers.push({ key: "data", label: "Missing data", impact: "neutral", detail: "No install date on file — prediction confidence is low. Adding it sharpens the forecast." });
  }

  return {
    equipment_id: eq.id,
    customer_id: eq.customer_id,
    label,
    friendly_type: type,
    health,
    risk,
    action_type: actionType,
    window_min_months: windowMin,
    window_max_months: windowMax,
    confidence,
    age_years: ageYears === null ? null : Math.round(ageYears * 10) / 10,
    lifespan_years: lifespan,
    lifespan_used_pct: ratio === null ? null : Math.round(ratio * 100),
    drivers,
  };
}

export function gradeFor(score: number): PropertyHealth["grade"] {
  return score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "F";
}

/** Home score: weighted mean (critical systems x1.5) blended with the weakest unit. */
export function scoreProperty(items: EquipmentHealth[]): PropertyHealth | null {
  if (items.length === 0) return null;
  let weighted = 0;
  let weights = 0;
  let confWeighted = 0;
  for (const it of items) {
    const w = CRITICAL_TYPES.test(it.friendly_type) ? 1.5 : 1;
    weighted += it.health * w;
    confWeighted += it.confidence * w;
    weights += w;
  }
  const mean = weighted / weights;
  const weakest = Math.min(...items.map((i) => i.health));
  const score = clamp(Math.round(0.7 * mean + 0.3 * weakest), 0, 100);
  return {
    score,
    grade: gradeFor(score),
    confidence: Math.round((confWeighted / weights) * 100) / 100,
    equipment_count: items.length,
    at_risk_count: items.filter((i) => i.risk !== "low").length,
    equipment: items,
  };
}

/** Plain-language customer/owner explanation. Deterministic on purpose. */
export function explain(h: EquipmentHealth): string {
  const when = h.window_min_months !== null && h.window_max_months !== null
    ? `in roughly ${h.window_min_months}–${h.window_max_months} months`
    : "sooner than ideal";
  const need = h.action_type === "replacement_planning"
    ? `is likely to need replacement ${when}`
    : `is likely to need service ${when}`;
  const reasons = h.drivers.filter((d) => d.impact === "negative").map((d) => d.detail);
  const because = reasons.length ? ` Why: ${reasons.join(" ")}` : "";
  return `Your ${h.friendly_type} (${h.label}) ${need}.${because} Acting early is typically cheaper and avoids an emergency breakdown.`;
}
