/**
 * Vireek Outcome Benchmark Network - data access.
 * Every call is a thin wrapper over an RPC / edge function; authorization
 * (manager-only, participation, k-anonymity) is enforced in the database.
 */

import { supabase } from '@/lib/supabase';
import type {
  OutcomeAdviceResponse,
  OutcomeBenchmarkRow,
  OutcomeBucket,
  OutcomeDirection,
  OutcomeDriver,
  OutcomeMetric,
  OutcomeScope,
  OutcomeUnit,
} from '@/lib/outcomeBenchmark';

export type WindowDays = 30 | 90;

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeRow(r: Record<string, unknown>): OutcomeBenchmarkRow {
  return {
    metric: r.metric as OutcomeMetric,
    unit: r.unit as OutcomeUnit,
    direction: r.direction as OutcomeDirection,
    my_value: num(r.my_value) ?? 0,
    my_sample: num(r.my_sample) ?? 0,
    scope: r.scope as OutcomeScope,
    industry: String(r.industry ?? 'unspecified'),
    region_key: String(r.region_key ?? 'all'),
    contributor_count: num(r.contributor_count),
    p10: num(r.p10),
    p25: num(r.p25),
    p50: num(r.p50),
    p75: num(r.p75),
    p90: num(r.p90),
    percentile_bucket: (r.percentile_bucket as OutcomeBucket | null) ?? null,
  };
}

export async function fetchOutcomeBenchmark(windowDays: WindowDays): Promise<OutcomeBenchmarkRow[]> {
  const { data, error } = await supabase.rpc('get_outcome_benchmark', { p_window_days: windowDays });
  if (error) throw error;
  return ((data as Record<string, unknown>[] | null) ?? []).map(normalizeRow);
}

export async function fetchOutcomeDrivers(windowDays: WindowDays): Promise<OutcomeDriver[]> {
  const { data, error } = await supabase.rpc('get_outcome_drivers', { p_window_days: windowDays });
  if (error) throw error;
  return ((data as Record<string, unknown>[] | null) ?? []).map((d) => ({
    service_type: String(d.service_type ?? ''),
    job_count: num(d.job_count) ?? 0,
    reworked_count: num(d.reworked_count) ?? 0,
    ftf_rate: num(d.ftf_rate) ?? 0,
  }));
}

export async function fetchParticipation(): Promise<boolean> {
  const { data, error } = await supabase.from('outcome_benchmark_settings').select('participating').maybeSingle();
  if (error) throw error;
  return data?.participating ?? true;
}

export async function setParticipation(participating: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_outcome_benchmark_participation', { p_participating: participating });
  if (error) throw error;
}

/** mode 'cached' never calls the AI; 'generate' reuses a fresh cache; 'refresh' regenerates (server cooldown applies). */
export async function requestOutcomeAdvice(
  windowDays: WindowDays,
  mode: 'cached' | 'generate' | 'refresh',
): Promise<OutcomeAdviceResponse> {
  const { data, error } = await supabase.functions.invoke('outcome-benchmark-advisor', {
    body: { window_days: windowDays, mode },
  });
  if (error) throw error;
  return data as OutcomeAdviceResponse;
}
