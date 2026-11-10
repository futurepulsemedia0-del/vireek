// supabase/functions/_shared/analytics/request.ts
//
// Pure request validation for the analytics edge functions. Nothing from the client is trusted: every
// field is checked, bounded and normalised here, and the result contains only known keys.

import { sanitizeAnalyticsEvent, type Granularity } from "./customerKpis.ts";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RANGE_DAYS = 400;
const MAX_TEAM = 50;
const DAY_MS = 86_400_000;

export type AnalyticsRequest =
  | { action: "get" | "csv"; fromDay: string; toDay: string; granularity: Granularity; teamIds: string[] }
  | { action: "settings"; hoursPerDay?: number; digestEnabled?: boolean; digestCadence?: "weekly" | "monthly"; alertsEnabled?: boolean }
  | { action: "ack"; alertId: string }
  | { action: "event"; name: string; props: Record<string, string | number | boolean> };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function validDay(d: unknown): d is string {
  if (typeof d !== "string" || !DAY_RE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d; // rejects 2028-02-30
}

export function parseAnalyticsRequest(body: unknown): Parsed<AnalyticsRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid request body." };
  const b = body as Record<string, unknown>;
  switch (b.action) {
    case "get":
    case "csv": {
      if (!validDay(b.from) || !validDay(b.to)) return { ok: false, error: "from and to must be valid YYYY-MM-DD dates." };
      const span = (Date.parse(`${b.to}T00:00:00Z`) - Date.parse(`${b.from}T00:00:00Z`)) / DAY_MS;
      if (span < 0) return { ok: false, error: "to must not be before from." };
      if (span + 1 > MAX_RANGE_DAYS) return { ok: false, error: `Range is limited to ${MAX_RANGE_DAYS} days.` };
      const g = b.granularity ?? "week";
      if (g !== "day" && g !== "week" && g !== "month") return { ok: false, error: "granularity must be day, week or month." };
      const raw = b.teamIds ?? [];
      if (!Array.isArray(raw) || raw.length > MAX_TEAM || !raw.every((x) => typeof x === "string" && UUID_RE.test(x))) {
        return { ok: false, error: "teamIds must be an array of up to 50 UUIDs." };
      }
      return { ok: true, value: { action: b.action, fromDay: b.from, toDay: b.to, granularity: g, teamIds: [...new Set(raw as string[])] } };
    }
    case "settings": {
      const v: AnalyticsRequest & { action: "settings" } = { action: "settings" };
      if (b.hoursPerDay !== undefined) {
        if (typeof b.hoursPerDay !== "number" || !Number.isFinite(b.hoursPerDay) || b.hoursPerDay <= 0 || b.hoursPerDay > 24) {
          return { ok: false, error: "hoursPerDay must be greater than 0 and at most 24." };
        }
        v.hoursPerDay = Math.round(b.hoursPerDay * 100) / 100;
      }
      if (b.digestEnabled !== undefined) {
        if (typeof b.digestEnabled !== "boolean") return { ok: false, error: "digestEnabled must be a boolean." };
        v.digestEnabled = b.digestEnabled;
      }
      if (b.alertsEnabled !== undefined) {
        if (typeof b.alertsEnabled !== "boolean") return { ok: false, error: "alertsEnabled must be a boolean." };
        v.alertsEnabled = b.alertsEnabled;
      }
      if (b.digestCadence !== undefined) {
        if (b.digestCadence !== "weekly" && b.digestCadence !== "monthly") return { ok: false, error: "digestCadence must be weekly or monthly." };
        v.digestCadence = b.digestCadence;
      }
      return { ok: true, value: v };
    }
    case "ack":
      if (typeof b.alertId !== "string" || !UUID_RE.test(b.alertId)) return { ok: false, error: "alertId must be a UUID." };
      return { ok: true, value: { action: "ack", alertId: b.alertId } };
    case "event": {
      const e = sanitizeAnalyticsEvent(b.name, b.props);
      return e ? { ok: true, value: { action: "event", name: e.name, props: e.props } } : { ok: false, error: "Unknown event." };
    }
    default:
      return { ok: false, error: "Unknown action." };
  }
}

/** Founder dashboard request. */
export type FounderRequest =
  | { action: "get"; month: string | null; activationDays: number }
  | { action: "upsert_input"; month: string; spendCents: number; grossMarginBp: number; platformFeeCents: number; note: string | null };

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_CENTS = 1_000_000_000_000; // 10 billion dollars: sanity ceiling against typos

export function parseFounderRequest(body: unknown): Parsed<FounderRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid request body." };
  const b = body as Record<string, unknown>;
  if (b.action === "get") {
    if (b.month !== undefined && b.month !== null && (typeof b.month !== "string" || !MONTH_RE.test(b.month))) return { ok: false, error: "month must be YYYY-MM." };
    const d = b.activationDays ?? 14;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 90) return { ok: false, error: "activationDays must be an integer 1..90." };
    return { ok: true, value: { action: "get", month: (b.month as string | null | undefined) ?? null, activationDays: d } };
  }
  if (b.action === "upsert_input") {
    if (typeof b.month !== "string" || !MONTH_RE.test(b.month)) return { ok: false, error: "month must be YYYY-MM." };
    const money = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_CENTS;
    if (!money(b.spendCents) || !money(b.platformFeeCents)) return { ok: false, error: "Amounts must be whole cents between 0 and 1e12." };
    if (typeof b.grossMarginBp !== "number" || !Number.isInteger(b.grossMarginBp) || b.grossMarginBp < 0 || b.grossMarginBp > 10000) {
      return { ok: false, error: "grossMarginBp must be an integer 0..10000." };
    }
    if (b.note !== undefined && b.note !== null && (typeof b.note !== "string" || b.note.length > 500)) return { ok: false, error: "note is limited to 500 characters." };
    return { ok: true, value: { action: "upsert_input", month: b.month, spendCents: b.spendCents as number, grossMarginBp: b.grossMarginBp, platformFeeCents: b.platformFeeCents as number, note: (b.note as string | null | undefined) ?? null } };
  }
  return { ok: false, error: "Unknown action." };
}
