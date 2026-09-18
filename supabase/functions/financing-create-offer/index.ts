// supabase/functions/financing-create-offer/index.ts
//
// Same dual-client convention as create-payment-request: a single
// service-role admin client authenticates the caller's JWT by hand
// (admin.auth.getUser), resolves their account owner id the same way
// (profiles -> team_members), then does the actual writes — because
// creating an offer needs the platform BNPL secret key, which can never
// live client-side.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { getFinancingProvider } from "../_shared/financing/registry.ts";
import { sendSms, sendEmail } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// Typical BNPL floor across this provider category — confirm your
// actual provider's minimum before relying on this in production.
const MIN_FINANCING_AMOUNT_CENTS = 20000; // $200

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

    const amountCents = Math.round(Number(job.invoice_amount) * 100);
    if (amountCents < MIN_FINANCING_AMOUNT_CENTS) {
      return jsonResponse({ error: `Financing is only available for jobs at or above $${(MIN_FINANCING_AMOUNT_CENTS / 100).toFixed(0)}.` }, 400);
    }

    const customerPhone = customerPhoneInput || job.customer_phone || undefined;
    if (!customerEmail && !customerPhone) {
      return jsonResponse({ error: "Add a customer email or phone number to send the financing offer to." }, 400);
    }

    const { data: connection } = await admin
      .from("financing_connections")
      .select("external_merchant_id, status")
      .eq("user_id", ownerId)
      .eq("provider", "wisetack")
      .maybeSingle();
    if (!connection?.external_merchant_id || connection.status !== "connected") {
      return jsonResponse({ error: "Set up financing for your account before sending offers." }, 400);
    }

    const provider = getFinancingProvider("wisetack");
    if (!provider.isConfigured()) {
      return jsonResponse({ error: "Financing isn't configured on this server yet." }, 500);
    }

    const { data: offer, error: insertError } = await admin
      .from("financing_offers")
      .insert({
        user_id: ownerId,
        job_id: job.id,
        provider: "wisetack",
        customer_name: job.customer_name,
        customer_email: customerEmail ?? null,
        customer_phone: customerPhone ?? null,
        requested_amount_cents: amountCents,
        status: "created",
      })
      .select()
      .single();
    if (insertError || !offer) throw insertError || new Error("Could not create the financing offer.");

    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
    const description = job.service_type ? `${job.service_type} — ${job.customer_name}` : `Financing for ${job.customer_name}`;

    let created;
    try {
      created = await provider.createOffer({
        externalMerchantId: connection.external_merchant_id,
        amountCents,
        customerName: job.customer_name,
        customerEmail,
        customerPhone,
        description,
        successUrl: `${siteUrl}/financing-result?status=success&offer=${offer.id}`,
        cancelUrl: `${siteUrl}/financing-result?status=cancel&offer=${offer.id}`,
        referenceId: offer.id,
      });
    } catch (providerError) {
      await admin.from("financing_offers").update({ status: "canceled", decline_reason: providerError instanceof Error ? providerError.message : String(providerError) }).eq("id", offer.id);
      throw providerError;
    }

    await admin
      .from("financing_offers")
      .update({
        status: "sent",
        external_transaction_id: created.externalTransactionId,
        application_url: created.applicationUrl,
      })
      .eq("id", offer.id);

    const amountLabel = `$${(amountCents / 100).toFixed(2)}`;
    if (customerPhone) {
      await sendSms(customerPhone, `Hi ${job.customer_name}, you can finance your ${amountLabel} job over time. Apply here (soft credit check, no obligation): ${created.applicationUrl}`);
    }
    if (customerEmail) {
      await sendEmail(
        customerEmail,
        `Financing available for your ${amountLabel} job`,
        `<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
          <p style="font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin: 0 0 16px;">Financing available</p>
          <h1 style="font-size: 22px; margin: 0 0 16px;">Pay ${amountLabel} over time instead of all at once</h1>
          <p style="font-size: 14px; color: #4b5563;">Check your rate in about a minute — a soft credit check that won't affect your score.</p>
          <a href="${created.applicationUrl}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px;">Check my rate</a>
        </div>`,
        `Finance your ${amountLabel} job: ${created.applicationUrl}`,
      );
    }

    return jsonResponse({ offer_id: offer.id, application_url: created.applicationUrl });
  } catch (error) {
    console.error(JSON.stringify({ event: "financing_create_offer_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Something went wrong creating the financing offer." }, 500);
  }
});
