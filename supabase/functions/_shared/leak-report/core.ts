/**
 * Leak Report - pure core (no imports, no I/O). Shared by the edge function
 * (Deno), the browser and the tests, so the numbers can never drift.
 */

export type Direction = 'inbound' | 'outbound';

export interface CallObservation {
  id: string;
  startedAt: string;
  direction: Direction;
  answered: boolean;
  isVoicemail: boolean;
  ringSeconds: number | null;
  durationSeconds: number | null;
  phoneKey: string | null;
}

export interface NormalizedEvent {
  dedupeKey: string;
  direction: Direction;
  startedAt: string;
  answered: boolean;
  isVoicemail: boolean;
  ringSeconds: number | null;
  durationSeconds: number | null;
  phoneKey: string | null;
}

export type BusinessHours = Record<string, { open: string; close: string }> | null | undefined;

export const WINDOW_DAYS = 7;
export const CALLBACK_HORIZON_HOURS = 72;
export const DEFAULT_CLOSE_RATE_BPS = 3000;
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DEDUPE_WINDOW_MS = 120_000;

// ---------------------------------------------------------------- normalization

export function normalizePhoneKey(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(o)) lower.set(k.toLowerCase().replace(/[\s-]+/g, '_'), v);
  for (const k of keys) {
    const v = lower.get(k);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(s)) return true;
    if (['false', 'no', 'n', '0'].includes(s)) return false;
  }
  return undefined;
}

function toSeconds(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), 86_400);
}

function toIso(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  let ms: number;
  if (typeof v === 'number' || /^\d{9,13}$/.test(String(v).trim())) {
    const n = Number(v);
    ms = n < 1e11 ? n * 1000 : n;
  } else {
    ms = Date.parse(String(v));
  }
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const ANSWERED = new Set(['completed', 'answered', 'in-progress', 'in_progress', 'connected', 'accepted']);
const UNANSWERED = new Set(['no-answer', 'no_answer', 'noanswer', 'busy', 'failed', 'canceled', 'cancelled', 'missed', 'unanswered', 'abandoned', 'voicemail']);

export type NormalizeResult = { ok: true; event: NormalizedEvent } | { ok: false; reason: string };

/** Accepts generic JSON, Twilio status callbacks and CallRail-style payloads. */
export function normalizeEvent(raw: unknown, sourceKey = 'x', nowMs = Date.now()): NormalizeResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not_an_object' };
  const o = raw as Record<string, unknown>;

  const startedAt = toIso(pick(o, ['started_at', 'start_time', 'starttime', 'timestamp', 'call_start', 'datetime', 'date_time', 'date', 'call_datetime']));
  if (!startedAt) return { ok: false, reason: 'bad_start_time' };
  const t = Date.parse(startedAt);
  if (t > nowMs + 3_600_000) return { ok: false, reason: 'start_in_future' };
  if (t < nowMs - 400 * 86_400_000) return { ok: false, reason: 'too_old' };

  const dirRaw = String(pick(o, ['direction', 'call_direction', 'type']) ?? 'inbound').toLowerCase();
  const direction: Direction = dirRaw.includes('out') ? 'outbound' : 'inbound';

  const from = pick(o, ['from', 'caller', 'caller_phone', 'caller_number']);
  const to = pick(o, ['to', 'called', 'destination', 'callee']);
  const generic = pick(o, ['customer_phone_number', 'customer_phone', 'phone', 'phone_number', 'contact_phone']);
  const phoneKey = normalizePhoneKey(generic ?? (direction === 'inbound' ? from : to));

  const duration = toSeconds(pick(o, ['duration_seconds', 'duration', 'callduration', 'call_duration']));
  const statusRaw = String(pick(o, ['status', 'callstatus', 'call_status', 'disposition', 'result']) ?? '').trim().toLowerCase();
  const explicitAnswered = toBool(pick(o, ['answered', 'is_answered']));
  let isVoicemail = toBool(pick(o, ['voicemail', 'is_voicemail'])) ?? statusRaw === 'voicemail';
  let answered = explicitAnswered ?? (ANSWERED.has(statusRaw) ? true : UNANSWERED.has(statusRaw) ? false : (duration ?? 0) > 0);
  if (isVoicemail) answered = false;
  if (answered) isVoicemail = false;

  let ring = toSeconds(pick(o, ['ring_seconds', 'ringing_seconds', 'time_to_answer', 'answer_delay', 'ring_duration']));
  const answeredAt = toIso(pick(o, ['answered_at', 'answer_time']));
  if (ring === null && answered && answeredAt) {
    const diff = (Date.parse(answeredAt) - t) / 1000;
    if (Number.isFinite(diff) && diff >= 0) ring = Math.min(Math.round(diff), 3600);
  }
  if (ring !== null) ring = Math.min(ring, 3600);
  if (!answered) ring = null;

  const ext = pick(o, ['id', 'call_id', 'callsid', 'sid', 'external_id', 'uuid']);
  const dedupeKey = ext !== undefined
    ? `${sourceKey}:${String(ext).slice(0, 120)}`
    : `${sourceKey}:${direction}:${phoneKey ?? 'anon'}:${startedAt}`;

  return { ok: true, event: { dedupeKey, direction, startedAt, answered, isVoicemail, ringSeconds: ring, durationSeconds: duration, phoneKey } };
}

// ---------------------------------------------------------------- CSV

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

export interface CsvParseResult { events: NormalizedEvent[]; rejected: number; total: number }

export const CSV_MAX_ROWS = 5000;

export function parseCallLogCsv(text: string, nowMs = Date.now()): CsvParseResult {
  const rows = parseCsv(text);
  if (rows.length < 2) return { events: [], rejected: 0, total: 0 };
  const headers = rows[0].map((h) => h.trim());
  const body = rows.slice(1, CSV_MAX_ROWS + 1);
  const events: NormalizedEvent[] = [];
  let rejected = 0;
  for (const r of body) {
    const o: Record<string, unknown> = {};
    headers.forEach((h, i) => { if (h) o[h] = r[i]?.trim() ?? ''; });
    const lower = Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
    if (!pick(o, ['started_at', 'start_time', 'timestamp', 'datetime', 'date_time', 'call_datetime']) && lower.date && lower.time) {
      o.started_at = `${lower.date} ${lower.time}`;
    }
    const res = normalizeEvent(o, 'csv', nowMs);
    if (res.ok) events.push(res.event); else rejected++;
  }
  return { events, rejected, total: body.length };
}

// ---------------------------------------------------------------- time helpers

const fmtCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function localParts(iso: string, timeZone: string): { dow: number; hour: number; minute: number } {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: isValidTimeZone(timeZone) ? timeZone : 'UTC', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
    fmtCache.set(timeZone, f);
  }
  const parts = f.formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { dow: dow < 0 ? 0 : dow, hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

function hhmm(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  return h > 24 || mi > 59 ? null : h * 60 + mi;
}

/** Same rule as RevenueRecoveredCard: unlisted/malformed day = closed; no hours configured = Mon-Fri 8-18. */
export function isAfterHours(iso: string, tz: string, hours: BusinessHours): boolean {
  const { dow, hour, minute } = localParts(iso, tz);
  const mins = hour * 60 + minute;
  if (hours && Object.keys(hours).length > 0) {
    const e = hours[DAY_KEYS[dow]];
    const o = hhmm(e?.open); const c = hhmm(e?.close);
    if (o === null || c === null) return true;
    return mins < o || mins >= c;
  }
  return dow === 0 || dow === 6 || mins < 8 * 60 || mins >= 18 * 60;
}

// ---------------------------------------------------------------- report

export interface HourBucket { hour: number; total: number; missed: number }
export interface DayBucket { dow: number; total: number; missed: number }

export interface LeakReport {
  inboundTotal: number;
  answered: number;
  missed: number;
  voicemails: number;
  answerRate: number | null;
  afterHoursTotal: number;
  afterHoursMissed: number;
  afterHoursAnswered: number;
  byHour: HourBucket[];
  byDay: DayBucket[];
  worstHour: number | null;
  worstDay: number | null;
  avgAnswerSeconds: number | null;
  medianCallbackSeconds: number | null;
  avgFirstResponseSeconds: number | null;
  calledBackWithin5Min: number;
  calledBack: number;
  recoveredByCaller: number;
  lostCallers: number;
  neverCalledBackRate: number | null;
  observedDays: number;
  avgTicketCents: number | null;
  closeRateBps: number;
  estimatedLostCents: number | null;
  ceilingLostCents: number | null;
  annualizedLostCents: number | null;
}

export interface ReportInput {
  events: CallObservation[];
  windowStart: Date;
  windowEnd: Date;
  timeZone: string;
  businessHours: BusinessHours;
  avgTicketCents: number | null;
  closeRateBps?: number;
  nowMs?: number;
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** Observed events win over Vireek-handled calls from the same caller within 2 minutes. */
export function mergeObservations(observed: CallObservation[], vireek: CallObservation[]): CallObservation[] {
  const keep = vireek.filter((v) => !observed.some((o) =>
    o.direction === v.direction && o.phoneKey !== null && o.phoneKey === v.phoneKey &&
    Math.abs(Date.parse(o.startedAt) - Date.parse(v.startedAt)) <= DEDUPE_WINDOW_MS));
  return [...observed, ...keep].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

export function computeLeakReport(input: ReportInput): LeakReport {
  const closeRateBps = Math.min(10_000, Math.max(0, Math.round(input.closeRateBps ?? DEFAULT_CLOSE_RATE_BPS)));
  const ws = input.windowStart.getTime();
  const we = input.windowEnd.getTime();
  const horizon = CALLBACK_HORIZON_HOURS * 3_600_000;
  const all = [...input.events].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const inbound = all.filter((e) => e.direction === 'inbound' && Date.parse(e.startedAt) >= ws && Date.parse(e.startedAt) <= we);

  const byHour: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({ hour, total: 0, missed: 0 }));
  const byDay: DayBucket[] = Array.from({ length: 7 }, (_, dow) => ({ dow, total: 0, missed: 0 }));
  let answered = 0; let missed = 0; let voicemails = 0;
  let afterHoursTotal = 0; let afterHoursMissed = 0;
  const answerTimes: number[] = [];

  for (const c of inbound) {
    const p = localParts(c.startedAt, input.timeZone);
    const miss = !c.answered;
    byHour[p.hour].total++; byDay[p.dow].total++;
    if (miss) {
      missed++; byHour[p.hour].missed++; byDay[p.dow].missed++;
      if (c.isVoicemail) voicemails++;
    } else {
      answered++;
      if (c.ringSeconds !== null) answerTimes.push(c.ringSeconds);
    }
    if (isAfterHours(c.startedAt, input.timeZone, input.businessHours)) { afterHoursTotal++; if (miss) afterHoursMissed++; }
  }

  // Missed calls -> callback / caller retry. One outcome per unique caller.
  const callbackDelays: number[] = [];
  let recoveredByCaller = 0; let lostCallers = 0; let calledBack = 0; let within5 = 0;
  const seen = new Set<string>();
  for (const c of inbound) {
    if (c.answered) continue;
    const t = Date.parse(c.startedAt);
    if (!c.phoneKey) { lostCallers++; continue; }
    if (seen.has(c.phoneKey)) continue;
    seen.add(c.phoneKey);
    const first = all.find((e) => e.phoneKey === c.phoneKey && Date.parse(e.startedAt) > t && Date.parse(e.startedAt) - t <= horizon &&
      (e.direction === 'outbound' || (e.direction === 'inbound' && e.answered)));
    if (!first) { lostCallers++; continue; }
    if (first.direction === 'inbound') { recoveredByCaller++; continue; }
    calledBack++;
    const d = Math.round((Date.parse(first.startedAt) - t) / 1000);
    callbackDelays.push(d);
    if (d <= 300) within5++;
  }

  const uniqueMissedCallers = lostCallers + calledBack + recoveredByCaller;
  const firstResponses = [...answerTimes, ...callbackDelays];
  const observedMs = Math.max(0, Math.min(input.nowMs ?? Date.now(), we) - ws);
  const observedDays = Math.round((observedMs / 86_400_000) * 10) / 10;

  const ticket = input.avgTicketCents !== null && input.avgTicketCents > 0 ? input.avgTicketCents : null;
  const ceiling = ticket === null ? null : lostCallers * ticket;
  const estimated = ticket === null ? null : Math.round((lostCallers * ticket * closeRateBps) / 10_000);
  const annualized = estimated === null || observedDays < 1 ? null : Math.round((estimated / observedDays) * 365);

  const worst = <T extends { total: number; missed: number }>(xs: T[]) => {
    const c = xs.filter((x) => x.missed >= 1).sort((a, b) => b.missed - a.missed || b.missed / b.total - a.missed / a.total);
    return c.length ? xs.indexOf(c[0]) : null;
  };

  return {
    inboundTotal: inbound.length, answered, missed, voicemails,
    answerRate: inbound.length ? Math.round((answered / inbound.length) * 100) : null,
    afterHoursTotal, afterHoursMissed, afterHoursAnswered: afterHoursTotal - afterHoursMissed,
    byHour, byDay,
    worstHour: worst(byHour), worstDay: worst(byDay),
    avgAnswerSeconds: avg(answerTimes), medianCallbackSeconds: median(callbackDelays),
    avgFirstResponseSeconds: avg(firstResponses),
    calledBackWithin5Min: within5, calledBack, recoveredByCaller, lostCallers,
    neverCalledBackRate: uniqueMissedCallers ? Math.round((lostCallers / uniqueMissedCallers) * 100) : null,
    observedDays, avgTicketCents: ticket, closeRateBps,
    estimatedLostCents: estimated, ceilingLostCents: ceiling, annualizedLostCents: annualized,
  };
}

// ---------------------------------------------------------------- formatting + phase

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '-';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const h = seconds / 3600;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
}

export function formatUsd(cents: number | null): string {
  if (cents === null) return '-';
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

export function hourLabel(h: number): string {
  const s = h % 12 === 0 ? 12 : h % 12;
  return `${s} ${h < 12 ? 'AM' : 'PM'}`;
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export type ReportPhase = 'off' | 'waiting' | 'collecting' | 'complete';

export function reportPhase(enabled: boolean, startedAt: string | null, inboundTotal: number, windowDays: number, now = Date.now()): ReportPhase {
  if (!enabled || !startedAt) return 'off';
  if (now >= Date.parse(startedAt) + windowDays * 86_400_000) return 'complete';
  return inboundTotal === 0 ? 'waiting' : 'collecting';
}
