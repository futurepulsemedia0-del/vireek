// src/lib/wallboard.ts
//
// Pure logic for the Dispatch Wallboard (TV mode). No React, no Supabase:
// everything here is unit-tested in wallboard.test.ts.

export const PANEL_KEYS = ['jobs', 'technicians', 'emergencies', 'calls', 'revenue'] as const;
export type WallboardPanelKey = (typeof PANEL_KEYS)[number];

export const PANEL_LABELS: Record<WallboardPanelKey, string> = {
  jobs: "Today's jobs",
  technicians: 'Technicians',
  emergencies: 'Open emergencies',
  calls: 'Missed calls',
  revenue: 'Revenue vs goal',
};

export const MIN_ROTATION_SECONDS = 8;
export const MAX_ROTATION_SECONDS = 120;
export const DEFAULT_ROTATION_SECONDS = 15;
/** Realtime nudges are coalesced; the poll is only the safety net for a dropped socket. */
export const POLL_INTERVAL_MS = 20_000;
export const NUDGE_DEBOUNCE_MS = 400;
/** Past this age without a successful refresh the TV says so instead of looking "live". */
export const STALE_AFTER_MS = 90_000;
const TOKEN_RE = /^[0-9a-f]{64}$/;

export type JobStatus = 'scheduled' | 'en_route' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
export type TechStatus = 'on_site' | 'en_route' | 'driving' | 'available' | 'offline';
export type EmergencySeverity = 'critical' | 'high' | 'standard';

export interface WallboardConfig {
  name: string;
  rotationSeconds: number;
  panels: WallboardPanelKey[];
  channelKey: string;
}

export interface JobCounts {
  scheduled: number;
  enRoute: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  late: number;
  total: number;
}

export interface WallJob {
  id: string;
  customer: string;
  service: string | null;
  scheduledAt: string | null;
  status: JobStatus;
  technician: string | null;
  late: boolean;
}

export interface WallTech {
  id: string;
  name: string;
  status: TechStatus;
  jobCustomer: string | null;
  jobService: string | null;
  lat: number | null;
  lng: number | null;
  place: string | null;
  speedMph: number;
  lastFixAt: string | null;
  completedToday: number;
}

export interface WallEmergency {
  id: string;
  severity: EmergencySeverity;
  status: string;
  trade: string;
  customer: string;
  technician: string | null;
  slaDueAt: string | null;
  createdAt: string | null;
  slaBreached: boolean;
}

export interface WallMissedCall {
  id: string;
  caller: string;
  at: string;
}

export interface WallCalls {
  totalToday: number;
  missedToday: number;
  emergencyToday: number;
  recentMissed: WallMissedCall[];
}

export interface WallRevenue {
  today: number;
  mtd: number;
  goal: number | null;
  dayOfMonth: number;
  daysInMonth: number;
  daily: Array<{ day: string; amount: number }>;
}

export interface WallboardSnapshot {
  generatedAt: string;
  timezone: string;
  config: WallboardConfig;
  jobCounts: JobCounts;
  jobs: WallJob[];
  technicians: WallTech[];
  emergencies: WallEmergency[];
  calls: WallCalls;
  revenue: WallRevenue;
}

// ---------------------------------------------------------------- parsing

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Postgres numeric arrives as a number or a numeric string depending on the driver. */
export function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
const numOrNull = (v: unknown): number | null => {
  const n = num(v, NaN);
  return Number.isFinite(n) ? n : null;
};

const JOB_STATUSES: readonly string[] = ['scheduled', 'en_route', 'in_progress', 'completed', 'cancelled', 'no_show'];
const TECH_STATUSES: readonly string[] = ['on_site', 'en_route', 'driving', 'available', 'offline'];
const SEVERITIES: readonly string[] = ['critical', 'high', 'standard'];

export function isValidWallboardToken(token: string | undefined | null): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

export function clampRotation(seconds: unknown): number {
  const n = Math.round(num(seconds, DEFAULT_ROTATION_SECONDS));
  return Math.min(MAX_ROTATION_SECONDS, Math.max(MIN_ROTATION_SECONDS, n));
}

export function normalizePanels(raw: unknown): WallboardPanelKey[] {
  const seen = new Set<WallboardPanelKey>();
  for (const p of arr(raw)) {
    if ((PANEL_KEYS as readonly unknown[]).includes(p)) seen.add(p as WallboardPanelKey);
  }
  // Keep the canonical order regardless of how the owner ticked the boxes.
  const ordered = PANEL_KEYS.filter((k) => seen.has(k));
  return ordered.length > 0 ? ordered : [...PANEL_KEYS];
}

/**
 * Defensive parse of the RPC payload. A TV runs unattended for weeks, so a
 * missing or odd field must degrade to an empty panel, never a crashed screen.
 * Returns null only when the payload is not a snapshot at all.
 */
export function parseSnapshot(raw: unknown): WallboardSnapshot | null {
  if (!isRec(raw) || !isRec(raw.config)) return null;
  const cfg = raw.config;
  const counts = isRec(raw.job_counts) ? raw.job_counts : {};
  const calls = isRec(raw.calls) ? raw.calls : {};
  const rev = isRec(raw.revenue) ? raw.revenue : {};

  const jobs: WallJob[] = arr(raw.jobs)
    .filter(isRec)
    .map((j) => ({
      id: str(j.id),
      customer: str(j.customer, 'Customer'),
      service: strOrNull(j.service),
      scheduledAt: strOrNull(j.scheduled_datetime),
      status: (JOB_STATUSES.includes(str(j.status)) ? str(j.status) : 'scheduled') as JobStatus,
      technician: strOrNull(j.technician),
      late: j.late === true,
    }));

  const technicians: WallTech[] = arr(raw.technicians)
    .filter(isRec)
    .map((t) => ({
      id: str(t.id),
      name: str(t.name, 'Technician'),
      status: (TECH_STATUSES.includes(str(t.status)) ? str(t.status) : 'offline') as TechStatus,
      jobCustomer: strOrNull(t.job_customer),
      jobService: strOrNull(t.job_service),
      lat: numOrNull(t.lat),
      lng: numOrNull(t.lng),
      place: strOrNull(t.place),
      speedMph: num(t.speed_mph),
      lastFixAt: strOrNull(t.last_fix_at),
      completedToday: num(t.completed_today),
    }));

  const emergencies: WallEmergency[] = arr(raw.emergencies)
    .filter(isRec)
    .map((e) => ({
      id: str(e.id),
      severity: (SEVERITIES.includes(str(e.severity)) ? str(e.severity) : 'standard') as EmergencySeverity,
      status: str(e.status),
      trade: str(e.trade, 'general'),
      customer: str(e.customer, 'Customer'),
      technician: strOrNull(e.technician),
      slaDueAt: strOrNull(e.sla_due_at),
      createdAt: strOrNull(e.created_at),
      slaBreached: e.sla_breached === true,
    }));

  return {
    generatedAt: str(raw.generated_at),
    timezone: str(raw.timezone, 'UTC'),
    config: {
      name: str(cfg.name, 'Dispatch'),
      rotationSeconds: clampRotation(cfg.rotation_seconds),
      panels: normalizePanels(cfg.panels),
      channelKey: str(cfg.channel_key),
    },
    jobCounts: {
      scheduled: num(counts.scheduled),
      enRoute: num(counts.en_route),
      inProgress: num(counts.in_progress),
      completed: num(counts.completed),
      cancelled: num(counts.cancelled),
      late: num(counts.late),
      total: num(counts.total),
    },
    jobs,
    technicians,
    emergencies,
    calls: {
      totalToday: num(calls.total_today),
      missedToday: num(calls.missed_today),
      emergencyToday: num(calls.emergency_today),
      recentMissed: arr(calls.recent_missed)
        .filter(isRec)
        .map((m) => ({ id: str(m.id), caller: str(m.caller, 'Unknown caller'), at: str(m.at) })),
    },
    revenue: {
      today: num(rev.today),
      mtd: num(rev.mtd),
      goal: numOrNull(rev.goal),
      dayOfMonth: Math.max(1, num(rev.day_of_month, 1)),
      daysInMonth: Math.max(1, num(rev.days_in_month, 30)),
      daily: arr(rev.daily)
        .filter(isRec)
        .map((d) => ({ day: str(d.day), amount: num(d.amount) })),
    },
  };
}

// --------------------------------------------------------------- rotation

export function countOpenEmergencies(s: Pick<WallboardSnapshot, 'emergencies'>): number {
  return s.emergencies.length;
}

export function hasCriticalEmergency(s: Pick<WallboardSnapshot, 'emergencies'>): boolean {
  return s.emergencies.some((e) => e.severity === 'critical' || e.slaBreached);
}

/**
 * Panels the rotation actually visits. An empty emergencies panel is skipped
 * (the always-visible KPI strip already shows "0") unless it is the only panel.
 */
export function activePanels(snapshot: WallboardSnapshot | null): WallboardPanelKey[] {
  if (!snapshot) return [...PANEL_KEYS];
  const configured = snapshot.config.panels;
  const filtered = configured.filter((p) => !(p === 'emergencies' && snapshot.emergencies.length === 0));
  return filtered.length > 0 ? filtered : configured;
}

/** Wrap-around stepping; safe for an empty list and for out-of-range indexes. */
export function stepIndex(current: number, length: number, direction: 1 | -1): number {
  if (length <= 0) return 0;
  const base = Number.isInteger(current) ? current : 0;
  return (((base + direction) % length) + length) % length;
}

/** Emergencies hold the screen longer, so a critical incident is never glanced past. */
export function dwellMs(panel: WallboardPanelKey, snapshot: WallboardSnapshot | null, rotationSeconds: number): number {
  const base = clampRotation(rotationSeconds) * 1000;
  return panel === 'emergencies' && snapshot && hasCriticalEmergency(snapshot) ? Math.round(base * 1.5) : base;
}

// ---------------------------------------------------------------- revenue

export type PaceStatus = 'no_goal' | 'ahead' | 'on_track' | 'behind';

export interface RevenuePace {
  goal: number | null;
  mtd: number;
  pctOfGoal: number;
  expectedToDate: number;
  paceDelta: number;
  dailyTarget: number;
  todayPct: number;
  status: PaceStatus;
}

export function revenuePace(r: WallRevenue): RevenuePace {
  const goal = r.goal !== null && r.goal > 0 ? r.goal : null;
  if (goal === null) {
    return { goal: null, mtd: r.mtd, pctOfGoal: 0, expectedToDate: 0, paceDelta: 0, dailyTarget: 0, todayPct: 0, status: 'no_goal' };
  }
  const dailyTarget = goal / r.daysInMonth;
  const expectedToDate = dailyTarget * Math.min(r.dayOfMonth, r.daysInMonth);
  const paceDelta = r.mtd - expectedToDate;
  const status: PaceStatus = r.mtd >= expectedToDate * 1.05 ? 'ahead' : r.mtd >= expectedToDate * 0.95 ? 'on_track' : 'behind';
  return {
    goal,
    mtd: r.mtd,
    pctOfGoal: Math.max(0, Math.round((r.mtd / goal) * 100)),
    expectedToDate,
    paceDelta,
    dailyTarget,
    todayPct: dailyTarget > 0 ? Math.max(0, Math.round((r.today / dailyTarget) * 100)) : 0,
    status,
  };
}

// ------------------------------------------------------------- formatting

export function formatMoney(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return `${v < 0 ? '-' : ''}$${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
}

export function formatMoneyCompact(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1000)}K`;
  return formatMoney(v);
}

export function safeTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

export function formatClock(nowMs: number, tz: string): { time: string; date: string } {
  const timeZone = safeTimeZone(tz);
  const d = new Date(nowMs);
  return {
    time: new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(d),
    date: new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone }).format(d),
  };
}

export function formatTimeOfDay(iso: string | null, tz: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: safeTimeZone(tz) }).format(new Date(t));
}

/** "just now", "5 min ago", "2 h ago". */
export function formatAge(iso: string | null, nowMs: number): string {
  if (!iso) return 'no signal';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'no signal';
  const min = Math.max(0, Math.floor((nowMs - t) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

/** Countdown to an SLA: "12 min left" / "5 min overdue". */
export function formatSla(dueIso: string | null, nowMs: number): { text: string; overdue: boolean } {
  if (!dueIso) return { text: 'No SLA', overdue: false };
  const due = Date.parse(dueIso);
  if (Number.isNaN(due)) return { text: 'No SLA', overdue: false };
  const min = Math.round((due - nowMs) / 60_000);
  const abs = Math.abs(min);
  const body = abs >= 60 ? `${Math.floor(abs / 60)} h ${abs % 60} min` : `${abs} min`;
  return min < 0 ? { text: `${body} overdue`, overdue: true } : { text: `${body} left`, overdue: false };
}

export function isStale(lastOkMs: number | null, nowMs: number): boolean {
  return lastOkMs === null || nowMs - lastOkMs > STALE_AFTER_MS;
}

// ---------------------------------------------------------------- display

export const TECH_STATUS_META: Record<TechStatus, { label: string; tone: 'success' | 'accent' | 'warning' | 'muted' }> = {
  on_site: { label: 'On site', tone: 'success' },
  en_route: { label: 'En route', tone: 'accent' },
  driving: { label: 'Driving', tone: 'accent' },
  available: { label: 'Available', tone: 'warning' },
  offline: { label: 'Offline', tone: 'muted' },
};

export const JOB_COLUMNS: ReadonlyArray<{ status: JobStatus; label: string }> = [
  { status: 'in_progress', label: 'In progress' },
  { status: 'en_route', label: 'En route' },
  { status: 'scheduled', label: 'Scheduled' },
  { status: 'completed', label: 'Completed' },
];

export function groupJobs(jobs: WallJob[], perColumn: number): Record<string, { items: WallJob[]; hidden: number }> {
  const out: Record<string, { items: WallJob[]; hidden: number }> = {};
  for (const col of JOB_COLUMNS) {
    const all = jobs.filter((j) => j.status === col.status);
    out[col.status] = { items: all.slice(0, Math.max(0, perColumn)), hidden: Math.max(0, all.length - perColumn) };
  }
  return out;
}

export interface ProjectedPoint {
  id: string;
  x: number;
  y: number;
}

/**
 * Fits technician coordinates into a width x height box (equirectangular,
 * longitude scaled by cos(latitude) so shapes are not stretched). A single
 * point, or identical points, is centred instead of dividing by zero.
 */
export function projectPoints(
  points: Array<{ id: string; lat: number; lng: number }>,
  width: number,
  height: number,
  pad = 24,
): ProjectedPoint[] {
  const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180);
  if (valid.length === 0) return [];
  const meanLat = valid.reduce((s, p) => s + p.lat, 0) / valid.length;
  const k = Math.max(0.1, Math.cos((meanLat * Math.PI) / 180));
  const xs = valid.map((p) => p.lng * k);
  const ys = valid.map((p) => -p.lat); // north is up
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  if (spanX === 0 && spanY === 0) return valid.map((p) => ({ id: p.id, x: width / 2, y: height / 2 }));
  const scale = Math.min(spanX === 0 ? Infinity : innerW / spanX, spanY === 0 ? Infinity : innerH / spanY);
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  return valid.map((p, i) => ({ id: p.id, x: offX + (xs[i] - minX) * scale, y: offY + (ys[i] - minY) * scale }));
}

export function buildWallboardUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/wallboard/${token}`;
}
