import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { fetchServiceTitanPricebook } from "../_shared/price-book/servicetitan.ts";
import { upsertPriceBookItems } from "../_shared/price-book/upsert.ts";
import { saveSecrets } from "../_shared/secrets/providerCredentials.ts";
import { requireIntegrationManager } from "../_shared/auth/integrationAccessGuard.ts";
import { createFlagEvaluator } from "../_shared/flags/flagEval.ts";
import { loadStOnboardingInputs, type StDb } from "../_shared/price-book/stOnboardingInputs.ts";
import { decideServiceTitanConnect } from "../_shared/price-book/stOnboardingPolicy.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface RequestBody {
  /** "status" = report whether this account may connect (no credentials are read or stored). */
  action?: string;
  client_id?: string;
  client_secret?: string;
  app_key?: string;
  tenant_id?: string;
  business_unit_id?: string;
  job_type_id?: string;
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
    const userId = userData.user.id;

    // Same permission as QuickBooks (can_manage_integrations); also resolves the account owner used for flags.
    const access = await requireIntegrationManager(req, "ServiceTitan", corsHeaders);
    if (access instanceof Response) return access;

    // Anti-tunneling policy (see _shared/price-book/stOnboardingPolicy.ts). Existing live connections are
    // grandfathered; new sign-ups are blocked unless staff switch them on. Evaluated BEFORE any credential is read.
    const inputs = await loadStOnboardingInputs(
      admin as unknown as StDb,
      createFlagEvaluator({ rpc: (fn, args) => admin.rpc(fn, args) }),
      { userId, ownerId: access.ownerId },
    );
    const decision = decideServiceTitanConnect(inputs);

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    if (body.action === "status") {
      return jsonResponse(decision.allow ? { allowed: true, reason: decision.reason } : { allowed: false, code: decision.code, reason: decision.reason, message: decision.message });
    }
    if (!decision.allow) return jsonResponse({ error: decision.message, code: decision.code }, 403);
    const creds = {
      st_client_id: (body.client_id ?? "").trim(),
      st_client_secret: (body.client_secret ?? "").trim(),
      st_app_key: (body.app_key ?? "").trim(),
      st_tenant_id: (body.tenant_id ?? "").trim(),
      st_business_unit_id: (body.business_unit_id ?? "").trim(),
      st_job_type_id: (body.job_type_id ?? "").trim(),
    };
    if (!creds.st_client_id || !creds.st_client_secret || !creds.st_app_key || !creds.st_tenant_id) {
      return jsonResponse({ error: "Client ID, Client Secret, App Key, and Tenant ID are all required." }, 400);
    }

    // Secrets go to the encrypted vault; the table keeps only non-secret identifiers.
    const { st_client_secret, st_app_key, ...publicCreds } = creds;

    let items;
    try {
      items = await fetchServiceTitanPricebook(creds);
    } catch (error) {
      await admin.from("price_book_connections").upsert(
        { user_id: userId, provider: "service_titan", status: "error", ...publicCreds, st_client_secret: null, st_app_key: null, last_sync_error: error instanceof Error ? error.message : String(error) },
        { onConflict: "user_id,provider" },
      );
      return jsonResponse({ error: "Could not connect to ServiceTitan with those credentials. Double-check them and try again." }, 400);
    }

    await saveSecrets(admin, userId, "service_titan", { st_client_secret, st_app_key });

    const { synced, error: upsertError } = await upsertPriceBookItems(admin, userId, "service_titan", items);

    await admin.from("price_book_connections").upsert(
      {
        user_id: userId,
        provider: "service_titan",
        status: upsertError ? "error" : "connected",
        ...publicCreds,
        st_client_secret: null,
        st_app_key: null,
        last_synced_at: upsertError ? null : new Date().toISOString(),
        last_sync_error: upsertError ?? null,
      },
      { onConflict: "user_id,provider" },
    );

    if (upsertError) return jsonResponse({ error: `Connected, but the first sync failed: ${upsertError}` }, 500);
    return jsonResponse({ success: true, synced });
  } catch (error) {
    console.error(JSON.stringify({ event: "price_book_connect_servicetitan_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Something went wrong connecting ServiceTitan." }, 500);
  }
});
