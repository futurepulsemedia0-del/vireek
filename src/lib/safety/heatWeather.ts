// src/lib/safety/heatWeather.ts
//
// Fetches the current-hour air temperature and relative humidity for a US ZIP, using the same free, keyless sources as
// supabase/functions/weather-surge-check (Zippopotam.us for ZIP -> lat/lon, api.weather.gov for weather).
// The value is the NWS hourly FORECAST for the current hour, not a sensor observation, and the UI says so.
// The heat index itself is computed by the caller with ./heat.ts (kept separate so this file has no local imports and
// loads unchanged in both Vite and Deno).
// `fetchFn` is injectable so tests never touch the network.
//
// [VERIFY] Response shapes follow the public api.weather.gov docs (points -> forecastHourly -> periods[].temperature,
// temperatureUnit, relativeHumidity.value). Re-check against a live call before enabling in production.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface WeatherReading {
  tempF: number;
  rhPct: number;
  /** Start of the forecast hour the reading describes. */
  observedAt: Date;
  source: 'nws_hourly_forecast';
}

export type WeatherResult =
  | { ok: true; reading: WeatherReading }
  | { ok: false; error: 'bad_zip' | 'geocode_failed' | 'points_failed' | 'forecast_failed' | 'no_humidity' | 'timeout' };

const USER_AGENT = 'Vireek Dashboard (safety-heat-tick, support@vireek.com)';
const TIMEOUT_MS = 10_000;

async function getJson(fetchFn: FetchFn, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return await res.json();
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function fetchHeatReading(zip: string, fetchFn: FetchFn = fetch, now: Date = new Date()): Promise<WeatherResult> {
  if (!/^[0-9]{5}$/.test(zip)) return { ok: false, error: 'bad_zip' };
  const timedOut = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

  let lat: number | null = null;
  let lon: number | null = null;
  try {
    const g = (await getJson(fetchFn, `https://api.zippopotam.us/us/${encodeURIComponent(zip)}`)) as { places?: Array<{ latitude?: unknown; longitude?: unknown }> };
    lat = num(g.places?.[0]?.latitude);
    lon = num(g.places?.[0]?.longitude);
  } catch (e) {
    return { ok: false, error: timedOut(e) ? 'timeout' : 'geocode_failed' };
  }
  if (lat === null || lon === null) return { ok: false, error: 'geocode_failed' };

  const nwsHeaders = { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' };
  let hourlyUrl: string | null = null;
  try {
    const p = (await getJson(fetchFn, `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, nwsHeaders)) as { properties?: { forecastHourly?: unknown } };
    const u = p.properties?.forecastHourly;
    // Only follow links that stay on api.weather.gov: the URL comes from a response body.
    if (typeof u === 'string' && /^https:\/\/api\.weather\.gov\//.test(u)) hourlyUrl = u;
  } catch (e) {
    return { ok: false, error: timedOut(e) ? 'timeout' : 'points_failed' };
  }
  if (!hourlyUrl) return { ok: false, error: 'points_failed' };

  try {
    const f = (await getJson(fetchFn, hourlyUrl, nwsHeaders)) as {
      properties?: { periods?: Array<{ startTime?: unknown; endTime?: unknown; temperature?: unknown; temperatureUnit?: unknown; relativeHumidity?: { value?: unknown } }> };
    };
    const periods = f.properties?.periods ?? [];
    const t = now.getTime();
    // The period that contains "now"; fall back to the first one only if none matches (forecast just rolled over).
    const cur = periods.find((p) => {
      const s = typeof p.startTime === 'string' ? Date.parse(p.startTime) : NaN;
      const e = typeof p.endTime === 'string' ? Date.parse(p.endTime) : NaN;
      return Number.isFinite(s) && Number.isFinite(e) && s <= t && t < e;
    }) ?? periods[0];
    if (!cur) return { ok: false, error: 'forecast_failed' };
    const rawT = num(cur.temperature);
    const rh = num(cur.relativeHumidity?.value);
    if (rawT === null) return { ok: false, error: 'forecast_failed' };
    if (rh === null) return { ok: false, error: 'no_humidity' };
    const tempF = cur.temperatureUnit === 'C' ? rawT * 1.8 + 32 : rawT;
    const startMs = typeof cur.startTime === 'string' ? Date.parse(cur.startTime) : NaN;
    const observedAt = Number.isFinite(startMs) ? new Date(startMs) : now;
    return { ok: true, reading: { tempF, rhPct: rh, observedAt, source: 'nws_hourly_forecast' } };
  } catch (e) {
    return { ok: false, error: timedOut(e) ? 'timeout' : 'forecast_failed' };
  }
}
