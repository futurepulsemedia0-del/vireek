import { adminClient, authenticate, corsHeaders, isServiceCall, json } from "../_shared/bank/http.ts";
import { computeInsights, processUser, syncConnection } from "../_shared/bank/engine.ts";

// User call:    POST {}                       -> sync all of the caller's connections
// Service/cron: POST { all: true }            -> sync every active connection (nightly safety net)
// Reprocess:    POST { reprocess: true }      -> re-run matching/categorization without hitting the bank
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const db = adminClient();
    const body = await req.json().catch(() => ({}));

    if (isServiceCall(req)) {
      const { data: conns } = await db.from("bank_connections").select("id, user_id").eq("status", "active").limit(500);
      let ok = 0, failed = 0;
      const users = new Set<string>();
      for (const c of conns ?? []) {
        try { await syncConnection(db, c.id); ok++; users.add(c.user_id); } catch { failed++; }
      }
      for (const u of users) { try { await computeInsights(db, u, 90, true); } catch { /* best effort */ } }
      return json({ synced: ok, failed });
    }

    const caller = await authenticate(req, db);
    if (caller instanceof Response) return caller;

    if (body.reprocess) {
      const r = await processUser(db, caller.ownerId);
      return json({ summary: r });
    }

    const { data: conns } = await db.from("bank_connections").select("id").eq("user_id", caller.ownerId).in("status", ["active", "error"]);
    const results: { connection_id: string; ok: boolean; error?: string }[] = [];
    for (const c of conns ?? []) {
      try { await syncConnection(db, c.id); results.push({ connection_id: c.id, ok: true }); }
      catch (e) { results.push({ connection_id: c.id, ok: false, error: e instanceof Error ? e.message.slice(0, 160) : "error" }); }
    }
    return json({ results });
  } catch (e) {
    console.error(JSON.stringify({ event: "bank_sync_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Sync failed. Please try again." }, 500);
  }
});
