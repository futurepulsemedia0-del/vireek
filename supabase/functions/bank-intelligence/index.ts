// Direct Bank Intelligence — authenticated API (actions: link_token, exchange,
// reconnected, sync, analyze, disconnect, sync_forecast_cash, status).
// Secrets: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox|production),
//          optional PLAID_WEBHOOK_URL. Deploy: supabase functions deploy bank-intelligence

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { BankProviderError, buildStatusView, getBankProvider, INITIAL_HEALTH, type BankDataProvider, type HealthSnapshot, type HealthState, type ProviderErrorKind } from "../_shared/bank/provider/index.ts";
import { syncConnection, syncAccounts, type ConnRow, type SyncOptions } from "../_shared/bank/sync.ts";
import { runAnalysis } from "../_shared/bank/analysis.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const authClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);
    const [{ data: allowed }, { data: ownerId }] = await Promise.all([authClient.rpc("bank_can_access"), authClient.rpc("get_account_owner_id")]);
    if (!allowed || !ownerId) return json({ error: "You don't have access to banking." }, 403);

    const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "");
    // Aggregator access goes through the resilient provider: circuit breaker + health + per-pull metering.
    const providerFor = (connectionId: string | null = null): BankDataProvider => getBankProvider(db, { userId: ownerId, connectionId });
    const syncOpts: SyncOptions = { requireConsent: Deno.env.get("BANK_CONSENT_ENFORCE") === "true" };

    const getConn = async (id: unknown): Promise<(ConnRow & { status: string }) | null> => {
      if (!isUuid(id)) return null;
      const { data } = await db.from("bank_connections").select("id, user_id, sync_cursor, last_synced_at, status").eq("id", id).eq("user_id", ownerId).maybeSingle();
      return data;
    };

    switch (action) {
      case "link_token": {
        const webhookUrl = Deno.env.get("PLAID_WEBHOOK_URL") ?? `${url}/functions/v1/bank-webhook`;
        let accessToken: string | undefined;
        let connId: string | null = null;
        if (body.connection_id) {
          const conn = await getConn(body.connection_id);
          if (!conn) return json({ error: "Connection not found." }, 404);
          const { data: secret } = await db.from("bank_connection_secrets").select("access_token").eq("connection_id", conn.id).maybeSingle();
          if (!secret) return json({ error: "Connection has no credentials — connect the bank again." }, 409);
          accessToken = secret.access_token as string; // update mode (re-authentication)
          connId = conn.id;
        }
        const { linkToken } = await providerFor(connId).createLinkToken({ ownerId, webhookUrl, accessToken, historyDays: 365 });
        return json({ link_token: linkToken });
      }

      case "exchange": {
        const publicToken = typeof body.public_token === "string" ? body.public_token : "";
        if (!publicToken) return json({ error: "Missing public_token." }, 400);
        const provider = providerFor();
        await authClient.rpc("ensure_default_chart_of_accounts"); // so accounts map to ledger 1000 / 2200
        const ex = await provider.exchangePublicToken(publicToken);
        const { data: conn, error } = await db.from("bank_connections").upsert({
          user_id: ownerId, provider: provider.id, item_id: ex.itemId,
          institution_id: typeof body.institution_id === "string" ? body.institution_id.slice(0, 64) : null,
          institution_name: typeof body.institution_name === "string" && body.institution_name ? body.institution_name.slice(0, 120) : "Bank",
          status: "active", last_error: null, updated_at: new Date().toISOString(),
        }, { onConflict: "provider,item_id" }).select("id, user_id, sync_cursor, last_synced_at").single();
        if (error || !conn) throw error ?? new Error("Could not save connection");
        const { error: secErr } = await db.from("bank_connection_secrets").upsert({ connection_id: conn.id, access_token: ex.accessToken }, { onConflict: "connection_id" });
        if (secErr) throw secErr;

        // Consent record: evidence that THIS user completed the provider link flow for THIS connection.
        // We record only what we can prove. Vireek's own notice text/version is [COUNSEL] and is stored
        // only if the client reports it; nothing is fabricated.
        const notice = body?.consent && typeof body.consent === "object" ? body.consent as Record<string, unknown> : null;
        const { error: consentErr } = await db.rpc("bank_record_consent", {
          p_user_id: ownerId, p_connection_id: conn.id, p_provider: provider.id, p_actor_id: user.id,
          p_scopes: ["accounts", "transactions", "balances"], p_source: "link_flow",
          p_notice_version: typeof notice?.version === "string" ? notice.version.slice(0, 40) : null,
          p_notice_acknowledged: notice?.acknowledged === true,
        });
        if (consentErr) console.error(JSON.stringify({ event: "bank_consent_record_failed", connection_id: conn.id, error: consentErr.message }));

        const scoped = providerFor(conn.id);
        await syncAccounts(db, scoped, conn, ex.accessToken);
        const sync = await syncConnection(db, scoped, conn, syncOpts); // history may not be ready yet; the webhook finishes it
        return json({ connection_id: conn.id, sync });
      }

      case "reconnected": {
        const conn = await getConn(body.connection_id);
        if (!conn) return json({ error: "Connection not found." }, 404);
        await db.from("bank_connections").update({ status: "active", last_error: null, updated_at: new Date().toISOString() }).eq("id", conn.id);
        const sync = await syncConnection(db, providerFor(conn.id), { ...conn, last_synced_at: null }, syncOpts);
        return json({ sync });
      }

      case "sync": {
        const { data: conns } = await db.from("bank_connections").select("id, user_id, sync_cursor, last_synced_at").eq("user_id", ownerId).eq("status", "active");
        const totals = { added: 0, modified: 0, removed: 0, skipped: 0, providerUnavailable: 0, retryAfterSeconds: null as number | null, errors: [] as string[] };
        for (const c of conns ?? []) {
          const r = await syncConnection(db, providerFor(c.id), c, { ...syncOpts, minIntervalMs: 15_000 });
          totals.added += r.added; totals.modified += r.modified; totals.removed += r.removed;
          if (r.skipped) totals.skipped++;
          if (r.skipped === "provider_unavailable") {
            totals.providerUnavailable++;
            if (r.retry_after_seconds) totals.retryAfterSeconds = Math.max(totals.retryAfterSeconds ?? 0, r.retry_after_seconds);
          }
          if (r.error) totals.errors.push(r.error);
        }
        // Analysis reads only data already in Postgres, so it still runs (and serves cached data) during an outage.
        const analysis = await runAnalysis(db, ownerId);
        return json({ sync: totals, analysis, degraded: totals.providerUnavailable > 0 });
      }

      case "analyze":
        return json({ analysis: await runAnalysis(db, ownerId) });

      case "disconnect": {
        const conn = await getConn(body.connection_id);
        if (!conn) return json({ error: "Connection not found." }, 404);
        const { data: secret } = await db.from("bank_connection_secrets").select("access_token").eq("connection_id", conn.id).maybeSingle();
        if (secret) {
          // If this fails (e.g. provider outage) the vendor-side item is orphaned: see
          // docs/runbooks/bank-data-provider-failure.md ("Orphaned items").
          try { await providerFor(conn.id).removeItem(secret.access_token as string); }
          catch (e) { console.error(JSON.stringify({ event: "bank_item_remove_failed", connection_id: conn.id, kind: e instanceof BankProviderError ? e.kind : "unknown", error: e instanceof Error ? e.message : String(e) })); }
        }
        await db.rpc("bank_revoke_consents", { p_connection_id: conn.id, p_actor_id: user.id, p_reason: "disconnected_by_user" });
        await db.from("bank_connection_secrets").delete().eq("connection_id", conn.id);
        await db.from("bank_accounts").update({ is_active: false }).eq("connection_id", conn.id);
        await db.from("bank_connections").update({ status: "disconnected", updated_at: new Date().toISOString() }).eq("id", conn.id);
        return json({ ok: true });
      }

      case "status": {
        const { data: h } = await db.from("bank_provider_health").select("*").eq("provider", "plaid").maybeSingle();
        const health: HealthSnapshot = h ? {
          state: (["healthy", "degraded", "down"].includes(h.state) ? h.state : "healthy") as HealthState,
          consecutiveFailures: Number(h.consecutive_failures ?? 0), lastSuccessAt: h.last_success_at ?? null,
          lastFailureAt: h.last_failure_at ?? null, lastErrorKind: (h.last_error_kind ?? null) as ProviderErrorKind | null,
          circuitOpenUntil: h.circuit_open_until ?? null,
        } : INITIAL_HEALTH;
        const { data: conns } = await db.from("bank_connections").select("id, institution_name, status, last_synced_at").eq("user_id", ownerId).neq("status", "disconnected");
        const now = new Date();
        return json({
          provider: buildStatusView(health, null, now).providerState,
          connections: (conns ?? []).map((c: { id: string; institution_name: string; status: string; last_synced_at: string | null }) => ({
            id: c.id, institution_name: c.institution_name, status: c.status, ...buildStatusView(health, c.last_synced_at, now),
          })),
        });
      }

      case "sync_forecast_cash": {
        const { data: accts } = await db.from("bank_accounts").select("available_balance_cents, current_balance_cents")
          .eq("user_id", ownerId).eq("is_active", true).eq("account_type", "depository").eq("currency", "USD");
        if (!accts?.length) return json({ error: "Connect a bank account first." }, 409);
        const cents = accts.reduce((s: number, a: { available_balance_cents: number | null; current_balance_cents: number | null }) => s + Number(a.available_balance_cents ?? a.current_balance_cents ?? 0), 0);
        const { error } = await db.from("cash_flow_settings").upsert({ user_id: ownerId, starting_cash_balance: cents / 100, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
        if (error) throw error;
        return json({ starting_cash_balance: cents / 100, accounts: accts.length });
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (err) {
    if (err instanceof BankProviderError) {
      console.error(JSON.stringify({ event: "bank_provider_error", provider: err.provider, kind: err.kind, code: err.code }));
      if (err.kind === "not_configured") return json({ error: err.message, code: err.code }, 503);
      if (err.kind === "provider_unavailable" || err.kind === "rate_limited") {
        return json({ error: "Our bank connection provider is temporarily unavailable. Your existing data is still available; please try again shortly.", code: "provider_unavailable", retry_after_seconds: err.retryAfterMs ? Math.ceil(err.retryAfterMs / 1000) : null }, 503);
      }
      return json({ error: "Your bank connection provider returned an error. Please try again.", code: err.code }, 502);
    }
    console.error(JSON.stringify({ event: "bank_intelligence_failed", error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
