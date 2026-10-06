/**
 * Vireek Home Service Passport — client library.
 *
 * FACTS (equipment, warranties, service history, permits, known problems,
 * predicted maintenance) are derived server-side by get_home_service_passport()
 * and sealed by issue_home_passport_transfer(). Nothing here lets a user type a
 * fact into a passport.
 *
 * PROJECTIONS (expected future costs) are the one client-computed block: they
 * come from the existing Home Budget model (computeHomeBudget), are sanitised
 * and bounded by the server, and are always labelled "estimate" in the UI.
 */

import { supabase } from '@/lib/supabase';
import type { Equipment, EquipmentMaintenanceAlert, Job } from '@/lib/supabase';
import type { PropertyTwin, PropertyTwinJobLink } from '@/lib/propertyTwin';
import type { HierarchySite } from '@/lib/siteHierarchy';
import { computeHomeBudget, type HomeBudget } from '@/lib/homeBudget';

// ------------------------------------------------------------------------ types

export type RecipientType = 'buyer' | 'agent' | 'inspector' | 'insurer' | 'lender' | 'owner';
export type EquipmentCondition = 'good' | 'watch' | 'attention' | 'unknown' | 'retired';
export type ProblemSeverity = 'high' | 'medium' | 'low';
export type ProblemKind =
  | 'open_alert'
  | 'past_expected_life'
  | 'recurring_repair'
  | 'overdue_service'
  | 'safety_flag'
  | 'permit_gap';

export interface PassportEquipment {
  label: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  install_date: string | null;
  age_years: number | null;
  lifespan_years: number;
  remaining_years: number | null;
  status: 'active' | 'replaced' | 'removed';
  warranty_expires_at: string | null;
  warranty_status: 'active' | 'expired' | 'unknown';
  warranty_notes: string | null;
  last_service_date: string | null;
  service_interval_months: number;
  next_service_due: string | null;
  service_count: number;
  repair_count_24m: number;
  condition: EquipmentCondition;
}

export interface PassportServiceVisit {
  date: string | null;
  service_type: string | null;
  equipment: string[];
  was_rework: boolean;
  evidence_verified: boolean;
}

export interface PassportPermit {
  permit_type: string;
  permit_number: string | null;
  jurisdiction: string | null;
  status: PermitStatus;
  issued_on: string | null;
  expires_on: string | null;
  finalized_on: string | null;
}

export interface PassportProblem {
  kind: ProblemKind;
  severity: ProblemSeverity;
  equipment: string | null;
  title: string;
  detail: string | null;
}

export interface PassportPrediction {
  equipment: string;
  next_due: string | null;
  overdue: boolean;
  predicted_issue_due: string | null;
}

export interface PassportSummary {
  active_equipment: number;
  retired_equipment: number;
  needs_attention: number;
  on_watch: number;
  overdue_service: number;
  warranties_active: number;
  warranties_expiring_12m: number;
  avg_remaining_years: number | null;
  record_completeness_pct: number;
  service_visits: number;
  first_service_date: string | null;
  open_problems: number;
  permits_on_file: number;
}

export interface PassportProjections {
  model: string;
  annual: number;
  annualLow: number;
  annualHigh: number;
  fiveYear: number;
  fiveYearLow: number;
  fiveYearHigh: number;
  suggestedMonthlyReserve: number;
  confidence: 'low' | 'medium' | 'high';
  years: { year: number; maintenance: number; expectedFailure: number; total: number }[];
  categories: { key: string; label: string; annual: number; fiveYear: number; equipmentCount: number }[];
  assumptions: string[];
}

export interface HomePassportPayload {
  schema: string;
  generated_at: string;
  serviced_by: string | null;
  property: {
    address: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
    property_kind: 'residential' | 'commercial';
  };
  summary: PassportSummary;
  health: { score: number; grade: 'A' | 'B' | 'C' | 'D' | 'F'; confidence: number; computed_at: string } | null;
  equipment: PassportEquipment[];
  service_history: PassportServiceVisit[];
  permits: PassportPermit[];
  known_problems: PassportProblem[];
  predicted_maintenance: PassportPrediction[];
  recipient_type?: RecipientType;
  projections?: PassportProjections | null;
  consent_confirmed_at?: string;
}

export interface PassportTransfer {
  id: string;
  recipient_type: RecipientType;
  label: string | null;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
  snapshot_hash: string;
}

export interface IssuedTransfer {
  transfer_id: string;
  token: string;
  expires_at: string;
  snapshot_hash: string;
}

export interface PublicHomePassportResult {
  status: 'valid' | 'expired' | 'revoked' | 'tampered' | 'not_found';
  issued_at?: string;
  expires_at?: string;
  recipient_type?: RecipientType;
  snapshot_hash?: string;
  snapshot?: HomePassportPayload | null;
}

export type PermitStatus = 'applied' | 'issued' | 'inspection_pending' | 'passed' | 'failed' | 'expired' | 'closed';

export interface HomePermit {
  id: string;
  customer_id: string;
  job_id: string | null;
  permit_type: string;
  permit_number: string | null;
  jurisdiction: string | null;
  status: PermitStatus;
  issued_on: string | null;
  expires_on: string | null;
  finalized_on: string | null;
  notes: string | null;
}

export type PermitInput = Omit<HomePermit, 'id' | 'customer_id'>;

// ------------------------------------------------------------------------ labels

export const RECIPIENT_LABELS: Record<RecipientType, string> = {
  buyer: 'Home buyer',
  agent: 'Real-estate agent',
  inspector: 'Home inspector',
  insurer: 'Insurer',
  lender: 'Lender',
  owner: 'Homeowner copy',
};

export const PERMIT_STATUS_LABELS: Record<PermitStatus, string> = {
  applied: 'Applied',
  issued: 'Issued',
  inspection_pending: 'Inspection pending',
  passed: 'Passed inspection',
  failed: 'Failed inspection',
  expired: 'Expired',
  closed: 'Closed',
};

export const CONDITION_META: Record<EquipmentCondition, { label: string; className: string }> = {
  good: { label: 'Good', className: 'bg-success-500/10 text-success-500' },
  watch: { label: 'Watch', className: 'bg-warning-500/10 text-warning-500' },
  attention: { label: 'Needs attention', className: 'bg-danger/10 text-danger' },
  unknown: { label: 'Insufficient data', className: 'bg-bg-primary text-text-secondary' },
  retired: { label: 'Retired', className: 'bg-bg-primary text-text-secondary' },
};

export const SEVERITY_META: Record<ProblemSeverity, { label: string; className: string }> = {
  high: { label: 'High', className: 'bg-danger/10 text-danger' },
  medium: { label: 'Medium', className: 'bg-warning-500/10 text-warning-500' },
  low: { label: 'Low', className: 'bg-bg-primary text-text-secondary' },
};

// ----------------------------------------------------------------------- formatting

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

export function formatPassportDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatYears(years: number | null | undefined): string {
  if (years === null || years === undefined) return '—';
  return `${years} yr${years === 1 ? '' : 's'}`;
}

export function passportUrl(token: string): string {
  return `${window.location.origin}/verify/home/${token}`;
}

export function formatAddress(p: HomePassportPayload['property']): string {
  const tail = [p.city, [p.state, p.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [p.address, tail].filter(Boolean).join(' · ') || 'Address not on file';
}

// ------------------------------------------------------------------- data access

export async function fetchHomePassport(customerId: string): Promise<HomePassportPayload> {
  const { data, error } = await supabase.rpc('get_home_service_passport', { p_customer_id: customerId });
  if (error) throw error;
  return data as HomePassportPayload;
}

/** Customer-scoped twin (all of the customer's equipment, regardless of room/site). */
export async function fetchCustomerTwin(customerId: string): Promise<PropertyTwin> {
  const [equipmentRes, jobsRes, siteRes] = await Promise.all([
    supabase.from('equipment').select('*').eq('customer_id', customerId),
    supabase
      .from('jobs')
      .select('id, user_id, customer_id, service_type, scheduled_datetime, job_status, invoice_amount, invoice_currency, site_id')
      .eq('customer_id', customerId)
      .order('scheduled_datetime', { ascending: false })
      .limit(500),
    supabase.from('customer_sites').select('*').eq('customer_id', customerId).order('is_primary', { ascending: false }).limit(1),
  ]);
  if (equipmentRes.error) throw equipmentRes.error;
  if (jobsRes.error) throw jobsRes.error;
  if (siteRes.error) throw siteRes.error;

  const equipment = (equipmentRes.data ?? []) as Equipment[];
  const jobs = (jobsRes.data ?? []) as unknown as Job[];
  const equipmentIds = equipment.map((e) => e.id);
  const jobIds = jobs.map((j) => j.id);

  const [linksRes, alertsRes] = await Promise.all([
    jobIds.length > 0 && equipmentIds.length > 0
      ? supabase.from('job_equipment').select('job_id, equipment_id, service_type').in('job_id', jobIds)
      : Promise.resolve({ data: [] as PropertyTwinJobLink[], error: null }),
    equipmentIds.length > 0
      ? supabase.from('equipment_maintenance_alerts').select('*').in('equipment_id', equipmentIds).eq('is_dismissed', false)
      : Promise.resolve({ data: [] as EquipmentMaintenanceAlert[], error: null }),
  ]);
  if (linksRes.error) throw linksRes.error;
  if (alertsRes.error) throw alertsRes.error;

  const siteRow = (siteRes.data ?? [])[0];
  return {
    site: siteRow ? ({ ...siteRow, buildings: [] } as unknown as HierarchySite) : null,
    equipment,
    jobs,
    jobEquipmentLinks: (linksRes.data ?? []) as PropertyTwinJobLink[],
    maintenanceAlerts: (alertsRes.data ?? []) as EquipmentMaintenanceAlert[],
  };
}

/** Maps the Home Budget model onto the exact shape the server sanitiser accepts. */
export function buildProjections(budget: HomeBudget | null): Omit<PassportProjections, 'model'> | null {
  if (!budget) return null;
  return {
    annual: budget.annual,
    annualLow: budget.annualLow,
    annualHigh: budget.annualHigh,
    fiveYear: budget.fiveYear,
    fiveYearLow: budget.fiveYearLow,
    fiveYearHigh: budget.fiveYearHigh,
    suggestedMonthlyReserve: budget.suggestedMonthlyReserve,
    confidence: budget.confidence,
    years: budget.years.map((y) => ({
      year: y.year,
      maintenance: y.maintenance,
      expectedFailure: y.expectedFailure,
      total: y.total,
    })),
    categories: budget.categories.map((c) => ({
      key: c.key,
      label: c.label,
      annual: c.annual,
      fiveYear: c.fiveYear,
      equipmentCount: c.equipmentCount,
    })),
    assumptions: budget.assumptions,
  };
}

export async function computePassportProjections(customerId: string): Promise<Omit<PassportProjections, 'model'> | null> {
  const twin = await fetchCustomerTwin(customerId);
  return buildProjections(computeHomeBudget(twin));
}

export async function listPassportTransfers(customerId: string): Promise<PassportTransfer[]> {
  const { data, error } = await supabase
    .from('home_passport_transfers')
    .select('id, recipient_type, label, issued_at, expires_at, revoked_at, view_count, last_viewed_at, snapshot_hash')
    .eq('customer_id', customerId)
    .order('issued_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as PassportTransfer[];
}

export async function issuePassportTransfer(args: {
  customerId: string;
  recipientType: RecipientType;
  label: string;
  validDays: number;
  customerConsent: boolean;
  projections: Omit<PassportProjections, 'model'> | null;
}): Promise<IssuedTransfer> {
  const { data, error } = await supabase.rpc('issue_home_passport_transfer', {
    p_customer_id: args.customerId,
    p_recipient_type: args.recipientType,
    p_label: args.label.trim() || null,
    p_valid_days: args.validDays,
    p_customer_consent: args.customerConsent,
    p_projections: args.projections,
  });
  if (error) throw error;
  return data as IssuedTransfer;
}

export async function revokePassportTransfer(transferId: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_home_passport_transfer', { p_transfer_id: transferId });
  if (error) throw error;
}

export async function fetchPublicHomePassport(token: string): Promise<PublicHomePassportResult> {
  const { data, error } = await supabase.rpc('verify_home_passport', { p_token: token });
  if (error) throw error;
  return data as PublicHomePassportResult;
}

// ------------------------------------------------------------------------ permits

const PERMIT_COLUMNS =
  'id, customer_id, job_id, permit_type, permit_number, jurisdiction, status, issued_on, expires_on, finalized_on, notes';

export async function listHomePermits(customerId: string): Promise<HomePermit[]> {
  const { data, error } = await supabase
    .from('home_permits')
    .select(PERMIT_COLUMNS)
    .eq('customer_id', customerId)
    .order('issued_on', { ascending: false, nullsFirst: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as HomePermit[];
}

export async function createHomePermit(customerId: string, input: PermitInput): Promise<void> {
  const { error } = await supabase.from('home_permits').insert({ customer_id: customerId, ...input });
  if (error) throw error;
}

export async function deleteHomePermit(id: string): Promise<void> {
  const { error } = await supabase.from('home_permits').delete().eq('id', id);
  if (error) throw error;
}
