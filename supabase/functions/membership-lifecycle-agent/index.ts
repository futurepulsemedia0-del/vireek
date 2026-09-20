// supabase/functions/membership-lifecycle-agent/index.ts
//
// Membership / Service Agreement Lifecycle Agent
//
// Daily cron. Handles every time-based transition memberships can't
// react to on their own (row triggers already cover "sold" and
// "cancelled" — see the migration):
//
//   1. Issue the renewal invoice — a REAL payment_request + Stripe
//      Connect Checkout session, exactly the way create-payment-request
//      builds one, so it inherits the existing send-payment-reminders
//      dunning for free.
//   2. Roll the billing period forward once that invoice is paid.
//   3. Flag past_due + start the grace-period clock when it isn't.
//   4. Flip to churned once the grace period runs out, and log it to
//      the shared revenue_recovery_events ledger.
//   5. Nudge members who haven't booked their included visit.
//   6. Flag proactive churn risk (paying for a benefit never used).
//
// All "please engage" messaging (steps 1's follow-up, 5, 6) is handed
// to the Call-to-Cash Workflow Engine via append_activity_event, so it
// goes through the SAME DNC-checked, throttled, human-in-the-loop-
// capable pipeline as every other automated message in this project —
// this function never sends a persuasive message directly, only the
// transactional "here is your invoice" one, matching the precedent set
// by create-payment-request.
//
// DEPLOYMENT: supabase functions deploy membership-lifecycle-agent
// --no-verify-jwt, then point your cron at it once a day.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripeRequest } from "../_shared/stripe/client.ts";
import { sendSms, sendEmail } from "../_shared/notify/deliver.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret" };
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const RENEWAL_LEAD_DAYS = 7;      // issue the invoice this many days before period end
const DUNNING_AFTER_DAYS = 3;     // renewal invoice unpaid this long -> past_due
const GRACE_PERIOD_DAYS = 14;     // past_due this long -> churned
const VISIT_DUE_AT_PCT = 0.5;     // nudge once >=50% of the period has elapsed, unused
const CHURN_RISK_AT_PCT = 0.8;    // flag risk once >=80% elapsed, still zero visits used

function addInterval(date: Date, interval: "monthly" | "yearly"): Date {
  const d = new Date(date);
  if (interval === "monthly") d.setMonth(d.getMonth() + 1);
  else d.setFullYear(d.getFullYear() + 1);
  return d;
}

async function enroll(admin: ReturnType<typeof createClient>, args: {
  aggregateId: string; eventType: string; userId: string;
  customerName: string | null; customerPhone: string | null; customerEmail: string | null;
  extra?: Record<string, unknown>;
}) {
  await admin.rpc("append_activity_event", {
    p_aggregate_type: "membership",
    p_aggregate_id: args.aggregateId,
    p_event_type: args.eventType,
    p_event_data: {
      customer_name: args.customerName, customer_phone: args.customerPhone, customer_email: args.customerEmail,
      ...(args.extra ?? {}),
    },
    p_actor_type: "ai",
    p_user_id: args.userId,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const now = new Date();
  const counts = { invoiced: 0, renewed: 0, past_due: 0, churned: 0, visit_nudged: 0, churn_risk: 0 };

  // -----------------------------------------------------------------
  // 1. ROLL PERIOD FORWARD — renewal invoice already paid
  // -----------------------------------------------------------------
  {
    const { data: candidates } = await admin
      .from("memberships")
      .select("id, user_id, plan_id, last_payment_request_id, current_period_start, current_period_end, membership_plans:plan_id(billing_interval, visits_included_per_period)")
      .in("status", ["active", "past_due"])
      .not("last_payment_request_id", "is", null);

    for (const m of candidates ?? []) {
      const { data: pr } = await admin.from("payment_requests").select("status, paid_at").eq("id", m.last_payment_request_id).maybeSingle();
      if (pr?.status !== "paid") continue;
      if (m.current_period_end && pr.paid_at && new Date(pr.paid_at) < new Date(m.current_period_end)) continue; // already rolled

      const plan = (m as any).membership_plans as { billing_interval: "monthly" | "yearly"; visits_included_per_period: number } | null;
      const interval = plan?.billing_interval ?? "yearly";
      const newStart = m.current_period_end ? new Date(m.current_period_end) : now;
      const newEnd = addInterval(newStart, interval);

      await admin.from("memberships").update({
        status: "active",
        current_period_start: newStart.toISOString(),
        current_period_end: newEnd.toISOString(),
        visits_included_current_period: plan?.visits_included_per_period ?? 0,
        visits_used_current_period: 0,
        dunning_stage: 0, payment_failed_at: null, payment_grace_period_ends_at: null,
      }).eq("id", m.id);
      counts.renewed++;
    }
  }

  // -----------------------------------------------------------------
  // 2. ISSUE RENEWAL INVOICE — period ending soon, nothing pending
  // -----------------------------------------------------------------
  {
    const cutoff = new Date(now.getTime() + RENEWAL_LEAD_DAYS * 86400_000).toISOString();
    const { data: due } = await admin
      .from("memberships")
      .select("id, user_id, plan_id, customer_name, customer_phone, customer_email, current_period_end, last_payment_request_id, membership_plans:plan_id(name, price_cents)")
      .eq("status", "active").eq("auto_renew", true)
      .lte("current_period_end", cutoff);

    for (const m of due ?? []) {
      if (m.last_payment_request_id) {
        const { data: pr } = await admin.from("payment_requests").select("status").eq("id", m.last_payment_request_id).maybeSingle();
        if (pr && ["pending", "sent", "overdue"].includes(pr.status)) continue; // already invoiced, still open
      }
      const plan = (m as any).membership_plans as { name: string; price_cents: number } | null;
      if (!plan || plan.price_cents <= 0) continue;
      if (!m.customer_email && !m.customer_phone) continue;

      const { data: connect } = await admin.from("stripe_connect_accounts").select("stripe_account_id, charges_enabled").eq("user_id", m.user_id).maybeSingle();
      if (!connect?.stripe_account_id || !connect.charges_enabled || !secretKey) continue;

      const { data: paymentRequest } = await admin.from("payment_requests").insert({
        user_id: m.user_id, customer_name: m.customer_name, customer_email: m.customer_email ?? null,
        customer_phone: m.customer_phone ?? null, amount: plan.price_cents / 100, status: "pending",
      }).select().single();
      if (!paymentRequest) continue;

      const description = `${plan.name} membership renewal — ${m.customer_name}`;
      const session = await stripeRequest("checkout/sessions", {
        mode: "payment",
        success_url: `${siteUrl}/pay-result?status=success`,
        cancel_url: `${siteUrl}/pay-result?status=cancel`,
        customer_email: m.customer_email ?? undefined,
        line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: plan.price_cents, product_data: { name: description } } }],
        payment_intent_data: { transfer_data: { destination: connect.stripe_account_id } },
        metadata: { payment_request_id: paymentRequest.id, membership_id: m.id, user_id: m.user_id },
      }, secretKey);

      await admin.from("payment_requests").update({ status: "sent", stripe_checkout_session_id: session.id, payment_link_url: session.url, last_reminder_sent_at: now.toISOString() }).eq("id", paymentRequest.id);
      await admin.from("memberships").update({ last_payment_request_id: paymentRequest.id, renewal_alert_stage: "sent", renewal_alert_sent_at: now.toISOString() }).eq("id", m.id);

      const amountLabel = `$${(plan.price_cents / 100).toFixed(0)}`;
      if (m.customer_phone) await sendSms(m.customer_phone, `Hi ${m.customer_name}, your ${plan.name} membership renews for ${amountLabel}. Pay securely: ${session.url}`);
      if (m.customer_email) await sendEmail(m.customer_email, `Your ${plan.name} membership renewal`, `<p>Your ${plan.name} membership renews for ${amountLabel}.</p><p><a href="${session.url}">Renew now</a></p>`, `Renew your ${plan.name} membership for ${amountLabel}: ${session.url}`);

      await enroll(admin, { aggregateId: m.id, eventType: "membership.renewal_upcoming", userId: m.user_id, customerName: m.customer_name, customerPhone: m.customer_phone, customerEmail: m.customer_email, extra: { amount_cents: plan.price_cents, payment_link_url: session.url } });
      counts.invoiced++;
    }
  }

  // -----------------------------------------------------------------
  // 3. PAST DUE — renewal invoice unpaid past DUNNING_AFTER_DAYS
  // -----------------------------------------------------------------
  {
    const { data: active } = await admin.from("memberships").select("id, user_id, customer_name, customer_phone, customer_email, last_payment_request_id, dunning_stage").eq("status", "active").not("last_payment_request_id", "is", null);
    for (const m of active ?? []) {
      const { data: pr } = await admin.from("payment_requests").select("status, created_at").eq("id", m.last_payment_request_id).maybeSingle();
      if (!pr || !["sent", "overdue", "failed"].includes(pr.status)) continue;
      const daysUnpaid = (now.getTime() - new Date(pr.created_at).getTime()) / 86400_000;
      if (daysUnpaid < DUNNING_AFTER_DAYS) continue;

      const graceEnds = new Date(now.getTime() + GRACE_PERIOD_DAYS * 86400_000);
      await admin.from("memberships").update({
        status: "past_due", dunning_stage: (m.dunning_stage ?? 0) + 1,
        payment_failed_at: now.toISOString(), payment_grace_period_ends_at: graceEnds.toISOString(),
      }).eq("id", m.id);
      await enroll(admin, { aggregateId: m.id, eventType: "membership.payment_failed", userId: m.user_id, customerName: m.customer_name, customerPhone: m.customer_phone, customerEmail: m.customer_email });
      counts.past_due++;
    }
  }

  // -----------------------------------------------------------------
  // 4. CHURNED — grace period expired with no successful payment
  // -----------------------------------------------------------------
  {
    const { data: pastDue } = await admin.from("memberships").select("id, user_id, plan_id, lead_id, customer_name, customer_phone").eq("status", "past_due").lt("payment_grace_period_ends_at", now.toISOString());
    for (const m of pastDue ?? []) {
      await admin.from("memberships").update({ status: "churned", churned_at: now.toISOString() }).eq("id", m.id);

      const { data: plan } = await admin.from("membership_plans").select("price_cents").eq("id", m.plan_id).maybeSingle();
      await admin.from("revenue_recovery_events").upsert({
        user_id: m.user_id, source_type: "membership_churned", source_table: "memberships", source_id: m.id,
        lead_id: m.lead_id, customer_name: m.customer_name, customer_phone: m.customer_phone,
        estimated_value_cents: plan?.price_cents ?? 0, estimated_value_basis: plan?.price_cents ? "membership_plan" : "none",
      }, { onConflict: "source_table,source_id", ignoreDuplicates: true });

      await enroll(admin, { aggregateId: m.id, eventType: "membership.churned", userId: m.user_id, customerName: m.customer_name, customerPhone: m.customer_phone, customerEmail: null });
      counts.churned++;
    }
  }

  // -----------------------------------------------------------------
  // 5. VISIT DUE — included visit unused, period half elapsed
  // -----------------------------------------------------------------
  {
    const { data: active } = await admin.from("memberships").select("id, user_id, customer_name, customer_phone, customer_email, current_period_start, current_period_end, visits_included_current_period, visits_used_current_period").eq("status", "active").gt("visits_included_current_period", 0);
    for (const m of active ?? []) {
      if (m.visits_used_current_period >= m.visits_included_current_period) continue;
      if (!m.current_period_start || !m.current_period_end) continue;
      const start = new Date(m.current_period_start).getTime();
      const end = new Date(m.current_period_end).getTime();
      const pct = (now.getTime() - start) / (end - start);
      if (pct < VISIT_DUE_AT_PCT) continue;

      const { data: scheduled } = await admin.from("membership_visits").select("id").eq("membership_id", m.id).eq("status", "scheduled").eq("period_end", m.current_period_end).maybeSingle();
      if (scheduled) continue;

      await enroll(admin, { aggregateId: m.id, eventType: "membership.visit_due", userId: m.user_id, customerName: m.customer_name, customerPhone: m.customer_phone, customerEmail: m.customer_email, extra: { visits_remaining: m.visits_included_current_period - m.visits_used_current_period } });
      counts.visit_nudged++;

      // >= CHURN_RISK_AT_PCT and STILL zero visits used = the strongest
      // available churn predictor (paying for a benefit never touched).
      if (pct >= CHURN_RISK_AT_PCT && m.visits_used_current_period === 0) {
        await admin.from("memberships").update({ churn_risk_score: Math.min(100, Math.round(pct * 100)) }).eq("id", m.id);
        await enroll(admin, { aggregateId: m.id, eventType: "membership.churn_risk", userId: m.user_id, customerName: m.customer_name, customerPhone: m.customer_phone, customerEmail: m.customer_email, extra: { reason: "unused_benefit" } });
        counts.churn_risk++;
      }
    }
  }

  return json({ ok: true, ...counts });
});
