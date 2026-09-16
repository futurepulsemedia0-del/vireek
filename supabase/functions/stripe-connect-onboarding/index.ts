import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripeRequest } from "../_shared/stripe/client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
    const user = userData.user;

    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
    if (!secretKey) return jsonResponse({ error: "Payments aren't configured on this server yet (missing STRIPE_SECRET_KEY)." }, 500);

    const { data: existing } = await admin
      .from("stripe_connect_accounts")
      .select("stripe_account_id")
      .eq("user_id", user.id)
      .maybeSingle();

    let accountId = existing?.stripe_account_id as string | undefined;

    if (!accountId) {
      const account = await stripeRequest(
        "accounts",
        {
          type: "express",
          email: user.email,
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        },
        secretKey,
      );
      accountId = account.id;
      await admin.from("stripe_connect_accounts").upsert({ user_id: user.id, stripe_account_id: accountId }, { onConflict: "user_id" });
    }

    const link = await stripeRequest(
      "account_links",
      {
        account: accountId,
        refresh_url: `${siteUrl}/dashboard/payments?stripe=refresh`,
        return_url: `${siteUrl}/dashboard/payments?stripe=connected`,
        type: "account_onboarding",
      },
      secretKey,
    );

    return jsonResponse({ url: link.url });
  } catch (error) {
    console.error(JSON.stringify({ event: "stripe_connect_onboarding_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Something went wrong starting your Stripe connection." }, 500);
  }
});
