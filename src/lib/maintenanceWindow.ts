/**
 * Scheduled-maintenance window logic for the public /maintenance page.
 *
 * Pure + dependency-free so it is trivially unit-testable. Reads the same
 * env vars the app-wide maintenance gate already uses (see connectivity.ts)
 * and adds ONE new optional var, VITE_MAINTENANCE_START. A remote JSON
 * signal (VITE_MAINTENANCE_STATUS_URL) can override everything without a
 * redeploy. Failures never fabricate a window.
 */

export type MaintenancePhase = 'none' | 'upcoming' | 'in_progress' | 'completed';

export interface MaintenanceWindow {
  title: string;
  message: string;
  /** Epoch ms, or null when unknown */
  startsAt: number | null;
  /** Epoch ms, or null when unknown */
  endsAt: number | null;
  statusUrl: string;
}

export const DEFAULT_WINDOW_TITLE = 'Scheduled maintenance';
export const DEFAULT_WINDOW_MESSAGE =
  'We are performing a planned update to keep Vireek fast, secure, and reliable. Voice answering for live calls is designed to keep running while the dashboard is updated.';

/** Parse an ISO-8601 string into epoch ms; null when empty or invalid. */
export function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : null;
}

/** Only same-origin paths or http(s) URLs are allowed as the status link. */
export function safeStatusUrl(value: unknown): string {
  if (typeof value !== 'string') return '/status';
  const v = value.trim();
  if (v.startsWith('/') && !v.startsWith('//')) return v;
  if (/^https?:\/\//i.test(v)) return v;
  return '/status';
}

function clean(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Drops an end time that is not after the start time. */
function normalize(start: number | null, end: number | null) {
  if (start !== null && end !== null && end <= start) return { start, end: null };
  return { start, end };
}

export function readEnvWindow(): MaintenanceWindow {
  const env = import.meta.env;
  const { start, end } = normalize(
    parseTime(env.VITE_MAINTENANCE_START),
    parseTime(env.VITE_MAINTENANCE_ETA),
  );
  return {
    title: clean(env.VITE_MAINTENANCE_TITLE) ?? DEFAULT_WINDOW_TITLE,
    message: clean(env.VITE_MAINTENANCE_MESSAGE) ?? DEFAULT_WINDOW_MESSAGE,
    startsAt: start,
    endsAt: end,
    statusUrl: '/status',
  };
}

/**
 * Optional remote override. Expected JSON (all fields optional):
 * { "start": "2026-10-20T22:00:00Z", "eta": "2026-10-21T00:00:00Z",
 *   "title": "...", "message": "...", "statusUrl": "/status" }
 * Accepts "end" as an alias of "eta". Any failure returns null.
 */
export async function fetchRemoteWindow(
  base: MaintenanceWindow,
  signal?: AbortSignal,
): Promise<MaintenanceWindow | null> {
  const url = clean(import.meta.env.VITE_MAINTENANCE_STATUS_URL);
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: 'no-store', signal });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const start = parseTime(data.start) ?? base.startsAt;
    const end = parseTime(data.eta) ?? parseTime(data.end) ?? base.endsAt;
    const n = normalize(start, end);
    return {
      title: clean(data.title) ?? base.title,
      message: clean(data.message) ?? base.message,
      startsAt: n.start,
      endsAt: n.end,
      statusUrl: data.statusUrl === undefined ? base.statusUrl : safeStatusUrl(data.statusUrl),
    };
  } catch {
    return null;
  }
}

export function getPhase(
  win: Pick<MaintenanceWindow, 'startsAt' | 'endsAt'>,
  now: number,
  gateActive = false,
): MaintenancePhase {
  if (gateActive) return 'in_progress';
  const { startsAt, endsAt } = win;
  if (startsAt === null && endsAt === null) return 'none';
  if (startsAt !== null && now < startsAt) return 'upcoming';
  if (endsAt !== null && now >= endsAt) return 'completed';
  // Started (or start unknown) and not yet ended
  return startsAt !== null ? 'in_progress' : 'upcoming';
}

export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  totalMs: number;
}

export function getCountdown(targetMs: number, now: number): CountdownParts {
  const totalMs = Math.max(0, targetMs - now);
  const s = Math.floor(totalMs / 1000);
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
    totalMs,
  };
}

/** Human duration like "2 h 30 min"; null when under a minute or invalid. */
export function formatDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 60_000) return null;
  const totalMin = Math.round(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return [d ? `${d} d` : '', h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
}

function icsStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Minimal RFC 5545 calendar file for the window. Requires both bounds. */
export function buildIcs(win: MaintenanceWindow, origin: string): string | null {
  if (win.startsAt === null || win.endsAt === null) return null;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vireek//Maintenance//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:maintenance-${win.startsAt}@vireek.com`,
    `DTSTAMP:${icsStamp(Date.now())}`,
    `DTSTART:${icsStamp(win.startsAt)}`,
    `DTEND:${icsStamp(win.endsAt)}`,
    `SUMMARY:${icsEscape(`Vireek: ${win.title}`)}`,
    `DESCRIPTION:${icsEscape(win.message)}`,
    `URL:${origin}/maintenance`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}
