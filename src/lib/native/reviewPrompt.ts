// src/lib/native/reviewPrompt.ts — WHEN to ask for an app-store rating (pure, unit tested).
// Ask only after a genuine success moment, never mid-task, never after an error, and rarely.

export interface ReviewState {
  installedAt: number;
  lastPromptedAt: number | null;
  promptCount: number;
  completedJobs: number;
  lastErrorAt: number | null;
}

const DAY = 86_400_000;
export const REVIEW_MIN_DAYS_INSTALLED = 7;
export const REVIEW_MIN_COMPLETED_JOBS = 5;
export const REVIEW_COOLDOWN_DAYS = 120;
export const REVIEW_MAX_PROMPTS = 3;
export const REVIEW_QUIET_AFTER_ERROR_MS = 3 * DAY;

export function shouldAskForReview(s: ReviewState, now: number): boolean {
  if (s.promptCount >= REVIEW_MAX_PROMPTS) return false;
  if (now - s.installedAt < REVIEW_MIN_DAYS_INSTALLED * DAY) return false;
  if (s.completedJobs < REVIEW_MIN_COMPLETED_JOBS) return false;
  if (s.lastPromptedAt !== null && now - s.lastPromptedAt < REVIEW_COOLDOWN_DAYS * DAY) return false;
  if (s.lastErrorAt !== null && now - s.lastErrorAt < REVIEW_QUIET_AFTER_ERROR_MS) return false;
  return true;
}
