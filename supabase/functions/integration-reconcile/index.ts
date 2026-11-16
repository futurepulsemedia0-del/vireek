// supabase/functions/integration-reconcile/index.ts
//
// Drift detection: compares the price-book rows imported from ServiceTitan / Jobber with what the provider returns now
// and records an integration_drift_reports row when they differ. REPORT ONLY - it never edits price_book_items.
//
// POST {}                       Authorization: Bearer <user JWT>   -> the caller's own connections
// POST { "all_tenants": true }  x-cron-secret: <CRON_SECRET>       -> every connected tenant (schedule weekly)
//
// Housecall Pro has no read endpoint in this codebase (write-back only), so it is not reconciled. Not verified.
// Deploy: supabase functions deploy integration-reconcile   (requires migration 20290304000100)

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { requireCronAuth } from "../_shared/http/cronAuth.ts";
import { hydrateRow, saveSecrets } from "../_shared/secrets/providerCredentials.ts";
import { fetchServiceTitanPricebook } from "../_shared/price-book/servicetitan.ts";
import { fetchJobberProducts, refreshJobberTokenIfNeeded } from "../_shared/price-book/jobber.ts";
import { computeDrift, summarizeDrift, type LocalItem } from "../_shared/price-book/drift.ts";
import type { NormalizedPriceItem } from "../_shared/price-book/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type Conn = Record<string, any> & { id: string; user_id: string; provider: "service_titan" | "jobber" };
const MAX_LOCAL_ROWS = 10_000;

async function fetchRemote(admin: SupabaseClient, conn: Conn): Promise<NormalizedPriceItem[]> {
  if (conn.provider === "service_titan") {
    return await fetchServiceTitanPricebook({
      st_client_id: conn.st_client_id ?? "", st_client_secret: conn.st_client_secret ?? "",
      st_app_key: conn.st_app_key ?? "", st_tenant_id: conn.st_tenant_id ?? "",
    });
  }
  if (!conn.jobber_access_token || !conn.jobber_refresh_token) throw new Error("missing_jobber_tokens");
  const refreshed = await refreshJobberTokenIfNeeded({ access_token: conn.jobber_access_token, refresh_token: conn.jobber_refresh_token, expires_at: conn.jobber_token_expires_at });
  if (refreshed) {
    await saveSecrets(admin, conn.user_id, "jobber", { jobber_access_token: refreshed.access_token, jobber_refresh_token: refreshed.refresh_token });
    await admin.from("price_book_connections").update({ jobber_access_token: null, jobber_refresh_token: null, jobber_token_expires_at: refreshed.expires_at }).eq("id", conn.id);
  }
  return await fetchJobberProducts(refreshed?.access_token ?? conn.jobber_access_token);
}

async function reconcileOne(admin: SupabaseClient, stored: Conn) {
  let conn = stored;
  try { conn = (await hydrateRow(admin, stored.user_id, stored)) as Conn; } catch { /* fall back to stored (legacy plaintext) */ }

  const remote = await fetchRemote(admin, conn);
  const { data, error } = await admin.from("price_book_items").select("external_id, service_name, price_cents, active")
    .eq("user_id", conn.user_id).eq("source", conn.provider).not("external_id", "is", null).limit(MAX_LOCAL_ROWS);
  if (error) throw new Error("local_read_failed");

  const report = computeDrift((data ?? []) as LocalItem[], remote);
  // Close previous open reports, then record the new one if there is drift.
  await admin.from("integration_drift_reports").update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("user_id", conn.user_id).eq("provider", conn.provider).eq("status", "open");
  if (report.total > 0) {
    const { error: insErr } = await admin.from("integration_drift_reports").insert({
      user_id: conn.user_id, provider: conn.provider, total: report.total,
      missing_in_vireek: report.missing_in_vireek.length, missing_in_provider: report.missing_in_provider.length,
      price_mismatch: report.price_mismatch.length, active_mismatch: report.active_mismatch.length,
      details: summarizeDrift(report),
    });
    if (insErr) throw new Error("report_write_failed");
  }
  return { provider: conn.provider, drift: report.total };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  try {
    const body = await req.json().catch(() => ({}));
    let query = admin.from("price_book_connections").select("*").eq("status", "connected").in("provider", ["service_titan", "jobber"]);
    if (body?.all_tenants === true) {
      const cron = requireCronAuth(req);
      if (!cron.ok) return cron.response;
    } else {
      const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!jwt) return json({ error: "Missing Authorization header." }, 401);
      const { data: u, error: ue } = await admin.auth.getUser(jwt);
      if (ue || !u?.user) return json({ error: "Invalid or expired session." }, 401);
      query = query.eq("user_id", u.user.id);
    }
    const { data: conns, error } = await query;
    if (error) return json({ error: "Could not load connections." }, 500);

    const results: Array<{ provider: string; drift?: number; error?: string }> = [];
    for (const c of (conns ?? []) as Conn[]) {
      try { results.push(await reconcileOne(admin, c)); }
      catch (e) {
        // Never leak provider error bodies / credentials to the caller; log the class only.
        console.error(JSON.stringify({ event: "reconcile_failed", provider: c.provider, error: e instanceof Error ? e.message.slice(0, 120) : "unknown" }));
        results.push({ provider: c.provider, error: "reconcile_failed" });
      }
    }
    return json({ results });
  } catch (e) {
    console.error(JSON.stringify({ event: "integration_reconcile_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Something went wrong." }, 500);
  }
});
