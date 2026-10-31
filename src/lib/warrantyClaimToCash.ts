// Warranty claim-to-cash: pure helpers mirrored from the SQL state machine in
// supabase/migrations/20280101000000_warranty_claim_to_cash.sql (the database is authoritative).
import { supabase } from '@/lib/supabase';

export type WccStatus = 'needs_review' | 'ready' | 'submitted' | 'approved' | 'denied' | 'expired' | 'paid' | 'closed';

const LEGACY: Record<string, WccStatus> = { eligible: 'needs_review', packet_pending: 'ready', credit_received: 'paid' };

export function normalizeStatus(s: string): WccStatus {
  return (LEGACY[s] ?? s) as WccStatus;
}

const NEXT: Record<WccStatus, WccStatus[]> = {
  needs_review: ['ready', 'expired', 'closed'],
  ready: ['needs_review', 'submitted', 'expired', 'closed'],
  submitted: ['approved', 'denied', 'expired'],
  approved: ['paid', 'closed'],
  denied: ['closed'],
  expired: ['closed'],
  paid: ['closed'],
  closed: [],
};

export function nextStatuses(from: string): WccStatus[] {
  return NEXT[normalizeStatus(from)] ?? [];
}

export function canTransition(from: string, to: string): boolean {
  return nextStatuses(from).includes(normalizeStatus(to));
}

export interface PaymentVariance {
  vsEstimateCents: number | null;
  vsApprovedCents: number | null;
  shortPaid: boolean;
  overPaid: boolean;
}

// Positive = paid more than the reference. Null when either side is unknown (never guessed).
export function paymentVariance(
  paidCents: number | null | undefined,
  estimateCents: number | null | undefined,
  approvedCents: number | null | undefined,
): PaymentVariance {
  const has = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
  const vsEstimateCents = has(paidCents) && has(estimateCents) ? paidCents - estimateCents : null;
  const vsApprovedCents = has(paidCents) && has(approvedCents) ? paidCents - approvedCents : null;
  return {
    vsEstimateCents,
    vsApprovedCents,
    shortPaid: vsApprovedCents !== null && vsApprovedCents < 0,
    overPaid: vsApprovedCents !== null && vsApprovedCents > 0,
  };
}

// Whole days since submission, only for claims still awaiting money.
export function daysUnpaid(status: string, submittedAt: string | null | undefined, now: Date = new Date()): number | null {
  const s = normalizeStatus(status);
  if (!submittedAt || (s !== 'submitted' && s !== 'approved')) return null;
  const t = new Date(submittedAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86400000));
}

export function isUnpaidBeyond<T extends { status: string; submitted_at: string | null }>(rows: T[], days: number, now: Date = new Date()): T[] {
  return rows.filter((r) => {
    const d = daysUnpaid(r.status, r.submitted_at, now);
    return d !== null && d > days;
  });
}

export interface ClaimPacket {
  claim_id: string;
  status: WccStatus;
  customer_name: string | null;
  property_address: string | null;
  manufacturer: string | null;
  distributor: string | null;
  model_number: string | null;
  serial_number: string | null;
  install_date: string | null;
  warranty_expires_at: string | null;
  claim_deadline: string | null;
  failure_description: string | null;
  part_description: string | null;
  parts: { part_number: string | null; name: string; quantity: number; unit_cost_cents: number }[];
  labor_hours: number | null;
  photo_count: number;
  invoice_ref: string | null;
  estimated_recovery_cents: number | null;
  missing: string[];
  blocking: string[];
  ready_to_submit: boolean;
}

export const MISSING_LABELS: Record<string, string> = {
  manufacturer: 'Manufacturer', model_number: 'Model number', serial_number: 'Serial number',
  failure_description: 'Failure description', install_date: 'Install date', parts: 'Parts used',
  labor_hours: 'Labor hours', photos: 'Job photos', invoice_ref: 'Invoice reference',
};

export function missingLabel(key: string): string {
  if (key.startsWith('checklist:')) return `Checklist: ${key.slice(10).replace(/_/g, ' ')}`;
  return MISSING_LABELS[key] ?? key;
}

export async function fetchClaimPacket(claimId: string): Promise<ClaimPacket> {
  const { data, error } = await supabase.rpc('wcc_packet', { p_claim_id: claimId });
  if (error) throw error;
  return data as ClaimPacket;
}

export async function createWarrantyInvoice(claimId: string): Promise<string> {
  const { data, error } = await supabase.rpc('wcc_create_ar_invoice', { p_claim_id: claimId });
  if (error) throw error;
  return data as string;
}

export async function applyWarrantyPayment(claimId: string): Promise<string> {
  const { data, error } = await supabase.rpc('wcc_apply_payment', { p_claim_id: claimId });
  if (error) throw error;
  return data as string;
}

// Status change patch; the database trigger is the real validator and returns readable error codes.
export function buildTransitionPatch(
  to: WccStatus,
  f: { claimNumber?: string; submittedAt?: string; approvedCents?: number; denialReason?: string; paidCents?: number; paidAt?: string },
): Record<string, unknown> {
  const p: Record<string, unknown> = { status: to };
  if (to === 'submitted') { p.claim_number = f.claimNumber?.trim(); if (f.submittedAt) p.submitted_at = f.submittedAt; }
  if (to === 'approved') p.approved_amount_cents = f.approvedCents;
  if (to === 'denied') p.denial_reason = f.denialReason?.trim();
  if (to === 'paid') { p.credit_received_cents = f.paidCents; if (f.paidAt) p.credit_received_at = f.paidAt; }
  return p;
}

export const TRANSITION_ERRORS: Record<string, string> = {
  claim_packet_incomplete: 'Manufacturer, model, serial and failure description are required before a claim is ready.',
  manufacturer_reference_required: 'Enter the manufacturer claim/reference number.',
  submitted_date_in_future: 'Submitted date cannot be in the future.',
  approved_amount_required: 'Enter the approved amount.',
  denial_reason_required: 'Enter the denial reason.',
  paid_amount_required: 'Enter the amount actually paid.',
  claim_paid_locked: 'Amounts on a paid claim are locked.',
  invalid_claim_transition: 'That status change is not allowed from the current status.',
};

export function transitionErrorMessage(message: string | undefined): string {
  const m = message ?? '';
  const key = Object.keys(TRANSITION_ERRORS).find((k) => m.includes(k));
  return key ? TRANSITION_ERRORS[key] : 'Could not update status';
}
