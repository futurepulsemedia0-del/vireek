/**
 * Event Prediction Mesh — data layer.
 *
 * Gathers the live signals behind every forecast in a fixed number of batched
 * queries, hands them to the pure engine (eventPredictionMesh.ts), persists
 * the run, and records what actually happened once each forecast window has
 * closed (calibration). Every optional source degrades gracefully: if a table
 * cannot be read the forecast still runs, confidence drops, and the report
 * lists which sources were unavailable.
 */

import { supabase } from '@/lib/supabase';
import {
  buildMeshReport,
  type MeshEventKind,
  type MeshLevel,
  type MeshReport,
  type MeshSignals,
  type ResolvedPrediction,
  type Driver,
  type CascadeContribution,
  type ActionUrgency,
} from '@/lib/eventPredictionMesh';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const HORIZON_OPTIONS = [24, 48, 72, 168] as const;
export type MeshHorizon = (typeof HORIZON_OPTIONS)[number];

// ============================================================
// SMALL HELPERS
// ============================================================

const iso = (ms: number): string => new Date(ms).toISOString();
const uniq = <T>(xs: T[]): T[] => Array.from(new Set(xs));

type QueryResult = { data: unknown; error: { message: string } | null };

async function rowsIf<T>(
  source: string,
  unavailable: Set<string>,
  run: () => PromiseLike<QueryResult>,
): Promise<T[] | null> {
  try {
    const { data, error } = await run();
    if (error) {
      unavailable.add(source);
      return null;
    }
    return (data as T[] | null) ?? [];
  } catch {
    unavailable.add(source);
    return null;
  }
}

async function getOwnerId(): Promise<string> {
  const { data, error } = await supabase.rpc('get_account_owner_id');
  if (error || !data) throw error ?? new Error('Could not resolve account owner');
  return data as string;
}

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

// ============================================================
// ROW SHAPES
// ============================================================

interface WeatherRow {
  event_type: string;
  severity: string | null;
  expires_at: string | null;
  resolved_at: string | null;
}
interface EquipmentRow {
  install_date: string | null;
  expected_lifespan_years: number | null;
  last_service_date: string | null;
  service_interval_months: number | null;
}
interface OutcomeRow {
  caused_callback: boolean;
  is_rework: boolean;
  recorded_at: string;
}
interface UpcomingJobRow {
  id: string;
  assigned_technician_id: string | null;
  sla_response_hours: number | null;
  scheduled_datetime: string;
}
interface PartLineRow {
  job_id: string;
  status: 'needed' | 'allocated' | 'installed' | 'backordered';
}
interface PartRow {
  id: string;
  reorder_point: number;
}
interface StockRow {
  part_id: string;
  quantity_on_hand: number;
  quantity_reserved: number;
}
interface TechRow {
  max_jobs_per_day: number | null;
}
interface CallRow {
  call_datetime: string;
  status: string;
  is_emergency: boolean;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
}

const SEVERE_LEVELS = new Set(['severe', 'extreme']);
const MS_PER_MONTH = 30.4375 * DAY_MS;

// ============================================================
// SIGNAL ASSEMBLY (batched)
// ============================================================

export async function buildMeshSignals(
  horizonHours: number,
  now: Date = new Date(),
): Promise<MeshSignals> {
  const ownerId = await getOwnerId();
  const unavailable = new Set<string>();
  const nowMs = now.getTime();
  const horizonEnd = iso(nowMs + horizonHours * HOUR_MS);

  // ---- round 1: everything that does not depend on upcoming job ids ----
  const [weather, surge, equipment, outcomes, upcoming, techs, calls, breaches, recovery, rework] =
    await Promise.all([
      rowsIf<WeatherRow>('weather_surge_events', unavailable, () =>
        supabase
          .from('weather_surge_events')
          .select('event_type, severity, expires_at, resolved_at')
          .eq('user_id', ownerId)
          .is('resolved_at', null)
          .gte('created_at', iso(nowMs - 7 * DAY_MS))
          .limit(200),
      ),
      rowsIf<{ surge_mode_active: boolean | null }>('business_profile', unavailable, () =>
        supabase
          .from('business_profile')
          .select('surge_mode_active')
          .eq('user_id', ownerId)
          .limit(1),
      ),
      rowsIf<EquipmentRow>('equipment', unavailable, () =>
        supabase
          .from('equipment')
          .select(
            'install_date, expected_lifespan_years, last_service_date, service_interval_months',
          )
          .eq('user_id', ownerId)
          .eq('status', 'active')
          .limit(5000),
      ),
      rowsIf<OutcomeRow>('job_outcomes', unavailable, () =>
        supabase
          .from('job_outcomes')
          .select('caused_callback, is_rework, recorded_at')
          .eq('user_id', ownerId)
          .gte('recorded_at', iso(nowMs - 180 * DAY_MS))
          .limit(5000),
      ),
      rowsIf<UpcomingJobRow>('jobs', unavailable, () =>
        supabase
          .from('jobs')
          .select('id, assigned_technician_id, sla_response_hours, scheduled_datetime')
          .eq('user_id', ownerId)
          .in('job_status', ['scheduled', 'en_route'])
          .gte('scheduled_datetime', now.toISOString())
          .lte('scheduled_datetime', horizonEnd)
          .limit(2000),
      ),
      rowsIf<TechRow>('team_members', unavailable, () =>
        supabase
          .from('team_members')
          .select('max_jobs_per_day')
          .eq('account_owner_id', ownerId)
          .eq('role', 'technician')
          .eq('invite_status', 'active')
          .eq('dispatch_enabled', true)
          .limit(500),
      ),
      rowsIf<CallRow>('calls', unavailable, () =>
        supabase
          .from('calls')
          .select('call_datetime, status, is_emergency, sentiment')
          .eq('user_id', ownerId)
          .gte('call_datetime', iso(nowMs - 35 * DAY_MS))
          .limit(10000),
      ),
      rowsIf<{ id: string }>('contract_sla_breaches', unavailable, () =>
        supabase
          .from('contract_sla_breaches')
          .select('id')
          .eq('user_id', ownerId)
          .gte('created_at', iso(nowMs - 30 * DAY_MS))
          .limit(500),
      ),
      rowsIf<{ id: string }>('service_recovery_signals', unavailable, () =>
        supabase
          .from('service_recovery_signals')
          .select('id')
          .eq('user_id', ownerId)
          .in('status', ['open', 'playbook_enrolled', 'escalated'])
          .limit(500),
      ),
      rowsIf<{ id: string }>('rework_jobs', unavailable, () =>
        supabase
          .from('jobs')
          .select('id')
          .eq('user_id', ownerId)
          .eq('is_rework', true)
          .in('job_status', ['scheduled', 'en_route', 'in_progress'])
          .limit(500),
      ),
    ]);

  // ---- round 2: parts (needs upcoming job ids) + inventory ----
  const jobIds = uniq((upcoming ?? []).map((j) => j.id)).slice(0, 1000);
  const [partLines, parts, stock] = await Promise.all([
    jobIds.length === 0
      ? Promise.resolve<PartLineRow[] | null>([])
      : Promise.all(
          chunk(jobIds, 200).map((ids) =>
            rowsIf<PartLineRow>('job_parts_required', unavailable, () =>
              supabase
                .from('job_parts_required')
                .select('job_id, status')
                .in('job_id', ids)
                .in('status', ['needed', 'backordered']),
            ),
          ),
        ).then((groups) =>
          groups.some((g) => g === null) ? null : groups.flatMap((g) => g ?? []),
        ),
    rowsIf<PartRow>('inventory_parts', unavailable, () =>
      supabase
        .from('inventory_parts')
        .select('id, reorder_point')
        .eq('user_id', ownerId)
        .eq('active', true)
        .gt('reorder_point', 0)
        .limit(5000),
    ),
    rowsIf<StockRow>('inventory_stock_levels', unavailable, () =>
      supabase
        .from('inventory_stock_levels')
        .select('part_id, quantity_on_hand, quantity_reserved')
        .eq('user_id', ownerId)
        .limit(20000),
    ),
  ]);

  // ---- weather ----
  const weatherSignal: MeshSignals['weather'] =
    weather === null
      ? null
      : (() => {
          const active = weather.filter((w) => !w.expires_at || Date.parse(w.expires_at) > nowMs);
          const severe = active.filter(
            (w) =>
              SEVERE_LEVELS.has((w.severity ?? '').toLowerCase()) || /warning/i.test(w.event_type),
          );
          return {
            activeAlerts: active.length,
            severeAlerts: severe.length,
            surgeModeActive: !!surge?.[0]?.surge_mode_active,
          };
        })();

  // ---- equipment ----
  const equipmentSignal: MeshSignals['equipment'] =
    equipment === null
      ? null
      : (() => {
          let nearEnd = 0;
          let overdue = 0;
          for (const e of equipment) {
            const life =
              e.expected_lifespan_years && e.expected_lifespan_years > 0
                ? e.expected_lifespan_years
                : 15;
            if (e.install_date) {
              const ageYears = (nowMs - Date.parse(e.install_date)) / (365.25 * DAY_MS);
              if (Number.isFinite(ageYears) && ageYears >= life * 0.8) nearEnd++;
            }
            const interval =
              e.service_interval_months && e.service_interval_months > 0
                ? e.service_interval_months
                : 12;
            const last = e.last_service_date ?? e.install_date;
            if (last && (nowMs - Date.parse(last)) / MS_PER_MONTH > interval) overdue++;
          }
          const n = equipment.length;
          return {
            activeCount: n,
            nearEndOfLifeShare: n ? nearEnd / n : 0,
            serviceOverdueShare: n ? overdue / n : 0,
          };
        })();

  // ---- failures (callback/rework rate, last 90d vs the 90d before) ----
  const failuresSignal: MeshSignals['failures'] =
    outcomes === null
      ? null
      : (() => {
          const cut = nowMs - 90 * DAY_MS;
          const recent = outcomes.filter((o) => Date.parse(o.recorded_at) >= cut);
          const prior = outcomes.filter((o) => Date.parse(o.recorded_at) < cut);
          const rate = (rows: OutcomeRow[]) =>
            rows.length
              ? (rows.filter((o) => o.caused_callback || o.is_rework).length / rows.length) * 100
              : null;
          return {
            recentRatePct: rate(recent),
            priorRatePct: prior.length >= 5 ? rate(prior) : null,
            sample: recent.length,
          };
        })();

  // ---- parts ----
  const partsAvailable = partLines !== null && parts !== null && stock !== null;
  const partsSignal: MeshSignals['parts'] = !partsAvailable
    ? null
    : (() => {
        const onHand = new Map<string, number>();
        for (const s of stock)
          onHand.set(
            s.part_id,
            (onHand.get(s.part_id) ?? 0) + (s.quantity_on_hand - s.quantity_reserved),
          );
        const below = parts.filter((p) => (onHand.get(p.id) ?? 0) <= p.reorder_point).length;
        const backordered = new Set(
          partLines.filter((l) => l.status === 'backordered').map((l) => l.job_id),
        );
        const needed = new Set(partLines.filter((l) => l.status === 'needed').map((l) => l.job_id));
        // No inventory configured and no part lines at all = unknown, not safe.
        if (parts.length === 0 && partLines.length === 0) return null;
        return {
          backorderedOnUpcoming: backordered.size,
          neededOnUpcoming: needed.size,
          belowReorderShare: parts.length ? below / parts.length : 0,
          trackedParts: parts.length,
        };
      })();
  if (partsSignal === null && partsAvailable) unavailable.add('inventory (not configured)');

  // ---- workforce ----
  const workforceSignal: MeshSignals['workforce'] =
    techs === null || upcoming === null || techs.length === 0
      ? null
      : {
          activeTechnicians: techs.length,
          horizonCapacityJobs:
            techs.reduce(
              (sum, t) =>
                sum + (t.max_jobs_per_day && t.max_jobs_per_day > 0 ? t.max_jobs_per_day : 6),
              0,
            ) *
            (horizonHours / 24),
          upcomingJobs: upcoming.length,
          unassignedUpcoming: upcoming.filter((j) => !j.assigned_technician_id).length,
        };
  if (techs !== null && techs.length === 0)
    unavailable.add('team_members (no dispatchable technicians)');

  // ---- demand / sentiment (calls) ----
  let demandSignal: MeshSignals['demand'] = null;
  let sentimentSignal: MeshSignals['sentiment'] = null;
  if (calls !== null) {
    const cut7 = nowMs - 7 * DAY_MS;
    const recent = calls.filter((c) => Date.parse(c.call_datetime) >= cut7);
    const baseline = calls.filter((c) => Date.parse(c.call_datetime) < cut7);
    const baselineDaily = baseline.length / 28;
    if (baseline.length >= 10) {
      demandSignal = {
        recentDaily: recent.length / 7,
        baselineDaily,
        missedRatePct: recent.length
          ? (recent.filter((c) => c.status === 'missed').length / recent.length) * 100
          : 0,
        emergenciesRecent: recent.filter((c) => c.is_emergency).length,
      };
    } else {
      unavailable.add('calls (baseline too short)');
    }
    sentimentSignal = {
      negativeShareRecent: recent.length
        ? recent.filter((c) => c.sentiment === 'negative').length / recent.length
        : null,
      callsRecent: recent.length,
      openReworkJobs: rework?.length ?? 0,
      openRecoverySignals: recovery?.length ?? 0,
    };
  } else if (rework !== null || recovery !== null) {
    sentimentSignal = {
      negativeShareRecent: null,
      callsRecent: 0,
      openReworkJobs: rework?.length ?? 0,
      openRecoverySignals: recovery?.length ?? 0,
    };
  }

  // ---- SLA ----
  const slaSignal: MeshSignals['sla'] =
    upcoming === null
      ? null
      : (() => {
          const bound = upcoming.filter((j) => j.sla_response_hours != null);
          return {
            upcomingSlaJobs: bound.length,
            unassignedSlaJobs: bound.filter((j) => !j.assigned_technician_id).length,
            dueWithin24h: bound.filter((j) => Date.parse(j.scheduled_datetime) - nowMs <= DAY_MS)
              .length,
            recentBreaches30d: breaches?.length ?? 0,
          };
        })();

  return {
    horizonHours,
    weather: weatherSignal,
    equipment: equipmentSignal,
    failures: failuresSignal,
    parts: partsSignal,
    workforce: workforceSignal,
    demand: demandSignal,
    sla: slaSignal,
    sentiment: sentimentSignal,
    unavailableSources: Array.from(unavailable).sort(),
  };
}

// ============================================================
// PERSISTENCE
// ============================================================

export interface StoredPrediction {
  id: string;
  run_id: string;
  event_kind: MeshEventKind;
  probability: number;
  base_probability: number;
  confidence: number;
  level: MeshLevel;
  drivers: Driver[];
  cascade: CascadeContribution[];
  window_start: string;
  window_end: string;
  observed: boolean | null;
  resolved_at: string | null;
  created_at: string;
}

export type ActionStatus = 'proposed' | 'approved' | 'dismissed' | 'completed' | 'superseded';

export interface StoredAction {
  id: string;
  run_id: string;
  event_kind: MeshEventKind;
  action_key: string;
  title: string;
  detail: string;
  href: string;
  urgency: ActionUrgency;
  probability: number;
  status: ActionStatus;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

export interface StoredRun {
  id: string;
  engine_version: string;
  horizon_hours: number;
  data_coverage: number;
  unavailable_sources: string[];
  signature: string;
  created_at: string;
  prediction_mesh_predictions?: Pick<StoredPrediction, 'event_kind' | 'probability' | 'level'>[];
}

/** Runs the forecast, stores it, and supersedes stale proposals. Returns the report and the new run id. */
export async function runMeshForecast(
  horizonHours: number,
): Promise<{ report: MeshReport; signals: MeshSignals; runId: string }> {
  const signals = await buildMeshSignals(horizonHours);
  const report = buildMeshReport(signals);

  const { data: run, error: runErr } = await supabase
    .from('prediction_mesh_runs')
    .insert({
      engine_version: report.engineVersion,
      horizon_hours: report.horizonHours,
      data_coverage: report.dataCoverage,
      unavailable_sources: signals.unavailableSources,
      signals,
      signature: report.signature,
    })
    .select('id')
    .single();
  if (runErr) throw runErr;
  const runId = (run as { id: string }).id;

  const { error: predErr } = await supabase.from('prediction_mesh_predictions').insert(
    report.predictions.map((p) => ({
      run_id: runId,
      event_kind: p.kind,
      probability: p.probability,
      base_probability: p.baseProbability,
      confidence: p.confidence,
      level: p.level,
      drivers: p.drivers,
      cascade: p.cascade,
      window_start: p.windowStart,
      window_end: p.windowEnd,
    })),
  );
  if (predErr) throw predErr;

  // The newest forecast replaces every older, still-undecided proposal.
  const { error: supErr } = await supabase
    .from('prediction_mesh_actions')
    .update({ status: 'superseded' })
    .eq('status', 'proposed')
    .neq('run_id', runId);
  if (supErr) throw supErr;

  if (report.actions.length > 0) {
    const { error: actErr } = await supabase.from('prediction_mesh_actions').insert(
      report.actions.map((a) => ({
        run_id: runId,
        event_kind: a.kind,
        action_key: a.key,
        title: a.title,
        detail: a.detail,
        href: a.href,
        urgency: a.urgency,
        probability: a.probability,
      })),
    );
    if (actErr) throw actErr;
  }

  return { report, signals, runId };
}

export async function fetchLatestRun(): Promise<{
  run: StoredRun;
  predictions: StoredPrediction[];
} | null> {
  const { data: run, error } = await supabase
    .from('prediction_mesh_runs')
    .select(
      'id, engine_version, horizon_hours, data_coverage, unavailable_sources, signature, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!run) return null;
  const { data: preds, error: pErr } = await supabase
    .from('prediction_mesh_predictions')
    .select('*')
    .eq('run_id', (run as StoredRun).id);
  if (pErr) throw pErr;
  return { run: run as StoredRun, predictions: (preds as StoredPrediction[] | null) ?? [] };
}

export async function fetchRunHistory(limit = 8): Promise<StoredRun[]> {
  const { data, error } = await supabase
    .from('prediction_mesh_runs')
    .select(
      'id, engine_version, horizon_hours, data_coverage, unavailable_sources, signature, created_at, prediction_mesh_predictions(event_kind, probability, level)',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as StoredRun[] | null) ?? [];
}

export async function fetchOpenActions(): Promise<StoredAction[]> {
  const { data, error } = await supabase
    .from('prediction_mesh_actions')
    .select(
      'id, run_id, event_kind, action_key, title, detail, href, urgency, probability, status, decided_at, decision_note, created_at',
    )
    .in('status', ['proposed', 'approved'])
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  const URGENCY_RANK: Record<string, number> = { now: 0, today: 1, this_week: 2 };
  return ((data as StoredAction[] | null) ?? []).sort(
    (a, b) =>
      Number(a.status !== 'proposed') - Number(b.status !== 'proposed') ||
      (URGENCY_RANK[a.urgency] ?? 9) - (URGENCY_RANK[b.urgency] ?? 9) ||
      b.probability - a.probability,
  );
}

export async function decideAction(
  actionId: string,
  decision: 'approved' | 'dismissed' | 'completed',
  note?: string,
): Promise<void> {
  const { error } = await supabase.rpc('decide_prediction_action', {
    p_action_id: actionId,
    p_decision: decision,
    p_note: note?.trim() ? note.trim() : null,
  });
  if (error) throw error;
}

// ============================================================
// CALIBRATION — record what actually happened once a window closes
// ============================================================

interface DueRow {
  id: string;
  event_kind: MeshEventKind;
  window_start: string;
  window_end: string;
}

/**
 * Observation rules (documented so the score is auditable):
 *  - demand_spike        calls/day in window >= 1.3x the prior 28-day baseline (min 5 calls)
 *  - parts_shortage      any job scheduled in the window currently has a backordered part line
 *  - dispatch_pressure   jobs scheduled in window >= 90% of current technician capacity
 *  - sla_breach          at least one contract_sla_breaches row created in the window
 *  - customer_escalation a service-recovery dispute / escalation / severity>=70 signal in the window
 */
async function observeWindow(
  ownerId: string,
  startIso: string,
  endIso: string,
  kinds: MeshEventKind[],
): Promise<Map<MeshEventKind, boolean | null>> {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const spanDays = Math.max((endMs - startMs) / DAY_MS, 1 / 24);
  const unavailable = new Set<string>();
  const result = new Map<MeshEventKind, boolean | null>();

  const want = (k: MeshEventKind) => kinds.includes(k);

  const [windowCalls, baselineCalls, windowJobs, techs, breaches, recovery] = await Promise.all([
    want('demand_spike')
      ? rowsIf<{ id: string }>('calls', unavailable, () =>
          supabase
            .from('calls')
            .select('id')
            .eq('user_id', ownerId)
            .gte('call_datetime', startIso)
            .lt('call_datetime', endIso)
            .limit(10000),
        )
      : Promise.resolve(null),
    want('demand_spike')
      ? rowsIf<{ id: string }>('calls', unavailable, () =>
          supabase
            .from('calls')
            .select('id')
            .eq('user_id', ownerId)
            .gte('call_datetime', iso(startMs - 28 * DAY_MS))
            .lt('call_datetime', startIso)
            .limit(10000),
        )
      : Promise.resolve(null),
    want('parts_shortage') || want('dispatch_pressure')
      ? rowsIf<{ id: string }>('jobs', unavailable, () =>
          supabase
            .from('jobs')
            .select('id')
            .eq('user_id', ownerId)
            .neq('job_status', 'cancelled')
            .gte('scheduled_datetime', startIso)
            .lt('scheduled_datetime', endIso)
            .limit(2000),
        )
      : Promise.resolve(null),
    want('dispatch_pressure')
      ? rowsIf<TechRow>('team_members', unavailable, () =>
          supabase
            .from('team_members')
            .select('max_jobs_per_day')
            .eq('account_owner_id', ownerId)
            .eq('role', 'technician')
            .eq('invite_status', 'active')
            .eq('dispatch_enabled', true)
            .limit(500),
        )
      : Promise.resolve(null),
    want('sla_breach')
      ? rowsIf<{ id: string }>('contract_sla_breaches', unavailable, () =>
          supabase
            .from('contract_sla_breaches')
            .select('id')
            .eq('user_id', ownerId)
            .gte('created_at', startIso)
            .lt('created_at', endIso)
            .limit(1),
        )
      : Promise.resolve(null),
    want('customer_escalation')
      ? rowsIf<{ signal_type: string; status: string; severity_score: number }>(
          'service_recovery_signals',
          unavailable,
          () =>
            supabase
              .from('service_recovery_signals')
              .select('signal_type, status, severity_score')
              .eq('user_id', ownerId)
              .gte('detected_at', startIso)
              .lt('detected_at', endIso)
              .limit(500),
        )
      : Promise.resolve(null),
  ]);

  if (want('demand_spike')) {
    if (windowCalls === null || baselineCalls === null || baselineCalls.length < 10)
      result.set('demand_spike', null);
    else
      result.set(
        'demand_spike',
        windowCalls.length >= 5 &&
          windowCalls.length / spanDays >= (baselineCalls.length / 28) * 1.3,
      );
  }
  if (want('parts_shortage')) {
    const ids = (windowJobs ?? []).map((j) => j.id).slice(0, 1000);
    if (windowJobs === null) result.set('parts_shortage', null);
    else if (ids.length === 0) result.set('parts_shortage', false);
    else {
      const groups = await Promise.all(
        chunk(ids, 200).map((c) =>
          rowsIf<{ job_id: string }>('job_parts_required', unavailable, () =>
            supabase
              .from('job_parts_required')
              .select('job_id')
              .in('job_id', c)
              .eq('status', 'backordered')
              .limit(1),
          ),
        ),
      );
      result.set(
        'parts_shortage',
        groups.some((g) => g === null) ? null : groups.some((g) => (g?.length ?? 0) > 0),
      );
    }
  }
  if (want('dispatch_pressure')) {
    if (windowJobs === null || techs === null || techs.length === 0)
      result.set('dispatch_pressure', null);
    else {
      const capacity =
        techs.reduce(
          (s, t) => s + (t.max_jobs_per_day && t.max_jobs_per_day > 0 ? t.max_jobs_per_day : 6),
          0,
        ) * spanDays;
      result.set('dispatch_pressure', windowJobs.length >= capacity * 0.9);
    }
  }
  if (want('sla_breach')) result.set('sla_breach', breaches === null ? null : breaches.length > 0);
  if (want('customer_escalation')) {
    result.set(
      'customer_escalation',
      recovery === null
        ? null
        : recovery.some(
            (r) =>
              r.signal_type === 'customer_dispute' ||
              r.status === 'escalated' ||
              r.severity_score >= 70,
          ),
    );
  }
  return result;
}

/** Resolves every forecast whose window has closed. Safe to call repeatedly. */
export async function resolveDuePredictions(): Promise<number> {
  const ownerId = await getOwnerId();
  const { data, error } = await supabase
    .from('prediction_mesh_predictions')
    .select('id, event_kind, window_start, window_end')
    .is('resolved_at', null)
    .lte('window_end', new Date().toISOString())
    .order('window_end', { ascending: true })
    .limit(100);
  if (error) throw error;
  const due = (data as DueRow[] | null) ?? [];
  if (due.length === 0) return 0;

  const groups = new Map<string, DueRow[]>();
  for (const row of due) {
    const key = `${row.window_start}|${row.window_end}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  let resolved = 0;
  for (const [key, rows] of groups) {
    const [start, end] = key.split('|');
    const observed = await observeWindow(ownerId, start, end, uniq(rows.map((r) => r.event_kind)));
    for (const row of rows) {
      const outcome = observed.get(row.event_kind);
      if (outcome === null || outcome === undefined) continue; // not enough data to judge — leave unresolved
      const { error: updErr } = await supabase
        .from('prediction_mesh_predictions')
        .update({ observed: outcome, resolved_at: new Date().toISOString() })
        .eq('id', row.id)
        .is('resolved_at', null);
      if (!updErr) resolved++;
    }
  }
  return resolved;
}

export async function fetchResolvedPredictions(limit = 500): Promise<ResolvedPrediction[]> {
  const { data, error } = await supabase
    .from('prediction_mesh_predictions')
    .select('event_kind, probability, observed')
    .not('resolved_at', 'is', null)
    .not('observed', 'is', null)
    .order('resolved_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (
    (data as
      { event_kind: MeshEventKind; probability: number | string; observed: boolean }[] | null) ?? []
  ).map((r) => ({
    kind: r.event_kind,
    probability: Number(r.probability),
    observed: r.observed,
  }));
}
