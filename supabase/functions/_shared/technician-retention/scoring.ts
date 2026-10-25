// Technician Retention Engine - transparent, rule-based scoring.
// No AI, no black box: every score is a weighted sum of seven operational
// signals, and every point of it is traceable to a driver.
//
// NEVER add a protected attribute (age, gender, ethnicity, health, religion,
// disability, ...) to the inputs - scoring.test.ts enforces an allow-list.

export const MODEL_VERSION = "rules-v1";
export const WINDOW_WEEKS = 8;
/** Industry baseline annual turnover (16-20%) used when there is not enough data. */
export const BASELINE_PROBABILITY = 0.18;
export const NEW_HIRE_DAYS = 56;

export type SignalKey =
  | "same_day_changes" | "overtime" | "on_call_load" | "earnings_trend"
  | "callback_rate" | "unpaid_time" | "unanswered_requests";

/** Sum = 100. */
export const SIGNAL_WEIGHTS: Record<SignalKey, number> = {
  same_day_changes: 22, earnings_trend: 18, overtime: 16, on_call_load: 14,
  unanswered_requests: 12, unpaid_time: 10, callback_rate: 8,
};

/** value <= good -> 0 pts, value >= bad -> 100 pts, linear in between. */
export const RAMPS: Record<SignalKey, { good: number; bad: number }> = {
  same_day_changes: { good: 0.5, bad: 4 },     // changes per week
  overtime: { good: 1, bad: 8 },               // overtime hours per week
  on_call_load: { good: 1.1, bad: 2 },         // ratio vs team average
  earnings_trend: { good: 0.02, bad: 0.3 },    // fractional drop, last 4 vs prior 4 weeks
  callback_rate: { good: 0.03, bad: 0.15 },    // callbacks / completed jobs
  unpaid_time: { good: 0.25, bad: 4 },         // rejected (unpaid) hours per week
  unanswered_requests: { good: 0.25, bad: 3 }, // requests without office reply per week
};

export const HIGH_AT = 50;
export const ELEVATED_AT = 25;
const MIN_DRIVER_COMPONENT = 20;

export interface TechSignalInputs {
  tenureDays: number;
  scheduledJobs: number;
  completedJobs: number;
  sameDayChanges: number;
  hasTimesheets: boolean;
  overtimeHours: number;
  rejectedHours: number;
  /** null when the technician is in no on-call rotation */
  onCallDays: number | null;
  /** null when fewer than 2 people share a rotation */
  teamAvgOnCallDays: number | null;
  /** cents */
  earningsRecent: number;
  earningsPrior: number;
  callbacks: number;
  /** technician requests in office threads */
  techRequests: number;
  unansweredRequests: number;
}

export type RiskBand = "high" | "elevated" | "low" | "insufficient";
export type DataQuality = "ok" | "limited" | "insufficient";

export interface Driver {
  key: SignalKey;
  /** share of the final score this driver explains (drivers sum to the score) */
  points: number;
  /** 0-100 severity of this signal alone */
  severity: number;
  /** values for the UI's i18n template */
  params: Record<string, number>;
  /** plain-language English fallback */
  message: string;
}

export interface ScoreResult {
  score: number;
  band: RiskBand;
  dataQuality: DataQuality;
  confidence: number;
  weeksObserved: number;
  newHire: boolean;
  topDrivers: Driver[];
  signals: Record<string, { available: boolean; severity: number; value: number | null }>;
  attritionProbability: number;
  replacementCost: number;
  expectedAnnualCost: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function ramp(value: number, key: SignalKey): number {
  const { good, bad } = RAMPS[key];
  if (!Number.isFinite(value)) return 0;
  return clamp(((value - good) / (bad - good)) * 100, 0, 100);
}

/** Weeks of data this technician contributes to the 8-week window (1..8). */
export function observedWeeks(tenureDays: number): number {
  return clamp(tenureDays / 7, 1, WINDOW_WEEKS);
}

/** Whole US dollars; tenure-tiered inside the $15-25k industry range. */
export function replacementCostDollars(tenureDays: number): number {
  if (tenureDays < 365) return 15_000;
  if (tenureDays < 1095) return 20_000;
  return 25_000;
}

/** Heuristic 12-month departure likelihood: ~18% at score 20, ~60% at 100. */
export function attritionProbability(score: number): number {
  return Math.round(clamp(0.08 + 0.0052 * score, 0, 0.6) * 1000) / 1000;
}

export function bandFor(score: number): Exclude<RiskBand, "insufficient"> {
  return score >= HIGH_AT ? "high" : score >= ELEVATED_AT ? "elevated" : "low";
}

interface Evaluated { available: boolean; value: number | null; params: Record<string, number>; message: string }

function evaluate(i: TechSignalInputs, weeks: number): Record<SignalKey, Evaluated> {
  const none: Evaluated = { available: false, value: null, params: {}, message: "" };

  const sdPerWeek = i.sameDayChanges / weeks;
  const sameDay: Evaluated = i.scheduledJobs >= 3
    ? { available: true, value: r2(sdPerWeek), params: { count: i.sameDayChanges, perWeek: r1(sdPerWeek) },
        message: `${i.sameDayChanges} job${i.sameDayChanges === 1 ? "" : "s"} moved within 24 hours of the start time (${r1(sdPerWeek)} per week).` }
    : none;

  const otPerWeek = i.overtimeHours / weeks;
  const overtime: Evaluated = i.hasTimesheets
    ? { available: true, value: r2(otPerWeek), params: { hours: r1(i.overtimeHours), perWeek: r1(otPerWeek) },
        message: `${r1(i.overtimeHours)} overtime hours (${r1(otPerWeek)} per week).` }
    : none;

  const ratio = i.onCallDays !== null && i.teamAvgOnCallDays !== null && i.teamAvgOnCallDays > 0
    ? i.onCallDays / i.teamAvgOnCallDays : null;
  const onCall: Evaluated = ratio !== null
    ? { available: true, value: r2(ratio), params: { days: r1(i.onCallDays ?? 0), avg: r1(i.teamAvgOnCallDays ?? 0), ratio: r1(ratio) },
        message: `${r1(i.onCallDays ?? 0)} days on call vs a team average of ${r1(i.teamAvgOnCallDays ?? 0)}.` }
    : none;

  const drop = i.earningsPrior > 0 ? Math.max(0, (i.earningsPrior - i.earningsRecent) / i.earningsPrior) : 0;
  const earnings: Evaluated = i.earningsPrior >= 20_000 && weeks >= 6
    ? { available: true, value: r2(drop), params: { dropPct: Math.round(drop * 100), recent: Math.round(i.earningsRecent / 100), prior: Math.round(i.earningsPrior / 100) },
        message: `Earnings are down ${Math.round(drop * 100)}% over the last 4 weeks compared with the 4 weeks before.` }
    : none;

  const cbRate = i.completedJobs > 0 ? i.callbacks / i.completedJobs : 0;
  const callbacks: Evaluated = i.completedJobs >= 8
    ? { available: true, value: r2(cbRate), params: { count: i.callbacks, jobs: i.completedJobs, ratePct: r1(cbRate * 100) },
        message: `${i.callbacks} callback${i.callbacks === 1 ? "" : "s"} on ${i.completedJobs} completed jobs (${r1(cbRate * 100)}%).` }
    : none;

  const unpaidPerWeek = i.rejectedHours / weeks;
  const unpaid: Evaluated = i.hasTimesheets
    ? { available: true, value: r2(unpaidPerWeek), params: { hours: r1(i.rejectedHours), perWeek: r1(unpaidPerWeek) },
        message: `${r1(i.rejectedHours)} worked hours were rejected and not paid (${r1(unpaidPerWeek)} per week).` }
    : none;

  const unPerWeek = i.unansweredRequests / weeks;
  const unanswered: Evaluated = i.techRequests >= 3
    ? { available: true, value: r2(unPerWeek), params: { count: i.unansweredRequests, total: i.techRequests, perWeek: r1(unPerWeek) },
        message: `${i.unansweredRequests} of ${i.techRequests} requests to the office got no reply within 4 hours.` }
    : none;

  return {
    same_day_changes: sameDay, overtime, on_call_load: onCall, earnings_trend: earnings,
    callback_rate: callbacks, unpaid_time: unpaid, unanswered_requests: unanswered,
  };
}

export function computeScore(i: TechSignalInputs): ScoreResult {
  const weeks = observedWeeks(i.tenureDays);
  const newHire = i.tenureDays < NEW_HIRE_DAYS;
  const replacementCost = replacementCostDollars(i.tenureDays);
  const ev = evaluate(i, weeks);
  const keys = Object.keys(SIGNAL_WEIGHTS) as SignalKey[];

  const signals: ScoreResult["signals"] = {};
  const available = keys.filter((k) => ev[k].available);
  const availW = available.reduce((s, k) => s + SIGNAL_WEIGHTS[k], 0);
  for (const k of keys) {
    signals[k] = { available: ev[k].available, severity: ev[k].available ? Math.round(ramp(ev[k].value ?? 0, k)) : 0, value: ev[k].value };
  }

  // Not enough evidence: show "insufficient", never a made-up number.
  if (available.length < 2) {
    return {
      score: 0, band: "insufficient", dataQuality: "insufficient", confidence: 0, weeksObserved: r1(weeks), newHire,
      topDrivers: [], signals, attritionProbability: BASELINE_PROBABILITY, replacementCost,
      expectedAnnualCost: Math.round(BASELINE_PROBABILITY * replacementCost),
    };
  }

  const confidence = Math.min(1, availW / 60) * Math.min(1, weeks / 4);
  const drivers: Driver[] = available.map((k) => {
    const severity = ramp(ev[k].value ?? 0, k);
    return {
      key: k, severity: Math.round(severity),
      points: r1(((SIGNAL_WEIGHTS[k] * severity) / availW) * confidence),
      params: ev[k].params, message: ev[k].message,
    };
  });
  const raw = drivers.reduce((s, d) => s + (SIGNAL_WEIGHTS[d.key] * d.severity) / availW, 0);
  const score = Math.round(clamp(raw * confidence, 0, 100));
  const topDrivers = drivers
    .filter((d) => d.severity >= MIN_DRIVER_COMPONENT && d.points > 0)
    .sort((a, b) => b.points - a.points || SIGNAL_WEIGHTS[b.key] - SIGNAL_WEIGHTS[a.key])
    .slice(0, 3);

  const probability = attritionProbability(score);
  return {
    score, band: bandFor(score), confidence: Math.round(confidence * 1000) / 1000, weeksObserved: r1(weeks), newHire,
    dataQuality: confidence < 1 || newHire || available.length < 4 ? "limited" : "ok",
    topDrivers, signals, attritionProbability: probability, replacementCost,
    expectedAnnualCost: Math.round(probability * replacementCost),
  };
}

// ---------------------------------------------------------------- actions
export type ActionType =
  | "rebalance_on_call" | "freeze_schedule" | "reduce_overtime"
  | "remove_paperwork_step" | "clear_office_backlog" | "manager_one_on_one";

export const DRIVER_ACTION: Record<SignalKey, ActionType> = {
  same_day_changes: "freeze_schedule",
  overtime: "reduce_overtime",
  on_call_load: "rebalance_on_call",
  earnings_trend: "manager_one_on_one",
  callback_rate: "manager_one_on_one",
  unpaid_time: "remove_paperwork_step",
  unanswered_requests: "clear_office_backlog",
};

export interface PlannedAction {
  action_type: ActionType;
  driver_key: SignalKey;
  title: string;
  detail: string;
  params: Record<string, number | string>;
}

const ACTION_TEXT: Record<ActionType, (name: string, d: Driver) => { title: string; detail: string }> = {
  freeze_schedule: (n, d) => ({
    title: `Freeze ${n}'s schedule for the next 48 hours`,
    detail: `${d.message} Locking the next 48 hours means only an emergency can move ${n}'s jobs; you can lift the freeze at any time.`,
  }),
  reduce_overtime: (n, d) => ({
    title: `Redistribute ${n}'s overtime`,
    detail: `${d.message} Move or reassign some of ${n}'s upcoming jobs to technicians with open capacity.`,
  }),
  rebalance_on_call: (n, d) => ({
    title: `Rebalance the on-call rotation for ${n}`,
    detail: `${d.message} Review the rotation so on-call days are shared more evenly.`,
  }),
  manager_one_on_one: (n, d) => ({
    title: `Hold a 1:1 check-in with ${n}`,
    detail: `${d.message} Ask what is getting in the way and what would help; review job mix and support together.`,
  }),
  remove_paperwork_step: (n, d) => ({
    title: `Remove a paperwork step for ${n}`,
    detail: `${d.message} Find out why the time was rejected and simplify the timesheet or close-out step that causes it.`,
  }),
  clear_office_backlog: (n, d) => ({
    title: `Clear the office backlog for ${n}`,
    detail: `${d.message} Reply to open requests and agree a response-time target with the office.`,
  }),
};

/** One concrete action per top driver (deduplicated by action type), only for elevated/high scores. */
export function planActions(result: ScoreResult, techName: string): PlannedAction[] {
  if (result.band !== "high" && result.band !== "elevated") return [];
  const name = techName.trim() || "this technician";
  const seen = new Set<ActionType>();
  const out: PlannedAction[] = [];
  for (const d of result.topDrivers) {
    const type = DRIVER_ACTION[d.key];
    if (seen.has(type)) continue;
    seen.add(type);
    const text = ACTION_TEXT[type](name, d);
    out.push({ action_type: type, driver_key: d.key, title: text.title.slice(0, 300), detail: text.detail.slice(0, 2000), params: { name, ...d.params } });
  }
  return out;
}

export type Outcome = "improved" | "no_change" | "worsened";
export const OUTCOME_MIN_DAYS = 7;
export const OUTCOME_DELTA = 5;

/** Did the technician's score move at least 5 points since the action was approved? */
export function evaluateOutcome(baseline: number, current: number): Outcome {
  const delta = current - baseline;
  if (delta <= -OUTCOME_DELTA) return "improved";
  if (delta >= OUTCOME_DELTA) return "worsened";
  return "no_change";
}
