// telematics-sync — scheduled poller for providers without push (Samsara snapshot).
// Auth: X-Cron-Secret == TELEMATICS_CRON_SECRET, or the service-role bearer token.
// Deploy: supabase functions deploy telematics-sync --no-verify-jwt ; schedule every minute.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsPreflight, decryptJson, jsonResponse, timingSafeEqualStr } from "../_shared/telematics/security.ts";
import { VehicleSession } from "../_shared/telematics/ingest.ts";
import { fetchSnapshots, SamsaraError } from "../_shared/telematics/samsara.ts";

const TIME_BUDGET_MS = 45_000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight();
  const supabaseUrl = Deno.env.get("SUPABASE_URL"), serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return jsonResponse({ error: "Server misconfiguration." }, 500);

  const cron = Deno.env.get("TELEMATICS_CRON_SECRET") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const okCron = cron.length >= 16 && timingSafeEqualStr(req.headers.get("X-Cron-Secret") ?? "", cron);
  if (!okCron && !(bearer && timingSafeEqualStr(bearer, serviceKey))) return jsonResponse({ error: "Unauthorized." }, 401);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const started = Date.now();
  const out = { connections: 0, vehicles: 0, fixes: 0, arrivals: 0, departures: 0, errors: 0 };

  const { data: conns, error } = await admin.from("telematics_connections").select("id, user_id, settings").eq("provider", "samsara").in("status", ["connected", "error"]);
  if (error) return jsonResponse({ error: "Could not load connections." }, 500);

  for (const conn of conns ?? []) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    out.connections++;
    try {
      const { data: cred } = await admin.from("telematics_credentials").select("encrypted").eq("connection_id", conn.id).maybeSingle();
      const apiToken = cred ? (await decryptJson<{ api_token?: string }>(cred.encrypted)).api_token : undefined;
      if (!apiToken) throw new SamsaraError("Missing Samsara API token.", 401);

      const [{ data: vehicles }, snaps] = await Promise.all([
        admin.from("vehicles").select("id, user_id, assigned_technician_id, telematics_external_id").eq("telematics_connection_id", conn.id).neq("status", "retired"),
        fetchSnapshots(apiToken),
      ]);
      const byExt = new Map((vehicles ?? []).map((v) => [String(v.telematics_external_id), v]));

      for (const s of snaps) {
        const v = byExt.get(s.externalId);
        if (!v || !s.fix) continue;
        const session = new VehicleSession(admin, v, conn.settings);
        await session.init();
        await session.push(s.fix);
        await session.flush();
        out.vehicles++; out.fixes += session.stats.fixes; out.arrivals += session.stats.arrivals; out.departures += session.stats.departures;
      }
      await admin.from("telematics_connections").update({ status: "connected", last_sync_at: new Date().toISOString(), last_error: null }).eq("id", conn.id);
    } catch (e) {
      out.errors++;
      const msg = e instanceof SamsaraError ? e.message : "Sync failed.";
      console.error(JSON.stringify({ event: "telematics_sync_failed", connection: conn.id, error: String(e) }));
      await admin.from("telematics_connections").update({ status: "error", last_error: msg }).eq("id", conn.id);
    }
  }
  return jsonResponse({ ok: true, ...out });
});
