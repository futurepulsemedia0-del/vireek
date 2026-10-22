/**
 * Job-duration model — data layer.
 *
 * Pulls measured job history, trains the pure engine in src/lib/durationModel.ts,
 * and persists what must survive a session: predictions as made, drift alerts,
 * settings and the learned per-service slot lengths used by public booking.
 *
 * Every optional source degrades gracefully: a missing table / RLS denial means a
 * smaller training set or a skipped write, never a thrown error in the UI.
 */

import { supabase, type Job } from '@/lib/supabase';
import {
  detectDrift,
  durationKey,
  historyFor,
  predictDuration,
  resolveExistingEstimate,
  slotMinutesFor,
  trainDurationModel,
  type DriftReport,
  type DurationPrediction,
  type PredictionContext,
  type SlotPolicy,
  type TrainedModel,
  type TrainingJob,
} from '@/lib/durationModel';

const PAGE = 1000;
const MAX_JOBS = 6000;
const HISTORY_DAYS = 540;
const IN_CHUNK = 150;
const MODEL_TTL_MS = 5 * 60_000;

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

// ============================================================
// SETTINGS
// ============================================================

export interface DurationSettings {
  slotPolicy: SlotPolicy;
  feedDispatch: boolean;
  feedBooking: boolean;
  driftAlertsEnabled: boolean;
}

export const DEFAULT_DURATION_SETTINGS: DurationSettings = {
  slotPolicy: 'balanced',
  feedDispatch: true,
  feedBooking: false, // customer-facing, so it is opt-in
  driftAlertsEnabled: true,
};

export async function fetchDurationSettings(ownerId: string): Promise<DurationSettings> {
  const { data, error } = await supabase
    .from('job_duration_settings')
    .select('slot_policy, feed_dispatch, feed_booking, drift_alerts_enabled')
    .eq('user_id', ownerId)
    .maybeSingle();
  if (error || !data) return DEFAULT_DURATION_SETTINGS;
  const r = data as { slot_policy: SlotPolicy; feed_dispatch: boolean; feed_booking: boolean; drift_alerts_enabled: boolean };
  return { slotPolicy: r.slot_policy, feedDispatch: r.feed_dispatch, feedBooking: r.feed_booking, driftAlertsEnabled: r.drift_alerts_enabled };
}

export async function saveDurationSettings(ownerId: string, s: DurationSettings): Promise<boolean> {
  const { error } = await supabase.from('job_duration_settings').upsert(
    {
      user_id: ownerId,
      slot_policy: s.slotPolicy,
      feed_dispatch: s.feedDispatch,
      feed_booking: s.feedBooking,
      drift_alerts_enabled: s.driftAlertsEnabled,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  invalidateDurationModel();
  return !error;
}

// ============================================================
// TRAINING DATA
// ============================================================

interface JobRow {
  id: string;
  customer_id: string | null;
  service_type: string | null;
  assigned_technician_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_minutes: number | null;
  expected_duration_minutes: number | null;
}

interface EquipLink {
  job_id: string;
  equipment_id: string;
  equipment: { equipment_type: string | null } | { equipment_type: string | null }[] | null;
}

export interface EquipmentFacts {
  ids: string[];
  types: string[];
}

async function fetchEquipmentFacts(jobIds: string[]): Promise<Map<string, EquipmentFacts>> {
  const out = new Map<string, EquipmentFacts>();
  const groups = await Promise.all(
    chunk(jobIds, IN_CHUNK).map(async (ids) => {
      const { data, error } = await supabase.from('job_equipment').select('job_id, equipment_id, equipment:equipment_id(equipment_type)').in('job_id', ids);
      return error || !data ? [] : (data as unknown as EquipLink[]);
    }),
  );
  for (const link of groups.flat()) {
    const eq = Array.isArray(link.equipment) ? link.equipment[0] : link.equipment;
    const facts = out.get(link.job_id) ?? { ids: [], types: [] };
    facts.ids.push(link.equipment_id);
    if (eq?.equipment_type) facts.types.push(eq.equipment_type);
    out.set(link.job_id, facts);
  }
  return out;
}

export async function fetchTrainingJobs(ownerId: string): Promise<TrainingJob[]> {
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();
  const rows: JobRow[] = [];
  for (let from = 0; from < MAX_JOBS; from += PAGE) {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, customer_id, service_type, assigned_technician_id, started_at, completed_at, duration_minutes, expected_duration_minutes')
      .eq('user_id', ownerId)
      .eq('job_status', 'completed')
      .not('completed_at', 'is', null)
      .gte('completed_at', since)
      .order('completed_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error || !data) break;
    rows.push(...(data as JobRow[]));
    if (data.length < PAGE) break;
  }
  if (rows.length === 0) return [];

  // Jobs completed without a start tap fall back to the recorded outcome duration.
  const needOutcome = rows.filter((r) => !r.started_at).map((r) => r.id);
  const outcomeMinutes = new Map<string, number>();
  if (needOutcome.length > 0) {
    const groups = await Promise.all(
      chunk(needOutcome, IN_CHUNK).map(async (ids) => {
        const { data } = await supabase.from('job_outcomes').select('job_id, duration_minutes').in('job_id', ids);
        return (data ?? []) as { job_id: string; duration_minutes: number | null }[];
      }),
    );
    for (const o of groups.flat()) if (o.duration_minutes && o.duration_minutes > 0) outcomeMinutes.set(o.job_id, o.duration_minutes);
  }

  const equip = await fetchEquipmentFacts(rows.map((r) => r.id));

  const out: TrainingJob[] = [];
  for (const r of rows) {
    const done = ms(r.completed_at);
    const started = ms(r.started_at);
    if (done === null) continue;
    const measured = started !== null ? (done - started) / 60_000 : (outcomeMinutes.get(r.id) ?? null);
    if (measured === null) continue;
    const eq = equip.get(r.id);
    out.push({
      jobId: r.id,
      completedAtMs: done,
      jobTypeKey: durationKey(r.service_type),
      technicianId: r.assigned_technician_id,
      equipmentIds: eq?.ids ?? [],
      equipmentTypes: eq?.types ?? [],
      customerId: r.customer_id,
      actualMinutes: measured,
      baselineMinutes: resolveExistingEstimate({ planMinutes: r.expected_duration_minutes, slotMinutes: r.duration_minutes }).minutes,
      priorMinutes: r.expected_duration_minutes && r.expected_duration_minutes > 0 ? r.expected_duration_minutes : null,
    });
  }
  return out;
}

async function fetchTechnicianNames(ownerId: string): Promise<Record<string, string>> {
  const { data } = await supabase.from('team_members').select('id, member_name, member_email').eq('account_owner_id', ownerId);
  const out: Record<string, string> = {};
  for (const t of (data ?? []) as { id: string; member_name: string | null; member_email: string | null }[]) {
    out[t.id] = t.member_name ?? t.member_email ?? 'Technician';
  }
  return out;
}

// ============================================================
// MODEL CACHE (5 min, in-flight de-duplicated, per owner)
// ============================================================

export interface LoadedDurationModel {
  model: TrainedModel;
  techNames: Record<string, string>;
  settings: DurationSettings;
  loadedAtMs: number;
}

const cache = new Map<string, { at: number; value: LoadedDurationModel }>();
const inflight = new Map<string, Promise<LoadedDurationModel>>();

export function invalidateDurationModel(): void {
  cache.clear();
  inflight.clear();
}

export function loadDurationModel(ownerId: string, opts: { force?: boolean } = {}): Promise<LoadedDurationModel> {
  const hit = cache.get(ownerId);
  if (!opts.force && hit && Date.now() - hit.at < MODEL_TTL_MS) return Promise.resolve(hit.value);
  const running = inflight.get(ownerId);
  if (!opts.force && running) return running;

  const p = (async () => {
    const [jobs, techNames, settings] = await Promise.all([fetchTrainingJobs(ownerId), fetchTechnicianNames(ownerId), fetchDurationSettings(ownerId)]);
    const value: LoadedDurationModel = { model: trainDurationModel(jobs), techNames, settings, loadedAtMs: Date.now() };
    cache.set(ownerId, { at: Date.now(), value });
    return value;
  })().finally(() => inflight.delete(ownerId));
  inflight.set(ownerId, p);
  return p;
}

// ============================================================
// PREDICTING FOR JOBS
// ============================================================

const OPEN_STATUSES = new Set(['scheduled', 'en_route', 'in_progress']);

export function contextForJob(
  job: Pick<Job, 'service_type' | 'assigned_technician_id' | 'customer_id' | 'duration_minutes'> & { expected_duration_minutes?: unknown },
  model: TrainedModel,
  equipment: EquipmentFacts | undefined,
  overrides: { technicianId?: string | null } = {},
): PredictionContext {
  const hist = historyFor(model, job.service_type);
  return {
    jobTypeKey: job.service_type,
    technicianId: overrides.technicianId !== undefined ? overrides.technicianId : job.assigned_technician_id,
    equipmentIds: equipment?.ids ?? [],
    equipmentTypes: equipment?.types ?? [],
    customerId: job.customer_id,
    existing: resolveExistingEstimate({
      planMinutes: typeof job.expected_duration_minutes === 'number' ? job.expected_duration_minutes : null,
      historyMedianMinutes: hist.median,
      historyCount: hist.count,
      slotMinutes: job.duration_minutes,
    }),
  };
}

export async function predictForJobs(ownerId: string, jobs: Job[]): Promise<{ predictions: Record<string, DurationPrediction>; loaded: LoadedDurationModel }> {
  const loaded = await loadDurationModel(ownerId);
  const open = jobs.filter((j) => OPEN_STATUSES.has(j.job_status as string));
  const equip = open.length > 0 ? await fetchEquipmentFacts(open.map((j) => j.id)) : new Map<string, EquipmentFacts>();
  const predictions: Record<string, DurationPrediction> = {};
  for (const j of open) predictions[j.id] = predictDuration(loaded.model, contextForJob(j, loaded.model, equip.get(j.id)));
  return { predictions, loaded };
}

/** Predict for a single hypothetical / in-form job (e.g. the schedule drawer with a technician change). */
export async function predictForDraft(
  ownerId: string,
  draft: { jobId: string | null; serviceType: string | null; technicianId: string | null; customerId: string | null; planMinutes: number | null; slotMinutes: number | null },
): Promise<{ prediction: DurationPrediction; settings: DurationSettings }> {
  const loaded = await loadDurationModel(ownerId);
  const equip = draft.jobId ? (await fetchEquipmentFacts([draft.jobId])).get(draft.jobId) : undefined;
  const ctx = contextForJob(
    { service_type: draft.serviceType, assigned_technician_id: draft.technicianId, customer_id: draft.customerId, expected_duration_minutes: draft.planMinutes, duration_minutes: draft.slotMinutes },
    loaded.model,
    equip,
  );
  return { prediction: predictDuration(loaded.model, ctx), settings: loaded.settings };
}

/** Open jobs from yesterday to `days` ahead — what the dispatcher is about to schedule. */
export async function fetchUpcomingJobs(ownerId: string, days = 14, limit = 80): Promise<Job[]> {
  const from = new Date(Date.now() - 86_400_000).toISOString();
  const to = new Date(Date.now() + days * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('user_id', ownerId)
    .in('job_status', Array.from(OPEN_STATUSES))
    .gte('scheduled_datetime', from)
    .lte('scheduled_datetime', to)
    .order('scheduled_datetime', { ascending: true })
    .limit(limit);
  return error || !data ? [] : (data as Job[]);
}

// ============================================================
// PERSIST PREDICTIONS (as made, before work starts)
// ============================================================

export async function recordPredictions(jobs: Job[], predictions: Record<string, DurationPrediction>, policy: SlotPolicy): Promise<number> {
  const rows = jobs
    .filter((j) => predictions[j.id] && !j.started_at && OPEN_STATUSES.has(j.job_status as string))
    .slice(0, 200)
    .map((j) => {
      const p = predictions[j.id];
      return {
        job_id: j.id,
        job_type_key: p.jobTypeKey,
        model_version: p.modelVersion,
        p10: p.quantiles.p10,
        p25: p.quantiles.p25,
        p50: p.quantiles.p50,
        p75: p.quantiles.p75,
        p90: p.quantiles.p90,
        confidence: p.confidence,
        source: p.source,
        existing_minutes: p.existing.minutes,
        existing_source: p.existing.source,
        slot_minutes: slotMinutesFor(p, policy),
        context: { sample_size: p.sampleSize, method: p.intervalMethod, factors: p.factors.map((f) => ({ id: f.id, minutes: f.minutes })) },
      };
    });
  if (rows.length === 0) return 0;
  const { data, error } = await supabase.rpc('record_job_duration_predictions', { p_rows: rows });
  return error ? 0 : Number(data ?? 0);
}

// ============================================================
// FEEDS: dispatch + booking
// ============================================================

/**
 * Minutes to reserve per job for the dispatch engine. Returns {} when the feed is
 * off or the model has nothing learned yet, so callers fall back to jobs.duration_minutes.
 * Also snapshots the predictions (fire-and-forget) so they can be scored later.
 */
export async function fetchDispatchDurations(ownerId: string, jobs: Job[]): Promise<Record<string, number>> {
  try {
    const { predictions, loaded } = await predictForJobs(ownerId, jobs);
    void recordPredictions(jobs, predictions, loaded.settings.slotPolicy).catch(() => 0);
    if (!loaded.settings.feedDispatch) return {};
    const out: Record<string, number> = {};
    for (const [id, p] of Object.entries(predictions)) {
      const m = slotMinutesFor(p, loaded.settings.slotPolicy);
      if (m !== null) out[id] = m;
    }
    return out;
  } catch {
    return {};
  }
}

/** Publishes learned per-service slot lengths for the public booking page (server re-validates). */
export async function publishServiceStats(model: TrainedModel): Promise<number> {
  const rows: { service_key: string; sample_size: number; p50: number; p75: number; p90: number }[] = [];
  for (const [key, xs] of model.typeActuals.entries()) {
    if (xs.length < 8 || key === 'unspecified') continue;
    const p = predictDuration(model, { jobTypeKey: key, technicianId: null, equipmentIds: [], equipmentTypes: [], customerId: null });
    if (p.source !== 'model') continue;
    rows.push({ service_key: key, sample_size: p.sampleSize, p50: p.quantiles.p50, p75: p.quantiles.p75, p90: p.quantiles.p90 });
  }
  const { data, error } = await supabase.rpc('save_duration_service_stats', { p_stats: rows });
  return error ? 0 : Number(data ?? 0);
}

// ============================================================
// STORED PREDICTED vs ACTUAL
// ============================================================

export interface StoredPredictionRow {
  job_id: string;
  job_type_key: string;
  technician_id: string | null;
  predicted_at: string;
  p10: number;
  p50: number;
  p90: number;
  actual_minutes: number;
  within_range: boolean | null;
  existing_minutes: number | null;
  confidence: string;
}

export async function fetchScoredPredictions(ownerId: string, days = 120): Promise<StoredPredictionRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('job_duration_predictions')
    .select('job_id, job_type_key, technician_id, predicted_at, p10, p50, p90, actual_minutes, within_range, existing_minutes, confidence')
    .eq('user_id', ownerId)
    .eq('scored', true)
    .gte('settled_at', since)
    .order('settled_at', { ascending: false })
    .limit(500);
  return error || !data ? [] : (data as StoredPredictionRow[]);
}

// ============================================================
// DRIFT ALERTS
// ============================================================

export interface DriftAlertRow {
  id: string;
  alert_key: string;
  scope: 'overall' | 'job_type' | 'technician';
  scope_key: string;
  kind: 'bias' | 'calibration' | 'shift';
  severity: 'info' | 'warning' | 'critical';
  direction: 'longer' | 'shorter' | 'narrow' | 'wide';
  message: string;
  metrics: Record<string, unknown>;
  status: 'open' | 'acknowledged' | 'resolved';
  first_detected_at: string;
  last_detected_at: string;
}

export function evaluateDrift(loaded: LoadedDurationModel, nowMs: number = Date.now()): DriftReport {
  return detectDrift(loaded.model.records, { nowMs, labels: loaded.techNames });
}

export async function syncDriftAlerts(report: DriftReport): Promise<{ opened: number; updated: number; resolved: number } | null> {
  // An insufficient-data report must never auto-resolve real alerts.
  if (report.status === 'insufficient_data') return null;
  const alerts = report.alerts.map((a) => ({
    key: a.key,
    scope: a.scope,
    scope_key: a.scopeKey,
    kind: a.kind,
    severity: a.severity,
    direction: a.direction,
    message: a.message,
    metrics: { recent_n: a.recentN, reference_n: a.referenceN, bias_pct: Math.round(a.biasPct * 10) / 10, z: Math.round(a.z * 100) / 100, coverage: a.coverage, since_ms: a.sinceMs },
  }));
  const { data, error } = await supabase.rpc('sync_duration_drift_alerts', { p_alerts: alerts, p_full: true });
  if (error || !data) return null;
  const d = data as { opened?: number; updated?: number; resolved?: number };
  return { opened: d.opened ?? 0, updated: d.updated ?? 0, resolved: d.resolved ?? 0 };
}

export async function fetchDriftAlerts(ownerId: string): Promise<DriftAlertRow[]> {
  const { data, error } = await supabase
    .from('job_duration_drift_alerts')
    .select('id, alert_key, scope, scope_key, kind, severity, direction, message, metrics, status, first_detected_at, last_detected_at')
    .eq('user_id', ownerId)
    .neq('status', 'resolved')
    .order('last_detected_at', { ascending: false })
    .limit(100);
  return error || !data ? [] : (data as DriftAlertRow[]);
}

export async function setDriftAlertStatus(id: string, status: 'acknowledged' | 'resolved'): Promise<boolean> {
  const { data, error } = await supabase.rpc('set_duration_alert_status', { p_id: id, p_status: status });
  return !error && data === true;
}
