/**
 * Public membership signup — /join/:planSlug
 *
 * Client side of the end-customer flow: read a publicly-enabled plan,
 * validate the signup form, and start a Stripe Checkout session through
 * the membership-join-checkout edge function. Pure helpers are exported
 * so they can be unit-tested without a browser.
 *
 * Server counterparts:
 *  - supabase/migrations/20270411000000_membership_public_join.sql
 *  - supabase/functions/membership-join-checkout
 */

import { supabase } from './supabase';
import { toMonthlyCents } from './memberships';

// ============================================================
// TYPES
// ============================================================

export interface PublicMembershipPlan {
  slug: string;
  business_name: string | null;
  name: string;
  price_cents: number;
  billing_interval: 'monthly' | 'yearly';
  benefits: string[];
  visits_included_per_period: number;
  service_type: string | null;
  can_purchase: boolean;
}

export type PublicMembershipPlanResult =
  | { state: 'ok'; plan: PublicMembershipPlan }
  | { state: 'not_found' }
  | { state: 'error' };

export interface JoinFormValues {
  name: string;
  email: string;
  phone: string;
}

export type JoinFormErrors = Partial<Record<keyof JoinFormValues, string>>;

export type JoinFailureReason = 'invalid' | 'already_member' | 'rate_limited' | 'unavailable' | 'error';

export type StartCheckoutResult = { ok: true; url: string } | { ok: false; reason: JoinFailureReason };

export const JOIN_FAILURE_MESSAGES: Record<JoinFailureReason, string> = {
  invalid: 'Please check your details and try again.',
  already_member: 'You already have this membership. Contact the business if you need help with it.',
  rate_limited: 'Too many attempts. Please wait a little while and try again.',
  unavailable: 'Online signup is not available for this plan right now. Please contact the business.',
  error: "We couldn't start checkout. Please try again in a moment.",
};

// ============================================================
// PURE HELPERS
// ============================================================

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const KNOWN_REASONS: JoinFailureReason[] = ['invalid', 'already_member', 'rate_limited', 'unavailable'];

export function normalizePlanSlug(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidPlanSlug(slug: string): boolean {
  return slug.length >= 3 && slug.length <= 60 && SLUG_RE.test(slug);
}

/** Same rules as the edge function — keep the two in sync. */
export function validateJoinForm(values: JoinFormValues): JoinFormErrors {
  const errors: JoinFormErrors = {};

  const name = values.name.trim();
  if (name.length < 2) errors.name = 'Please enter your full name.';
  else if (name.length > 100) errors.name = 'That name is too long.';

  const email = values.email.trim();
  if (!email) errors.email = 'Please enter your email.';
  else if (email.length > 254 || !EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';

  const phone = values.phone.trim();
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (phone.length > 30 || digits.length < 7 || digits.length > 15) errors.phone = 'Enter a valid phone number, or leave it empty.';
  }

  return errors;
}

/** $49, $49.99, $1,200 — whole dollars drop the cents. */
export function formatPlanPrice(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function intervalNoun(interval: 'monthly' | 'yearly'): 'month' | 'year' {
  return interval === 'monthly' ? 'month' : 'year';
}

/** "about $24.92 / month" for yearly plans, null for monthly ones. */
export function monthlyEquivalentLabel(priceCents: number, interval: 'monthly' | 'yearly'): string | null {
  if (interval !== 'yearly') return null;
  return `about ${formatPlanPrice(toMonthlyCents(priceCents, interval))} / month`;
}

/** Only ever send the customer to a Stripe-hosted https page. */
export function isSafeCheckoutUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && (parsed.hostname === 'stripe.com' || parsed.hostname.endsWith('.stripe.com'));
  } catch {
    return false;
  }
}

function cleanBenefits(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((b): b is string => typeof b === 'string').map((b) => b.trim()).filter((b) => b.length > 0);
}

// ============================================================
// DATA LAYER
// ============================================================

export async function fetchPublicMembershipPlan(slug: string): Promise<PublicMembershipPlanResult> {
  const normalized = normalizePlanSlug(slug);
  if (!isValidPlanSlug(normalized)) return { state: 'not_found' };
  const { data, error } = await supabase.rpc('get_public_membership_plan', { p_slug: normalized });
  if (error) return { state: 'error' };
  if (!data) return { state: 'not_found' };
  const raw = data as Omit<PublicMembershipPlan, 'benefits'> & { benefits?: unknown };
  return { state: 'ok', plan: { ...raw, benefits: cleanBenefits(raw.benefits) } };
}

/** supabase.functions.invoke hides the JSON body of non-2xx replies in error.context. */
async function reasonFromError(error: unknown): Promise<JoinFailureReason> {
  const context = (error as { context?: { json?: () => Promise<unknown> } } | null)?.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.json()) as { reason?: string } | null;
      const reason = body?.reason as JoinFailureReason | undefined;
      if (reason && KNOWN_REASONS.includes(reason)) return reason;
    } catch {
      // fall through to the generic error
    }
  }
  return 'error';
}

export async function startMembershipCheckout(slug: string, values: JoinFormValues, honeypot = ''): Promise<StartCheckoutResult> {
  if (Object.keys(validateJoinForm(values)).length > 0) return { ok: false, reason: 'invalid' };

  const { data, error } = await supabase.functions.invoke('membership-join-checkout', {
    body: {
      plan_slug: normalizePlanSlug(slug),
      customer_name: values.name.trim(),
      customer_email: values.email.trim(),
      customer_phone: values.phone.trim() || undefined,
      website: honeypot,
    },
  });
  if (error) return { ok: false, reason: await reasonFromError(error) };

  const url = (data as { checkout_url?: string } | null)?.checkout_url;
  if (!isSafeCheckoutUrl(url)) return { ok: false, reason: 'error' };
  return { ok: true, url };
}
