// supabase/functions/growth-stripe-reconcile/index.ts
//
// Compares Stripe's live subscriptions with subscription_facts (derived from stored webhook events) and records
// the result in growth_reconciliation_runs. Catches missed webhooks, stale statuses and MRR drift.
//
// Caller: a staff user's JWT (dashboard button) OR header x-growth-cron-secret = GROWTH_CRON_SECRET (schedule weekly).
// Secrets: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROWTH_CRON_SECRET (>=16 chars).
// Deploy: supabase functions deploy growth-stripe-reconcile
//
// Read-only against Stripe. Truncation (> MAX_SUBS) is reported, never silently ignored.

import Stripe from "npm:stripe@17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { cronSecretMatches } from "../_shared/growth/auth.ts";
import { reconcile, type FactLatest, type StripeSubLite } from "../_shared/growth/reconcile.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Growth-Cron-Secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_SUBS = 5000;
const PAGE = 1000;

function discountOf(sub: Stripe.Subscription): Stripe.Discount | null {
  if (sub.discount) return sub.discount;
  const first = (sub.discounts ?? []).find((d): d is Stripe.Discount => typeof d === "object" && d !== null);
  return first ?? null;
}

function toLite(sub: Stripe.Subscription): StripeSubLite {
  const item = sub.items.data[0];
  const price = item?.price;
  const d = discountOf(sub);
  const coupon = d?.coupon;
  const foreverPercent = coupon && coupon.duration === "forever" && coupon.percent_off !== null && coupon.percent_off !== undefined
    ? coupon.percent_off : null;
  const anyDiscount = d !== null || (sub.discounts ?? []).length > 0;
  return {
    id: sub.id,
    status: sub.status,
    currency: (sub.currency ?? price?.currency ?? null)?.toLowerCase() ?? null,
    interval: price?.recurring?.interval ?? null,
    intervalCount: price?.recurring?.interval_count ?? 1,
    unitAmount: price?.unit_amount ?? null,
    quantity: item?.quantity ?? 1,
    percentOffForever: foreverPercent,
    hasOtherDiscount: anyDiscount && foreverPercent === null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (!url || !serviceKey || !stripeKey) return json({ error: "Not configured" }, 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let triggeredBy: "cron" | "staff" = "cron";
  let staffId: string | null = null;
  if (!cronSecretMatches(req.headers.get("x-growth-cron-secret"), Deno.env.get("GROWTH_CRON_SECRET") ?? "")) {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Unauthorized" }, 401);
    const { data: u, error: uErr } = await admin.auth.getUser(token);
    if (uErr || !u.user) return json({ error: "Unauthorized" }, 401);
    const { data: isStaff } = await admin.rpc("is_vireek_staff", { uid: u.user.id });
    if (isStaff !== true) return json({ error: "Staff only" }, 403);
    triggeredBy = "staff";
    staffId = u.user.id;
  }

  try {
    const stripe = new Stripe(stripeKey, { apiVersion: "2024-11-20.acacia" as Stripe.LatestApiVersion });
    const subs: StripeSubLite[] = [];
    let complete = true;
    for await (const sub of stripe.subscriptions.list({ status: "all", limit: 100, expand: ["data.discounts"] })) {
      if (subs.length >= MAX_SUBS) { complete = false; break; }
      subs.push(toLite(sub));
    }

    const facts: FactLatest[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin.rpc("growth_latest_facts").range(from, from + PAGE - 1);
      if (error) throw new Error(`facts: ${error.message}`);
      const rows = (data ?? []) as { stripe_subscription_id: string; status: string; mrr_cents: number | string; currency: string | null; discount_unresolved: boolean }[];
      for (const r of rows) facts.push({ ...r, mrr_cents: Number(r.mrr_cents) });
      if (rows.length < PAGE) break;
    }

    const result = reconcile(subs, facts, complete);
    const summary = {
      complete,
      stripe_subscriptions: subs.length,
      facts_subscriptions: facts.length,
      totals: result.totals,
      unexplained: result.unexplained,
      by_kind: result.mismatches.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.kind]: (acc[m.kind] ?? 0) + 1 }), {}),
    };
    const { error: insErr } = await admin.from("growth_reconciliation_runs").insert({
      triggered_by: triggeredBy,
      staff_id: staffId,
      stripe_subscriptions: subs.length,
      mismatches: result.unexplained,
      summary,
      details: result.mismatches.slice(0, 200),
    });
    if (insErr) throw new Error(`save: ${insErr.message}`);
    return json({ ok: true, summary, mismatches_shown: Math.min(result.mismatches.length, 200) });
  } catch (err) {
    console.error("[growth-stripe-reconcile]", err instanceof Error ? err.message : "unknown");
    return json({ error: "Reconciliation failed" }, 500);
  }
});
