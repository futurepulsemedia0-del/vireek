// property-intelligence-enrich
//
// Builds the external layers of the Property Intelligence Graph for one customer site:
//   address -> coordinates (+ US census tract), climate, hazards, economic context.
//
// Runs as the CALLER (anon key + the caller's JWT), never with the service role, so RLS decides what
// they may read/write — team members of an account behave exactly like the owner.
//
// Providers (all keyless; optional CENSUS_API_KEY secret raises Census rate limits):
//   - OpenStreetMap Nominatim     : geocoding (only when coordinates are missing or the address changed)
//   - US Census Geocoder / ACS    : census tract + area-level economics (US only)
//   - Open-Meteo Archive          : 5-year climate normals
//   - FEMA NFHL / USGS Earthquake : flood zone (US only) / regional seismic activity
//
// Rules:
//   - Layers with status 'manual' (user-verified) are never overwritten.
//   - A failed/unavailable provider never replaces previously good data.
//   - One run per profile at a time (atomic claim) + 30s cooldown to be a good citizen to public APIs.
//
// Body: { "site_id": "<uuid>", "layers"?: ["climate" | "hazards" | "economic"] }

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const USER_AGENT = "Vireek Property Intelligence (support@vireek.com)";
const FETCH_TIMEOUT_MS = 9_000;
const COOLDOWN_MS = 30_000;
const STALE_LOCK_MS = 3 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACS_VINTAGES = [2024, 2023, 2022];

type ProviderLayer = "climate" | "hazards" | "economic";
const PROVIDER_LAYERS: ProviderLayer[] = ["climate", "hazards", "economic"];

interface LayerResult {
  layer: ProviderLayer;
  status: "ok" | "partial" | "unavailable" | "failed";
  data: Record<string, unknown>;
  source: string;
  confidence: number;
  as_of: string | null;
  error: string | null;
}

type Json = Record<string, unknown>;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function log(event: string, extra: Json = {}) {
  console.log(JSON.stringify({ event, ...extra }));
}

function msg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v: number, d = 0) => Math.round(v * 10 ** d) / 10 ** d;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function fetchJson(url: string): Promise<Json> {
  const parsed = JSON.parse(await fetchText(url));
  if (parsed === null || typeof parsed !== "object") throw new Error("Unexpected response");
  return parsed as Json;
}

// ---------------------------------------------------------------- geocoding

interface GeoPoint {
  lat: number;
  lon: number;
  display: string | null;
  country: string | null;
  confidence: number;
}

async function geocode(query: string): Promise<GeoPoint | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(query)}`;
  const parsed = JSON.parse(await fetchText(url));
  const hit = Array.isArray(parsed) ? (parsed[0] as Json | undefined) : undefined;
  if (!hit) return null;
  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const addr = (hit.address ?? {}) as Json;
  const country = typeof addr.country_code === "string" && addr.country_code.length === 2 ? addr.country_code.toUpperCase() : null;
  const importance = asNum(hit.importance) ?? 0.5;
  return {
    lat,
    lon,
    display: typeof hit.display_name === "string" ? hit.display_name.slice(0, 500) : null,
    country,
    confidence: round(Math.min(0.99, Math.max(0.3, importance)), 2),
  };
}

async function censusTract(lat: number, lon: number): Promise<string | null> {
  const url =
    "https://geocoding.geo.census.gov/geocoder/geographies/coordinates" +
    `?x=${lon}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current&layers=Census%20Tracts&format=json`;
  const j = await fetchJson(url);
  const tracts = ((j.result as Json | undefined)?.geographies as Json | undefined)?.["Census Tracts"];
  const geoid = Array.isArray(tracts) ? (tracts[0] as Json | undefined)?.GEOID : null;
  return typeof geoid === "string" && /^[0-9]{11}$/.test(geoid) ? geoid : null;
}

// ---------------------------------------------------------------- climate

interface DailySeries {
  time?: string[];
  temperature_2m_max?: Array<number | null>;
  temperature_2m_min?: Array<number | null>;
  temperature_2m_mean?: Array<number | null>;
  precipitation_sum?: Array<number | null>;
}

async function climateLayer(lat: number, lon: number): Promise<LayerResult> {
  const year = new Date().getUTCFullYear();
  const start = `${year - 5}-01-01`;
  const end = `${year - 1}-12-31`;
  const url =
    "https://archive-api.open-meteo.com/v1/archive" +
    `?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}` +
    "&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum" +
    "&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto";
  const j = await fetchJson(url);
  const d = (j.daily ?? {}) as DailySeries;
  const days = d.time?.length ?? 0;
  if (!days) throw new Error("No climate data returned");

  let valid = 0;
  let hdd = 0;
  let cdd = 0;
  let sumMean = 0;
  let heat = 0;
  let freeze = 0;
  let precip = 0;
  let hi = -Infinity;
  let lo = Infinity;

  for (let i = 0; i < days; i++) {
    const tmax = asNum(d.temperature_2m_max?.[i]);
    const tmin = asNum(d.temperature_2m_min?.[i]);
    const mean = asNum(d.temperature_2m_mean?.[i]) ?? (tmax !== null && tmin !== null ? (tmax + tmin) / 2 : null);
    if (mean === null) continue;
    valid++;
    sumMean += mean;
    hdd += Math.max(0, 65 - mean);
    cdd += Math.max(0, mean - 65);
    if (tmax !== null) {
      if (tmax >= 95) heat++;
      hi = Math.max(hi, tmax);
    }
    if (tmin !== null) {
      if (tmin <= 32) freeze++;
      lo = Math.min(lo, tmin);
    }
    precip += asNum(d.precipitation_sum?.[i]) ?? 0;
  }

  if (valid < 365 * 3) throw new Error("Insufficient climate history");
  const perYear = 365.25 / valid;
  const hddY = hdd * perYear;
  const cddY = cdd * perYear;
  const share = hddY + cddY > 0 ? hddY / (hddY + cddY) : 0.5;

  return {
    layer: "climate",
    status: "ok",
    data: {
      window: { start, end },
      avg_temp_f: round(sumMean / valid, 1),
      hdd65_f: round(hddY),
      cdd65_f: round(cddY),
      heat_days_95f: round(heat * perYear),
      freeze_days_32f: round(freeze * perYear),
      precip_in: round(precip * perYear, 1),
      record_high_f: Number.isFinite(hi) ? round(hi, 1) : null,
      record_low_f: Number.isFinite(lo) ? round(lo, 1) : null,
      climate_profile: share > 0.65 ? "heating_dominated" : share < 0.35 ? "cooling_dominated" : "mixed",
    },
    source: "open-meteo.com (ERA5 reanalysis)",
    confidence: 0.85,
    as_of: end,
    error: null,
  };
}

// ---------------------------------------------------------------- hazards

async function floodHazard(lat: number, lon: number): Promise<Json> {
  const url =
    "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query" +
    `?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects` +
    "&outFields=FLD_ZONE,SFHA_TF,ZONE_SUBTY&returnGeometry=false&f=json";
  const j = await fetchJson(url);
  if (j.error) throw new Error("FEMA service error");
  const feature = Array.isArray(j.features) ? (j.features[0] as Json | undefined) : undefined;
  const a = (feature?.attributes ?? null) as Json | null;
  if (!a) return { mapped: false, zone: null, sfha: null, subtype: null, source: "FEMA NFHL" };
  return {
    mapped: true,
    zone: typeof a.FLD_ZONE === "string" ? a.FLD_ZONE : null,
    sfha: a.SFHA_TF === "T" ? true : a.SFHA_TF === "F" ? false : null,
    subtype: typeof a.ZONE_SUBTY === "string" ? a.ZONE_SUBTY : null,
    source: "FEMA NFHL",
  };
}

async function seismicHazard(lat: number, lon: number): Promise<Json> {
  const years = 10;
  const startYear = new Date().getUTCFullYear() - years;
  const url =
    "https://earthquake.usgs.gov/fdsnws/event/1/count" +
    `?format=geojson&latitude=${lat}&longitude=${lon}&maxradiuskm=100&minmagnitude=4&starttime=${startYear}-01-01`;
  const text = await fetchText(url);
  let count: number | null = null;
  try {
    count = asNum((JSON.parse(text) as Json).count);
  } catch {
    count = Number.isFinite(Number(text.trim())) ? Number(text.trim()) : null;
  }
  if (count === null) throw new Error("Unexpected USGS response");
  return { events_m4_100km: count, window_years: years, source: "USGS ComCat" };
}

async function hazardsLayer(lat: number, lon: number, country: string | null): Promise<LayerResult> {
  const attempts: Array<{ key: string; run: Promise<Json> }> = [{ key: "seismic", run: seismicHazard(lat, lon) }];
  const notCovered: string[] = [];
  if (country === "US") attempts.push({ key: "flood", run: floodHazard(lat, lon) });
  else notCovered.push("flood");

  const settled = await Promise.allSettled(attempts.map((a) => a.run));
  const data: Json = { not_covered: notCovered };
  const errors: string[] = [];
  let ok = 0;
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      data[attempts[i].key] = r.value;
      ok++;
    } else {
      errors.push(`${attempts[i].key}: ${msg(r.reason)}`);
    }
  });

  const status = ok === attempts.length ? "ok" : ok > 0 ? "partial" : "failed";
  return {
    layer: "hazards",
    status,
    data,
    source: "FEMA NFHL, USGS ComCat",
    confidence: status === "ok" ? 0.8 : status === "partial" ? 0.4 : 0,
    as_of: new Date().toISOString().slice(0, 10),
    error: errors.length ? errors.join("; ").slice(0, 500) : null,
  };
}

// ---------------------------------------------------------------- economic (area level, never about the occupants)

const acsValue = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > -1_000_000 ? n : null; // Census uses -666666666 style sentinels
};

async function economicLayer(geoid: string | null, country: string | null): Promise<LayerResult> {
  if (country !== "US" || !geoid) {
    return {
      layer: "economic",
      status: "unavailable",
      data: {},
      source: "US Census ACS 5-year",
      confidence: 0,
      as_of: null,
      error: "Requires a US address with a resolved census tract",
    };
  }
  const state = geoid.slice(0, 2);
  const county = geoid.slice(2, 5);
  const tract = geoid.slice(5);
  const key = Deno.env.get("CENSUS_API_KEY");
  let lastError = "No ACS vintage available";

  for (const vintage of ACS_VINTAGES) {
    try {
      const url =
        `https://api.census.gov/data/${vintage}/acs/acs5` +
        "?get=B25077_001E,B19013_001E,B25035_001E,B25003_001E,B25003_002E" +
        `&for=tract:${tract}&in=state:${state}%20county:${county}${key ? `&key=${encodeURIComponent(key)}` : ""}`;
      const parsed = JSON.parse(await fetchText(url));
      const row = Array.isArray(parsed) && Array.isArray(parsed[1]) ? (parsed[1] as unknown[]) : null;
      if (!row) throw new Error("Empty ACS response");
      const [homeValue, income, yearBuilt, units, owned] = row.map(acsValue);
      if ([homeValue, income, yearBuilt].every((v) => v === null)) throw new Error("No ACS values for tract");
      return {
        layer: "economic",
        status: "ok",
        data: {
          geography: "census_tract",
          geoid,
          vintage,
          median_home_value_usd: homeValue,
          median_household_income_usd: income,
          median_year_built: yearBuilt,
          owner_occupied_pct: units && owned !== null ? round((owned / units) * 100, 1) : null,
        },
        source: `US Census ACS 5-year ${vintage}`,
        confidence: 0.9,
        as_of: `${vintage}-12-31`,
        error: null,
      };
    } catch (err) {
      lastError = msg(err);
    }
  }
  throw new Error(lastError);
}

// ---------------------------------------------------------------- handler

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return jsonResponse({ error: "Missing Authorization header." }, 401);

  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userError } = await db.auth.getUser(jwt);
  if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session." }, 401);

  let body: { site_id?: unknown; layers?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }
  const siteId = typeof body.site_id === "string" ? body.site_id : "";
  if (!UUID_RE.test(siteId)) return jsonResponse({ error: "site_id must be a UUID." }, 400);

  const requested = Array.isArray(body.layers)
    ? PROVIDER_LAYERS.filter((l) => (body.layers as unknown[]).includes(l))
    : PROVIDER_LAYERS;
  if (requested.length === 0) return jsonResponse({ error: "No valid layers requested." }, 400);

  // RLS decides whether this site is visible to the caller.
  const { data: site, error: siteError } = await db
    .from("customer_sites")
    .select("id, address, city, state, postal_code")
    .eq("id", siteId)
    .maybeSingle();
  if (siteError) return jsonResponse({ error: "Could not read site." }, 500);
  if (!site) return jsonResponse({ error: "Site not found." }, 404);

  const query = [site.address, site.city, site.state, site.postal_code].filter((p) => typeof p === "string" && p.trim()).join(", ");
  if (!query) return jsonResponse({ error: "Add an address to this site before enriching it." }, 422);

  await db.from("property_profiles").upsert({ site_id: siteId }, { onConflict: "site_id", ignoreDuplicates: true });
  const { data: profile, error: profileError } = await db
    .from("property_profiles")
    .select("id, latitude, longitude, country_code, census_geoid, geocoded_query, enrichment_status, last_enriched_at")
    .eq("site_id", siteId)
    .maybeSingle();
  if (profileError || !profile) return jsonResponse({ error: "Could not open property profile." }, 500);

  if (profile.last_enriched_at && Date.now() - new Date(profile.last_enriched_at).getTime() < COOLDOWN_MS && profile.enrichment_status !== "failed") {
    return jsonResponse({ error: "Recently refreshed. Try again in a moment.", retry_after_s: 30 }, 429);
  }

  // Atomic claim: only one run per profile at a time (stale locks expire).
  const staleIso = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  const { data: claimed, error: claimError } = await db
    .from("property_profiles")
    .update({ enrichment_status: "running" })
    .eq("id", profile.id)
    .or(`enrichment_status.neq.running,updated_at.lt.${staleIso}`)
    .select("id");
  if (claimError) return jsonResponse({ error: "Could not start enrichment." }, 500);
  if (!claimed?.length) return jsonResponse({ error: "Enrichment already running for this property." }, 409);

  const finish = async (status: "complete" | "partial" | "failed", patch: Json = {}) => {
    await db
      .from("property_profiles")
      .update({ ...patch, enrichment_status: status, last_enriched_at: new Date().toISOString() })
      .eq("id", profile.id);
  };

  try {
    // 1. Location
    let lat = profile.latitude as number | null;
    let lon = profile.longitude as number | null;
    let country = profile.country_code as string | null;
    let geoid = profile.census_geoid as string | null;
    const patch: Json = {};

    if (lat === null || lon === null || profile.geocoded_query !== query) {
      const point = await geocode(query);
      if (!point) {
        await finish("failed");
        return jsonResponse({ error: "Address could not be located. Check the street, city and postal code." }, 422);
      }
      lat = point.lat;
      lon = point.lon;
      country = point.country;
      geoid = null;
      Object.assign(patch, {
        latitude: lat,
        longitude: lon,
        country_code: country,
        normalized_address: point.display,
        geocoded_query: query,
        geocode_source: "nominatim.openstreetmap.org",
        geocode_confidence: point.confidence,
        census_geoid: null,
      });
    }

    if (country === "US" && !geoid && lat !== null && lon !== null) {
      try {
        geoid = await censusTract(lat, lon);
        if (geoid) patch.census_geoid = geoid;
      } catch (err) {
        log("property_intel_census_failed", { error: msg(err) });
      }
    }

    // 2. Provider layers in parallel
    const { data: existing } = await db.from("property_intel_layers").select("layer, status").eq("profile_id", profile.id);
    const existingByLayer = new Map((existing ?? []).map((r: { layer: string; status: string }) => [r.layer, r.status] as [string, string]));
    const toRun = requested.filter((l) => existingByLayer.get(l) !== "manual");

    const latN = lat as number;
    const lonN = lon as number;
    const jobs: Record<ProviderLayer, () => Promise<LayerResult>> = {
      climate: () => climateLayer(latN, lonN),
      hazards: () => hazardsLayer(latN, lonN, country),
      economic: () => economicLayer(geoid, country),
    };

    const settled = await Promise.allSettled(toRun.map((l) => jobs[l]()));
    const results: LayerResult[] = settled.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : { layer: toRun[i], status: "failed", data: {}, source: "provider", confidence: 0, as_of: null, error: msg(r.reason) },
    );

    // 3. Persist: never replace good data with a failure
    const nowIso = new Date().toISOString();
    const rows = results
      .filter((r) => (r.status === "ok" || r.status === "partial") || !existingByLayer.has(r.layer))
      .map((r) => ({
        profile_id: profile.id,
        layer: r.layer,
        status: r.status,
        data: r.data,
        source: r.source,
        confidence: r.confidence,
        as_of: r.as_of,
        fetched_at: nowIso,
        error: r.error,
      }));
    if (rows.length) {
      const { error: upsertError } = await db.from("property_intel_layers").upsert(rows, { onConflict: "profile_id,layer" });
      if (upsertError) throw new Error(`Layer save failed: ${upsertError.message}`);
    }

    const counted = results.filter((r) => r.status !== "unavailable");
    const okCount = counted.filter((r) => r.status === "ok").length;
    const anyUsable = results.some((r) => r.status === "ok" || r.status === "partial");
    const status = counted.length > 0 && okCount === counted.length ? "complete" : anyUsable ? "partial" : toRun.length === 0 ? "complete" : "failed";
    await finish(status, patch);

    log("property_intel_enriched", { site_id: siteId, status, layers: results.map((r) => `${r.layer}:${r.status}`) });
    return jsonResponse({
      status,
      layers: results.map((r) => ({ layer: r.layer, status: r.status, error: r.error })),
      skipped_manual: requested.filter((l) => existingByLayer.get(l) === "manual"),
    });
  } catch (err) {
    log("property_intel_enrich_failed", { site_id: siteId, error: msg(err) });
    await finish("failed");
    return jsonResponse({ error: "Enrichment failed. Please try again." }, 500);
  }
});
