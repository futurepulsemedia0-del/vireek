import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { exchangeJobberCode, fetchJobberProducts } from "../_shared/price-book/jobber.ts";
import { verifyState } from "../_shared/price-book/oauthState.ts";
import { upsertPriceBookItems } from "../_shared/price-book/upsert.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const redirectTo = (params: Record<string, string>) => {
    const dest = new URL(`${siteUrl}/dashboard/price-book`);
    for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
    return Response.redirect(dest.toString(), 302);
  };

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateSecret = Deno.env.get("JOBBER_STATE_SECRET") ?? "";

  if (!code || !state) return redirectTo({ jobber: "error", reason: "missing_code_or_state" });

  const userId = await verifyState(state, stateSecret);
  if (!userId) return redirectTo({ jobber: "error", reason: "invalid_state" });

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/jobber-oauth-callback`;
    const tokens = await exchangeJobberCode(code, redirectUri);

    let items;
    let syncError: string | undefined;
    try {
      items = await fetchJobberProducts(tokens.access_token);
    } catch (error) {
      syncError = error instanceof Error ? error.message : String(error);
    }

    let synced = 0;
    if (items) {
      const result = await upsertPriceBookItems(admin, userId, "jobber", items);
      synced = result.synced;
      syncError = result.error;
    }

    await admin.from("price_book_connections").upsert(
      {
        user_id: userId,
        provider: "jobber",
        status: syncError ? "error" : "connected",
        jobber_access_token: tokens.access_token,
        jobber_refresh_token: tokens.refresh_token,
        jobber_token_expires_at: tokens.expires_at,
        last_synced_at: syncError ? null : new Date().toISOString(),
        last_sync_error: syncError ?? null,
      },
      { onConflict: "user_id,provider" },
    );

    return redirectTo(syncError ? { jobber: "connected_with_errors" } : { jobber: "connected", synced: String(synced) });
  } catch (error) {
    console.error(JSON.stringify({ event: "jobber_oauth_callback_failed", user_id: userId, error: error instanceof Error ? error.message : String(error) }));
    return redirectTo({ jobber: "error", reason: "exchange_failed" });
  }
});
