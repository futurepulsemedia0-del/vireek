// supabase/functions/_shared/portal/adapter.ts
// Channel adapter contract. No vendor is claimed to be supported: every real adapter needs [VERIFY] against vendor docs.
import type { PortalState } from "./stateMachine.ts";

export interface AdapterCapabilities {
  id: string;
  submit: boolean;
  status: "poll" | "webhook" | "none";
  remittance: boolean;
  verified_against_vendor: false; // literal false until someone verifies a real vendor
}
export interface PortalPacket {
  invoice_id: string;
  invoice_number: string;
  po_number: string | null;
  total_cents: number;
  currency: string;
  issue_date: string;   // YYYY-MM-DD
  due_date: string | null;
  supplier: { name: string; tax_id?: string | null };
  buyer: { name: string };
  lines: { description: string; quantity: number; unit_cents: number }[];
  attachments: { name: string; sha256: string; bytes: number }[];
  fields: Record<string, string>;
}
export interface ValidationIssue { field: string; code: string; message: string }
export interface SubmitResult { ok: boolean; reference?: string; retryable: boolean; error?: string }
export interface StatusResult { ok: boolean; rawStatus?: string; state?: PortalState; rejectionReason?: string; retryable: boolean; error?: string }
export interface RemittanceLine { invoice_number: string; amount_cents: number; confidence: number }
export interface ParsedRemittance { payment_ref: string | null; paid_on: string | null; currency: string | null; lines: RemittanceLine[]; method: "rule" | "ai_assisted"; requires_confirmation: boolean }

export interface PortalAdapter {
  capabilities(): AdapterCapabilities;
  validate(packet: PortalPacket): ValidationIssue[];
  submit(packet: PortalPacket, idempotencyKey: string): Promise<SubmitResult>;
  getStatus(ref: string): Promise<StatusResult>;
  parseRemittance(doc: string): ParsedRemittance;
}

/** Shared validation every adapter starts from. */
export function baseValidate(p: PortalPacket): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const need = (ok: boolean, field: string, code: string, message: string) => { if (!ok) out.push({ field, code, message }); };
  need(p.invoice_number.trim().length > 0, "invoice_number", "required", "Invoice number is required.");
  need(Number.isInteger(p.total_cents) && p.total_cents > 0, "total_cents", "positive_integer", "Total must be a positive integer number of cents.");
  need(/^[A-Z]{3}$/.test(p.currency), "currency", "iso4217", "Currency must be a 3-letter ISO code.");
  need(/^\d{4}-\d{2}-\d{2}$/.test(p.issue_date), "issue_date", "date", "Issue date must be YYYY-MM-DD.");
  need(p.lines.length > 0, "lines", "required", "At least one line item is required.");
  const sum = p.lines.reduce((a, l) => a + Math.round(l.quantity * l.unit_cents), 0);
  need(sum <= p.total_cents, "lines", "sum_exceeds_total", "Line items exceed the invoice total.");
  need(p.attachments.length > 0, "attachments", "required", "The invoice packet needs at least one attachment.");
  return out;
}
