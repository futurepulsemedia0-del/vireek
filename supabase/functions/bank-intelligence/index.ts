// Direct Bank Intelligence — authenticated API (actions: link_token, exchange,
// reconnected, sync, analyze, disconnect, sync_forecast_cash).
// Secrets: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox|production),
//          optional PLAID_WEBHOOK_URL. Deploy: supabase functions deploy bank-intelligence

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { getPlaid, PlaidError } from "../_shared/bank/plaid.ts";
import { syncConnection, syncAccounts, type ConnRow } from "../_shared/bank/sync.ts";
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

    const getConn = async (id: unknown): Promise<(ConnRow & { status: string }) | null> => {
      if (!isUuid(id)) return null;
      const { data } = await db.from("bank_connections").select("id, user_id, sync_cursor, last_synced_at, status").eq("id", id).eq("user_id", ownerId).maybeSingle();
      return data;
    };

    switch (action) {
      case "link_token": {
        const plaid = getPlaid();
        const payload: Record<string, unknown> = {
          client_name: "Vireek", language: "en", country_codes: ["US"],
          user: { client_user_id: ownerId },
          webhook: Deno.env.get("PLAID_WEBHOOK_URL") ?? `${url}/functions/v1/bank-webhook`,
        };
        if (body.connection_id) {
          const conn = await getConn(body.connection_id);
          if (!conn) return json({ error: "Connection not found." }, 404);
          const { data: secret } = await db.from("bank_connection_secrets").select("access_token").eq("connection_id", conn.id).maybeSingle();
          if (!secret) return json({ error: "Connection has no credentials — connect the bank again." }, 409);
          payload.access_token = secret.access_token; // update mode (re-authentication)
        } else {
          payload.products = ["transactions"];
          payload.transactions = { days_requested: 365 };
        }
        const r = await plaid.post("/link/token/create", payload);
        return json({ link_token: r.link_token });
      }

      case "exchange": {
        const publicToken = typeof body.public_token === "string" ? body.public_token : "";
        if (!publicToken) return json({ error: "Missing public_token." }, 400);
        const plaid = getPlaid();
        await authClient.rpc("ensure_default_chart_of_accounts"); // so accounts map to ledger 1000 / 2200
        const ex = await plaid.post("/item/public_token/exchange", { public_token: publicToken });
        const { data: conn, error } = await db.from("bank_connections").upsert({
          user_id: ownerId, provider: "plaid", item_id: ex.item_id,
          institution_id: typeof body.institution_id === "string" ? body.institution_id.slice(0, 64) : null,
          institution_name: typeof body.institution_name === "string" && body.institution_name ? body.institution_name.slice(0, 120) : "Bank",
          status: "active", last_error: null, updated_at: new Date().toISOString(),
        }, { onConflict: "provider,item_id" }).select("id, user_id, sync_cursor, last_synced_at").single();
        if (error || !conn) throw error ?? new Error("Could not save connection");
        const { error: secErr } = await db.from("bank_connection_secrets").upsert({ connection_id: conn.id, access_token: ex.access_token }, { onConflict: "connection_id" });
        if (secErr) throw secErr;
        await syncAccounts(db, plaid, conn, ex.access_token);
        const sync = await syncConnection(db, plaid, conn); // history may not be ready yet; the webhook finishes it
        return json({ connection_id: conn.id, sync });
      }

      case "reconnected": {
        const conn = await getConn(body.connection_id);
        if (!conn) return json({ error: "Connection not found." }, 404);
        await db.from("bank_connections").update({ status: "active", last_error: null, updated_at: new Date().toISOString() }).eq("id", conn.id);
        const sync = await syncConnection(db, getPlaid(), { ...conn, last_synced_at: null });
        return json({ sync });
      }

      case "sync": {
        const plaid = getPlaid();
        const { data: conns } = await db.from("bank_connections").select("id, user_id, sync_cursor, last_synced_at").eq("user_id", ownerId).eq("status", "active");
        const totals = { added: 0, modified: 0, removed: 0, skipped: 0, errors: [] as string[] };
        for (const c of conns ?? []) {
          const r = await syncConnection(db, plaid, c, { minIntervalMs: 15_000 });
          totals.added += r.added; totals.modified += r.modified; totals.removed += r.removed;
          if (r.skipped) totals.skipped++;
          if (r.error) totals.errors.push(r.error);
        }
        const analysis = await runAnalysis(db, ownerId);
        return json({ sync: totals, analysis });
      }

      case "analyze":
        return json({ analysis: await runAnalysis(db, ownerId) });

      case "disconnect": {
        const conn = await getConn(body.connection_id);
        if (!conn) return json({ error: "Connection not found." }, 404);
        const { data: secret } = await db.from("bank_connection_secrets").select("access_token").eq("connection_id", conn.id).maybeSingle();
        if (secret) {
          try { await getPlaid().post("/item/remove", { access_token: secret.access_token }); }
          catch (e) { console.error(JSON.stringify({ event: "bank_item_remove_failed", error: e instanceof Error ? e.message : String(e) })); }
        }
        await db.from("bank_connection_secrets").delete().eq("connection_id", conn.id);
        await db.from("bank_accounts").update({ is_active: false }).eq("connection_id", conn.id);
        await db.from("bank_connections").update({ status: "disconnected", updated_at: new Date().toISOString() }).eq("id", conn.id);
        return json({ ok: true });
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
    if (err instanceof PlaidError) {
      console.error(JSON.stringify({ event: "bank_plaid_error", code: err.code, message: err.message }));
      return json({ error: err.code === "NOT_CONFIGURED" ? err.message : "Your bank connection provider returned an error. Please try again.", code: err.code }, err.code === "NOT_CONFIGURED" ? 503 : 502);
    }
    console.error(JSON.stringify({ event: "bank_intelligence_failed", error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
