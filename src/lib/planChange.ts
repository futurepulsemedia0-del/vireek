// src/lib/planChange.ts
//
// Pure types + helpers for /dashboard/billing/plans. No Supabase import here so
// everything is unit-testable (see planChange.test.ts). Network calls live in
// ./planChangeApi.ts.
import type { PlanId, PricingPlan } from '@/lib/pricing';

export type PlanChangeKind = 'new' | 'upgrade' | 'downgrade';

export interface LivePrice {
  amountMinor: number;
  currency: string;
  interval: string;
}

export interface ScheduledChange {
  planId: PlanId;
  effectiveAt: string;
}

export interface SubscriptionState {
  canManage: boolean;
  hasSubscription: boolean;
  status: string | null;
  currentPlanId: PlanId | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  currency: string | null;
  currentAmountMinor: number | null;
  paymentMethod: { brand: string; last4: string } | null;
  scheduledChange: ScheduledChange | null;
  prices: Partial<Record<PlanId, LivePrice>>;
}

export interface PlanChangePreview {
  kind: PlanChangeKind;
  currentPlanId: string | null;
  targetPlanId: PlanId;
  currency: string;
  interval: string;
  effectiveAt: string;
  nextBillingDate: string | null;
  dueNowMinor: number;
  creditMinor: number;
  lines: { description: string; amountMinor: number }[];
  newRecurringMinor: number;
  taxesApply: boolean;
  hasDiscount: boolean;
  prorationDate: number;
}

export class PlanChangeError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'PlanChangeError';
    this.code = code;
  }
}

/** Error codes where the right recovery is "fetch a fresh preview and ask again". */
export function isStalePreviewError(err: unknown): boolean {
  return err instanceof PlanChangeError && (err.code === 'PRICE_CHANGED' || err.code === 'PREVIEW_EXPIRED');
}

const RANK: Record<PlanId, number> = { free: 0, starter: 1, professional: 2, business: 3, enterprise: 4 };

export function planRank(plan: PlanId | string | null | undefined): number {
  if (!plan) return -1;
  return plan in RANK ? RANK[plan as PlanId] : -1;
}

/** Plans that can be bought/changed self-serve through Stripe. */
export function isSelfServePlan(plan: PlanId): boolean {
  return plan === 'starter' || plan === 'professional' || plan === 'business';
}

export function classifyPlanChange(
  current: PlanId | string | null | undefined,
  target: PlanId,
  hasSubscription: boolean,
): PlanChangeKind | 'same' {
  if (!hasSubscription) return 'new';
  if (current === target) return 'same';
  return planRank(target) > planRank(current) ? 'upgrade' : 'downgrade';
}

/** "1,500 min" -> 1500. Returns null for "Unlimited" or anything unparseable. */
export function parsePlanMinutes(minutes: string): number | null {
  const match = minutes.replace(/,/g, '').match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/** "$0.20/min after" -> 0.2. */
export function parseOverageRate(overage: string | null): number | null {
  if (!overage) return null;
  const match = overage.match(/\$([\d.]+)\/min/);
  return match ? parseFloat(match[1]) : null;
}

/** Formats a Stripe minor-unit amount (cents) in its own currency. Handles zero-decimal currencies. */
export function formatMinor(amountMinor: number, currency: string, locale = 'en-US'): string {
  const code = (currency || 'usd').toUpperCase();
  try {
    const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency: code });
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(amountMinor / 10 ** digits);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${code}`;
  }
}

export function formatLongDate(iso: string | null | undefined, locale = 'en-US'): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric' });
}

export function formatCardBrand(brand: string): string {
  const known: Record<string, string> = {
    visa: 'Visa',
    mastercard: 'Mastercard',
    amex: 'American Express',
    discover: 'Discover',
    diners: 'Diners Club',
    jcb: 'JCB',
    unionpay: 'UnionPay',
  };
  return known[brand.toLowerCase()] ?? brand.charAt(0).toUpperCase() + brand.slice(1);
}

export interface UsageImpact {
  exceedsTarget: boolean;
  overageMinutes: number;
  /** Estimated monthly overage (USD) if usage keeps this month's pace. Null when the target has no metered overage. */
  estimatedOverageUsd: number | null;
}

/**
 * Projects this month's pace onto the target plan's allowance — the one
 * real-world surprise of a downgrade (usage that fit before now bills overage).
 */
export function computeUsageImpact(minutesUsed: number, target: PricingPlan): UsageImpact {
  const allowance = parsePlanMinutes(target.minutes);
  if (allowance === null) return { exceedsTarget: false, overageMinutes: 0, estimatedOverageUsd: null };
  const overageMinutes = Math.max(0, minutesUsed - allowance);
  const rate = parseOverageRate(target.overage);
  return {
    exceedsTarget: overageMinutes > 0,
    overageMinutes,
    estimatedOverageUsd: rate === null ? null : Math.round(overageMinutes * rate * 100) / 100,
  };
}

/** Human label for the primary button of a plan card / dialog. */
export function changeActionLabel(kind: PlanChangeKind, planName: string, dueNowMinor?: number, currency?: string): string {
  if (kind === 'new') return `Subscribe to ${planName}`;
  if (kind === 'downgrade') return `Schedule downgrade to ${planName}`;
  if (dueNowMinor && dueNowMinor > 0 && currency) return `Pay ${formatMinor(dueNowMinor, currency)} & upgrade`;
  return `Upgrade to ${planName}`;
}
