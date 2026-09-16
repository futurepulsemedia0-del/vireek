import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripeRequest } from "../_shared/stripe/client.ts";
import { sendSms, sendEmail } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}

async function resolveAccountOwnerId(admin: any, caller: { id: string; email?: string | null }): Promise<string> {
  const { data: profile } = await admin.from("profiles").select("id").eq("id", caller.id).maybeSingle();
  if (profile) return profile.id;
  const { data: member } = await admin.from("team_members").select("account_owner_id").eq("member_email", caller.email ?? "").maybeSingle();
  return member?.account_owner_id ?? caller.id;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse({ error: "Missing Authorization header." }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session." }, 401);
    const caller = userData.user;

    const body = await req.json().catch(() => ({}));
    const jobId = body.job_id as string | undefined;
    const customerEmail = (body.customer_email as string | undefined)?.trim() || undefined;
    const customerPhoneInput = (body.customer_phone as string | undefined)?.trim() || undefined;
    if (!jobId) return jsonResponse({ error: "job_id is required." }, 400);

    const ownerId = await resolveAccountOwnerId(admin, caller);

    const { data: job } = await admin
      .from("jobs")
      .select("id, user_id, customer_name, customer_phone, service_type, invoice_amount")
      .eq("id", jobId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (!job) return jsonResponse({ error: "Job not found." }, 404);
    if (!job.invoice_amount || job.invoice_amount <= 0) return jsonResponse({ error: "Set an invoice amount on this job first." }, 400);

    const customerPhone = customerPhoneInput || job.customer_phone || undefined;
    if (!customerEmail && !customerPhone) {
      return jsonResponse({ error: "Add a customer email or phone number to send the payment request to." }, 400);
    }

    const { data: connect } = await admin
      .from("stripe_connect_accounts")
      .select("stripe_account_id, charges_enabled")
      .eq("user_id", ownerId)
      .maybeSingle();
    if (!connect?.stripe_account_id || !connect.charges_enabled) {
      return jsonResponse({ error: "Connect and finish verifying your Stripe account before sending payment requests." }, 400);
    }

    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
    if (!secretKey) return jsonResponse({ error: "Payments aren't configured on this server yet (missing STRIPE_SECRET_KEY)." }, 500);

    const { data: paymentRequest, error: insertError } = await admin
      .from("payment_requests")
      .insert({
        user_id: ownerId,
        job_id: job.id,
        customer_name: job.customer_name,
        customer_email: customerEmail ?? null,
        customer_phone: customerPhone ?? null,
        amount: job.invoice_amount,
        status: "pending",
      })
      .select()
      .single();
    if (insertError || !paymentRequest) throw insertError || new Error("Could not create the payment request.");

    const description = job.service_type ? `${job.service_type} — ${job.customer_name}` : `Invoice for ${job.customer_name}`;

    const session = await stripeRequest(
      "checkout/sessions",
      {
        mode: "payment",
        success_url: `${siteUrl}/pay-result?status=success`,
        cancel_url: `${siteUrl}/pay-result?status=cancel`,
        customer_email: customerEmail,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: Math.round(Number(job.invoice_amount) * 100),
              product_data: { name: description },
            },
          },
        ],
        payment_intent_data: { transfer_data: { destination: connect.stripe_account_id } },
        metadata: { payment_request_id: paymentRequest.id, job_id: job.id, user_id: ownerId },
      },
      secretKey,
    );

    await admin
      .from("payment_requests")
      .update({
        status: "sent",
        stripe_checkout_session_id: session.id,
        payment_link_url: session.url,
        last_reminder_sent_at: new Date().toISOString(),
      })
      .eq("id", paymentRequest.id);

    await admin.from("jobs").update({ invoice_status: "sent" }).eq("id", job.id).eq("invoice_status", "not_sent");

    const amountLabel = `$${Number(job.invoice_amount).toFixed(2)}`;
    if (customerPhone) {
      await sendSms(customerPhone, `Hi ${job.customer_name}, your invoice for ${amountLabel} is ready. Pay securely: ${session.url}`);
    }
    if (customerEmail) {
      await sendEmail(
        customerEmail,
        `Your ${amountLabel} invoice is ready`,
        `<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
          <p style="font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin: 0 0 16px;">Invoice ready</p>
          <h1 style="font-size: 22px; margin: 0 0 16px;">${amountLabel} due for ${escapeHtml(description)}</h1>
          <a href="${session.url}" style="display: inline-block; margin-top: 8px; padding: 12px 24px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px;">Pay ${amountLabel} now</a>
          <p style="margin-top: 24px; font-size: 13px; color: #9ca3af;">Secure payment powered by Stripe.</p>
        </div>`,
        `${amountLabel} due for ${description}. Pay securely: ${session.url}`,
      );
    }

    return jsonResponse({ payment_request_id: paymentRequest.id, payment_link_url: session.url });
  } catch (error) {
    console.error(JSON.stringify({ event: "create_payment_request_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Something went wrong creating the payment request." }, 500);
  }
});
