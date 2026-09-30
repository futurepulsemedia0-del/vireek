// Capacity Exchange — Liquidity Layer (client side).
//
// Two-sided market on top of Job Handoffs: waiting jobs (demand) meet idle
// technicians / vans (supply). Matching is scored server-side by
// compute_handoff_matches (see supabase/migrations/20270120000000_*.sql);
// this file holds the types, vocab, pure helpers and data access for it.
// Kept free of imports from contractorNetwork.ts to avoid a circular import.

import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// Vocabulary (slugs must match ^[a-z0-9_]{2,40}$ — enforced in SQL too)
// ---------------------------------------------------------------------------

export interface TagOption {
  value: string;
  label: string;
}

export const SKILL_OPTIONS: TagOption[] = [
  { value: 'refrigeration', label: 'Refrigeration' },
  { value: 'commercial_rtu', label: 'Commercial RTU' },
  { value: 'heat_pump', label: 'Heat pumps' },
  { value: 'vrf_vrv', label: 'VRF / VRV' },
  { value: 'chiller_boiler', label: 'Chillers & boilers' },
  { value: 'drain_cleaning', label: 'Drain cleaning' },
  { value: 'water_heater', label: 'Water heaters' },
  { value: 'backflow', label: 'Backflow' },
  { value: 'gas_line', label: 'Gas lines' },
  { value: 'panel_upgrade', label: 'Panel upgrades' },
  { value: 'ev_charger', label: 'EV chargers' },
  { value: 'generator', label: 'Generators' },
  { value: 'commercial_wiring', label: 'Commercial wiring' },
  { value: 'water_extraction', label: 'Water extraction' },
  { value: 'mold_remediation', label: 'Mold remediation' },
  { value: 'leak_detection', label: 'Leak detection' },
  { value: 'after_hours', label: 'After-hours response' },
];

export const EQUIPMENT_OPTIONS: TagOption[] = [
  { value: 'refrigerant_recovery', label: 'Refrigerant recovery' },
  { value: 'vacuum_pump', label: 'Vacuum pump' },
  { value: 'manifold_gauges', label: 'Manifold gauges' },
  { value: 'thermal_camera', label: 'Thermal camera' },
  { value: 'drain_camera', label: 'Drain camera' },
  { value: 'hydro_jet', label: 'Hydro jet' },
  { value: 'moisture_meter', label: 'Moisture meter' },
  { value: 'portable_generator', label: 'Portable generator' },
  { value: 'lift_boom', label: 'Lift / boom' },
  { value: 'brazing_kit', label: 'Brazing kit' },
];

export const CREDENTIAL_KINDS = ['insurance', 'license', 'certification', 'oem_authorization'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
export type CredentialStatus = 'self_declared' | 'verified' | 'rejected';

export const CREDENTIAL_KIND_LABELS: Record<CredentialKind, string> = {
  insurance: 'Insurance',
  license: 'License',
  certification: 'Certification',
  oem_authorization: 'OEM authorization',
};

export const SLA_OPTIONS: { value: number; label: string }[] = [
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
  { value: 240, label: '4 hours' },
  { value: 1440, label: '24 hours' },
];

export const WINDOW_OPTIONS: { hours: number; label: string }[] = [
  { hours: 8, label: 'Next 8 hours' },
  { hours: 24, label: 'Next 24 hours' },
  { hours: 72, label: 'Next 3 days' },
  { hours: 168, label: 'Next 7 days' },
];

// ---------------------------------------------------------------------------
// Types (mirror the SQL)
// ---------------------------------------------------------------------------

/** Points per factor. Sum of maxes = 100. Keep in sync with compute_handoff_matches. */
export const SCORE_FACTORS = [
  { key: 'geo', label: 'Location', max: 20 },
  { key: 'availability', label: 'Availability', max: 15 },
  { key: 'skills', label: 'Skills', max: 12 },
  { key: 'reliability', label: 'Reliability', max: 12 },
  { key: 'quality', label: 'Quality', max: 10 },
  { key: 'trust', label: 'Verified trust', max: 8 },
  { key: 'price', label: 'Price', max: 7 },
  { key: 'sla', label: 'Response SLA', max: 6 },
  { key: 'equipment', label: 'Equipment', max: 5 },
  { key: 'insurance', label: 'Insurance', max: 5 },
] as const;

export type ScoreBreakdown = Partial<Record<(typeof SCORE_FACTORS)[number]['key'], number>>;

export interface CapacityCapabilities {
  skills: string[];
  equipment: string[];
  service_regions: string[];
  hourly_rate_cents: number | null;
  sla_response_minutes: number | null;
}

export interface SetCapabilitiesInput {
  skills: string[];
  equipment: string[];
  serviceRegions: string[];
  hourlyRateCents: number | null;
  slaResponseMinutes: number | null;
}

export interface CapacityCredential {
  id: string;
  kind: CredentialKind;
  label: string;
  trade: string | null;
  expires_on: string | null;
  status: CredentialStatus;
  created_at: string;
}

export interface AddCredentialInput {
  kind: CredentialKind;
  label: string;
  trade: string | null;
  expiresOn: string | null;
}

export interface CapacityListing {
  id: string;
  trades: string[];
  technicians_available: number;
  vehicles_idle: number;
  available_from: string;
  available_until: string;
  hourly_rate_cents: number | null;
  note: string | null;
  status: 'active' | 'withdrawn' | 'expired';
  created_at: string;
}

export interface PublishListingInput {
  trades: string[];
  technicians: number;
  vehicles: number;
  availableFrom: string | null;
  availableUntil: string;
  hourlyRateCents: number | null;
  note: string;
}

export interface JobRequirements {
  skills: string[];
  equipment: string[];
  slaMinutes: number | null;
  maxHourlyRate: string; // dollars, free text, '' = no ceiling
  requiresInsurance: boolean;
}

export const emptyRequirements: JobRequirements = {
  skills: [],
  equipment: [],
  slaMinutes: null,
  maxHourlyRate: '',
  requiresInsurance: false,
};

export type MarketPosition = 'short_capacity' | 'surplus_capacity' | 'balanced';

export interface MarketRow {
  region: string;
  trade: string;
  jobs: number;
  value_cents: number;
  techs: number;
  vans: number;
}

export interface MarketPulse {
  generated_at: string;
  mine: {
    position: MarketPosition;
    waiting_jobs: number;
    active_claimed: number;
    max_concurrent: number;
    load_pct: number;
    active_listings: number;
    idle_technicians: number;
    idle_vehicles: number;
    open_jobs_for_my_listings: number;
  };
  network: {
    open_jobs: number;
    open_value_cents: number;
    available_technicians: number;
    idle_vehicles: number;
    members: number;
    median_minutes_to_accept_30d: number | null;
    fill_rate_30d_pct: number | null;
  };
  markets: MarketRow[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type MarketState = 'tight' | 'balanced' | 'surplus' | 'quiet';

/** demand/supply heat of one market bucket. */
export function marketState(jobs: number, technicians: number): MarketState {
  if (jobs <= 0 && technicians <= 0) return 'quiet';
  if (technicians <= 0) return 'tight';
  const ratio = jobs / technicians;
  if (ratio > 1.5) return 'tight';
  if (ratio < 0.5) return 'surplus';
  return 'balanced';
}

export const MARKET_STATE_LABELS: Record<MarketState, string> = {
  tight: 'Demand > supply',
  balanced: 'Balanced',
  surplus: 'Idle capacity',
  quiet: 'Quiet',
};

export const MARKET_STATE_COLORS: Record<MarketState, string> = {
  tight: 'bg-danger/10 text-danger',
  balanced: 'bg-success-500/10 text-success-500',
  surplus: 'bg-accent/10 text-accent',
  quiet: 'bg-bg-tertiary text-text-secondary',
};

export const POSITION_COPY: Record<MarketPosition, { title: string; body: string }> = {
  short_capacity: {
    title: 'You are short on capacity',
    body: 'You have jobs waiting or your team is near its limit. Post overflow jobs to the exchange.',
  },
  surplus_capacity: {
    title: 'You have idle capacity',
    body: 'Your listed technicians are available. Vireek prioritises you for matching jobs while your listing is live.',
  },
  balanced: {
    title: 'You are balanced',
    body: 'Nothing waiting and no idle capacity listed. Publish availability to start receiving matched jobs.',
  },
};

export function toggleInArray(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

/** "Austin, TX ; dallas" -> ['austin, tx', 'dallas'] (comma is part of a region, so split on ; or newline). */
export function parseRegionsInput(input: string): string[] {
  const seen = new Set<string>();
  for (const part of input.split(/[;\n]/)) {
    const v = part.trim().toLowerCase();
    if (v) seen.add(v);
  }
  return [...seen];
}

/** '85' | '85.50' | '$85' -> cents. '' -> null. Invalid -> NaN. */
export function parseRateToCents(input: string): number | null {
  const t = input.trim().replace(/^\$/, '');
  if (t === '') return null;
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * 100);
}

export function centsToRateInput(cents: number | null | undefined): string {
  return cents == null ? '' : (cents / 100).toFixed(2).replace(/\.00$/, '');
}

export function isCredentialActive(c: Pick<CapacityCredential, 'status' | 'expires_on'>, today: Date = new Date()): boolean {
  if (c.status === 'rejected') return false;
  if (!c.expires_on) return true;
  const day = today.toISOString().slice(0, 10);
  return c.expires_on >= day;
}

/** Highest-scoring factors relative to their max, for "why you were matched" copy. */
export function topFactors(b: ScoreBreakdown | null | undefined, n = 3): string[] {
  if (!b) return [];
  return SCORE_FACTORS.map((f) => ({ label: f.label, pct: (b[f.key] ?? 0) / f.max }))
    .filter((f) => f.pct >= 0.7)
    .sort((a, c) => c.pct - a.pct)
    .slice(0, n)
    .map((f) => f.label);
}

export function requirementsActive(r: JobRequirements): boolean {
  return (
    r.skills.length > 0 ||
    r.equipment.length > 0 ||
    r.slaMinutes !== null ||
    r.maxHourlyRate.trim() !== '' ||
    r.requiresInsurance
  );
}

export function formatWindow(fromIso: string, untilIso: string, now: number = Date.now()): string {
  const from = new Date(fromIso).getTime();
  const until = new Date(untilIso).getTime();
  const fmt = (t: number) =>
    new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return from > now ? `${fmt(from)} → ${fmt(until)}` : `Now → ${fmt(until)}`;
}

// ---------------------------------------------------------------------------
// Data access — every mutation is a SECURITY DEFINER RPC
// ---------------------------------------------------------------------------

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const liquidityApi = {
  pulse: () => rpc<MarketPulse>('get_market_pulse'),
  expireListings: () => rpc<number>('expire_capacity_listings'),

  /** RLS returns only my own profile row. */
  async getCapabilities(): Promise<CapacityCapabilities | null> {
    const { data, error } = await supabase
      .from('network_capacity_profiles')
      .select('skills, equipment, service_regions, hourly_rate_cents, sla_response_minutes')
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as CapacityCapabilities | null) ?? null;
  },

  setCapabilities: (i: SetCapabilitiesInput) =>
    rpc<void>('set_capacity_capabilities', {
      p_skills: i.skills,
      p_equipment: i.equipment,
      p_service_regions: i.serviceRegions,
      p_hourly_rate_cents: i.hourlyRateCents,
      p_sla_response_minutes: i.slaResponseMinutes,
    }),

  /** RLS returns only my own credentials. */
  async listCredentials(): Promise<CapacityCredential[]> {
    const { data, error } = await supabase
      .from('network_credentials')
      .select('id, kind, label, trade, expires_on, status, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return (data ?? []) as CapacityCredential[];
  },

  addCredential: (i: AddCredentialInput) =>
    rpc<string>('add_capacity_credential', {
      p_kind: i.kind,
      p_label: i.label,
      p_trade: i.trade,
      p_expires_on: i.expiresOn,
    }),

  removeCredential: (id: string) => rpc<void>('remove_capacity_credential', { p_id: id }),

  /** RLS returns only my own listings. */
  async listMyListings(): Promise<CapacityListing[]> {
    const { data, error } = await supabase
      .from('network_capacity_listings')
      .select('id, trades, technicians_available, vehicles_idle, available_from, available_until, hourly_rate_cents, note, status, created_at')
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    return (data ?? []) as CapacityListing[];
  },

  publishListing: (i: PublishListingInput) =>
    rpc<string>('publish_capacity_listing', {
      p_trades: i.trades,
      p_technicians: i.technicians,
      p_vehicles: i.vehicles,
      p_available_from: i.availableFrom,
      p_available_until: i.availableUntil,
      p_hourly_rate_cents: i.hourlyRateCents,
      p_note: i.note,
    }),

  withdrawListing: (id: string) => rpc<void>('withdraw_capacity_listing', { p_id: id }),

  /** Must run BEFORE capacityApi.computeMatches so the requirements gate the ranking. */
  setRequirements: (handoffId: string, r: JobRequirements) => {
    const rate = parseRateToCents(r.maxHourlyRate);
    return rpc<void>('set_handoff_requirements', {
      p_handoff_id: handoffId,
      p_skills: r.skills,
      p_equipment: r.equipment,
      p_sla_minutes: r.slaMinutes,
      p_max_hourly_rate_cents: rate !== null && Number.isFinite(rate) ? rate : null,
      p_requires_insurance: r.requiresInsurance,
    });
  },
};
