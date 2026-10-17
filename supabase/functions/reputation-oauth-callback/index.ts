// Deploy: supabase functions deploy reputation-oauth-callback --no-verify-jwt
// Redirect URI to whitelist at BOTH providers:
//   https://<project-ref>.supabase.co/functions/v1/reputation-oauth-callback
//
// The browser lands here from Google / Facebook with no Supabase session, so
// the owner id + platform ride inside the HMAC-signed, 10-minute `state`
// minted by the reputation function (REPUTATION_STATE_SECRET).
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { verifyState } from "../_shared/price-book/oauthState.ts";
import {
  assertConfigured,
  exchangeFacebookCode,
  exchangeGoogleCode,
  listFacebookPages,
  listGoogleLocations,
  saveCredentials,
} from "../_shared/reputation/providers.ts";
import { loadSettings, syncConnection } from "../_shared/reputation/sync.ts";
import type { Platform } from "../_shared/reputation/engine.ts";

const MAX_CONNECTIONS_PER_CONNECT = 50;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const site = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const back = (p: Record<string, string>) => {
    const d = new URL(`${site}/dashboard/reputation`);
    for (const [k, v] of Object.entries(p)) d.searchParams.set(k, v);
    return Response.redirect(d.toString(), 302);
  };

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return back({ connect: "error", reason: "denied" });
  if (!code || !state) return back({ connect: "error", reason: "missing_code_or_state" });

  const verified = await verifyState(state, Deno.env.get("REPUTATION_STATE_SECRET") ?? "");
  const [ownerId, platform] = (verified ?? "").split("~");
  if (!ownerId || (platform !== "google" && platform !== "facebook")) return back({ connect: "error", reason: "invalid_state" });

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
  const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/reputation-oauth-callback`;

  const saveConnection = async (
    p: Platform,
    externalId: string,
    name: string,
    creds: { access: string; refresh?: string | null; expiresInSec?: number | null },
  ) => {
    const { data: row, error } = await admin
      .from("review_connections")
      .upsert(
        { user_id: ownerId, platform: p, external_id: externalId, display_name: name, status: "active", last_error: null, updated_at: new Date().toISOString() },
        { onConflict: "user_id,platform,external_id" },
      )
      .select("id, user_id, platform, external_id, display_name")
      .single();
    if (error || !row) throw error ?? new Error("connection upsert failed");
    await saveCredentials(admin, row.id, ownerId, creds);
    return row;
  };

  try {
    assertConfigured(platform);
    const connections = [];
    if (platform === "google") {
      const t = await exchangeGoogleCode(code, redirectUri);
      if (!t.refresh_token) return back({ connect: "error", reason: "no_refresh_token" });
      const locations = (await listGoogleLocations(t.access_token)).slice(0, MAX_CONNECTIONS_PER_CONNECT);
      for (const l of locations) {
        connections.push(await saveConnection("google", l.id, l.name, { access: t.access_token, refresh: t.refresh_token, expiresInSec: t.expires_in }));
      }
      if (connections.length === 0) return back({ connect: "error", reason: "no_locations_found" });
    } else {
      const userToken = await exchangeFacebookCode(code, redirectUri);
      const pages = (await listFacebookPages(userToken)).slice(0, MAX_CONNECTIONS_PER_CONNECT);
      for (const p of pages) connections.push(await saveConnection("facebook", p.id, p.name, { access: p.access_token }));
      if (connections.length === 0) return back({ connect: "error", reason: "no_pages_found" });
    }

    // First pull happens right away so the inbox isn't empty after connecting.
    const settings = await loadSettings(admin, ownerId);
    for (const c of connections.slice(0, 10)) await syncConnection(admin, c as never, settings);

    console.log(JSON.stringify({ event: "reputation_connected", user_id: ownerId, platform, connections: connections.length }));
    return back({ connect: "ok", platform, count: String(connections.length) });
  } catch (e) {
    console.error(JSON.stringify({ event: "reputation_oauth_callback_failed", user_id: ownerId, platform, error: e instanceof Error ? e.message : String(e) }));
    return back({ connect: "error", reason: "exchange_failed" });
  }
});
