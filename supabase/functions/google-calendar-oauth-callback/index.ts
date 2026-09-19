// Deploy: supabase functions deploy google-calendar-oauth-callback --no-verify-jwt

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
  const stateSecret = Deno.env.get("GOOGLE_CALENDAR_STATE_SECRET") ?? "";
  if (!code || !state) return redirectTo({ google_calendar: "error", reason: "missing_code_or_state" });

  const userId = await verifyState(state, stateSecret);
  if (!userId) return redirectTo({ google_calendar: "error", reason: "invalid_state" });

  const clientId = Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET") ?? "";
  const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-calendar-oauth-callback`;

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error_description || tokens.error || "Token exchange failed.");

    const calRes = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const calendar = calRes.ok ? await calRes.json() : null;

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    await admin.from("integrations").upsert(
      {
        user_id: userId,
        integration_type: "google_calendar",
        status: "connected",
        config: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token ?? null,
          expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          calendar_id: calendar?.id ?? "primary",
        },
      },
      { onConflict: "user_id,integration_type" },
    );

    return redirectTo({ google_calendar: "connected" });
  } catch (error) {
    console.error(JSON.stringify({ event: "google_calendar_oauth_callback_failed", user_id: userId, error: error instanceof Error ? error.message : String(error) }));
    return redirectTo({ google_calendar: "error", reason: "exchange_failed" });
  }
});
