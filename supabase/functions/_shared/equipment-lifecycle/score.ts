// Deterministic equipment lifecycle risk scoring — pure functions (no I/O, no Deno APIs).
// Rule-based on purpose: a health score has to be consistent and explainable, not an LLM guess.
// Used by analyze-equipment-lifecycle and unit-tested from src/lib/equipmentLifecycleScore.test.ts.
//
// Two evidence sources:
//   1) the current account's own job_equipment rows (legacy behaviour, always available)
//   2) Equipment Passport signals: the sealed history from EVERY verified servicing company
//      (null when the unit has no verified passport -> behaviour is identical to before).

export type RiskLevel = "low" | "medium" | "high";

export interface LifecycleEquipment {
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_date: string | null;
  last_service_date: string | null;
  expected_lifespan_years: number;
  service_interval_months: number;
}

export interface PassportSignals {
  total_events: number;
  repair_12m: number;
  repair_6m: number;
  repair_prev_6m: number;
  callbacks_12m: number;
  contractors_24m: number;
  warranty_claims_24m: number;
  last_service_at: string | null;
  last_service_by_other: boolean;
  repeat_part: string | null;
  repeat_part_count: number;
}

export interface LifecycleAssessment {
  riskLevel: RiskLevel;
  predictedIssue: string;
  recommendedAction: string | null;
  predictedServiceDue: string | null;
  reasons: string[];
  snapshot: Record<string, unknown>;
}

const DAY_MS = 86_400_000;
const LEVEL_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

const ACTION_REPLACE =
  "Offer the customer a replacement quote before the next breakdown — this unit is a strong candidate for proactive replacement.";
const ACTION_MAINTAIN =
  "Schedule a routine maintenance visit and flag this unit for a replacement conversation within the next 6–12 months.";

export function monthsBetween(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Defensive parse of the JSON returned by lifecycle_passport_signals(). */
export function parseSignals(raw: unknown): PassportSignals | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const last = typeof r.last_service_at === "string" && !Number.isNaN(new Date(r.last_service_at).getTime()) ? r.last_service_at : null;
  const part = typeof r.repeat_part === "string" && r.repeat_part.trim() ? r.repeat_part.trim() : null;
  return {
    total_events: num(r.total_events),
    repair_12m: num(r.repair_12m),
    repair_6m: num(r.repair_6m),
    repair_prev_6m: num(r.repair_prev_6m),
    callbacks_12m: num(r.callbacks_12m),
    contractors_24m: num(r.contractors_24m),
    warranty_claims_24m: num(r.warranty_claims_24m),
    last_service_at: last,
    last_service_by_other: r.last_service_by_other === true,
    repeat_part: part,
    repeat_part_count: part ? num(r.repeat_part_count) : 0,
  };
}

interface Trigger {
  level: RiskLevel;
  priority: number; // lower = more important within the same level
  text: string;
  action: string;
}

export function assessLifecycle(
  eq: LifecycleEquipment,
  now: Date,
  localRepairs12m: number,
  signals: PassportSignals | null,
): LifecycleAssessment {
  const label = [eq.make, eq.model].filter(Boolean).join(" ") || eq.equipment_type;
  const installDate = eq.install_date ? new Date(eq.install_date) : null;
  const ageYears = installDate ? Math.max(0, (now.getTime() - installDate.getTime()) / (DAY_MS * 365.25)) : 0;
  const lifespanUsedPct = eq.expected_lifespan_years > 0 ? ageYears / eq.expected_lifespan_years : 0;

  // Last service = the most recent of: this account's record, install date, and ANY verified company's visit.
  const candidates: Date[] = [];
  if (eq.last_service_date) candidates.push(new Date(eq.last_service_date));
  if (installDate) candidates.push(installDate);
  if (signals?.last_service_at) candidates.push(new Date(signals.last_service_at));
  const valid = candidates.filter((d) => !Number.isNaN(d.getTime()));
  const lastService = valid.length > 0 ? new Date(Math.max(...valid.map((d) => d.getTime()))) : null;
  const monthsSinceService = lastService ? monthsBetween(lastService, now) : null;
  const overdueService = monthsSinceService !== null && monthsSinceService > eq.service_interval_months;

  // With a verified passport the repair count covers every company (and excludes routine maintenance).
  const repairs = signals ? signals.repair_12m : Math.max(0, Math.floor(localRepairs12m));
  const companies = signals?.contractors_24m ?? 0;
  const triggers: Trigger[] = [];

  if (lifespanUsedPct >= 1) {
    triggers.push({
      level: "high", priority: 1,
      text: `${label} has passed its expected ${eq.expected_lifespan_years}-year lifespan (${ageYears.toFixed(1)} years in service).`,
      action: ACTION_REPLACE,
    });
  }
  if (repairs >= 3) {
    triggers.push({
      level: "high", priority: 2,
      text: `${label} has needed ${repairs} repair visits in the last 12 months${companies > 1 ? ` across ${companies} service companies` : ""} — a common pattern right before failure.`,
      action: ACTION_REPLACE,
    });
  }
  if (signals && signals.callbacks_12m >= 2) {
    triggers.push({
      level: "high", priority: 3,
      text: `${label} has failed again after repair ${signals.callbacks_12m} times in the last 12 months — repairs are not holding.`,
      action: "Stop repeating the same fix: run a root-cause diagnosis or quote a replacement.",
    });
  }
  if (signals && signals.repeat_part && signals.repeat_part_count >= 3) {
    triggers.push({
      level: "high", priority: 4,
      text: `The same part ("${signals.repeat_part}") has been replaced ${signals.repeat_part_count} times in 24 months — something upstream is destroying it.`,
      action: "Diagnose what is killing this part before replacing it again; consider replacing the unit.",
    });
  } else if (signals && signals.repeat_part && signals.repeat_part_count === 2) {
    triggers.push({
      level: "medium", priority: 4,
      text: `The same part ("${signals.repeat_part}") has been replaced twice in 24 months.`,
      action: "Check for an upstream cause on the next visit instead of swapping the part a third time.",
    });
  }
  if (signals && signals.repair_6m >= 2 && signals.repair_6m > signals.repair_prev_6m) {
    triggers.push({
      level: lifespanUsedPct >= 0.75 ? "high" : "medium", priority: 5,
      text: `Repairs are accelerating on ${label}: ${signals.repair_6m} in the last 6 months vs ${signals.repair_prev_6m} in the 6 months before.`,
      action: lifespanUsedPct >= 0.75 ? ACTION_REPLACE : ACTION_MAINTAIN,
    });
  }
  if (signals && repairs >= 2 && companies >= 3) {
    triggers.push({
      level: "medium", priority: 6,
      text: `${companies} different service companies have worked on ${label} in 24 months — nobody owns the root cause.`,
      action: "Offer one thorough diagnostic visit that reviews the full service history and ends with a single recommendation.",
    });
  }
  if (signals && signals.warranty_claims_24m >= 2) {
    triggers.push({
      level: "medium", priority: 7,
      text: `${label} has ${signals.warranty_claims_24m} warranty claims in 24 months.`,
      action: "Check the manufacturer's repeat-failure / replacement policy and document every failure for the claim.",
    });
  }
  if (lifespanUsedPct >= 0.75 && lifespanUsedPct < 1) {
    triggers.push({
      level: "medium", priority: 8,
      text: `${label} is at ${Math.round(lifespanUsedPct * 100)}% of its expected lifespan.`,
      action: ACTION_MAINTAIN,
    });
  }
  if (overdueService) {
    triggers.push({
      level: "medium", priority: 9,
      text: `${label} is overdue for its ${eq.service_interval_months}-month service interval (${monthsSinceService} months since last service${signals?.last_service_by_other ? ", last serviced by another company" : ""}).`,
      action: ACTION_MAINTAIN,
    });
  }
  if (repairs === 2) {
    triggers.push({
      level: "medium", priority: 10,
      text: `${label} has needed 2 repair visits in the last 12 months.`,
      action: ACTION_MAINTAIN,
    });
  }

  triggers.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.priority - b.priority);
  const primary = triggers[0];
  const riskLevel: RiskLevel = primary ? primary.level : "low";

  const dueBase = lastService ?? installDate;
  const predictedServiceDue = dueBase
    ? new Date(dueBase.getTime() + eq.service_interval_months * 30 * DAY_MS).toISOString().slice(0, 10)
    : null;

  return {
    riskLevel,
    predictedIssue: primary ? primary.text : `${label} is within its expected service life.`,
    recommendedAction: primary ? primary.action : null,
    predictedServiceDue,
    reasons: triggers.map((t) => t.text),
    snapshot: {
      age_years: Number(ageYears.toFixed(2)),
      lifespan_used_pct: Number(lifespanUsedPct.toFixed(2)),
      repairs_last_12mo: repairs,
      months_since_service: monthsSinceService,
      reasons: triggers.map((t) => t.text),
      passport: signals
        ? {
            events: signals.total_events,
            companies_24m: signals.contractors_24m,
            repairs_6m: signals.repair_6m,
            repairs_prev_6m: signals.repair_prev_6m,
            callbacks_12m: signals.callbacks_12m,
            warranty_claims_24m: signals.warranty_claims_24m,
            repeat_part: signals.repeat_part,
            repeat_part_count: signals.repeat_part_count,
            last_service_by_other: signals.last_service_by_other,
          }
        : null,
    },
  };
}
