// src/lib/hoursAudit.ts
//
// Free Hours-Leak Audit — Phase A engine. Pure, deterministic, no I/O: the whole
// analysis runs in the browser, so the uploaded file never leaves the device.
//
// Model (all figures are ESTIMATES derived from the file the owner supplied):
//   paid hours      = paidHoursPerDay for every technician-day that has at least one job
//   billable hours  = union of the billable job intervals of that technician-day
//   leaked hours    = max(0, paid − billable)
// Leaked hours are split, in this fixed order, into (Phase B refines these causes):
//   1. non-billable job time   2. drive (gaps up to the cap)   3. idle gap (rest of the gap)
//   4. unscheduled (start/end-of-day slack — whatever is left)
// Components are clipped to the leaked total, so they always add up exactly.
//
// A job belongs to the local calendar day it STARTS on (so overnight jobs and
// night shifts stay in one piece). Overlapping jobs are counted once (union) and
// reported. Rows that cannot be trusted are rejected with a row number and reason.

export const DEFAULT_HOURLY_COST = 84.4; // ACCA-cited truck-roll cost per hour (editable)
export const MAX_AUDIT_ROWS = 50_000;
export const MAX_REPORTED_ISSUES = 200;

export type DateOrder = 'mdy' | 'dmy';
export type MissingEndPolicy = 'skip' | 'median';
export type DurationUnit = 'minutes' | 'hours';

/** Column names from the uploaded file. '' = not mapped. */
export interface AuditMapping {
  technician: string;
  start: string;
  end: string;
  duration: string;
  durationUnit: DurationUnit;
  billable: string;
}

export interface AuditSettings {
  timeZone: string;
  dateOrder: DateOrder;
  paidHoursPerDay: number;
  hourlyCost: number;
  driveGapCapMinutes: number;
  missingEnd: MissingEndPolicy;
  maxJobHours: number;
}

export const EMPTY_MAPPING: AuditMapping = { technician: '', start: '', end: '', duration: '', durationUnit: 'minutes', billable: '' };

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function defaultSettings(timeZone: string = browserTimeZone()): AuditSettings {
  return { timeZone, dateOrder: 'mdy', paidHoursPerDay: 8, hourlyCost: DEFAULT_HOURLY_COST, driveGapCapMinutes: 30, missingEnd: 'median', maxJobHours: 16 };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Clamp user-edited settings into safe ranges so a typo can never produce NaN or negative money. */
export function sanitizeSettings(s: Partial<AuditSettings>): AuditSettings {
  const d = defaultSettings();
  const num = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  return {
    timeZone: typeof s.timeZone === 'string' && isValidTimeZone(s.timeZone) ? s.timeZone : d.timeZone,
    dateOrder: s.dateOrder === 'dmy' ? 'dmy' : 'mdy',
    paidHoursPerDay: num(s.paidHoursPerDay, 1, 24, d.paidHoursPerDay),
    hourlyCost: num(s.hourlyCost, 0, 10_000, d.hourlyCost),
    driveGapCapMinutes: num(s.driveGapCapMinutes, 0, 240, d.driveGapCapMinutes),
    missingEnd: s.missingEnd === 'skip' ? 'skip' : 'median',
    maxJobHours: num(s.maxJobHours, 1, 48, d.maxJobHours),
  };
}

// ---------------------------------------------------------------- time zones

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  return f;
}

function localParts(ms: number, tz: string) {
  const out = { y: 0, mo: 0, d: 0, h: 0, mi: 0, s: 0 };
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    const v = Number(p.value);
    if (p.type === 'year') out.y = v;
    else if (p.type === 'month') out.mo = v;
    else if (p.type === 'day') out.d = v;
    else if (p.type === 'hour') out.h = v % 24;
    else if (p.type === 'minute') out.mi = v;
    else if (p.type === 'second') out.s = v;
  }
  return out;
}

function tzOffsetMs(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock time in `tz` → UTC milliseconds (DST-safe; a non-existent spring-forward time resolves forward). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

/** Local calendar day (YYYY-MM-DD) of a UTC instant in `tz`. */
export function localDay(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${String(p.y).padStart(4, '0')}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- cell parsing

function validDate(y: number, mo: number, d: number): boolean {
  if (y < 1970 || y > 2100) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function clock(h: number, mi: number, s: number, ampm?: string): { h: number; mi: number; s: number } | null {
  if (mi > 59 || s > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    const pm = ampm.toUpperCase() === 'PM';
    return { h: (h % 12) + (pm ? 12 : 0), mi, s };
  }
  return h > 23 ? null : { h, mi, s };
}

const ISO_OFFSET = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i;
const ISO_WALL = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(AM|PM)?)?$/i;
const NUMERIC = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[,T ]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i;

/**
 * Parses the date/time formats real exports use (ISO with or without offset, M/D/Y or D/M/Y with
 * 24h or AM/PM time). Values without an offset are interpreted in `tz`. Returns UTC ms or null.
 */
export function parseDateTime(raw: string, order: DateOrder, tz: string): number | null {
  const s = raw.trim();
  if (!s) return null;

  let m = ISO_OFFSET.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const c = clock(Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
    if (!c || !validDate(y, mo, d)) return null;
    const z = m[7].toUpperCase();
    let offsetMin = 0;
    if (z !== 'Z') {
      const digits = z.slice(1).replace(':', '');
      offsetMin = (z[0] === '-' ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0));
    }
    return Date.UTC(y, mo - 1, d, c.h, c.mi, c.s) - offsetMin * 60_000;
  }

  let y: number, mo: number, d: number, hh: string | undefined, mm: string | undefined, ss: string | undefined, ap: string | undefined;
  m = ISO_WALL.exec(s);
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    [hh, mm, ss, ap] = [m[4], m[5], m[6], m[7]];
  } else {
    m = NUMERIC.exec(s);
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2]);
    [mo, d] = order === 'mdy' ? [a, b] : [b, a];
    y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    [hh, mm, ss, ap] = [m[4], m[5], m[6], m[7]];
  }
  if (!validDate(y, mo, d)) return null;
  const c = hh === undefined ? { h: 0, mi: 0, s: 0 } : clock(Number(hh), Number(mm), Number(ss ?? 0), ap);
  return c ? zonedToUtc(y, mo, d, c.h, c.mi, c.s, tz) : null;
}

/** "90", "1.5", "1:30", "1h 30m", "45 min" → minutes. Plain numbers use `unit`. */
export function parseDurationMinutes(raw: string, unit: DurationUnit): number | null {
  const s = raw.trim().toLowerCase().replace(/,/g, '');
  if (!s) return null;
  let m = /^(\d+(?:\.\d+)?)$/.exec(s);
  if (m) return Number(m[1]) * (unit === 'hours' ? 60 : 1);
  m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(m[3] ?? 0) / 60;
  m = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)?$/.exec(s);
  if (m && (m[1] || m[2])) return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  return null;
}

const NON_BILLABLE = new Set(['no', 'n', 'false', '0', 'non-billable', 'nonbillable', 'non billable', 'nb', 'warranty', 'internal', 'callback', 'comeback']);
export function parseBillable(raw: string): boolean {
  return !NON_BILLABLE.has(raw.trim().toLowerCase());
}

// ---------------------------------------------------------------- mapping helpers

const GUESSES: Record<keyof Omit<AuditMapping, 'durationUnit'>, RegExp> = {
  technician: /\b(tech(nician)?|assigned|employee|worker|crew|resource|staff)\b/i,
  start: /(start|begin|arriv|scheduled\s*(date|time)|job\s*date|date)/i,
  end: /(end|finish|complet|depart|close)/i,
  duration: /(duration|hours|minutes|mins|time\s*spent|labor)/i,
  billable: /(billable|invoiced|chargeable)/i,
};

/** Best-effort first guess for the mapping UI — the owner always confirms or changes it. */
export function suggestMapping(headers: string[]): AuditMapping {
  const used = new Set<string>();
  const pick = (re: RegExp) => {
    const h = headers.find((x) => !used.has(x) && re.test(x));
    if (h) used.add(h);
    return h ?? '';
  };
  const technician = pick(GUESSES.technician);
  const start = pick(GUESSES.start);
  const end = pick(GUESSES.end);
  const duration = pick(GUESSES.duration);
  const billable = pick(GUESSES.billable);
  const durationUnit: DurationUnit = /hour|hrs/i.test(duration) ? 'hours' : 'minutes';
  return { technician, start, end, duration, durationUnit, billable };
}

export function mappingError(mapping: AuditMapping, headers: string[]): string | null {
  if (!mapping.technician) return 'Choose the column that holds the technician.';
  if (!mapping.start) return 'Choose the column that holds the job start time.';
  if (!mapping.end && !mapping.duration) return 'Choose an end-time column, a duration column, or both.';
  const chosen = [mapping.technician, mapping.start, mapping.end, mapping.duration, mapping.billable].filter(Boolean);
  for (const c of chosen) if (!headers.includes(c)) return `Column “${c}” is not in this file.`;
  if (new Set(chosen).size !== chosen.length) return 'Each column can only be used for one field.';
  return null;
}

/** A saved template applies when every column it names exists in the file. */
export function templateFits(mapping: AuditMapping, headers: string[]): boolean {
  return mappingError(mapping, headers) === null;
}

// ---------------------------------------------------------------- analysis

export type IssueCode =
  | 'missing_technician' | 'bad_start' | 'bad_end' | 'bad_duration' | 'end_before_start' | 'missing_end' | 'too_long';

export interface AuditIssue { row: number; code: IssueCode; message: string }

export interface DayRecord {
  tech: string; day: string; jobs: number;
  paid: number; billable: number; nonBillableJob: number; drive: number; idle: number; unscheduled: number; leaked: number;
  overlap: number;
}

export interface TechSummary {
  name: string; workdays: number; jobs: number;
  paid: number; billable: number; nonBillableJob: number; drive: number; idle: number; unscheduled: number; leaked: number;
  utilization: number; leakedCost: number; leakedCostPerMonth: number;
}

export interface MonthSummary {
  month: string; workdays: number;
  paid: number; billable: number; drive: number; idle: number; leaked: number; leakedCost: number;
}

export interface AuditResult {
  rowsRead: number; rowsUsed: number; rowsRejected: number; rowsImputed: number; overlapHours: number;
  issues: AuditIssue[]; issueCounts: Partial<Record<IssueCode, number>>;
  techs: TechSummary[]; months: MonthSummary[]; days: DayRecord[];
  totals: { workdays: number; paid: number; billable: number; nonBillableJob: number; drive: number; idle: number; unscheduled: number; leaked: number; leakedCost: number; utilization: number };
  spanDays: number; monthsSpanned: number; leakedHoursPerMonth: number; leakedCostPerMonth: number;
  warnings: string[];
  settings: AuditSettings;
}

interface Job { row: number; tech: string; start: number; end: number; billable: boolean; imputed: boolean }

const HOUR = 3_600_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function union(intervals: [number, number][]): [number, number][] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
const total = (xs: [number, number][]) => xs.reduce((a, [s, e]) => a + (e - s), 0);

export function analyzeHours(headers: string[], rows: string[][], mapping: AuditMapping, rawSettings: Partial<AuditSettings>): AuditResult {
  const settings = sanitizeSettings(rawSettings);
  const tz = settings.timeZone;
  const idx = (h: string) => (h ? headers.indexOf(h) : -1);
  const iTech = idx(mapping.technician), iStart = idx(mapping.start), iEnd = idx(mapping.end), iDur = idx(mapping.duration), iBill = idx(mapping.billable);

  const issues: AuditIssue[] = [];
  const issueCounts: Partial<Record<IssueCode, number>> = {};
  const reject = (row: number, code: IssueCode, message: string) => {
    issueCounts[code] = (issueCounts[code] ?? 0) + 1;
    if (issues.length < MAX_REPORTED_ISSUES) issues.push({ row, code, message });
  };

  const jobs: Job[] = [];
  const pending: { row: number; tech: string; start: number; billable: boolean }[] = [];
  const maxMs = settings.maxJobHours * HOUR;

  rows.forEach((r, i) => {
    const row = i + 2; // spreadsheet row number: header is row 1
    const tech = (r[iTech] ?? '').trim();
    if (!tech) return reject(row, 'missing_technician', 'No technician on this row.');
    const start = parseDateTime(r[iStart] ?? '', settings.dateOrder, tz);
    if (start === null) return reject(row, 'bad_start', `Could not read the start time “${(r[iStart] ?? '').slice(0, 40)}”.`);
    const billable = iBill >= 0 ? parseBillable(r[iBill] ?? '') : true;

    const endRaw = iEnd >= 0 ? (r[iEnd] ?? '').trim() : '';
    const durRaw = iDur >= 0 ? (r[iDur] ?? '').trim() : '';
    let end: number | null = null;
    if (endRaw) {
      end = parseDateTime(endRaw, settings.dateOrder, tz);
      if (end === null) return reject(row, 'bad_end', `Could not read the end time “${endRaw.slice(0, 40)}”.`);
    } else if (durRaw) {
      const mins = parseDurationMinutes(durRaw, mapping.durationUnit);
      if (mins === null) return reject(row, 'bad_duration', `Could not read the duration “${durRaw.slice(0, 40)}”.`);
      end = start + mins * 60_000;
    }
    if (end === null) {
      if (settings.missingEnd === 'median') pending.push({ row, tech, start, billable });
      else reject(row, 'missing_end', 'No end time or duration — row skipped.');
      return;
    }
    if (end <= start) return reject(row, 'end_before_start', 'The end time is not after the start time.');
    if (end - start > maxMs) return reject(row, 'too_long', `Longer than ${settings.maxJobHours} h — probably a data error.`);
    jobs.push({ row, tech, start, end, billable, imputed: false });
  });

  // Missing ends: use the technician's own median job length, else the account's; no data → skip.
  let imputed = 0;
  if (pending.length) {
    const byTech = new Map<string, number[]>();
    const all: number[] = [];
    for (const j of jobs) {
      const k = j.tech.toLowerCase();
      (byTech.get(k) ?? byTech.set(k, []).get(k)!).push(j.end - j.start);
      all.push(j.end - j.start);
    }
    for (const p of pending) {
      const pool = byTech.get(p.tech.toLowerCase());
      const len = pool?.length ? median(pool) : all.length ? median(all) : 0;
      if (len > 0) {
        jobs.push({ row: p.row, tech: p.tech, start: p.start, end: p.start + len, billable: p.billable, imputed: true });
        imputed++;
      } else reject(p.row, 'missing_end', 'No end time or duration and nothing to estimate from — row skipped.');
    }
  }

  // Group: technician (case-insensitive) → local start day.
  const groups = new Map<string, { name: string; days: Map<string, Job[]> }>();
  for (const j of jobs) {
    const key = j.tech.toLowerCase();
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { name: j.tech, days: new Map() }));
    const day = localDay(j.start, tz);
    (g.days.get(day) ?? g.days.set(day, []).get(day)!).push(j);
  }

  const capMs = settings.driveGapCapMinutes * 60_000;
  const dayRecords: DayRecord[] = [];
  let overlapMs = 0;
  for (const g of groups.values()) {
    for (const [day, list] of g.days) {
      const allIv = union(list.map((j): [number, number] => [j.start, j.end]));
      const billIv = union(list.filter((j) => j.billable).map((j): [number, number] => [j.start, j.end]));
      const occupied = total(allIv);
      const dayOverlap = list.reduce((a, j) => a + (j.end - j.start), 0) - occupied;
      overlapMs += dayOverlap;
      const billableMs = total(billIv);
      let driveMs = 0, idleMs = 0;
      for (let k = 1; k < allIv.length; k++) {
        const gap = allIv[k][0] - allIv[k - 1][1];
        const drive = Math.min(gap, capMs);
        driveMs += drive;
        idleMs += gap - drive;
      }
      const paidMs = settings.paidHoursPerDay * HOUR;
      const leakedMs = Math.max(0, paidMs - billableMs);
      let left = leakedMs;
      const take = (raw: number) => { const v = Math.min(left, raw); left -= v; return v; };
      const nb = take(occupied - billableMs);
      const dr = take(driveMs);
      const id = take(idleMs);
      dayRecords.push({
        tech: g.name, day, jobs: list.length,
        paid: paidMs / HOUR, billable: billableMs / HOUR, nonBillableJob: nb / HOUR, drive: dr / HOUR, idle: id / HOUR,
        unscheduled: left / HOUR, leaked: leakedMs / HOUR, overlap: dayOverlap / HOUR,
      });
    }
  }
  dayRecords.sort((a, b) => (a.day === b.day ? a.tech.localeCompare(b.tech) : a.day < b.day ? -1 : 1));

  // Time span → "per month" normalisation.
  const dayKeys = dayRecords.map((d) => d.day);
  const first = dayKeys[0], last = dayKeys[dayKeys.length - 1];
  const spanDays = first ? Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000) + 1 : 0;
  const monthsSpanned = spanDays ? spanDays / 30.4375 : 0;
  const rate = settings.hourlyCost;

  const techMap = new Map<string, TechSummary>();
  const monthMap = new Map<string, MonthSummary>();
  for (const d of dayRecords) {
    let t = techMap.get(d.tech.toLowerCase());
    if (!t) techMap.set(d.tech.toLowerCase(), (t = { name: d.tech, workdays: 0, jobs: 0, paid: 0, billable: 0, nonBillableJob: 0, drive: 0, idle: 0, unscheduled: 0, leaked: 0, utilization: 0, leakedCost: 0, leakedCostPerMonth: 0 }));
    t.workdays++; t.jobs += d.jobs; t.paid += d.paid; t.billable += d.billable; t.nonBillableJob += d.nonBillableJob;
    t.drive += d.drive; t.idle += d.idle; t.unscheduled += d.unscheduled; t.leaked += d.leaked;
    const mk = d.day.slice(0, 7);
    let m = monthMap.get(mk);
    if (!m) monthMap.set(mk, (m = { month: mk, workdays: 0, paid: 0, billable: 0, drive: 0, idle: 0, leaked: 0, leakedCost: 0 }));
    m.workdays++; m.paid += d.paid; m.billable += d.billable; m.drive += d.drive; m.idle += d.idle; m.leaked += d.leaked;
  }
  const techs = [...techMap.values()]
    .sort((a, b) => a.name.localeCompare(b.name)) // alphabetical on purpose: this is an audit, not a ranking
    .map((t) => ({
      ...t, paid: r2(t.paid), billable: r2(t.billable), nonBillableJob: r2(t.nonBillableJob), drive: r2(t.drive), idle: r2(t.idle),
      unscheduled: r2(t.unscheduled), leaked: r2(t.leaked),
      utilization: t.paid > 0 ? Math.round((t.billable / t.paid) * 1000) / 10 : 0,
      leakedCost: r2(t.leaked * rate),
      leakedCostPerMonth: monthsSpanned ? r2((t.leaked * rate) / monthsSpanned) : 0,
    }));
  const months = [...monthMap.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).map((m) => ({
    ...m, paid: r2(m.paid), billable: r2(m.billable), drive: r2(m.drive), idle: r2(m.idle), leaked: r2(m.leaked), leakedCost: r2(m.leaked * rate),
  }));

  const sum = (f: (d: DayRecord) => number) => r2(dayRecords.reduce((a, d) => a + f(d), 0));
  const paid = sum((d) => d.paid), billable = sum((d) => d.billable), leaked = sum((d) => d.leaked);
  const totals = {
    workdays: dayRecords.length, paid, billable, nonBillableJob: sum((d) => d.nonBillableJob), drive: sum((d) => d.drive),
    idle: sum((d) => d.idle), unscheduled: sum((d) => d.unscheduled), leaked, leakedCost: r2(leaked * rate),
    utilization: paid > 0 ? Math.round((billable / paid) * 1000) / 10 : 0,
  };

  const warnings: string[] = [];
  if (jobs.length === 0) warnings.push('No usable rows were found — check the column mapping and date order.');
  if (spanDays > 0 && spanDays < 28) warnings.push(`This file covers only ${spanDays} day${spanDays === 1 ? '' : 's'}, so the per-month figures are extrapolated.`);
  if (imputed > 0) warnings.push(`${imputed} job${imputed === 1 ? ' has' : 's have'} no end time; their length was estimated from the median of other jobs.`);
  if (overlapMs > 0) warnings.push(`${r2(overlapMs / HOUR)} hours of overlapping jobs were counted once.`);
  const rejected = rows.length - jobs.length;
  if (rows.length > 0 && rejected / rows.length > 0.2) warnings.push(`${rejected} of ${rows.length} rows were skipped — results may not represent the whole file.`);

  return {
    rowsRead: rows.length, rowsUsed: jobs.length, rowsRejected: rejected, rowsImputed: imputed, overlapHours: r2(overlapMs / HOUR),
    issues: issues.sort((a, b) => a.row - b.row), issueCounts, techs, months, days: dayRecords, totals,
    spanDays, monthsSpanned: r2(monthsSpanned),
    leakedHoursPerMonth: monthsSpanned ? r2(leaked / monthsSpanned) : 0,
    leakedCostPerMonth: monthsSpanned ? r2((leaked * rate) / monthsSpanned) : 0,
    warnings, settings,
  };
}

// ---------------------------------------------------------------- sharing

export const ESTIMATE_NOTE = 'Estimate based on the uploaded job times and the assumptions below — not an accounting figure.';

/**
 * Shareable plain-text summary. It carries aggregate numbers only: no technician names, no per-technician
 * figures, no customer names or addresses (those columns are never read), and no ranking.
 */
export function buildShareSummary(r: AuditResult): string {
  const s = r.settings;
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const h = (n: number) => `${Math.round(n).toLocaleString('en-US')} h`;
  return [
    'Technician hours audit — summary',
    ESTIMATE_NOTE,
    '',
    `Technicians: ${r.techs.length} · Technician-days: ${r.totals.workdays} · Period: ${r.spanDays} days`,
    `Paid vs billable: ${h(r.totals.paid)} paid, ${h(r.totals.billable)} billable (${r.totals.utilization}% billable)`,
    `Where the rest went (est.): drive ${h(r.totals.drive)}, idle gaps ${h(r.totals.idle)}, non-billable job time ${h(r.totals.nonBillableJob)}, unscheduled ${h(r.totals.unscheduled)}`,
    `Estimated leakage: ${h(r.totals.leaked)} total ≈ ${usd(r.totals.leakedCost)} · about ${h(r.leakedHoursPerMonth)} / ${usd(r.leakedCostPerMonth)} per month`,
    '',
    `Assumptions: ${s.paidHoursPerDay} paid hours per working day; $${s.hourlyCost.toFixed(2)} per hour${s.hourlyCost === DEFAULT_HOURLY_COST ? ' (ACCA-cited truck-roll cost)' : ''}; drive time capped at ${s.driveGapCapMinutes} min per gap; time zone ${s.timeZone}.`,
  ].join('\n');
}
