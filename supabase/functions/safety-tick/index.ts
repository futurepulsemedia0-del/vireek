// supabase/functions/safety-tick/index.ts
//
// Lone-worker engine. Two callers:
//  1. Cron (X-Cron-Secret = CRON_SECRET): mode "tick" every minute, mode "fairness" weekly.
//  2. A signed-in technician right after pressing the duress button or after a missed check-in is
//     noticed on the device: { mode: "session", session_id } so the first escalation does not wait for cron.
//     The JWT must belong to the technician who owns that session.
//
// Deploy: supabase functions deploy safety-tick
// Secrets: CRON_SECRET (required in production), TWILIO_* (already used by escalation-tick).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { runTick } from "../_shared/safety/runtime.ts";
import { runFairnessForAll } from "../_shared/safety/fairness.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !serviceKey) return json({ error: "Server misconfiguration" }, 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let body: { mode?: string; session_id?: string } = {};
  try { body = await req.json(); } catch { /* empty body = tick */ }
  const mode = body.mode ?? "tick";

  const cronSecret = Deno.env.get("CRON_SECRET");
  const provided = req.headers.get("X-Cron-Secret") ?? "";
  const isCron = !!cronSecret && constantTimeEqual(provided, cronSecret);

  try {
    if (mode === "session") {
      if (!body.session_id || !/^[0-9a-f-]{36}$/i.test(body.session_id)) return json({ error: "Invalid session" }, 400);
      if (!isCron) {
        const auth = req.headers.get("Authorization");
        if (!auth || !anonKey) return json({ error: "Unauthorized" }, 401);
        const userClient = createClient(url, anonKey, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
        // RLS-safe ownership check: the RPC only returns a session that belongs to the caller.
        const { data: me } = await userClient.rpc("get_my_team_member_id");
        if (!me) return json({ error: "Unauthorized" }, 401);
        const { data: owned } = await admin.from("safety_sessions").select("id").eq("id", body.session_id).eq("team_member_id", me as string).maybeSingle();
        if (!owned) return json({ error: "Not found" }, 404);
      }
      return json({ ok: true, result: await runTick(admin, new Date(), body.session_id) });
    }

    // Everything below is cron-only. If CRON_SECRET is not set, refuse rather than run open.
    if (!isCron) return json({ error: "Unauthorized" }, 401);
    if (mode === "fairness") return json({ ok: true, result: await runFairnessForAll(admin) });
    return json({ ok: true, result: await runTick(admin) });
  } catch (err) {
    console.error(JSON.stringify({ event: "safety_tick_failed", error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "Safety tick failed" }, 500);
  }
});
