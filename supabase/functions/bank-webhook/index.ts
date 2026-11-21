// Plaid webhook receiver — verifies the Plaid-Verification JWT, then syncs +
// re-analyzes in the background so Plaid gets its 200 quickly.
// Deploy: supabase functions deploy bank-webhook --no-verify-jwt
// Plaid dashboard / PLAID_WEBHOOK_URL: https://<project-ref>.supabase.co/functions/v1/bank-webhook

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { getBankProvider, type BankDataProvider } from "../_shared/bank/provider/index.ts";
import { syncConnection } from "../_shared/bank/sync.ts";
import { runAnalysis } from "../_shared/bank/analysis.ts";
import { dbWebhookEventStore, sha256Hex } from "../_shared/http/webhookGuard.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
const respond = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return respond(405, { error: "Method not allowed" });
  const raw = await req.text();

  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  // Verification and parsing are deliberately NOT gated by the circuit breaker (see provider/resilient.ts):
  // inbound events must never be refused during a provider outage.
  const provider: BankDataProvider = getBankProvider(db);
  if (!provider.isConfigured()) return respond(503, { error: "Not configured" });
  if (!(await provider.verifyWebhook(raw, req.headers.get("plaid-verification")))) return respond(401, { error: "Invalid signature" });

  const evt = provider.parseWebhook(raw);
  if (!evt) return respond(400, { error: "Bad JSON" });

  // Replay guard: each Plaid delivery carries a fresh signed JWT, so the digest of that header identifies one delivery.
  // Never key on the body alone (Plaid sends identical SYNC_UPDATES_AVAILABLE bodies repeatedly).
  const store = dbWebhookEventStore(db);
  const eventId = await sha256Hex(req.headers.get("plaid-verification") ?? "");
  const claim = await store.begin("plaid", eventId).catch(() => null);
  if (claim === null) return respond(503, { error: "Temporarily unavailable" });
  if (claim === "duplicate") return respond(200, { received: true, duplicate: true });
  if (claim === "in_progress") return respond(409, { error: "Event in progress" });

  const work = (async () => {
    if (evt.kind === "ignored" || !evt.itemId) return;
    const { data: conn } = await db.from("bank_connections").select("id, user_id, sync_cursor, last_synced_at").eq("provider", provider.id).eq("item_id", evt.itemId).maybeSingle();
    if (!conn) return;

    if (evt.kind === "transactions_updated") {
      // During a provider outage this is a quiet skip; the next successful sync catches up (cursor-based, nothing is lost).
      await syncConnection(db, getBankProvider(db, { userId: conn.user_id, connectionId: conn.id }), conn, { requireConsent: Deno.env.get("BANK_CONSENT_ENFORCE") === "true" });
      await runAnalysis(db, conn.user_id);
    } else if (evt.kind === "login_required") {
      await db.from("bank_connections").update({ status: "login_required", last_error: "Your bank needs you to sign in again.", updated_at: new Date().toISOString() }).eq("id", conn.id);
    } else if (evt.kind === "login_repaired") {
      await db.from("bank_connections").update({ status: "active", last_error: null, updated_at: new Date().toISOString() }).eq("id", conn.id);
    }
  })().then(
    () => store.finish("plaid", eventId, null),
    (e) => {
      console.error(JSON.stringify({ event: "bank_webhook_failed", error: e instanceof Error ? e.message : String(e) }));
      return store.finish("plaid", eventId, e instanceof Error ? e.message : String(e));
    },
  ).catch(() => undefined);

  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
  return respond(200, { received: true });
});
