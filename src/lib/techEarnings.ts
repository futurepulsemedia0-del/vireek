// src/lib/techEarnings.ts
// Technician-side earnings: wages, commissions and tips per pay period.
// Server side: get_my_earnings() / get_my_earnings_detail() in 20270410000100_tech_earnings.sql.
// Those RPCs only ever return the signed-in technician's own pay.
//
// Everything above the "Server" banner is pure and unit-tested.

import { supabase } from '@/lib/supabase';
import type { PaySchedule, PayType } from '@/lib/payroll';

export { formatCents } from '@/lib/payroll';

// ============================================================
// TYPES
// ============================================================

export interface EarningsEmployee {
  id: string;
  full_name: string;
  pay_type: PayType;
  pay_schedule: PaySchedule;
  commission_rate_percent: number;
  employment_type: 'w2' | '1099';
}

/** Everything earned since the last finalized pay run. An estimate until payroll runs. */
export interface CurrentPeriod {
  /** First day not covered by a finalized pay run, or null when there has never been one. */
  since: string | null;
  regular_hours: number;
  overtime_hours: number;
  pending_timesheets: number;
  regular_pay_cents: number;
  overtime_pay_cents: number;
  salary_pay_cents: number;
  commission_cents: number;
  commission_count: number;
  tips_cents: number;
}

export interface PastPeriod {
  pay_run_id: string;
  item_id: string;
  pay_period_start: string;
  pay_period_end: string;
  pay_date: string;
  status: 'approved' | 'paid';
  regular_hours: number;
  overtime_hours: number;
  regular_pay_cents: number;
  overtime_pay_cents: number;
  salary_pay_cents: number;
  commission_cents: number;
  bonus_cents: number;
  gross_pay_cents: number;
  tax_withholding_cents: number;
  other_deductions_cents: number;
  net_pay_cents: number;
  paid_at: string | null;
  tips_cents: number;
}

export interface EarningsSummary {
  employee: EarningsEmployee;
  current: CurrentPeriod;
  periods: PastPeriod[];
  /** ISO timestamp from the server. */
  generated_at: string;
}

export interface CommissionLine {
  id: string;
  job_id: string | null;
  customer_name: string | null;
  service_type: string | null;
  basis_amount_cents: number;
  commission_rate_percent: number;
  commission_cents: number;
  status: string;
  created_at: string;
}

export interface HoursLine {
  id: string;
  work_date: string;
  regular_hours: number;
  overtime_hours: number;
  status: string;
  customer_name: string | null;
}

export interface TipLine {
  id: string;
  amount_cents: number;
  source: string;
  note: string | null;
  received_at: string;
  customer_name: string | null;
}

export interface EarningsDetail {
  commissions: CommissionLine[];
  timesheets: HoursLine[];
  tips: TipLine[];
}

export type EarningsBlock = 'not_a_technician' | 'no_pay_profile';
export type EarningsResult =
  | { ok: true; data: EarningsSummary }
  | { ok: false; reason: EarningsBlock | 'network' | 'error'; message: string };
export type DetailResult =
  | { ok: true; data: EarningsDetail }
  | { ok: false; reason: 'not_found' | 'network' | 'error'; message: string };

// ============================================================
// PURE HELPERS
// ============================================================

export const currentWagesCents = (c: CurrentPeriod): number => c.regular_pay_cents + c.overtime_pay_cents + c.salary_pay_cents;

/** Wages + commission + tips, before any tax. */
export const currentTotalCents = (c: CurrentPeriod): number => currentWagesCents(c) + c.commission_cents + c.tips_cents;

export const periodWagesCents = (p: PastPeriod): number => p.regular_pay_cents + p.overtime_pay_cents + p.salary_pay_cents + p.bonus_cents;

/** Everything earned in the period, before tax: gross pay plus tips (tips are paid outside payroll). */
export const periodTotalCents = (p: PastPeriod): number => p.gross_pay_cents + p.tips_cents;

/** What actually lands with the technician: net pay after withholding, plus tips. */
export const periodTakeHomeCents = (p: PastPeriod): number => p.net_pay_cents + p.tips_cents;

export interface MixPart {
  key: 'wages' | 'commission' | 'tips';
  label: string;
  cents: number;
  /** Share of the total, 0-100, rounded so the parts always add up to exactly 100 (or all 0). */
  percent: number;
}

/** Largest-remainder rounding, so the stacked bar never ends at 99% or 101%. */
export function earningsMix(wages: number, commission: number, tips: number): MixPart[] {
  const parts: Omit<MixPart, 'percent'>[] = [
    { key: 'wages', label: 'Wages', cents: Math.max(wages, 0) },
    { key: 'commission', label: 'Commission', cents: Math.max(commission, 0) },
    { key: 'tips', label: 'Tips', cents: Math.max(tips, 0) },
  ];
  const total = parts.reduce((s, p) => s + p.cents, 0);
  if (total === 0) return parts.map((p) => ({ ...p, percent: 0 }));
  const raw = parts.map((p) => (p.cents / total) * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((s, n) => s + n, 0);
  const order = raw.map((r, i) => ({ i, rem: r - floors[i] })).sort((a, b) => b.rem - a.rem);
  for (const { i } of order) {
    if (left <= 0) break;
    if (parts[i].cents > 0) {
      floors[i] += 1;
      left -= 1;
    }
  }
  return parts.map((p, i) => ({ ...p, percent: floors[i] }));
}

/** 'YYYY-MM-DD' -> "Sep 14", never shifted by the device time zone. */
export function formatDay(iso: string | null | undefined, withYear = false): string {
  if (!iso) return '—';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}

export function periodLabel(start: string, end: string): string {
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${formatDay(start, !sameYear)} – ${formatDay(end, true)}`;
}

/** A timestamp as a short local date ("Oct 2"). */
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export const formatHours = (h: number): string => `${Number.isInteger(h) ? h : h.toFixed(1)} h`;

export interface TrendBar {
  id: string; // item_id, or 'current'
  label: string;
  cents: number;
  /** 0-100 relative to the tallest bar; at least 6 so a small value is still visible. */
  height: number;
  current: boolean;
}

/** Oldest → newest, with the running (estimated) period last. */
export function buildTrend(summary: EarningsSummary, max = 6): TrendBar[] {
  const past = [...summary.periods].slice(0, max).reverse();
  const bars = [
    ...past.map((p) => ({ id: p.item_id, label: formatDay(p.pay_period_end), cents: periodTotalCents(p), current: false })),
    { id: 'current', label: 'Now', cents: currentTotalCents(summary.current), current: true },
  ];
  const top = Math.max(...bars.map((b) => b.cents), 1);
  return bars.map((b) => ({ ...b, height: b.cents > 0 ? Math.max(Math.round((b.cents / top) * 100), 6) : 0 }));
}

export function describePayType(e: EarningsEmployee): string {
  switch (e.pay_type) {
    case 'hourly':
      return 'Hourly';
    case 'salary':
      return 'Salary';
    case 'commission_only':
      return `Commission only${e.commission_rate_percent > 0 ? ` · ${e.commission_rate_percent}%` : ''}`;
    default:
      return `Salary + commission${e.commission_rate_percent > 0 ? ` · ${e.commission_rate_percent}%` : ''}`;
  }
}

export const TIP_SOURCE_LABELS: Record<string, string> = { cash: 'Cash', card: 'Card', invoice: 'On invoice', other: 'Other' };

export function formatAgo(from: number | null, now = Date.now()): string {
  if (from === null) return 'never';
  const s = Math.max(Math.round((now - from) / 1000), 0);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function isNetworkError(message: string): boolean {
  return /failed to fetch|networkerror|network request|load failed|timed? ?out|offline|fetch|abort/i.test(message);
}

// ------------------------------------------------------------
// Parsing: server data is untrusted until normalized
// ------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const cents = (v: unknown): number => Math.round(num(v));
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);

const PAY_TYPES: PayType[] = ['hourly', 'salary', 'commission_only', 'salary_plus_commission'];
const SCHEDULES: PaySchedule[] = ['weekly', 'biweekly', 'semimonthly', 'monthly'];

export function parseSummary(raw: unknown): EarningsSummary | null {
  if (!isRec(raw) || !isRec(raw.employee) || !isRec(raw.current)) return null;
  const e = raw.employee;
  const id = str(e.id);
  const name = str(e.full_name);
  if (!id || !name) return null;
  const payType = PAY_TYPES.includes(e.pay_type as PayType) ? (e.pay_type as PayType) : 'hourly';
  const schedule = SCHEDULES.includes(e.pay_schedule as PaySchedule) ? (e.pay_schedule as PaySchedule) : 'biweekly';
  const c = raw.current;

  const periods: PastPeriod[] = [];
  for (const p of recs(raw.periods)) {
    const itemId = str(p.item_id);
    const runId = str(p.pay_run_id);
    const start = str(p.pay_period_start);
    const end = str(p.pay_period_end);
    if (!itemId || !runId || !start || !end) continue;
    periods.push({
      pay_run_id: runId,
      item_id: itemId,
      pay_period_start: start.slice(0, 10),
      pay_period_end: end.slice(0, 10),
      pay_date: (str(p.pay_date) ?? end).slice(0, 10),
      status: p.status === 'paid' ? 'paid' : 'approved',
      regular_hours: num(p.regular_hours),
      overtime_hours: num(p.overtime_hours),
      regular_pay_cents: cents(p.regular_pay_cents),
      overtime_pay_cents: cents(p.overtime_pay_cents),
      salary_pay_cents: cents(p.salary_pay_cents),
      commission_cents: cents(p.commission_cents),
      bonus_cents: cents(p.bonus_cents),
      gross_pay_cents: cents(p.gross_pay_cents),
      tax_withholding_cents: cents(p.tax_withholding_cents),
      other_deductions_cents: cents(p.other_deductions_cents),
      net_pay_cents: cents(p.net_pay_cents),
      paid_at: str(p.paid_at),
      tips_cents: cents(p.tips_cents),
    });
  }

  return {
    employee: {
      id,
      full_name: name,
      pay_type: payType,
      pay_schedule: schedule,
      commission_rate_percent: num(e.commission_rate_percent),
      employment_type: e.employment_type === '1099' ? '1099' : 'w2',
    },
    current: {
      since: str(c.since)?.slice(0, 10) ?? null,
      regular_hours: num(c.regular_hours),
      overtime_hours: num(c.overtime_hours),
      pending_timesheets: Math.max(Math.trunc(num(c.pending_timesheets)), 0),
      regular_pay_cents: cents(c.regular_pay_cents),
      overtime_pay_cents: cents(c.overtime_pay_cents),
      salary_pay_cents: cents(c.salary_pay_cents),
      commission_cents: cents(c.commission_cents),
      commission_count: Math.max(Math.trunc(num(c.commission_count)), 0),
      tips_cents: cents(c.tips_cents),
    },
    periods,
    generated_at: str(raw.generated_at) ?? new Date().toISOString(),
  };
}

export function parseDetail(raw: unknown): EarningsDetail | null {
  if (!isRec(raw)) return null;
  return {
    commissions: recs(raw.commissions).flatMap((r) => {
      const id = str(r.id);
      return id
        ? [{
            id,
            job_id: str(r.job_id),
            customer_name: str(r.customer_name),
            service_type: str(r.service_type),
            basis_amount_cents: cents(r.basis_amount_cents),
            commission_rate_percent: num(r.commission_rate_percent),
            commission_cents: cents(r.commission_cents),
            status: str(r.status) ?? 'approved',
            created_at: str(r.created_at) ?? '',
          }]
        : [];
    }),
    timesheets: recs(raw.timesheets).flatMap((r) => {
      const id = str(r.id);
      const day = str(r.work_date);
      return id && day
        ? [{ id, work_date: day.slice(0, 10), regular_hours: num(r.regular_hours), overtime_hours: num(r.overtime_hours), status: str(r.status) ?? 'approved', customer_name: str(r.customer_name) }]
        : [];
    }),
    tips: recs(raw.tips).flatMap((r) => {
      const id = str(r.id);
      return id
        ? [{ id, amount_cents: cents(r.amount_cents), source: str(r.source) ?? 'other', note: str(r.note), received_at: str(r.received_at) ?? '', customer_name: str(r.customer_name) }]
        : [];
    }),
  };
}

// ------------------------------------------------------------
// Device cache (last good summary, per user) so the screen opens with no signal
// ------------------------------------------------------------

const CACHE_KEY = (userId: string) => `vk:tech-earnings:v1:${userId}`;

export function loadCachedEarnings(userId: string): EarningsSummary | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY(userId));
    return raw ? parseSummary(JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

export function saveCachedEarnings(userId: string, summary: EarningsSummary): void {
  try {
    window.localStorage.setItem(CACHE_KEY(userId), JSON.stringify(summary));
  } catch {
    /* storage full or blocked: the screen still works from memory */
  }
}

// ============================================================
// Server — network calls
// ============================================================

export async function fetchEarnings(limit = 12): Promise<EarningsResult> {
  try {
    const { data, error } = await supabase.rpc('get_my_earnings', { p_limit: limit });
    if (error) return { ok: false, reason: isNetworkError(error.message) ? 'network' : 'error', message: error.message };
    const blocked = (data as { error?: string } | null)?.error;
    if (blocked === 'not_a_technician' || blocked === 'no_pay_profile') return { ok: false, reason: blocked, message: blocked };
    const parsed = parseSummary(data);
    return parsed ? { ok: true, data: parsed } : { ok: false, reason: 'error', message: 'The server sent earnings data this app could not read.' };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not load earnings.';
    return { ok: false, reason: isNetworkError(message) ? 'network' : 'error', message };
  }
}

/** itemId null = the current (not yet paid) period. */
export async function fetchEarningsDetail(itemId: string | null): Promise<DetailResult> {
  try {
    const { data, error } = await supabase.rpc('get_my_earnings_detail', { p_item_id: itemId });
    if (error) return { ok: false, reason: isNetworkError(error.message) ? 'network' : 'error', message: error.message };
    if ((data as { error?: string } | null)?.error === 'not_found') return { ok: false, reason: 'not_found', message: 'That pay period is no longer available.' };
    const parsed = parseDetail(data);
    return parsed ? { ok: true, data: parsed } : { ok: false, reason: 'error', message: 'The server sent details this app could not read.' };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not load details.';
    return { ok: false, reason: isNetworkError(message) ? 'network' : 'error', message };
  }
}
