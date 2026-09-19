// Deploy: supabase functions deploy hubspot-oauth-callback --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { verifyState } from "../_shared/price-book/oauthState.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const redirectTo = (params: Record<string, string>) => {
    const dest = new URL(`${siteUrl}/dashboard/integrations`);
    for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
    return Response.redirect(dest.toString(), 302);
  };

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateSecret = Deno.env.get("HUBSPOT_STATE_SECRET") ?? "";
  if (!code || !state) return redirectTo({ hubspot: "error", reason: "missing_code_or_state" });

  const userId = await verifyState(state, stateSecret);
  if (!userId) return redirectTo({ hubspot: "error", reason: "invalid_state" });

  const clientId = Deno.env.get("HUBSPOT_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("HUBSPOT_CLIENT_SECRET") ?? "";
  const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/hubspot-oauth-callback`;

  try {
    const tokenRes = await fetch("https://api.hubapi.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.message || "Token exchange failed.");

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    await admin.from("integrations").upsert(
      {
        user_id: userId,
        integration_type: "hubspot",
        status: "connected",
        config: { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString() },
      },
      { onConflict: "user_id,integration_type" },
    );

    return redirectTo({ hubspot: "connected" });
  } catch (error) {
    console.error(JSON.stringify({ event: "hubspot_oauth_callback_failed", user_id: userId, error: error instanceof Error ? error.message : String(error) }));
    return redirectTo({ hubspot: "error", reason: "exchange_failed" });
  }
});
