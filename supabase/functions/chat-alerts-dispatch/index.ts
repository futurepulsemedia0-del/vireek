// supabase/functions/chat-alerts-dispatch/index.ts
//
// Called by the dispatch_chat_alerts() Postgres trigger through pg_net —
// never by a browser. Looks up the account owner's enabled rules for the event,
// builds the message, posts it to Slack and/or Teams, and logs every attempt
// to chat_alert_deliveries for the settings page.
//
// Auth: shared secret in `x-push-dispatch-secret` (same as event-bus-dispatch).
//
// Required secrets (already set if the event bus is deployed):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PUSH_DISPATCH_SECRET
// Plus the ones chat-integrations needs for Teams token refresh:
//   TEAMS_CLIENT_ID, TEAMS_CLIENT_SECRET, TEAMS_TENANT (optional), SITE_URL
//
// Deploy:
//   supabase functions deploy chat-alerts-dispatch --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { ALERT_EVENT_TYPES, buildAlertMessage, shouldSendAlert, type AlertEventType, type ChatProvider } from "../_shared/chat/alerts.ts";
import { deliverAlert, type ConnectionRow } from "../_shared/chat/providers.ts";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const expected = Deno.env.get("PUSH_DISPATCH_SECRET") ?? "";
  const provided = req.headers.get("x-push-dispatch-secret") ?? "";
  if (!expected || !safeEqual(provided, expected)) return json({ error: "Unauthorized" }, 401);

  const body = (await req.json().catch(() => ({}))) as { owner_id?: string; event_type?: string; record?: Record<string, unknown> };
  const eventType = body.event_type as AlertEventType;
  if (!body.owner_id || !body.record || !ALERT_EVENT_TYPES.includes(eventType)) return json({ error: "Invalid payload" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

  try {
    const { data: rules } = await db
      .from("chat_alert_rules")
      .select("provider, enabled, channel_id, channel_name, container_id, threshold")
      .eq("user_id", body.owner_id)
      .eq("event_type", eventType)
      .eq("enabled", true);
    const active = (rules ?? []).filter((r) => shouldSendAlert(r, eventType, body.record!));
    if (active.length === 0) return json({ delivered: 0 });

    // Low-CSAT alerts show who the call was with.
    let call: { callerName: string | null; callerPhone: string | null } | undefined;
    if (eventType === "low_csat" && typeof body.record.call_id === "string") {
      const { data } = await db.from("calls").select("caller_name, caller_phone").eq("id", body.record.call_id).eq("user_id", body.owner_id).maybeSingle();
      if (data) call = { callerName: data.caller_name, callerPhone: data.caller_phone };
    }
    const message = buildAlertMessage(eventType, body.record, call);

    let delivered = 0;
    for (const rule of active) {
      const provider = rule.provider as ChatProvider;
      const { data: conn } = await db.from("chat_connections").select("id, user_id, provider").eq("user_id", body.owner_id).eq("provider", provider).maybeSingle();
      if (!conn) continue;
      const failure = await deliverAlert(db, conn as ConnectionRow, rule, message, siteUrl);
      if (!failure) delivered++;
      await db.from("chat_alert_deliveries").insert({
        user_id: body.owner_id, provider, event_type: eventType, status: failure ? "failed" : "sent",
        channel_name: rule.channel_name, error: failure,
      });
    }
    return json({ delivered });
  } catch (e) {
    console.error(JSON.stringify({ event: "chat_alerts_dispatch_failed", owner_id: body.owner_id, error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Dispatch failed" }, 500);
  }
});
