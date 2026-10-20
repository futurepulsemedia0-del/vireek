// Pure rules for the ICS calendar subscription feeds (technician + business).
// No network, no Deno/Node APIs beyond Web Crypto + TextEncoder, so the edge
// function (supabase/functions/calendar-feed), the client (src/lib/calendarFeeds.ts)
// and the vitest suite all share ONE implementation and can never disagree.
//
// Format: RFC 5545 (iCalendar) — CRLF line endings, 75-octet line folding,
// TEXT escaping, UTC timestamps (so no VTIMEZONE is needed and every client —
// Google, Apple, Outlook — renders in the viewer's own zone).

export type FeedScope = "business" | "technician";
export type DetailLevel = "full" | "busy";

export interface FeedJob {
  id: string;
  customer_name: string | null;
  customer_phone: string | null;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
  duration_minutes: number | null;
  assigned_technician_id: string | null;
  job_status: string | null;
  notes: string | null;
}

export const FEED_PAST_DAYS = 30;
export const FEED_FUTURE_DAYS = 180;
export const FEED_MAX_EVENTS = 2000;
export const FEED_REFRESH_MINUTES = 15;
export const FEED_ACCESS_THROTTLE_MS = 5 * 60 * 1000;
export const DEFAULT_DURATION_MINUTES = 60;
export const MIN_DURATION_MINUTES = 15;
export const MAX_DURATION_MINUTES = 720;
export const NOTES_MAX = 1000;
export const PRODID = "-//Vireek//Calendar Feed 1.0//EN";
export const UID_DOMAIN = "feeds.vireek.com";

/** Jobs in these states never appear: feeds are full snapshots, so omitting = removing. */
export const EXCLUDED_STATUSES = ["cancelled", "canceled", "no_show"] as const;

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Tokens are 256-bit random hex strings generated in Postgres. Anything else is rejected before any query. */
export function isValidFeedToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

/** Accepts `/calendar-feed/<token>.ics`, `/<token>.ics` or `/<token>`; returns null for anything else. */
export function parseFeedPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last || segments.length > 2) return null;
  const candidate = last.replace(/\.ics$/i, "").toLowerCase();
  return isValidFeedToken(candidate) ? candidate : null;
}

export function isExcludedStatus(status: string | null | undefined): boolean {
  return EXCLUDED_STATUSES.includes(String(status ?? "").toLowerCase() as (typeof EXCLUDED_STATUSES)[number]);
}

export function clampDuration(minutes: number | null | undefined): number {
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return DEFAULT_DURATION_MINUTES;
  return Math.min(MAX_DURATION_MINUTES, Math.max(MIN_DURATION_MINUTES, Math.round(minutes)));
}

export function jobWindow(job: Pick<FeedJob, "scheduled_datetime" | "duration_minutes">): { start: Date; end: Date } | null {
  if (!job.scheduled_datetime) return null;
  const start = new Date(job.scheduled_datetime);
  if (Number.isNaN(start.getTime())) return null;
  return { start, end: new Date(start.getTime() + clampDuration(job.duration_minutes) * 60_000) };
}

export function feedWindow(now: Date): { from: Date; to: Date } {
  const day = 86_400_000;
  return { from: new Date(now.getTime() - FEED_PAST_DAYS * day), to: new Date(now.getTime() + FEED_FUTURE_DAYS * day) };
}

/** RFC 5545 §3.3.5 UTC date-time: 20271020T143000Z */
export function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** RFC 5545 §3.3.11 TEXT escaping (+ control characters stripped so a customer name can never inject a property). */
export function escapeText(value: string): string {
  return value
    .replace(/\r\n|\r/g, "\n")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** RFC 5545 §3.1: lines are limited to 75 OCTETS; continuation lines start with one space. Never splits a multi-byte character. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = enc.encode(ch).length;
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
      limit = 74;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

function clip(value: string, max: number): string {
  const v = value.trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

function safeUidPart(id: string): string {
  return id.replace(/[^A-Za-z0-9-]/g, "");
}

export interface EventOptions {
  detail: DetailLevel;
  scope: FeedScope;
  appOrigin: string;
  stamp: Date;
  /** Business feeds only: assigned technician's display name. */
  technicianName?: string | null;
}

/** Returns the unfolded content lines of one VEVENT, or null when the job must not appear. */
export function buildEvent(job: FeedJob, opts: EventOptions): string[] | null {
  if (isExcludedStatus(job.job_status)) return null;
  const win = jobWindow(job);
  if (!win || !job.id) return null;

  const full = opts.detail === "full";
  const customer = (job.customer_name ?? "").trim();
  const service = (job.service_type ?? "").trim() || "Job";
  const summary = full ? (customer ? `${service} — ${customer}` : service) : "Vireek job";

  const lines = [
    "BEGIN:VEVENT",
    `UID:${safeUidPart(job.id)}@${UID_DOMAIN}`,
    `DTSTAMP:${icsDate(opts.stamp)}`,
    `DTSTART:${icsDate(win.start)}`,
    `DTEND:${icsDate(win.end)}`,
    `SUMMARY:${escapeText(summary)}`,
  ];

  if (full) {
    const address = (job.address ?? "").trim();
    if (address) lines.push(`LOCATION:${escapeText(address)}`);

    const parts: string[] = [];
    if (customer) parts.push(`Customer: ${customer}`);
    if (job.customer_phone?.trim()) parts.push(`Phone: ${job.customer_phone.trim()}`);
    parts.push(`Service: ${service}`);
    if (opts.scope === "business" && opts.technicianName) parts.push(`Technician: ${opts.technicianName}`);
    if (job.job_status) parts.push(`Status: ${job.job_status.replace(/_/g, " ")}`);
    if (job.notes?.trim()) parts.push(`Notes: ${clip(job.notes, NOTES_MAX)}`);
    const origin = opts.appOrigin.replace(/\/+$/, "");
    parts.push(`Open in Vireek: ${origin}/dashboard/jobs/${job.id}`);
    lines.push(`DESCRIPTION:${parts.map(escapeText).join("\\n")}`);
    lines.push(`URL:${origin}/dashboard/jobs/${encodeURIComponent(job.id)}`);
  }

  lines.push("STATUS:CONFIRMED", "TRANSP:OPAQUE", "CATEGORIES:Vireek", "END:VEVENT");
  return lines;
}

export interface CalendarOptions {
  name: string;
  jobs: FeedJob[];
  event: Omit<EventOptions, "technicianName">;
  /** Business feeds: technician id -> display name. */
  technicianNames?: Map<string, string>;
}

/** Builds the full VCALENDAR text (CRLF, folded, trailing CRLF). Events are sorted by start then id for a stable body. */
export function buildCalendar(opts: CalendarOptions): string {
  const events = opts.jobs
    .map((job) => ({
      job,
      lines: buildEvent(job, {
        ...opts.event,
        technicianName: job.assigned_technician_id ? opts.technicianNames?.get(job.assigned_technician_id) ?? null : null,
      }),
    }))
    .filter((e): e is { job: FeedJob; lines: string[] } => e.lines !== null)
    .sort((a, b) => {
      const sa = a.job.scheduled_datetime ?? "";
      const sb = b.job.scheduled_datetime ?? "";
      return sa === sb ? a.job.id.localeCompare(b.job.id) : sa < sb ? -1 : 1;
    });

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.name)}`,
    "X-WR-CALDESC:Jobs from Vireek. Read-only — change jobs in Vireek.",
    `REFRESH-INTERVAL;VALUE=DURATION:PT${FEED_REFRESH_MINUTES}M`,
    `X-PUBLISHED-TTL:PT${FEED_REFRESH_MINUTES}M`,
    ...events.flatMap((e) => e.lines),
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

export function feedCalendarName(scope: FeedScope, company: string | null, technician: string | null): string {
  const co = (company ?? "").trim();
  if (scope === "technician") return `${(technician ?? "").trim() || "Technician"}${co ? ` — ${co}` : ""} (Vireek)`;
  return `${co || "Business"} jobs (Vireek)`;
}

export function feedFileName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 60);
  return `${base || "vireek-calendar"}.ics`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** ETag over the calendar WITHOUT DTSTAMP lines, so an unchanged schedule keeps the same tag and clients get a cheap 304. */
export async function calendarEtag(body: string): Promise<string> {
  return `"${(await sha256Hex(body.replace(/^DTSTAMP:.*\r\n/gm, ""))).slice(0, 32)}"`;
}

/** RFC 7232 weak comparison for If-None-Match (handles lists, W/ prefixes and `*`). */
export function etagMatches(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (v: string) => v.trim().replace(/^W\//, "");
  return header.split(",").some((candidate) => strip(candidate) === "*" || strip(candidate) === strip(etag));
}

/** Whether a successful fetch should be recorded (throttled so aggressive pollers cannot cause a write storm). */
export function shouldRecordAccess(lastAccessedAt: string | null | undefined, now: Date): boolean {
  if (!lastAccessedAt) return true;
  const last = new Date(lastAccessedAt).getTime();
  return Number.isNaN(last) || now.getTime() - last >= FEED_ACCESS_THROTTLE_MS;
}
