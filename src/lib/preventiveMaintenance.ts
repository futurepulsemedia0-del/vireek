/**
 * Preventive Maintenance Command Center - pure domain logic (no I/O, fully unit-tested).
 *
 * Nothing here re-implements detection that already exists. It COMBINES signals from:
 *   - equipment (service interval + last service / install date)  -> overdue / upcoming
 *   - equipmentPassport.warrantyState                             -> warranty
 *   - commercial_contracts (live maintenance contracts)           -> contract
 *   - equipment_maintenance_alerts (Equipment Lifecycle)          -> high_risk / context
 *   - pfn_forecasts (Predictive Failure Network)                  -> high_risk
 *   - seasonal tune-up windows by equipment family                -> seasonal
 * and then recommends technician (reusing dispatch.suggestTechnicians), parts (service_part_kits +
 * live parts_availability), a visit date, and a customer notification (server-side template).
 *
 * Server counterparts: supabase/migrations/20271001000000_preventive_maintenance_command_center.sql
 *                      supabase/functions/pm-notify-customer
 */

import { warrantyState } from '@/lib/equipmentPassport';
import { suggestTechnicians, type DispatchSuggestion } from '@/lib/dispatch';
import type { Job, TeamMember } from '@/lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PmSignalKind = 'overdue' | 'upcoming' | 'contract' | 'warranty' | 'seasonal' | 'high_risk';
export type PmPriority = 'critical' | 'high' | 'medium' | 'low';
export type PmItemStatus = 'planned' | 'scheduled' | 'notified' | 'completed' | 'dismissed' | 'snoozed';
export type PmPartsStatus = 'none' | 'reserved' | 'partial' | 'backordered';
export type PmHemisphere = 'north' | 'south';

export interface PmSettings {
  due_soon_days: number;
  risk_threshold: number;
  seasonal_enabled: boolean;
  hemisphere: PmHemisphere;
  default_visit_minutes: number;
}

export const PM_DEFAULT_SETTINGS: PmSettings = {
  due_soon_days: 45,
  risk_threshold: 0.35,
  seasonal_enabled: true,
  hemisphere: 'north',
  default_visit_minutes: 60,
};

export interface PmEquipment {
  id: string;
  customer_id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  install_date: string | null;
  warranty_expires_at: string | null;
  expected_lifespan_years: number;
  service_interval_months: number;
  last_service_date: string | null;
}

export interface PmCustomer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  customer_type: 'residential' | 'commercial';
}

export interface PmLifecycleAlert {
  id: string;
  equipment_id: string;
  risk_level: 'low' | 'medium' | 'high';
  predicted_issue: string;
  recommended_action: string | null;
  predicted_service_due: string | null;
}

export interface PmForecast {
  id: string;
  equipment_id: string;
  probability: number;
  band: 'critical' | 'high' | 'elevated' | 'low';
  top_mode_label: string | null;
  horizon_days: number;
  status: 'open' | 'handed_off';
  exposure_cents: number;
  recommended: { label: string; parts: string[]; estMinutes: number } | null;
}

export interface PmContract {
  id: string;
  customer_id: string | null;
  contract_name: string;
  contract_type: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
}

export interface PmWorkItem {
  id: string;
  equipment_id: string;
  status: PmItemStatus;
  signals: PmSignalKind[];
  priority_score: number;
  due_by: string | null;
  snoozed_until: string | null;
  job_id: string | null;
  technician_id: string | null;
  scheduled_at: string | null;
  assignment_status: string | null;
  parts_status: PmPartsStatus;
  parts_detail: { part_id: string; location_id: string; quantity: number; status: 'reserved' | 'backordered' }[];
  notified_at: string | null;
  notified_channel: 'sms' | 'email' | null;
  notify_error: string | null;
  completed_at: string | null;
  dismissed_at: string | null;
}

export interface PmSignal {
  kind: PmSignalKind;
  label: string;
  detail: string;
  weight: number;
  deadline: string | null;
}

export interface PmCandidate {
  equipmentId: string;
  equipment: PmEquipment;
  customer: PmCustomer | null;
  label: string;
  signals: PmSignal[];
  context: string[];
  dataGaps: string[];
  score: number;
  priority: PmPriority;
  nextDue: string | null;
  daysToDue: number | null;
  deadline: string | null;
  forecast: PmForecast | null;
  workItem: PmWorkItem | null;
  serviceType: string;
  visitMinutes: number;
  recommendedDate: string;
}

export interface PmInput {
  equipment: PmEquipment[];
  customers: PmCustomer[];
  alerts: PmLifecycleAlert[];
  forecasts: PmForecast[];
  contracts: PmContract[];
  workItems: PmWorkItem[];
  settings: PmSettings;
  now?: Date;
}

// ─── Labels ───────────────────────────────────────────────────────────────────

export const SIGNAL_LABEL: Record<PmSignalKind, string> = {
  overdue: 'Overdue',
  upcoming: 'Due soon',
  contract: 'Contract-required',
  warranty: 'Warranty',
  seasonal: 'Seasonal',
  high_risk: 'High risk',
};

export const PRIORITY_LABEL: Record<PmPriority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const DISMISS_SUPPRESS_DAYS = 90;
const SEASON_COVERED_DAYS = 150;
const DAY_MS = 86_400_000;

// ─── Date helpers (UTC day arithmetic: immune to DST shifts) ───────────────────

export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

function dayNumber(iso: string): number | null {
  const p = parseIso(iso);
  return p ? Math.floor(Date.UTC(p.y, p.m - 1, p.d) / DAY_MS) : null;
}

function fromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier). Null on unparseable input. */
export function daysBetween(fromIso: string, toIso: string): number | null {
  const a = dayNumber(fromIso);
  const b = dayNumber(toIso);
  return a === null || b === null ? null : b - a;
}

export function addDaysIso(iso: string, days: number): string {
  const n = dayNumber(iso);
  return n === null ? iso : fromDayNumber(n + days);
}

/** Month arithmetic that clamps to the last day of the target month (Jan 31 + 1 month = Feb 28/29). */
export function addMonthsIso(iso: string, months: number): string | null {
  const p = parseIso(iso);
  if (!p) return null;
  const total = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12 + 12) % 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = Math.min(p.d, lastDay);
  return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
}

function nextWeekday(iso: string): string {
  const n = dayNumber(iso);
  if (n === null) return iso;
  const dow = new Date(n * DAY_MS).getUTCDay(); // 0 Sun .. 6 Sat
  if (dow === 6) return fromDayNumber(n + 2);
  if (dow === 0) return fromDayNumber(n + 1);
  return iso;
}

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const p = parseIso(iso);
  if (!p) return '—';
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export function normalizeSettings(raw: Partial<PmSettings> | null | undefined): PmSettings {
  const d = PM_DEFAULT_SETTINGS;
  if (!raw) return { ...d };
  const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  return {
    due_soon_days: Math.round(clamp(raw.due_soon_days, 7, 180, d.due_soon_days)),
    risk_threshold: clamp(raw.risk_threshold, 0.05, 0.95, d.risk_threshold),
    seasonal_enabled: raw.seasonal_enabled ?? d.seasonal_enabled,
    hemisphere: raw.hemisphere === 'south' ? 'south' : 'north',
    default_visit_minutes: Math.round(clamp(raw.default_visit_minutes, 15, 480, d.default_visit_minutes)),
  };
}

// ─── Signal derivation ────────────────────────────────────────────────────────

export function equipmentLabel(e: Pick<PmEquipment, 'make' | 'model' | 'equipment_type'>): string {
  return [e.make, e.model].filter(Boolean).join(' ') || e.equipment_type;
}

/** Same rule the rest of the app uses: (last service, else install) + service interval. */
export function nextServiceDue(e: Pick<PmEquipment, 'last_service_date' | 'install_date' | 'service_interval_months'>): string | null {
  const base = e.last_service_date ?? e.install_date;
  if (!base || !(e.service_interval_months > 0)) return null;
  return addMonthsIso(base, e.service_interval_months);
}

type SeasonFamily = 'cooling' | 'heating' | 'both';

export function seasonFamily(equipmentType: string): SeasonFamily | null {
  const t = equipmentType.toLowerCase();
  const cooling = /\b(a\/?c|air.?condition\w*|condens\w*|chiller|cooling|mini.?split|split)\b/.test(t);
  const heating = /\b(furnace|boiler|heater|heating|radiant|fireplace)\b/.test(t) && !/water.?heater/.test(t);
  const both = /\b(hvac|heat.?pump|rooftop|rtu|package unit)\b/.test(t);
  if (both || (cooling && heating)) return 'both';
  if (cooling) return 'cooling';
  if (heating) return 'heating';
  return null;
}

/** Months (1-12) in which a pre-season tune-up should happen, per hemisphere. */
function seasonMonths(season: 'cooling' | 'heating', hemisphere: PmHemisphere): number[] {
  const northCooling = [3, 4, 5];
  const northHeating = [9, 10, 11];
  const north = season === 'cooling' ? northCooling : northHeating;
  return hemisphere === 'north' ? north : north.map((m) => ((m + 5) % 12) + 1);
}

export function seasonalNeed(
  e: Pick<PmEquipment, 'equipment_type' | 'last_service_date'>,
  today: string,
  hemisphere: PmHemisphere,
): { season: 'cooling' | 'heating'; windowEnd: string } | null {
  const family = seasonFamily(e.equipment_type);
  if (!family) return null;
  const p = parseIso(today);
  if (!p) return null;
  const seasons: ('cooling' | 'heating')[] = family === 'both' ? ['cooling', 'heating'] : [family];
  const active = seasons.find((s) => seasonMonths(s, hemisphere).includes(p.m));
  if (!active) return null;
  if (e.last_service_date) {
    const since = daysBetween(e.last_service_date, today);
    if (since !== null && since >= 0 && since < SEASON_COVERED_DAYS) return null; // already tuned up this season
  }
  const months = seasonMonths(active, hemisphere);
  const lastMonth = months[months.length - 1];
  // Window end = last day of the final window month, in the year it ends (handles southern-hemisphere wrap).
  const endYear = lastMonth >= p.m ? p.y : p.y + 1;
  const windowEnd = new Date(Date.UTC(endYear, lastMonth, 0)).toISOString().slice(0, 10);
  return { season: active, windowEnd };
}

function pctText(p: number): string {
  return `${Math.round(p * 100)}%`;
}

export function deriveSignals(
  e: PmEquipment,
  ctx: {
    today: string;
    now: Date;
    settings: PmSettings;
    alerts: PmLifecycleAlert[];
    forecast: PmForecast | null;
    contracts: PmContract[];
  },
): { signals: PmSignal[]; context: string[]; dataGaps: string[]; nextDue: string | null; daysToDue: number | null } {
  const signals: PmSignal[] = [];
  const context: string[] = [];
  const dataGaps: string[] = [];
  const { today, now, settings } = ctx;

  const nextDue = nextServiceDue(e);
  const daysToDue = nextDue ? daysBetween(today, nextDue) : null;
  if (nextDue === null) dataGaps.push('No install or last-service date, so the next service date cannot be computed.');

  const isOverdue = daysToDue !== null && daysToDue < 0;
  const isDueSoon = daysToDue !== null && daysToDue >= 0 && daysToDue <= settings.due_soon_days;

  if (isOverdue && nextDue && daysToDue !== null) {
    const late = -daysToDue;
    signals.push({
      kind: 'overdue',
      label: SIGNAL_LABEL.overdue,
      detail: `Service was due ${formatDay(nextDue)} (${late} day${late === 1 ? '' : 's'} overdue).`,
      weight: 40 + Math.min(20, Math.floor(late / 5)),
      deadline: nextDue,
    });
  } else if (isDueSoon && nextDue && daysToDue !== null) {
    signals.push({
      kind: 'upcoming',
      label: SIGNAL_LABEL.upcoming,
      detail: `Service due ${formatDay(nextDue)} (in ${daysToDue} day${daysToDue === 1 ? '' : 's'}).`,
      weight: 10 + Math.round(10 * (1 - daysToDue / Math.max(1, settings.due_soon_days))),
      deadline: nextDue,
    });
  }

  // Warranty: reuse the passport's own state machine (expiring = within 90 days).
  const w = warrantyState(e.warranty_expires_at, now);
  if (w.state === 'expiring' && w.daysLeft !== null && e.warranty_expires_at) {
    signals.push({
      kind: 'warranty',
      label: SIGNAL_LABEL.warranty,
      detail: `Warranty ends in ${w.daysLeft} day${w.daysLeft === 1 ? '' : 's'}. Inspect and document condition while coverage still applies.`,
      weight: 25 + (w.daysLeft <= 30 ? 10 : 0),
      deadline: e.warranty_expires_at.slice(0, 10),
    });
  } else if (w.state === 'active' && isOverdue) {
    signals.push({
      kind: 'warranty',
      label: SIGNAL_LABEL.warranty,
      detail: 'Under warranty with overdue service. Skipped maintenance can void manufacturer coverage.',
      weight: 22,
      deadline: null,
    });
  }

  // Contract: a live maintenance contract that this unit's customer holds.
  const contract = ctx.contracts.find(
    (c) =>
      c.customer_id === e.customer_id &&
      c.contract_type === 'maintenance_contract' &&
      (c.status === 'active' || c.status === 'expiring_soon') &&
      (!c.end_date || (daysBetween(today, c.end_date) ?? 0) >= 0),
  );
  if (contract) {
    const servicedInTerm =
      !!e.last_service_date && (!contract.start_date || e.last_service_date >= contract.start_date);
    const toEnd = contract.end_date ? daysBetween(today, contract.end_date) : null;
    if (!servicedInTerm) {
      signals.push({
        kind: 'contract',
        label: SIGNAL_LABEL.contract,
        detail: `Visit owed under "${contract.contract_name}"${contract.end_date ? ` before ${formatDay(contract.end_date)}` : ''}; no service logged this term.`,
        weight: 30 + (toEnd !== null && toEnd <= 60 ? 15 : 0),
        deadline: contract.end_date,
      });
    } else if (isOverdue || isDueSoon) {
      signals.push({
        kind: 'contract',
        label: SIGNAL_LABEL.contract,
        detail: `Covered by "${contract.contract_name}". Keeping service on time protects the SLA.`,
        weight: 18,
        deadline: null,
      });
    }
  }

  if (settings.seasonal_enabled) {
    const s = seasonalNeed(e, today, settings.hemisphere);
    if (s) {
      signals.push({
        kind: 'seasonal',
        label: SIGNAL_LABEL.seasonal,
        detail: `Pre-${s.season} tune-up window is open (through ${formatDay(s.windowEnd)}).`,
        weight: 15,
        deadline: s.windowEnd,
      });
    }
  }

  const f = ctx.forecast;
  if (f && (f.band === 'critical' || f.band === 'high' || f.probability >= settings.risk_threshold)) {
    signals.push({
      kind: 'high_risk',
      label: SIGNAL_LABEL.high_risk,
      detail: `${pctText(f.probability)} chance of ${f.top_mode_label ?? 'failure'} within ${f.horizon_days} days.`,
      weight: 20 + Math.round(f.probability * 30),
      deadline: null,
    });
  }

  for (const a of ctx.alerts) {
    if (a.risk_level === 'high') {
      signals.push({
        kind: 'high_risk',
        label: SIGNAL_LABEL.high_risk,
        detail: `Lifecycle risk: ${a.predicted_issue}`,
        weight: 28,
        deadline: a.predicted_service_due,
      });
    } else if (a.risk_level === 'medium') {
      context.push(`Lifecycle watch: ${a.predicted_issue}`);
    }
  }

  return { signals, context, dataGaps, nextDue, daysToDue };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/** Strongest signal counts fully; each further distinct signal kind adds half the previous share. */
export function scoreSignals(signals: PmSignal[]): number {
  const byKind = new Map<PmSignalKind, number>();
  for (const s of signals) byKind.set(s.kind, Math.max(byKind.get(s.kind) ?? 0, s.weight));
  const sorted = [...byKind.values()].sort((a, b) => b - a);
  let total = 0;
  let factor = 1;
  for (const w of sorted) {
    total += w * factor;
    factor /= 2;
  }
  return Math.min(100, Math.round(total));
}

export function priorityOf(score: number): PmPriority {
  if (score >= 75) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

export function recommendedVisitDate(
  c: Pick<PmCandidate, 'signals' | 'priority' | 'nextDue' | 'forecast'>,
  today: string,
): string {
  const earliest = nextWeekday(addDaysIso(today, 1));
  const deadlines = c.signals.map((s) => s.deadline).filter((d): d is string => !!d);
  const pastDeadline = deadlines.some((d) => (daysBetween(today, d) ?? 1) <= 0);
  if (c.priority === 'critical' || pastDeadline) return earliest;

  const caps: string[] = [];
  for (const d of deadlines) caps.push(addDaysIso(d, -7));
  if (c.forecast?.band === 'critical') caps.push(addDaysIso(today, 7));
  else if (c.forecast?.band === 'high') caps.push(addDaysIso(today, 14));

  let target = caps.length ? caps.reduce((a, b) => (a < b ? a : b)) : (c.nextDue ?? addDaysIso(today, 14));
  if (target < earliest) target = earliest;
  return nextWeekday(target);
}

// ─── Candidate assembly ───────────────────────────────────────────────────────

export function buildCandidates(input: PmInput): PmCandidate[] {
  const now = input.now ?? new Date();
  const today = todayIso(now);
  const settings = normalizeSettings(input.settings);

  const customers = new Map(input.customers.map((c) => [c.id, c]));
  const alertsByEq = new Map<string, PmLifecycleAlert[]>();
  for (const a of input.alerts) {
    const list = alertsByEq.get(a.equipment_id) ?? [];
    list.push(a);
    alertsByEq.set(a.equipment_id, list);
  }
  // Highest-probability live forecast per unit.
  const forecastByEq = new Map<string, PmForecast>();
  for (const f of input.forecasts) {
    const cur = forecastByEq.get(f.equipment_id);
    if (!cur || f.probability > cur.probability) forecastByEq.set(f.equipment_id, f);
  }
  // Active work item per unit (planned / scheduled / notified / snoozed) + most recent dismissal.
  const activeItem = new Map<string, PmWorkItem>();
  const dismissedAt = new Map<string, string>();
  for (const w of input.workItems) {
    if (w.status === 'dismissed' && w.dismissed_at) {
      const cur = dismissedAt.get(w.equipment_id);
      if (!cur || w.dismissed_at > cur) dismissedAt.set(w.equipment_id, w.dismissed_at);
    } else if (w.status !== 'completed' && w.status !== 'dismissed') {
      activeItem.set(w.equipment_id, w);
    }
  }

  const out: PmCandidate[] = [];
  for (const e of input.equipment) {
    const item = activeItem.get(e.id) ?? null;

    if (item?.status === 'snoozed' && item.snoozed_until && item.snoozed_until > today) continue;
    const dismissed = dismissedAt.get(e.id);
    if (dismissed && !item) {
      const age = daysBetween(dismissed.slice(0, 10), today);
      if (age !== null && age < DISMISS_SUPPRESS_DAYS) continue;
    }

    const forecast = forecastByEq.get(e.id) ?? null;
    const derived = deriveSignals(e, {
      today,
      now,
      settings,
      alerts: alertsByEq.get(e.id) ?? [],
      forecast,
      contracts: input.contracts,
    });

    const scheduled = item?.status === 'scheduled' || item?.status === 'notified';
    if (derived.signals.length === 0 && !scheduled) continue;

    const score = scoreSignals(derived.signals);
    const priority = priorityOf(score);
    const deadlines = derived.signals.map((s) => s.deadline).filter((d): d is string => !!d).sort();
    const partial = { signals: derived.signals, priority, nextDue: derived.nextDue, forecast };

    out.push({
      equipmentId: e.id,
      equipment: e,
      customer: customers.get(e.customer_id) ?? null,
      label: equipmentLabel(e),
      signals: derived.signals,
      context: derived.context,
      dataGaps: derived.dataGaps,
      score,
      priority,
      nextDue: derived.nextDue,
      daysToDue: derived.daysToDue,
      deadline: deadlines[0] ?? null,
      forecast,
      workItem: item,
      serviceType: `${e.equipment_type} Maintenance`,
      visitMinutes: forecast?.recommended?.estMinutes
        ? Math.round(Math.min(480, Math.max(15, forecast.recommended.estMinutes)))
        : settings.default_visit_minutes,
      recommendedDate: recommendedVisitDate(partial, today),
    });
  }

  return out.sort((a, b) => b.score - a.score || (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999'));
}

export interface PmSummary {
  total: number;
  scheduled: number;
  byKind: Record<PmSignalKind, number>;
  byPriority: Record<PmPriority, number>;
}

/** Counts for the queue only (items not yet scheduled). */
export function summarize(candidates: PmCandidate[]): PmSummary {
  const byKind: Record<PmSignalKind, number> = { overdue: 0, upcoming: 0, contract: 0, warranty: 0, seasonal: 0, high_risk: 0 };
  const byPriority: Record<PmPriority, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  let total = 0;
  let scheduled = 0;
  for (const c of candidates) {
    if (c.workItem && (c.workItem.status === 'scheduled' || c.workItem.status === 'notified')) {
      scheduled += 1;
      continue;
    }
    total += 1;
    byPriority[c.priority] += 1;
    for (const k of new Set(c.signals.map((s) => s.kind))) byKind[k] += 1;
  }
  return { total, scheduled, byKind, byPriority };
}

// ─── Technician recommendation (reuses dispatch.suggestTechnicians) ──────────────

export interface PmTechRank {
  technician: TeamMember;
  score: number;
  reasons: string[];
}

const SKILL_STOP = new Set(['and', 'the', 'unit', 'system', 'systems', 'service', 'repair', 'maintenance']);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !SKILL_STOP.has(t));
}

export function skillsCoverType(skills: string[], equipmentType: string): boolean {
  const typeTokens = tokens(equipmentType);
  if (!typeTokens.length) return false;
  return skills.some((s) => {
    const skillTokens = tokens(s);
    return skillTokens.some((st) => typeTokens.some((tt) => tt === st || tt.includes(st) || st.includes(tt)));
  });
}

export function rankTechnicians(args: {
  candidate: Pick<PmCandidate, 'equipment' | 'customer'>;
  scheduledAtIso: string;
  technicians: TeamMember[];
  jobsByTechnician: Record<string, Pick<Job, 'scheduled_datetime'>[]>;
  lastTechnicianId: string | null;
  kitOnTruck: Record<string, boolean>;
}): PmTechRank[] {
  const { candidate, technicians, jobsByTechnician, lastTechnicianId, kitOnTruck } = args;
  const job = {
    service_type: candidate.equipment.equipment_type,
    address: candidate.customer?.address ?? null,
    scheduled_datetime: args.scheduledAtIso,
  } as unknown as Job;

  const base = suggestTechnicians(job, technicians, jobsByTechnician as unknown as Record<string, Job[]>);
  return base
    .map(({ technician, score, reasons }: DispatchSuggestion): PmTechRank => {
      let s = score;
      let r = [...reasons];
      const exact = r.some((x) => x.startsWith('Skilled in'));
      if (!exact && skillsCoverType(technician.skills ?? [], candidate.equipment.equipment_type)) {
        s += 8;
        r = r.filter((x) => !x.startsWith('No listed skill match'));
        r.push(`Skills cover ${candidate.equipment.equipment_type}`);
      }
      if (lastTechnicianId && technician.id === lastTechnicianId) {
        s += 6;
        r.push('Serviced this unit before');
      }
      if (kitOnTruck[technician.id]) {
        s += 8;
        r.push('Maintenance kit on truck');
      }
      return { technician, score: s, reasons: r };
    })
    .sort((a, b) => b.score - a.score);
}

// ─── Parts plan (service_part_kits + live availability) ─────────────────────────

export interface PmKitLine {
  service_type: string;
  part_id: string;
  quantity: number;
}
export interface PmPart {
  id: string;
  name: string;
  part_number: string | null;
}
export interface PmStockRow {
  part_id: string;
  location_id: string;
  location_name: string;
  location_type: string;
  quantity_available: number;
}
export interface PmLocation {
  id: string;
  name: string;
  location_type: string;
  assigned_technician_id: string | null;
}
export type PmPartSource = 'on_truck' | 'warehouse' | 'other_location' | 'short';
export interface PmPartLine {
  part_id: string;
  part_name: string;
  part_number: string | null;
  quantity: number;
  location_id: string | null;
  location_name: string | null;
  source: PmPartSource;
  available: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const MAINT_WORDS = /\b(maint\w*|tune|service|inspect\w*|preventi\w*|pm|clean\w*|flush)\b/;

/** Which parts a maintenance visit on this unit needs: matching kits first, then forecast-recommended parts. */
export function wantedParts(args: {
  kits: PmKitLine[];
  parts: PmPart[];
  equipmentType: string;
  forecastPartNames: string[];
}): { part_id: string; quantity: number }[] {
  const type = norm(args.equipmentType);
  const wanted = new Map<string, number>();
  if (type.length >= 3) {
    for (const k of args.kits) {
      const kit = norm(k.service_type);
      const typeMatch = kit.includes(type) || (kit.length >= 3 && type.includes(kit));
      if (typeMatch && (kit === type || MAINT_WORDS.test(kit))) {
        wanted.set(k.part_id, Math.max(wanted.get(k.part_id) ?? 0, Math.max(1, k.quantity)));
      }
    }
  }
  for (const name of args.forecastPartNames) {
    const n = norm(name);
    if (n.length < 3) continue;
    const hit = args.parts.find((p) => {
      const pn = norm(p.name);
      return pn.includes(n) || n.includes(pn) || (!!p.part_number && norm(p.part_number) === n);
    });
    if (hit && !wanted.has(hit.id)) wanted.set(hit.id, 1);
  }
  return [...wanted.entries()].map(([part_id, quantity]) => ({ part_id, quantity }));
}

export function planParts(args: {
  wanted: { part_id: string; quantity: number }[];
  parts: PmPart[];
  stock: PmStockRow[];
  locations: PmLocation[];
  technicianId: string | null;
}): PmPartLine[] {
  const partById = new Map(args.parts.map((p) => [p.id, p]));
  const vanIds = new Set(
    args.locations
      .filter((l) => args.technicianId && l.assigned_technician_id === args.technicianId && l.location_type === 'van')
      .map((l) => l.id),
  );
  const fallbackWarehouse = args.locations.find((l) => l.location_type === 'warehouse') ?? args.locations[0] ?? null;
  const byMostAvailable = (a: PmStockRow, b: PmStockRow) => b.quantity_available - a.quantity_available;

  const lines: PmPartLine[] = [];
  for (const { part_id, quantity } of args.wanted) {
    const part = partById.get(part_id);
    if (!part) continue;

    const make = (source: PmPartSource, row: PmStockRow | null): PmPartLine => ({
      part_id,
      part_name: part.name,
      part_number: part.part_number,
      quantity,
      location_id: row?.location_id ?? fallbackWarehouse?.id ?? null,
      location_name: row?.location_name ?? fallbackWarehouse?.name ?? null,
      source,
      available: Math.max(0, row?.quantity_available ?? 0),
    });

    const rows = args.stock.filter((r) => r.part_id === part_id);
    const enough = rows.filter((r) => r.quantity_available >= quantity);

    const van = enough.find((r) => vanIds.has(r.location_id));
    if (van) {
      lines.push(make('on_truck', van));
      continue;
    }
    const warehouse = enough.filter((r) => r.location_type === 'warehouse').sort(byMostAvailable)[0];
    if (warehouse) {
      lines.push(make('warehouse', warehouse));
      continue;
    }
    // Stock exists, but on a truck or site that is not this technician's: needs a transfer.
    const other = [...enough].sort(byMostAvailable)[0];
    if (other) {
      lines.push(make('other_location', other));
      continue;
    }
    // Not enough anywhere: record the shortfall against the best-stocked location so it can be replenished.
    lines.push(make('short', [...rows].sort(byMostAvailable)[0] ?? null));
  }
  return lines;
}

/** Does this technician's van already hold every wanted part? (drives the "kit on truck" bonus). */
export function kitOnTruckByTechnician(args: {
  wanted: { part_id: string; quantity: number }[];
  stock: PmStockRow[];
  locations: PmLocation[];
}): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!args.wanted.length) return out;
  for (const loc of args.locations) {
    if (loc.location_type !== 'van' || !loc.assigned_technician_id) continue;
    const ok = args.wanted.every((w) =>
      args.stock.some((r) => r.location_id === loc.id && r.part_id === w.part_id && r.quantity_available >= w.quantity),
    );
    out[loc.assigned_technician_id] = (out[loc.assigned_technician_id] ?? false) || ok;
  }
  return out;
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

export function buildDispatchNote(c: Pick<PmCandidate, 'label' | 'signals' | 'forecast'>): string {
  const lines = [`Preventive maintenance: ${c.label}.`];
  for (const s of c.signals) lines.push(`- ${s.label}: ${s.detail}`);
  if (c.forecast?.recommended?.label) lines.push(`- Suggested work: ${c.forecast.recommended.label}.`);
  return lines.join('\n').slice(0, 1000);
}

const ERROR_COPY: Record<string, string> = {
  ALREADY_SCHEDULED: 'This unit already has an open maintenance visit.',
  INVALID_SCHEDULE: 'Pick a date and time that is not in the past.',
  INVALID_DURATION: 'Visit length must be between 15 and 720 minutes.',
  EQUIPMENT_NOT_FOUND: 'That unit no longer exists or is not in your account.',
  EQUIPMENT_INACTIVE: 'That unit is no longer active.',
  CUSTOMER_NOT_FOUND: 'This unit has no customer attached, so a job cannot be created.',
  TECHNICIAN_NOT_FOUND: 'That technician is not on your team.',
  NOT_AUTHENTICATED: 'Your session expired. Sign in again.',
};

export function describeScheduleError(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : '';
  const code = Object.keys(ERROR_COPY).find((k) => msg.includes(k));
  return code ? ERROR_COPY[code] : 'Could not schedule the visit. Please try again.';
}

export function describeAssignment(status: string | null | undefined): { ok: boolean; text: string } {
  switch (status) {
    case 'assigned':
      return { ok: true, text: 'Technician assigned.' };
    case 'at_capacity':
      return { ok: false, text: 'Job created, but that technician is at capacity that day. Reassign from Jobs.' };
    case 'blocked_compliance':
      return { ok: false, text: 'Job created, but the technician is missing a required credential. Reassign from Jobs.' };
    case 'no_technician_available':
      return { ok: false, text: 'Job created, but no technician is available that day. Assign one from Jobs.' };
    default:
      return { ok: false, text: 'Job created without a technician. Assign one from Jobs.' };
  }
}
