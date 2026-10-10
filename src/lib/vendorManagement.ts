/**
 * Vendor Management — domain logic + data access.
 *
 * Sits on top of the Vendor & Procurement OS (src/lib/procurement.ts) and the
 * accounting / inventory / job-costing modules. It never re-implements RFQs,
 * POs, receiving or bills — it reads their data (via the SQL views created in
 * 20270420000000_vendor_management.sql) and adds the vendor-relationship layer
 * on top: tiers, contracts, compliance documents, incidents, scoring, alerts.
 *
 * Everything that scores / filters / analyses is a PURE function (no I/O, `now`
 * injectable) so it is fully unit-tested in vendorManagement.test.ts.
 */

import { supabase } from './supabase';
import { listInventoryVendors } from './inventory';
import type { InventoryVendor } from './inventory';
import type { PurchaseOrder } from './procurement';
import type { CsvColumn } from './csvExport';

// ============================================================
// TYPES
// ============================================================

export type VendorTier = 'strategic' | 'preferred' | 'approved' | 'probation' | 'blocked';
export type RiskLevel = 'low' | 'moderate' | 'high' | 'critical';
export type VendorContractType =
  | 'master_supply'
  | 'pricing_agreement'
  | 'service'
  | 'rebate'
  | 'nda'
  | 'other';
export type VendorContractStatus = 'draft' | 'active' | 'expired' | 'terminated';
export type VendorDocType =
  | 'w9'
  | 'coi'
  | 'license'
  | 'tax_certificate'
  | 'nda'
  | 'safety_program'
  | 'background_check'
  | 'other';
export type VendorDocStatus = 'pending' | 'verified' | 'rejected';
export type VendorIncidentType =
  | 'late_delivery'
  | 'quality'
  | 'wrong_item'
  | 'damaged'
  | 'billing_dispute'
  | 'communication'
  | 'compliance'
  | 'safety'
  | 'other';
export type VendorIncidentSeverity = 1 | 2 | 3;
export type VendorIncidentStatus = 'open' | 'resolved';
export type VendorDetailTab =
  | 'overview'
  | 'performance'
  | 'orders'
  | 'pricing'
  | 'contracts'
  | 'compliance'
  | 'incidents';
export type AlertSeverity = 'critical' | 'warning' | 'info';

/** One row of the `vendor_management_overview` view (all numbers already coerced). */
export interface VendorOverviewRow {
  vendor_id: string;
  user_id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  category: string | null;
  payment_terms: string | null;
  notes: string | null;
  active: boolean;
  tier: VendorTier;
  website: string | null;
  inventory_vendor_id: string | null;
  review_cadence_days: number;
  last_reviewed_at: string | null;
  required_documents: string[];
  created_at: string;
  po_count: number;
  po_spend_cents: number;
  po_spend_12m_cents: number;
  open_po_count: number;
  open_po_cents: number;
  late_open_po_count: number;
  last_order_at: string | null;
  delivery_measured_count: number;
  delivery_on_time_count: number;
  receipt_line_count: number;
  receipt_issue_line_count: number;
  ap_open_cents: number;
  ap_overdue_cents: number;
  ap_overdue_count: number;
  job_bills_unpaid_cents: number;
  job_bills_overdue_cents: number;
  eval_count: number;
  avg_quality_score: number | null;
  avg_price_score: number | null;
  avg_communication_score: number | null;
  avg_overall_score: number | null;
  eval_on_time_rate: number | null;
  open_incident_count: number;
  critical_incident_count: number;
  incident_count_12m: number;
  incident_cost_12m_cents: number;
  doc_count: number;
  expired_doc_count: number;
  expiring_doc_count: number;
  pending_doc_count: number;
  missing_required_doc_count: number;
  active_contract_count: number;
  expiring_contract_count: number;
  lapsed_contract_count: number;
  next_contract_end: string | null;
}

export interface VendorContract {
  id: string;
  vendor_id: string;
  title: string;
  contract_type: VendorContractType;
  status: VendorContractStatus;
  start_date: string | null;
  end_date: string | null;
  auto_renew: boolean;
  renewal_notice_days: number;
  value_cents: number | null;
  discount_percent: number | null;
  payment_terms: string | null;
  document_url: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type VendorContractInput = Omit<
  VendorContract,
  'id' | 'vendor_id' | 'created_at' | 'updated_at'
>;

export interface VendorDocument {
  id: string;
  vendor_id: string;
  doc_type: VendorDocType;
  title: string | null;
  status: VendorDocStatus;
  issued_on: string | null;
  expires_on: string | null;
  document_url: string | null;
  verified_at: string | null;
  verified_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type VendorDocumentInput = Pick<
  VendorDocument,
  'doc_type' | 'title' | 'issued_on' | 'expires_on' | 'document_url' | 'notes'
>;

export interface VendorIncident {
  id: string;
  vendor_id: string;
  po_id: string | null;
  incident_type: VendorIncidentType;
  severity: VendorIncidentSeverity;
  status: VendorIncidentStatus;
  summary: string;
  cost_impact_cents: number;
  occurred_on: string;
  resolved_at: string | null;
  resolution_notes: string | null;
  created_at: string;
  updated_at: string;
}

export type VendorIncidentInput = Pick<
  VendorIncident,
  'incident_type' | 'severity' | 'summary' | 'cost_impact_cents' | 'occurred_on' | 'po_id'
>;

export interface VendorPriceRow {
  po_item_id: string;
  vendor_id: string;
  po_id: string;
  po_number: string | null;
  part_id: string | null;
  description: string;
  unit_price_cents: number;
  quantity_ordered: number;
  ordered_at: string;
}

export interface VendorCatalogRow {
  vendor_id: string;
  catalog_entry_id: string;
  part_id: string;
  part_number: string | null;
  part_name: string;
  vendor_sku: string | null;
  unit_cost_cents: number;
  lead_time_days: number | null;
  is_preferred: boolean;
  best_catalog_cost_cents: number | null;
}

export interface VendorApBillRow {
  id: string;
  bill_number: string;
  status: 'draft' | 'approved' | 'partially_paid' | 'paid' | 'void';
  bill_date: string;
  due_date: string;
  total_cents: number;
  amount_paid_cents: number;
}

export interface VendorJobBillRow {
  id: string;
  job_id: string;
  bill_number: string | null;
  status: 'unpaid' | 'paid' | 'overdue';
  amount_cents: number;
  bill_date: string;
  due_date: string | null;
}

export interface NewVendorInput {
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  category: string | null;
  payment_terms: string | null;
  website: string | null;
  tier: VendorTier;
  notes: string | null;
  required_documents?: string[];
}

export type VendorProfilePatch = Partial<
  Pick<
    NewVendorInput,
    | 'name'
    | 'contact_name'
    | 'email'
    | 'phone'
    | 'address'
    | 'category'
    | 'payment_terms'
    | 'website'
    | 'notes'
  > & { review_cadence_days: number; required_documents: string[] }
>;

// ============================================================
// LABELS / OPTIONS
// ============================================================

export const TIER_LABELS: Record<VendorTier, string> = {
  strategic: 'Strategic',
  preferred: 'Preferred',
  approved: 'Approved',
  probation: 'Probation',
  blocked: 'Blocked',
};
export const TIER_OPTIONS: VendorTier[] = ['strategic', 'preferred', 'approved', 'probation', 'blocked'];

export const TIER_CLASS: Record<VendorTier, string> = {
  strategic: 'bg-accent/10 text-accent',
  preferred: 'bg-success-500/10 text-success-500',
  approved: 'bg-bg-tertiary text-text-secondary',
  probation: 'bg-warning-500/10 text-warning-500',
  blocked: 'bg-danger/10 text-danger',
};

export const RISK_LABELS: Record<RiskLevel, string> = {
  low: 'Low risk',
  moderate: 'Moderate',
  high: 'High risk',
  critical: 'Critical',
};
export const RISK_CLASS: Record<RiskLevel, string> = {
  low: 'bg-success-500/10 text-success-500',
  moderate: 'bg-bg-tertiary text-text-secondary',
  high: 'bg-warning-500/10 text-warning-500',
  critical: 'bg-danger/10 text-danger',
};

export const CONTRACT_TYPE_LABELS: Record<VendorContractType, string> = {
  master_supply: 'Master supply agreement',
  pricing_agreement: 'Pricing agreement',
  service: 'Service agreement',
  rebate: 'Rebate / volume program',
  nda: 'NDA',
  other: 'Other',
};
export const CONTRACT_TYPE_OPTIONS = Object.keys(CONTRACT_TYPE_LABELS) as VendorContractType[];
export const CONTRACT_STATUS_OPTIONS: VendorContractStatus[] = ['draft', 'active', 'expired', 'terminated'];

export const DOC_TYPE_LABELS: Record<VendorDocType, string> = {
  w9: 'W-9',
  coi: 'Certificate of insurance',
  license: 'Business / trade license',
  tax_certificate: 'Tax certificate',
  nda: 'NDA',
  safety_program: 'Safety program',
  background_check: 'Background check',
  other: 'Other',
};
export const DOC_TYPE_OPTIONS = Object.keys(DOC_TYPE_LABELS) as VendorDocType[];

export const INCIDENT_TYPE_LABELS: Record<VendorIncidentType, string> = {
  late_delivery: 'Late delivery',
  quality: 'Quality problem',
  wrong_item: 'Wrong item',
  damaged: 'Damaged goods',
  billing_dispute: 'Billing dispute',
  communication: 'Communication',
  compliance: 'Compliance',
  safety: 'Safety',
  other: 'Other',
};
export const INCIDENT_TYPE_OPTIONS = Object.keys(INCIDENT_TYPE_LABELS) as VendorIncidentType[];
export const SEVERITY_LABELS: Record<VendorIncidentSeverity, string> = {
  1: 'Minor',
  2: 'Major',
  3: 'Critical',
};

export const DETAIL_TABS: { key: VendorDetailTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'performance', label: 'Performance' },
  { key: 'orders', label: 'Orders & bills' },
  { key: 'pricing', label: 'Pricing & catalog' },
  { key: 'contracts', label: 'Contracts' },
  { key: 'compliance', label: 'Compliance' },
  { key: 'incidents', label: 'Incidents' },
];

export function isDetailTab(value: string | null): value is VendorDetailTab {
  return DETAIL_TABS.some((t) => t.key === value);
}

// ============================================================
// SMALL HELPERS
// ============================================================

const DAY_MS = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Parses a `YYYY-MM-DD` (or ISO) string as a LOCAL calendar day. Null when invalid. */
function parseDay(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : startOfDay(new Date(t));
}

/** Whole days from today until `value` (negative = in the past). Null when no/invalid date. */
export function daysUntil(value: string | null | undefined, now: Date = new Date()): number | null {
  const day = parseDay(value);
  if (day === null) return null;
  return Math.round((day - startOfDay(now)) / DAY_MS);
}

function shrink(successes: number, trials: number, priorRate: number, priorWeight: number): number {
  return (successes + priorRate * priorWeight) / (trials + priorWeight);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function formatPct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function isHttpUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** "acme.com" -> "https://acme.com"; empty -> null. Does not validate (see isHttpUrl). */
export function normalizeUrl(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
}

/** "1,234.50" -> 123450, "" -> null, anything else invalid -> NaN. */
export function parseMoneyToCents(value: string): number | null {
  const v = value.trim().replace(/[$,\s]/g, '');
  if (v === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return Number.NaN;
  return Math.round(Number(v) * 100);
}

export function centsToInput(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2);
}

/** Formats a `YYYY-MM-DD` / ISO string as a local calendar date (no UTC day-shift). */
export function formatDay(value: string | null | undefined): string {
  const day = parseDay(value);
  return day === null ? '—' : new Date(day).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ============================================================
// PERFORMANCE
// ============================================================

export interface PerformanceComponent {
  key: 'delivery' | 'quality' | 'evaluations';
  label: string;
  /** 0-100, already smoothed for small samples. */
  value: number;
  weight: number;
  sample: number;
}

export interface VendorPerformance {
  /** 0-100, null when there is no delivery / receiving / evaluation data yet. */
  score: number | null;
  grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  /** Raw (unsmoothed) on-time delivery rate, 0-1. */
  onTimeRate: number | null;
  /** Raw share of received lines that were damaged or short, 0-1. */
  issueRate: number | null;
  components: PerformanceComponent[];
  /** Total measured events behind the score. */
  sample: number;
}

export function gradeFor(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * Weighted blend of on-time delivery (40), receiving quality (30) and team
 * evaluations (30). Components without data are left out and the remaining
 * weights re-normalised. Small samples are shrunk toward a sensible prior so
 * 1-of-1 on-time doesn't read as a perfect 100.
 */
export function computeVendorPerformance(row: VendorOverviewRow): VendorPerformance {
  const components: PerformanceComponent[] = [];

  const onTimeRate =
    row.delivery_measured_count > 0 ? row.delivery_on_time_count / row.delivery_measured_count : null;
  if (row.delivery_measured_count > 0) {
    const v = shrink(row.delivery_on_time_count, row.delivery_measured_count, 0.85, 2);
    components.push({
      key: 'delivery',
      label: 'On-time delivery',
      value: Math.round(v * 100),
      weight: 40,
      sample: row.delivery_measured_count,
    });
  }

  const issueRate =
    row.receipt_line_count > 0 ? row.receipt_issue_line_count / row.receipt_line_count : null;
  if (row.receipt_line_count > 0) {
    const issue = shrink(row.receipt_issue_line_count, row.receipt_line_count, 0.05, 3);
    components.push({
      key: 'quality',
      label: 'Receiving quality',
      value: Math.round((1 - issue) * 100),
      weight: 30,
      sample: row.receipt_line_count,
    });
  }

  if (row.eval_count > 0 && row.avg_overall_score !== null) {
    const avg = clamp(row.avg_overall_score, 1, 5);
    components.push({
      key: 'evaluations',
      label: 'Team evaluations',
      value: Math.round(((avg - 1) / 4) * 100),
      weight: 30,
      sample: row.eval_count,
    });
  }

  if (components.length === 0) {
    return { score: null, grade: null, onTimeRate, issueRate, components, sample: 0 };
  }

  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const score = Math.round(components.reduce((s, c) => s + c.value * c.weight, 0) / totalWeight);
  return {
    score,
    grade: gradeFor(score),
    onTimeRate,
    issueRate,
    components,
    sample: components.reduce((s, c) => s + c.sample, 0),
  };
}

// ============================================================
// RISK
// ============================================================

export interface RiskFactor {
  key: string;
  label: string;
  points: number;
  detail: string;
}

export interface VendorRisk {
  /** 0-100, higher = riskier. */
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
}

export function riskLevelFor(score: number): RiskLevel {
  if (score >= 65) return 'critical';
  if (score >= 40) return 'high';
  if (score >= 20) return 'moderate';
  return 'low';
}

export const CONCENTRATION_THRESHOLD = 0.4;
export const OVERDUE_CRITICAL_CENTS = 500_000;

/** Days until the next review is due (negative = overdue). */
export function reviewDaysLeft(row: VendorOverviewRow, now: Date = new Date()): number {
  const base = row.last_reviewed_at ?? row.created_at;
  const baseDay = parseDay(base) ?? startOfDay(now);
  const due = baseDay + row.review_cadence_days * DAY_MS;
  return Math.round((due - startOfDay(now)) / DAY_MS);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function computeVendorRisk(
  row: VendorOverviewRow,
  performance: VendorPerformance,
  ctx: { spendShare: number; reviewDaysLeft: number },
): VendorRisk {
  const factors: RiskFactor[] = [];
  const add = (key: string, label: string, points: number, detail: string) => {
    if (points > 0) factors.push({ key, label, points, detail });
  };

  add(
    'missing_docs',
    'Missing compliance documents',
    Math.min(30, 15 * row.missing_required_doc_count),
    `${plural(row.missing_required_doc_count, 'required document')} missing or expired`,
  );
  add(
    'expiring_docs',
    'Documents expiring soon',
    Math.min(8, 4 * row.expiring_doc_count),
    `${plural(row.expiring_doc_count, 'document')} expire within 30 days`,
  );
  add(
    'contracts',
    'Contract coverage',
    Math.min(10, 10 * row.lapsed_contract_count + 5 * row.expiring_contract_count),
    row.lapsed_contract_count > 0
      ? `${plural(row.lapsed_contract_count, 'contract')} past end date`
      : `${plural(row.expiring_contract_count, 'contract')} inside the renewal window`,
  );
  add(
    'late_deliveries',
    'Late open orders',
    Math.min(15, 5 * row.late_open_po_count),
    `${plural(row.late_open_po_count, 'open PO')} past the expected delivery date`,
  );
  if (row.delivery_measured_count >= 3 && row.delivery_on_time_count / row.delivery_measured_count < 0.7) {
    add(
      'on_time_rate',
      'Poor on-time history',
      10,
      `${formatPct(row.delivery_on_time_count / row.delivery_measured_count)} on-time over ${row.delivery_measured_count} deliveries`,
    );
  }
  if (row.receipt_line_count >= 5 && row.receipt_issue_line_count / row.receipt_line_count >= 0.15) {
    add(
      'receiving_issues',
      'Frequent receiving problems',
      10,
      `${formatPct(row.receipt_issue_line_count / row.receipt_line_count)} of received lines damaged or short`,
    );
  }
  add(
    'critical_incidents',
    'Open critical incidents',
    Math.min(30, 15 * row.critical_incident_count),
    `${plural(row.critical_incident_count, 'critical incident')} still open`,
  );
  const otherOpen = Math.max(0, row.open_incident_count - row.critical_incident_count);
  add(
    'open_incidents',
    'Open incidents',
    Math.min(10, 3 * otherOpen),
    `${plural(otherOpen, 'open incident')}`,
  );
  add(
    'concentration',
    'Spend concentration',
    row.po_spend_12m_cents > 0 && ctx.spendShare >= CONCENTRATION_THRESHOLD ? 10 : 0,
    `${formatPct(ctx.spendShare)} of 12-month purchasing spend`,
  );
  add(
    'low_performance',
    'Low performance score',
    performance.score !== null && performance.sample >= 3 && performance.score < 60 ? 10 : 0,
    `Performance score ${performance.score ?? '—'}/100`,
  );
  add(
    'overdue_payables',
    'Overdue payables to this vendor',
    row.ap_overdue_cents + row.job_bills_overdue_cents > 0 ? 5 : 0,
    'We owe overdue amounts — supply and pricing goodwill at risk',
  );
  add(
    'review_overdue',
    'Review overdue',
    ctx.reviewDaysLeft < 0 ? 5 : 0,
    `Periodic review ${Math.abs(ctx.reviewDaysLeft)} days overdue`,
  );
  add('tier', 'On probation', row.tier === 'probation' ? 10 : 0, 'Vendor is on probation');

  factors.sort((a, b) => b.points - a.points);
  const score = Math.min(100, factors.reduce((s, f) => s + f.points, 0));
  return { score, level: riskLevelFor(score), factors };
}

// ============================================================
// PORTFOLIO ANALYSIS (insights + alerts)
// ============================================================

export interface VendorInsight {
  row: VendorOverviewRow;
  performance: VendorPerformance;
  risk: VendorRisk;
  /** Share (0-1) of total 12-month PO spend across all vendors. */
  spendShare: number;
  reviewDaysLeft: number;
  openPayablesCents: number;
  overduePayablesCents: number;
  alertCount: number;
}

export interface VendorAlert {
  id: string;
  vendorId: string;
  vendorName: string;
  severity: AlertSeverity;
  kind:
    | 'overdue_payables'
    | 'late_deliveries'
    | 'compliance_gap'
    | 'documents_expiring'
    | 'contract_lapsed'
    | 'contract_expiring'
    | 'critical_incident'
    | 'review_overdue'
    | 'concentration'
    | 'low_performance'
    | 'price_increase';
  title: string;
  detail: string;
  tab: VendorDetailTab;
  amountCents: number;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function buildVendorAlerts(
  insights: VendorInsight[],
  priceInsights: PriceInsight[] = [],
  now: Date = new Date(),
): VendorAlert[] {
  const alerts: VendorAlert[] = [];
  const priceUps = new Map<string, PriceInsight[]>();
  for (const p of priceInsights) {
    if (p.trend === 'up' && p.changePct !== null && p.changePct >= 0.1) {
      priceUps.set(p.vendorId, [...(priceUps.get(p.vendorId) ?? []), p]);
    }
  }

  for (const i of insights) {
    const r = i.row;
    const push = (
      kind: VendorAlert['kind'],
      severity: AlertSeverity,
      title: string,
      detail: string,
      tab: VendorDetailTab,
      amountCents = 0,
    ) =>
      alerts.push({
        id: `${kind}:${r.vendor_id}`,
        vendorId: r.vendor_id,
        vendorName: r.name,
        severity,
        kind,
        title,
        detail,
        tab,
        amountCents,
      });

    // Money we owe is relevant even for blocked / inactive vendors.
    const overdue = r.ap_overdue_cents + r.job_bills_overdue_cents;
    if (overdue > 0) {
      push(
        'overdue_payables',
        overdue >= OVERDUE_CRITICAL_CENTS || r.ap_overdue_count >= 3 ? 'critical' : 'warning',
        'Overdue payables',
        `${(overdue / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} past due`,
        'orders',
        overdue,
      );
    }

    if (r.tier === 'blocked' || !r.active) continue;

    if (r.late_open_po_count > 0) {
      push(
        'late_deliveries',
        r.late_open_po_count >= 3 ? 'critical' : 'warning',
        'Late deliveries',
        `${plural(r.late_open_po_count, 'open PO')} past the expected delivery date`,
        'orders',
      );
    }
    if (r.missing_required_doc_count > 0) {
      push(
        'compliance_gap',
        r.open_po_count > 0 ? 'critical' : 'warning',
        'Compliance documents missing',
        `${plural(r.missing_required_doc_count, 'required document')} missing or expired${
          r.open_po_count > 0 ? ' while orders are open' : ''
        }`,
        'compliance',
      );
    }
    if (r.expiring_doc_count > 0) {
      push(
        'documents_expiring',
        'warning',
        'Documents expiring',
        `${plural(r.expiring_doc_count, 'document')} expire within 30 days`,
        'compliance',
      );
    }
    if (r.lapsed_contract_count > 0) {
      push(
        'contract_lapsed',
        'warning',
        'Contract past end date',
        `${plural(r.lapsed_contract_count, 'contract')} still marked active after the end date`,
        'contracts',
      );
    }
    if (r.expiring_contract_count > 0) {
      const left = daysUntil(r.next_contract_end, now);
      push(
        'contract_expiring',
        'warning',
        'Contract renewal window',
        left === null
          ? `${plural(r.expiring_contract_count, 'contract')} inside the renewal window`
          : `Next contract ends in ${left} day${left === 1 ? '' : 's'}`,
        'contracts',
      );
    }
    if (r.critical_incident_count > 0) {
      push(
        'critical_incident',
        'critical',
        'Critical incident open',
        `${plural(r.critical_incident_count, 'critical incident')} awaiting resolution`,
        'incidents',
      );
    }
    if (i.performance.score !== null && i.performance.sample >= 3 && i.performance.score < 60) {
      push(
        'low_performance',
        'warning',
        'Low performance',
        `Score ${i.performance.score}/100 (${i.performance.grade}) over ${i.performance.sample} measured events`,
        'performance',
      );
    }
    if (r.po_spend_12m_cents > 0 && i.spendShare >= CONCENTRATION_THRESHOLD && insights.length > 1) {
      push(
        'concentration',
        'warning',
        'Spend concentration',
        `${formatPct(i.spendShare)} of 12-month spend — single-source dependency`,
        'pricing',
        r.po_spend_12m_cents,
      );
    }
    const ups = priceUps.get(r.vendor_id);
    if (ups && ups.length > 0) {
      const worst = ups.reduce((a, b) => ((b.changePct ?? 0) > (a.changePct ?? 0) ? b : a));
      push(
        'price_increase',
        'warning',
        'Price increases',
        `${plural(ups.length, 'item')} up 10%+ since the previous order (largest: ${formatPct(worst.changePct)} on ${worst.description})`,
        'pricing',
      );
    }
    if (i.reviewDaysLeft < 0 && (r.po_count > 0 || r.tier === 'strategic' || r.tier === 'preferred')) {
      push(
        'review_overdue',
        'info',
        'Vendor review due',
        `Periodic review is ${Math.abs(i.reviewDaysLeft)} days overdue`,
        'overview',
      );
    }
  }

  return alerts.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.amountCents - a.amountCents ||
      a.vendorName.localeCompare(b.vendorName),
  );
}

export interface VendorPortfolio {
  insights: VendorInsight[];
  alerts: VendorAlert[];
}

/** Scores every vendor, then derives portfolio-level alerts and per-vendor alert counts. */
export function analyzeVendorPortfolio(
  rows: VendorOverviewRow[],
  priceInsights: PriceInsight[] = [],
  now: Date = new Date(),
): VendorPortfolio {
  const totalSpend = rows.reduce((s, r) => s + r.po_spend_12m_cents, 0);
  const base: VendorInsight[] = rows.map((row) => {
    const performance = computeVendorPerformance(row);
    const spendShare = totalSpend > 0 ? row.po_spend_12m_cents / totalSpend : 0;
    const daysLeft = reviewDaysLeft(row, now);
    return {
      row,
      performance,
      spendShare,
      reviewDaysLeft: daysLeft,
      risk: computeVendorRisk(row, performance, { spendShare, reviewDaysLeft: daysLeft }),
      openPayablesCents: row.ap_open_cents + row.job_bills_unpaid_cents,
      overduePayablesCents: row.ap_overdue_cents + row.job_bills_overdue_cents,
      alertCount: 0,
    };
  });
  const alerts = buildVendorAlerts(base, priceInsights, now);
  const counts = new Map<string, number>();
  for (const a of alerts) counts.set(a.vendorId, (counts.get(a.vendorId) ?? 0) + 1);
  return {
    insights: base.map((i) => ({ ...i, alertCount: counts.get(i.row.vendor_id) ?? 0 })),
    alerts,
  };
}

export interface PortfolioSummary {
  totalVendors: number;
  activeVendors: number;
  spend12mCents: number;
  openPoCents: number;
  openPayablesCents: number;
  overduePayablesCents: number;
  avgPerformance: number | null;
  highRiskCount: number;
  complianceGapCount: number;
  contractsExpiringCount: number;
}

export function summarizePortfolio(insights: VendorInsight[]): PortfolioSummary {
  const active = insights.filter((i) => i.row.active && i.row.tier !== 'blocked');
  const scored = active.filter((i) => i.performance.score !== null);
  return {
    totalVendors: insights.length,
    activeVendors: active.length,
    spend12mCents: insights.reduce((s, i) => s + i.row.po_spend_12m_cents, 0),
    openPoCents: insights.reduce((s, i) => s + i.row.open_po_cents, 0),
    openPayablesCents: insights.reduce((s, i) => s + i.openPayablesCents, 0),
    overduePayablesCents: insights.reduce((s, i) => s + i.overduePayablesCents, 0),
    avgPerformance:
      scored.length > 0
        ? Math.round(scored.reduce((s, i) => s + (i.performance.score ?? 0), 0) / scored.length)
        : null,
    highRiskCount: active.filter((i) => i.risk.level === 'high' || i.risk.level === 'critical').length,
    complianceGapCount: active.filter((i) => i.row.missing_required_doc_count > 0).length,
    contractsExpiringCount: active.reduce((s, i) => s + i.row.expiring_contract_count + i.row.lapsed_contract_count, 0),
  };
}

// ============================================================
// SEARCH / FILTER / SORT
// ============================================================

export interface VendorFilters {
  query: string;
  tier: VendorTier | 'all';
  status: 'all' | 'active' | 'inactive';
  category: string;
  risk: RiskLevel | 'all';
  attention: boolean;
}

export const DEFAULT_VENDOR_FILTERS: VendorFilters = {
  query: '',
  tier: 'all',
  status: 'all',
  category: 'all',
  risk: 'all',
  attention: false,
};

export type VendorSortKey = 'name' | 'spend' | 'risk' | 'performance' | 'payables' | 'recent';
export interface VendorSort {
  key: VendorSortKey;
  dir: 'asc' | 'desc';
}

export function vendorCategories(rows: VendorOverviewRow[]): string[] {
  return [...new Set(rows.map((r) => r.category?.trim()).filter((c): c is string => !!c))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function matchesQuery(r: VendorOverviewRow, q: string): boolean {
  if (!q) return true;
  const hay = [r.name, r.contact_name, r.email, r.phone, r.category, r.website, r.address]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

export function filterAndSortVendors(
  insights: VendorInsight[],
  filters: VendorFilters,
  sort: VendorSort,
): VendorInsight[] {
  const out = insights.filter((i) => {
    const r = i.row;
    if (!matchesQuery(r, filters.query.trim())) return false;
    if (filters.tier !== 'all' && r.tier !== filters.tier) return false;
    if (filters.status === 'active' && !r.active) return false;
    if (filters.status === 'inactive' && r.active) return false;
    if (filters.category !== 'all' && (r.category ?? '').trim() !== filters.category) return false;
    if (filters.risk !== 'all' && i.risk.level !== filters.risk) return false;
    if (filters.attention && i.alertCount === 0) return false;
    return true;
  });

  const dir = sort.dir === 'asc' ? 1 : -1;
  const value = (i: VendorInsight): number | string | null => {
    switch (sort.key) {
      case 'name':
        return i.row.name.toLowerCase();
      case 'spend':
        return i.row.po_spend_12m_cents;
      case 'risk':
        return i.risk.score;
      case 'performance':
        return i.performance.score;
      case 'payables':
        return i.openPayablesCents;
      case 'recent':
        return i.row.last_order_at ? new Date(i.row.last_order_at).getTime() : null;
    }
  };
  return out.sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return a.row.name.localeCompare(b.row.name);
    if (va === null) return 1; // nulls always last, regardless of direction
    if (vb === null) return -1;
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return a.row.name.localeCompare(b.row.name);
  });
}

// ============================================================
// PRICING INTELLIGENCE
// ============================================================

export interface PriceInsight {
  key: string;
  description: string;
  vendorId: string;
  latestCents: number;
  previousCents: number | null;
  /** (latest - previous) / previous, null when there is no previous order. */
  changePct: number | null;
  trend: 'up' | 'down' | 'flat' | 'new';
  lastOrderedAt: string;
  orderCount: number;
  latestQuantity: number;
  bestVendorId: string | null;
  bestPriceCents: number | null;
  /** How much more this vendor charges than the cheapest recent vendor, null if not applicable. */
  premiumPct: number | null;
  /** (latest - best) * latest quantity, 0 when not the premium vendor. */
  potentialSavingsCents: number;
}

function priceKey(row: VendorPriceRow): string {
  return row.part_id ?? `desc:${row.description.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export function analyzePricing(
  history: VendorPriceRow[],
  opts: { changeThresholdPct?: number; windowMonths?: number; now?: Date } = {},
): PriceInsight[] {
  const threshold = opts.changeThresholdPct ?? 0.05;
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getFullYear(), now.getMonth() - (opts.windowMonths ?? 12), now.getDate()).getTime();

  const valid = history
    .filter((h) => h.unit_price_cents > 0 && !Number.isNaN(new Date(h.ordered_at).getTime()))
    .sort((a, b) => new Date(a.ordered_at).getTime() - new Date(b.ordered_at).getTime());

  const byKeyVendor = new Map<string, Map<string, VendorPriceRow[]>>();
  for (const h of valid) {
    const k = priceKey(h);
    const vendors = byKeyVendor.get(k) ?? new Map<string, VendorPriceRow[]>();
    vendors.set(h.vendor_id, [...(vendors.get(h.vendor_id) ?? []), h]);
    byKeyVendor.set(k, vendors);
  }

  const out: PriceInsight[] = [];
  for (const [key, vendors] of byKeyVendor) {
    // Cheapest *recent* latest price across vendors — the benchmark.
    let bestVendorId: string | null = null;
    let bestPrice: number | null = null;
    let recentVendorCount = 0;
    for (const [vendorId, rows] of vendors) {
      const last = rows[rows.length - 1];
      if (new Date(last.ordered_at).getTime() < windowStart) continue;
      recentVendorCount += 1;
      if (bestPrice === null || last.unit_price_cents < bestPrice) {
        bestPrice = last.unit_price_cents;
        bestVendorId = vendorId;
      }
    }

    for (const [vendorId, rows] of vendors) {
      const last = rows[rows.length - 1];
      const prev = rows.length > 1 ? rows[rows.length - 2] : null;
      const changePct = prev ? (last.unit_price_cents - prev.unit_price_cents) / prev.unit_price_cents : null;
      const trend: PriceInsight['trend'] =
        changePct === null ? 'new' : Math.abs(changePct) < threshold ? 'flat' : changePct > 0 ? 'up' : 'down';
      const isRecent = new Date(last.ordered_at).getTime() >= windowStart;
      const premium =
        isRecent && recentVendorCount > 1 && bestPrice !== null && last.unit_price_cents > bestPrice
          ? (last.unit_price_cents - bestPrice) / bestPrice
          : null;
      const hasPremium = premium !== null && premium >= threshold;
      out.push({
        key,
        description: last.description,
        vendorId,
        latestCents: last.unit_price_cents,
        previousCents: prev?.unit_price_cents ?? null,
        changePct,
        trend,
        lastOrderedAt: last.ordered_at,
        orderCount: rows.length,
        latestQuantity: last.quantity_ordered,
        bestVendorId: hasPremium ? bestVendorId : null,
        bestPriceCents: hasPremium ? bestPrice : null,
        premiumPct: hasPremium ? premium : null,
        potentialSavingsCents:
          hasPremium && bestPrice !== null
            ? Math.round((last.unit_price_cents - bestPrice) * last.quantity_ordered)
            : 0,
      });
    }
  }

  return out.sort(
    (a, b) =>
      Math.abs(b.changePct ?? 0) + (b.premiumPct ?? 0) - (Math.abs(a.changePct ?? 0) + (a.premiumPct ?? 0)),
  );
}

// ============================================================
// COMPLIANCE + CONTRACT HELPERS
// ============================================================

export type RequiredDocState = 'ok' | 'pending' | 'expired' | 'missing';
export interface RequiredDocStatus {
  type: string;
  state: RequiredDocState;
  document: VendorDocument | null;
}

/** Mirrors the SQL rule behind `missing_required_doc_count` (a valid doc = not rejected and not expired). */
export function evaluateRequiredDocuments(
  required: string[],
  docs: VendorDocument[],
  now: Date = new Date(),
): RequiredDocStatus[] {
  return required.map((type) => {
    const ofType = docs.filter((d) => d.doc_type === type && d.status !== 'rejected');
    const valid = ofType.filter((d) => {
      const left = daysUntil(d.expires_on, now);
      return left === null || left >= 0;
    });
    const verified = valid.find((d) => d.status === 'verified');
    if (verified) return { type, state: 'ok', document: verified };
    if (valid.length > 0) return { type, state: 'pending', document: valid[0] };
    if (ofType.length > 0) return { type, state: 'expired', document: ofType[0] };
    return { type, state: 'missing', document: null };
  });
}

export type DocumentState = 'expired' | 'expiring' | 'valid' | 'no_expiry' | 'rejected';
export function documentState(doc: VendorDocument, now: Date = new Date()): DocumentState {
  if (doc.status === 'rejected') return 'rejected';
  const left = daysUntil(doc.expires_on, now);
  if (left === null) return 'no_expiry';
  if (left < 0) return 'expired';
  return left <= 30 ? 'expiring' : 'valid';
}

export type ContractState = 'draft' | 'active' | 'expiring' | 'lapsed' | 'expired' | 'terminated';
export function contractState(c: VendorContract, now: Date = new Date()): ContractState {
  if (c.status !== 'active') return c.status;
  const left = daysUntil(c.end_date, now);
  if (left === null) return 'active';
  if (left < 0) return 'lapsed';
  return left <= c.renewal_notice_days ? 'expiring' : 'active';
}

// ============================================================
// VALIDATION (pure — each returns an error message or null)
// ============================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateVendorInput(input: Pick<NewVendorInput, 'name' | 'email' | 'website'>): string | null {
  if (!input.name.trim()) return 'Enter the vendor name.';
  if (input.name.trim().length > 120) return 'Vendor name is too long (120 characters max).';
  if (input.email && !EMAIL_RE.test(input.email.trim())) return 'Enter a valid email address.';
  const url = normalizeUrl(input.website);
  if (url && !isHttpUrl(url)) return 'Enter a valid website address.';
  return null;
}

export function validateContractInput(input: VendorContractInput): string | null {
  if (!input.title.trim()) return 'Enter a contract title.';
  if (input.start_date && input.end_date && input.end_date < input.start_date)
    return 'The end date cannot be before the start date.';
  if (input.value_cents !== null && (!Number.isFinite(input.value_cents) || input.value_cents < 0))
    return 'Contract value cannot be negative.';
  if (
    input.discount_percent !== null &&
    (!Number.isFinite(input.discount_percent) || input.discount_percent < 0 || input.discount_percent > 100)
  )
    return 'Discount must be between 0 and 100%.';
  if (!Number.isInteger(input.renewal_notice_days) || input.renewal_notice_days < 0 || input.renewal_notice_days > 365)
    return 'Renewal notice must be between 0 and 365 days.';
  if (input.document_url && !isHttpUrl(input.document_url)) return 'The document link must start with http:// or https://.';
  return null;
}

export function validateDocumentInput(input: VendorDocumentInput): string | null {
  if (input.issued_on && input.expires_on && input.expires_on < input.issued_on)
    return 'The expiry date cannot be before the issue date.';
  if (input.document_url && !isHttpUrl(input.document_url)) return 'The document link must start with http:// or https://.';
  return null;
}

export function validateIncidentInput(input: VendorIncidentInput): string | null {
  if (input.summary.trim().length < 3) return 'Describe what happened (at least 3 characters).';
  if (!Number.isFinite(input.cost_impact_cents) || input.cost_impact_cents < 0)
    return 'Cost impact cannot be negative.';
  if (!input.occurred_on) return 'Enter the date it happened.';
  return null;
}

// ============================================================
// CSV EXPORT
// ============================================================

export const VENDOR_CSV_COLUMNS: CsvColumn<VendorInsight>[] = [
  { header: 'Vendor', accessor: (i) => i.row.name },
  { header: 'Category', accessor: (i) => i.row.category },
  { header: 'Tier', accessor: (i) => TIER_LABELS[i.row.tier] },
  { header: 'Active', accessor: (i) => (i.row.active ? 'Yes' : 'No') },
  { header: 'Contact', accessor: (i) => i.row.contact_name },
  { header: 'Email', accessor: (i) => i.row.email },
  { header: 'Phone', accessor: (i) => i.row.phone },
  { header: 'Payment terms', accessor: (i) => i.row.payment_terms },
  { header: 'Spend (12 mo, USD)', accessor: (i) => (i.row.po_spend_12m_cents / 100).toFixed(2) },
  { header: 'Open PO value (USD)', accessor: (i) => (i.row.open_po_cents / 100).toFixed(2) },
  { header: 'Open payables (USD)', accessor: (i) => (i.openPayablesCents / 100).toFixed(2) },
  { header: 'Overdue payables (USD)', accessor: (i) => (i.overduePayablesCents / 100).toFixed(2) },
  { header: 'Performance score', accessor: (i) => i.performance.score },
  { header: 'On-time rate', accessor: (i) => (i.performance.onTimeRate === null ? '' : formatPct(i.performance.onTimeRate)) },
  { header: 'Risk score', accessor: (i) => i.risk.score },
  { header: 'Risk level', accessor: (i) => RISK_LABELS[i.risk.level] },
  { header: 'Missing required documents', accessor: (i) => i.row.missing_required_doc_count },
  { header: 'Open incidents', accessor: (i) => i.row.open_incident_count },
  { header: 'Next contract end', accessor: (i) => i.row.next_contract_end },
  { header: 'Last reviewed', accessor: (i) => (i.row.last_reviewed_at ? i.row.last_reviewed_at.slice(0, 10) : '') },
];

// ============================================================
// DATA ACCESS
// ============================================================

const NUMERIC_KEYS = [
  'review_cadence_days',
  'po_count',
  'po_spend_cents',
  'po_spend_12m_cents',
  'open_po_count',
  'open_po_cents',
  'late_open_po_count',
  'delivery_measured_count',
  'delivery_on_time_count',
  'receipt_line_count',
  'receipt_issue_line_count',
  'ap_open_cents',
  'ap_overdue_cents',
  'ap_overdue_count',
  'job_bills_unpaid_cents',
  'job_bills_overdue_cents',
  'eval_count',
  'open_incident_count',
  'critical_incident_count',
  'incident_count_12m',
  'incident_cost_12m_cents',
  'doc_count',
  'expired_doc_count',
  'expiring_doc_count',
  'pending_doc_count',
  'missing_required_doc_count',
  'active_contract_count',
  'expiring_contract_count',
  'lapsed_contract_count',
] as const;

const NULLABLE_NUMERIC_KEYS = [
  'avg_quality_score',
  'avg_price_score',
  'avg_communication_score',
  'avg_overall_score',
  'eval_on_time_rate',
] as const;

/** PostgREST can return bigint/numeric as strings in some setups — coerce defensively. */
export function normalizeOverviewRow(raw: Record<string, unknown>): VendorOverviewRow {
  const row = { ...raw } as Record<string, unknown>;
  for (const k of NUMERIC_KEYS) {
    const n = Number(raw[k] ?? 0);
    row[k] = Number.isFinite(n) ? n : 0;
  }
  for (const k of NULLABLE_NUMERIC_KEYS) {
    const v = raw[k];
    const n = v === null || v === undefined ? null : Number(v);
    row[k] = n !== null && Number.isFinite(n) ? n : null;
  }
  row.required_documents = Array.isArray(raw.required_documents) ? raw.required_documents : [];
  row.tier = (raw.tier as VendorTier | undefined) ?? 'approved';
  return row as unknown as VendorOverviewRow;
}

export async function fetchVendorOverview(): Promise<VendorOverviewRow[]> {
  const { data, error } = await supabase
    .from('vendor_management_overview')
    .select('*')
    .order('name', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(normalizeOverviewRow);
}

/** Newest-first and capped: PostgREST returns at most ~1000 rows per request. */
export const PRICE_HISTORY_LIMIT = 1000;

export async function fetchPriceHistory(months = 24): Promise<VendorPriceRow[]> {
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  const { data, error } = await supabase
    .from('vendor_price_history')
    .select('*')
    .gte('ordered_at', since.toISOString())
    .order('ordered_at', { ascending: false })
    .limit(PRICE_HISTORY_LIMIT);
  if (error) throw error;
  return ((data ?? []) as VendorPriceRow[]).map((r) => ({
    ...r,
    unit_price_cents: Number(r.unit_price_cents),
    quantity_ordered: Number(r.quantity_ordered),
  }));
}

export async function fetchVendorCatalog(vendorId: string): Promise<VendorCatalogRow[]> {
  const { data, error } = await supabase
    .from('vendor_catalog_overview')
    .select('*')
    .eq('vendor_id', vendorId)
    .order('part_name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as VendorCatalogRow[];
}

export async function fetchVendorOrders(vendorId: string, limit = 25): Promise<PurchaseOrder[]> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*')
    .eq('vendor_id', vendorId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as PurchaseOrder[];
}

export async function fetchVendorApBills(vendorId: string, limit = 25): Promise<VendorApBillRow[]> {
  const { data, error } = await supabase
    .from('ap_bills')
    .select('id, bill_number, status, bill_date, due_date, total_cents, amount_paid_cents')
    .eq('vendor_id', vendorId)
    .order('bill_date', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as VendorApBillRow[];
}

/** Escapes LIKE wildcards so a vendor called "A_B 100%" matches literally (case-insensitive). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function fetchVendorJobBills(vendorName: string, limit = 25): Promise<VendorJobBillRow[]> {
  const { data, error } = await supabase
    .from('vendor_bills')
    .select('id, job_id, bill_number, status, amount_cents, bill_date, due_date')
    .ilike('vendor_name', escapeLike(vendorName.trim()))
    .order('bill_date', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as VendorJobBillRow[];
}

// ---------- contracts ----------

export async function fetchVendorContracts(vendorId: string): Promise<VendorContract[]> {
  const { data, error } = await supabase
    .from('vendor_contracts')
    .select('*')
    .eq('vendor_id', vendorId)
    .order('end_date', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as VendorContract[];
}

export async function saveVendorContract(
  vendorId: string,
  input: VendorContractInput,
  id?: string,
): Promise<void> {
  const err = validateContractInput(input);
  if (err) throw new Error(err);
  const payload = { ...input, title: input.title.trim() };
  const { error } = id
    ? await supabase.from('vendor_contracts').update(payload).eq('id', id)
    : await supabase.from('vendor_contracts').insert({ ...payload, vendor_id: vendorId });
  if (error) throw error;
}

export async function deleteVendorContract(id: string): Promise<void> {
  const { error } = await supabase.from('vendor_contracts').delete().eq('id', id);
  if (error) throw error;
}

// ---------- documents ----------

export async function fetchVendorDocuments(vendorId: string): Promise<VendorDocument[]> {
  const { data, error } = await supabase
    .from('vendor_documents')
    .select('*')
    .eq('vendor_id', vendorId)
    .order('doc_type', { ascending: true })
    .order('expires_on', { ascending: false, nullsFirst: true });
  if (error) throw error;
  return (data ?? []) as VendorDocument[];
}

export async function saveVendorDocument(
  vendorId: string,
  input: VendorDocumentInput,
  id?: string,
): Promise<void> {
  const err = validateDocumentInput(input);
  if (err) throw new Error(err);
  const { error } = id
    ? await supabase.from('vendor_documents').update(input).eq('id', id)
    : await supabase.from('vendor_documents').insert({ ...input, vendor_id: vendorId });
  if (error) throw error;
}

export async function setVendorDocumentStatus(
  id: string,
  status: VendorDocStatus,
  verifiedBy: string | null,
): Promise<void> {
  const patch =
    status === 'verified'
      ? { status, verified_at: new Date().toISOString(), verified_by: verifiedBy }
      : { status, verified_at: null, verified_by: null };
  const { error } = await supabase.from('vendor_documents').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteVendorDocument(id: string): Promise<void> {
  const { error } = await supabase.from('vendor_documents').delete().eq('id', id);
  if (error) throw error;
}

// ---------- incidents ----------

export async function fetchVendorIncidents(vendorId: string): Promise<VendorIncident[]> {
  const { data, error } = await supabase
    .from('vendor_incidents')
    .select('*')
    .eq('vendor_id', vendorId)
    .order('status', { ascending: true }) // 'open' sorts before 'resolved'
    .order('occurred_on', { ascending: false });
  if (error) throw error;
  return (data ?? []) as VendorIncident[];
}

export async function saveVendorIncident(vendorId: string, input: VendorIncidentInput): Promise<void> {
  const err = validateIncidentInput(input);
  if (err) throw new Error(err);
  const { error } = await supabase
    .from('vendor_incidents')
    .insert({ ...input, summary: input.summary.trim(), vendor_id: vendorId });
  if (error) throw error;
}

export async function setVendorIncidentStatus(
  id: string,
  status: VendorIncidentStatus,
  resolutionNotes?: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('vendor_incidents')
    .update({ status, resolution_notes: status === 'resolved' ? (resolutionNotes?.trim() || null) : null })
    .eq('id', id);
  if (error) throw error;
}

// ---------- vendor profile ----------

export async function createVendorProfile(input: NewVendorInput): Promise<string> {
  const err = validateVendorInput(input);
  if (err) throw new Error(err);
  const { data, error } = await supabase
    .from('vendors')
    .insert({
      ...input,
      name: input.name.trim(),
      email: input.email?.trim() || null,
      website: normalizeUrl(input.website),
      // A vendor created as blocked must also be inactive (DB constraint).
      active: input.tier !== 'blocked',
    })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function updateVendorProfile(vendorId: string, patch: VendorProfilePatch): Promise<void> {
  const next = { ...patch };
  if (next.name !== undefined) {
    if (!next.name.trim()) throw new Error('Enter the vendor name.');
    next.name = next.name.trim();
  }
  if (next.email) {
    if (!EMAIL_RE.test(next.email.trim())) throw new Error('Enter a valid email address.');
    next.email = next.email.trim();
  }
  if (next.website !== undefined) {
    const url = normalizeUrl(next.website);
    if (url && !isHttpUrl(url)) throw new Error('Enter a valid website address.');
    next.website = url;
  }
  const { error } = await supabase.from('vendors').update(next).eq('id', vendorId);
  if (error) throw error;
}

/**
 * Changes tier and keeps `active` consistent in the SAME statement:
 * blocking deactivates the vendor (so it drops out of RFQ invites, which only
 * list active vendors); un-blocking reactivates it; other changes leave
 * `active` untouched.
 */
export async function setVendorTier(
  vendorId: string,
  currentTier: VendorTier,
  nextTier: VendorTier,
): Promise<void> {
  if (currentTier === nextTier) return;
  const patch: { tier: VendorTier; active?: boolean } = { tier: nextTier };
  if (nextTier === 'blocked') patch.active = false;
  else if (currentTier === 'blocked') patch.active = true;
  const { error } = await supabase.from('vendors').update(patch).eq('id', vendorId);
  if (error) throw error;
}

export async function setVendorActive(vendorId: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('vendors').update({ active }).eq('id', vendorId);
  if (error) throw error;
}

export async function markVendorReviewed(vendorId: string): Promise<void> {
  const { error } = await supabase
    .from('vendors')
    .update({ last_reviewed_at: new Date().toISOString() })
    .eq('id', vendorId);
  if (error) throw error;
}

// ---------- inventory link ----------

/** Inventory vendors not yet linked to any procurement vendor (plus the currently linked one). */
export async function fetchLinkableInventoryVendors(
  linkedIds: string[],
  keepId: string | null,
): Promise<InventoryVendor[]> {
  const all = await listInventoryVendors(false);
  const taken = new Set(linkedIds.filter((id) => id !== keepId));
  return all.filter((v) => !taken.has(v.id));
}

export async function linkInventoryVendor(vendorId: string, inventoryVendorId: string | null): Promise<void> {
  const { error } = await supabase
    .from('vendors')
    .update({ inventory_vendor_id: inventoryVendorId })
    .eq('id', vendorId);
  if (error) throw error;
}

/** Suggests the inventory vendor whose name or email matches (case-insensitive), if exactly one does. */
export function suggestInventoryVendor(
  vendor: Pick<VendorOverviewRow, 'name' | 'email'>,
  candidates: InventoryVendor[],
): InventoryVendor | null {
  const name = vendor.name.trim().toLowerCase();
  const email = (vendor.email ?? '').trim().toLowerCase();
  const hits = candidates.filter(
    (c) => c.name.trim().toLowerCase() === name || (email !== '' && (c.email ?? '').trim().toLowerCase() === email),
  );
  return hits.length === 1 ? hits[0] : null;
}
