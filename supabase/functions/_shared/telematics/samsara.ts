// Minimal Samsara REST client + defensive parsers. Docs: developers.samsara.com
//  GET /fleet/vehicles                     -> list vehicles (id, name, vin)
//  GET /fleet/vehicles/stats?types=a,b,c   -> last-known snapshot (max 3 types per call)
// Every field is parsed defensively: a missing/renamed field degrades to null, never throws.

import type { IncomingFix } from "./ingest.ts";

const BASE = "https://api.samsara.com";
const TIMEOUT_MS = 12_000;
const METERS_PER_MILE = 1609.344;

export class SamsaraError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- third-party payload, parsed defensively below

async function samsaraGet(path: string, token: string): Promise<Json> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new SamsaraError(res.status === 401 || res.status === 403 ? "Samsara rejected the API token." : `Samsara API error (${res.status}) ${text}`, res.status);
  }
  return res.json();
}

async function paged(path: string, token: string, maxPages = 20): Promise<Json[]> {
  const out: Json[] = [];
  let after = "";
  for (let i = 0; i < maxPages; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const body = await samsaraGet(`${path}${after ? `${sep}after=${encodeURIComponent(after)}` : ""}`, token);
    if (Array.isArray(body?.data)) out.push(...body.data);
    if (!body?.pagination?.hasNextPage || !body?.pagination?.endCursor) break;
    after = body.pagination.endCursor;
  }
  return out;
}

export interface SamsaraVehicle { id: string; name: string; vin: string | null }

export async function listVehicles(token: string): Promise<SamsaraVehicle[]> {
  const rows = await paged("/fleet/vehicles", token);
  return rows
    .filter((r) => r && r.id != null)
    .map((r) => ({ id: String(r.id), name: String(r.name ?? r.id), vin: r.vin ? String(r.vin) : null }));
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ts = (v: unknown): number | null => { const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : t; };

function engineOf(v: unknown): IncomingFix["engine"] {
  const s = String(v ?? "").toLowerCase();
  return s === "on" ? "on" : s === "off" ? "off" : s === "idle" ? "idle" : "unknown";
}

export interface SamsaraSnapshot { externalId: string; fix: IncomingFix | null }

/** Two calls (Samsara allows <=3 stat types each) merged per vehicle. */
export async function fetchSnapshots(token: string): Promise<SamsaraSnapshot[]> {
  const [a, b] = await Promise.all([
    paged("/fleet/vehicles/stats?types=gps,engineStates,obdOdometerMeters", token),
    paged("/fleet/vehicles/stats?types=fuelPercents,obdEngineSeconds", token).catch(() => [] as Json[]),
  ]);
  const extra = new Map<string, Json>(b.map((r) => [String(r.id), r]));
  return a.filter((r) => r?.id != null).map((r) => {
    const e = extra.get(String(r.id)) ?? {};
    // Snapshot responses use singular keys (gps, engineState, obdOdometerMeters, fuelPercent, obdEngineSeconds).
    const gps = r.gps ?? null;
    const lat = num(gps?.latitude);
    const lng = num(gps?.longitude);
    const t = ts(gps?.time);
    if (lat == null || lng == null || t == null) return { externalId: String(r.id), fix: null };
    const odo = num(r.obdOdometerMeters?.value);
    const secs = num(e.obdEngineSeconds?.value);
    const fuel = num(e.fuelPercent?.value);
    return {
      externalId: String(r.id),
      fix: {
        t, lat, lng,
        speedMph: num(gps?.speedMilesPerHour),
        headingDeg: num(gps?.headingDegrees),
        engine: engineOf(r.engineState?.value),
        odometerMiles: odo != null ? odo / METERS_PER_MILE : null,
        engineHours: secs != null ? secs / 3600 : null,
        fuelPct: fuel,
        reverseGeo: typeof gps?.reverseGeo?.formattedLocation === "string" ? gps.reverseGeo.formattedLocation : null,
      },
    };
  });
}
