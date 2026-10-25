// supabase/functions/_shared/pay/types.ts
//
// Shared contracts for Vireek Pay & Capital. Pure types: safe to import anywhere.
// The PROVIDER BOUNDARY is the three adapter interfaces at the bottom — everything above
// them (controls, ledger, policy, eligibility) is implemented in this repo; everything
// below them (moving money, issuing cards, underwriting) belongs to a licensed partner.

export type PayProduct = "instant_payouts" | "earned_wage_access" | "spend_cards" | "capital";
export type PayMode = "sandbox" | "live";

export const PAY_PRODUCTS: readonly PayProduct[] = ["instant_payouts", "earned_wage_access", "spend_cards", "capital"];

/** Result of pay_product_state(): the single answer to "may this tenant use this product?" */
export interface ProductState {
  available: boolean;
  product: PayProduct;
  mode: PayMode;
  /** null when available; otherwise a stable machine code. */
  reason: ProductUnavailableReason | null;
  partner_name?: string | null;
  fee_bps?: number;
  min_fee_cents?: number;
  max_fee_cents?: number;
  max_single_cents?: number;
  max_daily_tenant_cents?: number;
  max_pct_of_accrued?: number;
  config?: Record<string, unknown>;
}

export type ProductUnavailableReason =
  | "killed"
  | "platform_disabled"
  | "tenant_frozen"
  | "disclosures_not_reviewed"
  | "unknown_product"
  | "no_tenant";

export type TransferKind = "instant_payout" | "earned_wage_advance";
export type TransferStatus = "pending_provider" | "processing" | "paid" | "failed" | "needs_review" | "reversed" | "canceled";

/** Thrown by adapters BEFORE anything is sent (safe to mark the transfer failed). */
export class ProviderBoundaryError extends Error {
  constructor(public readonly code: ProviderErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ProviderBoundaryError";
  }
}
export type ProviderErrorCode = "provider_not_configured" | "not_supported_in_mode" | "invalid_request";

// ---------------------------------------------------------------------------
// Payouts (instant payout + EWA funding) — licensed payment partner
// ---------------------------------------------------------------------------
export interface PayoutRequest {
  /** Our pay_transfers.id — the partner's idempotency key. */
  referenceId: string;
  amountCents: number;
  currency: "usd";
  destinationAccountId: string;
  instant: boolean;
  description: string;
}
export interface PayoutResult {
  status: "paid" | "processing" | "failed";
  externalId: string;
  failureCode?: string;
  sandbox: boolean;
}
export interface PayoutProvider {
  readonly id: string;
  readonly mode: PayMode;
  isConfigured(): boolean;
  createPayout(req: PayoutRequest): Promise<PayoutResult>;
  verifyWebhookSignature(payload: string, headers: Headers): Promise<boolean>;
  parseWebhookEvent(payload: string): PayoutWebhookEvent | null;
}
export interface PayoutWebhookEvent {
  externalId: string;
  status: "processing" | "paid" | "failed" | "reversed";
  failureCode?: string;
}

// ---------------------------------------------------------------------------
// Card issuing — licensed issuer / program manager
// ---------------------------------------------------------------------------
export interface IssueCardRequest {
  referenceId: string;
  holderName: string;
  cardType: "virtual" | "physical";
}
export interface IssuedCard {
  externalCardId: string;
  last4: string;
  brand: string;
  sandbox: boolean;
}
export interface CardAuthorizationEvent {
  externalAuthId: string;
  externalCardId: string;
  amountCents: number;
  currency: string;
  merchantName: string | null;
  mcc: string | null;
}
export interface CardIssuer {
  readonly id: string;
  readonly mode: PayMode;
  isConfigured(): boolean;
  issueCard(req: IssueCardRequest): Promise<IssuedCard>;
  setCardStatus(externalCardId: string, status: "active" | "frozen" | "canceled"): Promise<void>;
  verifyWebhookSignature(payload: string, headers: Headers): Promise<boolean>;
  parseAuthorizationEvent(payload: string): CardAuthorizationEvent | null;
}

// ---------------------------------------------------------------------------
// Lending — licensed lending partner. The partner DECIDES. Vireek only relays.
// ---------------------------------------------------------------------------
export interface LendingDataPackage {
  requestedAmountCents: number;
  business: { trailing12mCents: number; trailing3mCents: number; monthsOfHistory: number; paidInvoiceCount12m: number };
  receivables: { invoiceId: string; customerRef: string; amountCents: number; dueDate: string | null; issuedAt: string }[];
}
export interface PartnerOffer {
  externalOfferId: string;
  offeredAmountCents: number;
  totalRepaymentCents: number;
  financeChargeCents: number;
  termDays: number;
  estimatedAprBps: number;
  repaymentDescription: string;
  termsUrl: string | null;
  expiresAt: string;
}
export interface LendingSubmitResult {
  externalApplicationId: string;
  outcome: "offers" | "declined" | "pending";
  offers: PartnerOffer[];
  /** Partner-supplied, shown to the applicant as-is. */
  declineReasons?: string[];
  sandbox: boolean;
}
export interface LendingPartner {
  readonly id: string;
  readonly mode: PayMode;
  isConfigured(): boolean;
  submitApplication(referenceId: string, pkg: LendingDataPackage): Promise<LendingSubmitResult>;
  acceptOffer(externalApplicationId: string, externalOfferId: string): Promise<{ status: "accepted" | "funded"; sandbox: boolean }>;
  withdrawApplication(externalApplicationId: string): Promise<void>;
  verifyWebhookSignature(payload: string, headers: Headers): Promise<boolean>;
}
