/**
 * Service Digital Twin — client library.
 *
 * A live model of a Job as a PROCESS: Expected (plan) vs Actual vs Projected.
 * This is NOT the Property Digital Twin (digitalTwin.ts models the building).
 *
 * All numbers come from the database (service_twin_evaluate /
 * service_twin_portfolio — see 20261231000000_service_digital_twin.sql), the
 * same way jobQualityGate.ts reads its report. Nothing here recomputes the
 * math, so the UI can never disagree with the server-side scan.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/jobCosting';

// ============================================================
// TYPES — mirror _service_twin_compute() output
// ============================================================

export type TwinPhase = 'planned' | 'live' | 'closed' | 'cancelled';
export type TwinStatus = 'on_plan' | 'watch' | 'off_plan' | 'critical';
export type InterventionKind = 'time_overrun' | 'cost_overrun' | 'margin_erosion' | 'ftf_risk' | 'parts_gap';
export type InterventionSeverity = 'watch' | 'high' | 'critical';
export type InterventionStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed';

export interface ServiceTwin {
  job_id: string;
  job: {
    customer_name: string;
    service_type: string | null;
    address: string | null;
    technician_id: string | null;
    job_status: string;
    started_at: string | null;
  };
  phase: TwinPhase;
  status: TwinStatus;
  computed_at: string;
  baseline: {
    hourly_cost_cents: number;
    duration_source: string;
    cost_source: string;
    ftf_source: string;
  };
  expected: { duration_minutes: number; cost_cents: number; revenue_cents: number; margin_pct: number | null; ftf_pct: number };
  actual: { elapsed_minutes: number; cost_cents: number; ftf_pct: number | null };
  projected: { duration_minutes: number; cost_cents: number; margin_pct: number | null; ftf_pct: number };
  variance: { time_ratio: number; cost_ratio: number; margin_delta_pts: number; ftf_delta_pts: number };
  ftf_drivers: { driver: string; points: number }[];
  interventions: {
    kind: InterventionKind;
    severity: InterventionSeverity;
    headline: string;
    action: string;
  }[];
}

export interface ServiceTwinIntervention {
  id: string;
  job_id: string;
  kind: InterventionKind;
  severity: InterventionSeverity;
  status: InterventionStatus;
  headline: string;
  recommended_action: string;
  first_detected_at: string;
  last_detected_at: string;
  resolved_at: string | null;
  resolution: string | null;
}

// ============================================================
// LABELS / PRESENTATION
// ============================================================

export const TWIN_STATUS_META: Record<TwinStatus, { label: string; tone: 'success' | 'warning' | 'danger'; rank: number }> = {
  on_plan: { label: 'On plan', tone: 'success', rank: 0 },
  watch: { label: 'Watch', tone: 'warning', rank: 1 },
  off_plan: { label: 'Off plan', tone: 'danger', rank: 2 },
  critical: { label: 'Critical', tone: 'danger', rank: 3 },
};

export const INTERVENTION_LABELS: Record<InterventionKind, string> = {
  time_overrun: 'Time overrun',
  cost_overrun: 'Cost overrun',
  margin_erosion: 'Margin erosion',
  ftf_risk: 'First-time-fix risk',
  parts_gap: 'Parts gap',
};

export const SOURCE_LABELS: Record<string, string> = {
  job_plan: 'the job plan',
  history: 'your completed jobs of this type',
  mission_brief: 'the mission brief',
  scheduled_slot: 'the booked slot',
  scorecard: 'the technician scorecard',
  model: 'the default model',
  default: 'the default target',
};

export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

export function formatPct(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : `${Math.round(value)}%`;
}

/** Signed variance vs plan, e.g. ratio 1.6 -> "+60%". Ratio <=1 -> "on plan". */
export function formatOverrun(ratio: number): string {
  const pct = Math.round((ratio - 1) * 100);
  return pct <= 0 ? 'on plan' : `+${pct}%`;
}

export function compareTwinsBySeverity(a: ServiceTwin, b: ServiceTwin): number {
  const d = TWIN_STATUS_META[b.status].rank - TWIN_STATUS_META[a.status].rank;
  if (d !== 0) return d;
  return b.variance.time_ratio - a.variance.time_ratio;
}

export { formatCents };

// ============================================================
// DATA ACCESS
// ============================================================

/** Computes the twin AND persists baseline/interventions server-side. */
export async function evaluateServiceTwin(jobId: string): Promise<ServiceTwin> {
  const { data, error } = await supabase.rpc('service_twin_evaluate', { p_job_id: jobId });
  if (error) throw error;
  return data as ServiceTwin;
}

/** Read-only snapshot of every en-route / in-progress job. */
export async function fetchServiceTwinPortfolio(): Promise<ServiceTwin[]> {
  const { data, error } = await supabase.rpc('service_twin_portfolio');
  if (error) throw error;
  return ((data as ServiceTwin[] | null) ?? []).slice().sort(compareTwinsBySeverity);
}

export async function fetchOpenInterventions(jobId?: string): Promise<ServiceTwinIntervention[]> {
  let query = supabase
    .from('service_twin_interventions')
    .select('*')
    .in('status', ['open', 'acknowledged'])
    .order('last_detected_at', { ascending: false });
  if (jobId) query = query.eq('job_id', jobId);
  const { data, error } = await query;
  if (error) throw error;
  return (data as ServiceTwinIntervention[]) ?? [];
}

export async function setInterventionStatus(id: string, status: 'acknowledged' | 'dismissed'): Promise<void> {
  const { error } = await supabase.from('service_twin_interventions').update({ status }).eq('id', id);
  if (error) throw error;
}

// ============================================================
// HOOKS — poll while visible; pause in background tabs
// ============================================================

const POLL_MS = 45_000;

function usePolling(load: () => Promise<void>, enabled: boolean) {
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void loadRef.current();
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [enabled]);
}

export function useServiceTwin(jobId: string, enabled = true) {
  const [twin, setTwin] = useState<ServiceTwin | null>(null);
  const [interventions, setInterventions] = useState<ServiceTwinIntervention[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const t = await evaluateServiceTwin(jobId);
      const iv = await fetchOpenInterventions(jobId);
      setTwin(t);
      setInterventions(iv);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the service twin.');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  usePolling(load, enabled);
  return { twin, interventions, loading, error, reload: load };
}

export function useServiceTwinPortfolio() {
  const [twins, setTwins] = useState<ServiceTwin[]>([]);
  const [interventions, setInterventions] = useState<ServiceTwinIntervention[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, iv] = await Promise.all([fetchServiceTwinPortfolio(), fetchOpenInterventions()]);
      setTwins(t);
      setInterventions(iv);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load live service twins.');
    } finally {
      setLoading(false);
    }
  }, []);

  usePolling(load, true);
  return { twins, interventions, loading, error, reload: load };
}
