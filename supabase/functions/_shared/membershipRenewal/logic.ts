// Pure helpers for the maintenance-agreement renewal workflow.
// No imports and no runtime APIs (no Deno, no fetch): shared by the Deno edge functions and vitest. Keep it that way.

export type BillingInterval = "monthly" | "yearly";
export type RenewalStage = "upcoming_60" | "upcoming_30" | "upcoming_7" | "due" | "past_due";
export type NoticeKey = "60" | "30" | "7";
export type PaymentRoute = "card_on_file" | "pay_link";

export const DAY_MS = 86_400_000;
/** Off-session charge schedule: attempt 1 on the renewal date, then +3 and +7 days. Max 3 attempts. */
export const CHARGE_RETRY_OFFSETS_DAYS = [0, 3, 7] as const;
export const MAX_CHARGE_ATTEMPTS = CHARGE_RETRY_OFFSETS_DAYS.length;
/** Matches membership-lifecycle-agent's grace period before a past-due member is churned. */
export const GRACE_PERIOD_DAYS = 14;
const MIN_HOURS_BETWEEN_ATTEMPTS = 20;

/** Notice windows per billing interval. A monthly plan has no room for a 60/30-day runway. */
export const NOTICE_DAYS: Record<BillingInterval, readonly number[]> = {
  yearly: [60, 30, 7],
  monthly: [7],
};

/** A cycle is opened once the renewal is within the first (longest) notice window. */
export function cycleLeadDays(interval: BillingInterval): number {
  return NOTICE_DAYS[interval][0];
}

export function addInterval(date: Date, interval: BillingInterval): Date {
  const d = new Date(date);
  if (interval === "monthly") d.setMonth(d.getMonth() + 1);
  else d.setFullYear(d.getFullYear() + 1);
  return d;
}

/** Whole days from `now` until `periodEnd`, rounded up (a renewal in 6.2 days is "7 days"). Negative once past. */
export function daysUntil(periodEnd: Date | string, now: Date): number {
  const diff = new Date(periodEnd).getTime() - now.getTime();
  return diff >= 0 ? Math.ceil(diff / DAY_MS) : -Math.ceil(-diff / DAY_MS);
}

export function stageForDaysLeft(daysLeft: number, interval: BillingInterval): RenewalStage {
  if (daysLeft <= 0) return "due";
  if (daysLeft <= 7) return "upcoming_7";
  if (interval === "monthly") return "upcoming_7";
  return daysLeft <= 30 ? "upcoming_30" : "upcoming_60";
}

/** Price the member will be renewed at, and the price they were on. */
export function renewalPricing(plan: { price_cents: number; renewal_price_cents?: number | null }): {
  amountCents: number;
  previousCents: number;
  changed: boolean;
} {
  const previousCents = Math.max(0, Math.round(plan.price_cents));
  const override = plan.renewal_price_cents;
  const amountCents = typeof override === "number" && Number.isFinite(override) && override >= 0 ? Math.round(override) : previousCents;
  return { amountCents, previousCents, changed: amountCents !== previousCents };
}

export interface CardOnFile {
  stripe_customer_id?: string | null;
  stripe_payment_method_id?: string | null;
  card_exp_month?: number | null;
  card_exp_year?: number | null;
  auto_renew?: boolean | null;
  auto_renew_consent_at?: string | null;
}

/** A card is charged only with a saved method, a customer, explicit consent, auto-renew on, and an unexpired card. */
export function cardUsable(m: CardOnFile, at: Date): boolean {
  if (!m.auto_renew || !m.stripe_customer_id || !m.stripe_payment_method_id || !m.auto_renew_consent_at) return false;
  if (m.card_exp_month && m.card_exp_year) {
    // A card is valid through the last day of its expiry month.
    const validThrough = Date.UTC(m.card_exp_year, m.card_exp_month, 1);
    if (at.getTime() >= validThrough) return false;
  }
  return true;
}

export function paymentRoute(m: CardOnFile, renewalDate: Date): PaymentRoute {
  return cardUsable(m, renewalDate) ? "card_on_file" : "pay_link";
}

/**
 * Which notice (if any) to send now. Only the most recent applicable notice is sent — a cycle opened late
 * (new member, or the agent was down) never fires 60 + 30 + 7 on the same day; earlier ones are just marked.
 */
export function noticeToSend(
  daysLeft: number,
  interval: BillingInterval,
  alreadySent: readonly string[],
): { send: NoticeKey | null; mark: NoticeKey[] } {
  if (daysLeft <= 0) return { send: null, mark: [] };
  const applicable = NOTICE_DAYS[interval].filter((d) => daysLeft <= d).map((d) => String(d) as NoticeKey);
  const fresh = applicable.filter((k) => !alreadySent.includes(k));
  if (fresh.length === 0) return { send: null, mark: [] };
  // NOTICE_DAYS is descending, so the last applicable entry is the closest window.
  const send = applicable[applicable.length - 1];
  return { send: fresh.includes(send) ? send : null, mark: fresh };
}

export type ChargeDecision = "charge" | "wait" | "skip";

/** Whether the off-session card charge should be attempted on this run. */
export function chargeDecision(input: {
  now: Date;
  periodEnd: Date | string;
  attempts: number;
  lastAttemptAt?: string | null;
  quoteStatus: string;
}): ChargeDecision {
  if (input.quoteStatus === "declined") return "skip";
  if (input.attempts >= MAX_CHARGE_ATTEMPTS) return "skip";
  const dueAt = new Date(input.periodEnd).getTime() + CHARGE_RETRY_OFFSETS_DAYS[input.attempts] * DAY_MS;
  if (input.now.getTime() < dueAt) return "wait";
  if (input.lastAttemptAt) {
    const hours = (input.now.getTime() - new Date(input.lastAttemptAt).getTime()) / 3_600_000;
    if (hours < MIN_HOURS_BETWEEN_ATTEMPTS) return "wait";
  }
  return "charge";
}

/** Stable per (cycle, attempt): Stripe replays the same result if a crashed run retries the same attempt. */
export function renewalChargeIdempotencyKey(cycleId: string, attempt: number): string {
  return `membership-renewal-${cycleId}-${attempt}`;
}

export function formatUsd(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars)
    ? `$${dollars.toLocaleString("en-US")}`
    : `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatLongDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function renewalUrl(siteUrl: string, quoteToken: string): string {
  return `${siteUrl.replace(/\/$/, "")}/renew/${quoteToken}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export interface NoticeContext {
  customerName: string;
  planName: string;
  amountCents: number;
  previousCents: number;
  periodEnd: Date | string;
  route: PaymentRoute;
  cardLabel?: string | null; // e.g. "Visa ending 4242"
  url: string;
}

/** Customer-facing renewal notice: one text body reused for SMS and email. Transactional, never promotional. */
export function renewalNoticeMessage(key: NoticeKey, c: NoticeContext): { subject: string; text: string } {
  const first = c.customerName.trim().split(/\s+/)[0] || "there";
  const date = formatLongDate(c.periodEnd);
  const price =
    c.amountCents !== c.previousCents
      ? `${formatUsd(c.amountCents)} (was ${formatUsd(c.previousCents)})`
      : formatUsd(c.amountCents);
  const charge =
    c.route === "card_on_file" && c.cardLabel
      ? ` We'll charge your ${c.cardLabel} on ${date}.`
      : c.route === "card_on_file"
        ? ` We'll charge your card on file on ${date}.`
        : "";
  const manage = ` Review, keep or cancel anytime: ${c.url}`;
  if (key === "60") {
    return {
      subject: `Your ${c.planName} renewal quote`,
      text: `Hi ${first}, your ${c.planName} renews on ${date} for ${price}.${charge}${manage}`,
    };
  }
  if (key === "30") {
    return {
      subject: `Your ${c.planName} renews in 30 days`,
      text: `Hi ${first}, a quick reminder: your ${c.planName} renews on ${date} for ${price}.${charge}${manage}`,
    };
  }
  return {
    subject: `Your ${c.planName} renews in 7 days`,
    text: `Hi ${first}, your ${c.planName} renews in 7 days (${date}) for ${price}.${charge}${manage}`,
  };
}

export function renewalReceiptMessage(c: { customerName: string; planName: string; amountCents: number; nextEnd: Date | string }): { subject: string; text: string } {
  const first = c.customerName.trim().split(/\s+/)[0] || "there";
  return {
    subject: `Your ${c.planName} has renewed`,
    text: `Hi ${first}, thank you — your ${c.planName} renewed and ${formatUsd(c.amountCents)} was charged to your card on file. You're covered through ${formatLongDate(c.nextEnd)}.`,
  };
}

export function chargeFailedMessage(c: { customerName: string; planName: string; amountCents: number; payUrl: string }): { subject: string; text: string } {
  const first = c.customerName.trim().split(/\s+/)[0] || "there";
  return {
    subject: `Action needed: update your card for ${c.planName}`,
    text: `Hi ${first}, we couldn't charge your card for your ${c.planName} renewal (${formatUsd(c.amountCents)}). Please update your payment here: ${c.payUrl}`,
  };
}

export function authRequiredMessage(c: { customerName: string; planName: string; amountCents: number; payUrl: string }): { subject: string; text: string } {
  const first = c.customerName.trim().split(/\s+/)[0] || "there";
  return {
    subject: `Confirm your ${c.planName} renewal`,
    text: `Hi ${first}, your bank needs you to confirm the ${formatUsd(c.amountCents)} renewal of your ${c.planName}. It takes a moment: ${c.payUrl}`,
  };
}

/** Event data for the win-back playbook ({{plan_join_url}}, {{plan_name}}, {{amount}} become template variables). */
export function winBackEventData(plan: { name?: string | null; price_cents?: number | null; public_slug?: string | null } | null, siteUrl: string): Record<string, unknown> {
  const base = siteUrl.replace(/\/$/, "");
  return {
    plan_name: plan?.name ?? null,
    amount: plan?.price_cents != null ? formatUsd(plan.price_cents) : null,
    plan_join_url: plan?.public_slug ? `${base}/join/${plan.public_slug}` : null,
  };
}

/** Maps a raw payment-method object from Stripe (charge.payment_method_details.card) to the columns we store. */
export function cardFromCharge(charge: any): { brand: string; last4: string; exp_month: number; exp_year: number } | null {
  const card = charge?.payment_method_details?.card;
  if (!card?.last4) return null;
  return {
    brand: String(card.brand ?? "card"),
    last4: String(card.last4),
    exp_month: Number(card.exp_month) || 0,
    exp_year: Number(card.exp_year) || 0,
  };
}

export function cardLabel(brand: string | null | undefined, last4: string | null | undefined): string | null {
  if (!last4) return null;
  const b = (brand ?? "card").replace(/^\w/, (ch) => ch.toUpperCase());
  return `${b} ending ${last4}`;
}
