import { supabase } from '@/lib/supabase';
import type {
  EvalStatus,
  FundingStatus,
  IncentiveEvaluation,
  IncentiveKind,
  IncentiveLevel,
  MeasureType,
  OptionResult,
  RebateReport,
  ReplacementOption,
  ReplacementStage,
} from '../../supabase/functions/_shared/rebate-intelligence/engine';

/**
 * Vireek Energy + Rebate Intelligence - dashboard client.
 *
 * All eligibility math runs server-side (supabase/functions/rebate-intelligence)
 * in a deterministic engine. This module invokes it, manages the account's own
 * programs and the outcome pipeline, and holds display metadata. Types are
 * imported (type-only where possible) from the engine so client and server
 * can never drift.
 */

export type { EvalStatus, FundingStatus, IncentiveEvaluation, IncentiveKind, IncentiveLevel, MeasureType, OptionResult, RebateReport, ReplacementOption, ReplacementStage };

// ---------------------------------------------------------------------------
// Display metadata
// ---------------------------------------------------------------------------

export const MEASURE_LABELS: Record<MeasureType, string> = {
  heat_pump_hvac: 'Heat pump (HVAC)',
  central_ac: 'Central air conditioner',
  furnace: 'Furnace',
  boiler: 'Boiler',
  heat_pump_water_heater: 'Heat pump water heater',
  water_heater: 'Water heater',
  panel_upgrade: 'Electrical panel upgrade',
  insulation_air_sealing: 'Insulation / air sealing',
  smart_thermostat: 'Smart thermostat',
  windows_doors: 'Windows / doors',
  duct_sealing: 'Duct sealing',
  home_energy_audit: 'Home energy audit',
};

export const MEASURE_OPTIONS = (Object.keys(MEASURE_LABELS) as MeasureType[]).map((value) => ({ value, label: MEASURE_LABELS[value] }));

export const STATUS_META: Record<EvalStatus, { label: string; tone: string }> = {
  eligible: { label: 'Eligible', tone: 'bg-success-500/10 text-success-500' },
  likely: { label: 'Likely', tone: 'bg-warning-500/10 text-warning-500' },
  needs_info: { label: 'Needs info', tone: 'bg-accent/10 text-accent' },
  ineligible: { label: 'Not eligible', tone: 'bg-danger-500/10 text-danger-500' },
};

export const STAGE_META: Record<ReplacementStage, { label: string; tone: string }> = {
  unknown: { label: 'Age unknown', tone: 'bg-bg-primary text-text-secondary' },
  early: { label: 'Early life', tone: 'bg-success-500/10 text-success-500' },
  mid: { label: 'Mid life', tone: 'bg-success-500/10 text-success-500' },
  late: { label: 'Plan replacement', tone: 'bg-warning-500/10 text-warning-500' },
  past_life: { label: 'Past expected life', tone: 'bg-danger-500/10 text-danger-500' },
};

export const LEVEL_LABELS: Record<IncentiveLevel, string> = {
  federal: 'Federal',
  state: 'State',
  local: 'Local',
  utility: 'Utility',
  manufacturer: 'Manufacturer',
};

export type ApplicationStatus = 'identified' | 'proposed' | 'submitted' | 'approved' | 'paid' | 'denied' | 'withdrawn';

export const APPLICATION_STATUSES: { value: ApplicationStatus; label: string }[] = [
  { value: 'identified', label: 'Identified' },
  { value: 'proposed', label: 'Proposed to customer' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'approved', label: 'Approved' },
  { value: 'paid', label: 'Paid' },
  { value: 'denied', label: 'Denied' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

export function formatUsd(cents: number): string {
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  const s = abs >= 100 ? Math.round(abs).toLocaleString('en-US') : abs.toFixed(2);
  return `${dollars < 0 ? '-' : ''}$${s}`;
}

export const dollarsToCents = (v: string): number | null => {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

// ---------------------------------------------------------------------------
// Run the engine
// ---------------------------------------------------------------------------

export interface RebateRequest {
  customerId: string;
  equipmentId?: string | null;
  siteId?: string | null;
  property: {
    state?: string;
    postal_code?: string;
    utility_name?: string;
    household_ami_pct?: number | null;
    owner_occupied?: boolean | null;
    install_target_date?: string | null;
  };
  options: ReplacementOption[];
  financing?: { apr_bps: number; term_months: number } | null;
}

export interface RebateAnalysisResult {
  analysisId: string | null;
  persisted: boolean;
  report: RebateReport;
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
  return error instanceof Error ? error.message : 'Could not analyze incentives.';
}

export async function runRebateAnalysis(req: RebateRequest): Promise<RebateAnalysisResult> {
  const { data, error } = await supabase.functions.invoke('rebate-intelligence', { body: req });
  if (error) throw new Error(await extractInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  if (!data?.report) throw new Error('Rebate Intelligence returned no result.');
  return { analysisId: data.analysis_id ?? null, persisted: data.persisted !== false, report: data.report as RebateReport };
}

// ---------------------------------------------------------------------------
// Customers / equipment pickers
// ---------------------------------------------------------------------------

export interface PickerCustomer {
  id: string;
  name: string;
}
export interface PickerEquipment {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_date: string | null;
}

export async function fetchPickerCustomers(): Promise<PickerCustomer[]> {
  const { data, error } = await supabase.from('customers').select('id, name').order('name', { ascending: true }).limit(500);
  if (error) throw error;
  return (data ?? []) as PickerCustomer[];
}

export async function fetchCustomerEquipment(customerId: string): Promise<PickerEquipment[]> {
  const { data, error } = await supabase
    .from('equipment')
    .select('id, equipment_type, make, model, install_date')
    .eq('customer_id', customerId)
    .eq('status', 'active')
    .order('install_date', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as PickerEquipment[];
}

// ---------------------------------------------------------------------------
// Private programs (account-entered)
// ---------------------------------------------------------------------------

export interface ProgramRow {
  id: string;
  owner_user_id: string | null;
  slug: string;
  name: string;
  level: IncentiveLevel;
  jurisdiction_state: string | null;
  utility_name: string | null;
  measure_types: string[];
  incentive_kind: IncentiveKind;
  amount_type: 'flat' | 'percent_of_cost' | 'per_ton' | 'per_unit';
  amount_value: number;
  max_amount_cents: number | null;
  funding_status: FundingStatus;
  end_date: string | null;
  source_url: string | null;
  last_verified_at: string | null;
}

export async function fetchPrograms(): Promise<ProgramRow[]> {
  const { data, error } = await supabase
    .from('incentive_programs')
    .select('id, owner_user_id, slug, name, level, jurisdiction_state, utility_name, measure_types, incentive_kind, amount_type, amount_value, max_amount_cents, funding_status, end_date, source_url, last_verified_at')
    .eq('is_active', true)
    .order('name', { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data ?? []).map((p) => ({ ...p, amount_value: Number(p.amount_value) })) as ProgramRow[];
}

export interface ProgramForm {
  name: string;
  level: IncentiveLevel;
  state: string;
  utility_name: string;
  measure: MeasureType;
  kind: IncentiveKind;
  amount_type: 'flat' | 'percent_of_cost' | 'per_ton' | 'per_unit';
  amount: string; // dollars for flat/per_ton/per_unit, percent for percent_of_cost
  max_amount: string;
  min_seer2: string;
  funding_status: FundingStatus;
  end_date: string;
  source_url: string;
  pre_approval: boolean;
}

export const EMPTY_PROGRAM_FORM: ProgramForm = {
  name: '',
  level: 'utility',
  state: '',
  utility_name: '',
  measure: 'heat_pump_hvac',
  kind: 'rebate',
  amount_type: 'flat',
  amount: '',
  max_amount: '',
  min_seer2: '',
  funding_status: 'open',
  end_date: '',
  source_url: '',
  pre_approval: false,
};

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'program';
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function addPrivateProgram(ownerId: string, f: ProgramForm): Promise<void> {
  const name = f.name.trim();
  if (name.length < 3) throw new Error('Give the program a name (3+ characters).');
  const amount = Number(f.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter the incentive amount.');
  if (f.amount_type === 'percent_of_cost' && amount > 100) throw new Error('A percentage cannot exceed 100.');
  const state = f.state.trim().toUpperCase();
  if (state && !/^[A-Z]{2}$/.test(state)) throw new Error('State must be a 2-letter code, e.g. TX.');
  if (f.level !== 'federal' && !state && !f.utility_name.trim()) throw new Error('Add a state or a utility so the program only applies where it should.');
  const minSeer2 = f.min_seer2.trim() === '' ? null : Number(f.min_seer2);
  if (minSeer2 !== null && (!Number.isFinite(minSeer2) || minSeer2 <= 0)) throw new Error('Minimum SEER2 must be a positive number.');
  const maxCents = dollarsToCents(f.max_amount);

  const { error } = await supabase.from('incentive_programs').insert({
    owner_user_id: ownerId,
    slug: slugify(name),
    name,
    level: f.level,
    jurisdiction_state: state || null,
    utility_name: f.utility_name.trim() || null,
    measure_types: [f.measure],
    incentive_kind: f.kind,
    payout_timing: f.kind === 'instant_discount' ? 'point_of_sale' : f.kind === 'tax_credit' ? 'tax_filing' : 'post_install',
    amount_type: f.amount_type,
    amount_value: f.amount_type === 'percent_of_cost' ? amount : Math.round(amount * 100),
    max_amount_cents: maxCents,
    min_efficiency: minSeer2 === null ? {} : { seer2: minSeer2 },
    requires_pre_approval: f.pre_approval,
    funding_status: f.funding_status,
    end_date: f.end_date || null,
    source_url: f.source_url.trim() || null,
    last_verified_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function deletePrivateProgram(id: string): Promise<void> {
  const { error } = await supabase.from('incentive_programs').delete().eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Rebate pipeline (outcome ledger)
// ---------------------------------------------------------------------------

export interface ApplicationRow {
  id: string;
  customer_id: string;
  program_id: string | null;
  program_name: string;
  option_key: string | null;
  status: ApplicationStatus;
  estimated_cents: number;
  approved_cents: number | null;
  paid_cents: number | null;
  denial_reason: string | null;
  created_at: string;
  customers: { name: string } | null;
}

export async function fetchApplications(): Promise<ApplicationRow[]> {
  const { data, error } = await supabase
    .from('rebate_applications')
    .select('id, customer_id, program_id, program_name, option_key, status, estimated_cents, approved_cents, paid_cents, denial_reason, created_at, customers(name)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as unknown as ApplicationRow[];
}

export async function trackIncentive(
  ownerId: string,
  p: { customerId: string; analysisId: string | null; optionKey: string; ev: IncentiveEvaluation },
): Promise<void> {
  const { error } = await supabase.from('rebate_applications').insert({
    user_id: ownerId,
    customer_id: p.customerId,
    analysis_id: p.analysisId,
    program_id: p.ev.program_id,
    program_name: p.ev.name,
    option_key: p.optionKey,
    status: 'identified',
    estimated_cents: p.ev.expected_cents > 0 ? p.ev.expected_cents : p.ev.upside_cents,
  });
  if (error) {
    if (error.code === '23505') throw new Error('Already tracked in your pipeline.');
    throw error;
  }
}

export async function updateApplication(
  id: string,
  patch: { status?: ApplicationStatus; approved_cents?: number | null; paid_cents?: number | null; denial_reason?: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = { ...patch };
  if (patch.status === 'submitted') row.submitted_at = now;
  if (patch.status === 'approved' || patch.status === 'denied') row.decided_at = now;
  if (patch.status === 'paid') {
    row.paid_at = now;
    row.decided_at = now;
  }
  const { error } = await supabase.from('rebate_applications').update(row).eq('id', id);
  if (error) throw error;
}

export async function deleteApplication(id: string): Promise<void> {
  const { error } = await supabase.from('rebate_applications').delete().eq('id', id);
  if (error) throw error;
}
