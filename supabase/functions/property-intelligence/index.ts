// supabase/functions/property-intelligence/index.ts
//
// Vireek Property Intelligence Graph — dashboard API.
//
//   POST { "action": "get",    "site_id": "<uuid>" }   stored data only, scores recomputed from live equipment/jobs
//   POST { "action": "enrich", "site_id": "<uuid>" }   fetches external property data, stores it, returns the briefing
//
// Security: the caller's JWT is verified, then the site is read THROUGH RLS with a caller-scoped client — if the
// caller's account cannot see the site, the request stops at 404. Only after that does the service-role client
// (needed because profile tables are write-protected from the browser) act, always filtered by the site's owner id.
//
// Secrets (all optional — a missing key just marks that provider "not connected" in the UI):
//   RENTCAST_API_KEY   parcel facts (APN, year built, sq ft, lot, heating/cooling)
//   ATTOM_API_KEY      building permits
//   EIA_API_KEY        state residential electricity price
//   (US Census geocoder and NASA POWER climate need no key.)
//
// Deploy: supabase functions deploy property-intelligence

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildBriefing, enrichSite, readServiceEnv } from "../_shared/property-intelligence/service.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing Authorization header." }, 401);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session." }, 401);

  let body: { action?: string; site_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const action = body.action;
  const siteId = body.site_id;
  if (action !== "get" && action !== "enrich") return json({ error: "action must be 'get' or 'enrich'." }, 400);
  if (typeof siteId !== "string" || !UUID_RE.test(siteId)) return json({ error: "A valid site_id is required." }, 400);

  // Authorisation: can THIS caller see the site? (RLS decides — not this code.)
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
  const { data: site } = await caller.from("customer_sites").select("id,user_id").eq("id", siteId).maybeSingle();
  if (!site) return json({ error: "Property not found." }, 404);
  const ownerId = (site as { user_id: string }).user_id;

  try {
    if (action === "get") {
      const briefing = await buildBriefing(admin, ownerId, siteId);
      if (!briefing) return json({ error: "Property not found." }, 404);
      return json({ briefing, cached: true });
    }

    const result = await enrichSite(admin, ownerId, siteId, { channel: "dashboard", env: readServiceEnv() });
    if (!result.ok) {
      const status = result.error === "site_not_found" ? 404 : result.error === "address_incomplete" ? 422 : 429;
      return json({ error: result.message, code: result.error }, status);
    }
    return json({ briefing: result.briefing, cached: result.cached });
  } catch (err) {
    console.error(JSON.stringify({ event: "property_intelligence_failed", action, error: err instanceof Error ? err.message : "unknown" }));
    return json({ error: "Property intelligence is temporarily unavailable." }, 500);
  }
});
