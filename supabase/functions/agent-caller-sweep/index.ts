// supabase/functions/agent-caller-sweep/index.ts
//
// Cron (every minute): POST with header X-Cron-Secret: $CRON_SECRET.
//   1. agent_holds_sweep(): notify owners 15 min before an AI-agent hold expires, then release expired holds
//      (the reserved job is cancelled so the window returns to capacity).
//   2. agent_callers_purge(): once per hour (minute 0) apply each business's retention_days.
// Deploy: supabase functions deploy agent-caller-sweep --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || !timingSafeEqual(req.headers.get("x-cron-secret") ?? "", secret)) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  try {
    const { data: holds, error } = await admin.rpc("agent_holds_sweep", { p_alert_minutes: 15 });
    if (error) throw error;
    let purged: unknown = null;
    if (new Date().getUTCMinutes() === 0) {
      const r = await admin.rpc("agent_callers_purge");
      if (r.error) throw r.error;
      purged = r.data;
    }
    return json({ ok: true, holds, purged });
  } catch (e) {
    console.error(JSON.stringify({ event: "agent_caller_sweep_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Sweep failed" }, 500);
  }
});
