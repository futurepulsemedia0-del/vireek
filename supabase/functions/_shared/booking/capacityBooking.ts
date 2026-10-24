// Capacity-based smart booking — data layer shared by every channel (public booking page, AI voice
// agent, SMS, MCP agents). It loads the real state (technicians + dispatch rules via the same loader
// dispatch-auto-assign uses, open jobs, time off, capacity-demand policy, cancel history), asks the
// pure engine (capacityEngine.ts) for slots, and commits through the atomic book_capacity_slot() RPC.
// Service-role client only; every query is scoped by ownerId.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { loadRulesContext } from '../dispatch/rulesContext.ts';
import {
  computeAvailability,
  evaluateSlot,
  formatSlotLocal,
  nearestOffered,
  overbookAllowance,
  predictDurationMinutes,
  safeTimezone,
  sanitizePolicy,
  type AvailabilityResult,
  type BookingContext,
  type BookingRequest,
  type BusyJob,
  type HoursByDay,
  type SlotDecision,
} from './capacityEngine.ts';

const OPEN_STATUSES = ['scheduled', 'en_route', 'in_progress'];
const DAY_MS = 86_400_000;

export interface LoadedCapacity {
  ctx: BookingContext;
  defaultDurationMinutes: number;
  bookingSlug: string | null;
  bookingEnabled: boolean;
  services: string[];
  hiddenServices: string[];
  depositCents: number;
  intakeQuestions: IntakeQuestion[];
}

export interface IntakeQuestion { id: string; label: string; type: string; required: boolean; options: string[] }

const dayOnly = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** Returns null when the account has not enabled capacity booking (callers fall back to legacy). */
export async function loadCapacityContext(admin: SupabaseClient, ownerId: string, now: number = Date.now(), opts: { force?: boolean } = {}): Promise<LoadedCapacity | null> {
  const policyRes = await admin.from('booking_capacity_policies').select('*').eq('user_id', ownerId).maybeSingle();
  // force = dashboard preview: evaluate even while the switch is still off (and with defaults if no row yet).
  if (!opts.force && (policyRes.error || !policyRes.data || policyRes.data.enabled !== true)) return null;

  const CORE = 'business_hours, holidays, booking_slug, booking_enabled, services_offered, booking_default_duration_minutes, booking_lead_time_hours, booking_window_days, timezone';
  const EXTRA = ', booking_hours, booking_buffer_before_minutes, booking_buffer_after_minutes, booking_hidden_services, booking_deposit_cents, booking_intake_questions';
  let bpRes = await admin.from('business_profile').select(CORE + EXTRA).eq('user_id', ownerId).maybeSingle();
  if (bpRes.error) bpRes = await admin.from('business_profile').select(CORE).eq('user_id', ownerId).maybeSingle(); // booking-settings migration not applied yet
  const bp = (bpRes.data ?? {}) as Record<string, unknown>;

  const windowDays = typeof bp.booking_window_days === 'number' ? bp.booking_window_days : 14;
  const demandRes = await admin.from('capacity_demand_policies').select('low_threshold_pct, full_threshold_pct, emergency_reserve_slots').eq('user_id', ownerId).maybeSingle();
  const policy = sanitizePolicy({ ...(demandRes.data ?? {}), ...(policyRes.data ?? {}), enabled: true });

  const from = new Date(now - DAY_MS).toISOString();
  const to = new Date(now + (windowDays + 2) * DAY_MS).toISOString();
  const today = new Date(now).toISOString().slice(0, 10);
  const lastDay = new Date(now + (windowDays + 1) * DAY_MS).toISOString().slice(0, 10);
  const since90 = new Date(now - 90 * DAY_MS).toISOString();

  const [rulesCtx, jobsRes, offRes, blackRes, availRes, histRes] = await Promise.all([
    loadRulesContext(admin, ownerId, [today, lastDay]),
    admin.from('jobs').select('id, assigned_technician_id, scheduled_datetime, duration_minutes, latitude, longitude')
      .eq('user_id', ownerId).in('job_status', OPEN_STATUSES).not('scheduled_datetime', 'is', null)
      .gte('scheduled_datetime', from).lt('scheduled_datetime', to).limit(5000),
    admin.from('technician_time_off').select('technician_id, start_date, end_date').eq('user_id', ownerId).eq('status', 'approved').gte('end_date', today).lte('start_date', lastDay),
    admin.from('company_blackout_dates').select('label, start_date, end_date').eq('user_id', ownerId).eq('status', 'active').gte('end_date', today).lte('start_date', lastDay),
    admin.from('technician_availability').select('technician_id, working_days').eq('user_id', ownerId),
    admin.from('jobs').select('job_status').eq('user_id', ownerId).gte('scheduled_datetime', since90).lt('scheduled_datetime', new Date(now).toISOString()).limit(5000),
  ]);

  const jobs: BusyJob[] = ((jobsRes.data ?? []) as Record<string, unknown>[]).flatMap((j) => {
    const start = Date.parse(j.scheduled_datetime as string);
    if (!Number.isFinite(start)) return [];
    const mins = typeof j.duration_minutes === 'number' && j.duration_minutes > 0 ? j.duration_minutes : 60;
    return [{ id: j.id as string, technician_id: (j.assigned_technician_id as string | null) ?? null, start, end: start + mins * 60_000, lat: (j.latitude as number | null) ?? null, lon: (j.longitude as number | null) ?? null }];
  });

  const workingDays: Record<string, number[]> = {};
  for (const r of (availRes.data ?? []) as { technician_id: string; working_days: number[] }[]) workingDays[r.technician_id] = r.working_days ?? [];

  const hist = (histRes.data ?? []) as { job_status: string }[];
  const cancelled = hist.filter((h) => h.job_status === 'cancelled' || h.job_status === 'no_show').length;
  const cancelRate = hist.length >= 30 ? cancelled / hist.length : null; // too little history = no overbooking

  const holidays = (Array.isArray(bp.holidays) ? bp.holidays : []).flatMap((h: unknown) => {
    const d = dayOnly((h as { date?: unknown })?.date);
    return d ? [d] : [];
  });

  const ctx: BookingContext = {
    now,
    timezone: safeTimezone(bp.timezone as string | null),
    hours: ((bp.booking_hours as HoursByDay | null) ?? (bp.business_hours as HoursByDay | null) ?? {}) as HoursByDay,
    holidays,
    leadTimeHours: typeof bp.booking_lead_time_hours === 'number' ? bp.booking_lead_time_hours : 2,
    windowDays,
    bufferBefore: typeof bp.booking_buffer_before_minutes === 'number' ? bp.booking_buffer_before_minutes : 0,
    bufferAfter: typeof bp.booking_buffer_after_minutes === 'number' ? bp.booking_buffer_after_minutes : 0,
    policy,
    technicians: rulesCtx.technicians,
    rules: rulesCtx.rules,
    territories: rulesCtx.territories,
    preferences: rulesCtx.preferences,
    jobs,
    timeOff: ((offRes.data ?? []) as Record<string, unknown>[]).flatMap((r) => { const s = dayOnly(r.start_date), e = dayOnly(r.end_date); return s && e ? [{ technician_id: r.technician_id as string, start_date: s, end_date: e }] : []; }),
    blackouts: ((blackRes.data ?? []) as Record<string, unknown>[]).flatMap((r) => { const s = dayOnly(r.start_date), e = dayOnly(r.end_date); return s && e ? [{ label: String(r.label ?? 'Blackout'), start_date: s, end_date: e }] : []; }),
    workingDays,
    cancelRate,
  };

  return {
    ctx,
    defaultDurationMinutes: typeof bp.booking_default_duration_minutes === 'number' ? bp.booking_default_duration_minutes : 60,
    bookingSlug: (bp.booking_slug as string | null) ?? null,
    bookingEnabled: bp.booking_enabled === true,
    services: Array.isArray(bp.services_offered) ? (bp.services_offered as string[]) : [],
    hiddenServices: Array.isArray(bp.booking_hidden_services) ? (bp.booking_hidden_services as string[]) : [],
    depositCents: typeof bp.booking_deposit_cents === 'number' ? bp.booking_deposit_cents : 0,
    intakeQuestions: Array.isArray(bp.booking_intake_questions) ? (bp.booking_intake_questions as IntakeQuestion[]) : [],
  };
}

/** Predicted visit length from the real durations (started_at -> completed_at) of the same service. */
export async function predictDuration(admin: SupabaseClient, ownerId: string, serviceType: string | null, fallback: number, now: number = Date.now()): Promise<number> {
  if (!serviceType) return predictDurationMinutes([], fallback);
  try {
    const { data } = await admin.from('jobs').select('started_at, completed_at')
      .eq('user_id', ownerId).eq('job_status', 'completed').eq('service_type', serviceType)
      .not('started_at', 'is', null).not('completed_at', 'is', null)
      .gte('completed_at', new Date(now - 180 * DAY_MS).toISOString()).limit(200);
    const mins = ((data ?? []) as { started_at: string; completed_at: string }[]).map((r) => (Date.parse(r.completed_at) - Date.parse(r.started_at)) / 60_000);
    return predictDurationMinutes(mins, fallback);
  } catch {
    return predictDurationMinutes([], fallback); // prediction is optional — never block booking on it
  }
}

export interface AvailabilityInput {
  serviceType?: string | null;
  address?: string | null;
  lat?: number | null;
  lon?: number | null;
  customerId?: string | null;
  isEmergency?: boolean;
  isVip?: boolean;
  /** Overrides the prediction (e.g. an agent that already knows). */
  durationMinutes?: number;
}

export type AvailabilityOutcome =
  | { enabled: false }
  | { enabled: true; loaded: LoadedCapacity; request: BookingRequest; result: AvailabilityResult };

/** Technicians missing a blocking credential for this service (same gate assign_technician_to_job enforces). Fails open. */
async function loadCredentialGaps(admin: SupabaseClient, loaded: LoadedCapacity, service: string | null): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  if (!service) return out;
  await Promise.all(loaded.ctx.technicians.slice(0, 50).map(async (t) => {
    try {
      const { data, error } = await admin.rpc('technician_compliance_gaps', { p_technician_id: t.id, p_service_type: service });
      if (!error && Array.isArray(data) && data.length > 0) out[t.id] = data as string[];
    } catch { /* credential data is optional here — the DB gate still blocks at commit */ }
  }));
  return out;
}

export async function buildRequest(admin: SupabaseClient, ownerId: string, loaded: LoadedCapacity, input: AvailabilityInput): Promise<BookingRequest> {
  const service = input.serviceType?.trim() || null;
  loaded.ctx.credentialGaps = await loadCredentialGaps(admin, loaded, service);
  const duration = input.durationMinutes && input.durationMinutes > 0
    ? input.durationMinutes
    : await predictDuration(admin, ownerId, service, loaded.defaultDurationMinutes, loaded.ctx.now);
  return {
    serviceType: service, durationMinutes: duration, address: input.address?.trim() || null,
    lat: typeof input.lat === 'number' ? input.lat : null, lon: typeof input.lon === 'number' ? input.lon : null,
    customerId: input.customerId ?? null, isVip: input.isVip === true, isEmergency: input.isEmergency === true,
  };
}

export async function getAvailability(admin: SupabaseClient, ownerId: string, input: AvailabilityInput, opts: { includeHidden?: boolean; maxOffered?: number; force?: boolean } = {}): Promise<AvailabilityOutcome> {
  const loaded = await loadCapacityContext(admin, ownerId, Date.now(), { force: opts.force });
  if (!loaded) return { enabled: false };
  const request = await buildRequest(admin, ownerId, loaded, input);
  return { enabled: true, loaded, request, result: computeAvailability(loaded.ctx, request, opts) };
}

export interface RequestedSlotVerdict {
  enabled: boolean;
  offered: boolean;
  decision: SlotDecision | null;
  alternatives: SlotDecision[];
  /** Plain-language answer for a voice/SMS/MCP agent — never invent availability beyond this. */
  message: string;
}

/** "Is Thursday 2:30 free?" — decision + the 3 nearest real alternatives + a ready-to-speak sentence. */
export async function checkRequestedSlot(admin: SupabaseClient, ownerId: string, input: AvailabilityInput, startMs: number): Promise<RequestedSlotVerdict> {
  const loaded = await loadCapacityContext(admin, ownerId);
  if (!loaded) return { enabled: false, offered: false, decision: null, alternatives: [], message: '' };
  const request = await buildRequest(admin, ownerId, loaded, input);
  const decision = evaluateSlot(loaded.ctx, request, startMs);
  const tz = loaded.ctx.timezone;
  if (decision.offered) {
    return { enabled: true, offered: true, decision, alternatives: [], message: `${formatSlotLocal(startMs, tz)} is available (about ${request.durationMinutes} minutes).` };
  }
  const alts = nearestOffered(computeAvailability(loaded.ctx, request).slots, startMs, 3);
  const altText = alts.length ? ` Closest open times: ${alts.map((a) => formatSlotLocal(Date.parse(a.start), tz)).join('; ')}.` : ' There are no open times in the booking window — offer to take a message or add the customer to the waitlist.';
  return { enabled: true, offered: false, decision, alternatives: alts, message: `${formatSlotLocal(startMs, tz)} is not available: ${decision.explanation}${altText}` };
}

export interface CommitInput extends AvailabilityInput {
  startMs: number;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  notes?: string | null;
  channel: string;
  refCode?: string | null;
  intake?: { id: string; label: string; answer: string }[];
}

export type CommitResult =
  | { status: 'legacy' } // capacity booking not enabled: caller keeps its legacy flow
  | { status: 'booked'; jobId: string; technicianId: string; technicianName: string | null; startIso: string; overbooked: boolean; depositDueCents: number; durationMinutes: number; explanation: string }
  | { status: 'unavailable'; decision: SlotDecision | null; alternatives: SlotDecision[]; message: string }
  | { status: 'error'; reason: string };

/**
 * Re-evaluates the slot against fresh data, then writes it atomically with the chosen technician.
 * If the DB rejects the winner (someone else just took it), it re-evaluates and tries again.
 */
export async function commitCapacityBooking(admin: SupabaseClient, ownerId: string, input: CommitInput): Promise<CommitResult> {
  if (!input.customerName.trim()) return { status: 'error', reason: 'missing_customer_name' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const loaded = await loadCapacityContext(admin, ownerId);
    if (!loaded) return { status: 'legacy' };
    const request = await buildRequest(admin, ownerId, loaded, input);
    const decision = evaluateSlot(loaded.ctx, request, input.startMs);
    if (!decision.offered || !decision.technician_id) {
      const alts = nearestOffered(computeAvailability(loaded.ctx, request).slots, input.startMs, 3);
      return { status: 'unavailable', decision, alternatives: alts, message: decision.explanation };
    }
    const winner = loaded.ctx.technicians.find((t) => t.id === decision.technician_id);
    const allowance = overbookAllowance(loaded.ctx.policy, loaded.ctx.cancelRate, winner && winner.max_jobs_per_day > 0 ? winner.max_jobs_per_day : 6);
    const { data, error } = await admin.rpc('book_capacity_slot', {
      p_user_id: ownerId,
      p_technician_id: decision.technician_id,
      p_start: new Date(input.startMs).toISOString(),
      p_duration_minutes: request.durationMinutes,
      p_customer_name: input.customerName.trim(),
      p_customer_phone: input.customerPhone?.trim() || null,
      p_customer_email: input.customerEmail?.trim() || null,
      p_service_type: request.serviceType,
      p_address: request.address,
      p_latitude: request.lat,
      p_longitude: request.lon,
      p_notes: input.notes?.trim() || null,
      p_channel: input.channel,
      p_ref_code: input.refCode?.trim() || null,
      p_intake: input.intake ?? [],
      p_deposit_cents: loaded.depositCents,
      p_overbook_allowance: decision.overbooked ? allowance : 0,
      p_explanation: decision.explanation,
      p_detail: { reasons: decision.reasons, score: decision.score, overbooked: decision.overbooked, travel_estimated: decision.travel_estimated, cancel_rate: loaded.ctx.cancelRate },
    });
    if (error) {
      if (error.code === 'PGRST202' || error.code === '42883') return { status: 'legacy' }; // migration not applied yet
      console.error(JSON.stringify({ event: 'capacity_booking_rpc_failed', error: error.message }));
      return { status: 'error', reason: 'rpc_failed' };
    }
    const res = (data ?? {}) as { status?: string; job_id?: string; technician_id?: string; technician_name?: string | null; overbooked?: boolean; deposit_due_cents?: number; reason?: string };
    if (res.status === 'booked' && res.job_id) {
      return { status: 'booked', jobId: res.job_id, technicianId: res.technician_id ?? decision.technician_id, technicianName: res.technician_name ?? decision.technician_name, startIso: new Date(input.startMs).toISOString(), overbooked: res.overbooked === true, depositDueCents: res.deposit_due_cents ?? 0, durationMinutes: request.durationMinutes, explanation: decision.explanation };
    }
    if (res.status === 'invalid') return { status: 'error', reason: res.reason ?? 'invalid' };
    // slot_conflict / at_capacity / blocked_* / tech_not_found: state moved under us — reload and re-decide.
  }
  return { status: 'unavailable', decision: null, alternatives: [], message: 'That time was just taken.' };
}

/** Same rules as the booking_settings RPC: required answers, select/yesno validity, length cap. */
export function validateIntake(questions: IntakeQuestion[], answers: Record<string, unknown> | null | undefined): { ok: true; intake: { id: string; label: string; answer: string }[] } | { ok: false; reason: 'intake_required' | 'intake_invalid' } {
  if (answers != null && (typeof answers !== 'object' || Array.isArray(answers))) return { ok: false, reason: 'intake_invalid' };
  const intake: { id: string; label: string; answer: string }[] = [];
  for (const q of questions) {
    const raw = answers?.[q.id];
    const a = typeof raw === 'string' ? raw.trim().slice(0, 1000) : '';
    if (!a) { if (q.required) return { ok: false, reason: 'intake_required' }; continue; }
    if (q.type === 'select' && !(q.options ?? []).includes(a)) return { ok: false, reason: 'intake_invalid' };
    if (q.type === 'yesno' && a !== 'yes' && a !== 'no') return { ok: false, reason: 'intake_invalid' };
    intake.push({ id: q.id, label: q.label, answer: a });
  }
  return { ok: true, intake };
}
