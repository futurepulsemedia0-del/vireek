import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripeRequest } from "../_shared/stripe/client.ts";
import { computeTip, firstName, TIP_PRESET_PERCENTS, type TipSelection } from "../_shared/payments/tip.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const TOKEN_RE = /^[a-f0-9]{64}$/;
const PAYABLE = ["pending", "sent", "overdue", "failed"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const token = typeof body.token === "string" ? body.token : "";
    if (!TOKEN_RE.test(token)) return json({ status: "not_found" });

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

    const { data: request } = await admin
      .from("payment_requests")
      .select("id, user_id, job_id, customer_name, customer_email, amount, status, technician_id, stripe_checkout_session_id")
      .eq("public_token", token)
      .maybeSingle();
    if (!request) return json({ status: "not_found" });
    if (request.status === "paid") return json({ status: "paid" });
    if (!PAYABLE.includes(request.status)) return json({ status: "canceled" });

    const [{ data: connect }, { data: job }, { data: tech }] = await Promise.all([
      admin.from("stripe_connect_accounts").select("stripe_account_id, charges_enabled, tip_enabled").eq("user_id", request.user_id).maybeSingle(),
      request.job_id ? admin.from("jobs").select("service_type").eq("id", request.job_id).maybeSingle() : Promise.resolve({ data: null }),
      request.technician_id ? admin.from("team_members").select("*").eq("id", request.technician_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);

    const baseCents = Math.round(Number(request.amount) * 100);
    const tipEnabled = !!connect?.tip_enabled && !!request.technician_id;
    const techFirstName = tech ? firstName((tech as Record<string, string | null>).full_name ?? (tech as Record<string, string | null>).member_name ?? (tech as Record<string, string | null>).name) : "";

    if (body.action === "get") {
      return json({
        status: "open",
        amount_cents: baseCents,
        description: job?.service_type ?? "Invoice",
        customer_first_name: firstName(request.customer_name),
        technician_first_name: techFirstName || null,
        tip_enabled: tipEnabled,
        presets: TIP_PRESET_PERCENTS,
      });
    }

    if (body.action !== "checkout") return json({ error: "Unknown action." }, 400);

    if (!connect?.stripe_account_id || !connect.charges_enabled) {
      return json({ error: "This business can't accept payments right now." }, 400);
    }
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secretKey) return json({ error: "Payments aren't configured on this server yet." }, 500);
    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

    const selection = (body.tip ?? { kind: "none" }) as TipSelection;
    if (selection.kind !== "none" && !tipEnabled) return json({ error: "Tipping isn't available for this payment." }, 400);
    const tip = computeTip(baseCents, selection);
    if (!tip.ok) return json({ error: tip.error }, 400);

    // Only one live session per request: expire the previous attempt (best effort).
    if (request.stripe_checkout_session_id) {
      try { await stripeRequest(`checkout/sessions/${request.stripe_checkout_session_id}/expire`, {}, secretKey); } catch { /* already completed/expired */ }
    }

    const description = job?.service_type ? `${job.service_type}` : `Invoice for ${request.customer_name}`;
    const metadata = {
      flow: "tip_v1",
      payment_request_id: request.id,
      job_id: request.job_id,
      user_id: request.user_id,
      base_cents: baseCents,
      tip_cents: tip.tipCents,
      technician_id: tip.tipCents > 0 ? request.technician_id : undefined,
    };

    const lineItems: unknown[] = [
      { quantity: 1, price_data: { currency: "usd", unit_amount: baseCents, product_data: { name: description } } },
    ];
    if (tip.tipCents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: { currency: "usd", unit_amount: tip.tipCents, product_data: { name: techFirstName ? `Tip for ${techFirstName}` : "Tip for your technician" } },
      });
    }

    const session = await stripeRequest(
      "checkout/sessions",
      {
        mode: "payment",
        success_url: `${siteUrl}/pay-result?status=success`,
        cancel_url: `${siteUrl}/pay/${token}?canceled=1`,
        customer_email: request.customer_email ?? undefined,
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
        line_items: lineItems,
        payment_intent_data: { transfer_data: { destination: connect.stripe_account_id }, metadata },
        metadata,
      },
      secretKey,
    );

    await admin
      .from("payment_requests")
      .update({ stripe_checkout_session_id: session.id, status: request.status === "pending" ? "sent" : request.status })
      .eq("id", request.id);

    return json({ url: session.url });
  } catch (error) {
    console.error(JSON.stringify({ event: "public_payment_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
