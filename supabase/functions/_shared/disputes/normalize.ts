// Pure helpers for Stripe dispute events — no Deno/Node APIs, so they are unit-testable under vitest.

export const HANDLED_DISPUTE_EVENTS = [
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
] as const;

export function isHandledDisputeEvent(type: unknown): boolean {
  return typeof type === "string" && (HANDLED_DISPUTE_EVENTS as readonly string[]).includes(type);
}

export interface NormalizedDispute {
  stripe_dispute_id: string;
  stripe_charge_id: string | null;
  stripe_payment_intent_id: string | null;
  amount_cents: number;
  currency: string;
  reason: string | null;
  network_reason_code: string | null;
  status: string;
  is_charge_refundable: boolean | null;
  evidence_due_by: number | null; // unix seconds
  has_evidence: boolean;
  past_due: boolean;
  submission_count: number;
  net_balance_cents: number;
  opened_at: number; // unix seconds
}

const idOf = (v: unknown): string | null =>
  typeof v === "string" && v ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null;

/** Maps a Stripe Dispute object to the flat shape consumed by apply_stripe_dispute_event(). Throws on a malformed object. */
export function normalizeDispute(obj: any): NormalizedDispute {
  if (!obj || typeof obj.id !== "string" || typeof obj.status !== "string") throw new Error("Malformed dispute object");
  const details = obj.evidence_details ?? {};
  const balance = Array.isArray(obj.balance_transactions) ? obj.balance_transactions : [];
  return {
    stripe_dispute_id: obj.id,
    stripe_charge_id: idOf(obj.charge),
    stripe_payment_intent_id: idOf(obj.payment_intent),
    amount_cents: Number.isFinite(obj.amount) ? Math.max(0, Math.trunc(obj.amount)) : 0,
    currency: typeof obj.currency === "string" && obj.currency ? obj.currency.toLowerCase() : "usd",
    reason: typeof obj.reason === "string" ? obj.reason : null,
    network_reason_code: obj.payment_method_details?.card?.network_reason_code ?? null,
    status: obj.status,
    is_charge_refundable: typeof obj.is_charge_refundable === "boolean" ? obj.is_charge_refundable : null,
    evidence_due_by: Number.isFinite(details.due_by) ? details.due_by : null,
    has_evidence: !!details.has_evidence,
    past_due: !!details.past_due,
    submission_count: Number.isFinite(details.submission_count) ? details.submission_count : 0,
    net_balance_cents: balance.reduce((sum: number, bt: any) => sum + (Number.isFinite(bt?.net) ? bt.net : 0), 0),
    opened_at: Number.isFinite(obj.created) ? obj.created : Math.floor(Date.now() / 1000),
  };
}

export const EVIDENCE_TEXT_FIELDS = [
  "product_description", "customer_name", "customer_email_address", "billing_address", "service_date",
  "uncategorized_text", "cancellation_rebuttal", "refund_refusal_explanation", "duplicate_charge_explanation", "access_activity_log",
] as const;

export const EVIDENCE_FILE_FIELDS = [
  "receipt", "customer_communication", "service_documentation", "customer_signature",
  "cancellation_policy", "refund_policy", "duplicate_charge_documentation", "uncategorized_file",
] as const;

/** Builds the `evidence` payload for POST /v1/disputes/:id from the saved draft + uploaded Stripe file ids. Empty values are dropped. */
export function buildStripeEvidence(
  draft: Record<string, unknown>,
  files: { category: string; stripe_file_id: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of EVIDENCE_TEXT_FIELDS) {
    const v = draft[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  // Stripe accepts ONE file per evidence field: the most recent upload wins; the rest should be merged into one PDF by the user.
  for (const f of files) {
    if ((EVIDENCE_FILE_FIELDS as readonly string[]).includes(f.category)) out[f.category] = f.stripe_file_id;
  }
  return out;
}
