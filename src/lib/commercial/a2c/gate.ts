import type { AttachmentType, DocumentType, GateCode, GateMode } from './types';
import { matchesPoFormat } from './safeRegex';

/**
 * Pre-invoice gate (PURE). Mirrors `commercial_evaluate_v2()` rule for rule and in the same order, so the UI
 * preview and the database hard gate agree. The database is authoritative; gate.cases.json holds the shared
 * fixtures for both sides (the SQL side of that parity is NOT run in CI yet — see report).
 * No Date.now(): the caller passes `now`.
 */
export interface GateRule {
  gateMode: GateMode;
  requiresPo: boolean;
  poFormatRegex: string | null;
  requiresWorkOrderNumber: boolean;
  requiresNteApproval: boolean;
  requiresCompletionPhotos: boolean;
  requiresSignature: boolean;
  requiresServiceReport: boolean;
  invoiceDueWindowDays: number | null;
  requiredAttachments: readonly AttachmentType[];
  nteWarnPct: number;
  nteBlockPct: number;
}

export interface GateApproval {
  poNumber: string | null;
  workOrderNumber: string | null;
  approvedAmountCents: number;
  /** ISO instant or null */
  expiresAt: string | null;
  hasEvidence: boolean;
  changeOrderPending: boolean;
}

export interface GateFacts {
  invoiceTotalCents: number;
  /** other open invoices already billed against the same approval */
  previouslyBilledCents: number;
  hasAfterPhoto: boolean;
  hasSignature: boolean;
  /** ISO instant the job was completed, or null */
  completedAt: string | null;
  documents: readonly DocumentType[];
  /** ISO instant */
  now: string;
  /** total (cents) the owner accepted when overriding; null = no override */
  overrideTotalCents: number | null;
}

export interface GateItem {
  code: GateCode;
  severity: 'block' | 'warn';
  detail?: Record<string, number | string | boolean | readonly string[]>;
}

export type GateResultKind = 'pass' | 'warn' | 'blocked_needs_approval';

export interface GateResult {
  result: GateResultKind;
  mode: GateMode;
  blocked: boolean;
  overridden: boolean;
  reasons: GateItem[];
  warnings: GateItem[];
}

const DAY_MS = 86_400_000;

export function evaluateGate(rule: GateRule, approval: GateApproval | null, facts: GateFacts): GateResult {
  if (rule.gateMode === 'off') {
    return { result: 'pass', mode: 'off', blocked: false, overridden: false, reasons: [], warnings: [] };
  }
  const items: GateItem[] = [];
  const nowMs = Date.parse(facts.now);
  const docs = new Set<DocumentType>(facts.documents);

  if (rule.requiresPo && (!approval || approval.poNumber === null)) items.push({ code: 'missing_po', severity: 'block' });

  if (rule.poFormatRegex !== null && approval && approval.poNumber !== null) {
    // null = unusable pattern: ignored on purpose, same as the SQL EXCEPTION branch
    if (matchesPoFormat(approval.poNumber, rule.poFormatRegex) === false) items.push({ code: 'po_format_mismatch', severity: 'block' });
  }
  if (rule.requiresWorkOrderNumber && (!approval || approval.workOrderNumber === null)) items.push({ code: 'missing_work_order', severity: 'block' });
  if (rule.requiresNteApproval && !approval) items.push({ code: 'missing_nte_approval', severity: 'block' });

  if (approval && approval.expiresAt !== null && Date.parse(approval.expiresAt) < nowMs) {
    items.push({ code: 'approval_expired', severity: 'block', detail: { expiresAt: approval.expiresAt } });
  }

  if (approval) {
    const all = facts.invoiceTotalCents + facts.previouslyBilledCents;
    const detail = {
      invoiceTotalCents: facts.invoiceTotalCents,
      previouslyBilledCents: facts.previouslyBilledCents,
      approvedAmountCents: approval.approvedAmountCents,
    };
    if (all * 100 > approval.approvedAmountCents * rule.nteBlockPct) {
      items.push({
        code: 'over_approved_amount', severity: 'block',
        detail: { ...detail, excessCents: all - approval.approvedAmountCents, changeOrderPending: approval.changeOrderPending },
      });
    } else if (all * 100 >= approval.approvedAmountCents * rule.nteWarnPct) {
      items.push({ code: 'nte_near_limit', severity: 'warn', detail });
    }
  }

  if (rule.requiresCompletionPhotos && !facts.hasAfterPhoto) items.push({ code: 'missing_completion_photos', severity: 'block' });
  if (rule.requiresSignature && !facts.hasSignature) items.push({ code: 'missing_signature', severity: 'block' });
  if (rule.requiresServiceReport && !docs.has('service_report')) items.push({ code: 'missing_service_report', severity: 'block' });

  const missing: AttachmentType[] = [];
  for (const a of rule.requiredAttachments) {
    const lacking =
      (a === 'po_copy' && !docs.has('po_copy')) ||
      (a === 'approval_proof' && !docs.has('approval_proof') && !(approval !== null && approval.hasEvidence)) ||
      (a === 'other' && !docs.has('other')) ||
      (a === 'completion_photos' && !facts.hasAfterPhoto && !rule.requiresCompletionPhotos) ||
      (a === 'signature' && !facts.hasSignature && !rule.requiresSignature) ||
      (a === 'service_report' && !docs.has('service_report') && !rule.requiresServiceReport);
    if (lacking) missing.push(a);
  }
  if (missing.length > 0) items.push({ code: 'missing_documents', severity: 'block', detail: { missing } });

  // late submission can never be fixed by the user, so it only ever warns
  if (rule.invoiceDueWindowDays !== null && facts.completedAt !== null &&
      nowMs > Date.parse(facts.completedAt) + rule.invoiceDueWindowDays * DAY_MS) {
    items.push({ code: 'late_submission', severity: 'warn', detail: { windowDays: rule.invoiceDueWindowDays } });
  }

  const overridden = facts.overrideTotalCents !== null && facts.overrideTotalCents >= facts.invoiceTotalCents;
  const blocking = rule.gateMode === 'block' ? items.filter((i) => i.severity === 'block') : [];
  const blocked = blocking.length > 0 && !overridden;
  const warnings = blocked ? items.filter((i) => i.severity !== 'block' || rule.gateMode !== 'block') : items;

  return {
    result: blocked ? 'blocked_needs_approval' : warnings.length > 0 ? 'warn' : 'pass',
    mode: rule.gateMode, blocked, overridden,
    reasons: blocked ? blocking : [], warnings,
  };
}

/** Defaults for a customer that has just been switched on (same defaults as the table). */
export const DEFAULT_RULE: GateRule = {
  gateMode: 'block', requiresPo: true, poFormatRegex: null, requiresWorkOrderNumber: false, requiresNteApproval: false,
  requiresCompletionPhotos: true, requiresSignature: false, requiresServiceReport: false, invoiceDueWindowDays: null,
  requiredAttachments: [], nteWarnPct: 80, nteBlockPct: 100,
};
