// supabase/functions/_shared/bank/provider/plaidProvider.ts
//
// Plaid implementation of BankDataProvider. Wraps the existing thin client in ../plaid.ts (unchanged)
// and is the ONLY place that knows Plaid's field names, sign convention and error codes.
//
// [VERIFY] Plaid error-code → kind mapping below was written from the codes already used in this
// repo (ITEM_LOGIN_REQUIRED, PENDING_EXPIRATION, PRODUCT_NOT_READY, TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION)
// plus HTTP semantics. The INSTITUTION_* handling is NOT confirmed against current Plaid documentation.

import { getPlaid, PlaidError, plaidConfigured, verifyPlaidWebhook, type Plaid, type PlaidAccount, type PlaidSyncPage, type PlaidTxn } from "../plaid.ts";
import {
  BankProviderError,
  type BankDataProvider,
  type LinkTokenInput,
  type NormalizedAccount,
  type NormalizedTransaction,
  type NormalizedWebhookEvent,
  type TransactionPage,
} from "./types.ts";

export function mapPlaidError(e: unknown): BankProviderError {
  if (e instanceof BankProviderError) return e;
  if (!(e instanceof PlaidError)) return new BankProviderError("unknown", "UNCLASSIFIED", e instanceof Error ? e.message : String(e), "plaid");
  const mk = (kind: BankProviderError["kind"]) => new BankProviderError(kind, e.code, e.message, "plaid", e.status);
  if (e.code === "NOT_CONFIGURED") return mk("not_configured");
  if (e.code === "NETWORK" || e.status === 0 || e.status >= 500) return mk("provider_unavailable");
  if (e.status === 429 || e.type === "RATE_LIMIT_EXCEEDED" || e.code === "RATE_LIMIT_EXCEEDED") return mk("rate_limited");
  if (e.code === "ITEM_LOGIN_REQUIRED" || e.code === "PENDING_EXPIRATION") return mk("auth_required");
  if (e.code === "PRODUCT_NOT_READY") return mk("product_not_ready");
  if (e.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") return mk("pagination_mutation");
  if (e.type === "INSTITUTION_ERROR" || e.code.startsWith("INSTITUTION_")) return mk("institution_unavailable"); // [VERIFY]
  if (e.status >= 400) return mk("invalid_request");
  return mk("unknown");
}

/** Plaid: positive = money OUT. Business perspective is the inverse. `|| 0` normalises -0. */
const toCents = (plaidAmount: number): number => -Math.round(Number(plaidAmount) * 100) || 0;
const balCents = (n: number | null | undefined): number | null => (typeof n === "number" ? Math.round(n * 100) : null);

export function normalizePlaidAccount(a: PlaidAccount): NormalizedAccount {
  return {
    providerAccountId: a.account_id,
    name: String(a.name || a.official_name || "Account").slice(0, 120),
    mask: a.mask ?? null,
    type: a.type ?? "depository",
    subtype: a.subtype ?? null,
    currency: a.balances?.iso_currency_code ?? "USD",
    currentBalanceCents: balCents(a.balances?.current),
    availableBalanceCents: balCents(a.balances?.available ?? a.balances?.current),
  };
}

export function normalizePlaidTxn(t: PlaidTxn): NormalizedTransaction {
  return {
    providerTxnId: String(t.transaction_id),
    providerAccountId: t.account_id,
    postedDate: t.date,
    amountCents: toCents(t.amount),
    currency: t.iso_currency_code ?? "USD",
    description: String(t.name ?? "").slice(0, 300),
    merchantName: t.merchant_name ? String(t.merchant_name).slice(0, 120) : null,
    category: t.personal_finance_category?.primary ?? null,
    pending: !!t.pending,
    supersedesPendingId: t.pending_transaction_id ?? null,
  };
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { throw mapPlaidError(e); }
}

/** `client` is lazy so that constructing the provider never throws on a deployment without credentials. */
export function createPlaidProvider(client: () => Plaid = getPlaid): BankDataProvider {
  return {
    id: "plaid",
    isConfigured: () => plaidConfigured(),

    createLinkToken: (i: LinkTokenInput) => wrap(async () => {
      const payload: Record<string, unknown> = {
        client_name: "Vireek", language: "en", country_codes: ["US"],
        user: { client_user_id: i.ownerId }, webhook: i.webhookUrl,
      };
      if (i.accessToken) payload.access_token = i.accessToken; // update mode (re-authentication)
      else { payload.products = ["transactions"]; payload.transactions = { days_requested: i.historyDays ?? 365 }; }
      const r = await client().post<{ link_token: string }>("/link/token/create", payload);
      return { linkToken: r.link_token };
    }),

    exchangePublicToken: (publicToken: string) => wrap(async () => {
      const r = await client().post<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: publicToken });
      return { accessToken: r.access_token, itemId: r.item_id };
    }),

    getAccounts: (accessToken: string) => wrap(async () => {
      const r = await client().post<{ accounts?: PlaidAccount[] }>("/accounts/get", { access_token: accessToken });
      return (r.accounts ?? []).map(normalizePlaidAccount);
    }),

    syncTransactions: (accessToken: string, cursor: string | null) => wrap(async (): Promise<TransactionPage> => {
      const r = await client().post<PlaidSyncPage>("/transactions/sync", { access_token: accessToken, ...(cursor ? { cursor } : {}), count: 500 });
      return {
        added: (r.added ?? []).map(normalizePlaidTxn),
        modified: (r.modified ?? []).map(normalizePlaidTxn),
        removedIds: (r.removed ?? []).map((x) => String(x.transaction_id)),
        nextCursor: r.next_cursor,
        hasMore: !!r.has_more,
      };
    }),

    removeItem: (accessToken: string) => wrap(async () => { await client().post("/item/remove", { access_token: accessToken }); }),

    verifyWebhook: async (rawBody: string, sig: string | null) => {
      try { return await verifyPlaidWebhook(client(), rawBody, sig); } catch { return false; }
    },

    parseWebhook: (rawBody: string): NormalizedWebhookEvent | null => {
      // deno-lint-ignore no-explicit-any
      let e: any;
      try { e = JSON.parse(rawBody); } catch { return null; }
      const itemId = typeof e?.item_id === "string" ? e.item_id : null;
      if (!itemId) return { kind: "ignored", itemId: null };
      const type = e.webhook_type, code = e.webhook_code;
      if (type === "TRANSACTIONS" && code === "SYNC_UPDATES_AVAILABLE") return { kind: "transactions_updated", itemId };
      if (type === "ITEM" && (code === "PENDING_EXPIRATION" || code === "USER_PERMISSION_REVOKED" || (code === "ERROR" && e.error?.error_code === "ITEM_LOGIN_REQUIRED"))) return { kind: "login_required", itemId };
      if (type === "ITEM" && code === "LOGIN_REPAIRED") return { kind: "login_repaired", itemId };
      return { kind: "ignored", itemId };
    },
  };
}
