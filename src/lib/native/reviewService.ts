// src/lib/native/reviewService.ts — persists review-prompt state and asks the OS to show its
// native rating sheet after a success moment (job completed). Policy lives in reviewPrompt.ts.
// The OS decides whether the sheet really appears (Apple/Google rate-limit it), so we never
// promise one and never ask from a button labelled "rate us".

import { isNative } from './platform';
import { shouldAskForReview, type ReviewState } from './reviewPrompt';

const KEY = 'vireek:review-state:v1';
const ASK_DELAY_MS = 2500;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

export function parseReviewState(raw: string | null, now: number): ReviewState {
  const fresh: ReviewState = { installedAt: now, lastPromptedAt: null, promptCount: 0, completedJobs: 0, lastErrorAt: null };
  if (!raw) return fresh;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    return {
      installedAt: num(p.installedAt) ?? now,
      lastPromptedAt: num(p.lastPromptedAt),
      promptCount: count(p.promptCount),
      completedJobs: count(p.completedJobs),
      lastErrorAt: num(p.lastErrorAt),
    };
  } catch {
    return fresh;
  }
}

function load(now: number): ReviewState {
  try {
    return parseReviewState(window.localStorage.getItem(KEY), now);
  } catch {
    return parseReviewState(null, now);
  }
}

function save(state: ReviewState): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode — the prompt simply never qualifies */
  }
}

export function recordError(now: number = Date.now()): void {
  if (!isNative()) return;
  save({ ...load(now), lastErrorAt: now });
}

export async function maybeAskForReview(now: number = Date.now()): Promise<boolean> {
  if (!isNative()) return false;
  const state = load(now);
  if (!shouldAskForReview(state, now)) return false;
  // Persist BEFORE asking so a crash or double trigger can never prompt twice.
  save({ ...state, lastPromptedAt: now, promptCount: state.promptCount + 1 });
  try {
    const { InAppReview } = await import('@capacitor-community/in-app-review');
    await InAppReview.requestReview();
    return true;
  } catch {
    return false;
  }
}

/** Call after a job reaches "completed" successfully. */
export function onJobCompleted(now: number = Date.now()): void {
  if (!isNative()) return;
  const state = load(now);
  save({ ...state, completedJobs: state.completedJobs + 1 });
  window.setTimeout(() => void maybeAskForReview(), ASK_DELAY_MS);
}
