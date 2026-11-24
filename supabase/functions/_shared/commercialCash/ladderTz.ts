// Time-zone aware wrapper around the v1 ladder (PURE: no I/O, no Deno APIs, no Date.now()).
// Reuses nextLadderAction() unchanged: it feeds it LOCAL calendar dates, so "day 30" means 30 calendar days
// in the customer's own time zone (DST-safe: a 23h or 25h day is still one day). Adds quiet hours.

import { nextLadderAction, type LadderAction } from "./logic.ts";

const FMT = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string): Intl.DateTimeFormat {
  let f = FMT.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    FMT.set(timeZone, f);
  }
  return f;
}

export interface LocalParts { date: string; minutes: number }

/** Local calendar date (YYYY-MM-DD) and minutes after local midnight for an instant in an IANA zone. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of fmt(timeZone).formatToParts(instant)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** Quiet window [start, end) in minutes after local midnight; start > end wraps past midnight (20:00 -> 08:00). */
export function inQuietHours(minutes: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return false;
  return startMin < endMin ? minutes >= startMin && minutes < endMin : minutes >= startMin || minutes < endMin;
}

export interface LadderTzInput {
  basis: "sent" | "due";
  /** instant (basis 'sent') or YYYY-MM-DD (basis 'due') */
  anchor: string | null;
  now: Date;
  timeZone: string;
  quietStartMin: number;
  quietEndMin: number;
  ladderDays: number[];
  demandDraftAfterDays: number;
  doneReminders: number[];
  draftDone: boolean;
  stage: string;
  snoozedUntil: string | null;
}

export type LadderTzPlan =
  | { action: "none"; reason: "stopped" | "snoozed" | "nothing_due" | "no_anchor" }
  | { action: "defer"; reason: "quiet_hours"; step: LadderAction }
  | { action: "reminder" | "demand_draft"; step: LadderAction & { stepDay: number } };

const STOP_STAGES = new Set(["paid", "void", "disputed", "written_off", "rejected"]);

export function planLadderTz(i: LadderTzInput): LadderTzPlan {
  if (STOP_STAGES.has(i.stage)) return { action: "none", reason: "stopped" };
  if (i.snoozedUntil && Date.parse(i.snoozedUntil) > i.now.getTime()) return { action: "none", reason: "snoozed" };
  if (!i.anchor) return { action: "none", reason: "no_anchor" };

  const local = localParts(i.now, i.timeZone);
  const anchorDate = i.basis === "due" ? i.anchor.slice(0, 10) : localParts(new Date(i.anchor), i.timeZone).date;
  const step = nextLadderAction({
    anchor: anchorDate, today: local.date, ladderDays: i.ladderDays, demandDraftAfterDays: i.demandDraftAfterDays,
    doneReminders: i.doneReminders, draftDone: i.draftDone,
  });
  if (step.action === "none") return { action: "none", reason: "nothing_due" };
  // a demand-letter DRAFT is queued internally (never sent), so quiet hours only gate customer-facing email
  if (step.action === "reminder" && inQuietHours(local.minutes, i.quietStartMin, i.quietEndMin)) {
    return { action: "defer", reason: "quiet_hours", step };
  }
  return { action: step.action, step };
}
