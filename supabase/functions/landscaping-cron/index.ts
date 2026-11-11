// landscaping-cron
//
// Scheduled (hourly, or daily at ~18:00 local for the weather step) worker for the Landscaping pack:
//   1. landscape_cron_tick()   — reconciles paused/ended contracts and idempotently generates visits
//      (+ jobs, checklists, seasonal rounds) inside the look-ahead window.
//   2. weather step            — for tomorrow's visits whose contract has weather rules: asks the WeatherAdapter
//      for a forecast, decides with the shared engine, applies skip (+ make-up date) through
//      landscape_apply_weather_decision(). An unknown / failed forecast NEVER skips a visit.
//
// Everything is gated inside the database (feature flag `landscaping_pack` + entitlement `packs:landscaping`);
// tenants without both are ignored. Nothing here assumes a tenant is enabled.
//
// Deploy + secure (fails CLOSED: without the secret every call is rejected):
//   supabase functions deploy landscaping-cron --no-verify-jwt
//   supabase secrets set LANDSCAPING_CRON_SECRET=<long-random-string>
//   Optional: LANDSCAPING_WEATHER_PROVIDER=none|mock   (default none — the weather step is skipped)
// Header: X-Cron-Secret: <LANDSCAPING_CRON_SECRET>
// Body (optional JSON): { "lookahead_days": 14, "weather_date": "YYYY-MM-DD" }

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { addDays, buildHolidayLookup, type HolidaySet } from "../../../src/lib/tradePacks/landscaping/calendar.ts";
import {
  decideForDate,
  makeupDate,
  MockWeatherAdapter,
  NullWeatherAdapter,
  type WeatherAdapter,
  type WeatherPolicy,
} from "../../../src/lib/tradePacks/landscaping/weather.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Real forecast providers are wired here, behind WeatherAdapter, after review. Default: none ⇒ never skips. */
function pickAdapter(): WeatherAdapter {
  const id = Deno.env.get("LANDSCAPING_WEATHER_PROVIDER") ?? "none";
  if (id === "mock") return new MockWeatherAdapter({});
  return new NullWeatherAdapter();
}

interface WeatherRow {
  visit_id: string;
  visit_date: string;
  lat: number | null;
  lng: number | null;
  weather_policy: WeatherPolicy;
  workdays: number[];
  holiday_set: HolidaySet;
  extra_holidays: string[];
  occupied: string[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  const cronSecret = Deno.env.get("LANDSCAPING_CRON_SECRET");
  if (!cronSecret) return jsonResponse({ error: "Server misconfiguration: LANDSCAPING_CRON_SECRET is not set." }, 500);
  if (!timingSafeEqual(req.headers.get("X-Cron-Secret") ?? "", cronSecret)) return jsonResponse({ error: "Unauthorized." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Server misconfiguration." }, 500);

  let body: { lookahead_days?: number; weather_date?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const lookahead = Number.isInteger(body.lookahead_days) ? Math.min(Math.max(body.lookahead_days as number, 1), 60) : 14;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const errors: string[] = [];

  let generation: unknown = null;
  try {
    const { data, error } = await admin.rpc("landscape_cron_tick", { p_lookahead: lookahead });
    if (error) throw error;
    generation = data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`generation: ${message}`);
    console.error(JSON.stringify({ event: "landscaping_generation_failed", error: message }));
  }

  // Weather is independent of generation — one failing must not block the other.
  const weather = { provider: "none", considered: 0, skipped: 0, kept: 0, unknown: 0, failed: 0 };
  try {
    const adapter = pickAdapter();
    weather.provider = adapter.id;
    if (adapter.id !== "none") {
      const date = body.weather_date && /^\d{4}-\d{2}-\d{2}$/.test(body.weather_date) ? body.weather_date : addDays(new Date().toISOString().slice(0, 10), 1);
      const { data, error } = await admin.rpc("landscape_visits_for_weather", { p_date: date });
      if (error) throw error;
      const rows = (data ?? []) as WeatherRow[];
      weather.considered = rows.length;
      const decisions = await decideForDate(
        adapter,
        date,
        rows.map((r) => ({ id: r.visit_id, point: r.lat != null && r.lng != null ? { lat: Number(r.lat), lng: Number(r.lng) } : null, policy: r.weather_policy })),
      );
      const byId = new Map(rows.map((r) => [r.visit_id, r]));
      for (const d of decisions) {
        const row = byId.get(d.id) as WeatherRow;
        if (d.decision.decision === "unknown") {
          weather.unknown += 1;
          continue;
        }
        const skip = d.decision.decision === "skip";
        let makeup: string | null = null;
        if (skip) {
          const hol = buildHolidayLookup(date, addDays(date, 14), row.holiday_set, row.extra_holidays);
          makeup = makeupDate(date, row.weather_policy.makeup, row.workdays, hol, new Set(row.occupied));
        }
        const res = await admin.rpc("landscape_apply_weather_decision", {
          p_visit_id: d.id,
          p_skip: skip,
          p_reasons: d.decision.reasons,
          p_forecast: d.forecast,
          p_makeup_date: makeup,
          p_source: adapter.id,
        });
        if (res.error) {
          weather.failed += 1;
          errors.push(`weather ${d.id}: ${res.error.message}`);
        } else if (skip) weather.skipped += 1;
        else weather.kept += 1;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`weather: ${message}`);
    console.error(JSON.stringify({ event: "landscaping_weather_failed", error: message }));
  }

  return jsonResponse({ ok: errors.length === 0, generation, weather, errors }, errors.length ? 207 : 200);
});
