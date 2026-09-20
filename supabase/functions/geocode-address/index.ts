// geocode-address
//
// Geocodes job-site and technician-home-base addresses into
// latitude/longitude and writes them straight onto `jobs` /
// `team_members` (see 20261013000000_advanced_routing.sql).
//
// Provider: OpenStreetMap Nominatim (nominatim.openstreetmap.org) — free,
// keyless, same "no API key" choice already made for the zip lookup in
// weather-surge-check. Nominatim's usage policy caps public requests at
// 1/second and requires a descriptive User-Agent, so batches are
// geocoded sequentially with a small delay, not in parallel.
//
// Call with a real user's `Authorization: Bearer <access_token>` header
// (this is a dashboard-triggered action — "Geocode addresses" button on
// the Advanced Routing page — not a cron job).
//
// Body:
//   { "targets": [
//       { "type": "job", "id": "<job uuid>", "address": "123 Main St, Austin, TX" },
//       { "type": "technician_home", "id": "<team_member uuid>", "address": "..." },
//       { "type": "scratch", "id": "<any-string-for-matching-the-result>", "address": "..." }
//   ] }
// "scratch" geocodes an address without writing to any table — used by
// the Advanced Routing page when picking a territory's center point,
// where there's no job or technician row to attach the result to.
// Max 25 targets per call (keeps a single request under Nominatim's rate
// limit and this function's own execution time budget).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const USER_AGENT = "Vireek Dashboard (geocode-address, support@vireek.com)";
const FETCH_TIMEOUT_MS = 8_000;
const RATE_LIMIT_DELAY_MS = 1_100;
const MAX_TARGETS = 25;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface Target {
  type: "job" | "technician_home" | "scratch";
  id: string;
  address: string;
}

interface GeocodeResult {
  id: string;
  type: Target["type"];
  status: "geocoded" | "not_found" | "error";
  latitude?: number;
  longitude?: number;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function geocodeOne(address: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const hit = Array.isArray(data) ? data[0] : null;
    if (!hit) return null;
    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  } catch (err) {
    console.error(JSON.stringify({ event: "geocode_address_failed", error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return jsonResponse({ error: "Missing Authorization header." }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session." }, 401);
  const userId = userData.user.id;

  let body: { targets?: Target[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const targets = (body.targets ?? []).filter((t) => t?.id && t?.address && (t.type === "job" || t.type === "technician_home" || t.type === "scratch"));
  if (targets.length === 0) return jsonResponse({ error: "No valid targets provided." }, 400);
  if (targets.length > MAX_TARGETS) return jsonResponse({ error: `Max ${MAX_TARGETS} targets per call.` }, 400);

  const results: GeocodeResult[] = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const point = await geocodeOne(target.address);

    if (!point) {
      results.push({ id: target.id, type: target.type, status: "not_found" });
    } else if (target.type === "scratch") {
      results.push({ id: target.id, type: target.type, status: "geocoded", latitude: point.lat, longitude: point.lon });
    } else if (target.type === "job") {
      const { error } = await admin
        .from("jobs")
        .update({ latitude: point.lat, longitude: point.lon, geocoded_at: new Date().toISOString() })
        .eq("id", target.id)
        .eq("user_id", userId);
      results.push(error
        ? { id: target.id, type: target.type, status: "error" }
        : { id: target.id, type: target.type, status: "geocoded", latitude: point.lat, longitude: point.lon });
    } else {
      const { error } = await admin
        .from("team_members")
        .update({ home_latitude: point.lat, home_longitude: point.lon, home_geocoded_at: new Date().toISOString() })
        .eq("id", target.id)
        .eq("account_owner_id", userId);
      results.push(error
        ? { id: target.id, type: target.type, status: "error" }
        : { id: target.id, type: target.type, status: "geocoded", latitude: point.lat, longitude: point.lon });
    }

    if (i < targets.length - 1) await sleep(RATE_LIMIT_DELAY_MS);
  }

  return jsonResponse({
    geocoded: results.filter((r) => r.status === "geocoded").length,
    total: results.length,
    results,
  });
});
