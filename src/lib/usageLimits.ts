// src/lib/usageLimits.ts
//
// Pure usage / limits / upsell logic shared by UsageLimitBanner, UsageDashboardPage and
// BillingPlansPage. No React, no network, no Date.now() unless `now` is injected, so every
// rule is unit-tested in usageLimits.test.ts.
//
// Single source of truth for prices, allowances and overage rates is PRICING_PLANS in
// src/lib/pricing.ts. Nothing here hardcodes a price or rate.
import { PRICING_PLANS, parseOverageRate, type PlanId, type PricingPlan } from '@/lib/pricing';

// ---------------------------------------------------------------------------
// Minutes snapshot
// ---------------------------------------------------------------------------

/** Show the early warning from this share of the allowance (included + bonus). */
export const WARNING_THRESHOLD_PCT = 80;
/** Don't project a month from fewer days of data than this (too noisy to nag on). */
export const MIN_DAYS_FOR_PROJECTION = 3;

export type UsageLevel = 'ok' | 'warning' | 'limit';
/** unlimited: not metered. bill: extra minutes are billed. block: answering pauses at the limit. */
export type LimitPolicy = 'unlimited' | 'bill' | 'block';

export interface UsageSnapshot {
  used: number;
  included: number;
  bonus: number;
  /** included + bonus. 0 when unlimited. */
  capacity: number;
  /** null when unlimited. */
  remaining: number | null;
  /** 0-100+ (not clamped). 0 when unlimited. */
  pct: number;
  unlimited: boolean;
  level: UsageLevel;
  /** Whole minutes beyond capacity. Bonus minutes are consumed before any overage. */
  overageMinutes: number;
}

function clean(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function getUsageSnapshot(input: {
  minutesUsed: unknown;
  minutesIncluded: unknown;
  bonusMinutes?: unknown;
}): UsageSnapshot {
  const used = clean(input.minutesUsed);
  const included = clean(input.minutesIncluded);
  const bonus = clean(input.bonusMinutes);
  // Existing convention (UsageDashboardPage / UsageLimitBanner): included <= 0 means unlimited.
  const unlimited = included <= 0;
  const capacity = unlimited ? 0 : included + bonus;
  const pct = unlimited ? 0 : (used / capacity) * 100;
  const level: UsageLevel = unlimited ? 'ok' : used >= capacity ? 'limit' : pct >= WARNING_THRESHOLD_PCT ? 'warning' : 'ok';
  return {
    used,
    included,
    bonus: unlimited ? 0 : bonus,
    capacity,
    remaining: unlimited ? null : Math.max(0, capacity - used),
    pct,
    unlimited,
    level,
    overageMinutes: unlimited ? 0 : Math.max(0, Math.round(used - capacity)),
  };
}

export function findPlan(planId: string | null | undefined): PricingPlan | undefined {
  return PRICING_PLANS.find((p) => p.id === planId);
}

/** Policy is derived from the plan: an overage rate means "bill", none (Free) means "block". */
export function getLimitPolicy(plan: PricingPlan | undefined, snap: Pick<UsageSnapshot, 'unlimited'>): LimitPolicy {
  if (!plan || snap.unlimited || plan.id === 'enterprise') return 'unlimited';
  return parseOverageRate(plan.overage) === null ? 'block' : 'bill';
}

export function overageRateFor(plan: PricingPlan | undefined): number | null {
  return plan ? parseOverageRate(plan.overage) : null;
}

/** USD rounded to cents, avoiding float noise (e.g. 3 * 0.15). */
export function estimateOverageUsd(overageMinutes: number, rate: number | null): number {
  if (rate === null || overageMinutes <= 0) return 0;
  return Math.round(overageMinutes * rate * 100) / 100;
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function formatUsdWhole(amount: number): string {
  return Number.isInteger(amount) ? `$${amount.toLocaleString('en-US')}` : formatUsd(amount);
}

export function formatMinutes(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// Banner content
// ---------------------------------------------------------------------------

export interface BannerContent {
  eyebrow: string;
  title: string;
  body: string;
  tone: 'warning' | 'danger';
  dismissible: boolean;
}

/**
 * Copy for UsageLimitBanner. Returns null when no banner should show.
 * 'block': only claims what the product is known to do (answering pauses). It deliberately makes NO claim
 *   about emergency forwarding at the limit — that behaviour is not implemented in this codebase snapshot.
 * 'bill': the per-minute rate is read from PRICING_PLANS, never hardcoded.
 */
export function getBannerContent(input: {
  snap: UsageSnapshot;
  policy: LimitPolicy;
  rate: number | null;
  planName: string;
  assistantName: string;
}): BannerContent | null {
  const { snap, policy, rate, planName, assistantName } = input;
  if (snap.level === 'ok' || policy === 'unlimited') return null;

  const total = formatMinutes(snap.capacity);
  const bonusNote = snap.bonus > 0 ? ` (includes ${formatMinutes(snap.bonus)} bonus)` : '';

  if (snap.level === 'warning') {
    const left = formatMinutes(snap.remaining ?? 0);
    const title = `You've used ${Math.floor(snap.pct)}% of your ${total} minutes this month${bonusNote}`;
    const body =
      policy === 'bill' && rate !== null
        ? `${left} min left. Extra minutes cost ${formatUsd(rate)}/min after that. Upgrade to raise your allowance and lower your rate.`
        : `${left} min left. Voice answering pauses at the limit. Upgrade to keep every call answered, 24/7.`;
    return { eyebrow: 'Approaching usage limit', title, body, tone: 'warning', dismissible: true };
  }

  // level === 'limit'
  if (policy === 'bill' && rate !== null) {
    return {
      eyebrow: 'Usage limit reached',
      title: `You've used all ${total} included minutes this month${bonusNote}`,
      body: `Extra minutes cost ${formatUsd(rate)}/min — about ${formatUsd(estimateOverageUsd(snap.overageMinutes, rate))} in overage so far (${formatMinutes(snap.overageMinutes)} min over). Upgrade to raise your included minutes and lower your rate.`,
      tone: 'warning',
      dismissible: true,
    };
  }
  return {
    eyebrow: 'Usage limit reached',
    title: `${assistantName} has paused answering new calls for your business`,
    body: `You've used all ${total} minutes included in the ${planName} plan this month${bonusNote} (${formatMinutes(snap.used)} used). Upgrade to a paid plan to resume 24/7 call answering right away.`,
    tone: 'danger',
    dismissible: false,
  };
}

// ---------------------------------------------------------------------------
// Billing period (calendar month — the period the existing dashboard already reports on)
// ---------------------------------------------------------------------------

export function getBillingPeriod(now: Date): { start: Date; end: Date; daysInMonth: number; daysElapsed: number; daysLeft: number } {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1),
    end: new Date(now.getFullYear(), now.getMonth(), daysInMonth),
    daysInMonth,
    daysElapsed: now.getDate(),
    daysLeft: daysInMonth - now.getDate(),
  };
}

export function formatPeriodRange(start: Date, end: Date): string {
  const short = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${short(start)} – ${short(end)}, ${end.getFullYear()}`;
}

export function projectMonthEndMinutes(used: number, daysElapsed: number, daysInMonth: number): number {
  if (daysElapsed <= 0) return clean(used);
  return Math.round((clean(used) / daysElapsed) * daysInMonth);
}

// ---------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------

/** "Up to 3 locations" -> 3, "5 seats" -> 5, "Unlimited seats" -> null. */
export function parseLimit(text: string): number | null {
  const m = text.replace(/,/g, '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Monthly list price; Enterprise falls back to its "from" price. Null when there is no price at all. */
export function planMonthlyPrice(plan: PricingPlan): number | null {
  return plan.monthly ?? plan.startingAt ?? null;
}

/** "Start 14-day trial" -> 14. Null for plans without a trial. */
export function trialDays(plan: PricingPlan): number | null {
  const m = plan.ctaLabel.match(/(\d+)-day trial/i);
  return m ? parseInt(m[1], 10) : null;
}

/** Annual saving vs 12 monthly payments, in USD and in months of the monthly price. Null when not applicable. */
export function annualSavings(plan: PricingPlan): { amount: number; monthsFree: number } | null {
  if (!plan.monthly || !plan.annual || plan.monthly <= 0) return null;
  const amount = plan.monthly * 12 - plan.annual;
  if (amount <= 0) return null;
  return { amount, monthsFree: Math.round((amount / plan.monthly) * 10) / 10 };
}

export const EXTRA_COMPARE_ROWS = [
  { label: 'Free trial', key: 'trial' },
  { label: 'Annual billing', key: 'annual' },
] as const;
export type ExtraCompareKey = (typeof EXTRA_COMPARE_ROWS)[number]['key'];

export function extraCompareValue(plan: PricingPlan, key: ExtraCompareKey): string {
  if (key === 'trial') {
    const days = trialDays(plan);
    return days ? `${days}-day trial` : '—';
  }
  const savings = annualSavings(plan);
  if (savings) {
    return `${formatUsdWhole(plan.annual as number)}/yr · save ${formatUsdWhole(savings.amount)} (${savings.monthsFree} months free)`;
  }
  return plan.id === 'enterprise' ? 'Custom' : '—';
}

/** One line for a plan card: annual saving + trial, in a stable order. */
export function planCardNote(plan: PricingPlan): string {
  const parts: string[] = [];
  const days = trialDays(plan);
  if (days) parts.push(`${days}-day trial`);
  const savings = annualSavings(plan);
  if (savings) parts.push(`Annual: save ${formatUsdWhole(savings.amount)} (${savings.monthsFree} months free)`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Upgrade suggestion
// ---------------------------------------------------------------------------

export type UpgradeReason = 'overage_cost' | 'would_be_blocked';

export interface UpgradeSuggestion {
  suggest: boolean;
  reason: UpgradeReason | null;
  currentPlanId: PlanId | null;
  targetPlanId: PlanId | null;
  projectedMinutes: number;
  projectedOverageMinutes: number;
  /** Overage on the current plan at the projected pace, USD. */
  projectedOverageUsd: number;
  /** Current monthly price + projected overage, USD. */
  projectedCostUsd: number;
  currentPriceUsd: number | null;
  targetPriceUsd: number | null;
}

const NO_SUGGESTION: UpgradeSuggestion = {
  suggest: false, reason: null, currentPlanId: null, targetPlanId: null,
  projectedMinutes: 0, projectedOverageMinutes: 0, projectedOverageUsd: 0,
  projectedCostUsd: 0, currentPriceUsd: null, targetPriceUsd: null,
};

/**
 * Suggest the NEXT plan only when it is not worse for the customer:
 *   billed plans:  current price + (projected month-end overage minutes x overage rate) >= next plan price
 *   Free (blocked): projected month-end minutes exceed the allowance, i.e. calls would stop being answered
 * Otherwise do not nag. Safeguards: unlimited/unknown/top plans never suggest; with fewer than
 * MIN_DAYS_FOR_PROJECTION days of data the projection is ignored unless the allowance is already used up.
 */
export function suggestUpgrade(input: {
  planId: string | null | undefined;
  minutesUsed: unknown;
  minutesIncluded: unknown;
  bonusMinutes?: unknown;
  now?: Date;
}): UpgradeSuggestion {
  const now = input.now ?? new Date();
  const current = findPlan(input.planId);
  if (!current) return NO_SUGGESTION;

  const snap = getUsageSnapshot(input);
  const idx = PRICING_PLANS.findIndex((p) => p.id === current.id);
  const next = PRICING_PLANS[idx + 1];
  const nextPrice = next ? planMonthlyPrice(next) : null;
  const currentPrice = planMonthlyPrice(current);
  const base = { ...NO_SUGGESTION, currentPlanId: current.id, currentPriceUsd: currentPrice };
  if (snap.unlimited || current.id === 'enterprise' || !next || nextPrice === null || currentPrice === null) return base;

  const period = getBillingPeriod(now);
  const projectedRaw = projectMonthEndMinutes(snap.used, period.daysElapsed, period.daysInMonth);
  const enoughData = period.daysElapsed >= MIN_DAYS_FOR_PROJECTION;
  // Never project below what has actually been used; ignore the (noisy) projection early in the month.
  const projectedMinutes = Math.max(snap.used, enoughData ? projectedRaw : 0);
  const projectedOverageMinutes = Math.max(0, Math.round(projectedMinutes - snap.capacity));
  const rate = parseOverageRate(current.overage);
  const projectedOverageUsd = estimateOverageUsd(projectedOverageMinutes, rate);
  const projectedCostUsd = Math.round((currentPrice + projectedOverageUsd) * 100) / 100;

  const common = {
    ...base,
    targetPlanId: next.id,
    projectedMinutes,
    projectedOverageMinutes,
    projectedOverageUsd,
    projectedCostUsd,
    targetPriceUsd: nextPrice,
  };

  if (rate === null) {
    return projectedOverageMinutes > 0 ? { ...common, suggest: true, reason: 'would_be_blocked' } : { ...common, suggest: false };
  }
  return projectedOverageMinutes > 0 && projectedCostUsd >= nextPrice
    ? { ...common, suggest: true, reason: 'overage_cost' }
    : { ...common, suggest: false };
}

export function describeSuggestion(s: UpgradeSuggestion): { title: string; body: string } | null {
  if (!s.suggest || !s.targetPlanId || s.targetPriceUsd === null) return null;
  const target = findPlan(s.targetPlanId);
  const current = findPlan(s.currentPlanId);
  if (!target || !current) return null;
  const targetPrice = `${formatUsdWhole(s.targetPriceUsd)}/mo`;
  if (s.reason === 'would_be_blocked') {
    return {
      title: `You're on pace to run out of minutes — consider ${target.name}`,
      body: `At your current pace you'll use about ${formatMinutes(s.projectedMinutes)} min this month and hit the ${current.minutes} limit, when answering pauses. ${target.name} (${targetPrice}) includes ${target.minutes}.`,
    };
  }
  return {
    title: `${target.name} would cost about the same or less`,
    body: `At your current pace (~${formatMinutes(s.projectedMinutes)} min) you'd pay about ${formatUsd(s.projectedCostUsd)} this month on ${current.name} (${formatUsdWhole(s.currentPriceUsd ?? 0)} + ${formatUsd(s.projectedOverageUsd)} overage). ${target.name} is ${targetPrice} and includes ${target.minutes}.`,
  };
}
