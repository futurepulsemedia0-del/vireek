/**
 * Commercial pack — SLA clock (PURE: no I/O, no Date.now(), no React, no Supabase).
 *
 * Counts only BUSINESS minutes: inside the calendar's weekly windows, in the calendar's IANA time
 * zone, excluding holidays and excluding paused periods. Every function takes `now` / instants as
 * arguments so it is fully deterministic and unit-tested (slaClock.test.ts).
 *
 * Limits (deliberate, documented):
 *  - A window never spans midnight; model an overnight shift as two windows (22:00–24:00 + 00:00–06:00).
 *  - Holidays are local calendar dates ("YYYY-MM-DD") in the calendar's own zone; the caller owns the list.
 *  - Times are tracked in milliseconds; results are returned in minutes (fractions allowed).
 */

export interface BusinessWindow {
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  /** Minutes after local midnight, 0–1440 */
  startMin: number;
  /** Minutes after local midnight, 1–1440 (1440 = end of day); must be > startMin */
  endMin: number;
}

export interface SlaCalendar {
  /** IANA zone, e.g. "America/New_York" */
  timeZone: string;
  windows: BusinessWindow[];
  /** Local dates (YYYY-MM-DD) with no business hours */
  holidays: string[];
}

export interface Pause {
  /** ISO instant the clock stopped */
  from: string;
  /** ISO instant it resumed; null/undefined = still paused */
  to?: string | null;
  reason?: string;
}

export const MINUTE_MS = 60_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_HORIZON_DAYS = 800;

/** Mon–Fri 08:00–17:00 */
export function standardBusinessWindows(): BusinessWindow[] {
  return [{ days: [1, 2, 3, 4, 5], startMin: 8 * 60, endMin: 17 * 60 }];
}

/** 24×7 calendar (emergency SLAs). */
export function twentyFourSeven(timeZone = 'UTC'): SlaCalendar {
  return { timeZone, windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }], holidays: [] };
}

/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Real calendar date check (round-trips, so "2027-02-30" is rejected rather than rolled over). */
function isRealDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

/** Human-readable problems; empty = valid. */
export function validateCalendar(cal: SlaCalendar): string[] {
  const errors: string[] = [];
  if (!cal || typeof cal.timeZone !== 'string' || !isValidTimeZone(cal.timeZone)) errors.push('Unknown time zone');
  if (!Array.isArray(cal?.windows) || cal.windows.length === 0) errors.push('At least one business window is required');
  for (const [i, w] of (cal?.windows ?? []).entries()) {
    const n = i + 1;
    if (!Array.isArray(w.days) || w.days.length === 0 || w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) errors.push(`Window ${n}: days must be 0–6`);
    if (!Number.isInteger(w.startMin) || !Number.isInteger(w.endMin) || w.startMin < 0 || w.endMin > 1440 || w.startMin >= w.endMin) {
      errors.push(`Window ${n}: start must be before end (0–1440 minutes)`);
    }
  }
  for (const h of cal?.holidays ?? []) if (!isRealDate(h)) errors.push(`Holiday "${h}" is not a valid YYYY-MM-DD date`);
  return errors;
}

/* ------------------------------------------------------------------ */
/* Time-zone helpers (Intl only — no external dependency)               */
/* ------------------------------------------------------------------ */

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Offset (ms) of `tz` from UTC at the given instant: local wall time − UTC. */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of dtf(tz).formatToParts(new Date(utcMs))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export interface LocalParts { dateKey: string; dow: number; minutes: number }

export function localParts(utcMs: number, tz: string): LocalParts {
  const local = new Date(utcMs + tzOffsetMs(utcMs, tz));
  const dateKey = local.toISOString().slice(0, 10);
  return { dateKey, dow: local.getUTCDay(), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

export function addDays(dateKey: string, n: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** UTC instant of local wall time `minutes` after midnight on `dateKey` (1440 = next midnight). */
export function localInstant(dateKey: string, minutes: number, tz: string): number {
  const day = minutes >= 1440 ? addDays(dateKey, 1) : dateKey;
  const mins = minutes >= 1440 ? 0 : minutes;
  const base = Date.parse(`${day}T00:00:00Z`) + mins * MINUTE_MS;
  const t1 = base - tzOffsetMs(base, tz);
  return base - tzOffsetMs(t1, tz);
}

/* ------------------------------------------------------------------ */
/* Intervals                                                            */
/* ------------------------------------------------------------------ */

type Interval = [number, number];

interface NormPause { from: number; to: number }

/** Sorts, drops invalid rows, merges overlaps. Open pauses end at Infinity. */
export function normalizePauses(pauses: Pause[] | undefined): NormPause[] {
  const list: NormPause[] = [];
  for (const p of pauses ?? []) {
    const from = Date.parse(p.from);
    const to = p.to == null ? Infinity : Date.parse(p.to);
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) continue;
    list.push({ from, to });
  }
  list.sort((a, b) => a.from - b.from);
  const merged: NormPause[] = [];
  for (const p of list) {
    const last = merged[merged.length - 1];
    if (last && p.from <= last.to) last.to = Math.max(last.to, p.to);
    else merged.push({ ...p });
  }
  return merged;
}

/** Caps each pause at `maxMinutes` of wall-clock time (a customer cannot stop the clock forever). */
export function capPauses(pauses: Pause[], maxMinutes: number | null | undefined, nowMs: number): Pause[] {
  if (!maxMinutes || maxMinutes <= 0) return pauses;
  return pauses.map((p) => {
    const from = Date.parse(p.from);
    if (Number.isNaN(from)) return p;
    const cap = from + maxMinutes * MINUTE_MS;
    const end = p.to == null ? nowMs : Date.parse(p.to);
    // An open pause that hit the cap is closed at the cap; a closed one is shortened if longer.
    if ((p.to == null && nowMs >= cap) || end > cap) return { ...p, to: new Date(cap).toISOString() };
    return p;
  });
}

function dayIntervals(dateKey: string, dow: number, cal: SlaCalendar, holidays: Set<string>): Interval[] {
  if (holidays.has(dateKey)) return [];
  const out: Interval[] = [];
  for (const w of cal.windows) {
    if (!w.days.includes(dow)) continue;
    const s = localInstant(dateKey, w.startMin, cal.timeZone);
    const e = localInstant(dateKey, w.endMin, cal.timeZone);
    if (e > s) out.push([s, e]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const iv of out) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged;
}

function subtractPauses(iv: Interval, pauses: NormPause[]): Interval[] {
  let pieces: Interval[] = [iv];
  for (const p of pauses) {
    if (p.to <= iv[0] || p.from >= iv[1]) continue;
    const next: Interval[] = [];
    for (const [s, e] of pieces) {
      if (p.to <= s || p.from >= e) { next.push([s, e]); continue; }
      if (p.from > s) next.push([s, p.from]);
      if (p.to < e) next.push([p.to, e]);
    }
    pieces = next;
  }
  return pieces;
}

/* Day-interval cache: computing a day needs several Intl calls, and sweeps evaluate thousands of timers
   against the same calendar. Keyed by calendar signature + date; bounded so it can never grow without limit. */
const DAY_CACHE_MAX = 20_000;
const dayCache = new Map<string, Interval[]>();

function calendarSignature(cal: SlaCalendar): string {
  return `${cal.timeZone}|${JSON.stringify(cal.windows)}|${[...cal.holidays].sort().join(',')}`;
}

function cachedDayIntervals(sig: string, dateKey: string, dow: number, cal: SlaCalendar, holidays: Set<string>): Interval[] {
  const key = `${sig}#${dateKey}`;
  const hit = dayCache.get(key);
  if (hit) return hit;
  const computed = dayIntervals(dateKey, dow, cal, holidays);
  if (dayCache.size >= DAY_CACHE_MAX) dayCache.clear();
  dayCache.set(key, computed);
  return computed;
}

/** Working intervals (ms, ascending) at/after `fromMs`, minus holidays and pauses. Stops at the horizon. */
export function* workIntervals(fromMs: number, cal: SlaCalendar, pauses: NormPause[] = [], horizonDays = DEFAULT_HORIZON_DAYS): Generator<Interval> {
  const holidays = new Set(cal.holidays);
  const sig = calendarSignature(cal);
  const openPauseFrom = pauses.find((p) => p.to === Infinity)?.from ?? Infinity;
  const start = localParts(fromMs, cal.timeZone);
  let dateKey = start.dateKey;
  let dow = start.dow;
  for (let i = 0; i < horizonDays; i++) {
    for (const raw of cachedDayIntervals(sig, dateKey, dow, cal, holidays)) {
      if (raw[1] <= fromMs) continue;
      const clipped: Interval = [Math.max(raw[0], fromMs), raw[1]];
      if (clipped[0] >= openPauseFrom) return; // paused forever from here on
      for (const piece of subtractPauses(clipped, pauses)) if (piece[1] > piece[0]) yield piece;
    }
    dateKey = addDays(dateKey, 1);
    dow = (dow + 1) % 7;
    if (openPauseFrom !== Infinity && localInstant(dateKey, 0, cal.timeZone) >= openPauseFrom) return;
  }
}

/* ------------------------------------------------------------------ */
/* Core arithmetic                                                      */
/* ------------------------------------------------------------------ */

/** Instant (ms) when `minutes` of business time have elapsed since `fromMs`; null if never within the horizon. */
export function addBusinessMinutes(fromMs: number, minutes: number, cal: SlaCalendar, pauses: Pause[] = []): number | null {
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError('minutes must be a non-negative number');
  let remaining = minutes * MINUTE_MS;
  if (remaining === 0) return fromMs;
  for (const [s, e] of workIntervals(fromMs, cal, normalizePauses(pauses))) {
    const len = e - s;
    if (len >= remaining) return s + remaining;
    remaining -= len;
  }
  return null;
}

/** Business minutes between two instants (paused time and non-business time excluded). */
export function businessMinutesBetween(fromMs: number, toMs: number, cal: SlaCalendar, pauses: Pause[] = []): number {
  if (toMs <= fromMs) return 0;
  let total = 0;
  for (const [s, e] of workIntervals(fromMs, cal, normalizePauses(pauses))) {
    if (s >= toMs) break;
    total += Math.min(e, toMs) - Math.max(s, fromMs);
  }
  return total / MINUTE_MS;
}

/* ------------------------------------------------------------------ */
/* Timer evaluation                                                     */
/* ------------------------------------------------------------------ */

export type TimerState = 'running' | 'at_risk' | 'paused' | 'breached' | 'met' | 'missed';

export interface TimerInput {
  startedAt: string;
  targetMinutes: number;
  calendar: SlaCalendar;
  pauses?: Pause[];
  /** Set when the response/resolution actually happened. */
  stoppedAt?: string | null;
  /** "At risk" once this share of the target has elapsed (default 80). */
  warnAtPct?: number;
}

export interface TimerEvaluation {
  state: TimerState;
  /** Deadline given pauses so far; null while an open pause makes it unknowable. */
  dueAt: string | null;
  elapsedMinutes: number;
  remainingMinutes: number;
  pctElapsed: number;
  /** Business minutes past the deadline (0 if not breached). */
  overByMinutes: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function evaluateTimer(input: TimerInput, nowIso: string): TimerEvaluation {
  const start = Date.parse(input.startedAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(start) || Number.isNaN(now)) throw new RangeError('Invalid timestamp');
  if (!(input.targetMinutes > 0)) throw new RangeError('targetMinutes must be positive');
  const warn = input.warnAtPct ?? 80;
  const pauses = input.pauses ?? [];
  const stop = input.stoppedAt ? Date.parse(input.stoppedAt) : null;
  const end = stop ?? now;

  const elapsed = businessMinutesBetween(start, Math.max(end, start), input.calendar, pauses);
  const pct = (elapsed / input.targetMinutes) * 100;
  const dueMs = addBusinessMinutes(start, input.targetMinutes, input.calendar, pauses);
  const remaining = Math.max(0, input.targetMinutes - elapsed);
  const over = Math.max(0, elapsed - input.targetMinutes);
  const base = {
    dueAt: dueMs == null ? null : new Date(dueMs).toISOString(),
    elapsedMinutes: round3(elapsed),
    remainingMinutes: round3(remaining),
    pctElapsed: round3(pct),
    overByMinutes: round3(over),
  };

  if (stop != null) return { ...base, state: elapsed <= input.targetMinutes + 1e-9 ? 'met' : 'missed' };
  if (elapsed > input.targetMinutes + 1e-9) return { ...base, state: 'breached' };
  const openPause = normalizePauses(pauses).some((p) => p.to === Infinity && p.from <= now);
  if (openPause) return { ...base, state: 'paused' };
  return { ...base, state: pct >= warn ? 'at_risk' : 'running' };
}

/* ------------------------------------------------------------------ */
/* Pause rules                                                          */
/* ------------------------------------------------------------------ */

export interface PauseRule {
  /** Job / ticket statuses during which the clock stops, e.g. "awaiting_customer". */
  pauseOnStatuses: string[];
  /** Safety cap on any single pause (wall-clock minutes); null = no cap. */
  maxPauseMinutes?: number | null;
}

/** Returns the pause list after a status change at `atIso` (never mutates; idempotent for repeated statuses). */
export function applyStatusChange(pauses: Pause[], rule: PauseRule, newStatus: string, atIso: string): Pause[] {
  const should = rule.pauseOnStatuses.includes(newStatus);
  const openIdx = pauses.findIndex((p) => p.to == null);
  if (should && openIdx === -1) return [...pauses, { from: atIso, to: null, reason: newStatus }];
  if (!should && openIdx !== -1) return pauses.map((p, i) => (i === openIdx ? { ...p, to: atIso } : p));
  return pauses;
}

/* ------------------------------------------------------------------ */
/* Escalation                                                           */
/* ------------------------------------------------------------------ */

export interface EscalationStep {
  /** Stable id; (timer, key) is unique so a step fires once. */
  key: string;
  /** Fires once this % of the target has elapsed. 100 = at breach; >100 = after breach. */
  atPct: number;
  notify: 'dispatcher' | 'manager' | 'owner';
}

/** Steps that are due and not yet fired, lowest threshold first. Never fires for paused/met timers. */
export function dueEscalations(ev: TimerEvaluation, steps: EscalationStep[], fired: ReadonlySet<string>): EscalationStep[] {
  if (ev.state === 'paused' || ev.state === 'met' || ev.state === 'missed') return [];
  return steps.filter((s) => ev.pctElapsed >= s.atPct && !fired.has(s.key)).sort((a, b) => a.atPct - b.atPct);
}
