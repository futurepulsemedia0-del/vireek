// supabase/functions/stripe-webhook/index.ts
//
// Receives Stripe billing events and drives the dunning lifecycle:
//   invoice.payment_failed      -> mark past_due, bump dunning_stage,
//                                  send the matching escalation email
//   invoice.payment_succeeded   -> clear dunning state back to active
//   customer.subscription.deleted -> hard-suspend immediately (Stripe gave
//                                  up retrying, or the customer canceled)
//
// This function does NOT decide the retry schedule or how many times to
// retry a card — that's Stripe Billing's own Smart Retries, configured in
// the Stripe Dashboard under Settings -> Billing -> Subscriptions and
// emails -> Manage failed payments. This function only reacts to each
// attempt Stripe already made and keeps our own DB + emails in sync with
// it. The actual suspend-after-grace-period cutoff is handled by the
// separate `enforce-payment-suspension` scheduled function, since that
// needs to fire on the *passage of time*, not a Stripe event.
//
// Required secrets (set once):
//   supabase secrets set STRIPE_SECRET_KEY=sk_live_xxxxxxxxxxxx
//   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx
//   supabase secrets set RESEND_API_KEY=re_xxxxxxxxxxxx
//   supabase secrets set RESEND_FROM_EMAIL="Vireek Billing <billing@yourdomain.com>"
//   supabase secrets set SITE_URL=https://vireek.com
//
// Deploy:
//   supabase functions deploy stripe-webhook --no-verify-jwt
//
// Then in the Stripe Dashboard -> Developers -> Webhooks, add an endpoint
// pointing at:
//   https://<project-ref>.supabase.co/functions/v1/stripe-webhook
// subscribed to: invoice.payment_failed, invoice.payment_succeeded,
// customer.subscription.deleted, checkout.session.completed,
// customer.subscription.updated, invoice.created, checkout.session.async_payment_succeeded.
//
// --no-verify-jwt is required because Stripe calls this endpoint directly
// with no Supabase auth header — the Stripe signature check below (via
// STRIPE_WEBHOOK_SECRET) is what authenticates the request instead.

import Stripe from "npm:stripe@17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { computeDunningUpdate, computeRecoveryUpdate } from "../_shared/stripe/dunningLogic.ts";
import { minutesForPlan, minutesToSyncOnPlanSync, planIdFromPriceId } from "../_shared/billing/planCatalog.ts";
import {
  processOverageInvoice,
  type InvoiceItemLike,
  type InvoiceLike,
  type OverageDeps,
  type UsagePeriodRow,
} from "../_shared/billing/overage.ts";
import {
  TOPUP_PRICE_ENV,
  isTopupSession,
  processTopupReversal,
  processTopupSession,
  type TopupDeps,
  type TopupLineItemLike,
  type TopupReversalDeps,
  type TopupSessionLike,
} from "../_shared/billing/topup.ts";
import { notifyPaymentSuspended } from "../_shared/billing/notices/dispatch.ts";
import {
  chargeRefundToClawbackArgs,
  disputeToClawbackArgs,
  disputeToReinstatementArgs,
  invoiceToEarnArgs,
} from "../_shared/partner-commission/stripeMapping.ts";
import { buildTrialEndingEmail } from "../_shared/billing/trialEmail.ts";
import {
  applyCheckoutSession,
  applyInvoicePaid,
  applySubscription,
  type StripeClientLike,
  type StripeSubscriptionLike,
} from "../_shared/billing/trialWebhook.ts";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Stripe-Signature",
};

// How long a customer gets, from the *first* failed payment in a streak,
// before the account is suspended. Matches the copy in the escalation
// emails below — change both together if you tune this.
const GRACE_PERIOD_DAYS = 7;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface DunningEmailParams {
  toEmail: string;
  greetingName: string;
  stage: number;
  daysLeft: number;
  declineReason: string | null;
  updatePaymentUrl: string;
}

/**
 * Builds the escalating dunning email. Stage 1 is informational ("we'll
 * retry automatically"); later stages get progressively more urgent; the
 * final one (isFinal) tells the customer the grace period is over today.
 */
function buildDunningEmail({ toEmail, greetingName, stage, daysLeft, declineReason, updatePaymentUrl }: DunningEmailParams) {
  const isFinal = daysLeft <= 1;
  const reasonLine = declineReason
    ? `Your bank gave this reason: <em>${escapeHtml(declineReason)}</em>.`
    : `Your bank didn't share a specific reason.`;

  const subject = isFinal
    ? "Action needed today: your Vireek payment method"
    : stage <= 1
      ? "We couldn't process your Vireek payment"
      : `Reminder: update your Vireek payment method (${daysLeft} day${daysLeft === 1 ? "" : "s"} left)`;

  const headline = isFinal
    ? "Your Vireek account will be paused today"
    : stage <= 1
      ? "We had trouble charging your card"
      : "Your Vireek subscription is still past due";

  const urgencyColor = isFinal ? "#d4222a" : stage <= 1 ? "#1C1B15" : "#a93b0f";

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1c1b15;">
      <p style="font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: ${urgencyColor}; margin: 0 0 16px;">Billing update</p>
      <h1 style="font-size: 22px; margin: 0 0 16px;">Hi ${escapeHtml(greetingName)}, ${escapeHtml(headline.charAt(0).toLowerCase() + headline.slice(1))}</h1>
      <p style="font-size: 15px; line-height: 1.6; color: #44423D;">
        We tried to charge your card for your Vireek subscription and it didn't go through. ${reasonLine}
      </p>
      <p style="font-size: 15px; line-height: 1.6; color: #44423D;">
        ${
          isFinal
            ? "Sarah will stop answering calls for your business until this is resolved. Update your payment method now to avoid any interruption."
            : `We'll keep retrying automatically, but to avoid any interruption to your AI receptionist, please update your payment method within <strong>${daysLeft} day${daysLeft === 1 ? "" : "s"}</strong>.`
        }
      </p>
      <a href="${updatePaymentUrl}"
         style="display: inline-block; margin-top: 24px; padding: 12px 24px; background: ${urgencyColor}; color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px;">
        Update payment method
      </a>
      <p style="margin-top: 24px; font-size: 13px; color: #a9a8a2;">
        Sent to ${escapeHtml(toEmail)} because a payment on your Vireek account failed. If you've already updated your card, you can ignore this — it may take a few minutes to reflect.
      </p>
    </div>
  `;

  const text = `${headline}\n\nWe tried to charge your card for your Vireek subscription and it didn't go through. ${declineReason ?? "Your bank didn't share a specific reason."}\n\n${
    isFinal
      ? "Sarah will stop answering calls for your business until this is resolved."
      : `We'll keep retrying automatically, but please update your payment method within ${daysLeft} day(s) to avoid any interruption.`
  }\n\nUpdate your payment method: ${updatePaymentUrl}`;

  return { subject, html, text };
}

async function sendEmail(params: { to: string; subject: string; html: string; text: string }) {
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!resendApiKey) {
    console.error("RESEND_API_KEY is not set — skipping dunning email send.");
    return;
  }
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "Vireek Billing <onboarding@resend.dev>";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: fromEmail, to: [params.to], subject: params.subject, html: params.html, text: params.text }),
  });

  if (!res.ok) {
    console.error("Resend error sending dunning email:", await res.text());
  }
}

type AdminClient = ReturnType<typeof createClient>;

/** Real Stripe/Supabase I/O for overage invoicing (logic lives in _shared/billing/overage.ts). */
function buildOverageDeps(stripe: Stripe, admin: AdminClient): OverageDeps {
  return {
    findProfilesByCustomer: async (customerId) => {
      const { data, error } = await admin.from("profiles").select("id, plan, usage_period_plan").eq("stripe_customer_id", customerId).limit(2);
      if (error) throw new Error(`profile lookup failed: ${error.message}`);
      return (data ?? []) as { id: string; plan: string | null; usage_period_plan: string | null }[];
    },
    planFromPriceId: (priceId) => planIdFromPriceId(priceId, (key) => Deno.env.get(key)),
    setPeriodPlan: async (userId, plan) => {
      const { error } = await admin.from("profiles").update({ usage_period_plan: plan }).eq("id", userId);
      if (error) throw new Error(`usage_period_plan update failed: ${error.message}`);
    },
    retrieveInvoice: async (invoiceId) => (await stripe.invoices.retrieve(invoiceId)) as unknown as InvoiceLike,
    listInvoiceItems: async (invoiceId) => {
      const out: InvoiceItemLike[] = [];
      for await (const item of stripe.invoiceItems.list({ invoice: invoiceId, limit: 100 })) {
        out.push({ id: item.id, metadata: item.metadata });
        if (out.length >= 250) break;
      }
      return out;
    },
    createInvoiceItem: async (params, idempotencyKey) => {
      const item = await stripe.invoiceItems.create(params, { idempotencyKey });
      return { id: item.id };
    },
    rollover: async (args) => {
      const { data, error } = await admin.rpc("period_rollover", args);
      if (error || !data) throw new Error(`period_rollover failed: ${error?.message ?? "empty result"}`);
      return data as UsagePeriodRow;
    },
    setBilling: async (args) => {
      const { data, error } = await admin.rpc("usage_period_set_billing", args);
      if (error) throw new Error(`usage_period_set_billing failed: ${error.message}`);
      return (data ?? null) as UsagePeriodRow | null;
    },
    log: (event, detail) => console.log(JSON.stringify({ event, ...detail })),
  };
}

/** Real Supabase I/O for top-up refund / dispute reversal (logic lives in _shared/billing/topup.ts). */
function buildReversalDeps(admin: AdminClient): TopupReversalDeps {
  return {
    reverse: async (args) => {
      const { data, error } = await admin.rpc("reverse_topup", args);
      if (error) throw new Error(`reverse_topup failed: ${error.message}`);
      return data as "reversed" | "noop" | "not_topup";
    },
    log: (event, detail) => console.log(JSON.stringify({ event, ...detail })),
  };
}
/** Real Stripe/Supabase I/O for top-up credits (logic lives in _shared/billing/topup.ts). */
function buildTopupDeps(stripe: Stripe, admin: AdminClient): TopupDeps {
  return {
    expectedPriceId: Deno.env.get(TOPUP_PRICE_ENV) || undefined,
    listLineItems: async (sessionId) => {
      const out: TopupLineItemLike[] = [];
      for await (const li of stripe.checkout.sessions.listLineItems(sessionId, { limit: 100 })) {
        out.push({ price: li.price ? { id: li.price.id } : null, quantity: li.quantity });
        if (out.length >= 100) break;
      }
      return out;
    },
    findProfilesByCustomer: async (customerId) => {
      const { data, error } = await admin.from("profiles").select("id, stripe_customer_id").eq("stripe_customer_id", customerId).limit(2);
      if (error) throw new Error(`profile lookup failed: ${error.message}`);
      return (data ?? []) as { id: string; stripe_customer_id: string | null }[];
    },
    recordCredit: async (args) => {
      const { data, error } = await admin.rpc("credit_topup", args);
      if (error) throw new Error(`credit_topup failed: ${error.message}`);
      return data as "credited" | "duplicate" | "rejected";
    },
    log: (event, detail) => console.log(JSON.stringify({ event, ...detail })),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!stripeSecretKey || !webhookSecret) {
    console.error("Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET secret.");
    return new Response("Webhook not configured.", { status: 500, headers: corsHeaders });
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-11-20.acacia" });

  // Signature verification needs the *raw* body — read it as text first,
  // never req.json(), or the signature check will fail.
  const rawBody = await req.text();
  const signature = req.headers.get("Stripe-Signature");
  if (!signature) {
    return new Response("Missing Stripe-Signature header.", { status: 400, headers: corsHeaders });
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("Stripe signature verification failed:", err);
    return new Response("Invalid signature.", { status: 400, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  // Idempotency + retry safety (migration 20290202000000_billing_events_processing_state.sql).
  const { data: claim, error: claimError } = await admin.rpc("claim_billing_event", {
    p_event_id: event.id,
    p_event_type: event.type,
    p_payload: event as unknown as Record<string, unknown>,
  });
  if (claimError) {
    console.error("Failed to claim billing event:", claimError.message);
    return new Response("Temporarily unavailable.", { status: 500, headers: corsHeaders });
  }
  if (claim === "duplicate") {
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (claim === "in_progress") {
    return new Response("Event is being processed.", { status: 409, headers: corsHeaders });
  }

  try {
    switch (event.type) {
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
        if (!customerId) break;

        const { data: profile } = await admin
          .from("profiles")
          .select("id, email, full_name, dunning_stage, payment_failed_at")
          .eq("stripe_customer_id", customerId)
          .maybeSingle();
        if (!profile) {
          console.error(`No profile found for Stripe customer ${customerId}`);
          break;
        }

        const declineReason =
          (invoice.last_finalization_error?.message as string | undefined) ??
          // Some accounts surface the reason on the underlying charge instead.
          null;

        const update = computeDunningUpdate(
          { dunning_stage: profile.dunning_stage ?? 0, payment_failed_at: profile.payment_failed_at as string | null },
          declineReason,
        );

        await admin
          .from("profiles")
          .update({
            subscription_status: update.subscription_status,
            dunning_stage: update.dunning_stage,
            payment_failed_at: update.payment_failed_at,
            payment_grace_period_ends_at: update.payment_grace_period_ends_at,
            last_payment_error: update.last_payment_error,
          })
          .eq("id", profile.id)
          .throwOnError();

        const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
        const daysLeft = update.daysLeft;
        const email = buildDunningEmail({
          toEmail: profile.email,
          greetingName: profile.full_name?.split(" ")[0] || "there",
          stage: update.dunning_stage,
          daysLeft,
          declineReason,
          updatePaymentUrl: `${siteUrl}/dashboard/billing/update-payment`,
        });
        // update بالا idempotent نیست (dunning_stage را جلو می‌برد)؛ خطای ایمیل نباید retry بسازد.
        try {
          await sendEmail({ to: profile.email, ...email });
        } catch (mailErr) {
          console.error("dunning email failed (not retried):", mailErr);
        }
        break;
      }

      case "invoice.paid": {
        await applyInvoicePaid(admin, event.data.object as unknown as Parameters<typeof applyInvoicePaid>[1], event.created);
        break;
      }
      case "invoice.payment_succeeded": {
        await applyInvoicePaid(admin, event.data.object as unknown as Parameters<typeof applyInvoicePaid>[1], event.created);
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
        if (!customerId) break;

        // A successful payment fully clears any in-progress dunning streak,
        // regardless of what stage it was at. Also lifts a suspension that
        // enforce-payment-suspension may have already applied.
        await admin.from("profiles").update(computeRecoveryUpdate()).eq("stripe_customer_id", customerId);
        const earnArgs = invoiceToEarnArgs(invoice as unknown as Parameters<typeof invoiceToEarnArgs>[0]);
        if (earnArgs) {
          const { error: commissionError } = await admin.rpc("record_partner_commission_for_invoice", earnArgs);
          // Idempotent RPC: throwing makes Stripe retry the whole event safely.
          if (commissionError) throw new Error(`partner commission earn failed: ${commissionError.message}`);
        }
        break;
      }
      case "customer.subscription.trial_will_end": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
        if (!customerId) break;
        const { data: p } = await admin
          .from("profiles")
          .select("id, email, full_name, plan, trial_state, trial_ends_at, minutes_used_this_month")
          .eq("stripe_customer_id", customerId)
          .maybeSingle();
        if (!p || p.trial_state !== "trialing" || !p.email) break;
        const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
        const mail = buildTrialEndingEmail({
          greetingName: p.full_name?.split(" ")[0] || "there",
          planName: p.plan ? p.plan.charAt(0).toUpperCase() + p.plan.slice(1) : "Vireek",
          trialEndsAt: p.trial_ends_at ?? (sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : ""),
          minutesUsed: Number(p.minutes_used_this_month) || 0,
          manageUrl: `${siteUrl}/dashboard/billing`,
        });
        // خطای ایمیل نباید retry بسازد (ایمیل تکراری نفرست).
        try { await sendEmail({ to: p.email, ...mail }); } catch (mailErr) { console.error("trial-ending email failed (not retried):", mailErr); }
        break;
      }
      case "customer.subscription.deleted": {
        // Stripe exhausted its own retry schedule and canceled the
        // subscription, or the customer canceled directly. Either way,
        // suspend immediately rather than waiting for our own grace period.
        const subscription = event.data.object as Stripe.Subscription;
        if ((await applySubscription(admin, stripe as unknown as StripeClientLike, subscription as unknown as StripeSubscriptionLike, { eventType: "deleted", eventCreated: event.created }, (k) => Deno.env.get(k))).handled) break;
        const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
        if (!customerId) break;

        await admin
          .from("profiles")
          .update({ subscription_status: "suspended", status: "suspended" })
          .eq("stripe_customer_id", customerId);
        // Owner notice only when Stripe gave up on payment (not on a voluntary cancel).
        // Idempotent (billing_notice_log); the hourly send-billing-notices pass re-tries any failure.
        if (subscription.cancellation_details?.reason === "payment_failed") {
          try {
            const { data: suspendedProfile } = await admin.from("profiles").select("id").eq("stripe_customer_id", customerId).maybeSingle();
            if (suspendedProfile?.id) await notifyPaymentSuspended(admin, suspendedProfile.id as string, subscription.id);
          } catch (noticeErr) {
            console.error("payment suspension notice failed (reconciled hourly):", noticeErr);
          }
        }
        break;
      }
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (isTopupSession(session)) {
          const result = await processTopupSession(session as unknown as TopupSessionLike, buildTopupDeps(stripe, admin));
          console.log(JSON.stringify({ event: "topup_session_processed", session: session.id, result }));
          break;
        }
        if (session.mode !== "subscription" || !session.subscription) break;
        {
          const r = await applyCheckoutSession(admin, stripe as unknown as StripeClientLike, session as unknown as Parameters<typeof applyCheckoutSession>[2], event.created, (k) => Deno.env.get(k));
          if (r.handled) break;
        }
        const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
        const planId = session.metadata?.plan_id as string | undefined;
        if (session.metadata?.results_plan === "1" && session.metadata.supabase_user_id) {
          const rpUser = session.metadata.supabase_user_id;
          const { data: rpAcct } = await admin.from("results_plan_accounts").select("terms_id").eq("user_id", rpUser).maybeSingle();
          if (rpAcct?.terms_id) {
            const { data: rpTerms } = await admin.from("results_plan_pricing_terms").select("fair_use_minutes").eq("id", rpAcct.terms_id).maybeSingle();
            if (rpTerms?.fair_use_minutes) await admin.from("profiles").update({ minutes_included: rpTerms.fair_use_minutes }).eq("id", rpUser);
          }
          const { error: rpErr } = await admin
            .from("results_plan_accounts")
            .update({ status: "active", opted_in_at: new Date().toISOString(), opted_in_by: rpUser, updated_at: new Date().toISOString() })
            .eq("user_id", rpUser)
            .eq("status", "draft");
          if (rpErr) console.error("results plan activation failed", rpErr.message);
        }
        if (session.metadata?.results_plan === "1" && session.metadata.supabase_user_id) {
          const { error: rpErr } = await admin
            .from("results_plan_accounts")
            .update({ status: "active", opted_in_at: new Date().toISOString(), opted_in_by: session.metadata.supabase_user_id, updated_at: new Date().toISOString() })
            .eq("user_id", session.metadata.supabase_user_id)
            .eq("status", "draft");
          if (rpErr) console.error("results plan activation failed", rpErr.message);
        }
        if (!customerId) break;

        await admin
          .from("profiles")
          .update({
            stripe_subscription_id: subscriptionId,
            plan: planId ?? undefined,
            minutes_included: planId ? (minutesForPlan(planId) ?? undefined) : undefined,
            subscription_status: "active",
            status: "active",
            dunning_stage: 0,
            payment_failed_at: null,
            payment_grace_period_ends_at: null,
            last_payment_error: null,
          })
          .eq("stripe_customer_id", customerId);
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        // اگه کاربر پلن رو از داخل Stripe Billing Portal عوض کنه، این کیس
        // profiles.plan رو هم‌سو نگه می‌داره.
        const subscription = event.data.object as Stripe.Subscription;
        {
          const r = await applySubscription(admin, stripe as unknown as StripeClientLike, subscription as unknown as StripeSubscriptionLike, { eventType: event.type === "customer.subscription.created" ? "created" : "updated", eventCreated: event.created }, (k) => Deno.env.get(k));
          if (r.handled || event.type === "customer.subscription.created") break;
        }
        const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
        // The price on the subscription is the source of truth: it also covers
        // scheduled downgrades, which flip the price (not the metadata) at renewal.
        const planId =
          planIdFromPriceId(subscription.items.data[0]?.price.id, (key) => Deno.env.get(key)) ??
          (subscription.metadata?.plan_id as string | undefined);
        if (!customerId || !planId) break;

        // Grandfathering: this event also fires on renewals, payment retries and metadata edits, so the included
        // minutes may only be (re)written when the plan really changed (see minutesToSyncOnPlanSync).
        const { data: current, error: currentError } = await admin
          .from("profiles")
          .select("plan, minutes_included")
          .eq("stripe_customer_id", customerId)
          .maybeSingle();
        if (currentError) throw new Error(`profile lookup failed: ${currentError.message}`); // => 500, Stripe retries
        if (!current) break;
        const syncedMinutes = minutesToSyncOnPlanSync({
          currentPlan: current.plan,
          currentMinutes: current.minutes_included,
          targetPlan: planId,
        });
        const { error: syncError } = await admin
          .from("profiles")
          .update(syncedMinutes === undefined ? { plan: planId } : { plan: planId, minutes_included: syncedMinutes })
          .eq("stripe_customer_id", customerId);
        if (syncError) throw new Error(`profile plan sync failed: ${syncError.message}`);
        break;
      }
      case "charge.refunded": {
        const args = chargeRefundToClawbackArgs(event.id, event.data.object as unknown as Parameters<typeof chargeRefundToClawbackArgs>[1]);
        if (!args) break;
        const { error: clawbackError } = await admin.rpc("record_partner_commission_clawback", args);
        if (clawbackError) throw new Error(`partner commission clawback failed: ${clawbackError.message}`);
        break;
      }
      case "charge.dispute.created":
      case "charge.dispute.closed": {
        const dispute = event.data.object as Stripe.Dispute;
        // A lost dispute is already clawed back at creation; only "won" needs action when it closes.
        if (event.type === "charge.dispute.closed" && dispute.status !== "won") break;
        const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
        if (!chargeId) break;
        const charge = (await stripe.charges.retrieve(chargeId)) as unknown as Parameters<typeof disputeToClawbackArgs>[2];
        const disputeLike = dispute as unknown as Parameters<typeof disputeToClawbackArgs>[1];
        if (event.type === "charge.dispute.created") {
          const args = disputeToClawbackArgs(event.id, disputeLike, charge);
          if (!args) break;
          const { error: e1 } = await admin.rpc("record_partner_commission_clawback", args);
          if (e1) throw new Error(`partner commission dispute clawback failed: ${e1.message}`);
        } else {
          const args = disputeToReinstatementArgs(event.id, disputeLike, charge);
          if (!args) break;
          const { error: e2 } = await admin.rpc("record_partner_commission_reinstatement", args);
          if (e2) throw new Error(`partner commission reinstatement failed: ${e2.message}`);
        }
        break;
      }
      case "invoice.created": {
        // Renewal draft invoice: close the previous usage period and (policy = bill) add ONE overage item.
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.billing_reason !== "subscription_cycle" && invoice.billing_reason !== "subscription_create") break;
        const result = await processOverageInvoice(invoice as unknown as InvoiceLike, buildOverageDeps(stripe, admin));
        console.log(JSON.stringify({ event: "overage_invoice_processed", invoice: invoice.id, result }));
        break;
      }
      case "checkout.session.async_payment_succeeded": {
        // Delayed payment methods: credit the top-up pack once the money has really arrived.
        const session = event.data.object as Stripe.Checkout.Session;
        if (!isTopupSession(session)) break;
        const result = await processTopupSession(session as unknown as TopupSessionLike, buildTopupDeps(stripe, admin));
        console.log(JSON.stringify({ event: "topup_session_processed", session: session.id, result }));
        break;
      }
      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
        const result = await processTopupReversal(
          { paymentIntentId, cumulativeAmountCents: charge.amount_refunded, reason: "refund" },
          buildReversalDeps(admin),
        );
        console.log(JSON.stringify({ event: "topup_refund_processed", charge: charge.id, result }));
        break;
      }
      case "charge.dispute.created": {
        const dispute = event.data.object as Stripe.Dispute;
        const paymentIntentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
        const result = await processTopupReversal(
          { paymentIntentId, cumulativeAmountCents: dispute.amount, reason: "dispute" },
          buildReversalDeps(admin),
        );
        console.log(JSON.stringify({ event: "topup_dispute_processed", dispute: dispute.id, result }));
        break;
      }
      default:
        // Not a dunning-relevant event — acknowledged and ignored.
        break;
    }
    console.error(`Error handling Stripe event ${event.type} (${event.id}):`, err);
    await admin.rpc("complete_billing_event", {
      p_event_id: event.id,
      p_error: err instanceof Error ? err.message : String(err),
    });
    // 500 => Stripe دوباره می‌فرستد و claim مقدار 'retry' برمی‌گرداند.
    return new Response("Handler failed; will retry.", { status: 500, headers: corsHeaders });
  }

  const { error: completeError } = await admin.rpc("complete_billing_event", { p_event_id: event.id, p_error: null });
  if (completeError) console.error("Failed to mark billing event processed:", completeError.message);

  return new Response(JSON.stringify({ received: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
