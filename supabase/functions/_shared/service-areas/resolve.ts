// Deno port of the pure functions in src/lib/serviceAreas.ts (normalize,
// extract, point-in-polygon, resolve, quote) plus the server-only pieces the
// Vapi webhook needs: loading a tenant's zones, geocoding on demand, and
// picking the best in-area technician.
// KEEP IN SYNC with src/lib/serviceAreas.ts — src/lib/serviceAreasParity.test.ts
// runs both against the same cases and fails if they drift.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export type LatLng = [number, number];
export type OutOfAreaMode = "decline" | "waitlist" | "transfer";

export interface ServiceAreaRow {
  id: string;
  name: string;
  zone_type: "zip" | "polygon";
  zip_codes: string[];
  polygon: LatLng[] | null;
  is_active: boolean;
  priority: number;
  travel_fee_cents: number;
  surge_enabled: boolean;
  surge_multiplier: number;
  surge_ends_at: string | null;
  created_at: string;
}

export interface AreaTechnicianRow {
  area_id: string;
  technician_id: string;
  is_primary: boolean;
}

export interface ServiceAreaSettingsRow {
  out_of_area_mode: OutOfAreaMode;
  out_of_area_message: string | null;
}

export const DEFAULT_OUT_OF_AREA_MESSAGES: Record<OutOfAreaMode, string> = {
  decline:
    "I'm sorry — that address is outside the area we currently serve, so I can't book it. I'd be happy to help if you have another address within our service area.",
  waitlist:
    "That address is just outside our current service area. I can take your name and number and add you to our waitlist — we'll reach out if we expand to your neighborhood.",
  transfer:
    "That address is outside our standard service area, so let me connect you with a team member who can tell you whether we can make an exception.",
};

const US_ZIP = /^\d{5}(?:-?\d{4})?$/;
const CA_POSTAL = /^[A-Z]\d[A-Z][ -]?\d[A-Z]\d$/;
const CA_FSA = /^[A-Z]\d[A-Z]$/;

export function normalizePostalCode(input: string): string | null {
  const raw = input.trim().toUpperCase();
  if (US_ZIP.test(raw)) return raw.slice(0, 5);
  if (CA_POSTAL.test(raw)) return raw.replace(/[ -]/g, "");
  if (CA_FSA.test(raw)) return raw;
  return null;
}

export function extractPostalCode(address: string | null | undefined): string | null {
  if (!address) return null;
  const upper = address.toUpperCase();
  const ca = [...upper.matchAll(/\b([A-Z]\d[A-Z])[ -]?(\d[A-Z]\d)\b/g)];
  if (ca.length > 0) {
    const m = ca[ca.length - 1];
    return `${m[1]}${m[2]}`;
  }
  const us = [...upper.matchAll(/(?<!\d)(\d{5})(?:-\d{4})?(?!\d)/g)];
  if (us.length > 0) return us[us.length - 1][1];
  return null;
}

function zipEntryMatches(entry: string, code: string): boolean {
  if (entry === code) return true;
  return entry.length === 3 && CA_FSA.test(entry) && code.startsWith(entry);
}

function isValidLatLng(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export function pointInPolygon(lat: number, lng: number, polygon: LatLng[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [latI, lngI] = polygon[i];
    const [latJ, lngJ] = polygon[j];
    const crosses = lngI > lng !== lngJ > lng && lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI;
    if (crosses) inside = !inside;
  }
  return inside;
}

export type ResolveResult =
  | { status: "in_area"; area: ServiceAreaRow; alsoMatched: ServiceAreaRow[] }
  | { status: "out_of_area" }
  | { status: "unknown" }
  | { status: "no_areas_configured" };

function compareAreas(a: ServiceAreaRow, b: ServiceAreaRow): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  const byDate = a.created_at.localeCompare(b.created_at);
  if (byDate !== 0) return byDate;
  return a.id.localeCompare(b.id);
}

export function resolveServiceArea(
  areas: ServiceAreaRow[],
  query: { postalCode?: string | null; latitude?: number | null; longitude?: number | null },
): ResolveResult {
  const active = areas.filter((a) => a.is_active);
  if (active.length === 0) return { status: "no_areas_configured" };

  const code = query.postalCode ? normalizePostalCode(query.postalCode) : null;
  const hasPoint =
    typeof query.latitude === "number" &&
    typeof query.longitude === "number" &&
    isValidLatLng(query.latitude, query.longitude);

  const hasZip = active.some((a) => a.zone_type === "zip");
  const hasPolygon = active.some((a) => a.zone_type === "polygon");
  const zipCheckable = !hasZip || code !== null;
  const polygonCheckable = !hasPolygon || hasPoint;

  const matches = active.filter((a) => {
    if (a.zone_type === "zip") return code !== null && a.zip_codes.some((z) => zipEntryMatches(z, code));
    return hasPoint && !!a.polygon && pointInPolygon(query.latitude as number, query.longitude as number, a.polygon);
  });

  if (matches.length > 0) {
    const sorted = [...matches].sort(compareAreas);
    return { status: "in_area", area: sorted[0], alsoMatched: sorted.slice(1) };
  }
  if (zipCheckable && polygonCheckable) return { status: "out_of_area" };
  return { status: "unknown" };
}

export function isSurgeActive(
  area: Pick<ServiceAreaRow, "surge_enabled" | "surge_multiplier" | "surge_ends_at">,
  now: Date = new Date(),
): boolean {
  if (!area.surge_enabled || area.surge_multiplier <= 1) return false;
  if (!area.surge_ends_at) return true;
  return new Date(area.surge_ends_at).getTime() > now.getTime();
}

export interface AreaQuote {
  baseCents: number;
  surgeMultiplier: number;
  surgeApplied: boolean;
  surgeAmountCents: number;
  travelFeeCents: number;
  totalCents: number;
}

export function computeAreaQuote(area: ServiceAreaRow, baseCents: number, now: Date = new Date()): AreaQuote {
  const base = Math.max(0, Math.round(baseCents));
  const surgeApplied = isSurgeActive(area, now);
  const multiplier = surgeApplied ? area.surge_multiplier : 1;
  const surged = Math.round(base * multiplier);
  const travel = Math.max(0, Math.round(area.travel_fee_cents));
  return {
    baseCents: base,
    surgeMultiplier: multiplier,
    surgeApplied,
    surgeAmountCents: surged - base,
    travelFeeCents: travel,
    totalCents: surged + travel,
  };
}

export function outOfAreaReply(settings: ServiceAreaSettingsRow | null): string {
  const mode = settings?.out_of_area_mode ?? "waitlist";
  return settings?.out_of_area_message?.trim() || DEFAULT_OUT_OF_AREA_MESSAGES[mode];
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Server-only helpers
// ---------------------------------------------------------------------------

export interface TenantServiceAreas {
  areas: ServiceAreaRow[];
  assignments: AreaTechnicianRow[];
  settings: ServiceAreaSettingsRow | null;
}

const AREA_COLUMNS =
  "id, name, zone_type, zip_codes, polygon, is_active, priority, travel_fee_cents, surge_enabled, surge_multiplier, surge_ends_at, created_at";

/** Loads a tenant's zones. Any failure resolves to "no zones" so a database hiccup can never block a booking. */
export async function loadTenantServiceAreas(admin: SupabaseClient, userId: string): Promise<TenantServiceAreas> {
  try {
    const [areasRes, assignRes, settingsRes] = await Promise.all([
      admin.from("service_areas").select(AREA_COLUMNS).eq("user_id", userId).eq("is_active", true),
      admin.from("service_area_technicians").select("area_id, technician_id, is_primary").eq("user_id", userId),
      admin.from("service_area_settings").select("out_of_area_mode, out_of_area_message").eq("user_id", userId).maybeSingle(),
    ]);
    if (areasRes.error) throw areasRes.error;
    return {
      areas: (areasRes.data as ServiceAreaRow[] | null) ?? [],
      assignments: (assignRes.data as AreaTechnicianRow[] | null) ?? [],
      settings: (settingsRes.data as ServiceAreaSettingsRow | null) ?? null,
    };
  } catch (error) {
    console.error(JSON.stringify({ event: "service_areas_load_failed", error: error instanceof Error ? error.message : String(error) }));
    return { areas: [], assignments: [], settings: null };
  }
}

const GEOCODE_UA = "Vireek Dashboard (vapi-webhook service-areas, support@vireek.com)";

async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
    const res = await fetch(url, { headers: { "User-Agent": GEOCODE_UA }, signal: AbortSignal.timeout(3500) });
    if (!res.ok) return null;
    const data = await res.json();
    const hit = Array.isArray(data) ? data[0] : null;
    const lat = Number(hit?.lat);
    const lng = Number(hit?.lon);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  } catch {
    return null;
  }
}

/**
 * Resolves an address against the tenant's zones. ZIP match first (free);
 * geocodes only when polygon zones exist and the ZIP check did not decide.
 * "unknown" is returned whenever we could not check — callers must fail OPEN.
 */
export async function evaluateAddress(tenant: TenantServiceAreas, address: string | null | undefined): Promise<ResolveResult> {
  const postalCode = extractPostalCode(address);
  let result = resolveServiceArea(tenant.areas, { postalCode });
  if (result.status === "in_area" || result.status === "no_areas_configured") return result;

  const hasPolygon = tenant.areas.some((a) => a.is_active && a.zone_type === "polygon");
  if (hasPolygon && address && address.trim().length >= 5) {
    const point = await geocodeAddress(address);
    if (point) result = resolveServiceArea(tenant.areas, { postalCode, latitude: point.lat, longitude: point.lng });
  }
  return result;
}

export interface AreaCandidate {
  technicianId: string;
  isPrimary: boolean;
}

/** Technicians covering an area, primary first. */
export function areaTechnicians(tenant: TenantServiceAreas, areaId: string): AreaCandidate[] {
  return tenant.assignments
    .filter((a) => a.area_id === areaId)
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
    .map((a) => ({ technicianId: a.technician_id, isPrimary: a.is_primary }));
}

/**
 * Picks the covering technician with spare capacity on the job's day:
 * primary first, then least-loaded. Returns null when nobody covering the
 * area is free — the caller then falls back to the normal AI dispatcher.
 */
export async function pickAreaTechnician(
  admin: SupabaseClient,
  userId: string,
  candidates: AreaCandidate[],
  scheduledDatetime: string | null,
): Promise<string | null> {
  if (candidates.length === 0) return null;
  const ids = candidates.map((c) => c.technicianId);
  const primary = new Set(candidates.filter((c) => c.isPrimary).map((c) => c.technicianId));
  try {
    const { data: techs } = await admin
      .from("team_members")
      .select("id, max_jobs_per_day")
      .eq("account_owner_id", userId)
      .eq("role", "technician")
      .eq("invite_status", "active")
      .eq("dispatch_enabled", true)
      .in("id", ids);
    if (!techs || techs.length === 0) return null;

    const day = new Date(scheduledDatetime ?? Date.now());
    day.setUTCHours(0, 0, 0, 0);
    const next = new Date(day);
    next.setUTCDate(next.getUTCDate() + 1);

    const { data: jobs } = await admin
      .from("jobs")
      .select("assigned_technician_id")
      .eq("user_id", userId)
      .in("assigned_technician_id", ids)
      .in("job_status", ["scheduled", "en_route", "in_progress"])
      .gte("scheduled_datetime", day.toISOString())
      .lt("scheduled_datetime", next.toISOString());

    const load = new Map<string, number>();
    (jobs ?? []).forEach((j: { assigned_technician_id: string | null }) => {
      if (j.assigned_technician_id) load.set(j.assigned_technician_id, (load.get(j.assigned_technician_id) ?? 0) + 1);
    });

    const free = (techs as { id: string; max_jobs_per_day: number | null }[])
      .filter((t) => (load.get(t.id) ?? 0) < (t.max_jobs_per_day ?? 6))
      .sort((a, b) => {
        const aRank = primary.has(a.id) ? 0 : 1;
        const bRank = primary.has(b.id) ? 0 : 1;
        if (aRank !== bRank) return aRank - bRank;
        return (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0);
      });
    return free[0]?.id ?? null;
  } catch {
    return null;
  }
}
