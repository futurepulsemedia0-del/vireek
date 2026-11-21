// supabase/functions/_shared/bank/provider/types.ts
//
// Provider-neutral contract for bank-data aggregators (Plaid today; MX / Finicity / Teller are
// candidates listed in docs/vendor-exit/plaid.md — none is implemented or evaluated).
// Everything above this seam (sync.ts, bank-intelligence, bank-webhook) must only see these types.
//
// Money: integer cents, signed from the BUSINESS point of view (positive = money IN).
// Adapters own the sign convention of their vendor; callers never invert amounts.

export type ProviderId = "plaid" | "mx" | "finicity" | "mock";

/** What a failure MEANS for us, independent of the vendor's own error vocabulary. */
export type ProviderErrorKind =
  | "auth_required"        // the END USER must re-authenticate at their bank (item-specific)
  | "rate_limited"         // vendor throttled us (provider-wide signal)
  | "provider_unavailable" // network / 5xx / timeout (provider-wide signal)
  | "product_not_ready"    // history still being prepared; retry later (item-specific)
  | "institution_unavailable" // ONE bank is down/unreachable; the aggregator itself is fine (item-specific)
  | "pagination_mutation"  // cursor invalidated mid-pagination; restart the page loop
  | "invalid_request"      // our bug or bad input; retrying will not help
  | "not_configured"       // missing credentials on this deployment
  | "unknown";

export class BankProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    public readonly code: string,
    message: string,
    public readonly provider: ProviderId,
    public readonly status = 0,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "BankProviderError";
  }
}

/** Kinds that say something about the PROVIDER's health (as opposed to one user's bank login). */
export const HEALTH_AFFECTING_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  "provider_unavailable",
  "rate_limited",
  "unknown",
]);

export interface NormalizedAccount {
  providerAccountId: string;
  name: string;
  mask: string | null;
  type: string;            // depository | credit | loan | investment | other
  subtype: string | null;
  currency: string;
  currentBalanceCents: number | null;
  availableBalanceCents: number | null;
}

export interface NormalizedTransaction {
  providerTxnId: string;
  providerAccountId: string;
  postedDate: string;      // YYYY-MM-DD
  amountCents: number;     // business perspective: + in, − out
  currency: string;
  description: string;
  merchantName: string | null;
  category: string | null;
  pending: boolean;
  supersedesPendingId: string | null;
}

export interface TransactionPage {
  added: NormalizedTransaction[];
  modified: NormalizedTransaction[];
  removedIds: string[];
  nextCursor: string;
  hasMore: boolean;
}

export type NormalizedWebhookEvent =
  | { kind: "transactions_updated"; itemId: string }
  | { kind: "login_required"; itemId: string }
  | { kind: "login_repaired"; itemId: string }
  | { kind: "ignored"; itemId: string | null };

export interface LinkTokenInput {
  ownerId: string;
  webhookUrl: string;
  /** Present for update-mode (re-authentication of an existing link). */
  accessToken?: string;
  historyDays?: number;
}

/** The only surface the rest of Vireek may use to talk to an aggregator. */
export interface BankDataProvider {
  readonly id: ProviderId;
  isConfigured(): boolean;
  createLinkToken(input: LinkTokenInput): Promise<{ linkToken: string }>;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  getAccounts(accessToken: string): Promise<NormalizedAccount[]>;
  /** One page. Callers loop while `hasMore`. */
  syncTransactions(accessToken: string, cursor: string | null): Promise<TransactionPage>;
  removeItem(accessToken: string): Promise<void>;
  verifyWebhook(rawBody: string, signatureHeader: string | null): Promise<boolean>;
  parseWebhook(rawBody: string): NormalizedWebhookEvent | null;
}

/** Operation names used for metering. Keep in sync with the CHECK in the migration. */
export type MeteredOperation =
  | "link_token"
  | "exchange"
  | "accounts"
  | "transactions_page"
  | "remove_item"
  | "webhook_verify";
