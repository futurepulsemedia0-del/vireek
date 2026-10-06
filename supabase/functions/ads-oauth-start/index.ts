// Deploy: supabase functions deploy ads-oauth-start
// Body: { "platform": "google" | "meta" }  ->  { "url": "<provider consent url>" }
// Redirect URI to whitelist at BOTH providers:
//   https://<project-ref>.supabase.co/functions/v1/ads-oauth-callback
import { signState } from "../_shared/price-book/oauthState.ts";
import { authenticate, corsHeaders, json, log } from "../_shared/ads/common.ts";
import { googleAuthUrl } from "../_shared/ads/google.ts";
import { metaAuthUrl } from "../_shared/ads/meta.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const who = await authenticate(req);
    if (!who) return json({ error: "Invalid or expired session." }, 401);
    if (who.userId !== who.ownerId) return json({ error: "Only the account owner can connect ad accounts." }, 403);
    const { platform } = await req.json().catch(() => ({}));
    if (platform !== "google" && platform !== "meta") return json({ error: "platform must be 'google' or 'meta'." }, 400);

    const secret = Deno.env.get("ADS_STATE_SECRET");
    if (!secret) return json({ error: "Ad connections aren't configured on this server yet." }, 500);

    // The callback has no session, so the owner id + platform ride inside the signed, 10-minute state.
    const state = await signState(`${who.ownerId}~${platform}`, secret);
    const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/ads-oauth-callback`;
    return json({ url: platform === "google" ? googleAuthUrl(redirectUri, state) : metaAuthUrl(redirectUri, state) });
  } catch (e) {
    log("ads_oauth_start_failed", { error: e instanceof Error ? e.message : String(e) });
    return json({ error: "Could not start the connection." }, 500);
  }
});
