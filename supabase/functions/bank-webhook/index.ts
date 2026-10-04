// Plaid webhook receiver — verifies the Plaid-Verification JWT, then syncs +
// re-analyzes in the background so Plaid gets its 200 quickly.
// Deploy: supabase functions deploy bank-webhook --no-verify-jwt
// Plaid dashboard / PLAID_WEBHOOK_URL: https://<project-ref>.supabase.co/functions/v1/bank-webhook

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { getPlaid, verifyPlaidWebhook, type Plaid } from "../_shared/bank/plaid.ts";
import { syncConnection } from "../_shared/bank/sync.ts";
import { runAnalysis } from "../_shared/bank/analysis.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
const respond = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return respond(405, { error: "Method not allowed" });
  const raw = await req.text();

  let plaid: Plaid;
  try { plaid = getPlaid(); } catch { return respond(503, { error: "Not configured" }); }
  if (!(await verifyPlaidWebhook(plaid, raw, req.headers.get("plaid-verification")))) return respond(401, { error: "Invalid signature" });

  // deno-lint-ignore no-explicit-any
  let evt: any;
  try { evt = JSON.parse(raw); } catch { return respond(400, { error: "Bad JSON" }); }

  const work = (async () => {
    if (!evt?.item_id) return;
    const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: conn } = await db.from("bank_connections").select("id, user_id, sync_cursor, last_synced_at").eq("provider", "plaid").eq("item_id", evt.item_id).maybeSingle();
    if (!conn) return;
    const type = evt.webhook_type, code = evt.webhook_code;

    if (type === "TRANSACTIONS" && code === "SYNC_UPDATES_AVAILABLE") {
      await syncConnection(db, plaid, conn);
      await runAnalysis(db, conn.user_id);
    } else if (type === "ITEM" && (code === "PENDING_EXPIRATION" || code === "USER_PERMISSION_REVOKED" || (code === "ERROR" && evt.error?.error_code === "ITEM_LOGIN_REQUIRED"))) {
      await db.from("bank_connections").update({ status: "login_required", last_error: "Your bank needs you to sign in again.", updated_at: new Date().toISOString() }).eq("id", conn.id);
    } else if (type === "ITEM" && code === "LOGIN_REPAIRED") {
      await db.from("bank_connections").update({ status: "active", last_error: null, updated_at: new Date().toISOString() }).eq("id", conn.id);
    }
  })().catch((e) => console.error(JSON.stringify({ event: "bank_webhook_failed", error: e instanceof Error ? e.message : String(e) })));

  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
  return respond(200, { received: true });
});
