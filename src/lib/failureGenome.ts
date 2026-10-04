/**
 * Vireek Failure Genome - client domain logic.
 *
 * Each equipment unit has a failure "DNA" with 10 strands:
 * MODEL, AGE, CLIMATE, USAGE (profile strands) and SYMPTOMS, HISTORY, PARTS,
 * FAILURE, REPAIR, OUTCOME (event strands). Genomes are built in Postgres
 * (fg_build_genome); the population layer (failure_patterns) is cross-tenant,
 * aggregate-only and reached exclusively through RPCs.
 *
 * Server counterpart: supabase/migrations/20270202000000_failure_genome.sql.
 * Keep slugify()/ageBand() in sync with fg_slug()/fg_age_band() there.
 */

import { supabase } from '@/lib/supabase';

export type FailureOutcome = 'fixed' | 'recurred' | 'callback' | 'replaced_unit' | 'deferred' | 'unknown';
export type ClimateZone = 'hot_humid' | 'hot_dry' | 'temperate' | 'cold' | 'marine' | 'mixed';
export type UsageProfile = 'light' | 'normal' | 'heavy' | 'continuous';
export type PatternStatus = 'emerging' | 'elevated' | 'stable' | 'declining';
export type StrandKey =
  | 'model' | 'age' | 'climate' | 'usage' | 'symptoms' | 'history' | 'parts' | 'failure' | 'repair' | 'outcome';

export interface GenomeDna {
  model: { key: string; make: string | null; model: string | null; type: string | null };
  age: { months: number | null; band: string };
  climate: { band: string };
  usage: { band: string };
  symptoms: string[];
  history: {
    failures: number;
    recurrences: number;
    first_on: string | null;
    last_on: string | null;
    mean_months_between: number | null;
    service_overdue: boolean;
  };
  parts: string[];
  failure: { components: { component: string; count: number }[]; last: string | null };
  repair: { actions: { action: string; count: number }[]; last: string | null };
  outcome: Record<FailureOutcome, number> & { last: FailureOutcome | null };
}

export interface GenomeSummary {
  failure_count: number;
  recurrence_count: number;
  last_failure_on: string | null;
  dna: GenomeDna;
  dna_hash: string;
  computed_at: string;
}

export interface UnitRow {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_date: string | null;
  climate_zone: ClimateZone | null;
  usage_profile: UsageProfile | null;
  customer_name: string | null;
  genome: GenomeSummary | null;
}

export interface FailureEventRow {
  id: string;
  occurred_on: string;
  age_months: number | null;
  symptoms: string[];
  failure_component: string;
  failure_mode: string | null;
  repair_action: string | null;
  parts_replaced: string[];
  outcome: FailureOutcome;
  repair_cost: number | null;
}

export interface TagShare {
  tag: string;
  share: number | null;
}

export interface FailurePattern {
  id: string;
  model_key: string;
  make_key: string;
  type_key: string;
  failure_component: string;
  age_band: string;
  climate_band: string;
  units_exposed: number;
  contributor_count: number;
  recent_events: number;
  baseline_events: number;
  recent_rate: number;
  baseline_rate: number;
  lift: number | null;
  z_score: number | null;
  status: PatternStatus;
  recurrence_rate: number | null;
  replacement_rate: number | null;
  fix_rate: number | null;
  avg_repair_cost: number | null;
  top_symptoms: TagShare[];
  top_parts: TagShare[];
  top_repairs: TagShare[];
  window_days: number;
  first_detected_at: string | null;
  status_changed_at: string;
}

export interface ExposureRow {
  pattern: FailurePattern;
  my_units: number;
  my_equipment_ids: string[];
}

export interface Strand {
  key: StrandKey;
  label: string;
  value: string;
  filled: boolean;
  kind: 'profile' | 'event';
}

export interface LogFailureInput {
  equipmentId: string;
  occurredOn: string;
  symptoms: string[];
  component: string;
  mode?: string;
  repairAction?: string;
  parts: string[];
  outcome: FailureOutcome;
  repairCost: number | null;
  notes?: string;
  source?: 'manual' | 'diagnosis';
}

export interface DiagnosisLite {
  id: string;
  created_at: string;
  symptoms: string;
  ai_result: {
    probable_causes?: { cause: string }[];
    parts_needed?: { name: string; necessity: string }[];
  } | null;
}

/** Shared <select> styling for this feature (inputs use the shared <Input>). */
export const SELECT_CLASS =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary transition-colors focus-visible:border-accent';

export const CLIMATE_OPTIONS: { value: ClimateZone; label: string }[] = [
  { value: 'hot_humid', label: 'Hot & humid' },
  { value: 'hot_dry', label: 'Hot & dry' },
  { value: 'temperate', label: 'Temperate' },
  { value: 'cold', label: 'Cold' },
  { value: 'marine', label: 'Marine / coastal' },
  { value: 'mixed', label: 'Mixed / seasonal extremes' },
];

export const USAGE_OPTIONS: { value: UsageProfile; label: string }[] = [
  { value: 'light', label: 'Light use' },
  { value: 'normal', label: 'Normal use' },
  { value: 'heavy', label: 'Heavy use' },
  { value: 'continuous', label: 'Continuous / 24-7' },
];

export const OUTCOME_META: Record<FailureOutcome, { label: string; className: string }> = {
  fixed: { label: 'Fixed', className: 'bg-success-500/10 text-success-500' },
  recurred: { label: 'Recurred', className: 'bg-warning-500/10 text-warning-500' },
  callback: { label: 'Callback', className: 'bg-warning-500/10 text-warning-500' },
  replaced_unit: { label: 'Unit replaced', className: 'bg-danger-500/10 text-danger-500' },
  deferred: { label: 'Deferred', className: 'bg-bg-tertiary text-text-secondary' },
  unknown: { label: 'Unknown', className: 'bg-bg-tertiary text-text-secondary' },
};

export const PATTERN_STATUS_META: Record<PatternStatus, { label: string; className: string }> = {
  emerging: { label: 'Emerging', className: 'bg-danger-500/10 text-danger-500' },
  elevated: { label: 'Elevated', className: 'bg-warning-500/10 text-warning-500' },
  stable: { label: 'Stable', className: 'bg-bg-tertiary text-text-secondary' },
  declining: { label: 'Declining', className: 'bg-success-500/10 text-success-500' },
};

// Suggestions only: converging on the same vocabulary is what makes cross-business patterns detectable.
export const COMPONENT_SUGGESTIONS = [
  'compressor', 'run_capacitor', 'start_capacitor', 'contactor', 'blower_motor', 'condenser_fan_motor',
  'evaporator_coil', 'condenser_coil', 'refrigerant_leak', 'expansion_valve', 'control_board', 'thermostat',
  'igniter', 'flame_sensor', 'heat_exchanger', 'gas_valve', 'inducer_motor', 'pressure_switch',
  'heating_element', 'anode_rod', 'tank_leak', 'circulator_pump', 'drain_pan', 'float_switch', 'breaker',
];

export const REPAIR_SUGGESTIONS = [
  'replace_component', 'clean', 'recharge_refrigerant', 'reseal', 'reprogram', 'rewire', 'tighten_connection',
  'flush', 'descale', 'recalibrate', 'replace_unit',
];

// ---------------------------------------------------------------- pure helpers

export function slugify(input: string | null | undefined): string | null {
  const s = (input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 60)
    .replace(/^_+|_+$/g, '');
  return s || null;
}

export function parseTags(input: string, max = 12): string[] {
  const seen = new Set<string>();
  for (const part of input.split(/[,\n;]+/)) {
    const s = slugify(part);
    if (s) seen.add(s);
    if (seen.size >= max) break;
  }
  return [...seen].sort();
}

export function humanize(slug: string | null | undefined): string {
  if (!slug) return '—';
  const t = slug.replace(/_/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function ageBand(months: number | null): string {
  if (months == null) return 'unknown';
  if (months < 36) return '0-2y';
  if (months < 72) return '3-5y';
  if (months < 108) return '6-8y';
  if (months < 156) return '9-12y';
  return '13y+';
}

export function ageLabel(months: number | null): string {
  if (months == null) return 'Unknown';
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m}m`;
  return m === 0 ? `${y}y` : `${y}y ${m}m`;
}

export function modelLabelFromKey(key: string): string {
  const [make, model, type] = key.split('/');
  const name = [humanize(make), (model ?? '').toUpperCase()].filter((p) => p && p !== '—' && p !== 'UNKNOWN').join(' ');
  return type && type !== 'unknown' ? `${name} (${humanize(type).toLowerCase()})` : name;
}

export function unitLabel(u: Pick<UnitRow, 'make' | 'model' | 'equipment_type' | 'customer_name'>): string {
  const base = [u.make, u.model].filter(Boolean).join(' ') || u.equipment_type;
  return u.customer_name ? `${base} · ${u.customer_name}` : base;
}

/** The 10 DNA strands in canonical order. Profile strands are what you set; event strands are learned from logged failures. */
export function strandsOf(dna: GenomeDna): Strand[] {
  const modelName = [dna.model.make, dna.model.model].filter(Boolean).join(' ') || dna.model.type || '';
  const known = (band: string) => band !== 'unknown';
  const list = (items: string[]) => items.slice(0, 3).map(humanize).join(', ');
  const h = dna.history;
  const lastOutcome = dna.outcome.last;

  return [
    { key: 'model', label: 'Model', value: modelName || 'Unknown', filled: modelName !== '', kind: 'profile' },
    { key: 'age', label: 'Age', value: ageLabel(dna.age.months), filled: dna.age.months != null, kind: 'profile' },
    {
      key: 'climate', label: 'Climate', kind: 'profile', filled: known(dna.climate.band),
      value: known(dna.climate.band) ? humanize(dna.climate.band) : 'Not set',
    },
    {
      key: 'usage', label: 'Usage', kind: 'profile', filled: known(dna.usage.band),
      value: known(dna.usage.band) ? humanize(dna.usage.band) : 'Not set',
    },
    { key: 'symptoms', label: 'Symptoms', value: list(dna.symptoms) || '—', filled: dna.symptoms.length > 0, kind: 'event' },
    {
      key: 'history', label: 'History', kind: 'event', filled: h.failures > 0,
      value: h.failures === 0
        ? 'No failures logged'
        : `${h.failures} failure${h.failures === 1 ? '' : 's'}${h.recurrences > 0 ? ` · ${h.recurrences} repeat` : ''}`,
    },
    { key: 'parts', label: 'Parts', value: list(dna.parts) || '—', filled: dna.parts.length > 0, kind: 'event' },
    { key: 'failure', label: 'Failure', value: humanize(dna.failure.last), filled: dna.failure.last != null, kind: 'event' },
    { key: 'repair', label: 'Repair', value: humanize(dna.repair.last), filled: dna.repair.last != null, kind: 'event' },
    {
      key: 'outcome', label: 'Outcome', kind: 'event', filled: lastOutcome != null,
      value: lastOutcome ? OUTCOME_META[lastOutcome].label : '—',
    },
  ];
}

/** Profile strands still missing - filling them puts the unit in a sharper population cohort. */
export function missingProfileFields(dna: GenomeDna): StrandKey[] {
  return strandsOf(dna).filter((s) => s.kind === 'profile' && !s.filled).map((s) => s.key);
}

export function explainPattern(p: FailurePattern): string {
  const expected = Math.round(((p.baseline_rate * p.units_exposed) / 100) * 10) / 10;
  const cohort = [
    p.age_band !== 'any' ? `aged ${p.age_band}` : null,
    p.climate_band !== 'any' ? `in ${humanize(p.climate_band).toLowerCase()} climates` : null,
  ].filter(Boolean).join(' ');
  return (
    `${p.recent_events} ${humanize(p.failure_component).toLowerCase()} failures in the last ${p.window_days} days ` +
    `across ${p.units_exposed} ${modelLabelFromKey(p.model_key)} units${cohort ? ` ${cohort}` : ''}, ` +
    `versus about ${expected} expected from the prior baseline.`
  );
}

export function prefillFromDiagnosis(d: DiagnosisLite): { component: string; parts: string; notes: string } {
  const cause = d.ai_result?.probable_causes?.[0]?.cause;
  const parts = (d.ai_result?.parts_needed ?? []).filter((p) => p.necessity === 'likely').map((p) => p.name);
  return {
    component: slugify(cause)?.replace(/_/g, ' ') ?? '',
    parts: parts.join(', '),
    notes: `AI diagnosis: ${d.symptoms.slice(0, 280)}`,
  };
}

// ---------------------------------------------------------------- data access

interface EquipmentQueryRow {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_date: string | null;
  climate_zone: ClimateZone | null;
  usage_profile: UsageProfile | null;
  customer: { name: string } | { name: string }[] | null;
}

interface GenomeQueryRow extends GenomeSummary {
  equipment_id: string;
}

/** Active units merged with their genome (units with failures first). RLS scopes both queries to the account. */
export async function fetchUnits(limit = 500): Promise<UnitRow[]> {
  const [eq, gen] = await Promise.all([
    supabase
      .from('equipment')
      .select('id, equipment_type, make, model, install_date, climate_zone, usage_profile, customer:customer_id (name)')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('failure_genomes')
      .select('equipment_id, failure_count, recurrence_count, last_failure_on, dna, dna_hash, computed_at')
      .limit(limit * 2),
  ]);
  if (eq.error) throw eq.error;
  if (gen.error) throw gen.error;

  const genomes = new Map((gen.data as GenomeQueryRow[]).map((g) => [g.equipment_id, g]));
  const units = (eq.data as unknown as EquipmentQueryRow[]).map((row): UnitRow => {
    const customer = Array.isArray(row.customer) ? row.customer[0] : row.customer;
    const g = genomes.get(row.id);
    return {
      id: row.id,
      equipment_type: row.equipment_type,
      make: row.make,
      model: row.model,
      install_date: row.install_date,
      climate_zone: row.climate_zone,
      usage_profile: row.usage_profile,
      customer_name: customer?.name ?? null,
      genome: g
        ? {
            failure_count: g.failure_count,
            recurrence_count: g.recurrence_count,
            last_failure_on: g.last_failure_on,
            dna: g.dna,
            dna_hash: g.dna_hash,
            computed_at: g.computed_at,
          }
        : null,
    };
  });

  return units.sort(
    (a, b) =>
      (b.genome?.failure_count ?? 0) - (a.genome?.failure_count ?? 0) ||
      (b.genome?.last_failure_on ?? '').localeCompare(a.genome?.last_failure_on ?? ''),
  );
}

export async function fetchEvents(equipmentId: string): Promise<FailureEventRow[]> {
  const { data, error } = await supabase
    .from('equipment_failure_events')
    .select('id, occurred_on, age_months, symptoms, failure_component, failure_mode, repair_action, parts_replaced, outcome, repair_cost')
    .eq('equipment_id', equipmentId)
    .order('occurred_on', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data as FailureEventRow[];
}

export async function logFailureEvent(input: LogFailureInput): Promise<void> {
  const { error } = await supabase.from('equipment_failure_events').insert({
    equipment_id: input.equipmentId,
    occurred_on: input.occurredOn,
    symptoms: input.symptoms,
    failure_component: input.component,
    failure_mode: input.mode || null,
    repair_action: input.repairAction || null,
    parts_replaced: input.parts,
    outcome: input.outcome,
    repair_cost: input.repairCost,
    notes: input.notes?.trim() || null,
    source: input.source ?? 'manual',
  });
  if (error) throw error;
}

export async function deleteFailureEvent(id: string): Promise<void> {
  const { error } = await supabase.from('equipment_failure_events').delete().eq('id', id);
  if (error) throw error;
}

export async function updateEquipmentProfile(
  equipmentId: string,
  patch: { climate_zone?: ClimateZone | null; usage_profile?: UsageProfile | null },
): Promise<void> {
  const { error } = await supabase.from('equipment').update(patch).eq('id', equipmentId);
  if (error) throw error;
}

export async function fetchPatternExposure(includeStable: boolean): Promise<ExposureRow[]> {
  const status: PatternStatus[] = includeStable
    ? ['emerging', 'elevated', 'stable', 'declining']
    : ['emerging', 'elevated'];
  const { data, error } = await supabase.rpc('get_failure_pattern_exposure', { p_status: status });
  if (error) throw error;
  return (data as ExposureRow[]) ?? [];
}

/** True unless the business opted out. Missing profile row counts as contributing (matches the DB default). */
export async function fetchSharing(): Promise<boolean> {
  const { data, error } = await supabase.from('business_profile').select('failure_genome_contribute').maybeSingle();
  if (error) throw error;
  return (data as { failure_genome_contribute: boolean } | null)?.failure_genome_contribute ?? true;
}

export async function saveSharing(ownerId: string, value: boolean): Promise<void> {
  const { data, error } = await supabase
    .from('business_profile')
    .update({ failure_genome_contribute: value })
    .eq('user_id', ownerId)
    .select('user_id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('Business profile not found.');
}

export async function fetchLatestDiagnosis(equipmentId: string): Promise<DiagnosisLite | null> {
  const { data, error } = await supabase
    .from('diagnosis_sessions')
    .select('id, created_at, symptoms, ai_result')
    .eq('equipment_id', equipmentId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data as DiagnosisLite[] | null) ?? [])[0] ?? null;
}
