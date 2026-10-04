// Plaid -> Supabase sync (cursor-based, idempotent, lock-protected).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { PlaidError, type Plaid } from "./plaid.ts";

export interface ConnRow { id: string; user_id: string; sync_cursor: string | null; last_synced_at?: string | null }
export interface SyncResult { added: number; modified: number; removed: number; skipped?: "already_running" | "cooldown" | "not_ready"; error?: string; login_required?: boolean }

const cents = (n: number | null | undefined): number | null => (typeof n === "number" ? Math.round(n * 100) : null);
const chunk = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export async function syncAccounts(db: SupabaseClient, plaid: Plaid, conn: ConnRow, accessToken: string): Promise<Map<string, { id: string; active: boolean }>> {
  const [{ data: coa }, res] = await Promise.all([
    db.from("chart_of_accounts").select("id, code").eq("user_id", conn.user_id).in("code", ["1000", "2200"]),
    plaid.post("/accounts/get", { access_token: accessToken }),
  ]);
  const ledger = new Map((coa ?? []).map((r: { id: string; code: string }) => [r.code, r.id]));
  const now = new Date().toISOString();
  // deno-lint-ignore no-explicit-any
  const rows = (res.accounts ?? []).map((a: any) => ({
    user_id: conn.user_id,
    connection_id: conn.id,
    provider_account_id: a.account_id,
    name: String(a.name || a.official_name || "Account").slice(0, 120),
    mask: a.mask ?? null,
    account_type: a.type ?? "depository",
    subtype: a.subtype ?? null,
    currency: a.balances?.iso_currency_code ?? "USD",
    current_balance_cents: cents(a.balances?.current),
    available_balance_cents: cents(a.balances?.available ?? a.balances?.current),
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

export async function syncConnection(db: SupabaseClient, plaid: Plaid, conn: ConnRow, opts: { minIntervalMs?: number } = {}): Promise<SyncResult> {
  const result: SyncResult = { added: 0, modified: 0, removed: 0 };
  if (opts.minIntervalMs && conn.last_synced_at && Date.now() - Date.parse(conn.last_synced_at) < opts.minIntervalMs) return { ...result, skipped: "cooldown" };

  const nowIso = new Date().toISOString();
  const { data: claimed } = await db.from("bank_connections")
    .update({ sync_locked_until: new Date(Date.now() + 120_000).toISOString() })
    .eq("id", conn.id).or(`sync_locked_until.is.null,sync_locked_until.lt.${nowIso}`).select("id");
  if (!claimed?.length) return { ...result, skipped: "already_running" };

  const release = (patch: Record<string, unknown>) =>
    db.from("bank_connections").update({ sync_locked_until: null, updated_at: new Date().toISOString(), ...patch }).eq("id", conn.id);

  try {
    const { data: secret } = await db.from("bank_connection_secrets").select("access_token").eq("connection_id", conn.id).maybeSingle();
    if (!secret?.access_token) throw new PlaidError("NO_TOKEN", "CONFIG", "Connection has no access token — reconnect the bank.", 400);
    const accessToken = secret.access_token as string;

    const accounts = await syncAccounts(db, plaid, conn, accessToken);

    // deno-lint-ignore no-explicit-any
    let added: any[] = [], modified: any[] = [], removed: any[] = [];
    let nextCursor: string | undefined = conn.sync_cursor ?? undefined;
    for (let attempt = 0; ; attempt++) {
      added = []; modified = []; removed = [];
      let cursor = conn.sync_cursor ?? undefined;
      let more = true;
      try {
        while (more) {
          const r = await plaid.post("/transactions/sync", { access_token: accessToken, cursor, count: 500 });
          added.push(...(r.added ?? [])); modified.push(...(r.modified ?? [])); removed.push(...(r.removed ?? []));
          cursor = r.next_cursor; more = !!r.has_more;
        }
        nextCursor = cursor;
        break;
      } catch (e) {
        if (e instanceof PlaidError && e.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && attempt < 2) continue;
        throw e;
      }
    }

    const toRow = (t: any) => { // deno-lint-ignore no-explicit-any
      const acc = accounts.get(t.account_id);
      if (!acc || !acc.active) return null;
      return {
        user_id: conn.user_id,
        account_id: acc.id,
        provider_txn_id: String(t.transaction_id),
        posted_date: t.date,
        amount_cents: -(Math.round(Number(t.amount) * 100)) || 0,
        currency: t.iso_currency_code ?? "USD",
        description: String(t.name ?? t.original_description ?? "").slice(0, 300),
        merchant_name: t.merchant_name ? String(t.merchant_name).slice(0, 120) : null,
        provider_category: t.personal_finance_category?.primary ?? null,
        pending: !!t.pending,
        updated_at: new Date().toISOString(),
      };
    };
    const incoming = new Map<string, NonNullable<ReturnType<typeof toRow>>>();
    for (const t of [...added, ...modified]) { const r = toRow(t); if (r) incoming.set(r.provider_txn_id, r); }

    // Pending rows are superseded by their posted version.
    const supersededPending = added.map((t) => t.pending_transaction_id).filter(Boolean) as string[];
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

    const removedIds = removed.map((r) => String(r.transaction_id));
    for (const part of chunk(removedIds, 100)) {
      await db.from("bank_transactions").delete().eq("user_id", conn.user_id).in("provider_txn_id", part).neq("match_status", "reconciled");
      await db.from("bank_transactions").update({ needs_review: true }).eq("user_id", conn.user_id).in("provider_txn_id", part).eq("match_status", "reconciled");
    }

    await release({ sync_cursor: nextCursor ?? null, last_synced_at: new Date().toISOString(), status: "active", last_error: null });
    return { added: added.length, modified: modified.length, removed: removed.length };
  } catch (e) {
    if (e instanceof PlaidError && e.code === "PRODUCT_NOT_READY") {
      await release({});
      return { ...result, skipped: "not_ready" };
    }
    const loginRequired = e instanceof PlaidError && ["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION"].includes(e.code);
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    await release(loginRequired ? { status: "login_required", last_error: message } : { last_error: message });
    console.error(JSON.stringify({ event: "bank_sync_failed", connection_id: conn.id, error: message }));
    return { ...result, error: loginRequired ? "Your bank needs you to sign in again." : "Sync failed — we'll retry automatically.", login_required: loginRequired };
  }
}
