// Auto-invoicing for recurring visits. Runs inside recurring-jobs-cron after
// generation. A visit is invoiced once its job is `completed`:
//   pending/blocked  --claim-->  sending  -->  sent | pending (retry) | failed
//
// Safety properties:
//  - Atomic claim (UPDATE ... WHERE invoice_state IN ('pending','blocked')) so
//    two overlapping cron runs can never invoice the same visit twice.
//  - Idempotent against crashes: an existing payment_request for the job marks
//    the visit `sent` instead of creating a second Stripe session.
//  - Never throws for one bad row; every failure is recorded on the row.
//  - `blocked` (no Stripe, no contact info, no amount) is re-checked every run
//    so the invoice goes out as soon as the owner fixes it.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripeRequest } from "../stripe/client.ts";
import { sendEmail, sendSms } from "../notify/deliver.ts";

const MAX_PER_RUN = 50;
const MAX_ATTEMPTS = 5;
const STALE_CLAIM_MINUTES = 30;

export interface InvoiceRunSummary {
  sent: number;
  blocked: number;
  failed: number;
  retried: number;
  recovered: number;
}

interface PendingRow {
  id: string;
  user_id: string;
  agreement_id: string;
  job_id: string;
  invoice_attempts: number;
  job: {
    id: string;
    job_status: string;
    invoice_amount: number | null;
    customer_name: string;
    customer_phone: string | null;
    service_type: string | null;
  };
  agreement: { customer_email: string | null; customer_phone: string | null; title: string } | null;
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

async function setBlocked(admin: SupabaseClient, id: string, reason: string) {
  await admin.from("recurring_occurrences").update({ invoice_state: "blocked", invoice_error: reason }).eq("id", id);
}

/** Puts crashed `sending` claims back in play (or marks them sent when the request already exists). */
async function recoverStaleClaims(admin: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000).toISOString();
  const { data: stale } = await admin
    .from("recurring_occurrences")
    .select("id, job_id")
    .eq("invoice_state", "sending")
    .lt("invoice_claimed_at", cutoff)
    .limit(100);
  let recovered = 0;
  for (const row of stale ?? []) {
    const { data: existing } = await admin
      .from("payment_requests")
      .select("id")
      .eq("job_id", row.job_id)
      .neq("status", "canceled")
      .limit(1)
      .maybeSingle();
    await admin
      .from("recurring_occurrences")
      .update(existing ? { invoice_state: "sent", invoiced_at: new Date().toISOString(), invoice_error: null } : { invoice_state: "pending" })
      .eq("id", row.id)
      .eq("invoice_state", "sending");
    recovered += 1;
  }
  return recovered;
}

export async function processPendingInvoices(admin: SupabaseClient): Promise<InvoiceRunSummary> {
  const summary: InvoiceRunSummary = { sent: 0, blocked: 0, failed: 0, retried: 0, recovered: 0 };
  summary.recovered = await recoverStaleClaims(admin);

  const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

  const { data, error } = await admin
    .from("recurring_occurrences")
    .select(
      "id, user_id, agreement_id, job_id, invoice_attempts, job:jobs!inner(id, job_status, invoice_amount, customer_name, customer_phone, service_type), agreement:recurring_agreements(customer_email, customer_phone, title)",
    )
    .in("invoice_state", ["pending", "blocked"])
    .eq("status", "generated")
    .eq("job.job_status", "completed")
    .order("scheduled_datetime", { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) throw error;

  const stripeByUser = new Map<string, string | null>();

  for (const row of (data ?? []) as unknown as PendingRow[]) {
    try {
      const { job, agreement } = row;
      const amount = Number(job.invoice_amount);
      const email = agreement?.customer_email?.trim() || undefined;
      const phone = job.customer_phone?.trim() || agreement?.customer_phone?.trim() || undefined;

      // Idempotency: a payment request for this job already exists.
      const { data: existing } = await admin
        .from("payment_requests")
        .select("id")
        .eq("job_id", job.id)
        .neq("status", "canceled")
        .limit(1)
        .maybeSingle();
      if (existing) {
        await admin
          .from("recurring_occurrences")
          .update({ invoice_state: "sent", invoiced_at: new Date().toISOString(), invoice_error: null })
          .eq("id", row.id)
          .in("invoice_state", ["pending", "blocked"]);
        summary.sent += 1;
        continue;
      }

      if (!Number.isFinite(amount) || amount <= 0) {
        await setBlocked(admin, row.id, "The visit has no invoice amount.");
        summary.blocked += 1;
        continue;
      }
      if (!email && !phone) {
        await setBlocked(admin, row.id, "No customer email or phone to send the invoice to.");
        summary.blocked += 1;
        continue;
      }
      if (!secretKey) {
        await setBlocked(admin, row.id, "Payments aren't configured on this server (missing STRIPE_SECRET_KEY).");
        summary.blocked += 1;
        continue;
      }

      if (!stripeByUser.has(row.user_id)) {
        const { data: connect } = await admin
          .from("stripe_connect_accounts")
          .select("stripe_account_id, charges_enabled")
          .eq("user_id", row.user_id)
          .maybeSingle();
        stripeByUser.set(row.user_id, connect?.stripe_account_id && connect.charges_enabled ? connect.stripe_account_id : null);
      }
      const stripeAccountId = stripeByUser.get(row.user_id);
      if (!stripeAccountId) {
        await setBlocked(admin, row.id, "Connect and finish verifying your Stripe account to send invoices.");
        summary.blocked += 1;
        continue;
      }

      // Atomic claim — only one runner proceeds.
      const { data: claimed } = await admin
        .from("recurring_occurrences")
        .update({
          invoice_state: "sending",
          invoice_claimed_at: new Date().toISOString(),
          invoice_attempts: row.invoice_attempts + 1,
          invoice_error: null,
        })
        .eq("id", row.id)
        .in("invoice_state", ["pending", "blocked"])
        .select("id");
      if (!claimed || claimed.length === 0) continue;

      try {
        const { data: paymentRequest, error: insertError } = await admin
          .from("payment_requests")
          .insert({
            user_id: row.user_id,
            job_id: job.id,
            customer_name: job.customer_name,
            customer_email: email ?? null,
            customer_phone: phone ?? null,
            amount,
            status: "pending",
          })
          .select("id")
          .single();
        if (insertError || !paymentRequest) throw insertError ?? new Error("Could not create the payment request.");

        const description = agreement?.title ? `${agreement.title} — ${job.customer_name}` : `Invoice for ${job.customer_name}`;
        const session = await stripeRequest(
          "checkout/sessions",
          {
            mode: "payment",
            success_url: `${siteUrl}/pay-result?status=success`,
            cancel_url: `${siteUrl}/pay-result?status=cancel`,
            customer_email: email,
            line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: Math.round(amount * 100), product_data: { name: description } } }],
            payment_intent_data: { transfer_data: { destination: stripeAccountId } },
            metadata: { payment_request_id: paymentRequest.id, job_id: job.id, user_id: row.user_id, recurring_occurrence_id: row.id },
          },
          secretKey,
        );

        await admin
          .from("payment_requests")
          .update({ status: "sent", stripe_checkout_session_id: session.id, payment_link_url: session.url, last_reminder_sent_at: new Date().toISOString() })
          .eq("id", paymentRequest.id);
        await admin.from("jobs").update({ invoice_status: "sent" }).eq("id", job.id).eq("invoice_status", "not_sent");

        const amountLabel = `$${amount.toFixed(2)}`;
        if (phone) await sendSms(phone, `Hi ${job.customer_name}, your ${amountLabel} invoice for ${agreement?.title ?? "your recent visit"} is ready. Pay securely: ${session.url}`);
        if (email) {
          await sendEmail(
            email,
            `Your ${amountLabel} invoice is ready`,
            `<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
              <p style="font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin: 0 0 16px;">Invoice ready</p>
              <h1 style="font-size: 22px; margin: 0 0 16px;">${amountLabel} due for ${escapeHtml(description)}</h1>
              <a href="${session.url}" style="display: inline-block; margin-top: 8px; padding: 12px 24px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px;">Pay ${amountLabel} now</a>
              <p style="margin-top: 24px; font-size: 13px; color: #9ca3af;">Secure payment powered by Stripe.</p>
            </div>`,
            `Your ${amountLabel} invoice is ready. Pay securely: ${session.url}`,
          );
        }

        await admin
          .from("recurring_occurrences")
          .update({ invoice_state: "sent", invoiced_at: new Date().toISOString(), invoice_error: null })
          .eq("id", row.id);
        summary.sent += 1;
      } catch (sendError) {
        const exhausted = row.invoice_attempts + 1 >= MAX_ATTEMPTS;
        await admin
          .from("recurring_occurrences")
          .update({ invoice_state: exhausted ? "failed" : "pending", invoice_error: errorText(sendError) })
          .eq("id", row.id);
        if (exhausted) {
          summary.failed += 1;
          await admin.from("notifications").insert({
            user_id: row.user_id,
            type: "recurring_invoice_failed",
            title: "A recurring-visit invoice could not be sent",
            message: `${row.job.customer_name}: ${errorText(sendError)}`,
            action_url: "/dashboard/recurring-jobs",
          });
        } else {
          summary.retried += 1;
        }
      }
    } catch (rowError) {
      console.error(JSON.stringify({ event: "recurring_invoice_row_failed", occurrence_id: row.id, error: errorText(rowError) }));
    }
  }
  return summary;
}
