// Pure helpers that turn raw operational rows into the numbers the scoring
// rules use. No I/O, no Deno APIs - unit-tested with vitest.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A job counts as a "same-day change" when it is moved inside this window around its ORIGINAL start. */
export const SAME_DAY_LEAD_MS = 24 * HOUR;
export const SAME_DAY_LAG_MS = 1 * HOUR;
/** An office reply slower than this (or missing) makes a technician request "unanswered". */
export const OFFICE_REPLY_SLA_MS = 4 * HOUR;
/** Consecutive technician messages in one thread within this gap are one request. */
const REQUEST_BURST_MS = 30 * 60_000;

// ---------------------------------------------------------------- schedule changes
/** True when a reschedule was made within 24h before (or 1h after) the job's original start. */
export function isSameDayChange(previousScheduledIso: string, changedAtIso: string): boolean {
  const prev = Date.parse(previousScheduledIso);
  const changed = Date.parse(changedAtIso);
  if (!Number.isFinite(prev) || !Number.isFinite(changed)) return false;
  const lead = prev - changed; // ms between the change and the original start
  return lead <= SAME_DAY_LEAD_MS && lead >= -SAME_DAY_LAG_MS;
}

// ---------------------------------------------------------------- on-call
export interface OnCallSchedule {
  rotation_type: "daily" | "weekly";
  timezone: string;
  /** YYYY-MM-DD */
  rotation_start_date: string;
  handoff_hour: number;
  /** position (0..n-1) -> team_member_id, exactly like on_call_schedule_members */
  members: { position: number; team_member_id: string }[];
}

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock `date` + `hour` in `timeZone` -> UTC ms. Falls back to UTC for an unknown zone. */
export function zonedToUtcMs(date: string, hour: number, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const naive = Date.UTC(y, (m || 1) - 1, d || 1, hour);
  try {
    const first = naive - tzOffsetMs(naive, timeZone);
    return naive - tzOffsetMs(first, timeZone);
  } catch {
    return naive;
  }
}

/**
 * Days each technician spent on call inside [windowStart, windowEnd).
 * Mirrors public.get_current_on_call(): period index = floor((t - start)/length),
 * clamped to 0 before the rotation starts; member = positions[index % n].
 */
export function onCallDaysByTech(schedules: OnCallSchedule[], windowStartMs: number, windowEndMs: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of schedules) {
    const n = s.members.length;
    if (n === 0 || windowEndMs <= windowStartMs) continue;
    const byPos = new Map(s.members.map((m) => [m.position, m.team_member_id]));
    const length = (s.rotation_type === "daily" ? 1 : 7) * DAY;
    const start = zonedToUtcMs(s.rotation_start_date, s.handoff_hour, s.timezone);
    let t = windowStartMs;
    while (t < windowEndMs) {
      const k = Math.max(0, Math.floor((t - start) / length));
      const segEnd = Math.min(start + (k + 1) * length, windowEndMs);
      const who = byPos.get(k % n);
      if (who) out.set(who, (out.get(who) ?? 0) + (segEnd - t) / DAY);
      t = segEnd;
    }
  }
  return out;
}

// ---------------------------------------------------------------- office requests
export interface ThreadMessage {
  job_id: string;
  sender_role: "technician" | "office";
  tech_id: string | null;
  at: number;
}
export interface TechRequest { tech_id: string; asked_at: number; replied_at: number | null }

/** Collapse a message log into technician requests and the office reply (if any) to each. */
export function summarizeRequests(messages: ThreadMessage[]): TechRequest[] {
  const byJob = new Map<string, ThreadMessage[]>();
  for (const m of messages) {
    const list = byJob.get(m.job_id);
    if (list) list.push(m); else byJob.set(m.job_id, [m]);
  }
  const requests: TechRequest[] = [];
  for (const list of byJob.values()) {
    list.sort((a, b) => a.at - b.at);
    let open: TechRequest | null = null;
    let lastTechAt = 0;
    for (const m of list) {
      if (m.sender_role === "office") {
        if (open) { open.replied_at = m.at; open = null; }
      } else if (m.tech_id) {
        if (open && m.at - lastTechAt < REQUEST_BURST_MS) { lastTechAt = m.at; continue; }
        open = { tech_id: m.tech_id, asked_at: m.at, replied_at: null };
        requests.push(open);
        lastTechAt = m.at;
      }
    }
  }
  return requests;
}

/** Requests with no office reply inside the SLA (late replies count). */
export function isUnanswered(r: TechRequest, nowMs: number): boolean {
  if (r.replied_at !== null) return r.replied_at - r.asked_at > OFFICE_REPLY_SLA_MS;
  return nowMs - r.asked_at >= OFFICE_REPLY_SLA_MS;
}

// ---------------------------------------------------------------- earnings
export interface EarningEvent { at: number; cents: number }

/** Sum events into the last 28 days vs the 28 days before that. */
export function splitEarnings(events: EarningEvent[], nowMs: number): { recent: number; prior: number } {
  let recent = 0;
  let prior = 0;
  for (const e of events) {
    const age = nowMs - e.at;
    if (age < 0) continue;
    if (age < 28 * DAY) recent += e.cents;
    else if (age < 56 * DAY) prior += e.cents;
  }
  return { recent, prior };
}

export function hourlyPayCents(rateCents: number, multiplier: number, regularHours: number, overtimeHours: number): number {
  return Math.round(rateCents * regularHours + rateCents * multiplier * overtimeHours);
}

/** Monday 00:00 UTC of the week containing `d`, as YYYY-MM-DD. */
export function weekStartUtc(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  return new Date(monday).toISOString().slice(0, 10);
}
