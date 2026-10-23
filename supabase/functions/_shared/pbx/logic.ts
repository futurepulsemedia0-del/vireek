// supabase/functions/_shared/pbx/logic.ts
// Pure PBX decisions: NO imports, NO I/O. Shared by the edge functions and the
// dashboard (re-exported from src/lib), and unit-tested in logic.test.ts.

export type DestType = 'extension' | 'ring_group' | 'queue' | 'voicemail' | 'ai' | 'external' | 'hangup';
export interface Destination { type: DestType; id?: string; number?: string }
export type Strategy = 'simultaneous' | 'sequential' | 'round_robin' | 'longest_idle';
export type Interval = [string, string];
export interface ScheduleException { date: string; closed?: boolean; intervals?: Interval[] }
export interface Schedule {
  timezone: string;
  weekly: Record<string, Interval[]>;
  exceptions: ScheduleException[];
  include_business_holidays?: boolean;
}
export type OpenReason = 'no_schedule' | 'holiday' | 'exception_closed' | 'exception_hours' | 'weekly' | 'outside_hours';

const DAYS = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const E164 = /^\+[1-9]\d{7,14}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isValidE164 = (v: unknown): v is string => typeof v === 'string' && E164.test(v);

export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (E164.test(t)) return t;
  const d = t.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

export function xml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string));
}

/** "204" -> internal extension, "+15551234567"/"5551234567" -> PSTN, anything else -> null. */
export function parseDialString(raw: string):
  | { kind: 'extension'; extension: string }
  | { kind: 'pstn'; e164: string }
  | null {
  const t = (raw ?? '').trim();
  if (/^\d{2,6}$/.test(t)) return { kind: 'extension', extension: t };
  const e = toE164(t);
  return e ? { kind: 'pstn', e164: e } : null;
}

// ---------------------------------------------------------------- schedules
export function zonedParts(now: Date, timeZone: string): { date: string; time: string; dow: string } {
  const make = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
  let f: Intl.DateTimeFormat;
  try { f = make(timeZone); } catch { f = make('UTC'); }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(now)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, dow: String(p.weekday).toLowerCase().slice(0, 3) };
}

const inInterval = (t: string, [a, b]: Interval) => (a < b ? t >= a && t < b : t >= a || t < b);

/** Fails OPEN (no schedule => open) so a misconfiguration never silences the phones. */
export function isOpenNow(s: Schedule | null, now: Date, businessHolidays: string[] = []): { open: boolean; reason: OpenReason } {
  if (!s) return { open: true, reason: 'no_schedule' };
  const p = zonedParts(now, s.timezone);
  const ex = (s.exceptions ?? []).find((e) => e.date === p.date);
  if (ex) {
    if (ex.closed || !ex.intervals?.length) return { open: false, reason: 'exception_closed' };
    return { open: ex.intervals.some((i) => inInterval(p.time, i)), reason: 'exception_hours' };
  }
  if (s.include_business_holidays && businessHolidays.includes(p.date)) return { open: false, reason: 'holiday' };
  const ok = (s.weekly?.[p.dow] ?? []).some((i) => inInterval(p.time, i));
  return { open: ok, reason: ok ? 'weekly' : 'outside_hours' };
}

export function validateSchedule(s: Schedule): string[] {
  const errs: string[] = [];
  try { new Intl.DateTimeFormat('en', { timeZone: s.timezone }); } catch { errs.push('Unknown time zone.'); }
  for (const [day, list] of Object.entries(s.weekly ?? {})) {
    if (!DAYS.has(day)) errs.push(`Unknown day "${day}".`);
    for (const [a, b] of list) if (!HHMM.test(a) || !HHMM.test(b)) errs.push(`Invalid time on ${day}.`);
  }
  for (const e of s.exceptions ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) errs.push(`Invalid exception date "${e.date}".`);
    for (const [a, b] of e.intervals ?? []) if (!HHMM.test(a) || !HHMM.test(b)) errs.push(`Invalid time on ${e.date}.`);
  }
  return errs;
}

// ------------------------------------------------------------------ routing
export interface Candidate { id: string; position: number; lastCallEndedAt: string | null }

/** Returns "steps": each step is rung together; the next step starts when the previous one fails. */
export function orderCandidates(strategy: Strategy, list: Candidate[], cursor = 0): string[][] {
  if (!list.length) return [];
  const byPos = [...list].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  if (strategy === 'simultaneous') return [byPos.map((c) => c.id)];
  if (strategy === 'sequential') return byPos.map((c) => [c.id]);
  if (strategy === 'round_robin') {
    const k = ((cursor % byPos.length) + byPos.length) % byPos.length;
    return [...byPos.slice(k), ...byPos.slice(0, k)].map((c) => [c.id]);
  }
  const t = (c: Candidate) => (c.lastCallEndedAt ? Date.parse(c.lastCallEndedAt) : -Infinity); // never-called first
  return [...byPos].sort((a, b) => (t(a) === t(b) ? 0 : t(a) < t(b) ? -1 : 1)).map((c) => [c.id]);
}

export function estimateWaitSeconds(position: number, avgHandleSeconds: number, agents: number): number {
  if (position <= 0) return 0;
  const handle = avgHandleSeconds > 0 ? avgHandleSeconds : 240;
  return Math.round((position / Math.max(1, agents)) * handle);
}

export function queueAnnouncement(position: number, waitSeconds: number, o: { position: boolean; wait: boolean }): string {
  const parts: string[] = [];
  if (o.position) parts.push(position <= 1 ? 'You are next in line.' : `You are number ${position} in line.`);
  if (o.wait && waitSeconds > 0) {
    const m = Math.round(waitSeconds / 60);
    parts.push(m < 1 ? 'Your estimated wait is less than a minute.' : `Your estimated wait is about ${m} minute${m === 1 ? '' : 's'}.`);
  }
  return parts.length ? `${parts.join(' ')} Thank you for holding.` : '';
}

// ---------------------------------------------------------------- caller ID
export interface LineInfo { id: string; e164: string; allowOutbound: boolean; enabled: boolean }

/** A user can only present a number from a line they are a dial-out member of. No match => refuse (never guess). */
export function pickOutboundCallerId(a: {
  preferredLineId: string | null;
  memberships: { lineId: string; canDialOut: boolean }[];
  lines: LineInfo[];
}): { lineId: string; e164: string } | null {
  const usable = (l: LineInfo) =>
    l.enabled && l.allowOutbound && isValidE164(l.e164) && a.memberships.some((m) => m.lineId === l.id && m.canDialOut);
  const chosen =
    a.lines.find((l) => l.id === a.preferredLineId && usable(l)) ??
    a.lines.filter(usable).sort((x, y) => x.id.localeCompare(y.id))[0];
  return chosen ? { lineId: chosen.id, e164: chosen.e164 } : null;
}

export type RecordingMode = 'off' | 'inbound' | 'outbound' | 'all';
export function shouldRecord(mode: RecordingMode, direction: 'inbound' | 'outbound' | 'internal', override?: RecordingMode | null): boolean {
  if (direction === 'internal') return false;
  const m = override ?? mode;
  return m === 'all' || m === direction;
}
