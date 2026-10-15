// Server-to-server: called by the `chat_dispatch_event()` Postgres trigger (pg_net) for each new chat_events row,
// and optionally by pg_cron with {"retry_due": true} to retry failures / orphaned events.
// Secrets: PUSH_DISPATCH_SECRET (shared with send-push-notification), CHAT_TOKEN_ENCRYPTION_KEY,
//          TEAMS_BOT_APP_ID / TEAMS_BOT_APP_SECRET / TEAMS_BOT_TENANT_ID (Teams only), SITE_URL
// Deploy:  supabase functions deploy chat-notify-dispatch --no-verify-jwt

import { timingSafeEqual } from "../_shared/chat-notify/security.ts";
import { deliverEvent } from "../_shared/chat-notify/delivery.ts";
import { adminClient, corsHeaders, json } from "../_shared/chat-notify/server.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR = 3_600_000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const expected = Deno.env.get("PUSH_DISPATCH_SECRET") ?? "";
  if (!expected || !timingSafeEqual(req.headers.get("x-push-dispatch-secret") ?? "", expected)) return json({ error: "Unauthorized" }, 401);

  let body: { event_id?: string; retry_due?: boolean };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const admin = adminClient();
  try {
    if (body.event_id) {
      if (!UUID.test(body.event_id)) return json({ error: "Invalid event_id" }, 400);
      return json(await deliverEvent(admin, body.event_id));
    }
    if (body.retry_due) {
      const since = new Date(Date.now() - 24 * HOUR).toISOString();
      const settled = new Date(Date.now() - 5 * 60_000).toISOString();
      const ids = new Set<string>();

      const { data: failed } = await admin.from("chat_deliveries").select("event_id").eq("status", "failed").lt("attempts", 6).lt("updated_at", settled).gt("created_at", since).limit(50);
      for (const f of failed ?? []) ids.add(f.event_id);

      const { data: recent } = await admin.from("chat_events").select("id").gt("created_at", since).lt("created_at", settled).order("created_at", { ascending: false }).limit(200);
      if (recent?.length) {
        const { data: done } = await admin.from("chat_deliveries").select("event_id").in("event_id", recent.map((r: { id: string }) => r.id));
        const have = new Set((done ?? []).map((d: { event_id: string }) => d.event_id));
        for (const r of recent) if (!have.has(r.id)) ids.add(r.id);
      }

      let sent = 0;
      for (const id of ids) sent += (await deliverEvent(admin, id)).sent;
      return json({ events: ids.size, sent });
    }
    return json({ error: "Provide event_id or retry_due." }, 400);
  } catch (e) {
    console.error(JSON.stringify({ event: "chat_dispatch_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Dispatch failed." }, 500);
  }
});
