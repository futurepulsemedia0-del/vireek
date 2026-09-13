import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { fetchServiceTitanPricebook } from "../_shared/price-book/servicetitan.ts";
import { fetchJobberProducts, refreshJobberTokenIfNeeded } from "../_shared/price-book/jobber.ts";
import { upsertPriceBookItems } from "../_shared/price-book/upsert.ts";
import type { PriceBookConnectionRow } from "../_shared/price-book/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function syncOneConnection(admin: SupabaseClient, conn: PriceBookConnectionRow): Promise<{ synced: number; error?: string }> {
  try {
    if (conn.provider === "service_titan") {
      if (!conn.st_client_id || !conn.st_client_secret || !conn.st_app_key || !conn.st_tenant_id) {
        return { synced: 0, error: "Missing ServiceTitan credentials — reconnect." };
      }
      const items = await fetchServiceTitanPricebook({
        st_client_id: conn.st_client_id,
        st_client_secret: conn.st_client_secret,
        st_app_key: conn.st_app_key,
        st_tenant_id: conn.st_tenant_id,
      });
      return await upsertPriceBookItems(admin, conn.user_id, "service_titan", items);
    }

    if (conn.provider === "jobber") {
      if (!conn.jobber_access_token || !conn.jobber_refresh_token) {
        return { synced: 0, error: "Missing Jobber tokens — reconnect." };
      }
      const refreshed = await refreshJobberTokenIfNeeded({
        access_token: conn.jobber_access_token,
        refresh_token: conn.jobber_refresh_token,
        expires_at: conn.jobber_token_expires_at,
      });
      const accessToken = refreshed?.access_token ?? conn.jobber_access_token;

      if (refreshed) {
        await admin.from("price_book_connections").update({
          jobber_access_token: refreshed.access_token,
          jobber_refresh_token: refreshed.refresh_token,
          jobber_token_expires_at: refreshed.expires_at,
        }).eq("id", conn.id);
      }

      const items = await fetchJobberProducts(accessToken);
      return await upsertPriceBookItems(admin, conn.user_id, "jobber", items);
    }

    return { synced: 0, error: `Unknown provider "${conn.provider}".` };
  } catch (error) {
    return { synced: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    const body = await req.json().catch(() => ({}));
    let connections: PriceBookConnectionRow[] = [];

    if (body?.all_tenants === true) {
      const { data, error } = await admin.from("price_book_connections").select("*").eq("status", "connected");
      if (error) return jsonResponse({ error: error.message }, 500);
      connections = (data as PriceBookConnectionRow[]) || [];
    } else {
      const authHeader = req.headers.get("Authorization") ?? "";
      const jwt = authHeader.replace(/^Bearer\s+/i, "");
      if (!jwt) return jsonResponse({ error: "Missing Authorization header." }, 401);

      const { data: userData, error: userError } = await admin.auth.getUser(jwt);
      if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session." }, 401);

      const { data, error } = await admin.from("price_book_connections").select("*").eq("user_id", userData.user.id);
      if (error) return jsonResponse({ error: error.message }, 500);
      connections = (data as PriceBookConnectionRow[]) || [];
    }

    if (connections.length === 0) return jsonResponse({ error: "No connected CRM to sync." }, 400);

    const results = await Promise.all(
      connections.map(async (conn) => {
        const result = await syncOneConnection(admin, conn);
        await admin.from("price_book_connections").update({
          status: result.error ? "error" : "connected",
          last_synced_at: result.error ? null : new Date().toISOString(),
          last_sync_error: result.error ?? null,
        }).eq("id", conn.id);
        return { provider: conn.provider, ...result };
      }),
    );

    return jsonResponse({ results });
  } catch (error) {
    console.error(JSON.stringify({ event: "price_book_sync_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Something went wrong syncing the price book." }, 500);
  }
});
