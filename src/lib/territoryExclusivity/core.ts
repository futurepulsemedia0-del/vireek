// src/lib/territoryExclusivity/core.ts
//
// Pure TypeScript twin of the overlap / waiting-list / lead-decision rules in
// supabase/migrations/20290312000100_territory_exclusivity.sql. The database is the authority (it re-checks under a lock);
// this file gives staff instant feedback in the UI and is the unit-tested statement of the rules.

export type ZoneType = 'zip' | 'polygon';
export type TerritoryStatus = 'draft' | 'active' | 'suspended' | 'ended';
export type LatLng = [number, number];
export type ConflictKind = 'zip_overlap' | 'polygon_overlap' | 'unverifiable_mixed';

export interface Shape { zoneType: ZoneType; zipCodes: string[]; polygon: LatLng[] | null }
export interface TerritoryLike extends Shape {
  id: string; accountId: string; trade: string; status: TerritoryStatus; termStart: string; termEnd: string; // ISO yyyy-mm-dd, inclusive
}
export interface Conflict { id: string; accountId: string; kind: ConflictKind; sharedZips: string[] }

export const MAX_ZIPS = 2000;
export const MAX_POLYGON_POINTS = 500;
/** Statuses that reserve the territory. A suspended holder is paused, not released. */
export const BLOCKING_STATUSES: readonly TerritoryStatus[] = ['active', 'suspended'];
export const OFFER_HOLD_HOURS = 72; // TODO(owner): must equal territory_offer_hold_hours() in the migration

/* ------------------------------ postal codes ------------------------------ */

const ZIP_RE = /^([0-9]{5}|[A-Z][0-9][A-Z]([0-9][A-Z][0-9])?)$/;

/** US ZIP / ZIP+4 -> 5 digits; Canadian postal code -> upper, no space; FSA stays 3 chars. null if unrecognisable. */
export function normalizeZip(input: string): string | null {
  const x = input.trim().toUpperCase().replace(/[ -]/g, '');
  const v = /^[0-9]{9}$/.test(x) ? x.slice(0, 5) : x;
  return ZIP_RE.test(v) ? v : null;
}

export function parseZipList(text: string): { codes: string[]; invalid: string[] } {
  const set = new Set<string>();
  const invalid: string[] = [];
  for (const raw of text.split(/[\n,;\t]+/).map((t) => t.trim()).filter(Boolean)) {
    const n = normalizeZip(raw);
    if (n) set.add(n);
    else {
      // "10001 10002" style: try whitespace-separated tokens before giving up
      const parts = raw.split(/\s+/);
      const normalized = parts.map(normalizeZip);
      if (parts.length > 1 && normalized.every(Boolean)) normalized.forEach((z) => set.add(z as string));
      else invalid.push(raw);
    }
  }
  return { codes: [...set].sort(), invalid };
}

/** A 3-character Canadian FSA covers every code under it (same rule as territory_zip_overlap). */
export const zipOverlap = (a: string, b: string): boolean =>
  a === b || (a.length === 3 && b.startsWith(a)) || (b.length === 3 && a.startsWith(b));

export function sharedZips(a: readonly string[], b: readonly string[]): string[] {
  const out = new Set<string>();
  for (const x of a) for (const y of b) if (zipOverlap(x, y)) out.add(x);
  return [...out].sort();
}

/* ------------------------------ polygons ([lat, lng]) ------------------------------ */

export function polygonError(p: unknown): string | null {
  if (!Array.isArray(p) || p.length < 3) return 'A polygon needs at least 3 points.';
  if (p.length > MAX_POLYGON_POINTS) return `Polygons are limited to ${MAX_POLYGON_POINTS} points.`;
  for (const pt of p) {
    if (!Array.isArray(pt) || pt.length !== 2 || typeof pt[0] !== 'number' || typeof pt[1] !== 'number' || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) return 'Each point must be [latitude, longitude].';
    if (pt[0] < -90 || pt[0] > 90 || pt[1] < -180 || pt[1] > 180) return 'Latitude must be -90..90 and longitude -180..180.';
  }
  return null;
}

export function pointInPolygon(lat: number, lng: number, poly: readonly LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i++) {
    const [aLat, aLng] = poly[i];
    const [bLat, bLng] = poly[j];
    if (aLng > lng !== bLng > lng && lat < ((bLat - aLat) * (lng - aLng)) / (bLng - aLng) + aLat) inside = !inside;
  }
  return inside;
}

const cross = (o: LatLng, a: LatLng, b: LatLng) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const onSeg = (a: LatLng, b: LatLng, p: LatLng) =>
  Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);

/** Closed-segment intersection: touching endpoints / collinear overlap count. */
export function segmentsIntersect(p1: LatLng, p2: LatLng, p3: LatLng, p4: LatLng): boolean {
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (d1 === 0 && onSeg(p3, p4, p1)) || (d2 === 0 && onSeg(p3, p4, p2)) || (d3 === 0 && onSeg(p1, p2, p3)) || (d4 === 0 && onSeg(p1, p2, p4));
}

/** Two simple polygons overlap iff an edge pair intersects or one contains a vertex of the other. Touching borders count (conservative, like PG's &&). */
export function polygonsOverlap(a: readonly LatLng[], b: readonly LatLng[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return pointInPolygon(a[0][0], a[0][1], b) || pointInPolygon(b[0][0], b[0][1], a);
}

/* ------------------------------ conflicts ------------------------------ */

export const termsOverlap = (aStart: string, aEnd: string, bStart: string, bEnd: string): boolean => aStart <= bEnd && bStart <= aEnd;

export function shapeOverlap(a: Shape, b: Shape): { kind: ConflictKind; shared: string[] } | null {
  if (a.zoneType === 'zip' && b.zoneType === 'zip') {
    const shared = sharedZips(a.zipCodes, b.zipCodes);
    return shared.length ? { kind: 'zip_overlap', shared } : null;
  }
  if (a.zoneType === 'polygon' && b.zoneType === 'polygon') {
    return a.polygon && b.polygon && polygonsOverlap(a.polygon, b.polygon) ? { kind: 'polygon_overlap', shared: [] } : null;
  }
  return { kind: 'unverifiable_mixed', shared: [] }; // no ZIP geometry available: cannot be decided automatically
}

export interface Candidate extends Shape { trade: string; termStart: string; termEnd: string; excludeId?: string }

/** Existing active / suspended grants of the same trade that overlap the candidate in space AND time. */
export function findConflicts(candidate: Candidate, existing: readonly TerritoryLike[]): Conflict[] {
  const out: Conflict[] = [];
  for (const e of existing) {
    if (e.id === candidate.excludeId || e.trade !== candidate.trade || !BLOCKING_STATUSES.includes(e.status)) continue;
    if (!termsOverlap(candidate.termStart, candidate.termEnd, e.termStart, e.termEnd)) continue;
    const o = shapeOverlap(candidate, e);
    if (o) out.push({ id: e.id, accountId: e.accountId, kind: o.kind, sharedZips: o.shared });
  }
  return out;
}

export type ActivationVerdict = { ok: true; needsAcknowledgement: boolean } | { ok: false; reason: 'overlap' };
export function activationVerdict(conflicts: readonly Conflict[]): ActivationVerdict {
  if (conflicts.some((c) => c.kind !== 'unverifiable_mixed')) return { ok: false, reason: 'overlap' };
  return { ok: true, needsAcknowledgement: conflicts.length > 0 };
}

/* ------------------------------ waiting list ------------------------------ */

export interface WaitEntry extends Shape { id: string; accountId: string; trade: string; status: 'waiting' | 'offered' | 'accepted' | 'declined' | 'expired' | 'cancelled' | 'fulfilled'; createdAt: string; offerExpiresAt?: string | null }

/**
 * Mirrors territory_offer_next: FIFO by createdAt (then id). A waiting request is offered only when no blocking grant overlaps it
 * (probe window = today .. today+364) AND it does not overlap an already offered / accepted request (that area is reserved).
 * Stale offers are expired first. Returns ids to offer plus ids that expired.
 */
export function planWaitlistOffers(trade: string, waitlist: readonly WaitEntry[], grants: readonly TerritoryLike[], now: Date): { offer: string[]; expire: string[] } {
  const today = now.toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 364 * 86_400_000).toISOString().slice(0, 10);
  const expire = waitlist.filter((w) => w.trade === trade && w.status === 'offered' && w.offerExpiresAt && Date.parse(w.offerExpiresAt) < now.getTime()).map((w) => w.id);
  const reserved: WaitEntry[] = waitlist.filter((w) => w.trade === trade && (w.status === 'accepted' || (w.status === 'offered' && !expire.includes(w.id))));
  const waiting = waitlist.filter((w) => w.trade === trade && w.status === 'waiting').sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
  const offer: string[] = [];
  for (const w of waiting) {
    if (findConflicts({ ...w, termStart: today, termEnd: end }, grants).length > 0) continue;
    if (reserved.some((r) => shapeOverlap(w, r))) continue;
    offer.push(w.id);
    reserved.push({ ...w, status: 'offered' });
  }
  return { offer, expire };
}

/* ------------------------------ lead routing / marketing ------------------------------ */

export type LeadDecision = 'allow' | 'allow_holder' | 'blocked_other_holder' | 'hold_suspended_holder';

/** Mirrors territory_holder_for + territory_lead_decision. */
export function leadDecision(accountId: string, q: { trade: string; zip?: string | null; lat?: number | null; lng?: number | null; on: string }, grants: readonly TerritoryLike[]): { decision: LeadDecision; holderId?: string } {
  const zip = q.zip ? normalizeZip(q.zip) : null;
  const holders = grants
    .filter((g) => g.trade === q.trade && BLOCKING_STATUSES.includes(g.status) && g.termStart <= q.on && q.on <= g.termEnd)
    .filter((g) => (g.zoneType === 'zip' ? !!zip && g.zipCodes.some((z) => zipOverlap(z, zip)) : q.lat != null && q.lng != null && !!g.polygon && pointInPolygon(q.lat, q.lng, g.polygon)))
    .sort((a, b) => a.termStart.localeCompare(b.termStart) || a.id.localeCompare(b.id));
  const h = holders[0];
  if (!h) return { decision: 'allow' };
  if (h.accountId === accountId) return { decision: h.status === 'suspended' ? 'hold_suspended_holder' : 'allow_holder', holderId: h.id };
  return { decision: 'blocked_other_holder', holderId: h.id };
}

/** ZIPs (from an account's marketing list) that someone else holds exclusively. */
export function blockedMarketingZips(accountId: string, trade: string, zips: readonly string[], grants: readonly TerritoryLike[], on: string): string[] {
  return [...new Set(zips.map((z) => normalizeZip(z)).filter((z): z is string => !!z))].sort()
    .filter((z) => leadDecision(accountId, { trade, zip: z, on }, grants).decision === 'blocked_other_holder');
}

/* ------------------------------ form validation ------------------------------ */

export interface TermFields { termStart: string; termEnd: string; renewalNoticeDays?: number | null; renewalTermMonths?: number | null; feeCents?: number | null; feeCurrency?: string | null }
export function validateTerms(t: TermFields): string | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(t.termStart) || !iso.test(t.termEnd) || Number.isNaN(Date.parse(t.termStart)) || Number.isNaN(Date.parse(t.termEnd))) return 'Enter valid start and end dates.';
  if (t.termEnd < t.termStart) return 'The end date cannot be before the start date.';
  if (Date.parse(t.termEnd) - Date.parse(t.termStart) > 3660 * 86_400_000) return 'A term cannot exceed 10 years.';
  if (t.renewalNoticeDays != null && (!Number.isInteger(t.renewalNoticeDays) || t.renewalNoticeDays < 0 || t.renewalNoticeDays > 365)) return 'Renewal notice must be 0-365 days.';
  if (t.renewalTermMonths != null && (!Number.isInteger(t.renewalTermMonths) || t.renewalTermMonths < 1 || t.renewalTermMonths > 120)) return 'Renewal term must be 1-120 months.';
  if ((t.feeCents == null) !== (t.feeCurrency == null || t.feeCurrency === '')) return 'Enter both a fee and its currency, or neither.';
  if (t.feeCents != null && (!Number.isInteger(t.feeCents) || t.feeCents < 0)) return 'The fee must be a non-negative whole number of cents.';
  if (t.feeCurrency && !/^[A-Z]{3}$/.test(t.feeCurrency)) return 'Currency must be a 3-letter code such as USD.';
  return null;
}
