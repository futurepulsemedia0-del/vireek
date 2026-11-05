// supabase/functions/mass-incident/index.ts
//
// Mass Incident Mode — server actions that cannot be done from the browser.
//
//   1. Scheduler:  POST {action:"sweep"}  + header  X-Cron-Secret: <MASS_INCIDENT_CRON_SECRET>
//      Moves quiet incidents active -> monitoring -> resolved, re-scores them as evidence expires, and marks
//      directory entries older than 365 days as stale (so they are never spoken to a caller again).
//   2. Owner:      POST {action:"broadcast", incident_id, kind:"update"|"resolved", dry_run?:boolean}
//      + header  Authorization: Bearer <user JWT>
//      Texts the people who contacted us about this incident. dry_run returns the exact text and recipient count
//      and sends NOTHING. Every send goes through sendCompliantSms (A2P approval, DNC / STOP, quiet hours).
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (provided), MASS_INCIDENT_CRON_SECRET.
// Deploy:  supabase functions deploy mass-incident --no-verify-jwt     (auth is checked in this file)
// Cron:    every 10 minutes, e.g. via pg_cron + pg_net, header X-Cron-Secret.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { broadcastToIncident, sweepIncidents } from "../_shared/mass-incident/runtime.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BROADCAST_COOLDOWN_MS = 10 * 60_000;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !serviceKey || !anonKey) return json({ error: "Server misconfiguration" }, 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const action = typeof body.action === "string" ? body.action : "";

  try {
    // ---------------- cron ----------------
    if (action === "sweep") {
      const secret = Deno.env.get("MASS_INCIDENT_CRON_SECRET");
      const given = req.headers.get("x-cron-secret") ?? "";
      if (!secret || !timingSafeEqual(secret, given)) return json({ error: "Unauthorized" }, 401);
      return json({ ok: true, ...(await sweepIncidents(admin)) });
    }

    // ---------------- owner broadcast ----------------
    if (action === "broadcast") {
      const auth = req.headers.get("Authorization") ?? "";
      if (!auth.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
      // A client bound to the CALLER's JWT, so tenant + permission come from the database, not from the request body.
      const user = createClient(url, anonKey, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
      const { data: who, error: whoErr } = await user.auth.getUser();
      if (whoErr || !who?.user) return json({ error: "Unauthorized" }, 401);
      const { data: ownerId } = await user.rpc("get_account_owner_id");
      const { data: canManage } = await user.rpc("can_manage_mass_incidents");
      if (!ownerId || canManage !== true) return json({ error: "Forbidden" }, 403);

      const incidentId = String(body.incident_id ?? "");
      const kind = body.kind === "resolved" ? "resolved" : body.kind === "update" ? "update" : null;
      const dryRun = body.dry_run !== false; // default SAFE: preview only unless explicitly false
      if (!UUID_RE.test(incidentId) || !kind) return json({ error: "incident_id and kind are required" }, 400);

      if (!dryRun) {
        const since = new Date(Date.now() - BROADCAST_COOLDOWN_MS).toISOString();
        const { count } = await admin.from("mass_incident_events").select("id", { count: "exact", head: true })
          .eq("user_id", ownerId as string).eq("incident_id", incidentId).eq("kind", `broadcast_${kind}`).gte("created_at", since);
        if ((count ?? 0) > 0) return json({ error: "A message for this incident was sent in the last 10 minutes." }, 429);
      }

      const result = await broadcastToIncident(admin, {
        userId: ownerId as string, incidentId, kind, actorId: who.user.id, dryRun,
        brandName: typeof body.brand_name === "string" ? body.brand_name.slice(0, 80) : null,
      });
      if ("error" in result) return json(result, result.error === "incident_not_found" ? 404 : 422);
      return json({ ok: true, dry_run: dryRun, ...result });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(JSON.stringify({ event: "mass_incident_function_failed", action, error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Temporary failure" }, 500);
  }
});
