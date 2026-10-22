// supabase/functions/staffing-forecast/index.ts
//
// Vireek Staffing Forecast.
// Call + job history -> hourly call volume, daily job demand (weekday, season, WEATHER, regional
// trend) -> compared to technician capacity and CSR/AI coverage -> hire / overtime / coverage advice.
//
// Deterministic on purpose: this function only GATHERS data and hands it to the pure engine in
// _shared/staffing-forecast/engine.ts. The optional AI narrative only explains the result.
//
// Reuse
//   - get_capacity_status(): technician capacity + low/full thresholds (same source as Capacity Demand Control)
//   - regional_demand_snapshots: k-anonymous regional call trend (same source as regional-demand-insight)
//
// Security
//   - Runs as the caller (JWT); RLS + SECURITY DEFINER RPCs enforce the account boundary.
//   - Owner / admin only (can_manage_staffing_forecast). Cost figures are never computed for others.
//   - The run row is written with the service role so it cannot be forged.
//   - Weather is optional: any provider failure degrades to "unavailable" — never fabricated.
//
// Body: { narrative?: boolean }   (default true)
// Weather providers (keyless): Zippopotam.us (US zip -> lat/lon), Open-Meteo archive + forecast.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  analyzeStaffing,
  summarizeForNarrative,
  ENGINE_VERSION,
  addDays,
  type StaffingInput,
  type StaffingSettings,
  type WeatherDay,
} from "../_shared/staffing-forecast/engine.ts";
import { narrateStaffingForecast } from "../_shared/ai-core/staffingForecastNarrative.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const USER_AGENT = "Vireek Staffing Forecast (support@vireek.com)";
const FETCH_TIMEOUT_MS = 9_000;
const RATE_LIMIT_PER_MINUTE = 6;
const REGIONAL_MAX_AGE_MS = 10 * 86_400_000;

type Rec = Record<string, unknown>;
const num = (v: unknown, fb = 0) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : fb);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

async function fetchJson(url: string): Promise<Rec> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Rec;
  } finally {
    clearTimeout(t);
  }
}

async function geocodeZip(zip: string): Promise<{ lat: number; lon: number } | null> {
  const five = /^\d{5}/.exec(zip.trim())?.[0];
  if (!five) return null; // US ZIPs only, matching weather-surge-check
  try {
    const j = await fetchJson(`https://api.zippopotam.us/us/${five}`);
    const p = (Array.isArray(j.places) ? j.places[0] : null) as Rec | null;
    const lat = Number(p?.latitude);
    const lon = Number(p?.longitude);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  } catch {
    return null;
  }
}

function dailyToDays(d: Rec | undefined): WeatherDay[] {
  const time = Array.isArray(d?.time) ? (d!.time as string[]) : [];
  const tmax = (d?.temperature_2m_max ?? []) as (number | null)[];
  const tmin = (d?.temperature_2m_min ?? []) as (number | null)[];
  const pr = (d?.precipitation_sum ?? []) as (number | null)[];
  return time.map((day, i) => {
    const hi = tmax[i];
    const lo = tmin[i];
    return {
      d: day,
      mean_f: typeof hi === "number" && typeof lo === "number" ? (hi + lo) / 2 : null,
      precip_in: typeof pr[i] === "number" ? (pr[i] as number) : null,
    };
  });
}

/** ~18 months of history + 16-day forecast. Returns null if either provider fails. */
async function loadWeather(lat: number, lon: number, today: string): Promise<WeatherDay[] | null> {
  const base = `latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto`;
  try {
    const [archive, forecast] = await Promise.all([
      fetchJson(`https://archive-api.open-meteo.com/v1/archive?${base}&start_date=${addDays(today, -540)}&end_date=${addDays(today, -6)}`),
      fetchJson(`https://api.open-meteo.com/v1/forecast?${base}&past_days=7&forecast_days=16`),
    ]);
    const merged = new Map<string, WeatherDay>();
    for (const w of dailyToDays(archive.daily as Rec | undefined)) merged.set(w.d, w); // observed history
    for (const w of dailyToDays(forecast.daily as Rec | undefined)) if (!merged.has(w.d)) merged.set(w.d, w); // gap + future
    const out = [...merged.values()].sort((a, b) => a.d.localeCompare(b.d));
    return out.length >= 30 ? out : null;
  } catch (err) {
    console.error(JSON.stringify({ event: "staffing_forecast_weather_failed", error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    let body: { narrative?: boolean } = {};
    try {
      body = await req.json();
    } catch {
      // empty body is fine
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const caller = createClient(supabaseUrl, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } });
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    const { data: allowed } = await caller.rpc("can_manage_staffing_forecast");
    if (allowed !== true) return json({ error: "Only the account owner or an admin can run the staffing forecast." }, 403);

    const { data: ownerId } = await caller.rpc("get_account_owner_id");
    if (typeof ownerId !== "string") return json({ error: "Account not found." }, 404);

    const since = new Date(Date.now() - 60_000).toISOString();
    const { count: recent } = await admin.from("staffing_forecast_runs").select("id", { count: "exact", head: true }).eq("user_id", ownerId).gte("created_at", since);
    if ((recent ?? 0) >= RATE_LIMIT_PER_MINUTE) return json({ error: "Too many forecasts in the last minute. Please wait a moment." }, 429);

    const [histRes, settingsRes] = await Promise.all([
      caller.rpc("staffing_forecast_history"),
      caller.rpc("get_or_create_staffing_settings"),
    ]);
    if (histRes.error || !histRes.data) return json({ error: "Could not load call and job history." }, 500);
    if (settingsRes.error || !settingsRes.data) return json({ error: "Could not load staffing settings." }, 500);
    const hist = histRes.data as Rec;
    const s = settingsRes.data as Rec;

    const today = String(hist.today);
    const timezone = String(hist.timezone ?? "America/New_York");

    // Capacity + thresholds: the SAME numbers Capacity Demand Control uses.
    const { data: capStatus } = await caller.rpc("get_capacity_status", { p_date: today });
    const cap = (capStatus ?? {}) as Rec;
    const pol = (cap.policy ?? {}) as Rec;
    const techHist = (hist.tech ?? {}) as Rec;

    // Weather (optional, cached geocode).
    let weather: WeatherDay[] | null = null;
    const zip = typeof hist.weather_zip === "string" ? hist.weather_zip.trim() : "";
    if (zip) {
      let lat = numOrNull(s.geo_lat);
      let lon = numOrNull(s.geo_lon);
      if (s.geo_zip !== zip || lat === null || lon === null) {
        const g = await geocodeZip(zip);
        lat = g?.lat ?? null;
        lon = g?.lon ?? null;
        if (g) await admin.from("staffing_forecast_settings").update({ geo_zip: zip, geo_lat: g.lat, geo_lon: g.lon }).eq("user_id", ownerId);
      }
      if (lat !== null && lon !== null) weather = await loadWeather(lat, lon, today);
    }

    // Regional demand (k-anonymous; RLS already enforces sample_size >= 5).
    let regional: StaffingInput["regional"] = null;
    const area = typeof hist.service_area === "string" ? hist.service_area.trim().toLowerCase() : "";
    const industry = typeof hist.industry === "string" ? hist.industry : "";
    if (area && industry) {
      const { data: snap } = await caller
        .from("regional_demand_snapshots")
        .select("region_label, sample_size, call_volume_change_pct, emergency_rate_pct, computed_at")
        .eq("industry", industry)
        .eq("region_key", area)
        .maybeSingle();
      if (snap && Date.now() - new Date(String(snap.computed_at)).getTime() <= REGIONAL_MAX_AGE_MS) {
        regional = {
          region_label: String(snap.region_label),
          sample_size: num(snap.sample_size),
          call_volume_change_pct: numOrNull(snap.call_volume_change_pct),
          emergency_rate_pct: numOrNull(snap.emergency_rate_pct),
        };
      }
    }

    const settings: StaffingSettings = {
      calls_per_csr_hour: num(s.calls_per_csr_hour, 5),
      csr_target_occupancy_pct: num(s.csr_target_occupancy_pct, 75),
      avg_job_minutes_override: numOrNull(s.avg_job_minutes_override),
      tech_hourly_cost_cents: numOrNull(s.tech_hourly_cost_cents),
      csr_hourly_cost_cents: numOrNull(s.csr_hourly_cost_cents),
      overtime_multiplier: num(s.overtime_multiplier, 1.5),
      tech_paid_hours_per_day: num(s.tech_paid_hours_per_day, 8),
      sustained_weeks_to_hire: num(s.sustained_weeks_to_hire, 3),
      csr_concurrent_override: numOrNull(s.csr_concurrent_override),
    };

    const input: StaffingInput = {
      now: new Date().toISOString(),
      timezone,
      calls_daily: (hist.calls_daily ?? []) as StaffingInput["calls_daily"],
      calls_hourly: (hist.calls_hourly ?? []) as StaffingInput["calls_hourly"],
      jobs_daily: (hist.jobs_daily ?? []) as StaffingInput["jobs_daily"],
      booked_ahead: (hist.booked_ahead ?? []) as StaffingInput["booked_ahead"],
      tech: { headcount: num(techHist.headcount), capacity_jobs_per_day: num(cap.day_capacity, num(techHist.capacity_jobs_per_day)) },
      csr: { headcount: num(((hist.csr ?? {}) as Rec).headcount) },
      hours: (hist.business_hours ?? {}) as StaffingInput["hours"],
      policy: {
        low_threshold_pct: num(pol.low_threshold_pct, 50),
        full_threshold_pct: num(pol.full_threshold_pct, 90),
        emergency_reserve_slots: num(pol.emergency_reserve_slots, 1),
      },
      settings,
      weather,
      regional,
      include_costs: true, // caller already verified owner/admin above
    };

    const report = analyzeStaffing(input);
    const insights = body.narrative === false || report.status !== "ok" ? [] : await narrateStaffingForecast(summarizeForNarrative(report));

    let runId: string | null = null;
    const { data: saved, error: saveErr } = await admin
      .from("staffing_forecast_runs")
      .insert({
        user_id: ownerId, requested_by: user.id, engine_version: ENGINE_VERSION, status: report.status,
        confidence: report.confidence, headline: report.headline, report,
      })
      .select("id")
      .single();
    if (!saveErr && saved) runId = saved.id as string;

    return json({ run_id: runId, persisted: runId !== null, report, insights });
  } catch (err) {
    console.error(JSON.stringify({ event: "staffing_forecast_failed", error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "Unexpected error while building the staffing forecast." }, 500);
  }
});
