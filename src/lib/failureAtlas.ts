/**
 * Global Failure Atlas — client layer.
 *
 * The Atlas is a network-wide, privacy-preserving knowledge graph of equipment
 * failures (see supabase/migrations/20270301000000_global_failure_atlas.sql).
 * All aggregation and every privacy rule runs in SQL; this file only reads the
 * already-published cells and does presentation math on top of them.
 *
 * "Technician success probability" is deliberately computed HERE, from the
 * account's OWN job_outcomes, shrunk toward the network baseline — technician
 * identities never enter the shared Atlas.
 */

import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------- constants

/** Mirrors the thresholds enforced in refresh_failure_atlas(); display-only. */
export const ATLAS_PRIVACY = {
  minBusinesses: 5,
  maxBusinessSharePct: 40,
  minBusinessesPerDetail: 3,
} as const;

/** Prior strength (pseudo-observations) for technician shrinkage. */
export const TECH_SHRINKAGE_STRENGTH = 8;

export interface AtlasOption {
  key: string;
  label: string;
}

/** Controlled vocabularies for structured capture (keys match ^[a-z0-9_]{1,48}$). */
export const ATLAS_SYMPTOMS: readonly AtlasOption[] = [
  { key: 'no_power', label: 'No power / dead' },
  { key: 'wont_start', label: "Won't start or run" },
  { key: 'short_cycling', label: 'Short cycling' },
  { key: 'no_cooling', label: 'Not cooling' },
  { key: 'no_heating', label: 'Not heating' },
  { key: 'weak_output', label: 'Weak output / poor performance' },
  { key: 'abnormal_noise', label: 'Abnormal noise or vibration' },
  { key: 'leaking', label: 'Leaking' },
  { key: 'tripping_breaker', label: 'Tripping breaker / blowing fuse' },
  { key: 'error_code', label: 'Error code displayed' },
  { key: 'intermittent', label: 'Intermittent fault' },
  { key: 'odor_or_smoke', label: 'Odor or smoke' },
];

export const ATLAS_DIAGNOSTIC_TESTS: readonly AtlasOption[] = [
  { key: 'visual_inspection', label: 'Visual inspection' },
  { key: 'voltage_check', label: 'Voltage check' },
  { key: 'continuity_test', label: 'Continuity / resistance test' },
  { key: 'capacitance_test', label: 'Capacitance test' },
  { key: 'amp_draw', label: 'Amp draw measurement' },
  { key: 'pressure_test', label: 'Pressure test' },
  { key: 'leak_detection', label: 'Leak detection' },
  { key: 'temperature_split', label: 'Temperature split / delta-T' },
  { key: 'airflow_static', label: 'Airflow / static pressure' },
  { key: 'insulation_test', label: 'Insulation (megohm) test' },
  { key: 'thermal_imaging', label: 'Thermal imaging' },
  { key: 'error_code_lookup', label: 'Error-code lookup' },
];

// -------------------------------------------------------------------- types

export interface AtlasPart {
  part: string;
  share_pct: number;
  first_visit_fix_pct: number;
  sample: number;
}
export interface AtlasTest {
  test: string;
  first_visit_fix_pct: number;
  sample: number;
}
export interface AtlasSymptom {
  symptom: string;
  share_pct: number;
}

export interface AtlasCell {
  id: string;
  equipment_type: string;
  make_key: string;
  model_family: string; // '*' = brand-wide fallback
  failure_mode: string;
  units_observed: number;
  failed_units: number;
  failure_events: number;
  contributor_count: number;
  failure_rate_pct: number;
  median_age_months: number | null;
  p25_age_months: number | null;
  p75_age_months: number | null;
  first_visit_fix_pct: number | null;
  callback_pct: number | null;
  rework_pct: number | null;
  top_parts: AtlasPart[];
  top_symptoms: AtlasSymptom[];
  top_diagnostic_tests: AtlasTest[];
  window_months: number;
  computed_at: string;
}

export interface AtlasStats {
  contributing_businesses: number;
  units_observed: number;
  cells_published: number;
  window_months: number;
  computed_at: string | null;
}

export interface AtlasIndexRow {
  equipment_type: string;
  make_key: string;
  model_family: string;
  units_observed: number;
  failure_modes: number;
}

export type RiskBand = 'past_typical' | 'in_window' | 'approaching' | 'early' | 'unknown';

export interface AtlasExposureRow {
  equipment_id: string;
  customer_id: string | null;
  equipment_type: string;
  make: string | null;
  model: string | null;
  unit_age_months: number | null;
  failure_mode: string;
  scope_family: string;
  failure_rate_pct: number;
  median_age_months: number | null;
  p25_age_months: number | null;
  p75_age_months: number | null;
  first_visit_fix_pct: number | null;
  callback_pct: number | null;
  risk_band: RiskBand;
}

export interface AtlasConsent {
  contribute: boolean;
  consented_at: string | null;
}

export type AtlasConfidence = 'high' | 'medium' | 'low';

export interface TechnicianRecord {
  technicianId: string;
  name: string;
  jobs: number;
  firstVisitFixes: number;
  /** Shrunk estimate in [0,1]; equals the network baseline when jobs = 0. */
  successProbability: number;
}

// ------------------------------------------------------------------ helpers

export function humanizeKey(key: string): string {
  const s = key.replace(/_/g, ' ').trim();
  return s.length === 0 ? key : s.charAt(0).toUpperCase() + s.slice(1);
}

export function optionLabel(options: readonly AtlasOption[], key: string): string {
  return options.find((o) => o.key === key)?.label ?? humanizeKey(key);
}

export function formatMake(makeKey: string): string {
  return makeKey.length === 0 ? makeKey : makeKey.charAt(0).toUpperCase() + makeKey.slice(1);
}

export function formatModelFamily(family: string): string {
  return family === '*' ? 'All models' : family.toUpperCase();
}

/** 101 -> "8y 5m", 7 -> "7m", null -> "—" */
export function formatAgeMonths(months: number | null | undefined): string {
  if (months === null || months === undefined || !Number.isFinite(months) || months < 0) return '—';
  const total = Math.round(months);
  const y = Math.floor(total / 12);
  const m = total % 12;
  if (y === 0) return `${m}m`;
  return m === 0 ? `${y}y` : `${y}y ${m}m`;
}

export function formatPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** Wilson score interval for a proportion; returns percentages [0,100]. */
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.96,
): { low: number; high: number } {
  if (!Number.isFinite(successes) || !Number.isFinite(n) || n <= 0) return { low: 0, high: 100 };
  const s = Math.min(Math.max(successes, 0), n);
  const p = s / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    low: Math.max(0, (centre - margin) * 100),
    high: Math.min(100, (centre + margin) * 100),
  };
}

/** Evidence strength from the (bucketed) sample behind a cell. */
export function atlasConfidence(
  cell: Pick<AtlasCell, 'units_observed' | 'contributor_count' | 'failure_events'>,
): AtlasConfidence {
  if (cell.units_observed >= 200 && cell.contributor_count >= 15 && cell.failure_events >= 40)
    return 'high';
  if (cell.units_observed >= 60 && cell.contributor_count >= 8 && cell.failure_events >= 15)
    return 'medium';
  return 'low';
}

/**
 * Empirical-Bayes shrinkage: a technician with few jobs on this failure mode is
 * pulled toward the network baseline instead of showing a noisy 0% / 100%.
 *   p = (successes + m * baseline) / (jobs + m)
 */
export function shrunkSuccessProbability(
  firstVisitFixes: number,
  jobs: number,
  baselinePct: number | null,
  strength: number = TECH_SHRINKAGE_STRENGTH,
): number {
  const baseline =
    baselinePct === null || !Number.isFinite(baselinePct)
      ? 0.5
      : Math.min(Math.max(baselinePct / 100, 0), 1);
  const n = Math.max(0, jobs);
  const s = Math.min(Math.max(0, firstVisitFixes), n);
  return (s + strength * baseline) / (n + strength);
}

/** Best part = highest first-visit-fix rate among parts with a meaningful sample. */
export function bestPart(cell: Pick<AtlasCell, 'top_parts'>, minSample = 5): AtlasPart | null {
  const parts = cell.top_parts ?? [];
  const solid = parts.filter((p) => p.sample >= minSample);
  const pool = solid.length > 0 ? solid : parts;
  if (pool.length === 0) return null;
  return [...pool].sort(
    (a, b) => b.first_visit_fix_pct - a.first_visit_fix_pct || b.sample - a.sample,
  )[0];
}

export function bestTest(cell: Pick<AtlasCell, 'top_diagnostic_tests'>): AtlasTest | null {
  const tests = cell.top_diagnostic_tests ?? [];
  if (tests.length === 0) return null;
  return [...tests].sort(
    (a, b) => b.first_visit_fix_pct - a.first_visit_fix_pct || b.sample - a.sample,
  )[0];
}

export const RISK_BAND_LABEL: Record<RiskBand, string> = {
  past_typical: 'Past typical failure age',
  in_window: 'In typical failure window',
  approaching: 'Approaching failure window',
  early: 'Early life',
  unknown: 'Install date unknown',
};

/** Pure aggregation of an account's own outcomes into technician records. */
export function aggregateTechnicianOutcomes(
  rows: ReadonlyArray<{ technician_id: string | null; resolution: string }>,
  names: ReadonlyMap<string, string>,
  baselinePct: number | null,
): TechnicianRecord[] {
  const byTech = new Map<string, { jobs: number; fixes: number }>();
  for (const r of rows) {
    if (!r.technician_id) continue;
    const cur = byTech.get(r.technician_id) ?? { jobs: 0, fixes: 0 };
    cur.jobs += 1;
    if (r.resolution === 'fixed_first_visit') cur.fixes += 1;
    byTech.set(r.technician_id, cur);
  }
  return [...byTech.entries()]
    .map(([technicianId, v]) => ({
      technicianId,
      name: names.get(technicianId) ?? 'Technician',
      jobs: v.jobs,
      firstVisitFixes: v.fixes,
      successProbability: shrunkSuccessProbability(v.fixes, v.jobs, baselinePct),
    }))
    .sort((a, b) => b.successProbability - a.successProbability || b.jobs - a.jobs);
}

// ---------------------------------------------------------------------- API

export async function fetchAtlasStats(): Promise<AtlasStats | null> {
  const { data, error } = await supabase
    .from('failure_atlas_stats')
    .select('contributing_businesses, units_observed, cells_published, window_months, computed_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  return (data as AtlasStats | null) ?? null;
}

export async function fetchAtlasIndex(): Promise<AtlasIndexRow[]> {
  const { data, error } = await supabase.rpc('get_failure_atlas_index');
  if (error) throw error;
  return (data ?? []) as AtlasIndexRow[];
}

export async function fetchAtlasLookup(input: {
  equipmentType: string;
  make: string;
  model?: string;
}): Promise<AtlasCell[]> {
  const { data, error } = await supabase.rpc('get_failure_atlas', {
    p_equipment_type: input.equipmentType,
    p_make: input.make,
    p_model: input.model && input.model.trim() !== '' ? input.model : null,
  });
  if (error) throw error;
  return (data ?? []) as AtlasCell[];
}

export async function fetchMyExposure(): Promise<AtlasExposureRow[]> {
  const { data, error } = await supabase.rpc('get_my_atlas_exposure');
  if (error) throw error;
  return (data ?? []) as AtlasExposureRow[];
}

export async function fetchConsent(ownerId: string): Promise<AtlasConsent> {
  const { data, error } = await supabase
    .from('failure_atlas_consent')
    .select('contribute, consented_at')
    .eq('user_id', ownerId)
    .maybeSingle();
  if (error) throw error;
  return (data as AtlasConsent | null) ?? { contribute: false, consented_at: null };
}

export async function setConsent(contribute: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_failure_atlas_consent', { p_contribute: contribute });
  if (error) throw error;
}

/**
 * Per-technician first-visit-fix record for one failure mode, from this
 * account's own job_outcomes only, shrunk toward the network baseline.
 */
export async function fetchTechnicianRecords(
  ownerId: string,
  failureMode: string,
  baselinePct: number | null,
): Promise<TechnicianRecord[]> {
  const [outcomes, team] = await Promise.all([
    supabase
      .from('job_outcomes')
      .select('technician_id, resolution')
      .eq('user_id', ownerId)
      .eq('root_cause_key', failureMode)
      .not('technician_id', 'is', null)
      .limit(2000),
    supabase
      .from('team_members')
      .select('id, member_name')
      .eq('account_owner_id', ownerId)
      .limit(200),
  ]);
  if (outcomes.error) throw outcomes.error;
  const names = new Map<string, string>();
  for (const m of (team.data ?? []) as { id: string; member_name: string | null }[]) {
    if (m.member_name) names.set(m.id, m.member_name);
  }
  return aggregateTechnicianOutcomes(
    (outcomes.data ?? []) as { technician_id: string | null; resolution: string }[],
    names,
    baselinePct,
  );
}
