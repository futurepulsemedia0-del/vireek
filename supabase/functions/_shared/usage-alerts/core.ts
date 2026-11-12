// supabase/functions/_shared/usage-alerts/core.ts
// Pure alert logic (no I/O, no Deno globals): period key, thresholds, once-per-period planning, channel plan.

export const USAGE_ALERT_KINDS = [
  "minutes_80", "minutes_100", "overage_started", "sms_80", "sms_100",
  "seat_limit", "location_limit", "number_limit",
] as const;
export type UsageAlertKind = (typeof USAGE_ALERT_KINDS)[number];
export type MinutesKind = "minutes_80" | "minutes_100";
export type LimitKind = "seat_limit" | "location_limit" | "number_limit";
export type ChannelName = "in_app" | "email" | "push" | "sms";
/** sent | deferred | skipped:<reason> | failed:<reason>. Only failed:* is retried. */
export type ChannelMap = Partial<Record<ChannelName, string>>;

/** Which channels each kind uses. 80% = in-app + email. 100% adds push and SMS. Limits = in-app + email. */
export const CHANNEL_PLAN: Record<UsageAlertKind, readonly ChannelName[]> = {
  minutes_80: ["in_app", "email"],
  minutes_100: ["in_app", "email", "push", "sms"],
  seat_limit: ["in_app", "email"],
  location_limit: ["in_app", "email"],
  number_limit: ["in_app", "email"],
  // Reserved: no verified overage-billing policy flag or SMS-usage meter exists in the repo yet.
  overage_started: [],
  sms_80: [],
  sms_100: [],
};

/** Billing period key. The repo has no usage_periods table; the meter is a UTC calendar-month counter. */
export function usagePeriodKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

function nonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** included + bonus. `bonus_minutes` does not exist in the schema today; it is honoured if it ever appears. */
export function effectiveIncludedMinutes(p: { minutes_included?: unknown; bonus_minutes?: unknown }): number {
  return nonNegInt(p.minutes_included) + nonNegInt(p.bonus_minutes);
}

/** Integer-only math: 80% is `used*100 >= included*80`. 100% is `used >= included`. Unlimited/zero => none. */
export function usageThresholdsReached(used: unknown, included: unknown): MinutesKind[] {
  const u = nonNegInt(used);
  const i = nonNegInt(included);
  if (i <= 0) return [];
  const out: MinutesKind[] = [];
  if (u * 100 >= i * 80) out.push("minutes_80");
  if (u >= i) out.push("minutes_100");
  return out;
}

export function usagePercent(used: unknown, included: unknown): number {
  const i = nonNegInt(included);
  return i > 0 ? Math.floor((nonNegInt(used) * 100) / i) : 0;
}

export interface SendPlan {
  send: MinutesKind[];
  /** Thresholds crossed in the same run as a higher one: recorded as done, never sent (no double email). */
  superseded: MinutesKind[];
}

/** Only the highest crossed, not-yet-completed threshold is sent. */
export function planMinutesAlerts(reached: readonly MinutesKind[], completed: ReadonlySet<string>): SendPlan {
  const highest: MinutesKind | null = reached.includes("minutes_100") ? "minutes_100" : reached.includes("minutes_80") ? "minutes_80" : null;
  return {
    send: highest && !completed.has(highest) ? [highest] : [],
    superseded: reached.filter((k) => k !== highest && !completed.has(k)),
  };
}

const INACTIVE_STATUSES = new Set(["suspended", "canceled", "cancelled"]);
export function isAlertableAccount(a: { plan?: string | null; status?: string | null }): boolean {
  if (a.plan === "enterprise") return false; // unlimited minutes
  return !INACTIVE_STATUSES.has(String(a.status ?? "").toLowerCase());
}

export const isTerminalStatus = (s: string | undefined): boolean => s !== undefined && !s.startsWith("failed");

/** Channels of this kind that have no terminal outcome yet. */
export function pendingChannels(kind: UsageAlertKind, existing: ChannelMap): ChannelName[] {
  return CHANNEL_PLAN[kind].filter((c) => !isTerminalStatus(existing[c]));
}
