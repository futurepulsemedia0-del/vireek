// supabase/functions/_shared/bank/types.ts
//
// Shared types for Bank Intelligence. Money is ALWAYS integer cents.
// Transaction amounts are signed from the business's point of view:
// positive = money IN, negative = money OUT.

export type MatchKind = "ar" | "ap" | "ar_payment" | "ap_payment";

export type MatchMethod =
  | "reference"
  | "exact_single"
  | "subset_unique"
  | "subset_ambiguous"
  | "partial"
  | "linked_payment"
  | "processor_fee";

export interface MatchTxn {
  id: string;
  amountCents: number;
  postedDate: string; // YYYY-MM-DD
  name: string;
  merchantKey: string | null;
}

export interface OpenInvoice {
  id: string;
  number: string;
  customerId: string | null;
  customerName: string | null;
  balanceCents: number;
  dueDate: string;
}

export interface OpenBill {
  id: string;
  number: string;
  vendorId: string | null;
  vendorName: string | null;
  balanceCents: number;
  dueDate: string;
}

/** A payment someone already recorded by hand in the books, not yet confirmed against a bank line. */
export interface UnlinkedPayment {
  id: string;
  kind: "ar" | "ap";
  amountCents: number;
  paymentDate: string;
  partyName: string | null;
}

export interface MatchItem {
  invoiceId?: string;
  billId?: string;
  paymentId?: string;
  amountCents: number;
  label: string;
}

export interface MatchSuggestion {
  kind: MatchKind;
  method: MatchMethod;
  confidence: number; // 0..1
  explanation: string;
  matchedCents: number;
  feeCents: number;
  unmatchedCents: number;
  items: MatchItem[];
}

export interface MatchContext {
  invoices: OpenInvoice[];
  bills: OpenBill[];
  unlinkedPayments: UnlinkedPayment[];
}

export type AutopilotLevel = "review" | "assisted" | "full";
