// supabase/functions/send-billing-notices/index.ts
//
// Scheduled job (run HOURLY): billing lifecycle notices that are driven by the passage of time.
//   1. Annual renewal notice, once per period, within 30 local days of renewal (Stripe is the source of truth).
//   2. Price-change / limit-reduction notices from price_change_notices (affected, non-grandfathered accounts only).
//   3. Reconciliation: owner notice for payment suspensions the webhook/sweep could not deliver.
// Every send goes through billing_notice_log (UNIQUE user_id, kind, key), so overlapping runs and retries are safe.
//
// Auth: X-Cron-Secret = BILLING_NOTICES_CRON_SECRET.  Secrets: STRIPE_SECRET_KEY, RESEND_API_KEY,
// RESEND_FROM_EMAIL, SITE_URL, optional SUPPORT_EMAIL, TWILIO_* (SMS), STRIPE_PRICE_* (plan mapping).
// Deploy: supabase functions deploy send-billing-notices --no-verify-jwt
// Schedule (Dashboard -> Edge Functions -> Cron): "5 * * * *" with header X-Cron-Secret.

import Stripe from "npm:stripe@17.4.0";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { checkSharedSecret } from "../_shared/http/core.ts";
import { minutesForPlan, planIdFromPriceId } from "../_shared/billing/planCatalog.ts";
import { isEligibleForPriceNotice, NOTICEABLE_STATUSES } from "../_shared/billing/notices/eligibility.ts";
import { notifyPaymentSuspended, sendPriceChangeNotice, sendRenewalNotice, toOwnerProfile } from "../_shared/billing/notices/dispatch.ts";
import { inSendWindow, localYmd, priceNoticeDecision, RENEWAL_NOTICE_DAYS, renewalNoticeDue } from "../_shared/billing/notices/schedule.ts";

const MAX_STRIPE_SUBS_PER_RUN = 400;
const MAX_SENDS_PER_RUN = 200;
const PAGE = 500;

interface Tally { sent: number; duplicate: number; failed: number; skipped: number }
const tally = (): Tally => ({ sent: 0, duplicate: 0, failed: 0, skipped: 0 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function bump(t: Tally, outcome: "sent" | "duplicate" | "failed" | "skipped") { t[outcome] += 1; }

async function renewalPass(admin: SupabaseClient, stripe: Stripe, now: Date): Promise<Tally> {
  const t = tally();
  const nowSec = Math.floor(now.getTime() / 1000);
  const horizon = nowSec + (RENEWAL_NOTICE_DAYS + 1) * 86400;
  let seen = 0;
  // Query only ANNUAL prices: every active monthly subscription also renews within 31 days, so an
  // unfiltered list would page through the whole customer base every hour and starve the annual ones.
  for await (const annual of stripe.prices.list({ active: true, type: "recurring", recurring: { interval: "year" }, limit: 100 })) {
    for await (const sub of stripe.subscriptions.list({ price: annual.id, status: "active", current_period_end: { gte: nowSec, lte: horizon }, limit: 100 })) {
      if (++seen > MAX_STRIPE_SUBS_PER_RUN || t.sent >= MAX_SENDS_PER_RUN) return t;
      const price = sub.items.data.find((i) => i.price.id === annual.id)?.price ?? annual;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
      if (!customerId) { bump(t, "skipped"); continue; }

      const { data: row } = await admin.from("profiles").select("*").eq("stripe_customer_id", customerId).maybeSingle();
      if (!row) { bump(t, "skipped"); continue; }
      const owner = toOwnerProfile(row as Record<string, unknown>);
      const periodEnd = new Date(sub.current_period_end * 1000);
      if (!owner.email || owner.status === "suspended" ||
          !renewalNoticeDue({ periodEnd, interval: price.recurring?.interval, cancelAtPeriodEnd: sub.cancel_at_period_end, now, tz: owner.timeZone })) {
        bump(t, "skipped");
        continue;
      }
      const planId = planIdFromPriceId(price.id, (k) => Deno.env.get(k)) ?? owner.plan;
      if (!planId || minutesForPlan(planId) === null) { bump(t, "skipped"); continue; } // custom/enterprise: no fixed minutes to quote

      // Amount actually due at renewal (discounts/credits included); fall back to the list price.
      let amountCents = price.unit_amount ?? 0;
      try {
        const upcoming = await stripe.invoices.retrieveUpcoming({ subscription: sub.id });
        amountCents = upcoming.amount_due;
      } catch (e) {
        console.error(JSON.stringify({ event: "renewal_upcoming_invoice_unavailable", sub: sub.id, error: String(e) }));
      }
      if (!(amountCents > 0)) { bump(t, "skipped"); continue; }

      bump(t, await sendRenewalNotice(admin, owner,
        { planId, renewalYmd: localYmd(periodEnd, owner.timeZone), amountCents, currency: price.currency },
        `renewal:${sub.id}:${sub.current_period_end}`));
    }
  }
  return t;
}

async function priceChangePass(admin: SupabaseClient, stripe: Stripe, now: Date): Promise<Tally> {
  const t = tally();
  const { data: notices, error } = await admin.from("price_change_notices").select("*").eq("status", "scheduled");
  if (error) throw new Error(error.message);

  for (const n of notices ?? []) {
    const decision = priceNoticeDecision(n.effective_date, now, n.dispatch_started_at !== null);
    if (decision !== "send") {
      await admin.from("price_change_notices").update({ status: decision }).eq("id", n.id);
      if (decision === "blocked_late") console.error(JSON.stringify({ event: "price_notice_blocked_late", notice: n.id, effective_date: n.effective_date }));
      continue;
    }
    if (n.dispatch_started_at === null) await admin.from("price_change_notices").update({ dispatch_started_at: now.toISOString() }).eq("id", n.id);

    const key = `price:${n.id}`;
    const { data: gf } = await admin.from("billing_grandfathered_accounts").select("user_id").eq("plan_id", n.plan_id);
    const grandfathered = new Set((gf ?? []).map((r: { user_id: string }) => r.user_id));
    const { data: done } = await admin.from("billing_notice_log").select("user_id").eq("kind", "price_change").eq("key", key).not("sent_at", "is", null);
    const alreadySent = new Set((done ?? []).map((r: { user_id: string }) => r.user_id));

    for (let from = 0; t.sent < MAX_SENDS_PER_RUN; from += PAGE) {
      const { data: rows, error: pErr } = await admin.from("profiles").select("*").eq("plan", n.plan_id)
        .in("subscription_status", [...NOTICEABLE_STATUSES]).order("id").range(from, from + PAGE - 1);
      if (pErr) throw new Error(pErr.message);
      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        if (t.sent >= MAX_SENDS_PER_RUN) break;
        const owner = toOwnerProfile(row as Record<string, unknown>);
        if (alreadySent.has(owner.id)) continue;
        if (!inSendWindow(now, owner.timeZone)) { bump(t, "skipped"); continue; }

        let canceling = false;
        if (owner.stripeSubscriptionId) {
          try {
            const sub = await stripe.subscriptions.retrieve(owner.stripeSubscriptionId);
            canceling = sub.cancel_at_period_end || !["active", "past_due", "trialing"].includes(sub.status);
          } catch { bump(t, "skipped"); continue; } // unknown state: do not guess, retry next run
        }
        if (!isEligibleForPriceNotice(
          { id: owner.id, email: owner.email, plan: owner.plan, status: owner.status, subscription_status: owner.subscriptionStatus, created_at: owner.createdAt },
          { planId: n.plan_id, noticeCreatedAt: n.created_at }, grandfathered, canceling)) { bump(t, "skipped"); continue; }

        bump(t, await sendPriceChangeNotice(admin, owner, {
          planId: n.plan_id, effectiveDate: n.effective_date, currency: n.currency,
          oldPriceCents: n.old_price_cents, newPriceCents: n.new_price_cents, oldMinutes: n.old_minutes, newMinutes: n.new_minutes,
        }, key));
      }
      if (rows.length < PAGE) break;
    }
  }
  return t;
}

async function suspensionReconcilePass(admin: SupabaseClient, now: Date): Promise<Tally> {
  const t = tally();
  const since = new Date(now.getTime() - 7 * 86400_000).toISOString();
  const { data, error } = await admin.from("profiles").select("id").eq("subscription_status", "suspended").eq("status", "suspended")
    .not("payment_failed_at", "is", null).gte("payment_grace_period_ends_at", since).limit(MAX_SENDS_PER_RUN);
  if (error) throw new Error(error.message);
  for (const r of data ?? []) bump(t, await notifyPaymentSuspended(admin, r.id as string));
  return t;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!checkSharedSecret(Deno.env.get("BILLING_NOTICES_CRON_SECRET"), req.headers.get("X-Cron-Secret"))) return json({ error: "Unauthorized." }, 401);

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) return json({ error: "STRIPE_SECRET_KEY is not set." }, 500);
  const stripe = new Stripe(stripeKey, { apiVersion: "2024-11-20.acacia" });
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const now = new Date();

  const result: Record<string, Tally | { error: string }> = {};
  for (const [name, run] of [
    ["renewal", () => renewalPass(admin, stripe, now)],
    ["price_change", () => priceChangePass(admin, stripe, now)],
    ["suspension_reconcile", () => suspensionReconcilePass(admin, now)],
  ] as const) {
    try { result[name] = await run(); }
    catch (e) {
      console.error(JSON.stringify({ event: "billing_notices_pass_failed", pass: name, error: e instanceof Error ? e.message : String(e) }));
      result[name] = { error: "pass_failed" };
    }
  }
  return json(result);
});
