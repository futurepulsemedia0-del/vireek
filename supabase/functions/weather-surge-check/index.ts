// weather-surge-check
//
// Two ways to call this:
//
// 1. Full sweep (cron): POST with header `X-Cron-Secret: <WEATHER_SURGE_CRON_SECRET>`,
//    no body. Checks every account that has weather_surge_enabled = true.
//    Deploy + schedule:
//      supabase functions deploy weather-surge-check --no-verify-jwt
//      supabase secrets set WEATHER_SURGE_CRON_SECRET=<random-string>
//    then point any scheduler (Supabase Dashboard Cron, GitHub Actions, etc.)
//    at this URL every 15-30 minutes with that header.
//
// 2. Single-account check (dashboard "Check now" button): POST with a real
//    user's `Authorization: Bearer <access_token>` header instead, no
//    X-Cron-Secret. Checks only the caller's own business.
//
// Weather data: the US National Weather Service's public alerts API
// (api.weather.gov) — free, no API key, only needs a descriptive
// User-Agent per NWS's usage policy. Zip -> lat/lon via Zippopotam.us,
// also free and keyless. US-only, matching this product's market.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Cron-Secret" };
const USER_AGENT = "Vireek Dashboard (weather-surge-check, support@vireek.com)";
const FETCH_TIMEOUT_MS = 10_000;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// NWS alert event -> which trades that event actually matters for.
// Anything not listed here is recorded (for the audit trail) but never
// triggers surge mode — no point shortening HVAC calls over a Small
// Craft Advisory.
const EVENT_TRADE_RELEVANCE: Record<string, string[]> = {
  "Tornado Warning": ["roofing", "electrical", "restoration"],
  "Severe Thunderstorm Warning": ["roofing", "electrical", "restoration"],
  "Hurricane Warning": ["roofing", "electrical", "restoration", "locksmith"],
  "Hurricane Watch": ["roofing", "electrical", "restoration"],
  "Tropical Storm Warning": ["roofing", "electrical", "restoration"],
  "High Wind Warning": ["roofing", "electrical"],
  "Flash Flood Warning": ["restoration", "plumbing"],
  "Flood Warning": ["restoration", "plumbing"],
  "Winter Storm Warning": ["hvac", "plumbing", "roofing"],
  "Ice Storm Warning": ["hvac", "plumbing", "roofing", "electrical"],
  "Hard Freeze Warning": ["hvac", "plumbing"],
  "Freeze Warning": ["hvac", "plumbing"],
  "Extreme Cold Warning": ["hvac", "plumbing"],
  "Excessive Heat Warning": ["hvac"],
  "Excessive Heat Watch": ["hvac"],
};

function priorityNoteFor(industry: string | null, eventType: string, headline: string): string {
  const trades = EVENT_TRADE_RELEVANCE[eventType] ?? [];
  if (industry && trades.includes(industry)) {
    switch (industry) {
      case "hvac":
        return "Prioritize no-heat and no-cool emergencies — call volume is likely spiking.";
      case "plumbing":
        return "Prioritize frozen/burst pipe and flooding calls.";
      case "roofing":
        return "Prioritize active roof leaks and storm damage over routine estimates.";
      case "electrical":
        return "Prioritize downed lines, exposed wiring, and outage-related safety calls.";
      case "restoration":
        return "Prioritize active water intrusion and flood-damage calls.";
      case "locksmith":
        return "Prioritize lockouts tied to evacuations or power outages.";
    }
  }
  return `Regional weather alert in effect: ${headline}`;
}

interface NwsAlertProperties {
  id: string;
  event: string;
  severity: string;
  headline: string;
  areaDesc: string;
  onset: string | null;
  expires: string | null;
}

async function geocodeZip(zip: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const place = data?.places?.[0];
    if (!place) return null;
    const lat = Number(place.latitude);
    const lon = Number(place.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  } catch (err) {
    console.error(JSON.stringify({ event: "geocode_zip_failed", zip, error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}

async function fetchActiveAlerts(lat: number, lon: number): Promise<NwsAlertProperties[]> {
  try {
    const res = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lon}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.features ?? []).map((f: { properties: NwsAlertProperties }) => f.properties);
  } catch (err) {
    console.error(JSON.stringify({ event: "fetch_active_alerts_failed", lat, lon, error: err instanceof Error ? err.message : String(err) }));
    return [];
  }
}

async function checkOneBusiness(
  admin: ReturnType<typeof createClient>,
  business: { user_id: string; weather_zip_code: string; primary_industry: string | null }
): Promise<{ user_id: string; alerts_seen: number; alerts_triggered: number } | { user_id: string; error: string }> {
  const geo = await geocodeZip(business.weather_zip_code);
  if (!geo) return { user_id: business.user_id, error: "Could not geocode zip code" };

  const alerts = await fetchActiveAlerts(geo.lat, geo.lon);
  let triggered = 0;

  for (const alert of alerts) {
    const relevantTrades = EVENT_TRADE_RELEVANCE[alert.event];
    const triggersSurge = !!relevantTrades && (!business.primary_industry || relevantTrades.includes(business.primary_industry));

    const { data: recorded, error: recordError } = await admin.rpc("record_weather_alert", {
      p_user_id: business.user_id,
      p_nws_alert_id: alert.id,
      p_event_type: alert.event,
      p_severity: alert.severity ?? null,
      p_headline: alert.headline ?? alert.event,
      p_area_desc: alert.areaDesc ?? null,
      p_triggered_surge: triggersSurge,
      p_effective_at: alert.onset ?? null,
      p_expires_at: alert.expires ?? null,
    });
    if (recordError) {
      console.error(JSON.stringify({ event: "record_weather_alert_failed", user_id: business.user_id, error: recordError.message }));
      continue;
    }
    if (!recorded) continue; // already seen this alert id before

    if (triggersSurge) {
      const { error: activateError } = await admin.rpc("activate_weather_surge", {
        p_user_id: business.user_id,
        p_event_type: alert.event,
        p_headline: alert.headline ?? alert.event,
        p_priority_note: priorityNoteFor(business.primary_industry, alert.event, alert.headline ?? alert.event),
        p_expires_at: alert.expires ?? null,
      });
      if (activateError) {
        console.error(JSON.stringify({ event: "activate_weather_surge_failed", user_id: business.user_id, error: activateError.message }));
      } else {
        triggered += 1;
      }
    }
  }

  const { error: checkedError } = await admin
    .from("business_profile")
    .update({ weather_surge_last_checked_at: new Date().toISOString() })
    .eq("user_id", business.user_id);
  if (checkedError) {
    console.error(JSON.stringify({ event: "update_last_checked_failed", user_id: business.user_id, error: checkedError.message }));
  }

  return { user_id: business.user_id, alerts_seen: alerts.length, alerts_triggered: triggered };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(JSON.stringify({ event: "weather_surge_check_failed", error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }));
    return jsonResponse({ error: "Server misconfiguration." }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const cronSecret = Deno.env.get("WEATHER_SURGE_CRON_SECRET");
  const providedCronSecret = req.headers.get("X-Cron-Secret");
  const authHeader = req.headers.get("Authorization");

  try {
    if (cronSecret && providedCronSecret === cronSecret) {
      // Full sweep across every opted-in account.
      const { data: businesses, error } = await admin
        .from("business_profile")
        .select("user_id, weather_zip_code, primary_industry")
        .eq("weather_surge_enabled", true)
        .not("weather_zip_code", "is", null);
      if (error) throw error;

      const results = [];
      for (const b of businesses ?? []) {
        const typedBusiness = b as { user_id: string; weather_zip_code: string; primary_industry: string | null };
        try {
          results.push(await checkOneBusiness(admin, typedBusiness));
        } catch (businessError) {
          console.error(JSON.stringify({
            event: "check_one_business_failed",
            user_id: typedBusiness.user_id,
            error: businessError instanceof Error ? businessError.message : String(businessError),
          }));
          results.push({ user_id: typedBusiness.user_id, error: "Unexpected error during check." });
        }
      }

      const { data: resolvedCount, error: resolveError } = await admin.rpc("resolve_expired_weather_surges");
      if (resolveError) console.error(JSON.stringify({ event: "resolve_expired_weather_surges_failed", error: resolveError.message }));

      return jsonResponse({ checked: results.length, resolved: resolvedCount ?? 0, results });
    }

    if (authHeader) {
      // Single-account check, triggered by a signed-in user from the dashboard.
      const jwt = authHeader.replace(/^Bearer\s+/i, "");
      const { data: userData, error: userError } = await admin.auth.getUser(jwt);
      if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session." }, 401);

      const { data: business, error: businessError } = await admin
        .from("business_profile")
        .select("user_id, weather_zip_code, primary_industry")
        .eq("user_id", userData.user.id)
        .maybeSingle();
      if (businessError) throw businessError;
      if (!business?.weather_zip_code) return jsonResponse({ error: "Set a zip code first." }, 400);

      const result = await checkOneBusiness(admin, business as { user_id: string; weather_zip_code: string; primary_industry: string | null });
      return jsonResponse(result);
    }

    return jsonResponse({ error: "Unauthorized." }, 401);
  } catch (error) {
    console.error(JSON.stringify({ event: "weather_surge_check_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Weather surge check failed." }, 500);
  }
});
