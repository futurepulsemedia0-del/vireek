// Provider adapters for the Property Intelligence Graph.
//
// Each adapter: fixed host (no user-controlled URLs → no SSRF), hard timeout, defensive parsing,
// generic error messages (API keys travel in headers/query and must never reach a log line or the UI).
//
//   census         US Census Geocoder     keyless    address -> coordinates, FIPS, tract
//   rentcast       RentCast /v1/properties  key       parcel facts: APN, year built, sq ft, lot, systems
//   attom_permits  ATTOM building permits   key       permit history (counties that publish permits)
//   nasa_power     NASA POWER climatology   keyless    30-yr monthly mean temperature -> degree days
//   eia            EIA API v2 retail sales  key       state residential electricity price
//
// Deliberately NOT mapped from any vendor: owner names, sale prices, tax/assessed values.

import type {
  ClimateFacts,
  EnergyFacts,
  GeoFacts,
  ParcelFacts,
  PermitFact,
  ProviderReport,
} from "./types.ts";
import { parseMatchedAddress } from "./address.ts";
import { classifyPermit, climateFromMonthly } from "./scoring.ts";

export interface ProviderResult<T> {
  report: ProviderReport;
  data: T | null;
}

const USER_AGENT = "Vireek Property Intelligence (support@vireek.com)";
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// ---------- tiny safe-parsing helpers ----------

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() ? v.trim() : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}
function num(v: unknown): number | null {
  if (typeof v === "string" && v.trim() === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function dateOnly(v: string | null): string | null {
  const m = v?.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
function positiveInt(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 ? Math.round(n) : null;
}

// ---------- HTTP ----------

class ProviderError extends Error {
  constructor(readonly kind: "auth" | "timeout" | "network" | "http" | "parse", message: string) {
    super(message);
  }
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new ProviderError("timeout", "Provider timed out.");
    throw new ProviderError("network", "Provider could not be reached.");
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError("auth", "Provider rejected the API key or plan.");
  if (res.status === 404) return null;
  if (res.status === 429) throw new ProviderError("http", "Provider rate limit reached.");
  if (!res.ok) throw new ProviderError("http", `Provider returned HTTP ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new ProviderError("parse", "Provider returned an unreadable response.");
  }
}

async function run<T>(fn: () => Promise<T | null>): Promise<ProviderResult<T>> {
  const started = Date.now();
  const fetched_at = new Date().toISOString();
  try {
    const data = await fn();
    return { data, report: { state: data === null ? "no_data" : "ok", fetched_at, latency_ms: Date.now() - started } };
  } catch (err) {
    const message = err instanceof ProviderError ? err.message : "Unexpected provider failure.";
    return { data: null, report: { state: "error", message, fetched_at, latency_ms: Date.now() - started } };
  }
}

export function skipped<T>(message: string): ProviderResult<T> {
  return { data: null, report: { state: "skipped", message } };
}

// ---------- 1. US Census Geocoder (keyless) ----------

function firstGeography(geographies: Record<string, unknown>, keyPattern: RegExp): Record<string, unknown> {
  for (const [key, value] of Object.entries(geographies)) {
    if (keyPattern.test(key)) return rec(arr(value)[0]);
  }
  return {};
}

export function geocodeCensus(addressLine: string, timeoutMs: number): Promise<ProviderResult<GeoFacts>> {
  return run(async () => {
    const url =
      "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress" +
      `?address=${encodeURIComponent(addressLine)}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`;
    const body = await getJson(url, {}, timeoutMs);
    const match = rec(arr(rec(rec(body).result).addressMatches)[0]);
    const lon = num(rec(match.coordinates).x);
    const lat = num(rec(match.coordinates).y);
    if (lat === null || lon === null) return null;

    const matched = str(match.matchedAddress) ?? addressLine;
    const parsed = parseMatchedAddress(matched);
    const geographies = rec(match.geographies);
    const tract = firstGeography(geographies, /tract/i);
    const county = firstGeography(geographies, /count(y|ies)/i);

    return {
      formatted_address: matched,
      latitude: lat,
      longitude: lon,
      state_fips: str(tract.STATE) ?? str(county.STATE),
      county_fips: str(tract.COUNTY) ?? str(county.COUNTY),
      census_tract: str(tract.TRACT),
      street1: parsed.street1,
      city: parsed.city,
      state: parsed.state,
      zip: parsed.zip,
    };
  });
}

// ---------- 2. RentCast property records (key) ----------

export function fetchRentcastParcel(
  addressLine: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<ProviderResult<ParcelFacts>> {
  if (!apiKey) return Promise.resolve(skipped("Parcel data provider not connected (set RENTCAST_API_KEY)."));
  return run(async () => {
    const body = await getJson(
      `https://api.rentcast.io/v1/properties?address=${encodeURIComponent(addressLine)}`,
      { "X-Api-Key": apiKey },
      timeoutMs,
    );
    const p = rec(arr(body)[0]);
    if (Object.keys(p).length === 0) return null;
    const features = rec(p.features);

    const yearBuilt = positiveInt(p.yearBuilt);
    return {
      formatted_address: str(p.formattedAddress),
      latitude: num(p.latitude),
      longitude: num(p.longitude),
      state_fips: str(p.stateFips),
      county_fips: str(p.countyFips),
      apn: str(p.assessorID),
      property_type: str(p.propertyType),
      year_built: yearBuilt !== null && yearBuilt >= 1600 && yearBuilt <= 2200 ? yearBuilt : null,
      living_sqft: positiveInt(p.squareFootage),
      lot_sqft: positiveInt(p.lotSize),
      bedrooms: num(p.bedrooms),
      bathrooms: num(p.bathrooms),
      stories: num(features.floorCount),
      heating_type: str(features.heatingType),
      cooling_type: str(features.coolingType),
      has_heating: bool(features.heating),
      has_cooling: bool(features.cooling),
      last_sale_date: dateOnly(str(p.lastSaleDate)),
    };
  });
}

// ---------- 3. ATTOM building permits (key) ----------

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  return undefined;
}

export function fetchAttomPermits(
  address1: string,
  address2: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<ProviderResult<PermitFact[]>> {
  if (!apiKey) return Promise.resolve(skipped("Permit provider not connected (set ATTOM_API_KEY)."));
  return run(async () => {
    const url =
      "https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/buildingpermits" +
      `?address1=${encodeURIComponent(address1)}&address2=${encodeURIComponent(address2)}`;
    const body = await getJson(url, { apikey: apiKey }, timeoutMs);
    const property = rec(arr(rec(body).property)[0]);
    if (Object.keys(property).length === 0) return null; // address not matched (≠ zero permits)

    const permits: PermitFact[] = [];
    for (const raw of arr(property.buildingPermits)) {
      const row = rec(raw);
      const permitNumber = str(pick(row, "permitNumber", "permitnumber"));
      const issued = dateOnly(str(pick(row, "effectiveDate", "effectivedate")));
      const type = str(row.type);
      const subType = str(pick(row, "subType", "subtype"));
      const description = str(row.description);
      const recordId = permitNumber ?? `${issued ?? "undated"}|${(description ?? type ?? "permit").slice(0, 40)}`;
      permits.push({
        source: "attom",
        source_record_id: recordId,
        permit_number: permitNumber,
        permit_type: [type, subType].filter(Boolean).join(" / ") || null,
        work_category: classifyPermit([type, subType, description, permitNumber]),
        status: str(row.status),
        description: description ? description.slice(0, 300) : null,
        issued_date: issued,
      });
    }
    return permits;
  });
}

// ---------- 4. NASA POWER climatology (keyless) ----------

export function fetchNasaClimate(
  latitude: number,
  longitude: number,
  timeoutMs: number,
): Promise<ProviderResult<ClimateFacts>> {
  return run(async () => {
    const url =
      "https://power.larc.nasa.gov/api/temporal/climatology/point" +
      `?parameters=T2M&community=SB&longitude=${longitude.toFixed(4)}&latitude=${latitude.toFixed(4)}&format=JSON`;
    const body = await getJson(url, {}, timeoutMs);
    const t2m = rec(rec(rec(rec(body).properties).parameter).T2M);
    const monthly = MONTHS.map((m) => num(t2m[m]));
    if (monthly.some((v) => v === null || v <= -900)) return null; // POWER uses -999 for missing
    return climateFromMonthly(monthly as number[], num(t2m.ANN));
  });
}

// ---------- 5. EIA residential electricity price by state (key) ----------

export function fetchEiaResidentialPrice(
  stateAbbr: string | null,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<ProviderResult<EnergyFacts>> {
  if (!apiKey) return Promise.resolve(skipped("Energy price provider not connected (set EIA_API_KEY)."));
  const state = (stateAbbr ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) return Promise.resolve(skipped("State unknown — cannot look up electricity price."));
  return run(async () => {
    const params = new URLSearchParams();
    params.set("api_key", apiKey);
    params.set("frequency", "monthly");
    params.set("data[0]", "price");
    params.append("facets[stateid][]", state);
    params.append("facets[sectorid][]", "RES");
    params.set("sort[0][column]", "period");
    params.set("sort[0][direction]", "desc");
    params.set("length", "12");
    const body = await getJson(`https://api.eia.gov/v2/electricity/retail-sales/data/?${params.toString()}`, {}, timeoutMs);
    const rows = arr(rec(rec(body).response).data).map(rec);
    const prices = rows.map((r) => num(r.price)).filter((v): v is number => v !== null);
    if (prices.length === 0) return null;
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    return {
      source: "eia",
      state,
      residential_cents_per_kwh: Math.round(prices[0] * 100) / 100,
      residential_cents_per_kwh_12m_avg: Math.round(avg * 100) / 100,
      period: str(rows[0]?.period),
    };
  });
}
