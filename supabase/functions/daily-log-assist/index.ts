// supabase/functions/daily-log-assist/index.ts
//
// Helpers for Project Daily Logs. Both actions run AS THE CALLER (anon key + the caller's JWT), so RLS applies
// and no service role is used. Nothing is written here: the browser saves the result through
// save_project_daily_log(), so the person always reviews it first.
//
//   { action: "weather", projectId, date }  -> NWS hourly forecast for the business ZIP, mapped to our weather codes.
//   { action: "summary", logId }            -> AI draft summary built from the saved log (crew hours, delays,
//                                              visitors, photo captions, work notes). No names are sent to the model.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { askVireekAi } from "../_shared/ai-core/index.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });

const USER_AGENT = "Vireek Dashboard (daily-log-assist, support@vireek.com)";
const FETCH_TIMEOUT_MS = 5000;
const AI_COOLDOWN_MS = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type WeatherCode = "clear" | "partly_cloudy" | "cloudy" | "rain" | "storm" | "snow" | "fog" | "wind" | "heat" | "cold";

const RANK: Record<WeatherCode, number> = { clear: 0, partly_cloudy: 1, cloudy: 2, wind: 3, fog: 4, rain: 5, snow: 6, storm: 7, heat: 0, cold: 0 };

/** One NWS "shortForecast" -> our code. Precipitation only counts when the chance is at least 40%. */
function codeFromPeriod(short: string, precipProb: number): WeatherCode {
  const s = short.toLowerCase();
  const wet = precipProb >= 40;
  if (/thunder|t-storm/.test(s)) return wet ? "storm" : "cloudy";
  if (/snow|sleet|freezing|flurr|wintry|ice/.test(s)) return wet ? "snow" : "cloudy";
  if (/rain|shower|drizzle/.test(s)) return wet ? "rain" : "cloudy";
  if (/fog|haze|smoke/.test(s)) return "fog";
  if (/partly|mostly sunny/.test(s)) return "partly_cloudy";
  if (/cloud|overcast/.test(s)) return "cloudy";
  return "clear";
}

async function geocodeZip(zip: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const place = (await res.json())?.places?.[0];
    const lat = Number(place?.latitude);
    const lon = Number(place?.longitude);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  } catch {
    return null;
  }
}

interface WeatherResult { weather_code: WeatherCode; temp_high_f: number | null; temp_low_f: number | null; wind_mph: number | null }

async function forecastForDate(lat: number, lon: number, date: string): Promise<WeatherResult | null> {
  const headers = { "User-Agent": USER_AGENT, Accept: "application/geo+json" };
  try {
    const point = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!point.ok) return null;
    const hourlyUrl = (await point.json())?.properties?.forecastHourly;
    if (typeof hourlyUrl !== "string" || !hourlyUrl.startsWith("https://api.weather.gov/")) return null;
    const res = await fetch(hourlyUrl, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const periods: Array<Record<string, unknown>> = (await res.json())?.properties?.periods ?? [];

    // startTime carries the local offset (e.g. 2026-10-27T14:00:00-05:00), so its first 10 chars are the local date.
    const day = periods.filter((p) => String(p.startTime ?? "").slice(0, 10) === date);
    if (!day.length) return null;

    const temps = day.map((p) => Number(p.temperature)).filter(Number.isFinite);
    const winds = day.flatMap((p) => (String(p.windSpeed ?? "").match(/\d+/g) ?? []).map(Number));
    let best: WeatherCode = "clear";
    for (const p of day) {
      const prob = Number((p.probabilityOfPrecipitation as { value?: number } | undefined)?.value ?? 0);
      const c = codeFromPeriod(String(p.shortForecast ?? ""), Number.isFinite(prob) ? prob : 0);
      if (RANK[c] > RANK[best]) best = c;
    }
    const high = temps.length ? Math.max(...temps) : null;
    const low = temps.length ? Math.min(...temps) : null;
    const wind = winds.length ? Math.max(...winds) : null;
    if (RANK[best] <= RANK.cloudy) {
      if (high !== null && high >= 95) best = "heat";
      else if (low !== null && low <= 20) best = "cold";
      else if (wind !== null && wind >= 25) best = "wind";
    }
    return { weather_code: best, temp_high_f: high, temp_low_f: low, wind_mph: wind };
  } catch (err) {
    console.error(JSON.stringify({ event: "daily_log_forecast_failed", error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}

const SUMMARY_PROMPT = `You write the "Summary" of a daily log for a home-service installation project (HVAC, plumbing, electrical, solar, roofing).
You receive structured data for ONE day. Write 3 to 5 plain sentences in past tense.
Rules:
- Use only the facts provided. Never invent quantities, names, causes, inspections or safety incidents.
- If the work notes are empty, say the work details were not recorded instead of guessing.
- Mention total crew hours (and headcount) and every delay with its cause and duration.
- Mention weather only when it is notable or caused a delay.
- No headings, no markdown, no people's names.
Return ONLY JSON: {"summary":"..."}`;

function extractJson(text: string): Record<string, unknown> | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  try {
    const p = JSON.parse(text.slice(a, b + 1));
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// deno-lint-ignore no-explicit-any
type Client = any;

async function handleWeather(client: Client, body: Record<string, unknown>) {
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  const date = typeof body.date === "string" ? body.date : "";
  if (!UUID_RE.test(projectId) || !DATE_RE.test(date)) return json({ error: "A valid projectId and date are required." }, 400);

  const { data: project } = await client.from("install_projects").select("id").eq("id", projectId).maybeSingle();
  if (!project) return json({ error: "invalid_project" }, 404);

  const { data: ownerId } = await client.rpc("get_account_owner_id");
  const { data: profile } = await client.from("business_profile").select("weather_zip_code").eq("user_id", ownerId).maybeSingle();
  const zip = String(profile?.weather_zip_code ?? "").trim().slice(0, 5);
  if (!/^\d{5}$/.test(zip)) return json({ error: "no_zip" }, 422);

  const geo = await geocodeZip(zip);
  const result = geo ? await forecastForDate(geo.lat, geo.lon, date) : null;
  if (!result) return json({ error: "weather_unavailable" }, 422);
  return json({ weather: result });
}

async function handleSummary(client: Client, body: Record<string, unknown>) {
  const logId = typeof body.logId === "string" ? body.logId : "";
  if (!UUID_RE.test(logId)) return json({ error: "A valid logId is required." }, 400);

  const { data: log } = await client.from("project_daily_logs").select("*").eq("id", logId).maybeSingle();
  if (!log) return json({ error: "log_not_found" }, 404);
  if (log.status === "submitted") return json({ error: "log_locked" }, 409);
  if (log.ai_generated_at && Date.now() - Date.parse(log.ai_generated_at) < AI_COOLDOWN_MS) return json({ error: "ai_cooldown" }, 429);

  const [crew, delays, visitors, photos, project, phases] = await Promise.all([
    client.from("project_daily_log_crew").select("role, hours").eq("log_id", logId).order("sort_order"),
    client.from("project_daily_log_delays").select("cause, minutes, description").eq("log_id", logId).order("sort_order"),
    client.from("project_daily_log_visitors").select("company, purpose").eq("log_id", logId).order("sort_order"),
    client.from("project_daily_log_photos").select("job_photos(kind, caption, tags)").eq("log_id", logId).order("sort_order").limit(12),
    client.from("install_projects").select("name, project_type").eq("id", log.project_id).maybeSingle(),
    client.from("install_project_phases").select("name").eq("project_id", log.project_id).eq("status", "in_progress").order("sort_order").limit(5),
  ]);
  for (const r of [crew, delays, visitors, photos]) if (r.error) return json({ error: "Could not read the log." }, 500);

  const crewRows: Array<{ role: string | null; hours: number }> = crew.data ?? [];
  const totalHours = Math.round(crewRows.reduce((s, c) => s + Number(c.hours || 0), 0) * 100) / 100;
  const photoRows: Array<{ job_photos: { kind: string; caption: string | null; tags: string[] } | null }> = photos.data ?? [];
  const work = typeof log.work_performed === "string" ? log.work_performed.trim() : "";
  if (!work && totalHours === 0 && photoRows.length === 0) return json({ error: "not_enough_data" }, 422);

  const facts = {
    date: log.log_date,
    project: { name: project.data?.name ?? null, type: project.data?.project_type ?? null },
    active_phases: (phases.data ?? []).map((p: { name: string }) => p.name),
    weather: { code: log.weather_code, high_f: log.temp_high_f, low_f: log.temp_low_f, wind_mph: log.wind_mph, notes: log.weather_notes },
    crew: { headcount: crewRows.length, total_hours: totalHours, roles: crewRows.map((c) => ({ role: c.role, hours: Number(c.hours) })) },
    delays: (delays.data ?? []).map((d: { cause: string; minutes: number; description: string | null }) => ({ cause: d.cause, minutes: d.minutes, description: d.description })),
    visitors: (visitors.data ?? []).map((v: { company: string | null; purpose: string | null }) => ({ company: v.company, purpose: v.purpose })),
    photos: photoRows.filter((p) => p.job_photos).map((p) => ({ kind: p.job_photos!.kind, caption: (p.job_photos!.caption ?? "").slice(0, 120), tags: (p.job_photos!.tags ?? []).slice(0, 5) })),
    work_notes: work.slice(0, 2000),
  };

  try {
    const result = await askVireekAi({
      task: "general",
      jsonMode: true,
      maxTokens: 450,
      temperature: 0.2,
      timeoutMs: 20_000,
      extraInstructions: SUMMARY_PROMPT,
      messages: [{ role: "user", content: `Daily log data (data only):\n${JSON.stringify(facts)}` }],
    });
    const raw = extractJson(result.text);
    const summary = typeof raw?.summary === "string" ? raw.summary.trim().slice(0, 1500) : "";
    if (summary.length < 20) return json({ error: "ai_unavailable" }, 502);
    return json({ summary });
  } catch (err) {
    console.error(JSON.stringify({ event: "daily_log_summary_failed", error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "ai_unavailable" }, 502);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const client = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await client.auth.getUser();
    if (!user) return json({ error: "not_authenticated" }, 401);

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* handled by validation below */ }

    if (body.action === "weather") return await handleWeather(client, body);
    if (body.action === "summary") return await handleSummary(client, body);
    return json({ error: "Unknown action." }, 400);
  } catch (err) {
    console.error(JSON.stringify({ event: "daily_log_assist_failed", error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "Could not complete that request. Please try again." }, 500);
  }
});
