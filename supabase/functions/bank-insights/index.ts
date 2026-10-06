import { adminClient, authenticate, corsHeaders, json } from "../_shared/bank/http.ts";
import { computeInsights } from "../_shared/bank/engine.ts";

// POST { horizon_days?: 30..180, save_brief?: boolean } -> { insights }
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const db = adminClient();
    const caller = await authenticate(req, db);
    if (caller instanceof Response) return caller;
    const body = await req.json().catch(() => ({}));
    const horizon = Math.max(30, Math.min(180, Number(body.horizon_days) || 90));
    const insights = await computeInsights(db, caller.ownerId, horizon, body.save_brief === true);
    return json({ insights });
  } catch (e) {
    console.error(JSON.stringify({ event: "bank_insights_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Could not compute bank insights." }, 500);
  }
});
