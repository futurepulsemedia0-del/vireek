/**
 * Service Areas — client library.
 *
 * Zip/postal and polygon zones with travel fees, surge multipliers,
 * technician coverage and the out-of-area AI reply policy.
 *
 * Split (same as the rest of the app): everything pure (geometry, matching,
 * pricing, validation) lives here and is unit-tested; everything that touches
 * the network goes through Supabase with RLS enforcing the tenant boundary.
 *
 * Every query is ALSO scoped explicitly by `accountOwnerId` (never the
 * logged-in user's own id — for a team member those differ). RLS is the real
 * wall; the explicit filter keeps queries index-friendly and makes a missing
 * owner id fail loudly instead of silently returning another scope.
 *
 * KEEP IN SYNC: supabase/functions/_shared/service-areas/resolve.ts is a Deno
 * port of the pure functions below (normalizePostalCode, extractPostalCode,
 * pointInPolygon, resolveServiceArea, computeAreaQuote).
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type ZoneType = 'zip' | 'polygon';
export type OutOfAreaMode = 'decline' | 'waitlist' | 'transfer';
/** [latitude, longitude] */
export type LatLng = [number, number];

export interface ServiceArea {
  id: string;
  user_id: string;
  name: string;
  color: string;
  zone_type: ZoneType;
  zip_codes: string[];
  polygon: LatLng[] | null;
  is_active: boolean;
  priority: number;
  travel_fee_cents: number;
  surge_enabled: boolean;
  surge_multiplier: number;
  surge_ends_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface AreaTechnician {
  area_id: string;
  technician_id: string;
  user_id: string;
  is_primary: boolean;
}

export interface ServiceAreaSettings {
  user_id: string;
  out_of_area_mode: OutOfAreaMode;
  out_of_area_message: string | null;
}

export interface ServiceAreaInput {
  id?: string;
  name: string;
  color: string;
  zoneType: ZoneType;
  zipCodes: string[];
  polygon: LatLng[] | null;
  isActive: boolean;
  priority: number;
  travelFeeCents: number;
  surgeEnabled: boolean;
  surgeMultiplier: number;
  surgeEndsAt: string | null;
  notes: string | null;
  technicians: { technicianId: string; isPrimary: boolean }[];
}

export const MAX_ZIP_CODES = 2000;
export const MAX_POLYGON_POINTS = 500;
export const MAX_TRAVEL_FEE_CENTS = 1_000_000;
export const MIN_SURGE = 1;
export const MAX_SURGE = 5;
export const AREA_COLORS = [
  '#3b82f6',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
];

export const DEFAULT_OUT_OF_AREA_MESSAGES: Record<OutOfAreaMode, string> = {
  decline:
    "I'm sorry — that address is outside the area we currently serve, so I can't book it. I'd be happy to help if you have another address within our service area.",
  waitlist:
    "That address is just outside our current service area. I can take your name and number and add you to our waitlist — we'll reach out if we expand to your neighborhood.",
  transfer:
    'That address is outside our standard service area, so let me connect you with a team member who can tell you whether we can make an exception.',
};

// ============================================================
// POSTAL CODES
// ============================================================

const US_ZIP = /^\d{5}(?:-?\d{4})?$/;
const CA_POSTAL = /^[A-Z]\d[A-Z][ -]?\d[A-Z]\d$/;
const CA_FSA = /^[A-Z]\d[A-Z]$/;

/** Normalizes a US ZIP / ZIP+4 (→ 5 digits) or Canadian postal code / FSA (→ upper, no spaces). Returns null when it isn't a recognizable code. */
export function normalizePostalCode(input: string): string | null {
  const raw = input.trim().toUpperCase();
  if (US_ZIP.test(raw)) return raw.slice(0, 5);
  if (CA_POSTAL.test(raw)) return raw.replace(/[ -]/g, '');
  if (CA_FSA.test(raw)) return raw;
  return null;
}

const CODE_SCAN =
  /(?<![A-Z0-9])(?:[A-Z]\d[A-Z][ -]?\d[A-Z]\d|\d{5}(?:-\d{4})?|[A-Z]\d[A-Z])(?![A-Z0-9])/gi;

/** Splits free text (commas, spaces, newlines, semicolons) into unique normalized codes, reporting what it couldn't parse. A Canadian code may contain a space ("K1A 0B1"); US zips may be space-separated. */
export function parsePostalCodeList(text: string): { codes: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const invalid: string[] = [];
  const tokens = text
    .split(/[\n,;\t]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  for (const token of tokens) {
    for (const match of token.matchAll(CODE_SCAN)) {
      const normalized = normalizePostalCode(match[0]);
      if (normalized) seen.add(normalized);
    }
    const leftover = token.replace(CODE_SCAN, ' ').split(/\s+/).filter(Boolean);
    invalid.push(...leftover);
  }
  return { codes: [...seen], invalid };
}

/** Pulls the postal code out of a free-form address (last match wins — street numbers can look like zips). */
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
  // 3-character entries are Canadian FSAs and cover every code under them.
  return entry.length === 3 && CA_FSA.test(entry) && code.startsWith(entry);
}

// ============================================================
// POLYGONS
// ============================================================

function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export interface PolygonParseResult {
  polygon: LatLng[] | null;
  error: string | null;
}

/**
 * Accepts either "lat, lng" lines or a GeoJSON Polygon / Feature (GeoJSON is
 * [lng, lat] — flipped here). Strips a closing point that repeats the first.
 */
export function parsePolygonInput(text: string): PolygonParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { polygon: null, error: 'Add at least 3 points.' };

  let points: LatLng[] = [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { polygon: null, error: 'That looks like JSON but could not be parsed.' };
    }
    const obj = parsed as {
      type?: string;
      geometry?: { type?: string; coordinates?: unknown };
      coordinates?: unknown;
    };
    const geometry = obj?.type === 'Feature' ? obj.geometry : obj;
    const coords = (geometry as { coordinates?: unknown } | undefined)?.coordinates;
    if (!Array.isArray(coords) || !Array.isArray(coords[0])) {
      return {
        polygon: null,
        error: 'Only a GeoJSON Polygon (or Feature containing one) is supported.',
      };
    }
    const ring = coords[0] as unknown[];
    for (const pair of ring) {
      if (!Array.isArray(pair) || pair.length < 2)
        return { polygon: null, error: 'Invalid coordinate in GeoJSON ring.' };
      points.push([Number(pair[1]), Number(pair[0])]);
    }
  } else {
    const lines = trimmed
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = 0; i < lines.length; i += 1) {
      const nums = lines[i]
        .split(/[\s,;]+/)
        .filter(Boolean)
        .map(Number);
      if (nums.length !== 2 || nums.some((n) => !Number.isFinite(n))) {
        return { polygon: null, error: `Line ${i + 1} must be "latitude, longitude".` };
      }
      points.push([nums[0], nums[1]]);
    }
  }

  for (const [lat, lng] of points) {
    if (!isValidLatLng(lat, lng))
      return { polygon: null, error: 'Latitude must be −90…90 and longitude −180…180.' };
  }

  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) points = points.slice(0, -1);
  }

  const distinct = new Set(points.map((p) => `${p[0]},${p[1]}`));
  if (distinct.size < 3)
    return { polygon: null, error: 'A polygon needs at least 3 distinct points.' };
  if (points.length > MAX_POLYGON_POINTS)
    return { polygon: null, error: `Polygons are limited to ${MAX_POLYGON_POINTS} points.` };

  return { polygon: points, error: null };
}

export function polygonToText(polygon: LatLng[] | null): string {
  return (polygon ?? []).map(([lat, lng]) => `${lat}, ${lng}`).join('\n');
}

/** Ray-casting point-in-polygon. Polygon points are [lat, lng]; fine for service-area scale (no antimeridian crossing). */
export function pointInPolygon(lat: number, lng: number, polygon: LatLng[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [latI, lngI] = polygon[i];
    const [latJ, lngJ] = polygon[j];
    const crosses =
      lngI > lng !== lngJ > lng && lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI;
    if (crosses) inside = !inside;
  }
  return inside;
}

// ============================================================
// RESOLUTION
// ============================================================

export interface ResolveQuery {
  postalCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export type ResolveResult =
  /** Matched at least one active zone. `area` is the winner (highest priority). */
  | { status: 'in_area'; area: ServiceArea; alsoMatched: ServiceArea[] }
  /** Enough location info to be sure the point is in NO active zone. */
  | { status: 'out_of_area' }
  /** Not enough location info to decide (e.g. no postal code and only polygon zones with no coordinates). Callers must NOT reject on this. */
  | { status: 'unknown' }
  /** The account has no active zones — feature is effectively off, nothing is restricted. */
  | { status: 'no_areas_configured' };

function compareAreas(a: ServiceArea, b: ServiceArea): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  const byDate = a.created_at.localeCompare(b.created_at);
  if (byDate !== 0) return byDate;
  return a.id.localeCompare(b.id);
}

export function resolveServiceArea(areas: ServiceArea[], query: ResolveQuery): ResolveResult {
  const active = areas.filter((a) => a.is_active);
  if (active.length === 0) return { status: 'no_areas_configured' };

  const code = query.postalCode ? normalizePostalCode(query.postalCode) : null;
  const hasPoint =
    typeof query.latitude === 'number' &&
    typeof query.longitude === 'number' &&
    isValidLatLng(query.latitude, query.longitude);

  // We can only declare "out of area" if every zone type we have was actually checkable.
  const hasZip = active.some((a) => a.zone_type === 'zip');
  const hasPolygon = active.some((a) => a.zone_type === 'polygon');
  const zipCheckable = !hasZip || code !== null;
  const polygonCheckable = !hasPolygon || hasPoint;

  const matches = active.filter((a) => {
    if (a.zone_type === 'zip')
      return code !== null && a.zip_codes.some((z) => zipEntryMatches(z, code));
    return (
      hasPoint &&
      !!a.polygon &&
      pointInPolygon(query.latitude as number, query.longitude as number, a.polygon)
    );
  });

  if (matches.length > 0) {
    const sorted = [...matches].sort(compareAreas);
    return { status: 'in_area', area: sorted[0], alsoMatched: sorted.slice(1) };
  }
  if (zipCheckable && polygonCheckable) return { status: 'out_of_area' };
  return { status: 'unknown' };
}

// ============================================================
// PRICING
// ============================================================

export function isSurgeActive(
  area: Pick<ServiceArea, 'surge_enabled' | 'surge_multiplier' | 'surge_ends_at'>,
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

/** Surge multiplies the BASE price only; the travel fee is added flat afterwards (never multiplied). All integer cents, rounded once. */
export function computeAreaQuote(
  area: ServiceArea,
  baseCents: number,
  now: Date = new Date(),
): AreaQuote {
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

export function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

// ============================================================
// VALIDATION
// ============================================================

export function validateAreaInput(input: ServiceAreaInput): string | null {
  if (!input.name.trim()) return 'Give this area a name.';
  if (input.name.trim().length > 80) return 'Name must be 80 characters or fewer.';
  if (input.zoneType === 'zip') {
    if (input.zipCodes.length === 0) return 'Add at least one ZIP / postal code.';
    if (input.zipCodes.length > MAX_ZIP_CODES)
      return `A zone can hold at most ${MAX_ZIP_CODES} codes.`;
  } else if (!input.polygon || input.polygon.length < 3) {
    return 'Draw or paste at least 3 polygon points.';
  }
  if (
    !Number.isFinite(input.travelFeeCents) ||
    input.travelFeeCents < 0 ||
    input.travelFeeCents > MAX_TRAVEL_FEE_CENTS
  ) {
    return 'Travel fee must be between $0 and $10,000.';
  }
  if (
    !Number.isFinite(input.surgeMultiplier) ||
    input.surgeMultiplier < MIN_SURGE ||
    input.surgeMultiplier > MAX_SURGE
  ) {
    return `Surge multiplier must be between ${MIN_SURGE}× and ${MAX_SURGE}×.`;
  }
  if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 1000)
    return 'Priority must be a whole number from 0 to 1000.';
  if (input.surgeEnabled && input.surgeEndsAt && Number.isNaN(Date.parse(input.surgeEndsAt)))
    return 'Surge end time is not a valid date.';
  return null;
}

/** Warns (does not block) when this zone's ZIPs overlap an existing zone — priority decides who wins. */
export function findZipOverlaps(
  areas: ServiceArea[],
  candidate: { id?: string; zipCodes: string[] },
): { area: ServiceArea; shared: string[] }[] {
  const mine = new Set(candidate.zipCodes);
  return areas
    .filter((a) => a.id !== candidate.id && a.zone_type === 'zip')
    .map((a) => ({ area: a, shared: a.zip_codes.filter((z) => mine.has(z)) }))
    .filter((o) => o.shared.length > 0);
}

// ============================================================
// DATA ACCESS (all scoped by accountOwnerId)
// ============================================================

function requireOwner(accountOwnerId: string | null | undefined): string {
  if (!accountOwnerId) throw new Error('No account context available.');
  return accountOwnerId;
}

export interface ServiceAreaBundle {
  areas: ServiceArea[];
  assignments: AreaTechnician[];
  settings: ServiceAreaSettings | null;
}

export async function fetchServiceAreaBundle(
  accountOwnerId: string | null | undefined,
): Promise<ServiceAreaBundle> {
  const owner = requireOwner(accountOwnerId);
  const [areasRes, assignRes, settingsRes] = await Promise.all([
    supabase
      .from('service_areas')
      .select('*')
      .eq('user_id', owner)
      .order('priority', { ascending: false })
      .order('name'),
    supabase.from('service_area_technicians').select('*').eq('user_id', owner),
    supabase.from('service_area_settings').select('*').eq('user_id', owner).maybeSingle(),
  ]);
  if (areasRes.error) throw areasRes.error;
  if (assignRes.error) throw assignRes.error;
  if (settingsRes.error) throw settingsRes.error;
  return {
    areas: (areasRes.data as ServiceArea[]) ?? [],
    assignments: (assignRes.data as AreaTechnician[]) ?? [],
    settings: (settingsRes.data as ServiceAreaSettings | null) ?? null,
  };
}

export async function saveServiceArea(
  accountOwnerId: string | null | undefined,
  input: ServiceAreaInput,
): Promise<string> {
  const owner = requireOwner(accountOwnerId);
  const invalid = validateAreaInput(input);
  if (invalid) throw new Error(invalid);

  const payload = {
    name: input.name.trim(),
    color: input.color,
    zone_type: input.zoneType,
    zip_codes: input.zoneType === 'zip' ? input.zipCodes : [],
    polygon: input.zoneType === 'polygon' ? input.polygon : null,
    is_active: input.isActive,
    priority: input.priority,
    travel_fee_cents: Math.round(input.travelFeeCents),
    surge_enabled: input.surgeEnabled,
    surge_multiplier: input.surgeMultiplier,
    surge_ends_at: input.surgeEnabled ? input.surgeEndsAt : null,
    notes: input.notes?.trim() ? input.notes.trim() : null,
  };

  let areaId = input.id;
  if (areaId) {
    const { error } = await supabase
      .from('service_areas')
      .update(payload)
      .eq('id', areaId)
      .eq('user_id', owner);
    if (error) throw error;
  } else {
    const { data, error } = await supabase
      .from('service_areas')
      .insert({ ...payload, user_id: owner })
      .select('id')
      .single();
    if (error) throw error;
    areaId = (data as { id: string }).id;
  }

  // Replace technician coverage: delete-then-insert keeps this idempotent without a diff.
  const del = await supabase
    .from('service_area_technicians')
    .delete()
    .eq('area_id', areaId)
    .eq('user_id', owner);
  if (del.error) throw del.error;
  if (input.technicians.length > 0) {
    const rows = input.technicians.map((t) => ({
      area_id: areaId as string,
      technician_id: t.technicianId,
      user_id: owner,
      is_primary: t.isPrimary,
    }));
    const ins = await supabase.from('service_area_technicians').insert(rows);
    if (ins.error) throw ins.error;
  }
  return areaId as string;
}

export async function deleteServiceArea(
  accountOwnerId: string | null | undefined,
  id: string,
): Promise<void> {
  const owner = requireOwner(accountOwnerId);
  const { error } = await supabase.from('service_areas').delete().eq('id', id).eq('user_id', owner);
  if (error) throw error;
}

export async function setServiceAreaActive(
  accountOwnerId: string | null | undefined,
  id: string,
  isActive: boolean,
): Promise<void> {
  const owner = requireOwner(accountOwnerId);
  const { error } = await supabase
    .from('service_areas')
    .update({ is_active: isActive })
    .eq('id', id)
    .eq('user_id', owner);
  if (error) throw error;
}

export async function saveServiceAreaSettings(
  accountOwnerId: string | null | undefined,
  mode: OutOfAreaMode,
  message: string | null,
): Promise<void> {
  const owner = requireOwner(accountOwnerId);
  const trimmed = message?.trim() ?? '';
  if (trimmed.length > 600)
    throw new Error('The out-of-area message must be 600 characters or fewer.');
  const { error } = await supabase
    .from('service_area_settings')
    .upsert(
      { user_id: owner, out_of_area_mode: mode, out_of_area_message: trimmed || null },
      { onConflict: 'user_id' },
    );
  if (error) throw error;
}

/** The exact words the AI will use for a caller outside every zone. */
export function outOfAreaReply(
  settings: Pick<ServiceAreaSettings, 'out_of_area_mode' | 'out_of_area_message'> | null,
): string {
  const mode = settings?.out_of_area_mode ?? 'waitlist';
  return settings?.out_of_area_message?.trim() || DEFAULT_OUT_OF_AREA_MESSAGES[mode];
}
