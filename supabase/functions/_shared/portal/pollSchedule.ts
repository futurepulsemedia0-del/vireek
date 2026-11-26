// supabase/functions/_shared/portal/pollSchedule.ts
// Status polling: exponential backoff on errors, jitter always, hard stop conditions.

const MIN = 60_000;
export const POLL_BASE_MS = 6 * 60 * MIN;      // healthy cadence: ~6 h
export const POLL_MAX_MS = 48 * 60 * MIN;
export const MAX_CONSECUTIVE_ERRORS = 8;
export const MAX_POLL_AGE_MS = 120 * 24 * 60 * MIN;
export const MAX_POLLS = 600;

export interface PollState { attempts: number; consecutiveErrors: number; createdAtMs: number; terminal: boolean }

/** rng must return [0,1); injectable for tests. Jitter = +/-20%. */
export function nextPollDelayMs(consecutiveErrors: number, rng: () => number = Math.random): number {
  const exp = Math.min(POLL_MAX_MS, POLL_BASE_MS * 2 ** Math.min(consecutiveErrors, 6));
  const jitter = 0.8 + rng() * 0.4;
  return Math.round(exp * jitter);
}

export type StopReason = "terminal" | "too_many_errors" | "too_old" | "too_many_polls";
export function pollStopReason(s: PollState, nowMs: number): StopReason | null {
  if (s.terminal) return "terminal";
  if (s.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return "too_many_errors";
  if (nowMs - s.createdAtMs > MAX_POLL_AGE_MS) return "too_old";
  if (s.attempts >= MAX_POLLS) return "too_many_polls";
  return null;
}
