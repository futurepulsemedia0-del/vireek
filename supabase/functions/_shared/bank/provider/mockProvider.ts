// supabase/functions/_shared/bank/provider/mockProvider.ts
// Scriptable provider used by tests and by local development. It performs no network I/O.
import {
  BankProviderError,
  type BankDataProvider,
  type LinkTokenInput,
  type NormalizedAccount,
  type NormalizedTransaction,
  type NormalizedWebhookEvent,
  type ProviderErrorKind,
  type TransactionPage,
} from "./types.ts";

export interface MockOptions {
  accounts?: NormalizedAccount[];
  /** Pages served in order; cursor "page-N" resumes at page N. */
  pages?: Array<Pick<TransactionPage, "added" | "modified" | "removedIds">>;
  webhookSecret?: string;
}

export class MockBankProvider implements BankDataProvider {
  readonly id = "mock" as const;
  calls: Array<{ method: string; args: unknown[] }> = [];
  private failures: Array<{ kind: ProviderErrorKind; remaining: number; method?: string }> = [];
  private down = false;
  accounts: NormalizedAccount[];
  pages: NonNullable<MockOptions["pages"]>;
  private secret: string;

  constructor(o: MockOptions = {}) {
    this.accounts = o.accounts ?? [];
    this.pages = o.pages ?? [{ added: [], modified: [], removedIds: [] }];
    this.secret = o.webhookSecret ?? "mock-secret";
  }

  /** Make the next `count` calls (optionally only to `method`) fail with `kind`. */
  failNext(kind: ProviderErrorKind, count = 1, method?: string): this {
    this.failures.push({ kind, remaining: count, method });
    return this;
  }
  /** Simulate a full provider outage until `setDown(false)`. */
  setDown(down: boolean): this { this.down = down; return this; }
  callCount(method?: string): number { return this.calls.filter((c) => !method || c.method === method).length; }

  private enter(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.down) throw new BankProviderError("provider_unavailable", "MOCK_DOWN", "mock outage", "mock", 503);
    const f = this.failures.find((x) => x.remaining > 0 && (!x.method || x.method === method));
    if (f) {
      f.remaining--;
      throw new BankProviderError(f.kind, `MOCK_${f.kind.toUpperCase()}`, `mock failure: ${f.kind}`, "mock", f.kind === "provider_unavailable" ? 503 : 400);
    }
  }

  isConfigured(): boolean { return true; }
  createLinkToken(i: LinkTokenInput): Promise<{ linkToken: string }> {
    try { this.enter("createLinkToken", [i]); return Promise.resolve({ linkToken: `link-${i.ownerId}` }); } catch (e) { return Promise.reject(e); }
  }
  exchangePublicToken(t: string): Promise<{ accessToken: string; itemId: string }> {
    try { this.enter("exchangePublicToken", [t]); return Promise.resolve({ accessToken: `access-${t}`, itemId: `item-${t}` }); } catch (e) { return Promise.reject(e); }
  }
  getAccounts(t: string): Promise<NormalizedAccount[]> {
    try { this.enter("getAccounts", [t]); return Promise.resolve(this.accounts); } catch (e) { return Promise.reject(e); }
  }
  syncTransactions(t: string, cursor: string | null): Promise<TransactionPage> {
    try {
      this.enter("syncTransactions", [t, cursor]);
      const idx = cursor?.startsWith("page-") ? Number(cursor.slice(5)) : 0;
      const page = this.pages[idx] ?? { added: [], modified: [], removedIds: [] };
      const hasMore = idx + 1 < this.pages.length;
      return Promise.resolve({ ...page, nextCursor: `page-${idx + 1}`, hasMore });
    } catch (e) { return Promise.reject(e); }
  }
  removeItem(t: string): Promise<void> {
    try { this.enter("removeItem", [t]); return Promise.resolve(); } catch (e) { return Promise.reject(e); }
  }
  verifyWebhook(_raw: string, sig: string | null): Promise<boolean> { return Promise.resolve(sig === this.secret); }
  parseWebhook(raw: string): NormalizedWebhookEvent | null {
    try {
      const e = JSON.parse(raw) as { item_id?: string; kind?: string };
      if (!e.item_id) return { kind: "ignored", itemId: null };
      if (e.kind === "transactions_updated" || e.kind === "login_required" || e.kind === "login_repaired") return { kind: e.kind, itemId: e.item_id };
      return { kind: "ignored", itemId: e.item_id };
    } catch { return null; }
  }
}

export const mockTxn = (over: Partial<NormalizedTransaction> = {}): NormalizedTransaction => ({
  providerTxnId: "t1", providerAccountId: "a1", postedDate: "2026-11-01", amountCents: -1250, currency: "USD",
  description: "SHELL OIL", merchantName: "Shell", category: null, pending: false, supersedesPendingId: null, ...over,
});
