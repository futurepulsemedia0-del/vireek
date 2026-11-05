// supabase/functions/_shared/mass-incident/core.ts
//
// Vireek Mass Incident Mode — deterministic core.
//
// Groups inbound contacts (calls, SMS, web leads) that look like ONE area-wide event (storm, grid outage,
// water-main break) into an Incident, so every caller gets consistent and honest information and the
// owner is not flooded with isolated truck rolls.
//
// Design rules (all enforced + unit-tested here):
//   * No I/O, no Deno or DOM APIs: runs unchanged in edge functions, the dashboard and Vitest.
//   * An LLM never decides anything in this file. It only SPEAKS the guidance this file produces.
//   * A contact is never dropped: every contact stays individually listed, attached or not.
//   * Honesty: a suspected cause is always "suspected" until a verified external signal or the owner
//     confirms it. Confidence is capped without corroboration. Language is hedged.
//   * Safety first: a true emergency is NEVER deflected, whatever the incident says.
//   * Utility / municipal numbers come only from a verified, non-stale directory entry. No directory
//     entry means we say so — we never recall a phone number from memory.

import { haversineMiles } from "../emergency/emergencyCore.ts";
import { safetyGuidance, screenSafety, type SafetyReason } from "../remote-resolution/score.ts";

export { haversineMiles };
export type { SafetyReason };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SymptomClass =
  | "no_water"
  | "low_water_pressure"
  | "discolored_water"
  | "no_power"
  | "partial_power"
  | "no_heat"
  | "no_cooling"
  | "gas_odor"
  | "flooding"
  | "sewer_backup"
  | "storm_damage"
  | "frozen_pipes"
  | "other";

export type SuspectedCause =
  | "water_supply_issue"
  | "power_grid_outage"
  | "gas_utility_issue"
  | "severe_weather"
  | "sewer_main_issue"
  | "extreme_temperature"
  | "unknown";

export type CauseStatus = "suspected" | "corroborated" | "owner_confirmed";
export type IncidentStatus = "watching" | "active" | "monitoring" | "resolved" | "dismissed";
export type ContactSource = "call" | "sms" | "lead" | "manual";
export type GeoPrecision = "address" | "postal" | "none";
export type ScopeKind = "postal" | "radius" | "polygon";
export type SignalKind = "weather_alert" | "utility_outage" | "municipal_notice" | "manual";
export type TriageDecision = "escalate_emergency" | "upstream_likely" | "book_normally";

export type LatLng = [number, number];

export interface IncidentContact {
  id: string;
  source: ContactSource;
  contactAt: string; // ISO
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
  geoPrecision: GeoPrecision;
  symptomClass: SymptomClass;
  symptomText: string;
  isEmergency: boolean;
  hazards: SafetyReason[];
  embedding: number[] | null;
  incidentId: string | null;
}

export interface ExternalSignal {
  id: string;
  kind: SignalKind;
  headline: string;
  postalCodes: string[];
  lat: number | null;
  lng: number | null;
  radiusMiles: number | null;
  /** true only for official sources (NWS feed, utility/municipal page the owner or platform verified). */
  verified: boolean;
  effectiveAt: string | null;
  expiresAt: string | null;
  /** causes this signal can corroborate */
  corroborates: SuspectedCause[];
}

export interface IncidentScope {
  kind: ScopeKind;
  postalCodes: string[];
  center: LatLng | null;
  radiusMiles: number | null;
  polygon: LatLng[] | null;
}

export interface IncidentSnapshot {
  id: string;
  status: IncidentStatus;
  scope: IncidentScope;
  symptomClass: SymptomClass;
  firstContactAt: string;
  lastContactAt: string;
  memberCount: number;
}

export interface ClusterParams {
  windowMinutes: number; // time window for grouping
  radiusMiles: number; // max distance between two contacts to be "same area"
  minContacts: number; // contacts needed to open an incident
  /** Minimum pair affinity (0..1) to be linked. */
  linkThreshold: number;
}

export const DEFAULT_PARAMS: ClusterParams = {
  windowMinutes: 120,
  radiusMiles: 3,
  minContacts: 3,
  linkThreshold: 0.55,
};

export const LIMITS = {
  maxCandidatePool: 200,
  maxPostalCodesInScope: 12,
  minRadiusMiles: 0.5,
  maxRadiusMiles: 25,
  directoryStaleDays: 365,
  /** Below this an incident is never shown to callers as likely. */
  informCallersMinConfidence: 0.6,
} as const;

export const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------
// Symptom classification (deterministic taxonomy; embeddings are an optional upgrade)
// ---------------------------------------------------------------------------

const strip = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const SYMPTOM_RULES: { cls: SymptomClass; re: RegExp }[] = [
  { cls: "gas_odor", re: /\b(smell(s|ed)? (of )?(natural )?gas|gas (smell|leak|odou?r)|rotten egg|huele a gas|fuga de gas)\b/ },
  { cls: "sewer_backup", re: /\b(sewer (backup|back up|smell)|sewage|toilet (is )?overflowing|drains? (backing|backed) up|aguas negras)\b/ },
  { cls: "flooding", re: /\b(flood(ed|ing)?|standing water|water (is )?(coming|pouring|gushing) (in|into)|inundacion|basement (is )?(full|wet))\b/ },
  { cls: "frozen_pipes", re: /\b(frozen pipes?|pipes? (are |is )?frozen|pipe froze|tuberias congeladas)\b/ },
  { cls: "discolored_water", re: /\b(brown water|rusty water|discolou?red water|cloudy water|dirty water|muddy water|agua (turbia|marron|sucia))\b/ },
  { cls: "low_water_pressure", re: /\b(low (water )?pressure|(weak|trickle|trickling|barely)\b.{0,20}\b(water|faucet|tap|shower)|no pressure|poca presion|baja presion)\b/ },
  { cls: "no_water", re: /\b(no (running )?water|water('s| is| has)? (off|out|gone|stopped)|without water|(taps?|faucets?) (are |is )?(dry|not working)|sin agua)\b/ },
  { cls: "partial_power", re: /\b(half (the )?(house|home)|some (outlets|lights|rooms)|(breaker|fuse)s? (keeps?|keep) tripping|flickering|lights? flicker(ing)?|brownout|dimming)\b/ },
  { cls: "no_power", re: /\b(no (power|electricity)|power('s| is| has)? (out|off|gone)|(power|electricity) (outage|cut)|blackout|lost power|sin (luz|electricidad|energia))\b/ },
  { cls: "no_cooling", re: /\b(no (cooling|a\/?c|air conditioning|cold air)|(a\/?c|air conditioner|ac) (is |has )?(not working|stopped|died|broke|out)|too hot|sin aire acondicionado)\b/ },
  { cls: "no_heat", re: /\b(no heat|(heat|heater|furnace|boiler) (is |has )?(not working|stopped|died|broke|out|off)|too cold|freezing (in|inside)|sin calefaccion)\b/ },
  { cls: "storm_damage", re: /\b(storm damage|tree (fell|down|on)|roof (damage|leak|blown|torn)|shingles? (blown|missing)|hail damage|wind damage|downed (tree|line|wire)|tornado|hurricane)\b/ },
];

const NEGATION_BEFORE = /\b(no|not|don'?t|doesn'?t|didn'?t|without|never|nothing|nope|sin)\W*$/;

/** True when `re` matches somewhere that is NOT directly negated ("no gas smell" must not count as gas). */
function hasUnnegatedMatch(re: RegExp, text: string): boolean {
  const g = new RegExp(re.source, "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    if (!NEGATION_BEFORE.test(text.slice(Math.max(0, m.index - 16), m.index))) return true;
    if (m[0].length === 0) g.lastIndex++;
  }
  return false;
}

export interface SymptomResult {
  symptomClass: SymptomClass;
  /** How sure the keyword match is (0 when "other"). */
  confidence: number;
}

export function classifySymptom(text: string | null | undefined): SymptomResult {
  const t = strip(String(text ?? "").slice(0, 2000));
  if (!t.trim()) return { symptomClass: "other", confidence: 0 };
  const hits = SYMPTOM_RULES.filter((r) => hasUnnegatedMatch(r.re, t));
  if (hits.length === 0) return { symptomClass: "other", confidence: 0 };
  // Rules are ordered by safety/specificity; the first hit wins. More agreeing hits => slightly more sure.
  return { symptomClass: hits[0].cls, confidence: clamp01(0.7 + 0.1 * (hits.length - 1)) };
}

/** Pairs of classes that very often share one upstream cause. */
const RELATED: ReadonlyArray<readonly [SymptomClass, SymptomClass]> = [
  ["no_water", "low_water_pressure"],
  ["no_water", "discolored_water"],
  ["low_water_pressure", "discolored_water"],
  ["no_power", "partial_power"],
  ["no_power", "no_cooling"],
  ["no_power", "no_heat"],
  ["no_power", "storm_damage"],
  ["storm_damage", "flooding"],
  ["flooding", "sewer_backup"],
  ["frozen_pipes", "no_water"],
  ["frozen_pipes", "no_heat"],
];

export function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? clamp01(dot / d) : 0;
}

const STOP = new Set(["the", "a", "an", "is", "are", "was", "my", "our", "and", "or", "of", "to", "in", "on", "it", "we", "i", "no", "not", "have", "has", "with", "for"]);
const tokens = (s: string): Set<string> => new Set(strip(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));

export function jaccard(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Symptom similarity 0..1. Uses embeddings when BOTH contacts have one; otherwise the taxonomy. */
export function symptomSimilarity(a: Pick<IncidentContact, "symptomClass" | "symptomText" | "embedding">, b: Pick<IncidentContact, "symptomClass" | "symptomText" | "embedding">): number {
  if (a.embedding && b.embedding) {
    const c = cosine(a.embedding, b.embedding);
    // Taxonomy equality keeps a floor so a noisy embedding cannot split two obvious "no water" calls.
    const floor = a.symptomClass === b.symptomClass && a.symptomClass !== "other" ? 0.8 : 0;
    return Math.max(c, floor);
  }
  if (a.symptomClass === b.symptomClass) return a.symptomClass === "other" ? clamp01(0.2 + 0.8 * jaccard(a.symptomText, b.symptomText)) : 1;
  const related = RELATED.some(([x, y]) => (x === a.symptomClass && y === b.symptomClass) || (x === b.symptomClass && y === a.symptomClass));
  return related ? 0.6 : 0.1 * jaccard(a.symptomText, b.symptomText);
}

// ---------------------------------------------------------------------------
// Geo + time affinity
// ---------------------------------------------------------------------------

export function normalizePostal(input: string | null | undefined): string | null {
  const raw = String(input ?? "").trim().toUpperCase();
  if (/^\d{5}(?:-?\d{4})?$/.test(raw)) return raw.slice(0, 5);
  if (/^[A-Z]\d[A-Z][ -]?\d[A-Z]\d$/.test(raw)) return raw.replace(/[ -]/g, "").slice(0, 3); // CA: FSA (area) level
  if (/^[A-Z]\d[A-Z]$/.test(raw)) return raw;
  return null;
}

/** First US ZIP / Canadian postal code found in free text (address, SMS body). */
export function extractPostal(text: string | null | undefined): string | null {
  const s = String(text ?? "").toUpperCase();
  const ca = /\b([A-Z]\d[A-Z])[ -]?\d[A-Z]\d\b/.exec(s);
  if (ca) return ca[1];
  const us = /\b(\d{5})(?:-\d{4})?\b/.exec(s);
  return us ? us[1] : null;
}

export function geoAffinity(a: Pick<IncidentContact, "postalCode" | "lat" | "lng">, b: Pick<IncidentContact, "postalCode" | "lat" | "lng">, radiusMiles: number): number {
  const haveA = a.lat != null && a.lng != null;
  const haveB = b.lat != null && b.lng != null;
  if (haveA && haveB) {
    const d = haversineMiles(a.lat as number, a.lng as number, b.lat as number, b.lng as number);
    if (d >= radiusMiles) return 0;
    return clamp01(1 - d / radiusMiles) * 0.5 + 0.5; // same-block 1.0 .. at the radius edge 0.5
  }
  if (a.postalCode && b.postalCode) return a.postalCode === b.postalCode ? 0.8 : 0;
  return 0; // unlocated contacts are never silently merged into a geographic cluster
}

export function timeAffinity(aIso: string, bIso: string, windowMinutes: number): number {
  const dt = Math.abs(Date.parse(aIso) - Date.parse(bIso)) / 60_000;
  if (!Number.isFinite(dt) || dt >= windowMinutes) return 0;
  return clamp01(1 - (dt / windowMinutes) * 0.5); // 1.0 now .. 0.5 at the window edge
}

/** Pair affinity: geo, time and symptom must ALL be present (multiplicative gate), then blended. */
export function pairAffinity(a: IncidentContact, b: IncidentContact, p: ClusterParams): number {
  const g = geoAffinity(a, b, p.radiusMiles);
  const t = timeAffinity(a.contactAt, b.contactAt, p.windowMinutes);
  const s = symptomSimilarity(a, b);
  if (g === 0 || t === 0 || s < 0.5) return 0;
  return round3(clamp01(0.4 * g + 0.25 * t + 0.35 * s));
}

// ---------------------------------------------------------------------------
// Scope (area) from member contacts
// ---------------------------------------------------------------------------

export function convexHull(points: ReadonlyArray<LatLng>): LatLng[] {
  const pts = [...points].sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  const uniq = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  if (uniq.length < 3) return uniq;
  const cross = (o: LatLng, a: LatLng, b: LatLng) => (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
  const lower: LatLng[] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: LatLng[] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

export function computeScope(contacts: ReadonlyArray<IncidentContact>): IncidentScope {
  const postals = [...new Set(contacts.map((c) => c.postalCode).filter((x): x is string => !!x))].sort().slice(0, LIMITS.maxPostalCodesInScope);
  const located = contacts.filter((c) => c.lat != null && c.lng != null) as Array<IncidentContact & { lat: number; lng: number }>;
  if (located.length === 0) return { kind: "postal", postalCodes: postals, center: null, radiusMiles: null, polygon: null };
  const lat = located.reduce((s, c) => s + c.lat, 0) / located.length;
  const lng = located.reduce((s, c) => s + c.lng, 0) / located.length;
  const maxD = Math.max(...located.map((c) => haversineMiles(lat, lng, c.lat, c.lng)));
  const radius = Math.min(LIMITS.maxRadiusMiles, Math.max(LIMITS.minRadiusMiles, round3(maxD * 1.15 + 0.25)));
  const hull = located.length >= 3 ? convexHull(located.map((c): LatLng => [c.lat, c.lng])) : [];
  if (hull.length >= 3) return { kind: "polygon", postalCodes: postals, center: [round3(lat), round3(lng)], radiusMiles: radius, polygon: hull };
  return { kind: "radius", postalCodes: postals, center: [round3(lat), round3(lng)], radiusMiles: radius, polygon: null };
}

export function pointInPolygon(lat: number, lng: number, polygon: ReadonlyArray<LatLng>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Does a (possibly postal-only) location fall inside an incident's scope? */
export function inScope(scope: IncidentScope, where: { postalCode: string | null; lat: number | null; lng: number | null }): boolean {
  if (where.lat != null && where.lng != null) {
    if (scope.polygon && scope.polygon.length >= 3 && pointInPolygon(where.lat, where.lng, scope.polygon)) return true;
    if (scope.center && scope.radiusMiles != null && haversineMiles(scope.center[0], scope.center[1], where.lat, where.lng) <= scope.radiusMiles) return true;
  }
  if (where.postalCode && scope.postalCodes.includes(where.postalCode)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Cause inference (always with explicit uncertainty)
// ---------------------------------------------------------------------------

const SYMPTOM_TO_CAUSE: Record<SymptomClass, SuspectedCause> = {
  no_water: "water_supply_issue",
  low_water_pressure: "water_supply_issue",
  discolored_water: "water_supply_issue",
  no_power: "power_grid_outage",
  partial_power: "power_grid_outage",
  no_heat: "extreme_temperature",
  no_cooling: "extreme_temperature",
  gas_odor: "gas_utility_issue",
  flooding: "severe_weather",
  sewer_backup: "sewer_main_issue",
  storm_damage: "severe_weather",
  frozen_pipes: "extreme_temperature",
  other: "unknown",
};

export interface CauseInference {
  cause: SuspectedCause;
  status: CauseStatus;
  /** 0..1 — how likely this cause is, NOT how sure we are an incident exists. */
  confidence: number;
  alternatives: Array<{ cause: SuspectedCause; confidence: number }>;
  /** Plain-language uncertainty statement, safe to show to the owner. */
  uncertainty: string;
  basis: string[];
  corroboratedBy: string[];
}

export function inferCause(
  contacts: ReadonlyArray<IncidentContact>,
  signals: ReadonlyArray<ExternalSignal>,
  now: Date,
  ownerConfirmedCause: SuspectedCause | null = null,
): CauseInference {
  if (ownerConfirmedCause) {
    return {
      cause: ownerConfirmedCause, status: "owner_confirmed", confidence: 0.95, alternatives: [],
      uncertainty: "Confirmed by the business owner.", basis: ["owner_confirmed"], corroboratedBy: [],
    };
  }
  const votes = new Map<SuspectedCause, number>();
  for (const c of contacts) votes.set(SYMPTOM_TO_CAUSE[c.symptomClass], (votes.get(SYMPTOM_TO_CAUSE[c.symptomClass]) ?? 0) + 1);
  const total = contacts.length || 1;
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked[0] ?? (["unknown", 0] as [SuspectedCause, number]);
  const share = top[1] / total;
  const active = signals.filter((s) => isSignalActive(s, now));
  const matching = active.filter((s) => s.verified && s.corroborates.includes(top[0]));
  const basis: string[] = [`${top[1]} of ${total} contacts describe the same kind of problem`];
  let confidence = clamp01(share * (0.45 + 0.1 * Math.min(contacts.length, 5)));
  let status: CauseStatus = "suspected";
  if (matching.length > 0) {
    confidence = clamp01(Math.max(confidence, 0.6) + 0.25);
    status = "corroborated";
    basis.push(`an official ${matching[0].kind.replace(/_/g, " ")} covers this area`);
  } else if (active.some((s) => !s.verified)) {
    basis.push("an unverified report exists but is not counted as evidence");
  }
  if (top[0] === "unknown") confidence = Math.min(confidence, 0.3);
  const alternatives = ranked.slice(1, 3).map(([cause, n]) => ({ cause, confidence: round3(clamp01((n / total) * 0.6)) }));
  const uncertainty =
    status === "corroborated"
      ? "An official notice matches what callers report. The exact cause and restoration time are still not confirmed by us."
      : "This is an inference from caller reports only. It may be wrong: individual homes can have their own, unrelated problem.";
  return { cause: top[0], status, confidence: round3(confidence), alternatives, uncertainty, basis, corroboratedBy: matching.map((s) => s.id) };
}

export function isSignalActive(s: Pick<ExternalSignal, "effectiveAt" | "expiresAt">, now: Date): boolean {
  const t = now.getTime();
  if (s.effectiveAt && Date.parse(s.effectiveAt) > t + 15 * 60_000) return false;
  if (s.expiresAt && Date.parse(s.expiresAt) < t) return false;
  return true;
}

export function signalCoversContact(s: ExternalSignal, c: Pick<IncidentContact, "postalCode" | "lat" | "lng">): boolean {
  if (c.postalCode && s.postalCodes.includes(c.postalCode)) return true;
  if (s.lat != null && s.lng != null && s.radiusMiles != null && c.lat != null && c.lng != null) {
    return haversineMiles(s.lat, s.lng, c.lat, c.lng) <= s.radiusMiles;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Incident confidence (explainable)
// ---------------------------------------------------------------------------

export interface ConfidenceBreakdown {
  value: number;
  count: number;
  agreement: number;
  tightness: number;
  burst: number;
  corroboration: number;
  cap: number;
}

/**
 * confidence = cap( 0.35*count + 0.25*agreement + 0.15*tightness + 0.10*burst + 0.15*corroboration )
 * cap: <minContacts => 0.45, no corroboration => 0.85, otherwise 0.98 (never 1: we are inferring).
 * Every component is returned so the dashboard can show WHY.
 */
export function scoreIncident(
  contacts: ReadonlyArray<IncidentContact>,
  scope: IncidentScope,
  cause: CauseInference,
  params: ClusterParams,
  baselinePerHour = 0.5,
): ConfidenceBreakdown {
  const n = contacts.length;
  const count = clamp01(1 - Math.exp(-n / 4));
  const agreement = n === 0 ? 0 : clamp01((contacts.filter((c) => SYMPTOM_TO_CAUSE[c.symptomClass] === cause.cause).length) / n);
  const tightness = scope.radiusMiles == null ? (scope.postalCodes.length <= 2 ? 0.6 : 0.3) : clamp01(1 - scope.radiusMiles / (params.radiusMiles * 2));
  const times = contacts.map((c) => Date.parse(c.contactAt)).filter(Number.isFinite);
  const spanH = times.length > 1 ? Math.max((Math.max(...times) - Math.min(...times)) / 3_600_000, 0.25) : 0.25;
  const burst = clamp01((n / spanH / Math.max(baselinePerHour, 0.1) - 1) / 6);
  const corroboration = cause.status === "owner_confirmed" ? 1 : cause.status === "corroborated" ? 1 : 0;
  const raw = 0.35 * count + 0.25 * agreement + 0.15 * tightness + 0.1 * burst + 0.15 * corroboration;
  const cap = n < params.minContacts ? 0.45 : corroboration > 0 ? 0.98 : 0.85;
  return { value: round3(Math.min(clamp01(raw), cap)), count: round3(count), agreement: round3(agreement), tightness: round3(tightness), burst: round3(burst), corroboration, cap };
}

// ---------------------------------------------------------------------------
// Clustering decision for ONE new contact
// ---------------------------------------------------------------------------

export type ClusterDecision =
  | { action: "none"; reason: "unlocated" | "no_match" | "below_threshold" }
  | { action: "attach"; incidentId: string; affinity: number }
  | { action: "create"; candidateIds: string[]; affinity: number };

/**
 * - Attach to the best OPEN incident the contact fits (in scope + matching symptom + inside the time window).
 * - Otherwise open a NEW incident when (minContacts-1) other unattached contacts are pairwise linked to it.
 * - Otherwise stay a loose contact (still visible, still counted for the next contact).
 */
export function decideCluster(
  contact: IncidentContact,
  open: ReadonlyArray<IncidentSnapshot>,
  pool: ReadonlyArray<IncidentContact>,
  p: ClusterParams = DEFAULT_PARAMS,
): ClusterDecision {
  if (contact.geoPrecision === "none" && contact.lat == null && !contact.postalCode) return { action: "none", reason: "unlocated" };
  if (contact.isEmergency || contact.hazards.length > 0) {
    // Emergencies may still be RECORDED in an incident for visibility, but they never open or define one.
    const joined = bestIncident(contact, open, p);
    return joined ? { action: "attach", incidentId: joined.id, affinity: joined.affinity } : { action: "none", reason: "no_match" };
  }
  const joined = bestIncident(contact, open, p);
  if (joined) return { action: "attach", incidentId: joined.id, affinity: joined.affinity };

  const linked = pool
    .filter((o) => o.id !== contact.id && o.incidentId === null && !o.isEmergency && o.hazards.length === 0)
    .map((o) => ({ o, a: pairAffinity(contact, o, p) }))
    .filter((x) => x.a >= p.linkThreshold)
    .sort((x, y) => y.a - x.a)
    .slice(0, LIMITS.maxCandidatePool);
  if (linked.length + 1 >= p.minContacts) {
    const avg = linked.reduce((s, x) => s + x.a, 0) / linked.length;
    return { action: "create", candidateIds: linked.map((x) => x.o.id), affinity: round3(avg) };
  }
  return { action: "none", reason: linked.length > 0 ? "below_threshold" : "no_match" };
}

function bestIncident(c: IncidentContact, open: ReadonlyArray<IncidentSnapshot>, p: ClusterParams): { id: string; affinity: number } | null {
  let best: { id: string; affinity: number } | null = null;
  for (const inc of open) {
    if (inc.status === "resolved" || inc.status === "dismissed") continue;
    if (!inScope(inc.scope, c)) continue;
    const dtMin = Math.abs(Date.parse(c.contactAt) - Date.parse(inc.lastContactAt)) / 60_000;
    // An incident stays "open to new members" for 2x the window after its last contact.
    if (!Number.isFinite(dtMin) || dtMin > p.windowMinutes * 2) continue;
    const sym = symptomSimilarity(c, { symptomClass: inc.symptomClass, symptomText: "", embedding: null });
    if (sym < 0.6) continue;
    const affinity = round3(0.6 * sym + 0.4 * clamp01(1 - dtMin / (p.windowMinutes * 2)));
    if (!best || affinity > best.affinity) best = { id: inc.id, affinity };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Utility / municipal directory (verified only)
// ---------------------------------------------------------------------------

export type DirectoryService = "water" | "power" | "gas" | "sewer" | "municipal_info";

export interface DirectoryEntry {
  id: string;
  /** null = platform-maintained; set = the tenant's own override. */
  userId: string | null;
  country: string;
  region: string | null;
  postalPrefix: string | null;
  service: DirectoryService;
  name: string;
  phone: string | null;
  website: string | null;
  sourceUrl: string;
  verifiedAt: string | null;
  status: "verified" | "stale" | "retired";
}

export function isDirectoryEntryUsable(e: DirectoryEntry, now: Date): boolean {
  if (e.status !== "verified" || !e.verifiedAt || !e.sourceUrl) return false;
  const ageDays = (now.getTime() - Date.parse(e.verifiedAt)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > LIMITS.directoryStaleDays) return false;
  return Boolean(e.phone || e.website);
}

/** Most specific usable entry per service: tenant override > postal prefix > region > country. */
export function pickDirectoryEntry(
  entries: ReadonlyArray<DirectoryEntry>,
  where: { country: string; region: string | null; postalCode: string | null; service: DirectoryService; userId: string },
  now: Date,
): DirectoryEntry | null {
  const country = where.country.toUpperCase();
  const region = where.region ? where.region.toUpperCase() : null;
  const scored = entries
    .filter((e) => e.service === where.service && e.country.toUpperCase() === country && isDirectoryEntryUsable(e, now))
    .filter((e) => e.userId === null || e.userId === where.userId)
    .filter((e) => e.region === null || (region !== null && e.region.toUpperCase() === region))
    .filter((e) => e.postalPrefix === null || (where.postalCode !== null && where.postalCode.startsWith(e.postalPrefix)))
    .map((e) => ({ e, s: (e.userId ? 100 : 0) + (e.postalPrefix ? e.postalPrefix.length * 4 : 0) + (e.region ? 10 : 0) }))
    .sort((a, b) => b.s - a.s || Date.parse(b.e.verifiedAt ?? "") - Date.parse(a.e.verifiedAt ?? ""));
  return scored[0]?.e ?? null;
}

export const CAUSE_TO_SERVICE: Partial<Record<SuspectedCause, DirectoryService>> = {
  water_supply_issue: "water",
  power_grid_outage: "power",
  gas_utility_issue: "gas",
  sewer_main_issue: "sewer",
  severe_weather: "municipal_info",
  extreme_temperature: "municipal_info",
};

/** Universal emergency numbers (not utilities). Stable, safety-critical, listed by country. */
export const NATIONAL_EMERGENCY_NUMBER: Record<string, string> = {
  US: "911", CA: "911", GB: "999", IE: "112", AU: "000", NZ: "111",
  DE: "112", FR: "112", ES: "112", IT: "112", NL: "112", SE: "112", PT: "112", AT: "112", BE: "112", PL: "112",
};

// ---------------------------------------------------------------------------
// Honest triage
// ---------------------------------------------------------------------------

/** Phrases that mean the problem is probably limited to THIS home, so we must not blame upstream. */
const OWN_SIDE_RE = /\b(only (my|our) (house|home|apartment|unit|kitchen|bathroom|sink|tap|toilet|shower|water heater)|just (my|our|the) (kitchen|bathroom|sink|tap|toilet|shower|water heater|room)|neighbou?rs? (have|has|are|is) (power|water|fine|ok|okay|normal)|neighbou?rs?'? (power|water) (is|are) (on|fine|ok|okay)|one (faucet|tap|toilet|outlet|room)|breaker (tripped|is tripped)|slow (drain|sink))\b/;

export function indicatesOwnSide(text: string | null | undefined): boolean {
  return OWN_SIDE_RE.test(strip(String(text ?? "")));
}

export interface IncidentForTriage {
  id: string;
  status: IncidentStatus;
  symptomClass: SymptomClass;
  scope: IncidentScope;
  confidence: number;
  cause: SuspectedCause;
  causeStatus: CauseStatus;
  causeConfidence: number;
  memberCount: number;
  firstContactAt: string;
}

export interface TriageInput {
  symptomText: string;
  hazards: SafetyReason[];
  isEmergency: boolean;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
}

export interface TriageResult {
  decision: TriageDecision;
  incidentId: string | null;
  /** ALWAYS true except for emergencies, where Sarah must escalate instead. */
  offerBooking: boolean;
  /** Dispatching a truck now is not recommended (upstream likely and not an emergency). */
  suggestHoldTruckRoll: boolean;
  safetySteps: string[];
  reasons: string[];
}

export function triageContact(input: TriageInput, incidents: ReadonlyArray<IncidentForTriage>): TriageResult {
  const screened = screenSafety([input.symptomText]);
  const hazards = [...new Set([...input.hazards, ...screened.reasons])];
  if (input.isEmergency || hazards.length > 0) {
    return { decision: "escalate_emergency", incidentId: null, offerBooking: false, suggestHoldTruckRoll: false, safetySteps: safetyGuidance(hazards), reasons: ["safety hazard reported — never deflected by an incident"] };
  }
  const cls = classifySymptom(input.symptomText).symptomClass;
  const match = incidents
    .filter((i) => (i.status === "active" || i.status === "monitoring") && inScope(i.scope, input))
    .filter((i) => symptomSimilarity({ symptomClass: cls, symptomText: input.symptomText, embedding: null }, { symptomClass: i.symptomClass, symptomText: "", embedding: null }) >= 0.6)
    .sort((a, b) => b.confidence - a.confidence)[0];
  if (!match) return { decision: "book_normally", incidentId: null, offerBooking: true, suggestHoldTruckRoll: false, safetySteps: [], reasons: ["no matching area incident"] };
  if (match.confidence < LIMITS.informCallersMinConfidence) {
    return { decision: "book_normally", incidentId: match.id, offerBooking: true, suggestHoldTruckRoll: false, safetySteps: [], reasons: ["an area incident is possible but not confident enough to tell the caller"] };
  }
  if (indicatesOwnSide(input.symptomText)) {
    return { decision: "book_normally", incidentId: match.id, offerBooking: true, suggestHoldTruckRoll: false, safetySteps: causeSafetySteps(match.cause), reasons: ["caller describes a problem that looks limited to their own home"] };
  }
  const upstream: SuspectedCause[] = ["water_supply_issue", "power_grid_outage", "sewer_main_issue", "gas_utility_issue"];
  return {
    decision: "upstream_likely",
    incidentId: match.id,
    offerBooking: true,
    suggestHoldTruckRoll: upstream.includes(match.cause),
    safetySteps: causeSafetySteps(match.cause),
    reasons: [`matches active area incident (${match.memberCount} contacts, confidence ${Math.round(match.confidence * 100)}%)`],
  };
}

/** Conservative, widely-published household safety steps. Needs trade/legal review before launch (see docs). */
export function causeSafetySteps(cause: SuspectedCause): string[] {
  switch (cause) {
    case "power_grid_outage":
      return [
        "Use flashlights, not candles.",
        "Never run a generator, grill or camp stove indoors or in a garage: carbon monoxide can kill.",
        "Keep fridge and freezer doors closed; unplug sensitive electronics until power is stable.",
        "Stay far away from any downed power line and call 911 and the utility.",
        "Check on anyone who relies on powered medical equipment.",
      ];
    case "water_supply_issue":
      return [
        "Do not use the dishwasher or washing machine until water is steady again.",
        "When service returns, open taps slowly and let cold water run until it is clear.",
        "If the water looks brown or cloudy, or a boil-water notice is issued, follow the water provider's instructions before drinking it.",
      ];
    case "sewer_main_issue":
      return ["Avoid contact with any backed-up water and keep children and pets away.", "Do not run more water down the drains until it clears."];
    case "gas_utility_issue":
      return ["If you smell gas, leave the building now, do not use switches, flames or phones inside, and call 911 and the gas utility from outside."];
    case "severe_weather":
      return ["Stay clear of downed lines, flooded areas and anything electrical that is wet.", "Do not enter a damaged structure until it has been checked."];
    case "extreme_temperature":
      return ["Check on infants, elderly neighbours and anyone with medical needs; move them somewhere safe and comfortable if you can."];
    default:
      return [];
  }
}

const CAUSE_PHRASE: Record<SuspectedCause, string> = {
  water_supply_issue: "a problem with the water supply in your area",
  power_grid_outage: "a power outage in your area",
  gas_utility_issue: "a gas service issue in your area",
  severe_weather: "storm or weather damage in your area",
  sewer_main_issue: "a sewer problem in your area",
  extreme_temperature: "the extreme temperatures in your area",
  unknown: "something affecting your area",
};

export interface GuidanceInput {
  triage: TriageResult;
  incident: IncidentForTriage | null;
  country: string;
  directoryEntry: DirectoryEntry | null;
  brandName: string;
}

/**
 * The text handed to the voice assistant (tool result) or used for an SMS preview. It is an INSTRUCTION to the
 * assistant in English; the assistant speaks it in the caller's language. Hedged, never a guarantee.
 */
export function buildGuidance(g: GuidanceInput): string {
  const t = g.triage;
  if (t.decision === "escalate_emergency") {
    const num = NATIONAL_EMERGENCY_NUMBER[g.country.toUpperCase()];
    return [
      "SAFETY FIRST — this is a possible emergency, not an area outage question. Do NOT mention any area incident and do NOT defer the caller.",
      `Say the safety steps plainly: ${t.safetySteps.join(" ") || "get everyone to a safe place."}`,
      num ? `If anyone is in danger, tell them to call ${num} now.` : "If anyone is in danger, tell them to call local emergency services now.",
      "Then call flag_emergency_call and transfer to the on-call contact without delay.",
    ].join(" ");
  }
  if (t.decision === "book_normally" || !g.incident) {
    return "No area-wide incident applies to this caller. Continue the normal flow and book the visit.";
  }
  const inc = g.incident;
  const parts: string[] = [];
  parts.push(
    `Other callers near this address are reporting a similar problem (${inc.memberCount} contacts so far). ` +
      `Say this with hedged language: "It may be ${CAUSE_PHRASE[inc.cause]}" — we have NOT confirmed it${inc.causeStatus === "corroborated" ? ", although an official notice appears to match" : ""}. ` +
      "Never state a cause, a restoration time or a repair promise as fact.",
  );
  if (t.safetySteps.length) parts.push(`Share these safety steps: ${t.safetySteps.join(" ")}`);
  if (g.directoryEntry) {
    const e = g.directoryEntry;
    const contact = [e.phone ? `phone ${e.phone}` : null, e.website ? `website ${e.website}` : null].filter(Boolean).join(", ");
    parts.push(`Suggest the caller check with ${e.name} (${contact}) for status. This contact was verified on ${e.verifiedAt?.slice(0, 10)}.`);
  } else {
    parts.push("We do NOT have a verified contact number for their utility. Say so honestly and suggest the number or website printed on their latest bill. NEVER invent or guess a phone number.");
  }
  parts.push(
    t.suggestHoldTruckRoll
      ? `Be clear that the problem may be on the utility's side, so a technician visit may not fix it. STILL offer to book ${g.brandName}'s visit if they want it or if they think the problem is only in their own home, and offer to text them an update once the area is back to normal. Do not push, do not refuse.`
      : "Offer to book a visit as usual.",
  );
  return parts.join(" ");
}

/** Owner-reviewed broadcast text. No cause is stated as fact; no promise of times. */
export function buildBroadcastText(i: { brandName: string; cause: SuspectedCause; causeStatus: CauseStatus; directoryEntry: DirectoryEntry | null; kind: "update" | "resolved" }): string {
  if (i.kind === "resolved") {
    return `${i.brandName}: we're no longer seeing reports of the area-wide issue. If you still have a problem, reply here or call us and we'll arrange a visit. Reply STOP to opt out.`;
  }
  const hedge = i.causeStatus === "suspected" ? "may be" : "appears to be";
  const util = i.directoryEntry ? ` For official status contact ${i.directoryEntry.name}${i.directoryEntry.phone ? ` at ${i.directoryEntry.phone}` : ""}.` : "";
  return `${i.brandName}: many customers near you reported a similar problem. It ${hedge} ${CAUSE_PHRASE[i.cause]}; we haven't confirmed the cause or a restoration time.${util} Need us anyway? Reply here and we'll book a visit. Reply STOP to opt out.`;
}

// ---------------------------------------------------------------------------
// Incident lifecycle helpers
// ---------------------------------------------------------------------------

export function incidentTitle(cause: SuspectedCause, scope: IncidentScope): string {
  const area = scope.postalCodes.length ? scope.postalCodes.slice(0, 3).join(", ") : scope.center ? "mapped area" : "area";
  const what: Record<SuspectedCause, string> = {
    water_supply_issue: "Possible water supply issue",
    power_grid_outage: "Possible power outage",
    gas_utility_issue: "Possible gas service issue",
    severe_weather: "Possible storm / weather event",
    sewer_main_issue: "Possible sewer issue",
    extreme_temperature: "Possible extreme-temperature surge",
    unknown: "Cluster of similar requests",
  };
  return `${what[cause]} — ${area}`;
}

/** active → monitoring after quietMinutes without contacts; monitoring → resolved after resolveHours. */
export function nextStatusByInactivity(status: IncidentStatus, lastContactAt: string, now: Date, windowMinutes: number, resolveAfterHours = 24): IncidentStatus {
  if (status === "resolved" || status === "dismissed") return status;
  const quietMin = (now.getTime() - Date.parse(lastContactAt)) / 60_000;
  if (!Number.isFinite(quietMin)) return status;
  if (quietMin > resolveAfterHours * 60) return "resolved";
  if (status === "active" && quietMin > windowMinutes) return "monitoring";
  return status;
}

/** watching (below the bar) → active when confident enough AND it has enough members. */
export function statusForNewScore(current: IncidentStatus, confidence: number, memberCount: number, p: ClusterParams): IncidentStatus {
  if (current === "resolved" || current === "dismissed") return current;
  if (current === "monitoring") return confidence >= LIMITS.informCallersMinConfidence && memberCount >= p.minContacts ? "active" : current;
  return memberCount >= p.minContacts && confidence >= 0.5 ? "active" : "watching";
}

export const maskPhone = (p: string | null | undefined): string => (p && p.length > 4 ? `••• ${p.slice(-4)}` : p ? "•••" : "—");

// ---------------------------------------------------------------------------
// Small pure helpers shared with the dashboard (realtime merges + ordering)
// ---------------------------------------------------------------------------

export function upsertById<T extends { id: string }>(rows: ReadonlyArray<T>, row: T): T[] {
  const i = rows.findIndex((r) => r.id === row.id);
  if (i === -1) return [row, ...rows];
  const next = rows.slice();
  next[i] = row;
  return next;
}

export const removeById = <T extends { id: string }>(rows: ReadonlyArray<T>, id: string): T[] => rows.filter((r) => r.id !== id);

export const isOpenStatus = (s: IncidentStatus): boolean => s === "watching" || s === "active" || s === "monitoring";

const STATUS_ORDER: Record<IncidentStatus, number> = { active: 0, watching: 1, monitoring: 2, resolved: 3, dismissed: 4 };

export function sortIncidentRows<T extends { status: IncidentStatus; last_contact_at: string }>(rows: ReadonlyArray<T>): T[] {
  return rows.slice().sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || Date.parse(b.last_contact_at) - Date.parse(a.last_contact_at));
}

// ---------------------------------------------------------------------------
// Phase 2 helpers: geocoding eligibility, dispatcher note, hedged SMS auto-reply
// ---------------------------------------------------------------------------

/** A street address worth sending to the geocoder: a number plus letters, at least 6 characters. */
export function looksGeocodable(address: string | null | undefined): boolean {
  const a = String(address ?? "").trim();
  return a.length >= 6 && a.length <= 300 && /\d/.test(a) && /[A-Za-z\u00C0-\u024F]{3}/.test(a);
}

/** One line for the dispatcher (jobs.dispatch_note). Informational only: it never blocks or reassigns a booking. */
export function buildBookingNote(title: string): string {
  return `Area incident: caller was told the problem may be area-wide (${title.replace(/\s+/g, " ").slice(0, 120)}). Re-check status before rolling a truck.`;
}

/** The single hedged text sent to a caller by SMS when the owner enabled auto-reply. */
export function buildSmsAutoReplyText(i: { brandName: string; cause: SuspectedCause; causeStatus: CauseStatus; directoryEntry: DirectoryEntry | null }): string {
  const hedge = i.causeStatus === "suspected" ? "may be" : "appears to be";
  const util = i.directoryEntry
    ? ` For official status contact ${i.directoryEntry.name}${i.directoryEntry.phone ? ` at ${i.directoryEntry.phone}` : ""}.`
    : "";
  return `${i.brandName}: other customers near you report a similar problem. It ${hedge} ${CAUSE_PHRASE[i.cause]}; we haven't confirmed the cause or any restoration time.${util} If you'd still like a visit, or you think it's only your home, reply BOOK and we'll schedule one. Reply STOP to opt out.`;
}
