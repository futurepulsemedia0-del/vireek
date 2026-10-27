// Pure helpers for split-payer PaymentIntents (several payers on one invoice).
// No imports and no runtime APIs: shared by the Deno edge functions and vitest. Keep it that way.

export const SPLIT_FLOW = "split_v1";

export interface SplitMetadataInput {
  payerId: string;
  invoiceId: string;
  userId: string;
  amountCents: number;
}

/** Server-set metadata on every split PaymentIntent; the webhook trusts only these keys. */
export function buildSplitIntentMetadata(input: SplitMetadataInput): Record<string, string> {
  return {
    flow: SPLIT_FLOW,
    split_payer_id: input.payerId,
    invoice_id: input.invoiceId,
    user_id: input.userId,
    base_cents: String(input.amountCents),
  };
}

/** True for a PaymentIntent created by the split pay page. */
export function isSplitIntent(pi: any): boolean {
  return pi?.metadata?.flow === SPLIT_FLOW && typeof pi?.metadata?.split_payer_id === "string" && pi.metadata.split_payer_id.length > 0;
}

export function splitIntentDescription(businessName: string | null | undefined, invoiceNumber: string, payerName: string): string {
  const business = businessName?.trim() ? ` from ${businessName.trim()}` : "";
  return `Invoice ${invoiceNumber}${business} (share of ${payerName})`.slice(0, 500);
}
