// Pure refund rules shared by the issue-refund edge function and its tests.
// No Deno/Supabase imports here on purpose so Vitest can run this file as-is.

export const REASON_CODES = [
  "duplicate_charge",
  "service_not_completed",
  "quality_issue",
  "pricing_adjustment",
  "customer_cancelled",
  "goodwill",
  "fraudulent",
  "other",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const MAX_REFUND_CENTS = 99_999_999; // stays below the ledger's 32-bit line limit
export const MAX_NOTE_LENGTH = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

export interface IssueRefundInput {
  paymentRequestId: string;
  amountCents: number;
  reasonCode: ReasonCode;
  reasonNote: string | null;
  notifyCustomer: boolean;
  idempotencyKey: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseIssueInput(body: unknown): ParseResult<IssueRefundInput> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  if (typeof b.payment_request_id !== "string" || !UUID_RE.test(b.payment_request_id)) {
    return { ok: false, error: "A valid payment_request_id is required." };
  }
  const amount = b.amount_cents;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    return { ok: false, error: "Refund amount must be a whole number of cents greater than zero." };
  }
  if (amount > MAX_REFUND_CENTS) return { ok: false, error: "Refund amount is too large." };

  if (typeof b.reason_code !== "string" || !(REASON_CODES as readonly string[]).includes(b.reason_code)) {
    return { ok: false, error: "Choose a valid refund reason." };
  }
  if (typeof b.idempotency_key !== "string" || !KEY_RE.test(b.idempotency_key)) {
    return { ok: false, error: "A valid idempotency_key is required." };
  }

  let note: string | null = null;
  if (b.reason_note !== undefined && b.reason_note !== null) {
    if (typeof b.reason_note !== "string") return { ok: false, error: "Note must be text." };
    // Strip control characters (newlines too — notes are a single paragraph).
    // deno-lint-ignore no-control-regex
    const cleaned = b.reason_note.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    if (cleaned.length > MAX_NOTE_LENGTH) return { ok: false, error: `Note must be ${MAX_NOTE_LENGTH} characters or fewer.` };
    note = cleaned || null;
  }
  if (b.reason_code === "other" && !note) {
    return { ok: false, error: "Add a short note when the reason is “Other”." };
  }

  return {
    ok: true,
    value: {
      paymentRequestId: b.payment_request_id.toLowerCase(),
      amountCents: amount,
      reasonCode: b.reason_code as ReasonCode,
      reasonNote: note,
      notifyCustomer: b.notify_customer !== false,
      idempotencyKey: b.idempotency_key,
    },
  };
}

/** Stripe only accepts three reason values; our finer-grained code travels in metadata. */
export function stripeReasonFor(code: ReasonCode): "duplicate" | "fraudulent" | "requested_by_customer" {
  if (code === "duplicate_charge") return "duplicate";
  if (code === "fraudulent") return "fraudulent";
  return "requested_by_customer";
}

export type RefundStatus = "pending" | "succeeded" | "failed" | "canceled";

export function mapStripeRefundStatus(status: unknown): RefundStatus {
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "canceled") return "canceled";
  return "pending"; // pending, requires_action, or anything new Stripe adds
}

/**
 * A 4xx from Stripe means the refund was definitely NOT created. Anything else
 * (network drop, 5xx, unparseable body, 409 "key in use") is ambiguous: the refund
 * may exist, so we must keep the reservation instead of releasing it.
 */
export function isAmbiguousStripeFailure(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== "number") return true;
  return status >= 500 || status === 409;
}

export function formatMoney(cents: number, currency = "usd"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}
