// supabase/functions/_shared/partner-commission/stripeMapping.ts
//
// Pure mapping from Stripe objects to the arguments of the partner-commission RPCs
// (20290303000100_affiliate_commission_ledger.sql). No Deno or Stripe SDK imports on purpose,
// so vitest covers it without mocks. All money is integer cents; the database does the maths.

export type IdOrObject = string | { id: string } | null | undefined;

export function idOf(v: IdOrObject): string | null {
  if (typeof v === "string") return v.length > 0 ? v : null;
  if (v && typeof v === "object" && typeof v.id === "string" && v.id.length > 0) return v.id;
  return null;
}

export interface InvoiceLike {
  id: string;
  customer?: IdOrObject;
  subscription?: IdOrObject;
  amount_paid: number;
  tax?: number | null;
  currency: string;
  created?: number;
  status_transitions?: { paid_at?: number | null } | null;
}

export interface EarnRpcArgs {
  p_customer_id: string;
  p_invoice_id: string;
  p_amount_paid_cents: number;
  p_tax_cents: number;
  p_currency: string;
  p_paid_at: string;
}

/** Only PAID SUBSCRIPTION invoices earn commission; $0 (trial) invoices and one-off invoices return null. */
export function invoiceToEarnArgs(inv: InvoiceLike): EarnRpcArgs | null {
  const customer = idOf(inv.customer);
  if (!customer || !inv.id || !idOf(inv.subscription)) return null;
  if (!Number.isInteger(inv.amount_paid) || inv.amount_paid <= 0) return null;
  const tax = Number.isInteger(inv.tax) && (inv.tax as number) > 0 ? (inv.tax as number) : 0;
  const seconds = inv.status_transitions?.paid_at ?? inv.created ?? Math.floor(Date.now() / 1000);
  return {
    p_customer_id: customer,
    p_invoice_id: inv.id,
    p_amount_paid_cents: inv.amount_paid,
    p_tax_cents: Math.min(tax, inv.amount_paid),
    p_currency: String(inv.currency ?? "").toLowerCase(),
    p_paid_at: new Date(seconds * 1000).toISOString(),
  };
}

export interface ChargeLike {
  id: string;
  invoice?: IdOrObject;
  amount: number;
  amount_refunded: number;
}

export interface ClawbackRpcArgs {
  p_event_id: string;
  p_invoice_id: string;
  p_source_kind: "refund" | "dispute";
  p_source_ref: string;
  p_refunded_cents: number;
  p_charge_amount_cents: number;
  p_reason: string;
}

/** charge.refunded -> pro-rata clawback. amount_refunded is cumulative; the RPC computes the delta. */
export function chargeRefundToClawbackArgs(eventId: string, charge: ChargeLike): ClawbackRpcArgs | null {
  const invoice = idOf(charge.invoice);
  if (!eventId || !invoice) return null;
  if (!(charge.amount > 0) || !(charge.amount_refunded > 0)) return null;
  return {
    p_event_id: eventId,
    p_invoice_id: invoice,
    p_source_kind: "refund",
    p_source_ref: charge.id,
    p_refunded_cents: Math.min(charge.amount_refunded, charge.amount),
    p_charge_amount_cents: charge.amount,
    p_reason: "refund",
  };
}

export interface DisputeLike {
  id: string;
  status?: string | null;
  charge?: IdOrObject;
}

/** charge.dispute.created -> full clawback of whatever commission is left for that invoice. `charge` is the retrieved charge. */
export function disputeToClawbackArgs(eventId: string, dispute: DisputeLike, charge: ChargeLike | null): ClawbackRpcArgs | null {
  const invoice = charge ? idOf(charge.invoice) : null;
  if (!eventId || !dispute.id || !invoice) return null;
  return {
    p_event_id: eventId,
    p_invoice_id: invoice,
    p_source_kind: "dispute",
    p_source_ref: dispute.id,
    p_refunded_cents: 0,
    p_charge_amount_cents: 0,
    p_reason: "dispute",
  };
}

export interface ReinstatementRpcArgs {
  p_event_id: string;
  p_invoice_id: string;
  p_source_ref: string;
  p_reason: string;
}

/** charge.dispute.closed with status "won" -> give the clawed-back commission back. Any other outcome returns null. */
export function disputeToReinstatementArgs(eventId: string, dispute: DisputeLike, charge: ChargeLike | null): ReinstatementRpcArgs | null {
  const invoice = charge ? idOf(charge.invoice) : null;
  if (!eventId || !dispute.id || !invoice || dispute.status !== "won") return null;
  return { p_event_id: eventId, p_invoice_id: invoice, p_source_ref: dispute.id, p_reason: "dispute won" };
}
