/**
 * Home Demand Exchange — data layer.
 *
 * Gathers signals the platform already stores (equipment, predictions,
 * weather, permits, rebates, prediction mesh, property profiles, jobs) in a
 * fixed number of batched reads, runs the pure engine, and persists through
 * the three transactional RPCs. Every optional source degrades gracefully:
 * if one cannot be read the scan still runs, and ONLY the sources that were
 * read successfully are allowed to expire stale opportunities.
 *
 * Hand-offs reuse existing code paths — nothing is re-implemented:
 *   Leads / Quotes / Jobs  -> convert_home_demand_opportunity (one transaction)
 *   Dispatch               -> assign_technician_to_job (capacity-locked)
 *   Capacity Exchange      -> networkApi.post + liquidityApi.setRequirements
 *                             + capacityApi.computeMatches
 */

import { supabase } from '@/lib/supabase';
import { networkApi, capacityApi } from '@/lib/contractorNetworkApi';
import { DEFAULT_REFERRAL_FEE_PCT } from '@/lib/contractorNetwork';
import { SKILL_OPTIONS, liquidityApi, emptyRequirements } from '@/lib/capacityLiquidity';
import type { AssignTechnicianResult } from '@/lib/technicianCapacity';
import {
  DEMAND_SOURCES,
  detectDemand,
  rankTechnicians,
  recommendRoute,
  type CustomerRef,
  type DemandCandidate,
  type DemandRoute,
  type DemandScope,
  type DemandSignals,
  type DemandSource,
  type DemandStatus,
  type DemandUrgency,
  type EquipmentSignal,
  type Evidence,
  type FailurePredictionSignal,
  type MatchContext,
  type MeshSignal,
  type OpenJobRef,
  type PermitSignal,
  type PropertySignal,
  type QualificationGate,
  type RebateSignal,
  type RouteRecommendation,
  type TechJobRef,
  type TechMatch,
  type TechnicianSignal,
  type WeatherSignal,
} from '@/lib/homeDemandExchange';
import type { TradeCategory } from '@/lib/laborMarketplace';

const DAY_MS = 86_400_000;
const MAX_CANDIDATES = 300;
const ID_CHUNK = 150;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface BestMatchSnapshot {
  route: DemandRoute;
  reason: string;
  technician_id: string | null;
  technician_name: string | null;
  score: number | null;
  matched_at: string;
}

export interface DemandOpportunity {
  id: string;
  user_id: string;
  dedupe_key: string;
  source_kind: DemandSource;
  source_ref: string | null;
  scope: DemandScope;
  customer_id: string | null;
  customer_name: string | null;
  site_id: string | null;
  equipment_id: string | null;
  title: string;
  summary: string | null;
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
  best_match: BestMatchSnapshot | null;
  status: DemandStatus;
  lead_id: string | null;
  quote_id: string | null;
  job_id: string | null;
  handoff_id: string | null;
  dismissed_reason: string | null;
  converted_at: string | null;
  detected_at: string;
  updated_at: string;
}

export interface ScanResult {
  detected: number;
  created: number;
  updated: number;
  expired: number;
  skipped: number;
  unavailableSources: string[];
}

export interface MatchResult {
  matches: TechMatch[];
  recommendation: RouteRecommendation;
}

export interface ConvertOptions {
  createQuote: boolean;
  createJob: boolean;
  /** ISO timestamp; required when createJob is true. */
  scheduledAt: string | null;
  durationMinutes: number;
  /** When set, the new job is assigned through the existing Dispatch RPC. */
  technicianId: string | null;
}

export interface ConvertResult {
  leadId: string | null;
  quoteId: string | null;
  jobId: string | null;
  assignment: AssignTechnicianResult | null;
  assignmentError: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type QueryResult = { data: unknown; error: { message: string } | null };

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Runs a read; null means the source was unavailable (never throws). */
async function rowsIf<T>(run: () => PromiseLike<QueryResult>): Promise<T[] | null> {
  try {
    const { data, error } = await run();
    if (error) return null;
    return (data as T[] | null) ?? [];
  } catch {
    return null;
  }
}

export async function getOwnerId(): Promise<string> {
  const { data, error } = await supabase.rpc('get_account_owner_id');
  if (error || !data) throw error ?? new Error('Could not resolve account owner');
  return data as string;
}

const chunk = <T>(xs: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
};

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
};

/** Plain-English message for the RPC errors this feature can raise. */
export function describeDemandError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  if (raw.includes('NOT_AUTHENTICATED')) return 'Please sign in again.';
  if (raw.includes('NOT_FOUND') || raw.includes('CUSTOMER_NOT_FOUND')) return 'That opportunity or customer no longer exists.';
  if (raw.includes('NOT_OPEN')) return 'This opportunity is no longer open.';
  if (raw.includes('NOT_CONVERTIBLE')) return 'Market signals cannot become a lead — route them to capacity instead.';
  if (raw.includes('SCHEDULE_REQUIRED')) return 'Pick a date and time before creating a job.';
  if (raw.includes('NOT_A_MEMBER')) return 'Join the Contractor Network to post work to Capacity Exchange.';
  if (raw.includes('TOO_MANY_ITEMS')) return 'Too many opportunities in one scan — try again.';
  return raw || 'Something went wrong. Please try again.';
}

/** Default job length by size of work. */
export function defaultDurationMinutes(estValueCents: number): number {
  if (estValueCents >= 500_000) return 240;
  if (estValueCents >= 100_000) return 120;
  return 60;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchOpportunities(): Promise<DemandOpportunity[]> {
  const { data, error } = await supabase
    .from('home_demand_opportunities')
    .select('*')
    .order('demand_score', { ascending: false })
    .limit(400);
  if (error) throw new Error(error.message);
  return (data ?? []) as DemandOpportunity[];
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

interface PermitRow {
  id: string;
  site_id: string | null;
  permit_type: string;
  status: string;
  expires_on: string | null;
  final_inspection_on: string | null;
  description: string | null;
  customer_sites: { customer_id: string | null } | { customer_id: string | null }[] | null;
}

async function loadCustomers(ids: string[]): Promise<Record<string, CustomerRef> | null> {
  const out: Record<string, CustomerRef> = {};
  for (const part of chunk(ids, ID_CHUNK)) {
    const rows = await rowsIf<CustomerRef>(() =>
      supabase.from('customers').select('id, name, phone, email, address').in('id', part),
    );
    if (rows === null) return null;
    for (const r of rows) out[r.id] = r;
  }
  return out;
}

export async function scanDemand(): Promise<ScanResult> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const since180 = new Date(now - 180 * DAY_MS).toISOString();
  const since120 = new Date(now - 120 * DAY_MS).toISOString();
  const legacyYear = new Date(now).getUTCFullYear() - 40;

  const [equipment, predictions, weather, permits, rebates, mesh, properties, openJobs, tickets] = await Promise.all([
    rowsIf<EquipmentSignal>(() =>
      supabase
        .from('equipment')
        .select('id, customer_id, equipment_type, make, model, install_date, warranty_expires_at, expected_lifespan_years, service_interval_months, last_service_date')
        .eq('status', 'active')
        .limit(2000),
    ),
    rowsIf<FailurePredictionSignal>(() =>
      supabase
        .from('equipment_failure_predictions')
        .select('id, equipment_id, failure_label, probability, confidence, horizon_days, recommended_action')
        .eq('status', 'open')
        .gte('probability', 0.4)
        .limit(500),
    ),
    rowsIf<WeatherSignal>(() =>
      supabase
        .from('weather_surge_events')
        .select('id, event_type, severity, headline, area_desc, effective_at, expires_at')
        .is('resolved_at', null)
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
        .limit(50),
    ),
    rowsIf<PermitRow>(() =>
      supabase
        .from('home_permits')
        .select('id, site_id, permit_type, status, expires_on, final_inspection_on, description, customer_sites(customer_id)')
        .in('status', ['issued', 'inspection_pending', 'failed'])
        .limit(500),
    ),
    rowsIf<RebateSignal>(() =>
      supabase
        .from('rebate_analyses')
        .select('id, customer_id, equipment_id, total_expected_cents, install_target_date, created_at')
        .gte('created_at', since120)
        .order('created_at', { ascending: false })
        .limit(300),
    ),
    rowsIf<MeshSignal>(() =>
      supabase
        .from('prediction_mesh_predictions')
        .select('id, event_kind, level, probability, window_start, window_end')
        .gt('window_end', nowIso)
        .in('level', ['elevated', 'high', 'critical'])
        .limit(30),
    ),
    rowsIf<PropertySignal>(() =>
      supabase
        .from('property_context_profiles')
        .select('customer_id, site_id, year_built, heating_fuel')
        .not('year_built', 'is', null)
        .lte('year_built', legacyYear)
        .limit(1000),
    ),
    rowsIf<OpenJobRef>(() =>
      supabase
        .from('jobs')
        .select('customer_id, service_type, scheduled_datetime, job_status')
        .in('job_status', ['scheduled', 'en_route', 'in_progress'])
        .limit(2000),
    ),
    rowsIf<{ invoice_amount: number | null }>(() =>
      supabase
        .from('jobs')
        .select('invoice_amount')
        .eq('job_status', 'completed')
        .not('invoice_amount', 'is', null)
        .gte('scheduled_datetime', since180)
        .limit(500),
    ),
  ]);

  // Jobs gate duplicate pitches; without them qualification would be unsafe.
  if (openJobs === null) throw new Error('Could not read jobs, so the scan was cancelled to avoid duplicate pitches.');

  const permitRows = (permits ?? []).map((p): PermitSignal => {
    const site = Array.isArray(p.customer_sites) ? p.customer_sites[0] : p.customer_sites;
    return {
      id: p.id,
      customer_id: site?.customer_id ?? null,
      site_id: p.site_id,
      permit_type: p.permit_type,
      status: p.status,
      expires_on: p.expires_on,
      final_inspection_on: p.final_inspection_on,
      description: p.description,
    };
  });

  const customerIds = Array.from(
    new Set(
      [
        ...(equipment ?? []).map((e) => e.customer_id),
        ...permitRows.map((p) => p.customer_id),
        ...(rebates ?? []).map((r) => r.customer_id),
        ...(properties ?? []).map((p) => p.customer_id),
      ].filter((id): id is string => !!id),
    ),
  );
  const customers = await loadCustomers(customerIds);
  if (customers === null) throw new Error('Could not read customers, so the scan was cancelled.');

  const amounts = (tickets ?? []).map((t) => num(t.invoice_amount)).filter((a) => a > 0);
  const signals: DemandSignals = {
    now,
    customers,
    equipment: (equipment ?? []).map((e) => ({
      ...e,
      expected_lifespan_years: num(e.expected_lifespan_years, 15),
      service_interval_months: num(e.service_interval_months, 12),
    })),
    predictions: (predictions ?? []).map((p) => ({ ...p, probability: num(p.probability), confidence: num(p.confidence), horizon_days: num(p.horizon_days, 30) })),
    weather: weather ?? [],
    permits: permitRows,
    rebates: (rebates ?? []).map((r) => ({ ...r, total_expected_cents: num(r.total_expected_cents) })),
    mesh: (mesh ?? []).map((m) => ({ ...m, probability: num(m.probability) })),
    properties: properties ?? [],
    openJobs,
    avgTicketCents: amounts.length ? Math.round((amounts.reduce((a, b) => a + b, 0) / amounts.length) * 100) : null,
    ticketSamples: amounts.length,
  };

  const candidates: DemandCandidate[] = detectDemand(signals).slice(0, MAX_CANDIDATES);

  // A source may expire stale rows only if everything it depends on was read.
  const ok = {
    equipment: equipment !== null,
    predictions: predictions !== null,
    weather: weather !== null,
    permits: permits !== null,
    rebates: rebates !== null,
    mesh: mesh !== null,
    properties: properties !== null,
  };
  const scanned: Record<DemandSource, boolean> = {
    equipment_health: ok.equipment,
    predicted_failure: ok.equipment && ok.predictions,
    warranty: ok.equipment,
    weather: ok.weather && ok.equipment,
    permit: ok.permits,
    rebate: ok.rebates && ok.equipment,
    event: ok.mesh,
    property_condition: ok.properties && ok.equipment,
  };
  const scannedSources = DEMAND_SOURCES.filter((s) => scanned[s]);

  const res = await rpc<{ created: number; updated: number; skipped: number; expired: number }>(
    'sync_home_demand_opportunities',
    { p_items: candidates, p_scanned_sources: scannedSources },
  );

  return {
    detected: candidates.length,
    created: res.created,
    updated: res.updated,
    expired: res.expired,
    skipped: res.skipped,
    unavailableSources: DEMAND_SOURCES.filter((s) => !scanned[s]),
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface TeamRow {
  id: string;
  member_name: string | null;
  member_email: string;
  role: string;
  skills: string[] | null;
  service_area: string | null;
  max_jobs_per_day: number | null;
  dispatch_enabled: boolean | null;
  hourly_cost_rate_cents: number | null;
  home_latitude: number | null;
  home_longitude: number | null;
  current_latitude: number | null;
  current_longitude: number | null;
  location_updated_at: string | null;
}

async function loadSiteCoordinates(opp: DemandOpportunity): Promise<{ lat: number; lng: number } | null> {
  let siteId = opp.site_id;
  if (!siteId && opp.customer_id) {
    const sites = await rowsIf<{ id: string }>(() =>
      supabase
        .from('customer_sites')
        .select('id')
        .eq('customer_id', opp.customer_id as string)
        .order('is_primary', { ascending: false })
        .limit(1),
    );
    siteId = sites?.[0]?.id ?? null;
  }
  if (!siteId) return null;
  const profile = await rowsIf<{ latitude: number | null; longitude: number | null }>(() =>
    supabase.from('property_profiles').select('latitude, longitude').eq('site_id', siteId as string).limit(1),
  );
  const p = profile?.[0];
  return p && p.latitude !== null && p.longitude !== null ? { lat: p.latitude, lng: p.longitude } : null;
}

export async function matchOpportunity(opp: DemandOpportunity): Promise<MatchResult> {
  const now = Date.now();
  const ownerId = await getOwnerId();

  const team = await rowsIf<TeamRow>(() =>
    supabase
      .from('team_members')
      .select('id, member_name, member_email, role, skills, service_area, max_jobs_per_day, dispatch_enabled, hourly_cost_rate_cents, home_latitude, home_longitude, current_latitude, current_longitude, location_updated_at')
      .eq('account_owner_id', ownerId),
  );
  const technicians: TechnicianSignal[] = (team ?? []).map((t) => ({
    id: t.id,
    name: t.member_name || t.member_email,
    role: t.role,
    skills: t.skills ?? [],
    service_area: t.service_area,
    max_jobs_per_day: t.max_jobs_per_day ?? 6,
    dispatch_enabled: t.dispatch_enabled ?? true,
    hourly_cost_rate_cents: t.hourly_cost_rate_cents,
    home_latitude: t.home_latitude,
    home_longitude: t.home_longitude,
    current_latitude: t.current_latitude,
    current_longitude: t.current_longitude,
    location_updated_at: t.location_updated_at,
  }));

  const jobsByTech: Record<string, TechJobRef[]> = {};
  const techIds = technicians.filter((t) => t.role === 'technician').map((t) => t.id);
  if (techIds.length > 0) {
    const jobs = await rowsIf<TechJobRef & { assigned_technician_id: string | null }>(() =>
      supabase
        .from('jobs')
        .select('assigned_technician_id, scheduled_datetime, job_status, customer_id')
        .in('assigned_technician_id', techIds)
        .gte('scheduled_datetime', new Date(now - 90 * DAY_MS).toISOString())
        .lte('scheduled_datetime', new Date(now + 21 * DAY_MS).toISOString())
        .limit(3000),
    );
    for (const j of jobs ?? []) {
      if (!j.assigned_technician_id) continue;
      (jobsByTech[j.assigned_technician_id] ??= []).push(j);
    }
  }

  const site = await loadSiteCoordinates(opp);
  const ctx: MatchContext = {
    now,
    targetMs: Math.max(now, new Date(opp.window_start).getTime()),
    trade: opp.trade_category,
    skill: opp.skill,
    serviceLabel: opp.service_label,
    address: opp.address,
    customerId: opp.customer_id,
    site,
    estValueCents: opp.est_value_cents,
    estMarginPct: opp.est_margin_pct,
    durationMinutes: defaultDurationMinutes(opp.est_value_cents),
  };

  const matches = rankTechnicians(ctx, technicians, jobsByTech);
  const recommendation = recommendRoute(matches, opp.est_value_cents);

  // Persist a compact snapshot so the board stays meaningful between sessions.
  if (opp.status === 'detected' || opp.status === 'qualified' || opp.status === 'matched') {
    const best = matches.find((m) => m.eligible) ?? null;
    const snapshot: BestMatchSnapshot = {
      route: recommendation.route,
      reason: recommendation.reason,
      technician_id: best?.technician_id ?? null,
      technician_name: best?.name ?? null,
      score: best?.score ?? null,
      matched_at: new Date(now).toISOString(),
    };
    try {
      await rpc<void>('set_home_demand_status', { p_id: opp.id, p_action: 'match', p_best_match: snapshot });
    } catch {
      /* the ranking is still shown; the snapshot is a convenience */
    }
  }
  return { matches, recommendation };
}

// ---------------------------------------------------------------------------
// Actions into existing systems
// ---------------------------------------------------------------------------

export async function convertOpportunity(opp: DemandOpportunity, o: ConvertOptions): Promise<ConvertResult> {
  const res = await rpc<{ lead_id: string | null; quote_id: string | null; job_id: string | null }>(
    'convert_home_demand_opportunity',
    {
      p_id: opp.id,
      p_create_quote: o.createQuote,
      p_create_job: o.createJob,
      p_scheduled_at: o.createJob ? o.scheduledAt : null,
      p_duration_minutes: o.durationMinutes,
    },
  );

  let assignment: AssignTechnicianResult | null = null;
  let assignmentError: string | null = null;
  if (res.job_id && o.technicianId) {
    try {
      // The existing Dispatch RPC enforces per-technician daily capacity.
      assignment = await rpc<AssignTechnicianResult>('assign_technician_to_job', {
        p_job_id: res.job_id,
        p_technician_id: o.technicianId,
      });
    } catch (e) {
      assignmentError = e instanceof Error ? e.message : 'Assignment failed';
    }
  }
  return { leadId: res.lead_id, quoteId: res.quote_id, jobId: res.job_id, assignment, assignmentError };
}

/**
 * Posts the opportunity to Capacity Exchange exactly the way its own form does:
 * post -> set requirements -> compute matches. If anything after the post fails
 * the handoff is cancelled so no orphan listing is left in the open feed.
 * Resolves to the number of offers sent.
 */
export async function postToCapacityExchange(opp: DemandOpportunity): Promise<{ handoffId: string; offered: number }> {
  let customer: { name: string; phone: string | null; address: string | null } | null = null;
  if (opp.customer_id) {
    const rows = await rowsIf<{ name: string; phone: string | null; address: string | null }>(() =>
      supabase.from('customers').select('name, phone, address').eq('id', opp.customer_id as string).limit(1),
    );
    customer = rows?.[0] ?? null;
  }
  const windowStart = new Date(opp.window_start).getTime();
  const handoffId = await networkApi.post({
    kind: 'capacity_overflow',
    trade: opp.trade_category,
    title: opp.title.slice(0, 120),
    summary: (opp.summary ?? '').slice(0, 1000),
    locationLabel: (opp.location_label ?? '').slice(0, 80),
    neededBy: windowStart > Date.now() ? new Date(windowStart).toISOString() : null,
    estimatedValueCents: opp.est_value_cents > 0 ? opp.est_value_cents : null,
    referralFeePct: DEFAULT_REFERRAL_FEE_PCT,
    customerName: customer?.name ?? '',
    customerPhone: customer?.phone ?? '',
    customerAddress: customer?.address ?? opp.address ?? '',
    notes: `Posted from Home Demand Exchange (${opp.service_label}).`,
    smartMatch: false,
  });

  try {
    const known = SKILL_OPTIONS.some((s) => s.value === opp.skill);
    if (known && opp.skill) {
      await liquidityApi.setRequirements(handoffId, { ...emptyRequirements, skills: [opp.skill] });
    }
    const offered = await capacityApi.computeMatches(handoffId);
    await rpc<void>('set_home_demand_status', { p_id: opp.id, p_action: 'link_handoff', p_handoff_id: handoffId });
    return { handoffId, offered };
  } catch (err) {
    await networkApi.cancel(handoffId).catch(() => undefined);
    throw err;
  }
}

export const dismissOpportunity = (id: string, reason: string) =>
  rpc<void>('set_home_demand_status', { p_id: id, p_action: 'dismiss', p_reason: reason });

export const reopenOpportunity = (id: string) =>
  rpc<void>('set_home_demand_status', { p_id: id, p_action: 'reopen' });
