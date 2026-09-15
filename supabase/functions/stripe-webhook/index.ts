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
// customer.subscription.deleted.
//
// --no-verify-jwt is required because Stripe calls this endpoint directly
// with no Supabase auth header — the Stripe signature check below (via
// STRIPE_WEBHOOK_SECRET) is what authenticates the request instead.

import Stripe from "npm:stripe@17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

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

  const urgencyColor = isFinal ? "#dc2626" : stage <= 1 ? "#111827" : "#b45309";

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
      <p style="font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: ${urgencyColor}; margin: 0 0 16px;">Billing update</p>
      <h1 style="font-size: 22px; margin: 0 0 16px;">Hi ${escapeHtml(greetingName)}, ${escapeHtml(headline.charAt(0).toLowerCase() + headline.slice(1))}</h1>
      <p style="font-size: 15px; line-height: 1.6; color: #374151;">
        We tried to charge your card for your Vireek subscription and it didn't go through. ${reasonLine}
      </p>
      <p style="font-size: 15px; line-height: 1.6; color: #374151;">
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
      <p style="margin-top: 24px; font-size: 13px; color: #9ca3af;">
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

  // Idempotency: Stripe redelivers events (retries, or you replaying them
  // from the Dashboard). If we've already logged this event id, stop here
  // before sending a second "your card was declined" email for the same
  // failure.
  const { error: dedupeError } = await admin
    .from("billing_events")
    .insert({ stripe_event_id: event.id, event_type: event.type, payload: event as unknown as Record<string, unknown> });
  if (dedupeError) {
    // Unique violation on stripe_event_id means we've already handled this
    // exact event — acknowledge with 200 so Stripe stops retrying it.
    if (dedupeError.code === "23505") {
      return new Response(JSON.stringify({ received: true, duplicate: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("Failed to log billing event:", dedupeError);
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

        const isFirstFailureInStreak = !profile.payment_failed_at;
        const failedAt = isFirstFailureInStreak ? new Date() : new Date(profile.payment_failed_at as string);
        const graceEndsAt = new Date(failedAt.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
        const nextStage = (profile.dunning_stage ?? 0) + 1;

        const declineReason =
          (invoice.last_finalization_error?.message as string | undefined) ??
          // Some accounts surface the reason on the underlying charge instead.
          null;

        await admin
          .from("profiles")
          .update({
            subscription_status: "past_due",
            dunning_stage: nextStage,
            payment_failed_at: failedAt.toISOString(),
            payment_grace_period_ends_at: graceEndsAt.toISOString(),
            last_payment_error: declineReason,
          })
          .eq("id", profile.id);

        const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
        const daysLeft = Math.max(1, Math.ceil((graceEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
        const email = buildDunningEmail({
          toEmail: profile.email,
          greetingName: profile.full_name?.split(" ")[0] || "there",
          stage: nextStage,
          daysLeft,
          declineReason,
          updatePaymentUrl: `${siteUrl}/dashboard/billing/update-payment`,
        });
        await sendEmail({ to: profile.email, ...email });
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
        if (!customerId) break;

        // A successful payment fully clears any in-progress dunning streak,
        // regardless of what stage it was at. Also lifts a suspension that
        // enforce-payment-suspension may have already applied.
        await admin
          .from("profiles")
          .update({
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

      case "customer.subscription.deleted": {
        // Stripe exhausted its own retry schedule and canceled the
        // subscription, or the customer canceled directly. Either way,
        // suspend immediately rather than waiting for our own grace period.
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
        if (!customerId) break;

        await admin
          .from("profiles")
          .update({ subscription_status: "suspended", status: "suspended" })
          .eq("stripe_customer_id", customerId);
        break;
      }

      default:
        // Not a dunning-relevant event — acknowledged and ignored.
        break;
    }
  } catch (err) {
    // We've already logged the event for idempotency above, so a failure
    // here means "retry the side effects", not "Stripe should resend this".
    // Returning 500 makes Stripe retry the whole delivery, which would hit
    // the dedupe check and no-op — so return 200 and just log loudly for
    // manual follow-up instead.
    console.error(`Error handling Stripe event ${event.type} (${event.id}):`, err);
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
