// src/lib/planOnboarding/intent.ts
//
// Plan intent plumbing for /onboarding/plan: validated plan/billing params, the deep link that must survive sign-up and
// email verification, and the precedence used to pre-select a plan. Pure (storage is injected) so Vitest can cover it.
//
// Why two carriers: sessionStorage/localStorage survive a refresh in the same browser, but people often open the
// verification mail on their phone. So the same choice is ALSO written into the Supabase user metadata at sign-up
// (signup_plan / signup_billing), which travels with the account to any device. Everything read back is re-validated;
// nothing here ever grants anything (entitlements change only from the Stripe webhook).

import { PRICING_PLANS, type BillingCycle, type PlanId } from '@/lib/pricing';

export const PLAN_STEP_PATH = '/onboarding/plan';
export const DEFAULT_BILLING: BillingCycle = 'monthly'; // never pre-select the annual upsell

export type SelectablePlanId = Exclude<PlanId, 'free'>;

/** Derived from PRICING_PLANS (single source of truth). 'free' is the legacy no-card teaser, not selectable here. */
export const SELECTABLE_PLAN_IDS: readonly SelectablePlanId[] = PRICING_PLANS.filter((p) => p.id !== 'free').map(
  (p) => p.id as SelectablePlanId,
);

export function isSelectablePlanId(value: unknown): value is SelectablePlanId {
  return typeof value === 'string' && (SELECTABLE_PLAN_IDS as readonly string[]).includes(value);
}

export function parsePlanParam(raw: unknown): SelectablePlanId | null {
  return typeof raw === 'string' && isSelectablePlanId(raw.trim().toLowerCase()) ? (raw.trim().toLowerCase() as SelectablePlanId) : null;
}

export function parseBillingParam(raw: unknown): BillingCycle | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return v === 'monthly' || v === 'annual' ? v : null;
}

const SOURCE_RE = /^[a-z0-9_]{1,32}$/;
export function safeSource(raw: unknown, fallback = 'plan_step'): string {
  return typeof raw === 'string' && SOURCE_RE.test(raw) ? raw : fallback;
}

export interface PlanDeepLink {
  plan: SelectablePlanId;
  billing: BillingCycle;
  source: string;
}

/** `/signup?plan=professional&billing=annual` — used by /pricing for visitors who are not signed in. */
export function buildSignupPath(plan: unknown, billing: unknown): string {
  const p = parsePlanParam(plan);
  if (!p) return '/signup';
  const b = parseBillingParam(billing) ?? DEFAULT_BILLING;
  return `/signup?plan=${p}&billing=${b}`;
}

export function deepLinkFromSearch(search: string | URLSearchParams, source = 'pricing_page'): PlanDeepLink | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const plan = parsePlanParam(params.get('plan'));
  if (!plan) return null;
  return { plan, billing: parseBillingParam(params.get('billing')) ?? DEFAULT_BILLING, source: safeSource(source, 'pricing_page') };
}

// ---- browser storage (injected for tests) ---------------------------------------------------------------------------
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function safeLocalStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null; // Safari private mode / blocked storage
  }
}

export const DEEP_LINK_KEY = 'vireek_plan_deeplink_v1';
export const DEEP_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function saveDeepLink(link: PlanDeepLink, storage: StorageLike | null = safeLocalStorage(), now = Date.now()): void {
  if (!storage) return;
  try {
    storage.setItem(DEEP_LINK_KEY, JSON.stringify({ ...link, savedAt: now }));
  } catch {
    /* non-fatal: the user metadata copy still carries the choice */
  }
}

export function readDeepLink(storage: StorageLike | null = safeLocalStorage(), now = Date.now()): PlanDeepLink | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(DEEP_LINK_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { plan?: unknown; billing?: unknown; source?: unknown; savedAt?: unknown };
    const plan = parsePlanParam(v.plan);
    const billing = parseBillingParam(v.billing);
    const savedAt = typeof v.savedAt === 'number' ? v.savedAt : 0;
    if (!plan || !billing || now - savedAt > DEEP_LINK_TTL_MS || now < savedAt) {
      storage.removeItem(DEEP_LINK_KEY);
      return null;
    }
    return { plan, billing, source: safeSource(v.source, 'pricing_page') };
  } catch {
    return null; // corrupt JSON is treated as "nothing stored"
  }
}

export function clearDeepLink(storage: StorageLike | null = safeLocalStorage()): void {
  try {
    storage?.removeItem(DEEP_LINK_KEY);
  } catch {
    /* non-fatal */
  }
}

// ---- Supabase user metadata (travels to another device) -------------------------------------------------------------
export function signupMetadata(link: PlanDeepLink | null): Record<string, string> {
  return link ? { signup_plan: link.plan, signup_billing: link.billing, signup_plan_source: link.source } : {};
}

export function deepLinkFromMetadata(meta: unknown): PlanDeepLink | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  const plan = parsePlanParam(m.signup_plan);
  if (!plan) return null;
  return {
    plan,
    billing: parseBillingParam(m.signup_billing) ?? DEFAULT_BILLING,
    source: safeSource(m.signup_plan_source, 'pricing_page'),
  };
}

// ---- pre-selection precedence ---------------------------------------------------------------------------------------
export type SelectionOrigin = 'url' | 'server' | 'deep_link' | 'metadata' | 'none';

export interface InitialSelection {
  plan: SelectablePlanId | null;
  billing: BillingCycle;
  origin: SelectionOrigin;
}

/**
 * 1. an explicit ?plan= on /onboarding/plan   2. the plan intent already saved on the server (resume)
 * 3. the browser deep link                    4. the sign-up metadata (verified on another device)
 * Billing follows the winning source; when that source has none, monthly.
 */
export function resolveInitialSelection(input: {
  urlPlan?: unknown;
  urlBilling?: unknown;
  server?: { plan: unknown; billing: unknown } | null;
  deepLink?: PlanDeepLink | null;
  metadata?: PlanDeepLink | null;
}): InitialSelection {
  const urlPlan = parsePlanParam(input.urlPlan);
  if (urlPlan) return { plan: urlPlan, billing: parseBillingParam(input.urlBilling) ?? DEFAULT_BILLING, origin: 'url' };

  const serverPlan = parsePlanParam(input.server?.plan);
  if (serverPlan) return { plan: serverPlan, billing: parseBillingParam(input.server?.billing) ?? DEFAULT_BILLING, origin: 'server' };

  if (input.deepLink) return { plan: input.deepLink.plan, billing: input.deepLink.billing, origin: 'deep_link' };
  if (input.metadata) return { plan: input.metadata.plan, billing: input.metadata.billing, origin: 'metadata' };

  // A billing preference with no plan is still honoured (e.g. /onboarding/plan?billing=annual).
  return { plan: null, billing: parseBillingParam(input.urlBilling) ?? DEFAULT_BILLING, origin: 'none' };
}
