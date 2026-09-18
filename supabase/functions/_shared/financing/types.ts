// supabase/functions/_shared/financing/types.ts

export type FinancingProviderId = "wisetack";

export type FinancingOfferStatus =
  | "created"
  | "sent"
  | "clicked"
  | "applied"
  | "approved"
  | "declined"
  | "expired"
  | "loan_confirmed"
  | "funded"
  | "canceled";

export interface CreateFinancingOfferParams {
  externalMerchantId: string;
  amountCents: number;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  /** Shown to the customer inside the provider's hosted flow. */
  description: string;
  /** Where the provider should redirect/notify once a decision is made. */
  successUrl: string;
  cancelUrl: string;
  /** Idempotency / correlation key — pass financing_offers.id. */
  referenceId: string;
}

export interface CreateFinancingOfferResult {
  externalTransactionId: string;
  applicationUrl: string;
}

export interface FinancingWebhookEvent {
  externalTransactionId: string;
  eventType: string;
  status: FinancingOfferStatus;
  approvedAmountCents?: number;
  aprBps?: number;
  termMonths?: number;
  declineReason?: string;
}

/**
 * Common interface every BNPL provider adapter implements — same shape
 * as the ai-core ProviderAdapter pattern, so adding a second provider
 * (Sunbit, Service Finance, ...) later never touches the edge functions
 * that call this, only the registry below.
 */
export interface FinancingProviderAdapter {
  readonly id: FinancingProviderId;
  isConfigured(): boolean;
  createOffer(params: CreateFinancingOfferParams): Promise<CreateFinancingOfferResult>;
  verifyWebhookSignature(payload: string, headers: Headers): Promise<boolean>;
  parseWebhookEvent(payload: string): FinancingWebhookEvent | null;
}
