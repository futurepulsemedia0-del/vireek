/**
 * SLO math — pure functions shared by the `slo-evaluate` edge function and the staff dashboard.
 * No imports on purpose: it must load unchanged in Deno (edge functions) and Vite (React + tests).
 *
 * Model: every synthetic probe produces good/bad events per SLI. An SLO says "objective of events
 * must be good over window_days". Error budget = (1 - objective) * total events.
 *
 * Alerting: multi-window multi-burn-rate (Google SRE workbook), adapted to low-volume synthetic
 * traffic: each rule needs a long AND a short window burning, plus a minimum number of bad events,
 * so a single flaky probe can never open an incident.
 */

export type SliName = 'availability' | 'answer_latency' | 'asr_accuracy' | 'booking_success' | 'webhook_delivery';

export interface Counts {
  good: number;
  total: number;
}

export interface WindowCountRow {
  window_minutes: number;
  sli: string;
  region: string;
  good: number | string;
  total: number | string;
}

export interface SloDefinition {
  key: string;
  label: string;
  sli: SliName;
  objective: number;
  window_days: number;
  region: string | null;
  component_id: string;
}

export type BudgetState = 'no_data' | 'healthy' | 'warning' | 'exhausted';

export interface ErrorBudget {
  total: number;
  good: number;
  bad: number;
  /** good / total, or null without data. */
  sli: number | null;
  objective: number;
  /** Bad events the objective allows for this many events. */
  allowedBad: number;
  /** Fraction of the budget consumed (1 = all of it). Null without data. */
  consumed: number | null;
  /** 1 - consumed; negative when overspent. Null without data. */
  remaining: number | null;
  state: BudgetState;
}

/** Windows (minutes) the evaluator and dashboard request in a single RPC call. */
export const SHORT_WINDOW_MINUTES = 15;
export const HOUR_WINDOW_MINUTES = 60;
export const LONG_WINDOW_MINUTES = 360;

export function windowsFor(sloWindowDays: number): number[] {
  const days = Math.min(Math.max(Math.trunc(sloWindowDays), 1), 90);
  return Array.from(new Set([SHORT_WINDOW_MINUTES, HOUR_WINDOW_MINUTES, LONG_WINDOW_MINUTES, days * 1440]));
}

function toNum(v: number | string): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function errorBudget(counts: Counts, objective: number): ErrorBudget {
  const total = Math.max(0, Math.trunc(counts.total));
  const good = Math.min(total, Math.max(0, Math.trunc(counts.good)));
  const bad = total - good;
  if (total === 0) {
    return { total, good, bad, sli: null, objective, allowedBad: 0, consumed: null, remaining: null, state: 'no_data' };
  }
  const allowedBad = (1 - objective) * total;
  const consumed = allowedBad > 0 ? bad / allowedBad : bad > 0 ? Infinity : 0;
  const remaining = 1 - consumed;
  let state: BudgetState = 'healthy';
  if (consumed >= 1) state = 'exhausted';
  else if (consumed >= 0.5) state = 'warning';
  return {
    total,
    good,
    bad,
    sli: good / total,
    objective,
    allowedBad,
    consumed: Number.isFinite(consumed) ? consumed : 1e9,
    remaining: Number.isFinite(remaining) ? remaining : -1e9,
    state,
  };
}

/** How many times faster than "exactly on objective" the budget is burning. Null without data. */
export function burnRate(counts: Counts, objective: number): number | null {
  if (counts.total <= 0) return null;
  const budgetFraction = 1 - objective;
  if (budgetFraction <= 0) return null;
  return (counts.total - counts.good) / counts.total / budgetFraction;
}

// ---------------------------------------------------------------------------
// Count helpers
// ---------------------------------------------------------------------------

export function pickCounts(rows: WindowCountRow[], windowMinutes: number, sli: string, region?: string | null): Counts {
  let good = 0;
  let total = 0;
  for (const r of rows) {
    if (r.window_minutes !== windowMinutes || r.sli !== sli) continue;
    if (region && r.region !== region) continue;
    good += toNum(r.good);
    total += toNum(r.total);
  }
  return { good, total };
}

export function regionsFor(rows: WindowCountRow[], sli: string): string[] {
  return Array.from(new Set(rows.filter((r) => r.sli === sli).map((r) => r.region))).sort();
}

// ---------------------------------------------------------------------------
// Burn-rate alert rules
// ---------------------------------------------------------------------------

export interface BurnRule {
  impact: 'major' | 'minor';
  longWindowMinutes: number;
  shortWindowMinutes: number;
  burn: number;
  /** Minimum bad events inside the long window (flake protection). */
  minBadLong: number;
  /** Minimum events inside the short window (must be measuring something). */
  minTotalShort: number;
}

export const DEFAULT_RULES: BurnRule[] = [
  { impact: 'major', longWindowMinutes: HOUR_WINDOW_MINUTES, shortWindowMinutes: SHORT_WINDOW_MINUTES, burn: 14.4, minBadLong: 2, minTotalShort: 1 },
  { impact: 'minor', longWindowMinutes: LONG_WINDOW_MINUTES, shortWindowMinutes: HOUR_WINDOW_MINUTES, burn: 6, minBadLong: 3, minTotalShort: 2 },
];

export interface AlertDecision {
  firing: boolean;
  impact: 'major' | 'minor' | null;
  rule: BurnRule | null;
  longBurn: number | null;
  shortBurn: number | null;
}

/** `countsFor(minutes)` returns the good/total counts for that window. Highest-impact rule wins. */
export function evaluateBurnAlerts(
  countsFor: (windowMinutes: number) => Counts,
  objective: number,
  rules: BurnRule[] = DEFAULT_RULES,
): AlertDecision {
  let best: AlertDecision = { firing: false, impact: null, rule: null, longBurn: null, shortBurn: null };
  for (const rule of rules) {
    const long = countsFor(rule.longWindowMinutes);
    const short = countsFor(rule.shortWindowMinutes);
    const longBurn = burnRate(long, objective);
    const shortBurn = burnRate(short, objective);
    const fires =
      longBurn !== null &&
      shortBurn !== null &&
      longBurn >= rule.burn &&
      shortBurn >= rule.burn &&
      long.total - long.good >= rule.minBadLong &&
      short.total >= rule.minTotalShort;
    if (fires && (!best.firing || (rule.impact === 'major' && best.impact !== 'major'))) {
      best = { firing: true, impact: rule.impact, rule, longBurn, shortBurn };
    } else if (!best.firing && best.longBurn === null) {
      best = { ...best, longBurn, shortBurn };
    }
  }
  return best;
}

/** Hysteresis: resolve only after a clean hour with enough probes to be meaningful. */
export function shouldResolve(hour: Counts, minSamples = 2): boolean {
  return hour.total >= minSamples && hour.total === hour.good;
}

export function incidentKey(sloKey: string, region: string | null): string {
  return `slo:${sloKey}:${region ?? 'all'}`;
}

const SLI_PHRASE: Record<SliName, string> = {
  availability: 'calls are not being answered by the AI receptionist',
  answer_latency: 'the AI receptionist is slow to answer calls',
  asr_accuracy: 'speech recognition quality is degraded on calls',
  booking_success: 'appointments are not being created from calls',
  webhook_delivery: 'outbound webhooks are delayed or failing',
};

export function incidentCopy(
  slo: Pick<SloDefinition, 'sli' | 'label'>,
  region: string | null,
  decision: AlertDecision,
): { title: string; message: string } {
  const where = region ? ` in ${region}` : '';
  const phrase = SLI_PHRASE[slo.sli];
  const burn = decision.shortBurn !== null ? ` (error budget burning ${decision.shortBurn.toFixed(1)}x faster than allowed)` : '';
  return {
    title: `${slo.sli === 'webhook_delivery' ? 'Webhooks' : 'Voice AI'} degraded${where}`,
    message: `Automated test calls detected that ${phrase}${where}${burn}. We are investigating.`,
  };
}

export function formatPct(v: number | null, digits = 2): string {
  return v === null ? '—' : `${(v * 100).toFixed(digits)}%`;
}
