/**
 * Data Quality Center — pure logic (no React, no Supabase).
 *
 * Everything deterministic lives here so it is unit-tested: which records are
 * flagged, which one-click fix is safe, and how the data-health score is built.
 * Fetching + applying fixes lives in dataQualityApi.ts.
 *
 * Scoring is disclosed, not hidden: the score is a weighted average of five
 * completeness dimensions. A dimension with no records to judge is left out and
 * the remaining weights are re-normalised, so an empty account is not punished.
 * The "reality" dimension reuses the Business Reality Engine score as-is.
 */

import type { RealityReport } from '@/lib/businessReality';

// ============================================================
// TYPES
// ============================================================

export type DqKind =
  | 'missing_phone'
  | 'missing_address'
  | 'missing_email'
  | 'unmatched_equipment'
  | 'job_without_cost'
  | 'no_consent';

export type DqDimension = 'contact' | 'equipment' | 'costing' | 'consent' | 'reality';
export type DqSeverity = 'low' | 'medium' | 'high';

export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  marketing_opt_in: boolean | null;
}

export interface JobRow {
  id: string;
  customer_id: string | null;
  customer_name: string;
  address: string | null;
  job_status: string;
  scheduled_datetime: string | null;
  created_at: string;
}

export interface LeadRow {
  customer_id: string | null;
  phone: string | null;
  email: string | null;
  created_at: string;
}

export interface EquipmentRow {
  id: string;
  customer_id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_job_id: string | null;
}

export interface CostJobRow {
  job_id: string;
  customer_name: string;
  cost_entry_count: number;
}

/** What one click will do. `open` and `consent_link` never invent data. */
export type DqFix =
  | { type: 'backfill_customer'; customerId: string; patch: { phone?: string; email?: string; address?: string } }
  | { type: 'link_equipment'; equipmentId: string; jobId: string }
  | { type: 'consent_link'; customerId: string }
  | { type: 'open'; href: string; label: string };

export interface DqIssue {
  id: string;
  label: string;
  detail: string | null;
  fix: DqFix | null;
}

export interface DqCheck {
  kind: DqKind;
  dimension: DqDimension;
  severity: DqSeverity;
  title: string;
  why: string;
  /** Records flagged (all of them, not just the listed sample). */
  count: number;
  issues: DqIssue[];
  /** Every safe automatic fix for this check (all flagged records, not just the sample). */
  bulkFixes: DqFix[];
  /** How many flagged records the "Fix all" button will touch. */
  fixable: number;
}

export interface DqDimensionScore {
  dimension: DqDimension;
  label: string;
  weight: number;
  total: number;
  bad: number;
  /** Percent of records that are fine; null when there is nothing to judge. */
  pct: number | null;
}

export interface DataHealth {
  score: number;
  grade: DqGrade;
  generatedAt: string;
  dimensions: DqDimensionScore[];
  checks: DqCheck[];
  /** True when a table hit the fetch limit, so numbers describe the newest rows. */
  truncated: boolean;
}

export type DqGrade = 'excellent' | 'good' | 'fair' | 'poor';

export const DIMENSION_LABELS: Record<DqDimension, string> = {
  contact: 'Customer contact details',
  equipment: 'Equipment matching',
  costing: 'Job costing',
  consent: 'Messaging consent',
  reality: 'Operational reality',
};

export const DIMENSION_WEIGHTS: Record<DqDimension, number> = {
  contact: 25,
  equipment: 15,
  costing: 20,
  consent: 20,
  reality: 20,
};

export const GRADE_LABELS: Record<DqGrade, string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Needs work',
  poor: 'At risk',
};

/** Max issues listed per check (counts always cover every flagged record). */
export const SAMPLE_LIMIT = 25;

// ============================================================
// SMALL HELPERS
// ============================================================

export function isBlank(v: string | null | undefined): boolean {
  return v == null || v.trim() === '';
}

const clean = (v: string | null | undefined): string => (v ?? '').trim();
export const phoneKey = (v: string | null | undefined): string => clean(v).replace(/\D/g, '');
export const emailKey = (v: string | null | undefined): string => clean(v).toLowerCase();

const jobTime = (j: JobRow): number => {
  const t = Date.parse(j.scheduled_datetime ?? j.created_at);
  return Number.isFinite(t) ? t : 0;
};
const rowTime = (v: string): number => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};

export function gradeFor(score: number): DqGrade {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 55) return 'fair';
  return 'poor';
}

// ============================================================
// FIX PLANNING (only ever copies data the account already holds)
// ============================================================

/**
 * Looks for the missing value on records the account already owns for this
 * customer: newest job address, newest lead phone/email. A phone or email that
 * already belongs to a DIFFERENT customer is never copied (the customers table
 * enforces one customer per phone/email, so it would fail and could hide a duplicate).
 */
export function planCustomerBackfill(
  customer: CustomerRow,
  jobs: readonly JobRow[],
  leads: readonly LeadRow[],
  taken: { phones: ReadonlySet<string>; emails: ReadonlySet<string> },
): { phone?: string; email?: string; address?: string } {
  const patch: { phone?: string; email?: string; address?: string } = {};

  if (isBlank(customer.address)) {
    const job = jobs
      .filter((j) => j.customer_id === customer.id && !isBlank(j.address))
      .sort((a, b) => jobTime(b) - jobTime(a))[0];
    if (job) patch.address = clean(job.address);
  }

  const ownLeads = leads.filter((l) => l.customer_id === customer.id).sort((a, b) => rowTime(b.created_at) - rowTime(a.created_at));

  if (isBlank(customer.phone)) {
    const lead = ownLeads.find((l) => phoneKey(l.phone).length >= 7 && !taken.phones.has(phoneKey(l.phone)));
    if (lead) patch.phone = clean(lead.phone);
  }
  if (isBlank(customer.email)) {
    const lead = ownLeads.find((l) => /^\S+@\S+\.\S+$/.test(clean(l.email)) && !taken.emails.has(emailKey(l.email)));
    if (lead) patch.email = clean(lead.email);
  }
  return patch;
}

/** Newest non-cancelled job of the same customer — the safest place to attach equipment. */
export function planEquipmentLink(equipment: EquipmentRow, jobs: readonly JobRow[]): string | null {
  const job = jobs
    .filter((j) => j.customer_id === equipment.customer_id && j.job_status !== 'cancelled')
    .sort((a, b) => jobTime(b) - jobTime(a))[0];
  return job ? job.id : null;
}

// ============================================================
// CHECK BUILDERS
// ============================================================

function finish(check: Omit<DqCheck, 'fixable' | 'bulkFixes'>, bulkFixes: DqFix[] = []): DqCheck {
  return { ...check, bulkFixes, fixable: bulkFixes.length };
}

/** Merges several backfills for the same customer into one write; other fixes pass through. */
export function mergeFixes(fixes: readonly DqFix[]): DqFix[] {
  const merged = new Map<string, DqFix>();
  const out: DqFix[] = [];
  for (const f of fixes) {
    if (f.type !== 'backfill_customer') { out.push(f); continue; }
    const prev = merged.get(f.customerId);
    if (prev && prev.type === 'backfill_customer') prev.patch = { ...prev.patch, ...f.patch };
    else {
      const copy: DqFix = { ...f, patch: { ...f.patch } };
      merged.set(f.customerId, copy);
      out.push(copy);
    }
  }
  return out;
}

export interface CustomerChecksInput {
  customers: readonly CustomerRow[];
  jobs: readonly JobRow[];
  leads: readonly LeadRow[];
  /** customer ids with a customer-recorded preference event (consent evidence). */
  consentEvidenceIds: ReadonlySet<string>;
}

export function buildCustomerChecks(input: CustomerChecksInput): DqCheck[] {
  const { customers, jobs, leads, consentEvidenceIds } = input;
  const taken = {
    phones: new Set(customers.map((c) => phoneKey(c.phone)).filter(Boolean)),
    emails: new Set(customers.map((c) => emailKey(c.email)).filter(Boolean)),
  };

  const defs: Array<{ kind: 'missing_phone' | 'missing_address' | 'missing_email'; field: 'phone' | 'address' | 'email'; title: string; why: string; severity: DqSeverity }> = [
    { kind: 'missing_phone', field: 'phone', severity: 'high', title: 'Customers with no phone number', why: 'No way to confirm appointments, send ETA texts or call back.' },
    { kind: 'missing_address', field: 'address', severity: 'high', title: 'Customers with no service address', why: 'Dispatch, routing and property history all depend on it.' },
    { kind: 'missing_email', field: 'email', severity: 'medium', title: 'Customers with no email', why: 'Invoices, receipts and quotes cannot be emailed.' },
  ];

  const checks: DqCheck[] = [];

  for (const d of defs) {
    const flagged = customers.filter((c) => isBlank(c[d.field]));
    if (flagged.length === 0) continue;
    const plans = flagged.map((c) => ({ c, value: planCustomerBackfill(c, jobs, leads, taken)[d.field] }));
    const toFix = (c: CustomerRow, value: string): DqFix => ({ type: 'backfill_customer', customerId: c.id, patch: { [d.field]: value } });
    const issues: DqIssue[] = plans.slice(0, SAMPLE_LIMIT).map(({ c, value }) => ({
      id: `${d.kind}:${c.id}`,
      label: c.name || 'Unnamed customer',
      detail: value ? `Found on file: ${value}` : null,
      fix: value ? toFix(c, value) : { type: 'open', href: `/dashboard/customers/${c.id}`, label: 'Open customer' },
    }));
    const bulk = plans.filter((p) => p.value).map((p) => toFix(p.c, p.value as string));
    checks.push(finish({ kind: d.kind, dimension: 'contact', severity: d.severity, title: d.title, why: d.why, count: flagged.length, issues }, bulk));
  }

  // Consent: only customers we could actually message are judged.
  const reachable = customers.filter((c) => !isBlank(c.phone) || !isBlank(c.email));
  const noConsent = reachable.filter((c) => c.marketing_opt_in !== true && !consentEvidenceIds.has(c.id));
  if (noConsent.length > 0) {
    checks.push(finish({
      kind: 'no_consent',
      dimension: 'consent',
      severity: 'high',
      title: 'Customers with no recorded messaging consent',
      why: 'No opt-in and no preference-center record. Marketing texts and emails to them are a compliance risk.',
      count: noConsent.length,
      issues: noConsent.slice(0, SAMPLE_LIMIT).map((c) => ({
        id: `no_consent:${c.id}`,
        label: c.name || 'Unnamed customer',
        detail: 'Send them their preference link — consent is only recorded when the customer sets it.',
        fix: { type: 'consent_link', customerId: c.id },
      })),
    }));
  }
  return checks;
}

export function buildEquipmentCheck(
  equipment: readonly EquipmentRow[],
  linkedEquipmentIds: ReadonlySet<string>,
  jobs: readonly JobRow[],
  customerNames: ReadonlyMap<string, string>,
): DqCheck | null {
  const flagged = equipment.filter((e) => !linkedEquipmentIds.has(e.id) && !e.install_job_id);
  if (flagged.length === 0) return null;
  const plans = flagged.map((e) => ({ e, jobId: planEquipmentLink(e, jobs) }));
  const bulk: DqFix[] = plans.filter((p) => p.jobId).map((p) => ({ type: 'link_equipment', equipmentId: p.e.id, jobId: p.jobId as string }));
  return finish({
    kind: 'unmatched_equipment',
    dimension: 'equipment',
    severity: 'medium',
    title: 'Equipment not linked to any job',
    why: 'Without a job link the unit has no service history, so warranty and maintenance alerts are blind.',
    count: flagged.length,
    issues: plans.slice(0, SAMPLE_LIMIT).map(({ e, jobId }) => ({
      id: `unmatched_equipment:${e.id}`,
      label: [e.make, e.model].filter((x) => !isBlank(x)).join(' ') || e.equipment_type,
      detail: customerNames.get(e.customer_id) ?? null,
      fix: jobId
        ? { type: 'link_equipment', equipmentId: e.id, jobId }
        : { type: 'open', href: `/dashboard/customers/${e.customer_id}`, label: 'Open customer' },
    })),
  }, bulk);
}

export function buildCostCheck(completed: readonly CostJobRow[]): DqCheck | null {
  const flagged = completed.filter((j) => j.cost_entry_count === 0);
  if (flagged.length === 0) return null;
  return finish({
    kind: 'job_without_cost',
    dimension: 'costing',
    severity: 'high',
    title: 'Completed jobs with no cost recorded',
    why: 'Revenue with no cost makes margin look 100% — profitability and pricing decisions get distorted.',
    count: flagged.length,
    issues: flagged.slice(0, SAMPLE_LIMIT).map((j) => ({
      id: `job_without_cost:${j.job_id}`,
      label: j.customer_name,
      detail: null,
      fix: { type: 'open', href: `/dashboard/jobs/${j.job_id}`, label: 'Add costs' },
    })),
  });
}

// ============================================================
// SCORE
// ============================================================

export interface DimensionTotals {
  contact: { total: number; bad: number };
  equipment: { total: number; bad: number };
  costing: { total: number; bad: number };
  consent: { total: number; bad: number };
}

export function buildDimensions(totals: DimensionTotals, reality: RealityReport | null): DqDimensionScore[] {
  const pct = (total: number, bad: number): number | null =>
    total > 0 ? Math.round(((total - Math.min(bad, total)) / total) * 100) : null;

  const base: DqDimensionScore[] = (['contact', 'equipment', 'costing', 'consent'] as const).map((d) => ({
    dimension: d,
    label: DIMENSION_LABELS[d],
    weight: DIMENSION_WEIGHTS[d],
    total: totals[d].total,
    bad: totals[d].bad,
    pct: pct(totals[d].total, totals[d].bad),
  }));

  base.push({
    dimension: 'reality',
    label: DIMENSION_LABELS.reality,
    weight: DIMENSION_WEIGHTS.reality,
    total: reality ? reality.findings.length : 0,
    bad: reality ? reality.findings.length : 0,
    pct: reality ? reality.score : null,
  });
  return base;
}

export function scoreFromDimensions(dimensions: readonly DqDimensionScore[]): number {
  const judged = dimensions.filter((d) => d.pct !== null);
  const weight = judged.reduce((s, d) => s + d.weight, 0);
  if (weight === 0) return 100;
  const sum = judged.reduce((s, d) => s + (d.pct as number) * d.weight, 0);
  return Math.max(0, Math.min(100, Math.round(sum / weight)));
}

/** Customer contact is judged per field (3 fields per customer) so one bad record doesn't hide behind two good ones. */
export function contactTotals(customerCount: number, checks: readonly DqCheck[]): { total: number; bad: number } {
  const bad = checks.filter((c) => c.dimension === 'contact').reduce((s, c) => s + c.count, 0);
  return { total: customerCount * 3, bad };
}

export function assembleHealth(args: {
  customerCount: number;
  reachableCount: number;
  equipmentCount: number;
  completedJobCount: number;
  checks: DqCheck[];
  reality: RealityReport | null;
  truncated: boolean;
  now?: Date;
}): DataHealth {
  const by = (k: DqKind) => args.checks.find((c) => c.kind === k)?.count ?? 0;
  const dimensions = buildDimensions(
    {
      contact: contactTotals(args.customerCount, args.checks),
      equipment: { total: args.equipmentCount, bad: by('unmatched_equipment') },
      costing: { total: args.completedJobCount, bad: by('job_without_cost') },
      consent: { total: args.reachableCount, bad: by('no_consent') },
    },
    args.reality,
  );
  const score = scoreFromDimensions(dimensions);
  const severityRank: Record<DqSeverity, number> = { high: 0, medium: 1, low: 2 };
  const checks = [...args.checks].sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.count - a.count);
  return { score, grade: gradeFor(score), generatedAt: (args.now ?? new Date()).toISOString(), dimensions, checks, truncated: args.truncated };
}
