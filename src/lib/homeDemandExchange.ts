// Home Demand Exchange — pure engine (no I/O, fully unit-tested).
//
// signals -> detectors -> merge duplicates -> score + qualify -> rank
// technicians -> recommend a route into the EXISTING systems (Dispatch,
// Capacity Exchange, Labor Marketplace). The data layer lives in
// homeDemandExchangeApi.ts; persistence in
// supabase/migrations/20270415000000_home_demand_exchange.sql.
//
// Value and margin are ESTIMATES. They use the account's own completed-job
// average when there are enough samples, otherwise a conservative per-trade
// fallback table, and the UI labels them as estimates.

import type { TradeCategory } from '@/lib/laborMarketplace';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const DEMAND_SOURCES = [
  'property_condition',
  'equipment_health',
  'predicted_failure',
  'weather',
  'warranty',
  'permit',
  'rebate',
  'event',
] as const;
export type DemandSource = (typeof DEMAND_SOURCES)[number];

export const SOURCE_LABELS: Record<DemandSource, string> = {
  property_condition: 'Property condition',
  equipment_health: 'Equipment health',
  predicted_failure: 'Predicted failure',
  weather: 'Weather',
  warranty: 'Warranty',
  permit: 'Permit',
  rebate: 'Rebate',
  event: 'Market event',
};

export type DemandUrgency = 'low' | 'medium' | 'high' | 'critical';
export type DemandScope = 'property' | 'market';
export type DemandStatus = 'detected' | 'qualified' | 'matched' | 'converted' | 'dismissed' | 'expired';
export type JobKind = 'maintenance' | 'repair' | 'replacement' | 'inspection' | 'prep';
export type DemandRoute = 'dispatch' | 'capacity_exchange' | 'marketplace';

export const URGENCY_LABELS: Record<DemandUrgency, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export const URGENCY_COLORS: Record<DemandUrgency, string> = {
  low: 'bg-bg-tertiary text-text-secondary',
  medium: 'bg-accent/10 text-accent',
  high: 'bg-warning-500/10 text-warning-500',
  critical: 'bg-danger/10 text-danger',
};

export const STATUS_LABELS: Record<DemandStatus, string> = {
  detected: 'Detected',
  qualified: 'Qualified',
  matched: 'Matched',
  converted: 'Converted',
  dismissed: 'Dismissed',
  expired: 'Expired',
};

export const STATUS_COLORS: Record<DemandStatus, string> = {
  detected: 'bg-bg-tertiary text-text-secondary',
  qualified: 'bg-accent/10 text-accent',
  matched: 'bg-accent/10 text-accent',
  converted: 'bg-success-500/10 text-success-500',
  dismissed: 'bg-bg-tertiary text-text-secondary',
  expired: 'bg-danger/10 text-danger',
};

export const OPEN_STATUSES: DemandStatus[] = ['detected', 'qualified', 'matched'];

export const ROUTE_LABELS: Record<DemandRoute, string> = {
  dispatch: 'Dispatch in-house',
  capacity_exchange: 'Post to Capacity Exchange',
  marketplace: 'Source via Labor Marketplace',
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const YEAR_MS = 365.25 * DAY_MS;

const clamp = (n: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, n));
const toMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};
const iso = (ms: number): string => new Date(ms).toISOString();
const ymd = (ms: number): string => iso(ms).slice(0, 10);

// ---------------------------------------------------------------------------
// Signal shapes (what the data layer gathers)
// ---------------------------------------------------------------------------

export interface CustomerRef {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
}

export interface EquipmentSignal {
  id: string;
  customer_id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_date: string | null;
  warranty_expires_at: string | null;
  expected_lifespan_years: number;
  service_interval_months: number;
  last_service_date: string | null;
}

export interface FailurePredictionSignal {
  id: string;
  equipment_id: string;
  failure_label: string;
  probability: number;
  confidence: number;
  horizon_days: number;
  recommended_action: string | null;
}

export interface WeatherSignal {
  id: string;
  event_type: string;
  severity: string | null;
  headline: string | null;
  area_desc: string | null;
  effective_at: string | null;
  expires_at: string | null;
}

export interface PermitSignal {
  id: string;
  customer_id: string | null;
  site_id: string | null;
  permit_type: string;
  status: string;
  expires_on: string | null;
  final_inspection_on: string | null;
  description: string | null;
}

export interface RebateSignal {
  id: string;
  customer_id: string;
  equipment_id: string | null;
  total_expected_cents: number;
  install_target_date: string | null;
  created_at: string;
}

export interface MeshSignal {
  id: string;
  event_kind: string;
  level: 'low' | 'elevated' | 'high' | 'critical';
  probability: number;
  window_start: string;
  window_end: string;
}

export interface PropertySignal {
  customer_id: string;
  site_id: string | null;
  year_built: number | null;
  heating_fuel: string | null;
}

export interface OpenJobRef {
  customer_id: string | null;
  service_type: string | null;
  scheduled_datetime: string | null;
  job_status: string;
}

export interface DemandSignals {
  now: number;
  customers: Record<string, CustomerRef>;
  equipment: EquipmentSignal[];
  predictions: FailurePredictionSignal[];
  weather: WeatherSignal[];
  permits: PermitSignal[];
  rebates: RebateSignal[];
  mesh: MeshSignal[];
  properties: PropertySignal[];
  openJobs: OpenJobRef[];
  /** Average invoiced ticket (cents) from the account's own completed jobs. */
  avgTicketCents: number | null;
  ticketSamples: number;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export interface QualificationGate {
  key: 'contactable' | 'value' | 'confidence' | 'score' | 'no_conflict';
  label: string;
  passed: boolean;
  detail: string;
}

export interface Evidence {
  label: string;
  detail: string;
}

export interface DemandCandidate {
  dedupe_key: string;
  source_kind: DemandSource;
  source_ref: string | null;
  scope: DemandScope;
  customer_id: string | null;
  customer_name: string | null;
  site_id: string | null;
  equipment_id: string | null;
  title: string;
  summary: string;
  trade_category: TradeCategory;
  service_label: string;
  skill: string | null;
  location_label: string | null;
  address: string | null;
  urgency: DemandUrgency;
  demand_score: number;
  confidence: number;
  est_value_cents: number;
  est_margin_pct: number | null;
  window_start: string;
  window_end: string;
  qualified: boolean;
  qualification: QualificationGate[];
  evidence: Evidence[];
}

/** Detector output before scoring/qualification. */
interface RawCandidate {
  dedupe_key: string;
  source_kind: DemandSource;
  source_ref: string | null;
  scope: DemandScope;
  customer_id: string | null;
  site_id: string | null;
  equipment_id: string | null;
  title: string;
  summary: string;
  trade: TradeCategory;
  service_label: string;
  skill: string | null;
  kind: JobKind;
  /** 0..1 — how severe / time-critical the underlying signal is. */
  severity: number;
  confidence: number;
  window_start: number;
  window_end: number;
  evidence: Evidence[];
  valueOverrideCents?: number;
}

// ---------------------------------------------------------------------------
// Value & margin model (estimates)
// ---------------------------------------------------------------------------

const FALLBACK_TICKET_CENTS: Record<TradeCategory, Record<JobKind, number>> = {
  hvac: { maintenance: 18_900, repair: 42_000, replacement: 950_000, inspection: 14_900, prep: 24_900 },
  plumbing: { maintenance: 14_900, repair: 38_000, replacement: 180_000, inspection: 12_900, prep: 19_900 },
  electrical: { maintenance: 15_900, repair: 36_000, replacement: 420_000, inspection: 14_900, prep: 29_900 },
  roofing: { maintenance: 29_900, repair: 95_000, replacement: 1_100_000, inspection: 24_900, prep: 49_900 },
  restoration: { maintenance: 49_900, repair: 180_000, replacement: 900_000, inspection: 39_900, prep: 69_900 },
  locksmith: { maintenance: 9_900, repair: 21_000, replacement: 45_000, inspection: 9_900, prep: 14_900 },
  general: { maintenance: 14_900, repair: 32_000, replacement: 250_000, inspection: 12_900, prep: 19_900 },
};

const DEFAULT_MARGIN_PCT: Record<JobKind, number> = {
  maintenance: 58,
  repair: 48,
  replacement: 34,
  inspection: 62,
  prep: 45,
};

const MIN_TICKET_SAMPLES = 5;

export function estimateValueCents(
  trade: TradeCategory,
  kind: JobKind,
  avgTicketCents: number | null,
  ticketSamples: number,
): number {
  if (kind === 'repair' && avgTicketCents && ticketSamples >= MIN_TICKET_SAMPLES) {
    return Math.round(clamp(avgTicketCents, 5_000, 5_000_000));
  }
  return FALLBACK_TICKET_CENTS[trade][kind];
}

// ---------------------------------------------------------------------------
// Equipment helpers
// ---------------------------------------------------------------------------

export function equipmentTrade(type: string): { trade: TradeCategory; skill: string | null; label: string } {
  const t = type.toLowerCase();
  if (/(water.?heater|tankless)/.test(t)) return { trade: 'plumbing', skill: 'water_heater', label: 'Water heater' };
  if (/(boiler)/.test(t)) return { trade: 'hvac', skill: 'chiller_boiler', label: 'Boiler' };
  if (/(heat.?pump)/.test(t)) return { trade: 'hvac', skill: 'heat_pump', label: 'Heat pump' };
  if (/(furnace|a\/?c|air.?cond|condens|hvac|rtu|mini.?split|chiller)/.test(t)) {
    return { trade: 'hvac', skill: null, label: type };
  }
  if (/(panel|breaker|electrical)/.test(t)) return { trade: 'electrical', skill: 'panel_upgrade', label: 'Electrical panel' };
  if (/(generator)/.test(t)) return { trade: 'electrical', skill: 'generator', label: 'Generator' };
  if (/(ev.?charger)/.test(t)) return { trade: 'electrical', skill: 'ev_charger', label: 'EV charger' };
  if (/(roof|shingle)/.test(t)) return { trade: 'roofing', skill: null, label: 'Roof' };
  if (/(sump|pump|plumb|pipe|softener|backflow)/.test(t)) return { trade: 'plumbing', skill: null, label: type };
  return { trade: 'general', skill: null, label: type };
}

function equipmentName(e: EquipmentSignal): string {
  return [e.make, e.model].filter(Boolean).join(' ') || e.equipment_type;
}

// ---------------------------------------------------------------------------
// Weather → trade profiles
// ---------------------------------------------------------------------------

interface WeatherProfile {
  match: RegExp;
  trade: TradeCategory;
  skill: string | null;
  headline: string;
  service: string;
}

const WEATHER_PROFILES: WeatherProfile[] = [
  { match: /(heat|hot)/i, trade: 'hvac', skill: null, headline: 'Heat wave: cooling failures expected', service: 'Pre-heat-wave cooling check' },
  { match: /(freeze|frost|winter|ice|cold|blizzard|snow)/i, trade: 'plumbing', skill: 'leak_detection', headline: 'Freeze risk: burst-pipe and heating calls expected', service: 'Freeze-protection check' },
  { match: /(flood|rain|storm surge)/i, trade: 'restoration', skill: 'water_extraction', headline: 'Flood risk: water-damage calls expected', service: 'Flood readiness inspection' },
  { match: /(wind|tornado|hail|hurricane|tropical)/i, trade: 'roofing', skill: null, headline: 'High wind / hail: roof damage expected', service: 'Storm roof inspection' },
  { match: /(thunder|lightning|power)/i, trade: 'electrical', skill: 'generator', headline: 'Severe storms: outage and surge calls expected', service: 'Surge and backup-power check' },
];

export function weatherProfile(eventType: string): WeatherProfile | null {
  return WEATHER_PROFILES.find((p) => p.match.test(eventType)) ?? null;
}

const SEVERITY_WEIGHT: Record<string, number> = { extreme: 1, severe: 0.8, moderate: 0.55, minor: 0.35, unknown: 0.4 };

// ---------------------------------------------------------------------------
// Detectors (pure)
// ---------------------------------------------------------------------------

function detectEquipmentHealth(s: DemandSignals): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const e of s.equipment) {
    const cust = s.customers[e.customer_id];
    if (!cust) continue;
    const { trade, skill, label } = equipmentTrade(e.equipment_type);
    const name = equipmentName(e);

    // Replacement: age vs expected lifespan
    const installMs = toMs(e.install_date);
    if (installMs !== null && e.expected_lifespan_years > 0) {
      const ageYears = (s.now - installMs) / YEAR_MS;
      const ratio = ageYears / e.expected_lifespan_years;
      if (ratio >= 0.85) {
        out.push({
          dedupe_key: `eq:${e.id}:replace`,
          source_kind: 'equipment_health',
          source_ref: e.id,
          scope: 'property',
          customer_id: e.customer_id,
          site_id: null,
          equipment_id: e.id,
          title: `${label} near end of life — ${cust.name}`,
          summary: `${name} is ${ageYears.toFixed(1)} years old against an expected ${e.expected_lifespan_years}-year life. Replacement is likely within the next season.`,
          trade,
          service_label: `${label} replacement`,
          skill,
          kind: 'replacement',
          severity: clamp(0.45 + (ratio - 0.85) * 1.5),
          confidence: clamp(0.55 + Math.min(0.3, (ratio - 0.85) * 0.8)),
          window_start: s.now,
          window_end: s.now + 180 * DAY_MS,
          evidence: [{ label: 'Age', detail: `${ageYears.toFixed(1)} of ${e.expected_lifespan_years} expected years (${Math.round(ratio * 100)}%)` }],
        });
      }
    }

    // Service overdue
    const lastMs = toMs(e.last_service_date) ?? installMs;
    if (lastMs !== null && e.service_interval_months > 0) {
      const dueMs = lastMs + e.service_interval_months * 30.4375 * DAY_MS;
      const overdueDays = (s.now - dueMs) / DAY_MS;
      if (overdueDays >= 0) {
        out.push({
          dedupe_key: `eq:${e.id}:service:${ymd(dueMs)}`,
          source_kind: 'equipment_health',
          source_ref: e.id,
          scope: 'property',
          customer_id: e.customer_id,
          site_id: null,
          equipment_id: e.id,
          title: `${label} service overdue — ${cust.name}`,
          summary: `${name} was due for service ${Math.round(overdueDays)} days ago (every ${e.service_interval_months} months).`,
          trade,
          service_label: `${label} maintenance`,
          skill,
          kind: 'maintenance',
          severity: clamp(0.3 + overdueDays / 365),
          confidence: 0.85,
          window_start: s.now,
          window_end: s.now + 60 * DAY_MS,
          evidence: [{ label: 'Service interval', detail: `Due ${ymd(dueMs)}; ${Math.round(overdueDays)} days overdue` }],
        });
      }
    }
  }
  return out;
}

function detectPredictedFailures(s: DemandSignals): RawCandidate[] {
  const out: RawCandidate[] = [];
  const byEquipment = new Map(s.equipment.map((e) => [e.id, e]));
  for (const p of s.predictions) {
    const e = byEquipment.get(p.equipment_id);
    const cust = e ? s.customers[e.customer_id] : undefined;
    if (!e || !cust || p.probability < 0.4) continue;
    const { trade, skill, label } = equipmentTrade(e.equipment_type);
    const urgent = p.horizon_days <= 14 ? 0.2 : p.horizon_days <= 45 ? 0.1 : 0;
    out.push({
      dedupe_key: `pred:${p.id}`,
      source_kind: 'predicted_failure',
      source_ref: p.id,
      scope: 'property',
      customer_id: e.customer_id,
      site_id: null,
      equipment_id: e.id,
      title: `${p.failure_label} likely — ${cust.name}`,
      summary: `${Math.round(p.probability * 100)}% chance of "${p.failure_label}" on ${equipmentName(e)} within ${p.horizon_days} days.${p.recommended_action ? ` Suggested: ${p.recommended_action}` : ''}`,
      trade,
      service_label: `${label} repair`,
      skill,
      kind: 'repair',
      severity: clamp(p.probability + urgent),
      confidence: clamp(p.confidence),
      window_start: s.now,
      window_end: s.now + Math.max(7, p.horizon_days) * DAY_MS,
      evidence: [
        { label: 'Prediction', detail: `${Math.round(p.probability * 100)}% within ${p.horizon_days} days` },
        { label: 'Model confidence', detail: `${Math.round(p.confidence * 100)}%` },
      ],
    });
  }
  return out;
}

function detectWarranties(s: DemandSignals): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const e of s.equipment) {
    const cust = s.customers[e.customer_id];
    const expMs = toMs(e.warranty_expires_at);
    if (!cust || expMs === null) continue;
    const daysLeft = (expMs - s.now) / DAY_MS;
    if (daysLeft < 0 || daysLeft > 60) continue;
    const { trade, skill, label } = equipmentTrade(e.equipment_type);
    out.push({
      dedupe_key: `war:${e.id}:${e.warranty_expires_at}`,
      source_kind: 'warranty',
      source_ref: e.id,
      scope: 'property',
      customer_id: e.customer_id,
      site_id: null,
      equipment_id: e.id,
      title: `Warranty ending — ${cust.name}`,
      summary: `Warranty on ${equipmentName(e)} ends in ${Math.max(0, Math.round(daysLeft))} days. An inspection now lets any defect be claimed before coverage lapses.`,
      trade,
      service_label: `${label} pre-expiry inspection`,
      skill,
      kind: 'inspection',
      severity: clamp(0.8 - daysLeft / 90),
      confidence: 0.8,
      window_start: s.now,
      window_end: Math.max(s.now + DAY_MS, expMs),
      evidence: [{ label: 'Warranty', detail: `Expires ${e.warranty_expires_at}` }],
    });
  }
  return out;
}

const PERMIT_TRADE: Record<string, TradeCategory> = {
  mechanical: 'hvac',
  electrical: 'electrical',
  plumbing: 'plumbing',
  gas: 'plumbing',
  roofing: 'roofing',
};

function detectPermits(s: DemandSignals): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const p of s.permits) {
    const cust = p.customer_id ? s.customers[p.customer_id] : undefined;
    if (!cust) continue;
    const trade = PERMIT_TRADE[p.permit_type] ?? 'general';
    const expMs = toMs(p.expires_on);
    const daysLeft = expMs === null ? null : (expMs - s.now) / DAY_MS;
    const failed = p.status === 'failed';
    const expiring = (p.status === 'issued' || p.status === 'inspection_pending') && daysLeft !== null && daysLeft >= 0 && daysLeft <= 30;
    if (!failed && !expiring) continue;
    out.push({
      dedupe_key: `permit:${p.id}:${p.status}`,
      source_kind: 'permit',
      source_ref: p.id,
      scope: 'property',
      customer_id: p.customer_id,
      site_id: p.site_id,
      equipment_id: null,
      title: failed ? `Failed inspection needs rework — ${cust.name}` : `Permit expiring without final inspection — ${cust.name}`,
      summary: failed
        ? `The ${p.permit_type} permit${p.description ? ` (${p.description})` : ''} failed inspection. Corrections and a re-inspection are needed.`
        : `The ${p.permit_type} permit expires in ${Math.round(daysLeft ?? 0)} days and has not passed final inspection.`,
      trade,
      service_label: failed ? `${p.permit_type} rework and re-inspection` : `${p.permit_type} final inspection`,
      skill: null,
      kind: failed ? 'repair' : 'inspection',
      severity: failed ? 0.8 : clamp(0.75 - (daysLeft ?? 30) / 60),
      confidence: 0.9,
      window_start: s.now,
      window_end: expMs !== null ? Math.max(s.now + 3 * DAY_MS, expMs) : s.now + 30 * DAY_MS,
      evidence: [{ label: 'Permit', detail: `${p.permit_type} · ${p.status.replace('_', ' ')}${p.expires_on ? ` · expires ${p.expires_on}` : ''}` }],
    });
  }
  return out;
}

function detectRebates(s: DemandSignals): RawCandidate[] {
  const out: RawCandidate[] = [];
  const latest = new Map<string, RebateSignal>();
  for (const r of s.rebates) {
    const prev = latest.get(r.customer_id);
    if (!prev || r.created_at > prev.created_at) latest.set(r.customer_id, r);
  }
  const byEquipment = new Map(s.equipment.map((e) => [e.id, e]));
  for (const r of latest.values()) {
    const cust = s.customers[r.customer_id];
    if (!cust || r.total_expected_cents < 20_000) continue;
    const targetMs = toMs(r.install_target_date);
    if (targetMs !== null && targetMs < s.now - 14 * DAY_MS) continue;
    const e = r.equipment_id ? byEquipment.get(r.equipment_id) : undefined;
    const { trade, skill, label } = e ? equipmentTrade(e.equipment_type) : { trade: 'hvac' as TradeCategory, skill: null, label: 'Efficiency upgrade' };
    out.push({
      dedupe_key: `rebate:${r.id}`,
      source_kind: 'rebate',
      source_ref: r.id,
      scope: 'property',
      customer_id: r.customer_id,
      site_id: null,
      equipment_id: e?.id ?? null,
      title: `Rebate-funded upgrade — ${cust.name}`,
      summary: `About $${Math.round(r.total_expected_cents / 100).toLocaleString()} in expected rebates lowers the customer's net cost for a ${label.toLowerCase()} upgrade.`,
      trade,
      service_label: `${label} upgrade`,
      skill,
      kind: 'replacement',
      severity: clamp(0.4 + r.total_expected_cents / 400_000),
      confidence: 0.65,
      window_start: s.now,
      window_end: targetMs !== null ? Math.max(s.now + 7 * DAY_MS, targetMs) : s.now + 120 * DAY_MS,
      evidence: [{ label: 'Expected rebates', detail: `$${Math.round(r.total_expected_cents / 100).toLocaleString()}` }],
    });
  }
  return out;
}

function detectPropertyCondition(s: DemandSignals): RawCandidate[] {
  const out: RawCandidate[] = [];
  const serviced = new Map<string, number>();
  for (const e of s.equipment) {
    const t = toMs(e.last_service_date);
    if (t !== null) serviced.set(e.customer_id, Math.max(serviced.get(e.customer_id) ?? 0, t));
  }
  for (const p of s.properties) {
    const cust = s.customers[p.customer_id];
    if (!cust || p.year_built === null) continue;
    const age = new Date(s.now).getUTCFullYear() - p.year_built;
    if (age < 40) continue;
    const last = serviced.get(p.customer_id) ?? 0;
    const stale = last === 0 || s.now - last > 2 * YEAR_MS;
    if (!stale) continue;
    out.push({
      dedupe_key: `prop:${p.customer_id}:legacy`,
      source_kind: 'property_condition',
      source_ref: p.customer_id,
      scope: 'property',
      customer_id: p.customer_id,
      site_id: p.site_id,
      equipment_id: null,
      title: `${age}-year-old home with no recent service — ${cust.name}`,
      summary: `Built ${p.year_built} and no recorded service in 2+ years. A whole-home systems check is a low-friction way in.`,
      trade: 'general',
      service_label: 'Whole-home systems inspection',
      skill: null,
      kind: 'inspection',
      severity: clamp(0.25 + (age - 40) / 120),
      confidence: 0.5,
      window_start: s.now,
      window_end: s.now + 90 * DAY_MS,
      evidence: [
        { label: 'Home age', detail: `Built ${p.year_built} (${age} years)` },
        { label: 'Last service', detail: last === 0 ? 'None recorded' : ymd(last) },
      ],
    });
  }
  return out;
}

function detectWeather(s: DemandSignals): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const w of s.weather) {
    const profile = weatherProfile(w.event_type);
    const endMs = toMs(w.expires_at);
    if (!profile || (endMs !== null && endMs < s.now)) continue;
    const sev = SEVERITY_WEIGHT[(w.severity ?? 'unknown').toLowerCase()] ?? 0.4;
    // Exposure = active equipment of the matching trade the account already services.
    const exposed = s.equipment.filter((e) => equipmentTrade(e.equipment_type).trade === profile.trade).length;
    const hit = sev >= 0.8 ? 0.15 : sev >= 0.55 ? 0.1 : 0.05;
    const valueOverrideCents = Math.round(exposed * hit) * FALLBACK_TICKET_CENTS[profile.trade].repair;
    out.push({
      dedupe_key: `wx:${w.id}:${profile.trade}`,
      source_kind: 'weather',
      source_ref: w.id,
      scope: 'market',
      customer_id: null,
      site_id: null,
      equipment_id: null,
      title: profile.headline,
      summary: `${w.headline ?? w.event_type}${w.area_desc ? ` — ${w.area_desc}` : ''}. ${exposed} ${profile.trade} assets in your customer base are exposed.`,
      trade: profile.trade,
      service_label: profile.service,
      skill: profile.skill,
      kind: 'prep',
      severity: sev,
      confidence: 0.75,
      window_start: toMs(w.effective_at) ?? s.now,
      window_end: endMs ?? s.now + 3 * DAY_MS,
      evidence: [
        { label: 'Alert', detail: `${w.event_type}${w.severity ? ` · ${w.severity}` : ''}` },
        { label: 'Modeled exposure', detail: `${exposed} assets × ${Math.round(hit * 100)}% expected call rate` },
      ],
      valueOverrideCents,
    });
  }
  return out;
}

const MESH_LEVEL: Record<MeshSignal['level'], number> = { low: 0.2, elevated: 0.5, high: 0.75, critical: 0.95 };

function detectMarketEvents(s: DemandSignals): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const m of s.mesh) {
    if (m.level === 'low' || (m.event_kind !== 'demand_spike' && m.event_kind !== 'dispatch_pressure')) continue;
    const endMs = toMs(m.window_end);
    if (endMs === null || endMs < s.now) continue;
    out.push({
      dedupe_key: `mesh:${m.id}`,
      source_kind: 'event',
      source_ref: m.id,
      scope: 'market',
      customer_id: null,
      site_id: null,
      equipment_id: null,
      title: m.event_kind === 'demand_spike' ? 'Demand spike forecast' : 'Dispatch pressure forecast',
      summary: `Event Prediction Mesh rates this ${m.level} (${Math.round(m.probability * 100)}% probability). Line up capacity before it lands.`,
      trade: 'general',
      service_label: 'Surge capacity planning',
      skill: null,
      kind: 'prep',
      severity: MESH_LEVEL[m.level],
      confidence: clamp(m.probability),
      window_start: toMs(m.window_start) ?? s.now,
      window_end: endMs,
      evidence: [{ label: 'Prediction mesh', detail: `${m.event_kind.replace('_', ' ')} · ${m.level}` }],
      valueOverrideCents: 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Duplicate merge — one opportunity per asset/trade, strongest signal wins
// ---------------------------------------------------------------------------

function mergeDuplicates(raws: RawCandidate[]): RawCandidate[] {
  const winners = new Map<string, RawCandidate>();
  const result: RawCandidate[] = [];
  for (const r of raws) {
    if (r.scope === 'market') {
      result.push(r);
      continue;
    }
    const group = `${r.equipment_id ?? r.customer_id ?? r.source_ref}:${r.trade}`;
    const prev = winners.get(group);
    if (!prev) {
      winners.set(group, r);
      continue;
    }
    const [win, lose] = rawStrength(r) > rawStrength(prev) ? [r, prev] : [prev, r];
    winners.set(group, {
      ...win,
      evidence: [
        ...win.evidence,
        { label: `Also flagged by ${SOURCE_LABELS[lose.source_kind].toLowerCase()}`, detail: lose.title },
        ...lose.evidence,
      ],
    });
  }
  return [...result, ...winners.values()];
}

const KIND_RANK: Record<JobKind, number> = { repair: 5, replacement: 4, inspection: 3, maintenance: 2, prep: 1 };
const rawStrength = (r: RawCandidate): number => r.severity * 100 + KIND_RANK[r.kind];

// ---------------------------------------------------------------------------
// Scoring & qualification
// ---------------------------------------------------------------------------

export function urgencyFromSeverity(severity: number): DemandUrgency {
  if (severity >= 0.85) return 'critical';
  if (severity >= 0.65) return 'high';
  if (severity >= 0.4) return 'medium';
  return 'low';
}

export function scoreDemand(input: {
  severity: number;
  confidence: number;
  estValueCents: number;
  daysToWindowStart: number;
}): number {
  const valueNorm = Math.sqrt(clamp(input.estValueCents / 1_000_000));
  const timeliness = clamp(1 - Math.max(0, input.daysToWindowStart) / 100, 0.3, 1);
  return Math.round(100 * (0.4 * clamp(input.severity) + 0.25 * clamp(input.confidence) + 0.2 * valueNorm + 0.15 * timeliness));
}

const TRADE_TOKENS: Record<TradeCategory, RegExp> = {
  hvac: /(hvac|heat|cool|furnace|\bac\b|a\/c|air|boiler)/i,
  plumbing: /(plumb|water|drain|pipe|leak|gas)/i,
  electrical: /(electr|panel|wiring|generator|charger)/i,
  roofing: /(roof|shingle)/i,
  restoration: /(restor|mold|extract|flood)/i,
  locksmith: /(lock|key)/i,
  general: /./,
};

export function jobMatchesTrade(serviceType: string | null, trade: TradeCategory): boolean {
  if (!serviceType) return true; // an untyped open job still blocks a duplicate pitch
  return TRADE_TOKENS[trade].test(serviceType);
}

function buildGates(
  raw: RawCandidate,
  cust: CustomerRef | undefined,
  value: number,
  score: number,
  s: DemandSignals,
): QualificationGate[] {
  const contactable = !!(cust && (cust.phone || cust.email));
  const conflict = s.openJobs.find(
    (j) =>
      j.customer_id === raw.customer_id &&
      jobMatchesTrade(j.service_type, raw.trade) &&
      ['scheduled', 'en_route', 'in_progress'].includes(j.job_status),
  );
  return [
    {
      key: 'contactable',
      label: 'Customer reachable',
      passed: contactable,
      detail: contactable ? 'Phone or email on file' : 'No phone or email on file',
    },
    {
      key: 'value',
      label: 'Worth pursuing',
      passed: value >= 10_000,
      detail: `Estimated ${(value / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}`,
    },
    {
      key: 'confidence',
      label: 'Signal confidence',
      passed: raw.confidence >= 0.35,
      detail: `${Math.round(raw.confidence * 100)}% confidence`,
    },
    { key: 'score', label: 'Demand score', passed: score >= 40, detail: `Score ${score}/100 (needs 40)` },
    {
      key: 'no_conflict',
      label: 'No overlapping job',
      passed: !conflict,
      detail: conflict ? 'Customer already has an open job for this trade' : 'No open job for this trade',
    },
  ];
}

function finalize(raw: RawCandidate, s: DemandSignals): DemandCandidate {
  const cust = raw.customer_id ? s.customers[raw.customer_id] : undefined;
  const value =
    raw.valueOverrideCents ?? estimateValueCents(raw.trade, raw.kind, s.avgTicketCents, s.ticketSamples);
  const score = scoreDemand({
    severity: raw.severity,
    confidence: raw.confidence,
    estValueCents: value,
    daysToWindowStart: (raw.window_start - s.now) / DAY_MS,
  });
  const gates = raw.scope === 'property' ? buildGates(raw, cust, value, score, s) : [];
  const evidence: Evidence[] = [...raw.evidence];
  if (raw.valueOverrideCents === undefined && raw.kind === 'repair' && s.avgTicketCents && s.ticketSamples >= MIN_TICKET_SAMPLES) {
    evidence.push({ label: 'Value basis', detail: `Average of your last ${s.ticketSamples} completed jobs` });
  }
  return {
    dedupe_key: raw.dedupe_key,
    source_kind: raw.source_kind,
    source_ref: raw.source_ref,
    scope: raw.scope,
    customer_id: raw.customer_id,
    customer_name: cust?.name ?? null,
    site_id: raw.site_id,
    equipment_id: raw.equipment_id,
    title: raw.title.slice(0, 160),
    summary: raw.summary.slice(0, 1000),
    trade_category: raw.trade,
    service_label: raw.service_label.slice(0, 80),
    skill: raw.skill,
    location_label: null,
    address: cust?.address ?? null,
    urgency: urgencyFromSeverity(raw.severity),
    demand_score: score,
    confidence: Math.round(clamp(raw.confidence) * 1000) / 1000,
    est_value_cents: Math.max(0, Math.round(value)),
    est_margin_pct: raw.scope === 'property' ? DEFAULT_MARGIN_PCT[raw.kind] : null,
    window_start: iso(raw.window_start),
    window_end: iso(Math.max(raw.window_end, raw.window_start)),
    qualified: raw.scope === 'property' && gates.every((g) => g.passed),
    qualification: gates,
    evidence,
  };
}

/** Runs every detector, merges duplicates, scores and qualifies. Best first. */
export function detectDemand(signals: DemandSignals): DemandCandidate[] {
  const raws = mergeDuplicates([
    ...detectEquipmentHealth(signals),
    ...detectPredictedFailures(signals),
    ...detectWarranties(signals),
    ...detectPermits(signals),
    ...detectRebates(signals),
    ...detectPropertyCondition(signals),
    ...detectWeather(signals),
    ...detectMarketEvents(signals),
  ]);
  return raws.map((r) => finalize(r, signals)).sort((a, b) => b.demand_score - a.demand_score);
}

// ---------------------------------------------------------------------------
// Technician matching
// ---------------------------------------------------------------------------

export interface TechnicianSignal {
  id: string;
  name: string;
  role: string;
  skills: string[];
  service_area: string | null;
  max_jobs_per_day: number;
  dispatch_enabled: boolean;
  hourly_cost_rate_cents: number | null;
  home_latitude: number | null;
  home_longitude: number | null;
  current_latitude: number | null;
  current_longitude: number | null;
  location_updated_at: string | null;
}

export interface TechJobRef {
  scheduled_datetime: string | null;
  job_status: string;
  customer_id: string | null;
}

export type FactorKey =
  | 'skill'
  | 'location'
  | 'availability'
  | 'capacity'
  | 'quality'
  | 'price'
  | 'margin'
  | 'customer_fit';

export const FACTOR_WEIGHTS: Record<FactorKey, number> = {
  skill: 22,
  location: 18,
  availability: 14,
  capacity: 12,
  quality: 12,
  price: 6,
  margin: 8,
  customer_fit: 8,
};

export const FACTOR_LABELS: Record<FactorKey, string> = {
  skill: 'Skill',
  location: 'Location',
  availability: 'Availability',
  capacity: 'Capacity',
  quality: 'Quality',
  price: 'Labor price',
  margin: 'Margin',
  customer_fit: 'Customer fit',
};

export interface MatchFactor {
  key: FactorKey;
  label: string;
  weight: number;
  /** 0..1 */
  score: number;
  detail: string;
}

export interface TechMatch {
  technician_id: string;
  name: string;
  /** 0..100 */
  score: number;
  eligible: boolean;
  blockers: string[];
  factors: MatchFactor[];
  est_margin_pct: number | null;
}

export interface MatchContext {
  now: number;
  /** When the work should happen (ms). */
  targetMs: number;
  trade: TradeCategory;
  skill: string | null;
  serviceLabel: string;
  address: string | null;
  customerId: string | null;
  site: { lat: number; lng: number } | null;
  estValueCents: number;
  estMarginPct: number | null;
  durationMinutes: number;
}

const OPEN_JOB = ['scheduled', 'en_route', 'in_progress'];
const FRESH_LOCATION_MS = 6 * HOUR_MS;
const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function skillTokens(ctx: MatchContext): string[] {
  const tokens = [ctx.trade, ctx.skill ?? '', ...ctx.serviceLabel.toLowerCase().split(/[^a-z0-9]+/)];
  return tokens.filter((t) => t.length >= 3);
}

function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Ranks technicians for one opportunity. Eligible candidates first, then by score. */
export function rankTechnicians(
  ctx: MatchContext,
  technicians: TechnicianSignal[],
  jobsByTech: Record<string, TechJobRef[]>,
): TechMatch[] {
  const pool = technicians.filter((t) => t.role === 'technician');
  const medianCost = medianOf(pool.map((t) => t.hourly_cost_rate_cents).filter((c): c is number => !!c && c > 0));
  const tokens = skillTokens(ctx);
  const hours = ctx.durationMinutes / 60;

  const matches = pool.map((t): TechMatch => {
    const jobs = jobsByTech[t.id] ?? [];
    const blockers: string[] = [];
    if (!t.dispatch_enabled) blockers.push('Dispatch is disabled for this technician');

    const open = jobs.filter((j) => OPEN_JOB.includes(j.job_status));
    const dayLoad = open.filter((j) => {
      const ms = toMs(j.scheduled_datetime);
      return ms !== null && sameDay(ms, ctx.targetMs);
    }).length;
    const maxPerDay = Math.max(1, t.max_jobs_per_day || 6);
    if (dayLoad >= maxPerDay) blockers.push(`At capacity that day (${dayLoad}/${maxPerDay})`);

    // skill
    const owned = t.skills.map((x) => x.toLowerCase());
    let skill = 0.5;
    let skillDetail = 'No skills listed — treated as neutral';
    if (owned.length > 0) {
      const hit = owned.some((o) => tokens.some((tok) => o.includes(tok) || tok.includes(o)));
      skill = hit ? 1 : 0.1;
      skillDetail = hit ? 'Skill on file matches this work' : `No listed skill for ${ctx.serviceLabel}`;
    }

    // location
    let location = 0.5;
    let locationDetail = 'No location data — treated as neutral';
    const locMs = toMs(t.location_updated_at);
    const live = locMs !== null && ctx.now - locMs <= FRESH_LOCATION_MS && t.current_latitude !== null && t.current_longitude !== null;
    const originLat = live ? t.current_latitude : t.home_latitude;
    const originLng = live ? t.current_longitude : t.home_longitude;
    if (ctx.site && originLat !== null && originLng !== null) {
      const km = haversineKm(ctx.site, { lat: originLat, lng: originLng });
      location = clamp(1 - Math.max(0, km - 5) / 75);
      locationDetail = `${km.toFixed(1)} km from ${live ? 'current position' : 'home base'}`;
    } else if (t.service_area && ctx.address && ctx.address.toLowerCase().includes(t.service_area.toLowerCase())) {
      location = 0.8;
      locationDetail = `Covers ${t.service_area}`;
    }

    // availability (target day)
    const availability = clamp(1 - dayLoad / maxPerDay);
    const availabilityDetail = `${dayLoad}/${maxPerDay} jobs that day`;

    // capacity (next 7 days of the target)
    const weekEnd = ctx.targetMs + 7 * DAY_MS;
    const weekLoad = open.filter((j) => {
      const ms = toMs(j.scheduled_datetime);
      return ms !== null && ms >= ctx.now && ms <= weekEnd;
    }).length;
    const capacity = clamp(1 - weekLoad / (maxPerDay * 5));
    const capacityDetail = `${weekLoad} open jobs in the next 7 days`;

    // quality — Bayesian completion rate over the last 90 days
    const recent = jobs.filter((j) => {
      const ms = toMs(j.scheduled_datetime);
      return ms !== null && ms >= ctx.now - 90 * DAY_MS && ms <= ctx.now;
    });
    const completed = recent.filter((j) => j.job_status === 'completed').length;
    const failed = recent.filter((j) => j.job_status === 'cancelled' || j.job_status === 'no_show').length;
    const quality = (completed + 3 * 0.8) / (completed + failed + 3);
    const qualityDetail = completed + failed === 0 ? 'No recent history — neutral prior' : `${completed} completed, ${failed} cancelled/no-show (90d)`;

    // price (labor cost vs team median) and margin
    const cost = t.hourly_cost_rate_cents && t.hourly_cost_rate_cents > 0 ? t.hourly_cost_rate_cents : null;
    let price = 0.5;
    let priceDetail = 'No labor rate on file — treated as neutral';
    let estMargin = ctx.estMarginPct;
    let margin = ctx.estMarginPct !== null ? clamp(ctx.estMarginPct / 60) : 0.5;
    let marginDetail = ctx.estMarginPct !== null ? `~${Math.round(ctx.estMarginPct)}% baseline margin` : 'No margin estimate';
    if (cost !== null && medianCost !== null) {
      price = clamp(1 - (cost / medianCost - 0.75) / 0.75);
      priceDetail = `$${(cost / 100).toFixed(0)}/h vs team median $${(medianCost / 100).toFixed(0)}/h`;
      if (ctx.estMarginPct !== null && ctx.estValueCents > 0) {
        estMargin = clamp(ctx.estMarginPct + (((medianCost - cost) * hours) / ctx.estValueCents) * 100, -100, 100);
        margin = clamp(estMargin / 60);
        marginDetail = `~${Math.round(estMargin)}% margin with this labor cost`;
      }
    }

    // customer fit
    const past = jobs.filter((j) => ctx.customerId && j.customer_id === ctx.customerId);
    const pastDone = past.filter((j) => j.job_status === 'completed').length;
    const fit = pastDone > 0 ? 1 : past.length > 0 ? 0.8 : 0.5;
    const fitDetail = pastDone > 0 ? `Completed ${pastDone} job(s) for this customer` : past.length > 0 ? 'Has worked with this customer' : 'No history with this customer';

    const raw: Record<FactorKey, [number, string]> = {
      skill: [skill, skillDetail],
      location: [location, locationDetail],
      availability: [availability, availabilityDetail],
      capacity: [capacity, capacityDetail],
      quality: [quality, qualityDetail],
      price: [price, priceDetail],
      margin: [margin, marginDetail],
      customer_fit: [fit, fitDetail],
    };
    const factors = (Object.keys(FACTOR_WEIGHTS) as FactorKey[]).map((key) => ({
      key,
      label: FACTOR_LABELS[key],
      weight: FACTOR_WEIGHTS[key],
      score: Math.round(raw[key][0] * 100) / 100,
      detail: raw[key][1],
    }));
    const score = Math.round(factors.reduce((sum, f) => sum + f.weight * f.score, 0));

    return {
      technician_id: t.id,
      name: t.name,
      score,
      eligible: blockers.length === 0,
      blockers,
      factors,
      est_margin_pct: estMargin === null ? null : Math.round(estMargin * 10) / 10,
    };
  });

  return matches.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
}

export const MIN_DISPATCH_SCORE = 55;

export interface RouteRecommendation {
  route: DemandRoute;
  reason: string;
}

/** Decides where an opportunity should go next. The caller performs the hand-off. */
export function recommendRoute(matches: TechMatch[], estValueCents: number): RouteRecommendation {
  const best = matches.find((m) => m.eligible);
  if (best && best.score >= MIN_DISPATCH_SCORE) {
    return { route: 'dispatch', reason: `${best.name} scores ${best.score}/100 and has room on the schedule.` };
  }
  if (estValueCents >= 25_000) {
    return {
      route: 'capacity_exchange',
      reason: best
        ? `Your best in-house fit is only ${best.score}/100 — a certified, in-region partner may serve this better.`
        : 'No in-house technician is eligible — offer it to certified capacity in your region.',
    };
  }
  return {
    route: 'marketplace',
    reason: 'Low-value work with no strong in-house fit — source labor through the Labor Marketplace.',
  };
}

// ---------------------------------------------------------------------------
// Dashboard helpers
// ---------------------------------------------------------------------------

export interface DemandRow {
  status: DemandStatus;
  scope: DemandScope;
  est_value_cents: number;
  est_margin_pct: number | null;
  source_kind: DemandSource;
  converted_at: string | null;
}

export interface DemandSummary {
  open: number;
  qualified: number;
  pipelineCents: number;
  expectedMarginCents: number;
  convertedThisMonth: number;
  bySource: Record<DemandSource, number>;
}

export function summarizeDemand(rows: DemandRow[], now: number = Date.now()): DemandSummary {
  const bySource = Object.fromEntries(DEMAND_SOURCES.map((s) => [s, 0])) as Record<DemandSource, number>;
  const monthStart = new Date(now);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const summary: DemandSummary = { open: 0, qualified: 0, pipelineCents: 0, expectedMarginCents: 0, convertedThisMonth: 0, bySource };
  for (const r of rows) {
    if (r.status === 'converted') {
      const t = toMs(r.converted_at);
      if (t !== null && t >= monthStart.getTime()) summary.convertedThisMonth += 1;
      continue;
    }
    if (!OPEN_STATUSES.includes(r.status)) continue;
    summary.open += 1;
    bySource[r.source_kind] += 1;
    if (r.status === 'qualified' || r.status === 'matched') summary.qualified += 1;
    if (r.scope === 'property') {
      summary.pipelineCents += r.est_value_cents;
      summary.expectedMarginCents += Math.round((r.est_value_cents * (r.est_margin_pct ?? 0)) / 100);
    }
  }
  return summary;
}
