// supabase/functions/_shared/usage-alerts/copy.ts
// Customer-facing copy. Plan name, included minutes, overage rate and upgrade target come from the pricing source of
// truth (src/lib/pricing.ts) and the account row; no number is hardcoded here. Transactional only, no promotion.
// Deliberately NOT claimed: "service paused" or "emergencies are still forwarded" (no usage-based pause exists in the
// repo) and top-up prices (no top-up product exists).

import { PRICING_PLANS, parseOverageRate, type PricingPlan } from "../../../../src/lib/pricing.ts";
import type { UnifiedNotification } from "../email-kit/notification.ts";
import { usagePercent, type LimitKind, type MinutesKind } from "./core.ts";

export interface AlertAccount {
  id: string;
  email: string | null;
  full_name: string | null;
  company_name: string | null;
  phone: string | null;
  plan: string | null;
  status?: string | null;
  minutes_used_this_month: number | null;
  minutes_included: number | null;
}

export interface PlanContext {
  plan: PricingPlan | null;
  overageRate: number | null;
  upgrade: PricingPlan | null;
}

export function resolvePlanContext(planId: string | null | undefined): PlanContext {
  const idx = PRICING_PLANS.findIndex((p) => p.id === planId);
  const plan = idx >= 0 ? PRICING_PLANS[idx] : null;
  return { plan, overageRate: plan ? parseOverageRate(plan.overage) : null, upgrade: idx >= 0 ? PRICING_PLANS[idx + 1] ?? null : null };
}

export interface AlertContent {
  notificationType: string;
  insight: { title: string; description: string; priority: number } | null;
  notification: UnifiedNotification;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const BILLING_URL = "/dashboard/billing";

function upgradeSentence(ctx: PlanContext): string {
  const u = ctx.upgrade;
  if (!u) return "";
  return u.monthly === null
    ? `For higher volume, talk to us about the ${u.name} plan.`
    : `The ${u.name} plan includes ${u.minutes}${parseOverageRate(u.overage) !== null ? ` at ${u.overage?.replace(" after", "")}` : ""}.`;
}

export function buildMinutesAlert(kind: MinutesKind, a: AlertAccount, periodKey: string): AlertContent {
  const used = Number(a.minutes_used_this_month) || 0;
  const included = Number(a.minutes_included) || 0;
  const ctx = resolvePlanContext(a.plan);
  const planName = ctx.plan?.name ?? "current";
  const is100 = kind === "minutes_100";
  const pct = is100 ? 100 : Math.min(99, usagePercent(used, included));

  const title = is100 ? `You've used all ${fmt(included)} included minutes` : `You've used ${pct}% of your included minutes`;
  const lead = `You've used ${fmt(used)} of ${fmt(included)} included minutes this month on the ${planName} plan.`;
  const rate = is100 && ctx.overageRate !== null
    ? ` Additional minutes are billed at $${ctx.overageRate.toFixed(2)}/min.`
    : ctx.overageRate !== null ? ` Minutes beyond your plan are billed at $${ctx.overageRate.toFixed(2)}/min.` : "";
  const body = `${lead}${rate} ${upgradeSentence(ctx)}`.replace(/\s+/g, " ").trim();

  return {
    notificationType: "usage_limit",
    insight: {
      title: `Included minutes ${is100 ? 100 : 80}% (${periodKey})`, // contains "included minutes": BillingPage reader still matches
      description: body,
      priority: is100 ? 5 : 4,
    },
    notification: {
      title,
      body,
      severity: is100 ? "high" : "warning",
      action: { label: ctx.upgrade ? "View plans" : "View usage", url: BILLING_URL },
      facts: [["Plan", ctx.plan?.name ?? "—"], ["Minutes used", `${fmt(used)} of ${fmt(included)}`], ["Billing period", periodKey]],
    },
  };
}

const LIMIT_LABEL: Record<LimitKind, { title: string; noun: string }> = {
  seat_limit: { title: "Team seat limit reached", noun: "team seats" },
  location_limit: { title: "Location limit reached", noun: "locations" },
  number_limit: { title: "Phone number limit reached", noun: "phone numbers" },
};

export function buildLimitAlert(kind: LimitKind, a: Pick<AlertAccount, "plan">, current: number, limit: number, periodKey: string): AlertContent {
  const ctx = resolvePlanContext(a.plan);
  const { title, noun } = LIMIT_LABEL[kind];
  const target = kind === "seat_limit" ? ctx.upgrade?.seats : kind === "location_limit" ? ctx.upgrade?.locations : undefined;
  const upgrade = ctx.upgrade
    ? ctx.upgrade.monthly === null
      ? ` Talk to us about the ${ctx.upgrade.name} plan to add more.`
      : ` The ${ctx.upgrade.name} plan includes ${target ?? "higher limits"}.`
    : "";
  const body = `Your ${ctx.plan?.name ?? "current"} plan is using ${fmt(current)} of ${fmt(limit)} ${noun}, so you can't add more right now.${upgrade}`;
  return {
    notificationType: "plan_limit",
    insight: { title: `${title} (${periodKey})`, description: body, priority: 4 },
    notification: { title, body, severity: "warning", action: { label: "Manage plan", url: BILLING_URL } },
  };
}
