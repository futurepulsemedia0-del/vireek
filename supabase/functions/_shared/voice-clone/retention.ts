// Retention rules for cloned voices. Pure: no I/O, never reads the clock (callers pass `now`).
// No imports on purpose, so the browser (CloneRetentionControl) and Deno share one copy.
//
// The numbers below are PRODUCT DEFAULTS, not legal advice. The right default and the allowed range are [COUNSEL]
// (see docs/compliance/voice-clone-data.md). The database enforces the same bounds (CHECK on retention_days).

export const RETENTION_MIN_DAYS = 7;
export const RETENTION_MAX_DAYS = 730;
export const RETENTION_DEFAULT_DAYS = 365;
/** Choices offered in the UI. Any integer within the bounds is accepted by the server. */
export const RETENTION_PRESETS = [30, 90, 180, 365, 730] as const;
/** The owner is warned when this many days (or fewer) remain. Index + 1 is the stored `expiry_notice_stage`. */
export const NOTICE_THRESHOLDS_DAYS = [30, 7, 1] as const;
/** After this many failed purge attempts a row stops being retried automatically and needs a person. */
export const MAX_PURGE_ATTEMPTS = 30;
/** Restore of the live assistant may be retried this many times before deletion goes ahead anyway. */
export const MAX_RESTORE_DEFERRALS = 3;

const DAY_MS = 86_400_000;

export type RetentionErrorCode = "retention_invalid" | "retention_out_of_range";
export type RetentionCheck = { ok: true; days: number } | { ok: false; code: RetentionErrorCode };

/** Accepts an integer number or a string of digits; rejects everything else (floats, NaN, booleans, null, objects). */
export function parseRetentionDays(input: unknown): RetentionCheck {
  let n: number;
  if (typeof input === "number") n = input;
  else if (typeof input === "string" && /^\d{1,4}$/.test(input.trim())) n = Number(input.trim());
  else return { ok: false, code: "retention_invalid" };
  if (!Number.isInteger(n)) return { ok: false, code: "retention_invalid" };
  if (n < RETENTION_MIN_DAYS || n > RETENTION_MAX_DAYS) return { ok: false, code: "retention_out_of_range" };
  return { ok: true, days: n };
}

/** Retention may be shortened at any time; lengthening needs a fresh consent. */
export function canShorten(currentDays: number, nextDays: number): boolean {
  return Number.isInteger(nextDays) && nextDays >= RETENTION_MIN_DAYS && nextDays <= currentDays;
}

/** approvedAt + days, in exact 24 h steps (matches the SQL trigger, which uses make_interval(secs => days * 86400)). */
export function computeExpiry(approvedAt: Date | string | number, days: number): Date {
  const t = approvedAt instanceof Date ? approvedAt.getTime() : new Date(approvedAt).getTime();
  if (!Number.isFinite(t)) throw new Error("invalid_approved_at");
  return new Date(t + days * DAY_MS);
}

function toMs(v: Date | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** True when the retention period has ended. A missing or unparseable expiry is NOT due (fail safe: never delete on bad data). */
export function isRetentionDue(expiresAt: Date | string | null | undefined, now: Date): boolean {
  const t = toMs(expiresAt);
  return t !== null && t <= now.getTime();
}

/** Whole days left, rounded up (0 once due). null when there is no valid expiry. */
export function daysRemaining(expiresAt: Date | string | null | undefined, now: Date): number | null {
  const t = toMs(expiresAt);
  if (t === null) return null;
  return Math.max(0, Math.ceil((t - now.getTime()) / DAY_MS));
}

/** 0 = no warning due yet, 1 = 30-day warning, 2 = 7-day warning, 3 = 1-day warning. */
export function noticeStageFor(daysLeft: number | null): 0 | 1 | 2 | 3 {
  if (daysLeft === null) return 0;
  if (daysLeft <= NOTICE_THRESHOLDS_DAYS[2]) return 3;
  if (daysLeft <= NOTICE_THRESHOLDS_DAYS[1]) return 2;
  if (daysLeft <= NOTICE_THRESHOLDS_DAYS[0]) return 1;
  return 0;
}
