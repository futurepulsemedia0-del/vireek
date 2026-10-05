import { supabase } from '@/lib/supabase';
import type {
  ActionItem,
  BenefitKind,
  CustomerKind,
  Delivery,
  EligibilityStatus,
  FundingStatus,
  IncentiveProject,
  IncentiveReport,
  PercentBasis,
  ProgramEvaluation,
  ProgramType,
} from '../../supabase/functions/_shared/incentives/engine';

/**
 * Vireek Incentive Decision Engine: dashboard client.
 *
 * All eligibility and economics are computed server-side
 * (supabase/functions/incentive-decision-engine) by a deterministic engine.
 * This module only invokes it, manages the account's own program catalog, and
 * holds display metadata. Types are imported (type-only) from the engine so the
 * client can never drift from the server.
 */

export type {
  ActionItem,
  BenefitKind,
  CustomerKind,
  Delivery,
  EligibilityStatus,
  FundingStatus,
  IncentiveProject,
  IncentiveReport,
  PercentBasis,
  ProgramEvaluation,
  ProgramType,
};

export { formatUsd } from '@/lib/quoteTruth';

// ---------------------------------------------------------------------------
// Display metadata
// ---------------------------------------------------------------------------

export const STATUS_META: Record<EligibilityStatus, { label: string; tone: string }> = {
  eligible: { label: 'Eligible', tone: 'bg-success-500/10 text-success-500' },
  conditional: { label: 'Verify first', tone: 'bg-warning-500/10 text-warning-500' },
  ineligible: { label: 'Not eligible', tone: 'bg-bg-tertiary text-text-secondary' },
};

export const PROGRAM_TYPE_OPTIONS: { value: ProgramType; label: string }[] = [
  { value: 'utility_rebate', label: 'Utility rebate' },
  { value: 'manufacturer_rebate', label: 'Manufacturer rebate' },
  { value: 'government_rebate', label: 'Government rebate' },
  { value: 'tax_credit', label: 'Tax credit' },
  { value: 'financing', label: 'Financing incentive' },
  { value: 'grant', label: 'Grant' },
  { value: 'other', label: 'Other' },
];

export const DELIVERY_OPTIONS: { value: Delivery; label: string }[] = [
  { value: 'instant', label: 'Instant (applied at invoice)' },
  { value: 'mail_in', label: 'Paid after the sale (mail-in / portal)' },
  { value: 'tax_credit', label: 'Tax credit (at filing)' },
];

export const BENEFIT_KIND_OPTIONS: { value: BenefitKind; label: string }[] = [
  { value: 'fixed', label: 'Fixed amount ($)' },
  { value: 'per_unit', label: 'Per unit ($ each)' },
  { value: 'percent', label: 'Percent of cost (%)' },
];

export const FUNDING_OPTIONS: { value: FundingStatus; label: string }[] = [
  { value: 'available', label: 'Funding open' },
  { value: 'waitlist', label: 'Waitlisted' },
  { value: 'exhausted', label: 'Exhausted' },
  { value: 'unknown', label: 'Unknown' },
];

export const CUSTOMER_KIND_OPTIONS: { value: CustomerKind; label: string }[] = [
  { value: 'any', label: 'Any customer' },
  { value: 'residential', label: 'Residential only' },
  { value: 'commercial', label: 'Commercial only' },
];

export const BASIS_OPTIONS: { value: PercentBasis; label: string }[] = [
  { value: 'project', label: 'Whole project price' },
  { value: 'equipment', label: 'Equipment cost only' },
];

export const DELIVERY_LABEL: Record<Delivery, string> = {
  instant: 'Instant',
  mail_in: 'After sale',
  tax_credit: 'Tax credit',
};

export function formatMonths(months: number | null): string {
  if (months === null || !Number.isFinite(months)) return 'n/a';
  if (months < 12) return `${months.toFixed(months % 1 === 0 ? 0 : 1)} mo`;
  const years = months / 12;
  return `${years.toFixed(1)} yr`;
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

/** Form state for the project inputs. Strings so empty means "not provided". */
export interface ProjectForm {
  effective_date: string;
  country: string;
  state: string;
  postal_code: string;
  utility_name: string;
  owner_occupied: '' | 'yes' | 'no';
  income_qualified: '' | 'yes' | 'no';
  building_year_built: string;
  equipment_type: string;
  equipment_units: string;
  efficiency_metric: string;
  efficiency_value: string;
  equipment_cost_dollars: string;
  annual_kwh_saved: string;
  annual_therms_saved: string;
  annual_savings_dollars: string;
  electric_rate_cents_per_kwh: string;
  gas_rate_cents_per_therm: string;
}

export const EMPTY_PROJECT_FORM: ProjectForm = {
  effective_date: '',
  country: '',
  state: '',
  postal_code: '',
  utility_name: '',
  owner_occupied: '',
  income_qualified: '',
  building_year_built: '',
  equipment_type: '',
  equipment_units: '1',
  efficiency_metric: '',
  efficiency_value: '',
  equipment_cost_dollars: '',
  annual_kwh_saved: '',
  annual_therms_saved: '',
  annual_savings_dollars: '',
  electric_rate_cents_per_kwh: '',
  gas_rate_cents_per_therm: '',
};

const triToBool = (v: '' | 'yes' | 'no'): boolean | null => (v === 'yes' ? true : v === 'no' ? false : null);
const boolToTri = (v: boolean | null): '' | 'yes' | 'no' => (v === true ? 'yes' : v === false ? 'no' : '');
const numStr = (v: number | null): string => (v === null || v === undefined ? '' : String(v));

/** Builds the request body. Empty strings are sent as null so the server falls back to saved defaults. */
export function projectFormToRequest(f: ProjectForm): Record<string, unknown> {
  const n = (s: string): number | null => (s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));
  return {
    effective_date: f.effective_date || null,
    country: f.country.trim() || null,
    state: f.state.trim() || null,
    postal_code: f.postal_code.trim() || null,
    utility_name: f.utility_name.trim() || null,
    owner_occupied: triToBool(f.owner_occupied),
    income_qualified: triToBool(f.income_qualified),
    building_year_built: n(f.building_year_built),
    equipment_type: f.equipment_type.trim() || null,
    equipment_units: n(f.equipment_units),
    efficiency_metric: f.efficiency_metric.trim() || null,
    efficiency_value: n(f.efficiency_value),
    equipment_cost_dollars: n(f.equipment_cost_dollars),
    annual_kwh_saved: n(f.annual_kwh_saved),
    annual_therms_saved: n(f.annual_therms_saved),
    annual_savings_dollars: n(f.annual_savings_dollars),
    electric_rate_cents_per_kwh: n(f.electric_rate_cents_per_kwh),
    gas_rate_cents_per_therm: n(f.gas_rate_cents_per_therm),
  };
}

/** Fills the form from the server-resolved project so saved defaults become visible and editable. */
export function projectToForm(p: IncentiveProject, previous: ProjectForm): ProjectForm {
  return {
    ...previous,
    effective_date: p.effective_date,
    country: p.country ?? '',
    state: p.state ?? '',
    postal_code: p.postal_code ?? '',
    utility_name: p.utility_name ?? '',
    owner_occupied: boolToTri(p.owner_occupied),
    income_qualified: boolToTri(p.income_qualified),
    building_year_built: numStr(p.building_year_built),
    electric_rate_cents_per_kwh: numStr(p.electric_rate_cents_per_kwh),
    gas_rate_cents_per_therm: numStr(p.gas_rate_cents_per_therm),
  };
}

export interface IncentiveAssessmentResult {
  assessmentId: string | null;
  persisted: boolean;
  profileSaved: boolean;
  customerId: string | null;
  project: IncentiveProject;
  report: IncentiveReport;
}

async function extractInvokeError(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx && typeof (ctx as Response).json === 'function') {
    try {
      const body = (await (ctx as Response).clone().json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      // fall through to the generic message
    }
  }
  return error instanceof Error ? error.message : 'Could not assess incentives.';
}

/** Runs the Incentive Decision Engine for a saved quote. Throws with a user-facing message. */
export async function assessQuoteIncentives(quoteId: string, form: ProjectForm, saveDefaults = false): Promise<IncentiveAssessmentResult> {
  const { data, error } = await supabase.functions.invoke('incentive-decision-engine', {
    body: { quoteId, project: projectFormToRequest(form), saveDefaults },
  });
  if (error) throw new Error(await extractInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  if (!data?.report || !data?.project) throw new Error('The Incentive Engine returned no result.');
  return {
    assessmentId: data.analysis_id ?? null,
    persisted: data.persisted !== false,
    profileSaved: data.profile_saved === true,
    customerId: data.customer_id ?? null,
    project: data.project as IncentiveProject,
    report: data.report as IncentiveReport,
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface IncentiveAssessmentRow {
  id: string;
  quote_id: string;
  total_cents: number;
  confirmed_cents: number;
  potential_cents: number;
  net_cost_best_cents: number;
  payback_months_best: number | null;
  created_at: string;
  quotes: { customer_name: string } | null;
}

export async function fetchRecentAssessments(limit = 50): Promise<IncentiveAssessmentRow[]> {
  const { data, error } = await supabase
    .from('incentive_assessments')
    .select('id, quote_id, total_cents, confirmed_cents, potential_cents, net_cost_best_cents, payback_months_best, created_at, quotes:quote_id (customer_name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as unknown as IncentiveAssessmentRow[]) ?? [];
}

// ---------------------------------------------------------------------------
// Program catalog (owner-editable)
// ---------------------------------------------------------------------------

export interface IncentiveProgramRow {
  id: string;
  name: string;
  program_type: ProgramType;
  administrator: string | null;
  country: string;
  states: string[];
  postal_prefixes: string[];
  utility_names: string[];
  equipment_types: string[];
  customer_kind: CustomerKind;
  requires_owner_occupied: boolean;
  requires_income_qualified: boolean;
  min_building_age_years: number | null;
  max_building_age_years: number | null;
  efficiency_metric: string | null;
  min_efficiency_value: number | null;
  min_project_cents: number | null;
  benefit_kind: BenefitKind;
  benefit_value: number;
  cap_cents: number | null;
  percent_basis: PercentBasis;
  delivery: Delivery;
  stack_group: string | null;
  funding_status: FundingStatus;
  effective_start: string | null;
  effective_end: string | null;
  verified_at: string | null;
  source_url: string | null;
  notes: string | null;
  is_active: boolean;
}

export const STALE_AFTER_DAYS = 180;

export function programFreshness(verifiedAt: string | null, now = Date.now()): { label: string; stale: boolean } {
  if (!verifiedAt) return { label: 'Never verified', stale: true };
  const days = Math.floor((now - Date.parse(verifiedAt)) / 86_400_000);
  if (!Number.isFinite(days)) return { label: 'Never verified', stale: true };
  return { label: days <= 0 ? 'Verified today' : `Verified ${days}d ago`, stale: days > STALE_AFTER_DAYS };
}

export function describeBenefit(p: Pick<IncentiveProgramRow, 'benefit_kind' | 'benefit_value' | 'cap_cents'>): string {
  const cap = p.cap_cents !== null ? ` (cap ${formatDollars(p.cap_cents)})` : '';
  if (p.benefit_kind === 'percent') return `${p.benefit_value}% of cost${cap}`;
  if (p.benefit_kind === 'per_unit') return `${formatDollars(p.benefit_value)} per unit${cap}`;
  return `${formatDollars(p.benefit_value)}${cap}`;
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export async function fetchPrograms(): Promise<IncentiveProgramRow[]> {
  const { data, error } = await supabase
    .from('incentive_programs')
    .select(
      'id, name, program_type, administrator, country, states, postal_prefixes, utility_names, equipment_types, customer_kind, requires_owner_occupied, requires_income_qualified, min_building_age_years, max_building_age_years, efficiency_metric, min_efficiency_value, min_project_cents, benefit_kind, benefit_value, cap_cents, percent_basis, delivery, stack_group, funding_status, effective_start, effective_end, verified_at, source_url, notes, is_active',
    )
    .order('is_active', { ascending: false })
    .order('name', { ascending: true })
    .limit(300);
  if (error) throw error;
  return ((data as unknown as IncentiveProgramRow[]) ?? []).map((p) => ({
    ...p,
    states: p.states ?? [],
    postal_prefixes: p.postal_prefixes ?? [],
    utility_names: p.utility_names ?? [],
    equipment_types: p.equipment_types ?? [],
    benefit_value: Number(p.benefit_value),
  }));
}

/** Form state for adding a program. Dollar fields are in dollars; they are converted to cents on save. */
export interface ProgramForm {
  name: string;
  program_type: ProgramType;
  administrator: string;
  country: string;
  states: string;
  postal_prefixes: string;
  utility_names: string;
  equipment_types: string;
  customer_kind: CustomerKind;
  requires_owner_occupied: boolean;
  requires_income_qualified: boolean;
  min_building_age_years: string;
  max_building_age_years: string;
  efficiency_metric: string;
  min_efficiency_value: string;
  min_project_dollars: string;
  benefit_kind: BenefitKind;
  benefit_value: string;
  cap_dollars: string;
  percent_basis: PercentBasis;
  delivery: Delivery;
  stack_group: string;
  funding_status: FundingStatus;
  effective_start: string;
  effective_end: string;
  source_url: string;
  notes: string;
  verified_now: boolean;
}

export const EMPTY_PROGRAM_FORM: ProgramForm = {
  name: '',
  program_type: 'utility_rebate',
  administrator: '',
  country: 'US',
  states: '',
  postal_prefixes: '',
  utility_names: '',
  equipment_types: '',
  customer_kind: 'any',
  requires_owner_occupied: false,
  requires_income_qualified: false,
  min_building_age_years: '',
  max_building_age_years: '',
  efficiency_metric: '',
  min_efficiency_value: '',
  min_project_dollars: '',
  benefit_kind: 'fixed',
  benefit_value: '',
  cap_dollars: '',
  percent_basis: 'project',
  delivery: 'mail_in',
  stack_group: '',
  funding_status: 'available',
  effective_start: '',
  effective_end: '',
  source_url: '',
  notes: '',
  verified_now: true,
};

const splitList = (s: string): string[] =>
  Array.from(new Set(s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean))).slice(0, 50);

function optionalNumber(s: string, label: string, min = 0): number | null {
  if (s.trim() === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < min) throw new Error(`${label} must be a number${min > 0 ? ` of at least ${min}` : ' of 0 or more'}.`);
  return n;
}

export async function addProgram(ownerId: string, f: ProgramForm): Promise<void> {
  const name = f.name.trim();
  if (name.length < 2) throw new Error('Give the program a name.');
  const value = Number(f.benefit_value);
  if (f.benefit_value.trim() === '' || !Number.isFinite(value) || value < 0) throw new Error('Enter the benefit amount.');
  if (f.benefit_kind === 'percent' && value > 100) throw new Error('A percentage benefit cannot exceed 100.');
  const country = f.country.trim().toUpperCase();
  if (country.length < 2 || country.length > 3) throw new Error('Use a 2-letter country code, e.g. US.');
  if (f.effective_start && f.effective_end && f.effective_end < f.effective_start) throw new Error('The end date is before the start date.');
  if (f.source_url.trim() && !/^https?:\/\//i.test(f.source_url.trim())) throw new Error('The source link must start with http:// or https://');
  const minAge = optionalNumber(f.min_building_age_years, 'Minimum building age');
  const maxAge = optionalNumber(f.max_building_age_years, 'Maximum building age');
  if (minAge !== null && maxAge !== null && maxAge < minAge) throw new Error('Maximum building age is below the minimum.');
  const minEff = optionalNumber(f.min_efficiency_value, 'Minimum efficiency');
  const minProject = optionalNumber(f.min_project_dollars, 'Minimum project size');
  const cap = optionalNumber(f.cap_dollars, 'Cap');

  const { error } = await supabase.from('incentive_programs').insert({
    user_id: ownerId,
    name,
    program_type: f.program_type,
    administrator: f.administrator.trim() || null,
    country,
    states: splitList(f.states),
    postal_prefixes: splitList(f.postal_prefixes),
    utility_names: splitList(f.utility_names),
    equipment_types: splitList(f.equipment_types),
    customer_kind: f.customer_kind,
    requires_owner_occupied: f.requires_owner_occupied,
    requires_income_qualified: f.requires_income_qualified,
    min_building_age_years: minAge === null ? null : Math.round(minAge),
    max_building_age_years: maxAge === null ? null : Math.round(maxAge),
    efficiency_metric: f.efficiency_metric.trim() || null,
    min_efficiency_value: minEff,
    min_project_cents: minProject === null ? null : Math.round(minProject * 100),
    benefit_kind: f.benefit_kind,
    benefit_value: f.benefit_kind === 'percent' ? value : Math.round(value * 100),
    cap_cents: cap === null ? null : Math.round(cap * 100),
    percent_basis: f.percent_basis,
    delivery: f.delivery,
    stack_group: f.stack_group.trim() || null,
    funding_status: f.funding_status,
    effective_start: f.effective_start || null,
    effective_end: f.effective_end || null,
    verified_at: f.verified_now ? new Date().toISOString() : null,
    source_url: f.source_url.trim() || null,
    notes: f.notes.trim() || null,
  });
  if (error) throw error;
}

export async function setProgramActive(id: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.from('incentive_programs').update({ is_active: isActive, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function markProgramVerified(id: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from('incentive_programs').update({ verified_at: now, updated_at: now }).eq('id', id);
  if (error) throw error;
}

export async function deleteProgram(id: string): Promise<void> {
  const { error } = await supabase.from('incentive_programs').delete().eq('id', id);
  if (error) throw error;
}
