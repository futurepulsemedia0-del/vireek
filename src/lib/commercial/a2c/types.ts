/**
 * Commercial Approval-to-Cash v2 — shared vocabulary (PURE: no I/O, no React, no Supabase).
 * Every literal union below mirrors a CHECK constraint in
 * supabase/migrations/20290312000000_commercial_a2c_v2.sql; stateMachine.test.ts / gate.test.ts diff them.
 */

export const STAGES = [
  'draft', 'ready', 'blocked_needs_approval', 'sent', 'received', 'approved',
  'rejected', 'disputed', 'paid', 'written_off', 'void',
] as const;
export type Stage = (typeof STAGES)[number];

export const SOURCES = ['user', 'system', 'portal', 'email_parse'] as const;
export type TransitionSource = (typeof SOURCES)[number];

export const REJECTION_CODES = [
  'missing_po', 'po_mismatch', 'amount_exceeds_nte', 'missing_documents', 'wrong_billing_entity',
  'late_submission', 'pricing_dispute', 'duplicate', 'other',
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

export const GATE_MODES = ['block', 'warn', 'off'] as const;
export type GateMode = (typeof GATE_MODES)[number];

export const SUBMISSION_CHANNELS = ['email', 'portal', 'edi', 'manual'] as const;
export type SubmissionChannel = (typeof SUBMISSION_CHANNELS)[number];

export const ATTACHMENT_TYPES = ['po_copy', 'approval_proof', 'completion_photos', 'signature', 'service_report', 'other'] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

export const DOCUMENT_TYPES = ['po_copy', 'approval_proof', 'service_report', 'other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const PACKET_SECTIONS = [
  'invoice', 'po', 'approval_proof', 'change_order', 'completion_photos', 'signature', 'service_report', 'other_documents',
] as const;
export type PacketSection = (typeof PACKET_SECTIONS)[number];

export const DEFAULT_PACKET_ORDER: readonly PacketSection[] = [
  'invoice', 'po', 'approval_proof', 'completion_photos', 'signature', 'service_report',
];

export const GATE_CODES = [
  'missing_po', 'po_format_mismatch', 'missing_work_order', 'missing_nte_approval', 'approval_expired',
  'over_approved_amount', 'nte_near_limit', 'missing_completion_photos', 'missing_signature',
  'missing_service_report', 'missing_documents', 'late_submission',
] as const;
export type GateCode = (typeof GATE_CODES)[number];

/** Maps the failing gate code to the rejection reason a customer would most likely give. */
export const GATE_TO_REJECTION: Readonly<Record<GateCode, RejectionCode>> = {
  missing_po: 'missing_po',
  po_format_mismatch: 'po_mismatch',
  missing_work_order: 'missing_documents',
  missing_nte_approval: 'missing_documents',
  approval_expired: 'missing_documents',
  over_approved_amount: 'amount_exceeds_nte',
  nte_near_limit: 'amount_exceeds_nte',
  missing_completion_photos: 'missing_documents',
  missing_signature: 'missing_documents',
  missing_service_report: 'missing_documents',
  missing_documents: 'missing_documents',
  late_submission: 'late_submission',
};
