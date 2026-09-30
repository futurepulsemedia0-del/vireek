/**
 * Dispatch Intelligence — pure planning engine.
 *
 * No I/O, no imports: deterministic and unit-tested (dispatchIntelligence.test.ts).
 * Data gathering lives in dispatchIntelligenceApi.ts.
 *
 * For every unassigned job it evaluates every technician on:
 *   skill fit · travel (marginal detour on the technician's real day) ·
 *   remaining capacity · SLA outcome · parts on the van · quality history ·
 *   service area
 * and hard-blocks technicians who are disabled, at capacity, missing a required
 * credential, or who cannot physically reach the job in time.
 *
 * Jobs are planned most-urgent-first (emergency, SLA deadline, appointment time)
 * with each pick added to that technician's tentative day, so later jobs see the
 * updated position, load and free time. Insertion is "cheapest feasible insertion
 * with time windows": fixed appointments keep their slot, flexible jobs go into
 * whichever gap adds the least driving.
 *
 * Travel time is a straight-line estimate (haversine × circuity ÷ average speed).
 * It is always labelled an estimate; the UI can refine any route with real road
 * ETAs through the existing optimize-route function.
 */

export const DISPATCH_ENGINE_VERSION = '1.0.0';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface DispatchTech {
  id: string;
  name: string;
  skills: string[];
  serviceArea: string | null;
  maxJobsPerDay: number;
  dispatchEnabled: boolean;
  home: GeoPoint | null;
  current: GeoPoint | null;
  /** ISO time of the last live position report. */
  currentAt: string | null;
  /** 0–100 percent, null when unknown. */
  firstTimeFixRate: number | null;
}

export interface DispatchJob {
  id: string;
  customerName: string;
  serviceType: string | null;
  address: string | null;
  point: GeoPoint | null;
  scheduledAt: string | null;
  durationMinutes: number | null;
  assignedTechnicianId: string | null;
  status: string;
  createdAt: string;
  slaResponseHours: number | null;
  emergency: boolean;
}

export interface StockFitEntry {
  partsRequired: number;
  partsOnVan: number;
}

export interface PlanOptions {
  workdayStartHour: number;
  workdayEndHour: number;
  defaultDurationMin: number;
  speedMph: number;
  circuity: number;
  lateToleranceMin: number;
  minTravelMin: number;
  unknownTravelMin: number;
  currentFreshMin: number;
  emergencyDefaultSlaHours: number;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  workdayStartHour: 8,
  workdayEndHour: 20,
  defaultDurationMin: 90,
  speedMph: 28,
  circuity: 1.3,
  lateToleranceMin: 10,
  minTravelMin: 2,
  unknownTravelMin: 15,
  currentFreshMin: 60,
  emergencyDefaultSlaHours: 2,
};

export interface PlanInput {
  nowMs: number;
  technicians: DispatchTech[];
  /** Every active job on the board (assigned and unassigned). Unassigned ones get planned. */
  jobs: DispatchJob[];
  stockFit?: Record<string, Record<string, StockFitEntry>>;
  /** Labels of blocking credentials the technician lacks for that service type. */
  blockingGaps?: (technicianId: string, serviceType: string | null) => string[];
  options?: Partial<PlanOptions>;
}

export type ScoreKey = 'skill' | 'travel' | 'load' | 'sla' | 'parts' | 'quality' | 'area';

export const SCORE_MAX: Record<ScoreKey, number> = {
  skill: 25,
  travel: 25,
  load: 15,
  sla: 10,
  parts: 10,
  quality: 10,
  area: 5,
};

export const SCORE_LABELS: Record<ScoreKey, string> = {
  skill: 'Skill match',
  travel: 'Travel time',
  load: 'Free capacity',
  sla: 'SLA outcome',
  parts: 'Parts on van',
  quality: 'First-time fix',
  area: 'Service area',
};

export interface CandidateEval {
  technicianId: string;
  technicianName: string;
  eligible: boolean;
  score: number;
  breakdown: Record<ScoreKey, number>;
  reasons: string[];
  blockers: string[];
  plannedArrivalMs: number | null;
  plannedEndMs: number | null;
  travelMinutes: number | null;
  travelKnown: boolean;
  slaBreach: boolean;
  /** 0–1: share of the judgeable factors that were based on real data. */
  confidence: number;
  insertIndex: number;
}

export interface JobPlan {
  jobId: string;
  dateKey: string;
  emergency: boolean;
  slaDeadlineMs: number | null;
  recommended: CandidateEval | null;
  alternatives: CandidateEval[];
  blocked: CandidateEval[];
}

export interface RouteStop {
  jobId: string;
  arrivalMs: number;
  endMs: number;
  travelMinFromPrev: number | null;
  milesFromPrev: number | null;
  /** true when this stop is a tentative AI pick, false for an existing assignment. */
  planned: boolean;
}

export interface TechRoute {
  technicianId: string;
  technicianName: string;
  dateKey: string;
  stops: RouteStop[];
  totalDriveMinutes: number;
  totalMiles: number;
}

export interface DispatchPlan {
  engineVersion: string;
  generatedAtMs: number;
  jobs: JobPlan[];
  routes: TechRoute[];
  summary: {
    unassigned: number;
    assignable: number;
    unassignable: number;
    slaAtRisk: number;
    avgTravelMinutes: number | null;
  };
}

// ============================================================
// GEOMETRY / TIME HELPERS
// ============================================================

export function isValidPoint(p: GeoPoint | null | undefined): p is GeoPoint {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const R = 3958.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const MIN = 60_000;

export function dateKeyOf(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function atHour(dateKey: string, hour: number): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d, hour, 0, 0, 0).getTime();
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export function isEmergencyJob(job: { serviceType: string | null; emergency?: boolean }, tags?: string[]): boolean {
  if (job.emergency) return true;
  const hay = `${job.serviceType ?? ''} ${(tags ?? []).join(' ')}`.toLowerCase();
  return hay.includes('emergency');
}

/** Estimated drive minutes between two points; null when either is unknown. */
export function estimateTravelMinutes(
  a: GeoPoint | null,
  b: GeoPoint | null,
  opts: Pick<PlanOptions, 'circuity' | 'speedMph' | 'minTravelMin'> = DEFAULT_PLAN_OPTIONS,
): { minutes: number; miles: number } | null {
  if (!isValidPoint(a) || !isValidPoint(b)) return null;
  const miles = haversineMiles(a, b) * opts.circuity;
  if (miles < 0.05) return { minutes: 0, miles: 0 };
  return { minutes: Math.max(opts.minTravelMin, (miles / opts.speedMph) * 60), miles };
}

/**
 * Live ETA from a technician's current position to the job site.
 * Returns null when the position is missing, invalid or stale.
 */
export function liveEtaMinutes(
  from: GeoPoint | null,
  to: GeoPoint | null,
  reportedAtIso: string | null,
  nowMs: number,
  maxAgeMin = 10,
  bufferMin = 2,
): { minutes: number; miles: number; ageMin: number } | null {
  if (!reportedAtIso) return null;
  const t = Date.parse(reportedAtIso);
  if (Number.isNaN(t)) return null;
  const ageMin = (nowMs - t) / MIN;
  if (ageMin > maxAgeMin) return null;
  const est = estimateTravelMinutes(from, to);
  if (!est) return null;
  return { minutes: Math.max(1, Math.ceil(est.minutes + bufferMin)), miles: Math.round(est.miles * 10) / 10, ageMin: Math.max(0, ageMin) };
}

export function slaDeadlineMs(job: DispatchJob, opts: PlanOptions): number | null {
  const created = Date.parse(job.createdAt);
  if (Number.isNaN(created)) return null;
  if (job.slaResponseHours !== null && job.slaResponseHours > 0) return created + job.slaResponseHours * 3_600_000;
  if (job.emergency) return created + opts.emergencyDefaultSlaHours * 3_600_000;
  return null;
}

// ============================================================
// TIMELINE + INSERTION
// ============================================================

interface Stop {
  jobId: string;
  start: number;
  end: number;
  point: GeoPoint | null;
  planned: boolean;
}

interface Insertion {
  ok: boolean;
  reason?: string;
  index: number;
  arrivalMs: number;
  endMs: number;
  travelInMin: number | null;
  detourMin: number;
  travelKnown: boolean;
}

interface Origin {
  point: GeoPoint | null;
  availableAt: number;
}

function originFor(tech: DispatchTech, dateKey: string, nowMs: number, opts: PlanOptions): Origin {
  const dayStart = atHour(dateKey, opts.workdayStartHour);
  if (dateKey === dateKeyOf(nowMs)) {
    const fresh =
      isValidPoint(tech.current) &&
      !!tech.currentAt &&
      nowMs - Date.parse(tech.currentAt) <= opts.currentFreshMin * MIN &&
      !Number.isNaN(Date.parse(tech.currentAt));
    if (fresh) return { point: tech.current, availableAt: nowMs };
    return { point: isValidPoint(tech.home) ? tech.home : null, availableAt: Math.max(nowMs, dayStart) };
  }
  return { point: isValidPoint(tech.home) ? tech.home : null, availableAt: dayStart };
}

function tryInsert(
  stops: Stop[],
  job: DispatchJob,
  origin: Origin,
  dateKey: string,
  scheduledMs: number | null,
  opts: PlanOptions,
): Insertion {
  const dur = (job.durationMinutes && job.durationMinutes > 0 ? job.durationMinutes : opts.defaultDurationMin) * MIN;
  const dayEnd = atHour(dateKey, opts.workdayEndHour);
  const tol = opts.lateToleranceMin * MIN;

  const legMin = (a: GeoPoint | null, b: GeoPoint | null): { min: number; known: boolean } => {
    const e = estimateTravelMinutes(a, b, opts);
    return e ? { min: e.minutes, known: true } : { min: opts.unknownTravelMin, known: false };
  };

  const indices: number[] =
    scheduledMs !== null
      ? [stops.filter((s) => s.start <= scheduledMs).length]
      : Array.from({ length: stops.length + 1 }, (_, i) => i);

  let best: Insertion | null = null;
  let firstReason = 'No feasible slot that day';

  for (const idx of indices) {
    const prev = idx > 0 ? stops[idx - 1] : null;
    const next = idx < stops.length ? stops[idx] : null;
    const fromPoint = prev ? prev.point : origin.point;
    const fromTime = prev ? prev.end : origin.availableAt;

    const tin = legMin(fromPoint, job.point);
    const reachMs = fromTime + tin.min * MIN;
    const arrival = scheduledMs !== null ? Math.max(reachMs, scheduledMs) : reachMs;

    if (scheduledMs !== null && reachMs > scheduledMs + tol) {
      firstReason = `Would arrive ${Math.round((reachMs - scheduledMs) / MIN)} min late after the previous job`;
      continue;
    }
    const end = arrival + dur;
    if (end > dayEnd) {
      firstReason = 'No working time left that day';
      continue;
    }
    let detour = tin.min;
    let known = tin.known;
    if (next) {
      const tout = legMin(job.point, next.point);
      if (end + tout.min * MIN > next.start + tol) {
        firstReason = 'Would make the next job late';
        continue;
      }
      const direct = legMin(fromPoint, next.point);
      detour = tin.min + tout.min - direct.min;
      known = known && tout.known;
    }
    const cand: Insertion = {
      ok: true,
      index: idx,
      arrivalMs: arrival,
      endMs: end,
      travelInMin: tin.known ? tin.min : null,
      detourMin: Math.max(0, detour),
      travelKnown: known,
    };
    if (!best || cand.detourMin < best.detourMin - 1e-9 || (Math.abs(cand.detourMin - best.detourMin) < 1e-9 && cand.arrivalMs < best.arrivalMs)) {
      best = cand;
    }
  }

  return best ?? { ok: false, reason: firstReason, index: 0, arrivalMs: 0, endMs: 0, travelInMin: null, detourMin: 0, travelKnown: false };
}

// ============================================================
// SCORING
// ============================================================

function skillScore(tech: DispatchTech, serviceType: string | null): { pts: number; known: boolean; reason: string } {
  if (!serviceType) return { pts: SCORE_MAX.skill * 0.5, known: false, reason: 'No service type on the job' };
  const svc = serviceType.trim().toLowerCase();
  const skills = tech.skills.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (skills.length === 0) return { pts: 8, known: false, reason: 'No skills listed for this technician' };
  if (skills.includes(svc)) return { pts: SCORE_MAX.skill, known: true, reason: `Skilled in ${serviceType}` };
  if (skills.some((s) => s.includes(svc) || svc.includes(s))) return { pts: 15, known: true, reason: `Related skill for ${serviceType}` };
  return { pts: 0, known: true, reason: `No skill match for ${serviceType}` };
}

function travelScore(minutes: number | null): number {
  if (minutes === null) return 10;
  return SCORE_MAX.travel * clamp(1 - minutes / 40, 0, 1);
}

function evaluateCandidate(
  tech: DispatchTech,
  job: DispatchJob,
  stops: Stop[],
  dateKey: string,
  scheduledMs: number | null,
  deadlineMs: number | null,
  input: PlanInput,
  opts: PlanOptions,
): CandidateEval {
  const zero: Record<ScoreKey, number> = { skill: 0, travel: 0, load: 0, sla: 0, parts: 0, quality: 0, area: 0 };
  const base: CandidateEval = {
    technicianId: tech.id,
    technicianName: tech.name,
    eligible: false,
    score: 0,
    breakdown: zero,
    reasons: [],
    blockers: [],
    plannedArrivalMs: null,
    plannedEndMs: null,
    travelMinutes: null,
    travelKnown: false,
    slaBreach: false,
    confidence: 0,
    insertIndex: 0,
  };

  const cap = tech.maxJobsPerDay > 0 ? tech.maxJobsPerDay : 6;
  if (!tech.dispatchEnabled) base.blockers.push('Dispatch is turned off for this technician');
  const gaps = input.blockingGaps ? input.blockingGaps(tech.id, job.serviceType) : [];
  for (const g of gaps) base.blockers.push(`Missing required credential: ${g}`);
  if (stops.length >= cap) base.blockers.push(`At capacity (${stops.length}/${cap} jobs)`);

  const ins = tryInsert(stops, job, originFor(tech, dateKey, input.nowMs, opts), dateKey, scheduledMs, opts);
  if (!ins.ok) base.blockers.push(ins.reason ?? 'Cannot fit this job into the day');
  if (base.blockers.length > 0 || !ins.ok) return base;

  const reasons: string[] = [];
  const sk = skillScore(tech, job.serviceType);
  reasons.push(sk.reason);

  const travelMin = ins.travelKnown ? ins.detourMin : null;
  if (travelMin !== null) reasons.push(`Adds ${Math.round(travelMin)} min of driving`);
  else reasons.push('Location unknown — travel not scored');

  const load = SCORE_MAX.load * clamp((cap - stops.length) / cap, 0, 1);
  reasons.push(`${stops.length}/${cap} jobs that day`);

  let sla = 6;
  let slaBreach = false;
  let slaKnown = false;
  if (deadlineMs !== null) {
    slaKnown = true;
    const slack = deadlineMs - ins.arrivalMs;
    if (slack < 0) {
      sla = -15;
      slaBreach = true;
      reasons.push(`Arrives ${Math.round(-slack / MIN)} min after the SLA deadline`);
    } else if (slack < 60 * MIN) {
      sla = 4;
      reasons.push('Meets SLA with under 1 hour to spare');
    } else {
      sla = SCORE_MAX.sla;
      reasons.push('Comfortably meets SLA');
    }
  }

  const fit = input.stockFit?.[job.id]?.[tech.id];
  let parts = 5;
  let partsKnown = false;
  if (fit && fit.partsRequired > 0) {
    partsKnown = true;
    parts = fit.partsOnVan >= fit.partsRequired ? SCORE_MAX.parts : Math.round((fit.partsOnVan / fit.partsRequired) * 5);
    reasons.push(
      fit.partsOnVan >= fit.partsRequired
        ? `Van has all ${fit.partsRequired} required part(s)`
        : `Van has ${fit.partsOnVan}/${fit.partsRequired} required parts`,
    );
  }

  let quality = 5;
  const qualityKnown = tech.firstTimeFixRate !== null && Number.isFinite(tech.firstTimeFixRate);
  if (qualityKnown) {
    quality = SCORE_MAX.quality * clamp((tech.firstTimeFixRate as number) / 100, 0, 1);
    reasons.push(`${Math.round(tech.firstTimeFixRate as number)}% first-time fix`);
  }

  const area =
    tech.serviceArea && job.address && job.address.toLowerCase().includes(tech.serviceArea.toLowerCase()) ? SCORE_MAX.area : 0;
  if (area > 0) reasons.push(`Covers ${tech.serviceArea}`);

  const breakdown: Record<ScoreKey, number> = {
    skill: sk.pts,
    travel: travelScore(travelMin),
    load,
    sla,
    parts,
    quality,
    area,
  };
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

  const judged = [ins.travelKnown, sk.known, partsKnown, qualityKnown, slaKnown];
  const confidence = judged.filter(Boolean).length / judged.length;

  return {
    ...base,
    eligible: true,
    score: Math.round(clamp(total, 0, 100)),
    breakdown: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, Math.round(v * 10) / 10])) as Record<ScoreKey, number>,
    reasons,
    plannedArrivalMs: ins.arrivalMs,
    plannedEndMs: ins.endMs,
    travelMinutes: travelMin === null ? null : Math.round(travelMin * 10) / 10,
    travelKnown: ins.travelKnown,
    slaBreach,
    confidence: Math.round(confidence * 100) / 100,
    insertIndex: ins.index,
  };
}

// ============================================================
// PLAN
// ============================================================

function compareCandidates(a: CandidateEval, b: CandidateEval): number {
  return (
    b.score - a.score ||
    (a.travelMinutes ?? Infinity) - (b.travelMinutes ?? Infinity) ||
    (a.plannedArrivalMs ?? Infinity) - (b.plannedArrivalMs ?? Infinity) ||
    a.technicianId.localeCompare(b.technicianId)
  );
}

export function planDispatch(input: PlanInput): DispatchPlan {
  const opts: PlanOptions = { ...DEFAULT_PLAN_OPTIONS, ...(input.options ?? {}) };
  const nowMs = input.nowMs;

  // ---- tentative timelines from existing assignments ----
  const timelines = new Map<string, Stop[]>();
  const keyOf = (techId: string, dateKey: string) => `${techId}|${dateKey}`;
  const techById = new Map(input.technicians.map((t) => [t.id, t]));

  const addStop = (techId: string, dateKey: string, stop: Stop) => {
    const k = keyOf(techId, dateKey);
    const list = timelines.get(k) ?? [];
    list.push(stop);
    list.sort((a, b) => a.start - b.start || a.jobId.localeCompare(b.jobId));
    timelines.set(k, list);
  };

  for (const j of input.jobs) {
    if (!j.assignedTechnicianId || !techById.has(j.assignedTechnicianId) || !j.scheduledAt) continue;
    const start = Date.parse(j.scheduledAt);
    if (Number.isNaN(start)) continue;
    const dur = (j.durationMinutes && j.durationMinutes > 0 ? j.durationMinutes : opts.defaultDurationMin) * MIN;
    let end = start + dur;
    if (j.status === 'in_progress' || j.status === 'en_route') end = Math.max(end, nowMs);
    addStop(j.assignedTechnicianId, dateKeyOf(start), {
      jobId: j.id,
      start,
      end,
      point: isValidPoint(j.point) ? j.point : null,
      planned: false,
    });
  }

  // ---- order unassigned jobs by urgency ----
  const todayKey = dateKeyOf(nowMs);
  const flexDateKey = nowMs >= atHour(todayKey, opts.workdayEndHour) ? dateKeyOf(nowMs + 24 * 3_600_000) : todayKey;

  const unassigned = input.jobs
    .filter((j) => !j.assignedTechnicianId)
    .map((j) => {
      const scheduledMs = j.scheduledAt ? Date.parse(j.scheduledAt) : NaN;
      const sched = Number.isNaN(scheduledMs) ? null : scheduledMs;
      return {
        job: j,
        scheduledMs: sched,
        dateKey: sched !== null ? dateKeyOf(sched) : flexDateKey,
        deadline: slaDeadlineMs(j, opts),
      };
    })
    .sort(
      (a, b) =>
        Number(b.job.emergency) - Number(a.job.emergency) ||
        (a.deadline ?? Infinity) - (b.deadline ?? Infinity) ||
        (a.scheduledMs ?? Infinity) - (b.scheduledMs ?? Infinity) ||
        Date.parse(a.job.createdAt) - Date.parse(b.job.createdAt) ||
        a.job.id.localeCompare(b.job.id),
    );

  const jobPlans: JobPlan[] = [];

  for (const u of unassigned) {
    const evals = input.technicians.map((t) =>
      evaluateCandidate(t, u.job, timelines.get(keyOf(t.id, u.dateKey)) ?? [], u.dateKey, u.scheduledMs, u.deadline, input, opts),
    );
    const eligible = evals.filter((e) => e.eligible).sort(compareCandidates);
    const blocked = evals.filter((e) => !e.eligible).sort((a, b) => a.technicianName.localeCompare(b.technicianName));
    const recommended = eligible[0] ?? null;

    if (recommended && recommended.plannedArrivalMs !== null && recommended.plannedEndMs !== null) {
      addStop(recommended.technicianId, u.dateKey, {
        jobId: u.job.id,
        start: recommended.plannedArrivalMs,
        end: recommended.plannedEndMs,
        point: isValidPoint(u.job.point) ? u.job.point : null,
        planned: true,
      });
    }

    jobPlans.push({
      jobId: u.job.id,
      dateKey: u.dateKey,
      emergency: u.job.emergency,
      slaDeadlineMs: u.deadline,
      recommended,
      alternatives: eligible.slice(1, 4),
      blocked,
    });
  }

  // ---- routes (existing + tentative) ----
  const routes: TechRoute[] = [];
  const keys = Array.from(timelines.keys()).sort();
  for (const k of keys) {
    const [techId, dateKey] = k.split('|');
    const tech = techById.get(techId);
    const stops = timelines.get(k) ?? [];
    if (!tech || stops.length === 0) continue;
    const origin = originFor(tech, dateKey, nowMs, opts);
    let prevPoint = origin.point;
    let driveMin = 0;
    let miles = 0;
    const out: RouteStop[] = stops.map((s) => {
      const leg = estimateTravelMinutes(prevPoint, s.point, opts);
      if (leg) {
        driveMin += leg.minutes;
        miles += leg.miles;
      }
      prevPoint = s.point ?? prevPoint;
      return {
        jobId: s.jobId,
        arrivalMs: s.start,
        endMs: s.end,
        travelMinFromPrev: leg ? Math.round(leg.minutes) : null,
        milesFromPrev: leg ? Math.round(leg.miles * 10) / 10 : null,
        planned: s.planned,
      };
    });
    routes.push({
      technicianId: techId,
      technicianName: tech.name,
      dateKey,
      stops: out,
      totalDriveMinutes: Math.round(driveMin),
      totalMiles: Math.round(miles * 10) / 10,
    });
  }

  const assignable = jobPlans.filter((p) => p.recommended).length;
  const travels = jobPlans.map((p) => p.recommended?.travelMinutes).filter((n): n is number => typeof n === 'number');

  return {
    engineVersion: DISPATCH_ENGINE_VERSION,
    generatedAtMs: nowMs,
    jobs: jobPlans,
    routes,
    summary: {
      unassigned: jobPlans.length,
      assignable,
      unassignable: jobPlans.length - assignable,
      slaAtRisk: jobPlans.filter((p) => p.recommended?.slaBreach).length,
      avgTravelMinutes: travels.length > 0 ? Math.round((travels.reduce((a, b) => a + b, 0) / travels.length) * 10) / 10 : null,
    },
  };
}
