// Deploy: supabase functions deploy listings-oauth-callback --no-verify-jwt
// Redirect URI to whitelist in the Meta app (Facebook Login -> Valid OAuth Redirect URIs):
//   https://<project-ref>.supabase.co/functions/v1/listings-oauth-callback
//
// The browser lands here from Facebook with no Supabase session, so the owner id
// + platform ride inside the HMAC-signed, 10-minute `state` minted by the
// listings function (LISTINGS_STATE_SECRET).
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { verifyState } from "../_shared/price-book/oauthState.ts";
import { assertConfigured, exchangeFacebookCode, listFacebookPages, saveCredentials } from "../_shared/listings/providers.ts";

const MAX_PAGES_PER_CONNECT = 50;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const site = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const back = (p: Record<string, string>) => {
    const d = new URL(`${site}/dashboard/listings`);
    for (const [k, v] of Object.entries(p)) d.searchParams.set(k, v);
    return Response.redirect(d.toString(), 302);
  };

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return back({ connect: "error", reason: "denied" });
  if (!code || !state) return back({ connect: "error", reason: "missing_code_or_state" });

  const verified = await verifyState(state, Deno.env.get("LISTINGS_STATE_SECRET") ?? "");
  const [ownerId, platform] = (verified ?? "").split("~");
  if (!ownerId || platform !== "facebook") return back({ connect: "error", reason: "invalid_state" });

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
  const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/listings-oauth-callback`;

  try {
    assertConfigured("facebook");
    const userToken = await exchangeFacebookCode(code, redirectUri);
    const pages = (await listFacebookPages(userToken)).slice(0, MAX_PAGES_PER_CONNECT);
    if (pages.length === 0) return back({ connect: "error", reason: "no_pages_found" });

    for (const p of pages) {
      const { data: row, error } = await admin
        .from("listing_connections")
        .upsert(
          { user_id: ownerId, platform: "facebook", external_id: p.id, display_name: p.name.slice(0, 200), status: "active", last_error: null, updated_at: new Date().toISOString() },
          { onConflict: "user_id,platform,external_id" },
        )
        .select("id")
        .single();
      if (error || !row) throw error ?? new Error("connection upsert failed");
      await saveCredentials(admin, row.id, ownerId, { access: p.access_token });
      // A reconnect revives links that were waiting for fresh credentials.
      await admin.from("listing_links").update({ state: "pending", last_error: null, updated_at: new Date().toISOString() }).eq("connection_id", row.id).eq("user_id", ownerId).eq("state", "needs_reauth");
    }

    console.log(JSON.stringify({ event: "listings_connected", user_id: ownerId, platform, connections: pages.length }));
    return back({ connect: "ok", platform, count: String(pages.length) });
  } catch (e) {
    console.error(JSON.stringify({ event: "listings_oauth_callback_failed", user_id: ownerId, platform, error: e instanceof Error ? e.message : String(e) }));
    return back({ connect: "error", reason: "exchange_failed" });
  }
});
