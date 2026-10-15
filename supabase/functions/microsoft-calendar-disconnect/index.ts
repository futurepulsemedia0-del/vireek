// Deploy: supabase functions deploy microsoft-calendar-disconnect
// Body: { connection_id: string, delete_events?: boolean }
// Microsoft has no token-revocation endpoint for this flow: we delete the stored tokens, which ends all access from
// Vireek. The user can also remove the app at https://myapps.microsoft.com.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { normalizeTenant } from "../_shared/microsoft-calendar/engine.ts";
import { resolveActorFromJwt } from "../_shared/microsoft-calendar/actor.ts";
import { ensureAccessToken, graphRequest } from "../_shared/microsoft-calendar/graph.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MAX_EVENT_DELETES = 200;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const actor = await resolveActorFromJwt(admin, jwt);
    if (!actor) return json({ error: "Invalid or expired session." }, 401);

    const body = await req.json().catch(() => ({}));
    const connectionId = typeof body?.connection_id === "string" ? body.connection_id : "";
    if (!connectionId) return json({ error: "connection_id is required." }, 400);

    const { data: conn } = await admin
      .from("microsoft_calendar_connections")
      .select("id, account_owner_id, user_id, scope")
      .eq("id", connectionId)
      .eq("account_owner_id", actor.accountOwnerId)
      .maybeSingle();
    if (!conn) return json({ error: "Connection not found." }, 404);
    if (!actor.canManage && conn.user_id !== actor.userId) return json({ error: "You can only disconnect your own calendar." }, 403);

    let removedEvents = 0;
    if (body?.delete_events === true) {
      try {
        const token = await ensureAccessToken(admin, conn.id, {
          tenant: normalizeTenant(Deno.env.get("MICROSOFT_CALENDAR_TENANT_ID")),
          clientId: Deno.env.get("MICROSOFT_CALENDAR_CLIENT_ID") ?? "",
          clientSecret: Deno.env.get("MICROSOFT_CALENDAR_CLIENT_SECRET") ?? "",
        });
        const { data: rows } = await admin
          .from("microsoft_calendar_event_map")
          .select("ms_event_id")
          .eq("connection_id", conn.id)
          .eq("status", "synced")
          .limit(MAX_EVENT_DELETES);
        for (const row of rows ?? []) {
          try {
            await graphRequest(token, `/me/events/${encodeURIComponent(row.ms_event_id)}`, { method: "DELETE" });
            removedEvents++;
          } catch { /* already gone or no longer reachable: best effort */ }
        }
      } catch (e) {
        console.error(JSON.stringify({ event: "ms_calendar_disconnect_event_cleanup_failed", connection_id: conn.id, error: e instanceof Error ? e.message : String(e) }));
      }
    }

    await admin.from("microsoft_calendar_secrets").delete().eq("connection_id", conn.id);
    await admin.from("calendar_busy_blocks").delete().eq("connection_id", conn.id);
    await admin.from("microsoft_calendar_event_map").delete().eq("connection_id", conn.id);
    await admin.from("microsoft_calendar_connections").update({
      status: "disconnected", delta_link: null, delta_window_end: null, sync_locked_until: null,
      last_error_code: null, last_error_message: null, consecutive_failures: 0,
    }).eq("id", conn.id);

    if (conn.scope === "office") {
      const { data: row } = await admin.from("integrations").select("id, config").eq("user_id", conn.account_owner_id).eq("integration_type", "microsoft_calendar").maybeSingle();
      if (row) {
        await admin.from("integrations").update({
          status: "disconnected",
          config: { ...(row.config ?? {}), error_code: "manual_disconnect", error_message: null, failed_at: new Date().toISOString() },
        }).eq("id", row.id);
      }
    }
    return json({ ok: true, removed_events: removedEvents });
  } catch (error) {
    console.error(JSON.stringify({ event: "ms_calendar_disconnect_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Could not disconnect Microsoft 365." }, 500);
  }
});
