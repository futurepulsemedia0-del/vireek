// external-world-sync
//
// Pulls live external data for a user's properties and stores it in
// external_world_signals (see 20270301000000_external_world_graph.sql).
// Called from the dashboard (World Model -> External World -> "Sync")
// with the signed-in user's `Authorization: Bearer <access_token>`.
//
// Body: { properties: [{ key, address, latitude?, longitude? }], force?: boolean }
//   key = World Model property node key, e.g. "property:123 main st, austin, tx"
//   Max 6 properties per call (the client batches).
//
// Sources (all US):
//   NOAA National Weather Service  api.weather.gov            keyless  alerts + 7-day forecast
//   NASA POWER                     power.larc.nasa.gov        keyless  30-yr climatology, degree-days
//   US Census Geocoder             geocoding.geo.census.gov   keyless  address -> lat/lon/state/county
//   OpenStreetMap Nominatim        (fallback geocoder, 1 req/s)
//   FEMA National Risk Index       ArcGIS county layer        keyless  hazard ratings by county
//   EIA                            api.eia.gov                optional secret EIA_API_KEY (free)
//
// Optional secrets:
//   EIA_API_KEY       enables the electricity-price signal; skipped when absent
//   NRI_COUNTIES_URL  overrides the FEMA NRI county FeatureServer /query URL
//
// Every provider is best-effort: a failed provider writes nothing and never
// fails the whole sync. Fresh signals (within TTL) are skipped unless force.
//
// Deploy:  supabase functions deploy external-world-sync

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const USER_AGENT = "Vireek Dashboard (external-world-sync, support@vireek.com)";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_PROPERTIES = 6;
const NOMINATIM_DELAY_MS = 1_100;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const NRI_URL =
  Deno.env.get("NRI_COUNTIES_URL") ??
  "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Counties/FeatureServer/0/query";

type SignalKey = "nws_alerts" | "nws_forecast" | "nasa_climate" | "fema_nri" | "eia_electricity";
const SIGNAL_META: Record<SignalKey, { domain: string; ttl: number; source: string }> = {
  nws_alerts: { domain: "weather", ttl: 30 * 60_000, source: "NOAA National Weather Service" },
  nws_forecast: { domain: "weather", ttl: 3 * HOUR, source: "NOAA National Weather Service" },
  nasa_climate: { domain: "climate", ttl: 90 * DAY, source: "NASA POWER" },
  fema_nri: { domain: "hazards", ttl: 180 * DAY, source: "FEMA National Risk Index" },
  eia_electricity: { domain: "energy", ttl: 7 * DAY, source: "U.S. EIA" },
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONTH_DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const BASE_C = 18.3;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

// deno-lint-ignore no-explicit-any
async function getJson(url: string, headers: Record<string, string> = {}): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    // never log the query string (may contain an API key)
    console.error(JSON.stringify({ event: "external_world_fetch_failed", url: url.split("?")[0], error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}

// ---------------------------------------------------------------- geography

interface Geo { lat: number; lon: number; state: string | null; countyFips: string | null; countyName: string | null }

// deno-lint-ignore no-explicit-any
function readCensusGeographies(g: any): { state: string | null; countyFips: string | null; countyName: string | null } {
  const county = g?.Counties?.[0];
  const st = g?.States?.[0];
  return {
    state: typeof st?.STUSAB === "string" ? st.STUSAB : null,
    countyFips: typeof county?.GEOID === "string" && /^\d{5}$/.test(county.GEOID) ? county.GEOID : null,
    countyName: typeof county?.NAME === "string" ? county.NAME : null,
  };
}

async function censusByAddress(address: string): Promise<Geo | null> {
  const data = await getJson(
    `https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`
  );
  const m = data?.result?.addressMatches?.[0];
  const lon = num(m?.coordinates?.x);
  const lat = num(m?.coordinates?.y);
  if (!m || lat == null || lon == null) return null;
  return { lat, lon, ...readCensusGeographies(m.geographies) };
}

async function censusByPoint(lat: number, lon: number) {
  const data = await getJson(
    `https://geocoding.geo.census.gov/geocoder/geographies/coordinates?x=${lon}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`
  );
  return readCensusGeographies(data?.result?.geographies);
}

async function nominatim(address: string): Promise<{ lat: number; lon: number } | null> {
  await sleep(NOMINATIM_DELAY_MS);
  const data = await getJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(address)}`);
  const hit = Array.isArray(data) ? data[0] : null;
  const lat = num(hit?.lat);
  const lon = num(hit?.lon);
  return lat != null && lon != null ? { lat, lon } : null;
}

function stateFromAddress(address: string): string | null {
  const m = address.match(/,\s*([A-Z]{2})\b(?:\s+\d{5})?/);
  return m ? m[1] : null;
}

async function resolveGeo(address: string, lat: number | null, lon: number | null): Promise<Geo | null> {
  if (lat != null && lon != null) {
    const g = await censusByPoint(lat, lon);
    return { lat, lon, ...g, state: g.state ?? stateFromAddress(address) };
  }
  const byAddress = await censusByAddress(address);
  if (byAddress) return { ...byAddress, state: byAddress.state ?? stateFromAddress(address) };
  const fallback = await nominatim(address);
  if (!fallback) return null;
  const g = await censusByPoint(fallback.lat, fallback.lon);
  return { ...fallback, ...g, state: g.state ?? stateFromAddress(address) };
}

// ---------------------------------------------------------------- providers

interface SignalOut { key: SignalKey; value: Record<string, unknown>; sourceUrl: string; asOf: string | null }

async function fetchNws(lat: number, lon: number): Promise<SignalOut[]> {
  const geo = { Accept: "application/geo+json" };
  const point = await getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, geo);
  if (!point?.properties) return []; // outside NWS coverage
  const [alertsRes, forecastRes] = await Promise.all([
    getJson(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`, geo),
    typeof point.properties.forecast === "string" ? getJson(point.properties.forecast, geo) : Promise.resolve(null),
  ]);
  const out: SignalOut[] = [];
  const now = new Date().toISOString();

  if (alertsRes) {
    // deno-lint-ignore no-explicit-any
    const alerts = (alertsRes.features ?? []).slice(0, 15).map((f: any) => ({
      id: String(f.properties?.id ?? ""),
      event: String(f.properties?.event ?? "Alert"),
      severity: f.properties?.severity ?? null,
      headline: f.properties?.headline ?? null,
      expires: f.properties?.expires ?? null,
    }));
    out.push({ key: "nws_alerts", value: { alerts }, sourceUrl: "https://api.weather.gov/alerts/active", asOf: now });
  }
  // deno-lint-ignore no-explicit-any
  const periods: any[] = forecastRes?.properties?.periods ?? [];
  if (periods.length > 0) {
    const temps = periods
      .slice(0, 14)
      .map((p) => {
        const t = num(p.temperatureUnit === "C" ? (num(p.temperature) ?? NaN) * 1.8 + 32 : p.temperature);
        return t == null ? null : Math.round(t);
      })
      .filter((t): t is number => t != null);
    if (temps.length > 0) {
      out.push({
        key: "nws_forecast",
        value: { max_f: Math.max(...temps), min_f: Math.min(...temps) },
        sourceUrl: String(point.properties.forecast),
        asOf: forecastRes?.properties?.updateTime ?? now,
      });
    }
  }
  return out;
}

async function fetchClimate(lat: number, lon: number): Promise<SignalOut[]> {
  const base = `https://power.larc.nasa.gov/api/temporal/climatology/point?community=SB&longitude=${lon.toFixed(4)}&latitude=${lat.toFixed(4)}&format=JSON`;
  let data = await getJson(`${base}&parameters=T2M,T2M_MAX,T2M_MIN,HDD18_3,CDD18_3`);
  if (!data?.properties?.parameter) data = await getJson(`${base}&parameters=T2M`);
  const p = data?.properties?.parameter;
  if (!p) return [];
  const valid = (v: unknown): number | null => {
    const n = num(v);
    return n != null && n > -900 ? n : null;
  };
  const ann = (k: string) => valid(p[k]?.ANN);
  const monthly: (number | null)[] = MONTHS.map((m) => valid(p.T2M?.[m]));

  let hdd = ann("HDD18_3");
  let cdd = ann("CDD18_3");
  let estimated = false;
  if ((hdd == null || cdd == null) && monthly.every((t) => t != null)) {
    // Fallback: degree-days from monthly means (underestimates; flagged)
    hdd = monthly.reduce((s, t, i) => s + MONTH_DAYS[i] * Math.max(0, BASE_C - (t as number)), 0);
    cdd = monthly.reduce((s, t, i) => s + MONTH_DAYS[i] * Math.max(0, (t as number) - BASE_C), 0);
    estimated = true;
  }
  if (hdd == null && cdd == null && ann("T2M") == null) return [];
  return [{
    key: "nasa_climate",
    value: { mean_c: ann("T2M"), max_c: ann("T2M_MAX"), min_c: ann("T2M_MIN"), hdd_c: hdd, cdd_c: cdd, estimated },
    sourceUrl: "https://power.larc.nasa.gov/docs/services/api/temporal/climatology/",
    asOf: null,
  }];
}

const NRI_HAZARDS = [
  "AVLN", "CFLD", "CWAV", "DRGT", "ERQK", "HAIL", "HWAV", "HRCN", "ISTM",
  "IFLD", "LNDS", "LTNG", "SWND", "TRND", "TSUN", "VLCN", "WFIR", "WNTW",
];
const NRI_RATINGS = new Set(["Very Low", "Relatively Low", "Relatively Moderate", "Relatively High", "Very High"]);

async function fetchNri(countyFips: string): Promise<SignalOut[]> {
  if (!/^\d{5}$/.test(countyFips)) return [];
  const url = `${NRI_URL}?where=${encodeURIComponent(`STCOFIPS='${countyFips}'`)}&outFields=*&returnGeometry=false&f=json`;
  const data = await getJson(url);
  const a = data?.features?.[0]?.attributes;
  if (!a) return [];
  const hazards: Record<string, string> = {};
  for (const code of NRI_HAZARDS) {
    const r = a[`${code}_RISKR`];
    if (typeof r === "string" && NRI_RATINGS.has(r)) hazards[code] = r;
  }
  return [{
    key: "fema_nri",
    value: {
      risk_rating: typeof a.RISK_RATNG === "string" ? a.RISK_RATNG : null,
      risk_score: num(a.RISK_SCORE),
      eal_total: num(a.EAL_VALT),
      county_name: typeof a.COUNTY === "string" ? a.COUNTY : null,
      hazards,
    },
    sourceUrl: "https://hazards.fema.gov/nri/",
    asOf: null,
  }];
}

async function fetchEia(state: string, apiKey: string): Promise<SignalOut[]> {
  if (!/^[A-Z]{2}$/.test(state)) return [];
  const url =
    `https://api.eia.gov/v2/electricity/retail-sales/data/?api_key=${encodeURIComponent(apiKey)}` +
    `&frequency=monthly&data[0]=price&facets[stateid][]=${state}&facets[sectorid][]=RES` +
    `&sort[0][column]=period&sort[0][direction]=desc&offset=0&length=1`;
  const data = await getJson(url);
  const row = data?.response?.data?.[0];
  const cents = num(row?.price);
  if (cents == null) return [];
  return [{
    key: "eia_electricity",
    value: { cents_per_kwh: cents, period: typeof row.period === "string" ? row.period : null },
    sourceUrl: "https://www.eia.gov/electricity/data.php",
    asOf: typeof row.period === "string" ? `${row.period}-01T00:00:00Z` : null,
  }];
}

// ---------------------------------------------------------------- handler

interface InProperty { key: string; address: string; latitude?: number; longitude?: number }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "Missing Authorization header." }, 401);

  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return json({ error: "Invalid or expired session." }, 401);
  const { data: ownerId, error: ownerError } = await db.rpc("get_account_owner_id");
  if (ownerError || !ownerId) return json({ error: "Could not resolve your account." }, 500);

  let body: { properties?: InProperty[]; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const props = (body.properties ?? [])
    .filter((p) => typeof p?.key === "string" && p.key.length <= 300 && typeof p?.address === "string" && p.address.trim().length > 0 && p.address.length <= 300)
    .slice(0, MAX_PROPERTIES);
  if (props.length === 0) return json({ error: "No valid properties provided." }, 400);
  const force = body.force === true;
  const eiaKey = Deno.env.get("EIA_API_KEY") ?? "";

  const { data: existingLocs, error: locErr } = await db
    .from("external_world_locations")
    .select("*")
    .eq("user_id", ownerId)
    .in("property_key", props.map((p) => p.key));
  if (locErr) return json({ error: "Could not read stored locations." }, 500);
  // deno-lint-ignore no-explicit-any
  const locByKey = new Map<string, any>((existingLocs ?? []).map((l: any) => [l.property_key, l]));

  const existingIds = (existingLocs ?? []).map((l: { id: string }) => l.id);
  const { data: existingSignals } = existingIds.length
    ? await db.from("external_world_signals").select("location_id, signal_key, expires_at").in("location_id", existingIds)
    : { data: [] as { location_id: string; signal_key: string; expires_at: string }[] };
  const freshSet = new Set<string>();
  for (const s of existingSignals ?? []) {
    if (new Date(s.expires_at).getTime() > Date.now()) freshSet.add(`${s.location_id}:${s.signal_key}`);
  }

  let signalsWritten = 0;
  let skippedFresh = 0;
  let synced = 0;
  const notFound: string[] = [];

  for (const p of props) {
    let loc = locByKey.get(p.key);
    const incomplete = !loc || loc.latitude == null || !loc.state || !loc.county_fips;
    const blocked = loc?.geocode_status === "not_found" && !force;
    if (incomplete && !blocked) {
      const geo = await resolveGeo(p.address, num(p.latitude) ?? num(loc?.latitude), num(p.longitude) ?? num(loc?.longitude));
      const row = geo
        ? { latitude: geo.lat, longitude: geo.lon, state: geo.state, county_fips: geo.countyFips, county_name: geo.countyName, geocode_status: "geocoded", geocoded_at: new Date().toISOString() }
        : { geocode_status: "not_found" };
      const { data: saved, error } = await db
        .from("external_world_locations")
        .upsert({ user_id: ownerId, property_key: p.key, address: p.address.trim(), ...row, updated_at: new Date().toISOString() }, { onConflict: "user_id,property_key" })
        .select()
        .single();
      if (error || !saved) continue;
      loc = saved;
    }
    if (!loc || loc.geocode_status !== "geocoded" || loc.latitude == null || loc.longitude == null) {
      notFound.push(p.key);
      continue;
    }
    synced += 1;

    const stale = (k: SignalKey) => force || !freshSet.has(`${loc.id}:${k}`);
    const jobs: Promise<SignalOut[]>[] = [];
    if (stale("nws_alerts") || stale("nws_forecast")) jobs.push(fetchNws(loc.latitude, loc.longitude));
    else skippedFresh += 2;
    if (stale("nasa_climate")) jobs.push(fetchClimate(loc.latitude, loc.longitude));
    else skippedFresh += 1;
    if (loc.county_fips && stale("fema_nri")) jobs.push(fetchNri(loc.county_fips));
    else if (loc.county_fips) skippedFresh += 1;
    if (eiaKey && loc.state && stale("eia_electricity")) jobs.push(fetchEia(loc.state, eiaKey));
    else if (eiaKey && loc.state) skippedFresh += 1;

    const results = (await Promise.all(jobs)).flat();
    const now = Date.now();
    const rows = results.map((s) => ({
      user_id: ownerId,
      location_id: loc.id,
      domain: SIGNAL_META[s.key].domain,
      signal_key: s.key,
      value: s.value,
      source: SIGNAL_META[s.key].source,
      source_url: s.sourceUrl,
      as_of: s.asOf,
      expires_at: new Date(now + SIGNAL_META[s.key].ttl).toISOString(),
      fetched_at: new Date(now).toISOString(),
    }));
    if (rows.length > 0) {
      const { error } = await db.from("external_world_signals").upsert(rows, { onConflict: "location_id,signal_key" });
      if (error) console.error(JSON.stringify({ event: "external_world_signal_upsert_failed", error: error.message }));
      else signalsWritten += rows.length;
    }
  }

  return json({
    properties: synced,
    signals_written: signalsWritten,
    skipped_fresh: skippedFresh,
    not_found: notFound,
    eia_configured: eiaKey.length > 0,
  });
});
