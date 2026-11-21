// Provider -> Supabase sync (cursor-based, idempotent, lock-protected).
// Talks to the aggregator ONLY through BankDataProvider (see ./provider/types.ts), so the vendor,
// its field names and its sign convention never leak into this file.
//
// Graceful degradation: when the provider is down / throttled / the circuit is open, a sync is SKIPPED
// (`skipped: "provider_unavailable"`). The connection's status and last_error are NOT touched — an
// outage at the aggregator is not the customer's fault and must not push them into "reconnect your
// bank". Already-synced data keeps being served; the UI shows freshness via bank_get_provider_status().
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { BankProviderError, type BankDataProvider, type NormalizedAccount, type NormalizedTransaction } from "./provider/types.ts";

export interface ConnRow { id: string; user_id: string; sync_cursor: string | null; last_synced_at?: string | null }
export interface SyncResult {
  added: number; modified: number; removed: number;
  skipped?: "already_running" | "cooldown" | "not_ready" | "provider_unavailable" | "consent_missing";
  error?: string; login_required?: boolean;
  /** Set with skipped = "provider_unavailable" when we know when retrying makes sense. */
  retry_after_seconds?: number;
}
export interface SyncOptions {
  minIntervalMs?: number;
  /** When true, refuse to pull for a connection that has no active (unrevoked, unexpired) consent record. */
  requireConsent?: boolean;
}

const chunk = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const MAX_PAGINATION_RESTARTS = 2;

export async function syncAccounts(db: SupabaseClient, provider: BankDataProvider, conn: ConnRow, accessToken: string): Promise<Map<string, { id: string; active: boolean }>> {
  const [{ data: coa }, accounts] = await Promise.all([
    db.from("chart_of_accounts").select("id, code").eq("user_id", conn.user_id).in("code", ["1000", "2200"]),
    provider.getAccounts(accessToken),
  ]);
  const ledger = new Map((coa ?? []).map((r: { id: string; code: string }) => [r.code, r.id]));
  const now = new Date().toISOString();
  const rows = accounts.map((a: NormalizedAccount) => ({
    user_id: conn.user_id,
    connection_id: conn.id,
    provider_account_id: a.providerAccountId,
    name: a.name,
    mask: a.mask,
    account_type: a.type,
    subtype: a.subtype,
    currency: a.currency,
    current_balance_cents: a.currentBalanceCents,
    available_balance_cents: a.availableBalanceCents,
    balance_updated_at: now,
    ledger_account_id: (a.type === "credit" ? ledger.get("2200") : ledger.get("1000")) ?? null,
    is_active: a.type === "depository" || a.type === "credit",
  }));
  const map = new Map<string, { id: string; active: boolean }>();
  if (!rows.length) return map;
  const { data, error } = await db.from("bank_accounts").upsert(rows, { onConflict: "connection_id,provider_account_id" }).select("id, provider_account_id, is_active");
  if (error) throw error;
  for (const r of data ?? []) map.set(r.provider_account_id, { id: r.id, active: r.is_active });
  return map;
}

export async function syncConnection(db: SupabaseClient, provider: BankDataProvider, conn: ConnRow, opts: SyncOptions = {}): Promise<SyncResult> {
  const result: SyncResult = { added: 0, modified: 0, removed: 0 };
  if (opts.minIntervalMs && conn.last_synced_at && Date.now() - Date.parse(conn.last_synced_at) < opts.minIntervalMs) return { ...result, skipped: "cooldown" };

  if (opts.requireConsent) {
    const { data: ok } = await db.rpc("bank_has_active_consent", { p_connection_id: conn.id });
    if (ok !== true) return { ...result, skipped: "consent_missing" };
  }

  const nowIso = new Date().toISOString();
  const { data: claimed } = await db.from("bank_connections")
    .update({ sync_locked_until: new Date(Date.now() + 120_000).toISOString() })
    .eq("id", conn.id).or(`sync_locked_until.is.null,sync_locked_until.lt.${nowIso}`).select("id");
  if (!claimed?.length) return { ...result, skipped: "already_running" };

  const release = (patch: Record<string, unknown>) =>
    db.from("bank_connections").update({ sync_locked_until: null, updated_at: new Date().toISOString(), ...patch }).eq("id", conn.id);

  try {
    const { data: secret } = await db.from("bank_connection_secrets").select("access_token").eq("connection_id", conn.id).maybeSingle();
    if (!secret?.access_token) throw new BankProviderError("invalid_request", "NO_TOKEN", "Connection has no access token — reconnect the bank.", provider.id, 400);
    const accessToken = secret.access_token as string;

    const accounts = await syncAccounts(db, provider, conn, accessToken);

    let added: NormalizedTransaction[] = [], modified: NormalizedTransaction[] = [], removedIds: string[] = [];
    let nextCursor: string | undefined = conn.sync_cursor ?? undefined;
    for (let attempt = 0; ; attempt++) {
      added = []; modified = []; removedIds = [];
      let cursor: string | null = conn.sync_cursor ?? null;
      let more = true;
      try {
        while (more) {
          const page = await provider.syncTransactions(accessToken, cursor);
          added.push(...page.added); modified.push(...page.modified); removedIds.push(...page.removedIds);
          cursor = page.nextCursor; more = page.hasMore;
        }
        nextCursor = cursor ?? undefined;
        break;
      } catch (e) {
        if (e instanceof BankProviderError && e.kind === "pagination_mutation" && attempt < MAX_PAGINATION_RESTARTS) continue;
        throw e;
      }
    }

    const toRow = (t: NormalizedTransaction) => {
      const acc = accounts.get(t.providerAccountId);
      if (!acc || !acc.active) return null;
      return {
        user_id: conn.user_id,
        account_id: acc.id,
        provider_txn_id: t.providerTxnId,
        posted_date: t.postedDate,
        amount_cents: t.amountCents,
        currency: t.currency,
        description: t.description,
        merchant_name: t.merchantName,
        provider_category: t.category,
        pending: t.pending,
        updated_at: new Date().toISOString(),
      };
    };
    const incoming = new Map<string, NonNullable<ReturnType<typeof toRow>>>();
    for (const t of [...added, ...modified]) { const r = toRow(t); if (r) incoming.set(r.provider_txn_id, r); }

    // Pending rows are superseded by their posted version.
    const supersededPending = added.map((t) => t.supersedesPendingId).filter(Boolean) as string[];
    for (const ids of chunk(supersededPending, 100)) {
      await db.from("bank_transactions").delete().eq("user_id", conn.user_id).in("provider_txn_id", ids).neq("match_status", "reconciled");
    }

    // Never silently rewrite a reconciled transaction: flag it for review if the bank changed it.
    const ids = [...incoming.keys()];
    for (const part of chunk(ids, 100)) {
      const { data: existing } = await db.from("bank_transactions").select("provider_txn_id, amount_cents, posted_date, match_status").eq("user_id", conn.user_id).in("provider_txn_id", part);
      for (const ex of existing ?? []) {
        if (ex.match_status !== "reconciled") continue;
        const inc = incoming.get(ex.provider_txn_id)!;
        incoming.delete(ex.provider_txn_id);
        if (Number(ex.amount_cents) !== inc.amount_cents || ex.posted_date !== inc.posted_date) {
          await db.from("bank_transactions").update({ needs_review: true }).eq("user_id", conn.user_id).eq("provider_txn_id", ex.provider_txn_id);
        }
      }
    }
    for (const rows of chunk([...incoming.values()], 500)) {
      const { error } = await db.from("bank_transactions").upsert(rows, { onConflict: "user_id,provider_txn_id" });
      if (error) throw error;
    }

    for (const part of chunk(removedIds, 100)) {
      await db.from("bank_transactions").delete().eq("user_id", conn.user_id).in("provider_txn_id", part).neq("match_status", "reconciled");
      await db.from("bank_transactions").update({ needs_review: true }).eq("user_id", conn.user_id).in("provider_txn_id", part).eq("match_status", "reconciled");
    }

    await release({ sync_cursor: nextCursor ?? null, last_synced_at: new Date().toISOString(), status: "active", last_error: null });
    return { added: added.length, modified: modified.length, removed: removedIds.length };
  } catch (e) {
    const err = e instanceof BankProviderError ? e : null;

    if (err?.kind === "product_not_ready") {
      await release({});
      return { ...result, skipped: "not_ready" };
    }

    // Provider-side trouble (or one bank being down): keep the connection healthy, keep serving cached data.
    if (err && (err.kind === "provider_unavailable" || err.kind === "rate_limited" || err.kind === "institution_unavailable")) {
      await release({});
      console.error(JSON.stringify({ event: "bank_sync_degraded", connection_id: conn.id, provider: err.provider, kind: err.kind, code: err.code }));
      return { ...result, skipped: "provider_unavailable", ...(err.retryAfterMs ? { retry_after_seconds: Math.ceil(err.retryAfterMs / 1000) } : {}) };
    }

    const loginRequired = err?.kind === "auth_required";
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    await release(loginRequired ? { status: "login_required", last_error: message } : { last_error: message });
    console.error(JSON.stringify({ event: "bank_sync_failed", connection_id: conn.id, error: message }));
    return { ...result, error: loginRequired ? "Your bank needs you to sign in again." : "Sync failed — we'll retry automatically.", login_required: loginRequired };
  }
}
