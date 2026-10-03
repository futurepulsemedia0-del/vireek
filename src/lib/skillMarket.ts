/**
 * Skill Liquidity Network (Technician Skill Market) — client library.
 *
 * Ranking is computed server-side by public.search_skill_market() from verified,
 * outcome-derived skill levels (see supabase/migrations/20270301000000_*.sql).
 * This file holds types, vocab, pure helpers and data access only.
 * Deliberately self-contained: it imports nothing from other network libs.
 */

import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type RequirementKind = 'equipment' | 'service';
export type Urgency = 'emergency' | 'urgent' | 'standard';
export type Availability = 'open' | 'busy' | 'offline';

export interface Requirement {
  kind: RequirementKind;
  /** lowercase a-z0-9 and dash, 2..24 chars, 1..4 tokens — enforced in SQL too */
  tokens: string[];
  minLevel: number;
  label: string;
}

export interface RequirementPreset {
  id: string;
  kind: RequirementKind;
  label: string;
  tokens: string[];
}

export const EQUIPMENT_PRESETS: RequirementPreset[] = [
  { id: 'daikin-vrv', kind: 'equipment', label: 'Daikin VRV', tokens: ['daikin', 'vrv'] },
  { id: 'mitsubishi-vrf', kind: 'equipment', label: 'Mitsubishi VRF', tokens: ['mitsubishi'] },
  { id: 'carrier-rtu', kind: 'equipment', label: 'Carrier rooftop unit', tokens: ['carrier'] },
  { id: 'trane-chiller', kind: 'equipment', label: 'Trane chiller', tokens: ['trane', 'chiller'] },
  { id: 'lennox', label: 'Lennox', kind: 'equipment', tokens: ['lennox'] },
  { id: 'heat-pump', kind: 'equipment', label: 'Heat pump', tokens: ['heat', 'pump'] },
];

export const SERVICE_PRESETS: RequirementPreset[] = [
  { id: 'compressor', kind: 'service', label: 'Compressor diagnosis', tokens: ['compressor'] },
  { id: 'refrigerant-leak', kind: 'service', label: 'Refrigerant leak', tokens: ['leak'] },
  { id: 'control-board', kind: 'service', label: 'Control board / PCB', tokens: ['board'] },
  { id: 'inverter', kind: 'service', label: 'Inverter / VFD', tokens: ['inverter'] },
  { id: 'electrical-fault', kind: 'service', label: 'Electrical fault', tokens: ['electrical'] },
  { id: 'install', kind: 'service', label: 'Installation', tokens: ['install'] },
];

export const URGENCY_META: Record<Urgency, { label: string; hint: string; respondHours: number }> = {
  emergency: { label: 'Emergency', hint: 'Distance and availability weigh most. Reply window 1h.', respondHours: 1 },
  urgent: { label: 'Urgent', hint: 'Balanced for same-day work. Reply window 4h.', respondHours: 4 },
  standard: { label: 'Standard', hint: 'Skill, outcomes and price weigh most. Reply window 24h.', respondHours: 24 },
};

export const LEVEL_LABELS: Record<number, string> = {
  1: 'Novice',
  2: 'Competent',
  3: 'Proficient',
  4: 'Advanced',
  5: 'Expert',
};

export const TRADE_OPTIONS = ['hvac', 'plumbing', 'electrical', 'roofing', 'restoration', 'locksmith', 'general'] as const;
export type MarketTrade = (typeof TRADE_OPTIONS)[number];

export const BREAKDOWN_LABELS: Record<string, string> = {
  skill_fit: 'Diagnostic skill',
  equipment_experience: 'Equipment experience',
  historical_outcome: 'Historical outcome',
  proximity: 'Proximity',
  availability: 'Availability',
  price: 'Price',
  trust: 'Verified trust',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchParams {
  requirements: Requirement[];
  lat: number | null;
  lng: number | null;
  urgency: Urgency;
  trade: MarketTrade | null;
  maxRadiusMiles: number;
  maxHourlyRateCents: number | null;
  requiresInsurance: boolean;
  remote: boolean;
  includeOwnTeam: boolean;
  limit?: number;
}

export interface MatchedSkill {
  label: string;
  skill: string;
  level: number;
  confidence: number;
  jobs: number;
  min_level: number;
}

export interface MarketCandidate {
  candidate_ref: string;
  alias: string;
  is_own_team: boolean;
  display_name: string | null;
  company_name: string;
  tier: string | null;
  passport_index: number | null;
  score: number;
  distance_miles: number | null;
  availability: Availability;
  capacity_left: number;
  hourly_rate_cents: number | null;
  callout_fee_cents: number | null;
  remote_ok: boolean;
  verified_jobs: number;
  first_time_fix_rate: number | null;
  rating_avg: number | null;
  network_jobs: number;
  network_resolved_rate: number | null;
  valid_insurance: boolean;
  evidence_refreshed_at: string | null;
  breakdown: Record<string, number | null | Record<string, number>>;
  matched_skills: MatchedSkill[];
  reasons: string[];
}

export interface TeamListing {
  technician_id: string;
  technician_name: string;
  has_login: boolean;
  listed: boolean;
  company_consent: boolean;
  technician_consent: boolean;
  paused: boolean;
  availability: Availability;
  service_radius_miles: number;
  hourly_rate_cents: number | null;
  callout_fee_cents: number | null;
  remote_assist_enabled: boolean;
  trade: MarketTrade | null;
  tier: string | null;
  passport_index: number | null;
  jobs_completed: number;
  evidence_refreshed_at: string | null;
  top_skills: { kind: RequirementKind; skill: string; level: number; confidence: number; jobs: number }[];
  network_jobs: number;
  network_resolved_rate: number | null;
}

export type OfferStatus = 'offered' | 'accepted' | 'declined' | 'expired' | 'withdrawn' | 'completed';
export type OfferOutcome = 'resolved' | 'partial' | 'unresolved';

export interface MarketOffer {
  id: string;
  direction: 'sent' | 'received';
  title: string;
  summary: string | null;
  urgency: Urgency;
  status: OfferStatus;
  match_score: number | null;
  offered_rate_cents: number | null;
  remote: boolean;
  responds_by: string;
  created_at: string;
  outcome: OfferOutcome | null;
  rating: number | null;
  requirements: { kind: RequirementKind; tokens: string[]; min_level: number; label?: string }[];
  technician_alias: string;
  technician_name: string | null;
  counterparty_company: string;
  counterparty_phone: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** "Daikin VRV-X" -> ['daikin','vrv-x']. Drops 1-char noise, caps at 4 tokens / 24 chars. */
export function tokensFromText(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9-]+/)) {
    const t = raw.replace(/^-+|-+$/g, '').slice(0, 24);
    if (t.length >= 2 && !out.includes(t)) out.push(t);
    if (out.length === 4) break;
  }
  return out;
}

export function presetToRequirement(p: RequirementPreset, minLevel: number): Requirement {
  return { kind: p.kind, tokens: [...p.tokens], minLevel: clampLevel(minLevel), label: p.label };
}

export function clampLevel(n: number): number {
  return Math.min(5, Math.max(1, Math.round(Number.isFinite(n) ? n : 1)));
}

/** Server wire format for p_requirements. */
export function requirementsToWire(reqs: Requirement[]) {
  return reqs.map((r) => ({ kind: r.kind, tokens: r.tokens, min_level: clampLevel(r.minLevel), label: r.label }));
}

export function validateSearch(p: SearchParams): string | null {
  if (p.requirements.length < 1) return 'Add at least one requirement.';
  if (p.requirements.length > 6) return 'Use at most 6 requirements.';
  if (p.requirements.some((r) => r.tokens.length < 1)) return 'Every requirement needs at least one keyword.';
  if (!p.remote && (p.lat === null || p.lng === null)) return 'Choose where the job is, or switch to remote.';
  if (p.lat !== null && (p.lat < -90 || p.lat > 90)) return 'Latitude must be between -90 and 90.';
  if (p.lng !== null && (p.lng < -180 || p.lng > 180)) return 'Longitude must be between -180 and 180.';
  return null;
}

/** "$85" / "85.50" -> cents. '' -> null. Invalid -> NaN (caller must check). */
export function parseRateToCents(input: string): number | null {
  const s = input.trim().replace(/^\$/, '');
  if (s === '') return null;
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(s)) return Number.NaN;
  return Math.round(Number(s) * 100);
}

export function formatRate(cents: number | null): string {
  return cents === null ? '—' : `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}/h`;
}

export function scoreTone(score: number): 'success' | 'accent' | 'warning' {
  return score >= 85 ? 'success' : score >= 70 ? 'accent' : 'warning';
}

/** Breakdown entries that apply to this candidate, in display order. */
export function breakdownEntries(b: MarketCandidate['breakdown']): { key: string; label: string; value: number }[] {
  return Object.keys(BREAKDOWN_LABELS)
    .map((key) => ({ key, label: BREAKDOWN_LABELS[key], value: b[key] }))
    .filter((e): e is { key: string; label: string; value: number } => typeof e.value === 'number');
}

export function hoursUntil(iso: string, now = Date.now()): number {
  return (new Date(iso).getTime() - now) / 3_600_000;
}

export function formatTimeLeft(iso: string, now = Date.now()): string {
  const h = hoursUntil(iso, now);
  if (h <= 0) return 'expired';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m left`;
  return `${Math.round(h)}h left`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERROR_COPY: Record<string, string> = {
  NETWORK_NOT_ENABLED: 'Join the Contractor Network first (Contractor Network → enable) to use the Skill Market.',
  MANAGER_ONLY: 'Only owners and managers can do this.',
  SELF_ONLY: 'Only the technician can give or withdraw their own consent.',
  TECHNICIAN_NOT_FOUND: 'That technician could not be found.',
  CANDIDATE_UNAVAILABLE: 'That technician is no longer available in the market.',
  OWN_TEAM_USE_DISPATCH: 'This technician is on your own team — assign them from the Dispatch Board.',
  ALREADY_OFFERED: 'You already have an open request with this technician.',
  TOO_MANY_OPEN: 'You have too many open requests. Withdraw or complete one first.',
  RATE_LIMITED: 'Too many requests in the last hour. Please wait a little.',
  PII_IN_PUBLIC_FIELDS: 'Remove phone numbers and e-mails — contact details are shared automatically after acceptance.',
  LOCATION_REQUIRED: 'Choose where the job is, or switch to remote.',
  INVALID_REQUIREMENTS: 'Check the requirements: 1–6 items, each with 1–4 plain keywords.',
  INVALID_URGENCY: 'Choose a valid urgency.',
  INVALID_TITLE: 'Give the request a title (3–120 characters).',
  INVALID_SUMMARY: 'The description is too long (max 600 characters).',
  INVALID_RADIUS: 'Service radius must be between 1 and 500 miles.',
  INVALID_AVAILABILITY: 'Choose a valid availability.',
  INVALID_OUTCOME: 'Choose how the job ended.',
  INVALID_RATING: 'Choose a rating from 1 to 5.',
  INVALID_NOTE: 'The note is too long (max 400 characters).',
  OFFER_NOT_FOUND: 'That request could not be found or has already changed.',
  OFFER_NOT_OPEN: 'This request is no longer open.',
  OFFER_EXPIRED: 'This request has expired.',
  REFRESH_TOO_SOON: 'Evidence was refreshed a moment ago. Try again in a few minutes.',
};

export function describeMarketError(err: unknown): string {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : '';
  const code = Object.keys(ERROR_COPY).find((c) => message.includes(c));
  return code ? ERROR_COPY[code] : 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export const skillMarketApi = {
  search: (p: SearchParams) =>
    rpc<MarketCandidate[]>('search_skill_market', {
      p_requirements: requirementsToWire(p.requirements),
      p_lat: p.remote ? null : p.lat,
      p_lng: p.remote ? null : p.lng,
      p_urgency: p.urgency,
      p_trade: p.trade,
      p_max_radius_miles: p.maxRadiusMiles,
      p_max_hourly_rate_cents: p.maxHourlyRateCents,
      p_requires_insurance: p.requiresInsurance,
      p_remote: p.remote,
      p_include_own_team: p.includeOwnTeam,
      p_limit: p.limit ?? 10,
    }),

  myTeam: () => rpc<TeamListing[]>('skill_market_my_team'),

  setListing: (a: {
    technicianId: string;
    enabled: boolean;
    trade: MarketTrade | null;
    radiusMiles: number;
    hourlyRateCents: number | null;
    calloutFeeCents: number | null;
    remoteAssist: boolean;
  }) =>
    rpc<void>('skill_market_set_listing', {
      p_technician_id: a.technicianId,
      p_enabled: a.enabled,
      p_trade: a.trade,
      p_radius_miles: a.radiusMiles,
      p_hourly_rate_cents: a.hourlyRateCents,
      p_callout_fee_cents: a.calloutFeeCents,
      p_remote_assist: a.remoteAssist,
    }),

  setConsent: (technicianId: string, consent: boolean) =>
    rpc<void>('skill_market_set_consent', { p_technician_id: technicianId, p_consent: consent }),

  setAvailability: (technicianId: string, availability: Availability, paused?: boolean) =>
    rpc<void>('skill_market_set_availability', {
      p_technician_id: technicianId,
      p_availability: availability,
      p_paused: paused ?? null,
    }),

  refreshEvidence: (technicianId: string) => rpc<void>('skill_market_refresh_mine', { p_technician_id: technicianId }),

  sendOffer: (a: {
    technicianId: string;
    title: string;
    summary: string;
    urgency: Urgency;
    requirements: Requirement[];
    matchScore: number | null;
    matchBreakdown: MarketCandidate['breakdown'];
    offeredRateCents: number | null;
    remote: boolean;
  }) =>
    rpc<string>('skill_market_send_offer', {
      p_technician_id: a.technicianId,
      p_title: a.title,
      p_summary: a.summary,
      p_urgency: a.urgency,
      p_requirements: requirementsToWire(a.requirements),
      p_match_score: a.matchScore,
      p_match_breakdown: a.matchBreakdown,
      p_offered_rate_cents: a.offeredRateCents,
      p_remote: a.remote,
    }),

  listOffers: () => rpc<MarketOffer[]>('skill_market_list_offers'),
  expireOffers: () => rpc<number>('skill_market_expire_offers'),
  respond: (offerId: string, accept: boolean) => rpc<void>('skill_market_respond_offer', { p_offer_id: offerId, p_accept: accept }),
  withdraw: (offerId: string) => rpc<void>('skill_market_withdraw_offer', { p_offer_id: offerId }),
  complete: (offerId: string, outcome: OfferOutcome, rating: number, note: string) =>
    rpc<void>('skill_market_complete_offer', { p_offer_id: offerId, p_outcome: outcome, p_rating: rating, p_note: note || null }),
};
