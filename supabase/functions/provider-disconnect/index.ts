// supabase/functions/provider-disconnect/index.ts
//
// User-initiated disconnect / offboarding for providers that had no disconnect path:
//   jobber, service_titan, housecall_pro (price_book_connections)   ·   hubspot, google_calendar (integrations)
//
// POST { provider, delete_imported_data?: boolean }   Authorization: Bearer <user JWT>
//
// What it does (all idempotent):
//   1. Best-effort token revocation at the provider WHERE A REVOCATION ENDPOINT IS VERIFIED: Google (RFC 7009 endpoint).
//      Jobber / ServiceTitan / Housecall Pro / HubSpot revocation is NOT implemented (no verified endpoint in this
//      repo): the response says `revoked: null` and the UI must tell the user to remove the app in the provider too.
//   2. Deletes the sealed credentials from provider_credentials and nulls any legacy plaintext secret columns.
//   3. Marks the price_book_connections row 'disconnected' (keeps the row/history) or deletes the integrations row.
//   4. Optionally deletes data imported from that provider (price_book_items where source = provider).
//   Job history (jobs, job_external_syncs) is retained on purpose: it is the customer's business record.
//
// Deploy: supabase functions deploy provider-disconnect

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { deleteSecrets, loadSecrets, type CredentialProvider } from "../_shared/secrets/providerCredentials.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const PRICE_BOOK_PROVIDERS = ["jobber", "service_titan", "housecall_pro"] as const;
const INTEGRATION_PROVIDERS = ["hubspot", "google_calendar"] as const;
type Provider = (typeof PRICE_BOOK_PROVIDERS)[number] | (typeof INTEGRATION_PROVIDERS)[number];
const isProvider = (v: unknown): v is Provider => typeof v === "string" && [...PRICE_BOOK_PROVIDERS, ...INTEGRATION_PROVIDERS].includes(v as Provider);
const isPriceBook = (p: Provider): p is (typeof PRICE_BOOK_PROVIDERS)[number] => (PRICE_BOOK_PROVIDERS as readonly string[]).includes(p);

/** Google OAuth token revocation (RFC 7009). Returns true on success, false on failure; never throws. */
async function revokeGoogle(token: string): Promise<boolean> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Missing Authorization header." }, 401);
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return json({ error: "Invalid or expired session." }, 401);
    const userId = userData.user.id;

    const body = (await req.json().catch(() => ({}))) as { provider?: unknown; delete_imported_data?: unknown };
    if (!isProvider(body.provider)) return json({ error: "Unknown provider." }, 400);
    const provider = body.provider;
    const deleteImported = body.delete_imported_data === true;

    // 1) Revocation where verified (needs the refresh token, so read it before deleting).
    let revoked: boolean | null = null;
    if (provider === "google_calendar") {
      let token: string | undefined;
      try {
        const bag = await loadSecrets(admin, userId, provider);
        token = bag?.refresh_token ?? bag?.access_token;
      } catch {
        token = undefined;
      }
      if (!token) {
        // Legacy plaintext row (pre-backfill).
        const { data } = await admin.from("integrations").select("config").eq("user_id", userId).eq("integration_type", provider).maybeSingle();
        const cfg = (data?.config ?? {}) as { refresh_token?: unknown; access_token?: unknown };
        token = typeof cfg.refresh_token === "string" ? cfg.refresh_token : typeof cfg.access_token === "string" ? cfg.access_token : undefined;
      }
      revoked = token ? await revokeGoogle(token) : false;
    }

    // 2) Delete sealed credentials.
    await deleteSecrets(admin, userId, provider as CredentialProvider);

    // 3) Connection record.
    if (isPriceBook(provider)) {
      const { error } = await admin
        .from("price_book_connections")
        .update({
          status: "disconnected",
          jobber_access_token: null,
          jobber_refresh_token: null,
          jobber_token_expires_at: null,
          st_client_secret: null,
          st_app_key: null,
          hcp_api_key: null,
          last_sync_error: null,
        })
        .eq("user_id", userId)
        .eq("provider", provider);
      if (error) throw new Error("connection_update_failed");
    } else {
      const { error } = await admin.from("integrations").delete().eq("user_id", userId).eq("integration_type", provider);
      if (error) throw new Error("connection_delete_failed");
    }

    // 4) Optional: delete imported data (only providers that import price-book rows).
    let importedDeleted: number | null = null;
    if (deleteImported && (provider === "jobber" || provider === "service_titan")) {
      const { count, error } = await admin.from("price_book_items").delete({ count: "exact" }).eq("user_id", userId).eq("source", provider);
      if (error) throw new Error("imported_data_delete_failed");
      importedDeleted = count ?? 0;
    }

    console.log(JSON.stringify({ event: "provider_disconnected", user_id: userId, provider, revoked, imported_deleted: importedDeleted }));
    return json({ ok: true, provider, revoked, imported_data_deleted: importedDeleted });
  } catch (error) {
    console.error(JSON.stringify({ event: "provider_disconnect_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong disconnecting." }, 500);
  }
});
