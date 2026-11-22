// supabase/functions/provider-disconnect/index.ts
//
// User-initiated disconnect / offboarding for:
//   jobber, service_titan, housecall_pro (price_book_connections)   ·   hubspot, google_calendar (integrations)
//
// POST { provider, delete_imported_data?: boolean }   Authorization: Bearer <user JWT>
//
// Authorization: caller must pass can_manage_integrations() (same gate as connecting); every read/write is scoped to the
// ACCOUNT OWNER id resolved by get_account_owner_id(), never to a client-supplied id.
//
// What it does (all idempotent):
//   1. Best-effort revocation AT THE PROVIDER, only where a mechanism is documented (see _shared/secrets/revocation.ts):
//        Google (RFC 7009) · Jobber (appDisconnect mutation) · HubSpot (deletes the refresh token only).
//        ServiceTitan / Housecall Pro have no documented endpoint -> `revocation: "unsupported"` and the UI tells the
//        user to remove the credential in the provider.
//      A failed revocation never blocks step 2: the user asked us to stop holding the credential.
//   2. Deletes the sealed credentials from provider_credentials and nulls any legacy plaintext secret columns.
//   3. Marks the price_book_connections row 'disconnected' (keeps the row/history) or deletes the integrations row.
//   4. Optionally deletes data imported from that provider (price_book_items where source = provider).
//   Job history (jobs, job_external_syncs) is retained on purpose: it is the customer's business record.
//
// Response: { ok, provider, revoked: true|false|null, revocation: "revoked"|"failed"|"unsupported"|"no_credentials",
//             manual_action_required: boolean, imported_data_deleted: number|null }
// Tokens are never logged or returned.
//
// Deploy: supabase functions deploy provider-disconnect

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { loadSecrets, deleteSecrets, type CredentialProvider, type SecretBag } from "../_shared/secrets/providerCredentials.ts";
import { revokeProviderAccess, type RevocationResult } from "../_shared/secrets/revocation.ts";
import { refreshJobberTokenIfNeeded } from "../_shared/price-book/jobber.ts";
import { markPriceBookDisconnected } from "../_shared/price-book/disconnect.ts";
import { requireIntegrationManager } from "../_shared/auth/integrationAccessGuard.ts";

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

const LABELS: Record<Provider, string> = {
  jobber: "Jobber",
  service_titan: "ServiceTitan",
  housecall_pro: "Housecall Pro",
  hubspot: "HubSpot",
  google_calendar: "Google Calendar",
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Jobber: refresh-token -> fresh access token, so `appDisconnect` works even when the stored access token expired. */
async function refreshJobberAccessToken(refreshToken: string): Promise<string | null> {
  try {
    const r = await refreshJobberTokenIfNeeded({ access_token: "", refresh_token: refreshToken, expires_at: null });
    return r?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Credentials to revoke: the vault wins, legacy plaintext columns/config are the pre-backfill fallback.
 * Never throws (an unreadable vault entry must not prevent the disconnect itself).
 */
async function collectCredentials(admin: SupabaseClient, ownerId: string, provider: Provider): Promise<SecretBag> {
  let vault: SecretBag = {};
  try {
    vault = (await loadSecrets(admin, ownerId, provider as CredentialProvider)) ?? {};
  } catch {
    vault = {};
  }

  const legacy: SecretBag = {};
  try {
    if (isPriceBook(provider)) {
      const { data } = await admin
        .from("price_book_connections")
        .select("jobber_access_token, jobber_refresh_token, st_client_secret, st_app_key, hcp_api_key")
        .eq("user_id", ownerId)
        .eq("provider", provider)
        .maybeSingle();
      for (const [k, v] of Object.entries((data ?? {}) as Record<string, unknown>)) {
        const s = str(v);
        if (s) legacy[k] = s;
      }
    } else {
      const { data } = await admin.from("integrations").select("config").eq("user_id", ownerId).eq("integration_type", provider).maybeSingle();
      const cfg = ((data as { config?: Record<string, unknown> } | null)?.config ?? {}) as Record<string, unknown>;
      const access = str(cfg.access_token);
      const refresh = str(cfg.refresh_token);
      if (access) legacy.access_token = access;
      if (refresh) legacy.refresh_token = refresh;
    }
  } catch {
    /* legacy fallback is best-effort */
  }
  return { ...legacy, ...vault };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = (await req.json().catch(() => ({}))) as { provider?: unknown; delete_imported_data?: unknown };
    if (!isProvider(body.provider)) return json({ error: "Unknown provider." }, 400);
    const provider = body.provider;
    const deleteImported = body.delete_imported_data === true;

    // Authorization + tenant resolution (401 / 403 Responses are ready to return).
    const access = await requireIntegrationManager(req, LABELS[provider], corsHeaders, "disconnect");
    if (access instanceof Response) return access;
    const { userId: actorId, ownerId } = access;

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

    // 1) Revocation at the provider (needs the tokens, so it runs before they are deleted). Never throws.
    const credentials = await collectCredentials(admin, ownerId, provider);
    const revocation: RevocationResult = await revokeProviderAccess(provider as CredentialProvider, credentials, { refreshJobberAccessToken });

    // 2 + 3) Delete credentials, then update the connection record.
    if (isPriceBook(provider)) {
      await markPriceBookDisconnected(admin, ownerId, provider); // deletes sealed secrets first, then nulls legacy columns
    } else {
      await deleteSecrets(admin, ownerId, provider as CredentialProvider);
      const { error } = await admin.from("integrations").delete().eq("user_id", ownerId).eq("integration_type", provider);
      if (error) throw new Error("connection_delete_failed");
    }

    // 4) Optional: delete imported data (only providers that import price-book rows).
    let importedDeleted: number | null = null;
    if (deleteImported && (provider === "jobber" || provider === "service_titan")) {
      const { count, error } = await admin.from("price_book_items").delete({ count: "exact" }).eq("user_id", ownerId).eq("source", provider);
      if (error) throw new Error("imported_data_delete_failed");
      importedDeleted = count ?? 0;
    }

    const revoked = revocation.outcome === "revoked" ? true : revocation.outcome === "failed" ? false : null;
    console.log(
      JSON.stringify({
        event: "provider_disconnected",
        owner_id: ownerId,
        actor_id: actorId,
        provider,
        revocation: revocation.outcome,
        revocation_detail: revocation.detail,
        manual_action_required: revocation.manualActionRequired,
        imported_deleted: importedDeleted,
      }),
    );
    return json({
      ok: true,
      provider,
      revoked,
      revocation: revocation.outcome,
      manual_action_required: revocation.manualActionRequired,
      imported_data_deleted: importedDeleted,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "provider_disconnect_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong disconnecting." }, 500);
  }
});
