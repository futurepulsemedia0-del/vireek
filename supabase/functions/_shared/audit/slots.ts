// supabase/functions/_shared/audit/slots.ts
//
// Pure planner + validator for the (up to) 3 test calls, and the dial-time gate.
//
// Safety rules, all enforced here AND re-checked at dial time:
//   * Every call window sits fully inside 08:00-21:00 local (the federal calling floor), even though the owner
//     asked for the call. Counsel may relax this; the code never does it silently.
//   * One call per condition, hard cap 3, never closer than 90 minutes apart, at least 5 minutes and at most
//     14 days ahead, and each is dialed at most once (the DB enforces UNIQUE(audit_id, slot)).
//   * The "after-hours" call must really be outside the owner's stated hours. If no safe after-hours window
//     exists (e.g. open until 21:00) the condition is reported as NOT TESTABLE, never faked.

import { federalHolidayKeys, isValidTimezone, parseHHMM, timezoneFromPhone, zonedParts, zonedToUtc } from "../messaging/quietHoursCore.ts";
import { SLOT_OF, type BusinessHours, type Condition, type PlannedSlot } from "./types.ts";

export const SAFE_WINDOW = { startMin: 8 * 60, endMin: 21 * 60 } as const;
export const GRACE_MIN = 30;
export const MIN_LEAD_MIN = 5;
export const MAX_HORIZON_DAYS = 14;
export const MIN_GAP_MIN = 90;
export const DEFAULT_HOURS: BusinessHours = { days: [1, 2, 3, 4, 5], open: "08:00", close: "17:00" };

const MIN = 60_000;
const LUNCH_VALID = { startMin: 11 * 60, endMin: 14 * 60 } as const;

export type HoursCheck =
  | { ok: true; hours: BusinessHours; openMin: number; closeMin: number }
  | { ok: false; reason: "invalid_days" | "invalid_time" | "hours_too_short" };

export function normalizeHours(raw: unknown): HoursCheck {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const days = Array.isArray(o.days) ? [...new Set(o.days.map(Number))] : [];
  if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return { ok: false, reason: "invalid_days" };
  const openMin = parseHHMM(String(o.open ?? ""));
  const closeMin = parseHHMM(String(o.close ?? ""));
  if (!Number.isFinite(openMin) || !Number.isFinite(closeMin) || openMin >= closeMin) return { ok: false, reason: "invalid_time" };
  if (closeMin - openMin < 4 * 60) return { ok: false, reason: "hours_too_short" };
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { ok: true, hours: { days: days.sort((a, b) => a - b), open: hhmm(openMin), close: hhmm(closeMin) }, openMin, closeMin };
}

const localMin = (d: Date, tz: string) => {
  const p = zonedParts(d, tz);
  return { min: p.hour * 60 + p.minute, weekday: p.weekday, dateKey: p.dateKey, year: p.year };
};

export function isOpenAt(h: BusinessHours, tz: string, at: Date): boolean {
  const l = localMin(at, tz);
  const o = parseHHMM(h.open);
  const c = parseHHMM(h.close);
  return h.days.includes(l.weekday) && l.min >= o && l.min < c;
}

const isHolidayLocal = (d: Date, tz: string): boolean => {
  const l = localMin(d, tz);
  return federalHolidayKeys(l.year).has(l.dateKey);
};

export type SlotError = "bad_condition" | "duplicate_condition" | "bad_time" | "too_soon" | "too_far" | "outside_safe_window"
  | "not_in_business_hours" | "not_at_lunch" | "not_after_hours" | "holiday" | "too_close_to_another_call" | "no_slots" | "bad_timezone";

export interface PlanInput {
  now: Date;
  timezone: string;
  hours: BusinessHours;
}

const toSlot = (condition: Condition, at: Date): PlannedSlot => ({
  condition,
  slot: SLOT_OF[condition],
  scheduledFor: at,
  windowEnd: new Date(at.getTime() + GRACE_MIN * MIN),
});

/** Checks one slot against every rule. Returns null when valid. */
export function checkSlot(input: PlanInput, s: PlannedSlot): SlotError | null {
  const { now, timezone: tz, hours } = input;
  const t = s.scheduledFor.getTime();
  if (!Number.isFinite(t)) return "bad_time";
  if (t < now.getTime() + MIN_LEAD_MIN * MIN) return "too_soon";
  if (t > now.getTime() + MAX_HORIZON_DAYS * 24 * 60 * MIN) return "too_far";
  const a = localMin(s.scheduledFor, tz);
  const b = localMin(s.windowEnd, tz);
  if (a.dateKey !== b.dateKey || a.min < SAFE_WINDOW.startMin || b.min > SAFE_WINDOW.endMin) return "outside_safe_window";
  const openStart = isOpenAt(hours, tz, s.scheduledFor);
  const openEnd = isOpenAt(hours, tz, s.windowEnd);
  if (s.condition === "business_hours") {
    if (!openStart || !openEnd) return "not_in_business_hours";
    if (a.min >= 11 * 60 + 30 && a.min < 13 * 60 + 30) return "not_in_business_hours";
    if (isHolidayLocal(s.scheduledFor, tz)) return "holiday";
  } else if (s.condition === "lunch") {
    if (!openStart || !openEnd) return "not_in_business_hours";
    if (a.min < LUNCH_VALID.startMin || b.min > LUNCH_VALID.endMin) return "not_at_lunch";
    if (isHolidayLocal(s.scheduledFor, tz)) return "holiday";
  } else if (s.condition === "after_hours") {
    if (openStart || openEnd) return "not_after_hours";
  } else return "bad_condition";
  return null;
}

export type ValidateResult = { ok: true; slots: PlannedSlot[] } | { ok: false; errors: { condition: string; reason: SlotError }[] };

/** Validates an owner-edited schedule (1-3 slots, one per condition). */
export function validateSlots(input: PlanInput, raw: { condition: string; scheduledFor: string }[]): ValidateResult {
  if (!isValidTimezone(input.timezone)) return { ok: false, errors: [{ condition: "*", reason: "bad_timezone" }] };
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, errors: [{ condition: "*", reason: "no_slots" }] };
  if (raw.length > 3) return { ok: false, errors: [{ condition: "*", reason: "duplicate_condition" }] };
  const errors: { condition: string; reason: SlotError }[] = [];
  const seen = new Set<string>();
  const slots: PlannedSlot[] = [];
  for (const r of raw) {
    if (!(r.condition in SLOT_OF)) { errors.push({ condition: String(r.condition), reason: "bad_condition" }); continue; }
    if (seen.has(r.condition)) { errors.push({ condition: r.condition, reason: "duplicate_condition" }); continue; }
    seen.add(r.condition);
    const at = new Date(r.scheduledFor);
    const slot = toSlot(r.condition as Condition, at);
    const err = Number.isFinite(at.getTime()) ? checkSlot(input, slot) : "bad_time";
    if (err) errors.push({ condition: r.condition, reason: err });
    else slots.push(slot);
  }
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      if (Math.abs(slots[i].scheduledFor.getTime() - slots[j].scheduledFor.getTime()) < MIN_GAP_MIN * MIN) {
        errors.push({ condition: slots[j].condition, reason: "too_close_to_another_call" });
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, slots: slots.sort((x, y) => x.scheduledFor.getTime() - y.scheduledFor.getTime()) };
}

function localDay(now: Date, tz: string, offset: number): { y: number; m: number; d: number } {
  const p = zonedParts(now, tz);
  const t = new Date(Date.UTC(p.year, p.month - 1, p.day + offset));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export interface Plan {
  slots: PlannedSlot[];
  /** Conditions that could not be scheduled safely, with why (shown to the owner, never hidden). */
  untestable: { condition: Condition; reason: "hours_dont_cover_lunch" | "no_safe_after_hours_window" | "no_open_day" }[];
}

/** Proposes the earliest valid slot per condition. The owner may edit them (validateSlots re-checks). */
export function planTestSlots(input: PlanInput): Plan {
  const { now, timezone: tz, hours } = input;
  const openMin = parseHHMM(hours.open);
  const closeMin = parseHHMM(hours.close);
  const chosen: PlannedSlot[] = [];
  const untestable: Plan["untestable"] = [];

  const farEnough = (at: Date) => chosen.every((c) => Math.abs(c.scheduledFor.getTime() - at.getTime()) >= MIN_GAP_MIN * MIN);
  const tryFind = (condition: Condition, candidatesForDay: (weekdayOpen: boolean) => number[]): boolean => {
    for (let off = 0; off < MAX_HORIZON_DAYS; off++) {
      const { y, m, d } = localDay(now, tz, off);
      const probe = zonedToUtc(y, m, d, 12, 0, tz);
      const weekday = zonedParts(probe, tz).weekday;
      for (const minute of candidatesForDay(hours.days.includes(weekday))) {
        const at = zonedToUtc(y, m, d, Math.floor(minute / 60), minute % 60, tz);
        const slot = toSlot(condition, at);
        if (checkSlot(input, slot) === null && farEnough(at)) {
          chosen.push(slot);
          return true;
        }
      }
    }
    return false;
  };

  if (!tryFind("business_hours", (open) => (open ? [10 * 60, 15 * 60, openMin + 60] : []))) untestable.push({ condition: "business_hours", reason: "no_open_day" });

  if (openMin > 11 * 60 + 30 || closeMin < 13 * 60 + 30) untestable.push({ condition: "lunch", reason: "hours_dont_cover_lunch" });
  else if (!tryFind("lunch", (open) => (open ? [12 * 60 + 15, 11 * 60 + 45] : []))) untestable.push({ condition: "lunch", reason: "no_open_day" });

  // After-hours: right after closing on an open day (most realistic), else mid-morning on a closed day.
  const afterOk = tryFind("after_hours", (open) => (open ? [closeMin + 30] : [10 * 60]));
  if (!afterOk) untestable.push({ condition: "after_hours", reason: "no_safe_after_hours_window" });

  return { slots: chosen.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime()), untestable };
}

export type DialGate = { ok: true } | { ok: false; reason: "before_window" | "window_passed" | "outside_calling_hours" | "bad_timezone" };

/**
 * Last check before ANY dial. Uses the strictest of the owner's timezone and the timezone implied by the number's
 * area code, so a wrongly-chosen timezone can never push a call outside 08:00-21:00 for the person called.
 */
export function canDialNow(now: Date, call: { scheduledFor: Date; windowEnd: Date }, timezone: string, phoneE164: string): DialGate {
  if (!isValidTimezone(timezone)) return { ok: false, reason: "bad_timezone" };
  if (now.getTime() < call.scheduledFor.getTime()) return { ok: false, reason: "before_window" };
  if (now.getTime() >= call.windowEnd.getTime()) return { ok: false, reason: "window_passed" };
  const zones = [timezone];
  const byPhone = timezoneFromPhone(phoneE164);
  if (byPhone && isValidTimezone(byPhone) && byPhone !== timezone) zones.push(byPhone);
  for (const z of zones) {
    const l = localMin(now, z);
    if (l.min < SAFE_WINDOW.startMin || l.min >= SAFE_WINDOW.endMin) return { ok: false, reason: "outside_calling_hours" };
  }
  return { ok: true };
}
