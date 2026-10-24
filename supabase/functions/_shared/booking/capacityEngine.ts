// Capacity-based smart booking engine — PURE (no I/O, no Deno APIs) so the exact same code decides
// which slots are offered on the public booking page, the AI voice agent, SMS and MCP agents, and
// is unit-tested with vitest. It reuses the dispatch rules engine (skills, zones, preferences, VIP,
// drive-time, overtime) for technician eligibility and mirrors the thresholds of the capacity-demand
// control (get_capacity_status). Hard gates that live in the database (time off trigger, credentials,
// the jobs_no_double_booking constraint) are re-checked at commit time by book_capacity_slot().
//
// A slot is offered only when at least one technician can really take it:
//   qualified (skill/zone/preferences) · working that day (time off, blackout, weekly days) ·
//   free for [start, start + PREDICTED duration] with buffers and drive time to/from neighbouring jobs ·
//   under the daily job/minute limit (+ controlled overbooking when cancellations justify it) ·
//   without eating the emergency reserve.
// Every slot — offered or hidden — carries a machine-readable reason and a human explanation.

import {
  DEFAULT_PARAMS,
  haversineMiles,
  rankTechnicians,
  type DispatchRule,
  type EngineJob,
  type EnginePreference,
  type EngineTechnician,
  type EngineTerritory,
  type RankedTechnician,
} from '../dispatch/rulesEngine.ts';

export type ReasonCode =
  | 'offered'
  | 'outside_hours'
  | 'holiday_blackout'
  | 'lead_time'
  | 'no_qualified_technician'
  | 'technicians_unavailable'
  | 'fully_booked'
  | 'day_at_capacity'
  | 'drive_time'
  | 'emergency_reserve'
  | 'unassigned_job_overlap';

export interface CapacityPolicy {
  /** Master switch. false = every channel keeps its legacy behaviour. */
  enabled: boolean;
  slot_step_minutes: number;
  /** Travel time assumed between two jobs when coordinates are unknown. */
  default_travel_minutes: number;
  /** Max extra jobs per technician per day above max_jobs_per_day (0 = overbooking off). */
  overbook_jobs_per_tech: number;
  /** Overbooking only unlocks when the trailing cancel/no-show rate is at least this %. */
  overbook_min_cancel_rate_pct: number;
  emergency_reserve_slots: number;
  low_threshold_pct: number;
  full_threshold_pct: number;
  max_slots_per_day: number;
}

export const DEFAULT_CAPACITY_POLICY: CapacityPolicy = {
  enabled: false,
  slot_step_minutes: 30,
  default_travel_minutes: 20,
  overbook_jobs_per_tech: 0,
  overbook_min_cancel_rate_pct: 10,
  emergency_reserve_slots: 1,
  low_threshold_pct: 50,
  full_threshold_pct: 90,
  max_slots_per_day: 12,
};

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;

/** Validates untrusted/DB values into a safe policy (never throws). */
export function sanitizePolicy(raw: Partial<Record<keyof CapacityPolicy, unknown>> | null | undefined): CapacityPolicy {
  const r = raw ?? {};
  const d = DEFAULT_CAPACITY_POLICY;
  const low = clampInt(r.low_threshold_pct, 0, 100, d.low_threshold_pct);
  const full = clampInt(r.full_threshold_pct, 0, 100, d.full_threshold_pct);
  return {
    enabled: r.enabled === true,
    slot_step_minutes: clampInt(r.slot_step_minutes, 5, 240, d.slot_step_minutes),
    default_travel_minutes: clampInt(r.default_travel_minutes, 0, 240, d.default_travel_minutes),
    overbook_jobs_per_tech: clampInt(r.overbook_jobs_per_tech, 0, 3, d.overbook_jobs_per_tech),
    overbook_min_cancel_rate_pct: clampInt(r.overbook_min_cancel_rate_pct, 0, 100, d.overbook_min_cancel_rate_pct),
    emergency_reserve_slots: clampInt(r.emergency_reserve_slots, 0, 50, d.emergency_reserve_slots),
    low_threshold_pct: low < full ? low : d.low_threshold_pct,
    full_threshold_pct: low < full ? full : d.full_threshold_pct,
    max_slots_per_day: clampInt(r.max_slots_per_day, 1, 48, d.max_slots_per_day),
  };
}

/** Used when the owner has not enabled any dispatch rule, so skills/zones are still respected. */
export const DEFAULT_BOOKING_RULES: DispatchRule[] = [
  { id: 'booking:skill', rule_type: 'skill_match', name: 'Skill match', enabled: true, mode: 'require', weight: 10, params: {}, position: 0 },
  { id: 'booking:zone', rule_type: 'zone', name: 'Service zone', enabled: true, mode: 'require', weight: 10, params: {}, position: 1 },
  { id: 'booking:drive', rule_type: 'max_drive_time', name: 'Drive time', enabled: true, mode: 'score', weight: 15, params: {}, position: 2 },
  { id: 'booking:pref', rule_type: 'tech_preference', name: 'Technician preference', enabled: true, mode: 'score', weight: 10, params: {}, position: 3 },
  { id: 'booking:overtime', rule_type: 'overtime_limit', name: 'Daily hours', enabled: true, mode: 'require', weight: 10, params: {}, position: 4 },
];

export type HoursByDay = Partial<Record<'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat', { open: string; close: string }>>;
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export interface BusyJob {
  id: string;
  technician_id: string | null;
  /** epoch ms */
  start: number;
  end: number;
  lat: number | null;
  lon: number | null;
}
export interface TimeOffRow { technician_id: string; start_date: string; end_date: string }
export interface BlackoutRow { label: string; start_date: string; end_date: string }

export interface BookingContext {
  now: number;
  timezone: string;
  hours: HoursByDay;
  /** 'YYYY-MM-DD' company holidays. */
  holidays: string[];
  leadTimeHours: number;
  windowDays: number;
  bufferBefore: number;
  bufferAfter: number;
  policy: CapacityPolicy;
  technicians: EngineTechnician[];
  rules: DispatchRule[];
  territories: EngineTerritory[];
  preferences: EnginePreference[];
  /** Open jobs (scheduled / en_route / in_progress) around the window. */
  jobs: BusyJob[];
  timeOff: TimeOffRow[];
  blackouts: BlackoutRow[];
  /** technician id -> working weekdays (0 = Sunday). No entry = every day. */
  workingDays: Record<string, number[]>;
  /** Trailing cancel + no-show share of booked jobs (0–1), null when unknown. */
  cancelRate: number | null;
  /** technician id -> missing blocking credentials for the requested service (from technician_compliance_gaps). */
  credentialGaps?: Record<string, string[]>;
}

export interface BookingRequest {
  serviceType: string | null;
  /** Predicted on-site duration in minutes. */
  durationMinutes: number;
  address: string | null;
  lat: number | null;
  lon: number | null;
  customerId: string | null;
  isVip: boolean;
  /** Emergency requests may use the emergency reserve. */
  isEmergency: boolean;
}

export interface SlotDecision {
  /** ISO start/end (UTC). */
  start: string;
  end: string;
  offered: boolean;
  technician_id: string | null;
  technician_name: string | null;
  overbooked: boolean;
  reasons: ReasonCode[];
  explanation: string;
  score: number;
  travel_estimated: boolean;
}

export interface DayDecision {
  date: string;
  demand: { status: 'low' | 'optimal' | 'full' | 'no_capacity'; load: number; capacity: number; load_pct: number | null; normal_slots_remaining: number };
  offered: number;
  hidden: number;
  reason: ReasonCode | null;
}

export interface AvailabilityResult {
  duration_minutes: number;
  slots: SlotDecision[];
  days: DayDecision[];
  overbooking_allowance_per_tech: number;
}

// ---------------------------------------------------------------------------------------------
// Time zone helpers (IANA, DST-safe, no dependencies)
// ---------------------------------------------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function safeTimezone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try { formatter(tz); return tz; } catch { return 'UTC'; }
}

function parts(ms: number, tz: string) {
  const o: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}

function tzOffsetMs(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock time in `tz` -> epoch ms. */
export function zonedToUtc(y: number, m: number, d: number, minutesOfDay: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutesOfDay / 60), minutesOfDay % 60);
  const off1 = tzOffsetMs(guess, tz);
  const t = guess - off1;
  const off2 = tzOffsetMs(t, tz);
  return off1 === off2 ? t : guess - off2;
}

const pad = (n: number) => String(n).padStart(2, '0');
export function localDateKey(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function parseHm(s: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h > 24 || mi > 59 ? null : h * 60 + mi;
}

/** "Thursday, Oct 22, 2:30 PM" in the business time zone — for voice/SMS/MCP replies. */
export function formatSlotLocal(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: safeTimezone(tz), weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

// ---------------------------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------------------------

const MIN = 60_000;
const inRange = (day: string, start: string, end: string) => day >= start && day <= end;
const round1 = (n: number) => Math.round(n * 10) / 10;
const baseCapacity = (t: EngineTechnician) => (t.max_jobs_per_day > 0 ? t.max_jobs_per_day : 6);

/** Extra jobs per technician allowed today, justified by the real cancel/no-show history. */
export function overbookAllowance(policy: CapacityPolicy, cancelRate: number | null, base: number): number {
  if (policy.overbook_jobs_per_tech <= 0 || cancelRate == null || !Number.isFinite(cancelRate)) return 0;
  if (cancelRate * 100 < policy.overbook_min_cancel_rate_pct) return 0;
  return Math.max(0, Math.min(policy.overbook_jobs_per_tech, Math.floor(base * cancelRate)));
}

/** Mirrors technician_unavailable_reason() in SQL. */
export function unavailableReason(ctx: Pick<BookingContext, 'timeOff' | 'blackouts' | 'workingDays'>, techId: string, dateKey: string, weekday: number): string | null {
  const b = ctx.blackouts.find((x) => inRange(dateKey, x.start_date, x.end_date));
  if (b) return `Company blackout: ${b.label}`;
  if (ctx.timeOff.some((t) => t.technician_id === techId && inRange(dateKey, t.start_date, t.end_date))) return 'Time off';
  const days = ctx.workingDays[techId];
  if (days && !days.includes(weekday)) return 'Not scheduled that weekday';
  return null;
}

interface Pt { lat: number | null; lon: number | null }
function travelMs(a: Pt, b: Pt, ctx: BookingContext): { ms: number; estimated: boolean } {
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return { ms: ctx.policy.default_travel_minutes * MIN, estimated: true };
  const miles = haversineMiles(a.lat, a.lon, b.lat, b.lon);
  return { ms: Math.ceil(((miles * DEFAULT_PARAMS.circuity * 60) / DEFAULT_PARAMS.avg_speed_mph) * MIN), estimated: false };
}

type FailKind = 'overlap' | 'gap_travel' | 'gap_buffer';
type Fit = { ok: true; addedTravelMs: number; estimated: boolean } | { ok: false; kind: FailKind };

function fitsTechnician(jobs: BusyJob[], start: number, end: number, req: Pick<BookingRequest, 'lat' | 'lon'>, ctx: BookingContext): Fit {
  const bb = ctx.bufferBefore * MIN;
  const ba = ctx.bufferAfter * MIN;
  let prev: BusyJob | null = null;
  let next: BusyJob | null = null;
  for (const e of jobs) {
    if (e.start < end && e.end > start) return { ok: false, kind: 'overlap' };
    if (e.end <= start) { if (!prev || e.end > prev.end) prev = e; } else if (!next || e.start < next.start) next = e;
  }
  let added = 0;
  let estimated = false;
  const me: Pt = { lat: req.lat, lon: req.lon };
  for (const e of jobs) {
    if (e.end <= start) {
      const t = travelMs(e, me, ctx);
      if (e.end + bb + t.ms > start) return { ok: false, kind: e.end + bb <= start ? 'gap_travel' : 'gap_buffer' };
      if (e === prev) { added += t.ms; estimated ||= t.estimated; }
    } else if (e.start >= end) {
      const t = travelMs(me, e, ctx);
      if (end + ba + t.ms > e.start) return { ok: false, kind: end + ba <= e.start ? 'gap_travel' : 'gap_buffer' };
      if (e === next) { added += t.ms; estimated ||= t.estimated; }
    }
  }
  return { ok: true, addedTravelMs: added, estimated };
}

function classifyExcluded(r: RankedTechnician): ReasonCode {
  const f = r.factors.find((x) => x.outcome === 'fail');
  if (!f) return 'no_qualified_technician';
  if (f.rule_type === 'capacity' || f.rule_type === 'overtime_limit') return 'day_at_capacity';
  if (f.rule_type === 'max_drive_time') return 'drive_time';
  return 'no_qualified_technician';
}

const EXPLAIN: Record<Exclude<ReasonCode, 'offered'>, (ctx: BookingContext, extra?: string) => string> = {
  outside_hours: () => 'Outside business hours, or the predicted visit would run past closing time.',
  holiday_blackout: () => 'Company holiday or blackout date — no technicians are dispatched.',
  lead_time: (c) => `Too soon: bookings need at least ${c.leadTimeHours}h notice.`,
  no_qualified_technician: (_c, x) => `No technician has the required skill, zone or customer preference for this service${x ? ` (${x})` : ''}.`,
  technicians_unavailable: () => 'Every technician is on time off, blacked out or not scheduled that day.',
  fully_booked: () => 'Every qualified technician is already booked at that time, or cannot get there in time.',
  day_at_capacity: () => 'All qualified technicians have reached their daily job or hours limit.',
  drive_time: () => 'The only qualified technicians would need to drive too far or have too little travel time between jobs.',
  emergency_reserve: (c) => `The last ${c.policy.emergency_reserve_slots} slot(s) of the day are held for emergencies.`,
  unassigned_job_overlap: () => 'An unassigned job already holds this time — assign it to a technician to free the slot.',
};

interface DayCtx {
  key: string;
  weekday: number;
  open: number | null;
  close: number | null;
  y: number; m: number; d: number;
  hiddenReason: ReasonCode | null;
  hiddenDetail?: string;
  eligible: RankedTechnician[];
  techById: Map<string, EngineTechnician>;
  jobsByTech: Map<string, BusyJob[]>;
  unassigned: BusyJob[];
  baseLoad: Map<string, number>;
  allowance: number;
  demand: DayDecision['demand'];
}

function groupJobsByDay(ctx: BookingContext): Map<string, BusyJob[]> {
  const out = new Map<string, BusyJob[]>();
  for (const j of ctx.jobs) {
    const k = localDateKey(j.start, ctx.timezone);
    (out.get(k) ?? out.set(k, []).get(k)!).push(j);
  }
  return out;
}

function buildDay(ctx: BookingContext, req: BookingRequest, key: string, dayJobs: BusyJob[]): DayCtx {
  const [y, m, d] = key.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const h = ctx.hours[DAY_KEYS[weekday]];
  const open = h ? parseHm(h.open) : null;
  const close = h ? parseHm(h.close) : null;

  const jobsByTech = new Map<string, BusyJob[]>();
  const unassigned: BusyJob[] = [];
  for (const j of dayJobs) {
    if (!j.technician_id) unassigned.push(j);
    else (jobsByTech.get(j.technician_id) ?? jobsByTech.set(j.technician_id, []).get(j.technician_id)!).push(j);
  }

  const day: DayCtx = {
    key, weekday, open, close, y, m, d, hiddenReason: null, eligible: [], techById: new Map(), jobsByTech, unassigned,
    baseLoad: new Map(), allowance: 0, demand: { status: 'no_capacity', load: dayJobs.length, capacity: 0, load_pct: null, normal_slots_remaining: 0 },
  };

  if (ctx.holidays.includes(key) || ctx.blackouts.some((b) => inRange(key, b.start_date, b.end_date))) { day.hiddenReason = 'holiday_blackout'; return day; }

  const avail = ctx.technicians.filter((t) => unavailableReason(ctx, t.id, key, weekday) === null);
  if (avail.length === 0) { day.hiddenReason = 'technicians_unavailable'; return day; }

  const capBase = avail.reduce((s, t) => s + baseCapacity(t), 0);
  const allowance = overbookAllowance(ctx.policy, ctx.cancelRate, Math.round(capBase / avail.length));
  day.allowance = allowance;
  const capEff = capBase + allowance * avail.length;
  const load = dayJobs.length;
  const loadPct = capBase > 0 ? round1((load / capBase) * 100) : null;
  const status = capBase === 0 ? 'no_capacity' : loadPct! >= ctx.policy.full_threshold_pct ? 'full' : loadPct! <= ctx.policy.low_threshold_pct ? 'low' : 'optimal';
  const remainingEff = Math.max(0, capEff - load);
  const normalRemaining = Math.max(0, remainingEff - ctx.policy.emergency_reserve_slots);
  day.demand = { status, load, capacity: capBase, load_pct: loadPct, normal_slots_remaining: normalRemaining };

  // Rank with the dispatch rules engine; capacity inside it already includes the overbooking allowance.
  const loads: Record<string, { jobs: number; minutes: number }> = {};
  for (const [tid, js] of jobsByTech) loads[tid] = { jobs: js.length, minutes: js.reduce((s, j) => s + (j.end - j.start) / MIN, 0) };
  for (const t of avail) day.baseLoad.set(t.id, loads[t.id]?.jobs ?? 0);
  const engineJob: EngineJob = { id: 'booking-request', service_type: req.serviceType, address: req.address, lat: req.lat, lon: req.lon, duration_minutes: req.durationMinutes, customer_id: req.customerId, is_vip: req.isVip };
  const rankTechs = avail.map((t) => ({
    ...t,
    skills: t.skills.length === 0 && req.serviceType ? [req.serviceType] : t.skills, // technician with no listed skills = generalist
    max_jobs_per_day: baseCapacity(t) + allowance,
  }));
  for (const t of avail) day.techById.set(t.id, t);
  const rules = ctx.rules.some((r) => r.enabled) ? ctx.rules : DEFAULT_BOOKING_RULES;
  const ranking = rankTechnicians({ job: engineJob, technicians: rankTechs, rules, territories: ctx.territories, preferences: ctx.preferences, loads });
  const gaps = ctx.credentialGaps ?? {};
  const credentialed = ranking.ranked.filter((r) => r.eligible && !(gaps[r.technician_id]?.length));
  day.eligible = credentialed;

  if (day.eligible.length === 0 && ranking.ranked.some((r) => r.eligible)) {
    day.hiddenReason = 'no_qualified_technician';
    day.hiddenDetail = 'missing required credentials for this service';
    return day;
  }
  if (day.eligible.length === 0) {
    const counts = new Map<ReasonCode, number>();
    for (const r of ranking.ranked) counts.set(classifyExcluded(r), (counts.get(classifyExcluded(r)) ?? 0) + 1);
    const order: ReasonCode[] = ['no_qualified_technician', 'drive_time', 'day_at_capacity'];
    day.hiddenReason = order.reduce((best, c) => ((counts.get(c) ?? 0) > (counts.get(best) ?? 0) ? c : best), order[0]);
    day.hiddenDetail = ranking.ranked.slice(0, 2).map((r) => `${r.technician_name}: ${r.blocked_by[0] ?? 'excluded'}`).join('; ');
    return day;
  }
  if (!req.isEmergency && normalRemaining <= 0) day.hiddenReason = remainingEff <= 0 ? 'day_at_capacity' : 'emergency_reserve';
  return day;
}

function hidden(ctx: BookingContext, start: number, end: number, reason: Exclude<ReasonCode, 'offered'>, detail?: string): SlotDecision {
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), offered: false, technician_id: null, technician_name: null, overbooked: false, reasons: [reason], explanation: EXPLAIN[reason](ctx, detail), score: 0, travel_estimated: false };
}

function decide(ctx: BookingContext, req: BookingRequest, day: DayCtx, start: number): SlotDecision {
  const end = start + req.durationMinutes * MIN;
  if (day.open == null || day.close == null) return hidden(ctx, start, end, 'outside_hours');
  const lp = parts(start, ctx.timezone);
  const startMin = (lp.hour === 24 ? 0 : lp.hour) * 60 + lp.minute; // wall-clock minutes: correct across DST changes
  if (startMin < day.open || startMin + req.durationMinutes > day.close) return hidden(ctx, start, end, 'outside_hours');
  if (start < ctx.now + ctx.leadTimeHours * 3_600_000) return hidden(ctx, start, end, 'lead_time');
  if (day.hiddenReason) return hidden(ctx, start, end, day.hiddenReason as Exclude<ReasonCode, 'offered'>, day.hiddenDetail);
  if (day.unassigned.some((j) => j.start < end && j.end > start)) return hidden(ctx, start, end, 'unassigned_job_overlap');

  const fitting: { r: RankedTechnician; overbooked: boolean; added: number; estimated: boolean }[] = [];
  const failKinds: FailKind[] = [];
  for (const r of day.eligible) {
    const t = day.techById.get(r.technician_id)!;
    const jobs = day.jobsByTech.get(t.id) ?? [];
    const fit = fitsTechnician(jobs, start, end, req, ctx);
    if (!fit.ok) { failKinds.push(fit.kind); continue; }
    fitting.push({ r, overbooked: jobs.length >= baseCapacity(t), added: fit.addedTravelMs, estimated: fit.estimated });
  }
  if (fitting.length === 0) {
    return hidden(ctx, start, end, failKinds.length > 0 && failKinds.every((k) => k === 'gap_travel') ? 'drive_time' : 'fully_booked');
  }
  fitting.sort((a, b) => Number(a.overbooked) - Number(b.overbooked) || b.r.score - a.r.score || a.added - b.added || a.r.technician_id.localeCompare(b.r.technician_id));
  const w = fitting[0];
  const load = day.baseLoad.get(w.r.technician_id) ?? 0;
  const cap = baseCapacity(day.techById.get(w.r.technician_id)!);
  const bits = [`${w.r.technician_name}: ${w.r.summary}`, `fits with ${ctx.bufferBefore}/${ctx.bufferAfter} min buffers and ~${Math.round(w.added / MIN)} min travel to neighbouring jobs${w.estimated ? ' (estimated)' : ''}`, `${load}/${cap} jobs that day`];
  if (w.overbooked) bits.push(`controlled overbooking: ${Math.round((ctx.cancelRate ?? 0) * 100)}% of recent bookings cancel or no-show`);
  return {
    start: new Date(start).toISOString(), end: new Date(end).toISOString(), offered: true,
    technician_id: w.r.technician_id, technician_name: w.r.technician_name, overbooked: w.overbooked,
    reasons: ['offered'], explanation: bits.join(' · '), score: w.r.score, travel_estimated: w.estimated,
  };
}

export interface AvailabilityOptions {
  /** Include hidden slots (with reasons) — for dashboards, MCP/voice "why not" answers. */
  includeHidden?: boolean;
  /** Hard cap on offered slots returned (default 60). */
  maxOffered?: number;
}

export function computeAvailability(ctx: BookingContext, req: BookingRequest, opts: AvailabilityOptions = {}): AvailabilityResult {
  const duration = Math.min(480, Math.max(15, Math.round(req.durationMinutes) || 60));
  const request: BookingRequest = { ...req, durationMinutes: duration };
  const slots: SlotDecision[] = [];
  const days: DayDecision[] = [];
  const byDay = groupJobsByDay(ctx);
  const [y0, m0, d0] = localDateKey(ctx.now, ctx.timezone).split('-').map(Number);
  const maxOffered = opts.maxOffered ?? 60;
  let offeredTotal = 0;
  let allowance = 0;

  for (let i = 0; i <= ctx.windowDays && offeredTotal < maxOffered; i++) {
    const key = new Date(Date.UTC(y0, m0 - 1, d0 + i)).toISOString().slice(0, 10);
    const day = buildDay(ctx, request, key, byDay.get(key) ?? []);
    allowance = Math.max(allowance, day.allowance);
    if (day.open == null || day.close == null) continue; // closed all day: nothing to show
    let offered = 0, hiddenCount = 0;
    const step = ctx.policy.slot_step_minutes;
    for (let min = day.open; min + duration <= day.close; min += step) {
      const start = zonedToUtc(day.y, day.m, day.d, min, ctx.timezone);
      if (start < ctx.now) continue;
      const s = decide(ctx, request, day, start);
      if (s.offered) {
        if (offered >= ctx.policy.max_slots_per_day || offeredTotal >= maxOffered) continue;
        offered++; offeredTotal++;
        slots.push(s);
      } else {
        hiddenCount++;
        if (opts.includeHidden) slots.push(s);
      }
    }
    days.push({ date: key, demand: day.demand, offered, hidden: hiddenCount, reason: day.hiddenReason });
  }
  return { duration_minutes: duration, slots, days, overbooking_allowance_per_tech: allowance };
}

/** Decide one specific requested start time (voice/SMS/MCP "is 2:30 Thursday free?"). */
export function evaluateSlot(ctx: BookingContext, req: BookingRequest, startMs: number): SlotDecision {
  const duration = Math.min(480, Math.max(15, Math.round(req.durationMinutes) || 60));
  const request = { ...req, durationMinutes: duration };
  const key = localDateKey(startMs, ctx.timezone);
  const windowEnd = ctx.now + (ctx.windowDays + 1) * 86_400_000;
  if (startMs < ctx.now || startMs > windowEnd) return hidden(ctx, startMs, startMs + duration * MIN, startMs < ctx.now ? 'lead_time' : 'outside_hours');
  const dayJobs = ctx.jobs.filter((j) => localDateKey(j.start, ctx.timezone) === key);
  return decide(ctx, request, buildDay(ctx, request, key, dayJobs), startMs);
}

/** The n offered slots closest to a requested time (alternatives when the request is not available). */
export function nearestOffered(slots: SlotDecision[], targetMs: number, n = 3): SlotDecision[] {
  return slots
    .filter((s) => s.offered)
    .sort((a, b) => Math.abs(Date.parse(a.start) - targetMs) - Math.abs(Date.parse(b.start) - targetMs) || a.start.localeCompare(b.start))
    .slice(0, n)
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** Public/customer-safe projection: never leaks technician identity, load or internal reasons. */
export function toPublicSlots(r: AvailabilityResult): { start: string; end: string }[] {
  return r.slots.filter((s) => s.offered).map((s) => ({ start: s.start, end: s.end }));
}

/**
 * Predicted visit length: median of recent completed jobs of the same service type (>= 5 samples),
 * clamped to 15–480 min; otherwise the configured default.
 */
export function predictDurationMinutes(history: number[], fallback: number): number {
  const clean = history.filter((n) => Number.isFinite(n) && n >= 10 && n <= 720).sort((a, b) => a - b);
  const fb = Math.min(480, Math.max(15, Math.round(fallback) || 60));
  if (clean.length < 5) return fb;
  const mid = Math.floor(clean.length / 2);
  const median = clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
  return Math.min(480, Math.max(15, Math.round(median / 5) * 5));
}
