// supabase/functions/_shared/bank/forecast.ts
//
// Pure, deterministic cash projection built from REAL balances:
// bank balance + open receivables (probability-weighted by each customer's
// historical payment lag) - open payables - recurring bank-detected outflows
// - manually entered fixed expenses. No AI, fully explainable and testable.

import { addDays, daysBetween, nameSimilarity } from "./normalize.ts";

export type Cadence = "weekly" | "biweekly" | "monthly";

export interface OutflowTxn { merchantKey: string; amountCents: number; date: string; label: string }
export interface RecurringOutflow {
  merchantKey: string; label: string; amountCents: number; cadence: Cadence; nextDate: string; occurrences: number;
}
export interface ForecastReceivable { id: string; balanceCents: number; dueDate: string; customerKey: string | null }
export interface ForecastPayable { id: string; balanceCents: number; dueDate: string; vendorKey: string | null }
export interface FixedExpense { label: string; amountCents: number; frequency: "one_time" | Cadence; nextDueDate: string }

export interface ForecastInput {
  today: string;
  horizonDays: number;
  startingBalanceCents: number;
  thresholdCents: number;
  receivables: ForecastReceivable[];
  payables: ForecastPayable[];
  recurring: RecurringOutflow[];
  fixed: FixedExpense[];
  customerLagDays: Record<string, number>;
}
export interface ForecastDay { date: string; balanceCents: number; noCollectionsBalanceCents: number }
export interface ForecastResult {
  days: ForecastDay[];
  runwayDaysExpected: number | null;
  runwayDaysNoCollections: number | null;
  breachDate: string | null;
  lowestBalanceCents: number;
  lowestDate: string;
  expectedInflowCents: number;
  scheduledOutflowCents: number;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function addMonths(date: string, n: number): string {
  const d = new Date(Date.parse(date.slice(0, 10) + "T00:00:00Z"));
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

function step(date: string, cadence: Cadence): string {
  return cadence === "weekly" ? addDays(date, 7) : cadence === "biweekly" ? addDays(date, 14) : addMonths(date, 1);
}

export function detectRecurring(txns: OutflowTxn[], today: string): RecurringOutflow[] {
  const groups = new Map<string, OutflowTxn[]>();
  for (const t of txns) {
    if (t.amountCents <= 0) continue;
    const g = groups.get(t.merchantKey) ?? [];
    g.push(t);
    groups.set(t.merchantKey, g);
  }
  const out: RecurringOutflow[] = [];
  for (const [key, list] of groups) {
    if (list.length < 3) continue;
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) intervals.push(daysBetween(sorted[i].date, sorted[i - 1].date));
    const med = median(intervals);
    let cadence: Cadence | null = null;
    let tol = 0;
    if (med >= 5 && med <= 9) { cadence = "weekly"; tol = 2; }
    else if (med >= 12 && med <= 16) { cadence = "biweekly"; tol = 3; }
    else if (med >= 26 && med <= 35) { cadence = "monthly"; tol = 5; }
    if (!cadence) continue;
    const consistent = intervals.filter((d) => Math.abs(d - med) <= tol).length / intervals.length;
    if (consistent < 0.7) continue;
    const amt = median(sorted.map((t) => t.amountCents));
    const mad = sorted.reduce((s, t) => s + Math.abs(t.amountCents - amt), 0) / sorted.length;
    if (amt <= 0 || mad / amt > 0.25) continue;
    const last = sorted[sorted.length - 1].date;
    const maxAge = cadence === "weekly" ? 16 : cadence === "biweekly" ? 32 : 70;
    if (daysBetween(today, last) > maxAge) continue;
    let next = step(last, cadence);
    let guard = 0;
    while (next <= today && guard++ < 60) next = step(next, cadence);
    out.push({ merchantKey: key, label: sorted[sorted.length - 1].label, amountCents: Math.round(amt), cadence, nextDate: next, occurrences: sorted.length });
  }
  return out.sort((a, b) => b.amountCents - a.amountCents);
}

function collectionProbability(daysPastDue: number): number {
  return daysPastDue <= 0 ? 0.93 : Math.max(0.35, 0.85 - 0.01 * daysPastDue);
}

export function projectCash(input: ForecastInput): ForecastResult {
  const { today, horizonDays: H } = input;
  const inflow = new Array<number>(H + 1).fill(0);
  const outflow = new Array<number>(H + 1).fill(0);
  const idx = (date: string) => daysBetween(date, today);

  for (const r of input.receivables) {
    if (r.balanceCents <= 0) continue;
    const pastDue = daysBetween(today, r.dueDate);
    const lag = Math.max(0, Math.min(45, r.customerKey && r.customerKey in input.customerLagDays ? input.customerLagDays[r.customerKey] : 8));
    let expected = addDays(r.dueDate, Math.round(lag));
    if (expected <= today) expected = addDays(today, 3 + Math.min(18, Math.floor(Math.max(0, pastDue) / 2)));
    const d = idx(expected);
    if (d >= 1 && d <= H) inflow[d] += Math.round(r.balanceCents * collectionProbability(pastDue));
  }

  for (const p of input.payables) {
    if (p.balanceCents <= 0) continue;
    const when = p.dueDate > today ? p.dueDate : addDays(today, 2);
    const d = idx(when);
    if (d >= 1 && d <= H) outflow[d] += p.balanceCents;
  }

  const coveredByBill = (merchantKey: string, date: string) =>
    input.payables.some((p) => p.vendorKey && (merchantKey.includes(p.vendorKey) || p.vendorKey.includes(merchantKey)) && Math.abs(daysBetween(date, p.dueDate)) <= 10);
  const coveredByFixed = (label: string) => input.fixed.some((f) => nameSimilarity(label, f.label) >= 0.6);

  for (const r of input.recurring) {
    if (coveredByFixed(r.label)) continue;
    let date = r.nextDate;
    let guard = 0;
    while (idx(date) <= H && guard++ < 60) {
      const d = idx(date);
      if (d >= 1 && !coveredByBill(r.merchantKey, date)) outflow[d] += r.amountCents;
      date = step(date, r.cadence);
    }
  }

  for (const f of input.fixed) {
    if (f.amountCents <= 0) continue;
    let date = f.nextDueDate;
    if (f.frequency === "one_time") {
      const d = Math.max(1, idx(date));
      if (d <= H) outflow[d] += f.amountCents;
      continue;
    }
    let guard = 0;
    while (idx(date) <= H && guard++ < 200) {
      const d = idx(date);
      if (d >= 1) outflow[d] += f.amountCents;
      date = step(date, f.frequency);
    }
  }

  const days: ForecastDay[] = [];
  let bal = input.startingBalanceCents;
  let bal2 = input.startingBalanceCents;
  let lowest = bal;
  let lowestDate = today;
  let runwayExpected: number | null = bal < input.thresholdCents ? 0 : null;
  let runwayNone: number | null = bal2 < input.thresholdCents ? 0 : null;
  let breachDate: string | null = bal < input.thresholdCents ? today : null;
  days.push({ date: today, balanceCents: bal, noCollectionsBalanceCents: bal2 });
  let totalIn = 0;
  let totalOut = 0;
  for (let d = 1; d <= H; d++) {
    bal += inflow[d] - outflow[d];
    bal2 -= outflow[d];
    totalIn += inflow[d];
    totalOut += outflow[d];
    const date = addDays(today, d);
    days.push({ date, balanceCents: bal, noCollectionsBalanceCents: bal2 });
    if (bal < lowest) { lowest = bal; lowestDate = date; }
    if (runwayExpected === null && bal < input.thresholdCents) { runwayExpected = d; breachDate = date; }
    if (runwayNone === null && bal2 < input.thresholdCents) runwayNone = d;
  }
  return {
    days, runwayDaysExpected: runwayExpected, runwayDaysNoCollections: runwayNone, breachDate,
    lowestBalanceCents: lowest, lowestDate, expectedInflowCents: totalIn, scheduledOutflowCents: totalOut,
  };
}
