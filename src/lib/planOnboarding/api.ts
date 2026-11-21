// src/lib/planOnboarding/api.ts
//
// Thin client for the plan step: state/intent through the SECURITY DEFINER RPCs (20290307000000_plan_onboarding.sql) and
// checkout through the existing create-checkout-session edge function (source: 'onboarding').
// Nothing here changes entitlements. The client only ever READS the result of the verified Stripe webhook.

import { supabase } from '@/lib/supabase';
import type { BillingCycle } from '@/lib/pricing';
import { DEFAULT_BILLING, parseBillingParam, parsePlanParam, type SelectablePlanId } from './intent';

export type TrialMode = 'card_required' | 'no_card' | 'none';
export type PlanStepName = 'plan' | 'checkout' | 'done' | 'skipped' | 'sales';

export interface PlanPolicy {
  trialMode: TrialMode;
  allowSkip: boolean;
  reminderDelayHours: number;
}

export interface PlanOnboardingState {
  canUseStep: boolean;
  shouldPrompt: boolean;
  showResume: boolean;
  reason: string;
  step: PlanStepName;
  plan: SelectablePlanId | null;
  billing: BillingCycle;
  source: string | null;
  sizeAnswers: { monthlyCalls?: number; technicians?: number; locations?: number };
  reminderConsent: boolean;
  trialEligible: boolean;
  policy: PlanPolicy;
}

/** Fail-closed defaults: an unreadable answer never prompts, never offers a trial, never blocks the dashboard. */
export const SAFE_STATE: PlanOnboardingState = {
  canUseStep: false,
  shouldPrompt: false,
  showResume: false,
  reason: 'unavailable',
  step: 'plan',
  plan: null,
  billing: DEFAULT_BILLING,
  source: null,
  sizeAnswers: {},
  reminderConsent: false,
  trialEligible: false,
  policy: { trialMode: 'card_required', allowSkip: true, reminderDelayHours: 24 },
};

const STEPS: readonly PlanStepName[] = ['plan', 'checkout', 'done', 'skipped', 'sales'];
const MODES: readonly TrialMode[] = ['card_required', 'no_card', 'none'];
const asBool = (v: unknown): boolean => v === true;
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asCount = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

export function parsePlanState(raw: unknown): PlanOnboardingState {
  const r = asObj(raw);
  if (Object.keys(r).length === 0) return SAFE_STATE;
  const policy = asObj(r.policy);
  const answers = asObj(r.size_answers);
  const step = STEPS.find((s) => s === r.step) ?? 'plan';
  const mode = MODES.find((m) => m === policy.trial_mode) ?? SAFE_STATE.policy.trialMode;
  const delay = asCount(policy.reminder_delay_hours);
  const sizeAnswers: PlanOnboardingState['sizeAnswers'] = {};
  const calls = asCount(answers.monthly_calls);
  const techs = asCount(answers.technicians);
  const locs = asCount(answers.locations);
  if (calls !== undefined) sizeAnswers.monthlyCalls = calls;
  if (techs !== undefined) sizeAnswers.technicians = techs;
  if (locs !== undefined) sizeAnswers.locations = locs;
  return {
    canUseStep: asBool(r.can_use_step),
    shouldPrompt: asBool(r.should_prompt),
    showResume: asBool(r.show_resume),
    reason: typeof r.reason === 'string' ? r.reason : 'unknown',
    step,
    plan: parsePlanParam(r.plan),
    billing: parseBillingParam(r.billing) ?? DEFAULT_BILLING,
    source: typeof r.source === 'string' ? r.source : null,
    sizeAnswers,
    reminderConsent: asBool(r.reminder_consent),
    trialEligible: asBool(r.trial_eligible),
    policy: {
      trialMode: mode,
      allowSkip: policy.allow_skip === undefined ? SAFE_STATE.policy.allowSkip : asBool(policy.allow_skip),
      reminderDelayHours: delay && delay >= 1 ? delay : SAFE_STATE.policy.reminderDelayHours,
    },
  };
}

// ---- cache shared by the dashboard gate and the resume banner (one RPC per minute, not one per mount) ----------------
const CACHE_TTL_MS = 60_000;
let cache: { userId: string; at: number; state: PlanOnboardingState } | null = null;
let inflight: { userId: string; p: Promise<PlanOnboardingState> } | null = null;

export function invalidatePlanState(): void {
  cache = null;
  inflight = null;
}

export async function fetchPlanState(): Promise<PlanOnboardingState> {
  const { data, error } = await supabase.rpc('plan_onboarding_state');
  if (error) throw new Error(error.message);
  return parsePlanState(data);
}

/** Cached read for passive consumers. Fails open: on any error the dashboard behaves as before this feature. */
export async function getPlanStateCached(userId: string, now = Date.now()): Promise<PlanOnboardingState> {
  if (cache && cache.userId === userId && now - cache.at < CACHE_TTL_MS) return cache.state;
  if (inflight && inflight.userId === userId) return inflight.p;
  const p = fetchPlanState()
    .then((state) => {
      cache = { userId, at: Date.now(), state };
      return state;
    })
    .catch(() => SAFE_STATE)
    .finally(() => {
      if (inflight?.p === p) inflight = null;
    });
  inflight = { userId, p };
  return p;
}

export interface SaveIntentArgs {
  plan: SelectablePlanId;
  billing: BillingCycle;
  source: string;
  step?: 'plan' | 'sales';
  answers?: { monthlyCalls?: number | null; technicians?: number | null; locations?: number | null } | null;
  reminderConsent?: boolean | null;
}

export async function savePlanIntent(a: SaveIntentArgs): Promise<void> {
  const { error } = await supabase.rpc('save_plan_intent', {
    p_plan: a.plan,
    p_billing: a.billing,
    p_source: a.source,
    p_step: a.step ?? 'plan',
    p_answers: a.answers
      ? { monthly_calls: a.answers.monthlyCalls ?? null, technicians: a.answers.technicians ?? null, locations: a.answers.locations ?? null }
      : null,
    p_reminder_consent: a.reminderConsent ?? null,
  });
  invalidatePlanState();
  if (error) throw new Error(error.message);
}

export async function skipPlanStep(): Promise<void> {
  const { error } = await supabase.rpc('skip_plan_step');
  invalidatePlanState();
  if (error) throw new Error(error.message);
}

// ---- checkout -------------------------------------------------------------------------------------------------------
export type CheckoutErrorCode =
  | 'rate_limited' | 'promo_invalid' | 'annual_unavailable' | 'not_eligible' | 'not_configured' | 'unavailable';

export type CheckoutResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'already_subscribed' }
  | { kind: 'error'; code: CheckoutErrorCode };

const CODES: readonly CheckoutErrorCode[] = ['rate_limited', 'promo_invalid', 'annual_unavailable', 'not_eligible', 'not_configured', 'unavailable'];

/** Accepts only https URLs on Stripe's checkout host, so a tampered response can never become an open redirect. */
export function isStripeCheckoutUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'checkout.stripe.com' || u.hostname.endsWith('.stripe.com'));
  } catch {
    return false;
  }
}

export function parseCheckoutBody(body: unknown): CheckoutResult {
  const b = asObj(body);
  if (b.alreadySubscribed === true || b.processing === true) return { kind: 'already_subscribed' };
  if (isStripeCheckoutUrl(b.url)) return { kind: 'redirect', url: b.url };
  const code = CODES.find((c) => c === b.code) ?? 'unavailable';
  return { kind: 'error', code };
}

async function readInvokeBody(error: unknown): Promise<unknown> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx && typeof (ctx as Response).json === 'function') {
    try {
      return await (ctx as Response).clone().json();
    } catch {
      return null;
    }
  }
  return null;
}

export async function startPlanCheckout(args: {
  plan: Exclude<SelectablePlanId, 'enterprise'>;
  billing: BillingCycle;
  promoCode?: string;
}): Promise<CheckoutResult> {
  const promo = args.promoCode?.trim();
  const { data, error } = await supabase.functions.invoke('create-checkout-session', {
    body: { planId: args.plan, billing: args.billing, source: 'onboarding', ...(promo ? { promoCode: promo } : {}) },
  });
  invalidatePlanState();
  if (error) return parseCheckoutBody(await readInvokeBody(error));
  return parseCheckoutBody(data);
}

/** Asks the server whether the open Stripe session is still usable (expired sessions send the user back to step "plan"). */
export async function reconcilePlanCheckout(): Promise<'open' | 'complete' | 'expired' | 'none'> {
  const { data, error } = await supabase.functions.invoke('create-checkout-session', {
    body: { source: 'onboarding', action: 'reconcile' },
  });
  invalidatePlanState();
  if (error) return 'none';
  const o = asObj(data).outcome;
  return o === 'open' || o === 'complete' || o === 'expired' ? o : 'none';
}
