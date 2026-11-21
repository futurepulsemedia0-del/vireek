// src/lib/planOnboarding/gate.ts — pure helpers for the dashboard gate (kept out of React so they are unit-testable).

import { PLAN_STEP_PATH } from './intent';
import type { PlanOnboardingState } from './api';

const DAY_MS = 86_400_000;
/** Cheap client pre-filter so long-standing accounts never pay for an RPC (the server stays the authority). */
export const NEW_ACCOUNT_WINDOW_MS = 30 * DAY_MS;

export function isLikelyNewAccount(createdAt: string | null | undefined, now: number, windowMs = NEW_ACCOUNT_WINDOW_MS): boolean {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && now - t <= windowMs;
}

export function shouldRedirectToPlanStep(state: PlanOnboardingState, pathname: string): boolean {
  return state.shouldPrompt && state.canUseStep && !pathname.startsWith(PLAN_STEP_PATH);
}

export function showResumeBanner(state: PlanOnboardingState, pathname: string): boolean {
  return state.showResume && state.canUseStep && !pathname.startsWith(PLAN_STEP_PATH);
}
