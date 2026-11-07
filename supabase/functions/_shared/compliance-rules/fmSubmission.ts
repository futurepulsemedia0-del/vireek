// supabase/functions/_shared/compliance-rules/fmSubmission.ts
//
// "fm_submission" surface of the regulation-as-code engine: pre-submission checks
// for proposals, parts orders and invoices that go to a facility-management portal
// (ServiceChannel-style). Pure and deterministic — same rules + same facts + same
// instant => same result. No I/O. engine.ts delegates to evalFm() / validateFmParams().
//
// These are CUSTOMER-PORTAL requirements, not law. The engine still only applies
// rule versions a human reviewer approved. Nothing here ever submits anything:
// every finding carries a suggested fix the account owner may apply to a DRAFT.

import { isValidTimezone, zonedParts } from "../messaging/quietHoursCore.ts";
import type { ActionType, FindingStatus } from "./types.ts";

export const FM_KINDS = [
  "fm_nte_cap",
  "fm_proposal_before_parts",
  "fm_invoice_deadline",
  "fm_ineligibility_window",
  "fm_prohibited_line_item",
  "fm_single_invoice",
  "fm_required_attachment",
] as const;
export type FmKind = (typeof FM_KINDS)[number];

export const isFmKind = (k: string): k is FmKind => (FM_KINDS as readonly string[]).includes(k);

export const FM_DOCUMENT_TYPES = ["invoice", "proposal", "parts_order"] as const;
export type FmDocumentType = (typeof FM_DOCUMENT_TYPES)[number];

export const FM_LINE_CATEGORIES = [
  "labor", "technicians", "materials", "trip", "freight", "sales_tax", "new_business_fee", "management_fee", "other",
] as const;
export type FmLineCategory = (typeof FM_LINE_CATEGORIES)[number];

export interface FmLineItem {
  category: FmLineCategory;
  label?: string;
  amountCents: number;
}

export interface FmFacts {
  documentType: FmDocumentType;
  workOrderId?: string;
  /** IANA timezone used for day arithmetic. Default America/New_York. */
  timezone?: string | null;
  /** Who the invoice is addressed to. null/undefined = not recorded. */
  billingParty?: "portal" | "customer" | null;
  /** CURRENT NTE in cents (after any approved increase). null/undefined = unknown. */
  nteCents?: number | null;
  proposalStatus?: "none" | "pending" | "approved" | "rejected";
  /** Document total, or projected total for a parts_order. */
  totalCents?: number | null;
  partsCents?: number | null;
  lineItems?: FmLineItem[];
  /** ISO instant the work order reached Completed/Confirmed — the anchor of day-based windows. */
  workConfirmedAt?: string | null;
  /** ISO instant the work order was received — alternative anchor for day-based windows. */
  workReceivedAt?: string | null;
  /** Invoices already submitted for this work order that are neither rejected nor voided. */
  existingInvoiceCount?: number;
  /** Attachment kinds already on the draft, e.g. "subcontractor_invoice". */
  attachments?: string[];
  hasSubcontractor?: boolean;
}

export type FmFixKind =
  | "reduce_total_to_cap"
  | "remove_line_item"
  | "create_proposal"
  | "wait_for_approval"
  | "attach_file"
  | "enter_nte"
  | "enter_confirmed_date"
  | "confirm_billing_party"
  | "contact_client"
  | "merge_into_existing_invoice";

export interface FmFix {
  kind: FmFixKind;
  label: string;
  /** true = the app can apply it to the DRAFT with one click. It never submits. */
  oneClick: boolean;
  params?: Record<string, string | number>;
}

export interface FmOutcome {
  status: FindingStatus;
  message: string;
  actions?: Array<{ type: ActionType; text: string; fix?: FmFix }>;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const DEFAULT_TZ = "America/New_York";
const DAY_MS = 86_400_000;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const strList = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
export const fmMoney = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const tzOf = (f: FmFacts): string => (isValidTimezone(f.timezone) ? f.timezone : DEFAULT_TZ);
const keyToUtcMs = (key: string): number => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));

/** YYYY-MM-DD of an ISO instant in `tz`; null when the input is not a valid instant. */
export function fmDayKey(iso: string | null | undefined, tz: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : zonedParts(d, isValidTimezone(tz) ? tz : DEFAULT_TZ).dateKey;
}

/** Whole calendar days from `fromKey` to `toKey` (negative when `toKey` is earlier). */
export const fmDayDiff = (fromKey: string, toKey: string): number => Math.round((keyToUtcMs(toKey) - keyToUtcMs(fromKey)) / DAY_MS);

/** Calendar date (YYYY-MM-DD) on which a `days`-day window that starts on `anchorKey` ends. */
export function fmAddDays(anchorKey: string, days: number): string {
  return new Date(keyToUtcMs(anchorKey) + days * DAY_MS).toISOString().slice(0, 10);
}

function docTypesOf(kind: FmKind, p: Record<string, unknown>): readonly string[] {
  const explicit = strList(p.documentTypes);
  if (explicit && explicit.length > 0) return explicit;
  return kind === "fm_proposal_before_parts" ? ["parts_order"]
    : kind === "fm_prohibited_line_item" || kind === "fm_required_attachment" ? ["invoice", "proposal"]
    : ["invoice"];
}

// ---------------------------------------------------------------------------
// params validation (mirrored by compliance_version_errors in the SQL migration)
// ---------------------------------------------------------------------------

export function validateFmParams(kind: FmKind, p: Record<string, unknown>): string[] {
  const errs: string[] = [];
  if (p.documentTypes !== undefined) {
    const dt = strList(p.documentTypes);
    if (!dt || dt.length === 0 || !dt.every((x) => (FM_DOCUMENT_TYPES as readonly string[]).includes(x))) {
      errs.push(`documentTypes must be a non-empty list of ${FM_DOCUMENT_TYPES.join(" | ")}`);
    }
  }
  switch (kind) {
    case "fm_nte_cap":
    case "fm_proposal_before_parts":
    case "fm_single_invoice":
      break;
    case "fm_invoice_deadline":
    case "fm_ineligibility_window": {
      const max = kind === "fm_invoice_deadline" ? 365 : 1095;
      if (!isInt(p.days) || p.days < 1 || p.days > max) errs.push(`days must be an integer 1-${max}`);
      if (p.warnDays !== undefined && (!isInt(p.warnDays) || p.warnDays < 0 || p.warnDays > 60)) errs.push("warnDays must be an integer 0-60");
      if (p.anchor !== undefined && p.anchor !== "work_confirmed" && p.anchor !== "work_received") errs.push("anchor must be work_confirmed or work_received");
      break;
    }
    case "fm_prohibited_line_item": {
      const c = strList(p.categories);
      if (!c || c.length === 0 || !c.every((x) => (FM_LINE_CATEGORIES as readonly string[]).includes(x))) {
        errs.push(`categories must be a non-empty list of ${FM_LINE_CATEGORIES.join(" | ")}`);
      }
      if (p.appliesWhenBilling !== undefined && p.appliesWhenBilling !== "portal" && p.appliesWhenBilling !== "customer") {
        errs.push("appliesWhenBilling must be portal or customer");
      }
      break;
    }
    case "fm_required_attachment":
      if (typeof p.attachment !== "string" || !/^[a-z0-9_-]{2,40}$/.test(p.attachment)) errs.push("attachment must match [a-z0-9_-]{2,40}");
      if (typeof p.label !== "string" || !p.label.trim()) errs.push("label is required");
      if (p.condition !== undefined && p.condition !== "always" && p.condition !== "has_subcontractor") errs.push("condition must be always or has_subcontractor");
      break;
  }
  return errs;
}

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

/** null = rule does not apply to these facts (engine records it as skipped). */
export function evalFm(kind: FmKind, p: Record<string, unknown>, facts: FmFacts | undefined, at: Date): FmOutcome | null {
  if (!facts) return null;
  if (!docTypesOf(kind, p).includes(facts.documentType)) return null;
  switch (kind) {
    case "fm_nte_cap": return evalNteCap(facts);
    case "fm_proposal_before_parts": return evalProposalBeforeParts(facts);
    case "fm_invoice_deadline": return evalWindow(p, facts, at, "deadline");
    case "fm_ineligibility_window": return evalWindow(p, facts, at, "ineligible");
    case "fm_prohibited_line_item": return evalProhibited(p, facts);
    case "fm_single_invoice": return evalSingleInvoice(facts);
    case "fm_required_attachment": return evalAttachment(p, facts);
  }
}

const fixAction = (text: string, fix: FmFix) => ({ type: "fix_before_sending" as ActionType, text, fix });

function evalNteCap(f: FmFacts): FmOutcome {
  if (f.nteCents === null || f.nteCents === undefined) {
    return { status: "action", message: "The NTE for this work order is not recorded, so the cap cannot be checked.",
      actions: [fixAction("Enter the NTE shown in the portal.", { kind: "enter_nte", label: "Enter NTE", oneClick: false })] };
  }
  if (f.totalCents === null || f.totalCents === undefined) {
    return { status: "action", message: "The invoice total is missing, so the NTE cap cannot be checked.",
      actions: [fixAction("Enter the invoice total.", { kind: "enter_nte", label: "Enter total", oneClick: false })] };
  }
  if (f.totalCents <= f.nteCents) return { status: "pass", message: `${fmMoney(f.totalCents)} is within the ${fmMoney(f.nteCents)} NTE.` };
  const over = f.totalCents - f.nteCents;
  const actions = [
    fixAction(`Reduce the invoice by ${fmMoney(over)} to ${fmMoney(f.nteCents)}.`,
      { kind: "reduce_total_to_cap", label: `Reduce to ${fmMoney(f.nteCents)}`, oneClick: false, params: { capCents: f.nteCents, overCents: over } }),
  ];
  if (f.proposalStatus === "pending") {
    actions.push(fixAction("A proposal is pending — wait for the approval before invoicing the extra amount.", { kind: "wait_for_approval", label: "Wait for proposal approval", oneClick: false }));
  } else if (f.proposalStatus !== "approved") {
    actions.push(fixAction("Submit a proposal to raise the NTE, and invoice the extra only after it is approved.", { kind: "create_proposal", label: "Create proposal", oneClick: false }));
  }
  return { status: "fail", message: `${fmMoney(f.totalCents)} is ${fmMoney(over)} above the ${fmMoney(f.nteCents)} NTE.`, actions };
}

function evalProposalBeforeParts(f: FmFacts): FmOutcome | null {
  if (f.nteCents === null || f.nteCents === undefined || f.totalCents === null || f.totalCents === undefined) {
    return { status: "action", message: "The NTE or the projected total is missing, so the parts check cannot run.",
      actions: [fixAction("Enter the NTE and the projected total before ordering parts.", { kind: "enter_nte", label: "Enter NTE", oneClick: false })] };
  }
  if (!f.partsCents || f.partsCents <= 0) return null;
  if (f.totalCents <= f.nteCents) return { status: "pass", message: `Projected ${fmMoney(f.totalCents)} stays within the ${fmMoney(f.nteCents)} NTE.` };
  if (f.proposalStatus === "approved") return { status: "pass", message: "Projected cost exceeds the NTE, but the proposal is approved." };
  if (f.proposalStatus === "pending") {
    return { status: "fail", message: `Projected ${fmMoney(f.totalCents)} exceeds the ${fmMoney(f.nteCents)} NTE and the proposal is not approved yet.`,
      actions: [fixAction("Hold the parts order until the proposal is approved.", { kind: "wait_for_approval", label: "Wait for proposal approval", oneClick: false })] };
  }
  return { status: "fail", message: `Projected ${fmMoney(f.totalCents)} exceeds the ${fmMoney(f.nteCents)} NTE and no proposal is approved.`,
    actions: [fixAction("Submit a proposal and order parts only after it is approved.", { kind: "create_proposal", label: "Create proposal", oneClick: false })] };
}

function evalWindow(p: Record<string, unknown>, f: FmFacts, at: Date, mode: "deadline" | "ineligible"): FmOutcome {
  const tz = tzOf(f);
  const received = p.anchor === "work_received";
  const anchorKey = fmDayKey(received ? f.workReceivedAt : f.workConfirmedAt, tz);
  if (!anchorKey) {
    const what = received ? "received" : "Completed/Confirmed";
    return { status: "action", message: `The ${what} date is missing, so the day-count rule cannot be checked.`,
      actions: [fixAction(`Enter the date the work order was ${what === "received" ? "received" : "marked Completed/Confirmed"}.`, { kind: "enter_confirmed_date", label: "Enter date", oneClick: false })] };
  }
  const days = p.days as number;
  const warn = isInt(p.warnDays) ? p.warnDays : 3;
  const endKey = fmAddDays(anchorKey, days);
  const left = fmDayDiff(zonedParts(at, tz).dateKey, endKey);
  const what = mode === "deadline" ? "Invoice window" : "Eligibility window";
  if (left < 0) {
    const late = -left;
    return mode === "deadline"
      ? { status: "fail", message: `${what} of ${days} days closed on ${endKey} (${late} day${late === 1 ? "" : "s"} ago).`,
          actions: [fixAction("Submit now and ask the customer to accept a late invoice.", { kind: "contact_client", label: "Contact customer", oneClick: false })] }
      : { status: "fail", message: `More than ${days} days since the work order was ${received ? "received" : "completed"} (limit passed ${endKey}) — it is likely ineligible for billing.`,
          actions: [fixAction("Ask the customer whether an exception is possible.", { kind: "contact_client", label: "Contact customer", oneClick: false })] };
  }
  if (left <= warn) {
    return { status: "action", message: `${what} of ${days} days closes ${endKey} (${left === 0 ? "today" : `in ${left} day${left === 1 ? "" : "s"}`}).` };
  }
  return { status: "pass", message: `${what} of ${days} days closes ${endKey} (${left} days left).` };
}

function evalProhibited(p: Record<string, unknown>, f: FmFacts): FmOutcome | null {
  const scope = p.appliesWhenBilling as "portal" | "customer" | undefined;
  if (scope && !f.billingParty) {
    return { status: "action", message: "Who this invoice is billed to is not recorded, so the line-item rule cannot be checked.",
      actions: [fixAction("Record whether you bill the portal or the customer directly.", { kind: "confirm_billing_party", label: "Confirm billing party", oneClick: false })] };
  }
  if (scope && f.billingParty !== scope) return null;
  const banned = new Set(p.categories as string[]);
  const hits = (f.lineItems ?? []).map((it, index) => ({ it, index })).filter(({ it }) => banned.has(it.category) && it.amountCents !== 0);
  if (hits.length === 0) return { status: "pass", message: "No prohibited line items." };
  return {
    status: "fail",
    message: `Prohibited line item${hits.length === 1 ? "" : "s"}: ${hits.map(({ it }) => `${it.label?.trim() || it.category.replace(/_/g, " ")} (${fmMoney(it.amountCents)})`).join(", ")}.`,
    actions: hits.map(({ it, index }) =>
      fixAction(`Remove ${it.label?.trim() || it.category.replace(/_/g, " ")} (${fmMoney(it.amountCents)}).`,
        { kind: "remove_line_item", label: "Remove line", oneClick: true, params: { index } })),
  };
}

function evalSingleInvoice(f: FmFacts): FmOutcome {
  const n = f.existingInvoiceCount ?? 0;
  if (n < 1) return { status: "pass", message: "No other invoice exists for this work order." };
  return { status: "fail", message: `${n} invoice${n === 1 ? "" : "s"} already exist${n === 1 ? "s" : ""} for this work order; the portal accepts one.`,
    actions: [fixAction("Add the charges to the existing invoice instead of creating another.", { kind: "merge_into_existing_invoice", label: "Use existing invoice", oneClick: false })] };
}

function evalAttachment(p: Record<string, unknown>, f: FmFacts): FmOutcome | null {
  if ((p.condition ?? "always") === "has_subcontractor" && !f.hasSubcontractor) return null;
  const kind = p.attachment as string;
  const label = String(p.label).trim();
  if ((f.attachments ?? []).includes(kind)) return { status: "pass", message: `${label} is attached.` };
  return { status: "action", message: `${label} is missing.`,
    actions: [fixAction(`Attach: ${label}.`, { kind: "attach_file", label: "Attach file", oneClick: false, params: { attachment: kind } })] };
}
