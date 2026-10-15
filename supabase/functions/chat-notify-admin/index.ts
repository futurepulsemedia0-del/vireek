// Authenticated (owner-only) helper for the Integrations UI.
// POST { action: "list_channels" | "refresh_channels" | "send_test" | "resend" | "disconnect", ... }
// Deploy: supabase functions deploy chat-notify-admin

import { CHAT_EVENT_TYPES, SAMPLE_PAYLOADS, buildMessageModel, isChatEventType } from "../_shared/chat-notify/events.ts";
import { deliverEvent, getSlackToken, loadTechnicians, sendToRoute, slackListChannels, slackRevoke, syncTeamChannels } from "../_shared/chat-notify/delivery.ts";
import { adminClient, corsHeaders, json, requireOwner, siteUrl } from "../_shared/chat-notify/server.ts";

type Provider = "slack" | "teams";
const isProvider = (v: unknown): v is Provider => v === "slack" || v === "teams";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const db = adminClient();
  const auth = await requireOwner(req, db);
  if (auth instanceof Response) return auth;
  const { ownerId } = auth;

  let body: { action?: string; provider?: string; event_type?: string; delivery_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  try {
    if (body.action === "resend") {
      if (!body.delivery_id || !UUID.test(body.delivery_id)) return json({ error: "Invalid delivery_id" }, 400);
      const { data: d } = await db.from("chat_deliveries").select("event_id, user_id").eq("id", body.delivery_id).maybeSingle();
      if (!d || d.user_id !== ownerId) return json({ error: "Delivery not found." }, 404);
      return json({ ok: true, ...(await deliverEvent(db, d.event_id)) });
    }

    if (!isProvider(body.provider)) return json({ error: "Unknown provider." }, 400);
    const { data: conn } = await db.from("chat_connections").select("*").eq("user_id", ownerId).eq("provider", body.provider).maybeSingle();
    if (!conn) return json({ error: "Not connected." }, 404);

    switch (body.action) {
      case "list_channels": {
        if (body.provider === "slack") return json({ channels: await slackListChannels(await getSlackToken(db, conn.id)) });
        const { data } = await db.from("chat_channels").select("channel_id, channel_name, team_name").eq("connection_id", conn.id).order("team_name").order("channel_name");
        return json({ channels: (data ?? []).map((c: { channel_id: string; channel_name: string; team_name: string | null }) => ({ id: c.channel_id, name: c.channel_name, group: c.team_name })) });
      }
      case "refresh_channels": {
        if (body.provider !== "teams") return json({ ok: true, teams: 0 });
        const { data } = await db.from("chat_channels").select("team_id, team_name, service_url").eq("connection_id", conn.id);
        const seen = new Map<string, { team_name: string | null; service_url: string }>();
        for (const r of data ?? []) seen.set(r.team_id, { team_name: r.team_name, service_url: r.service_url });
        for (const [teamId, t] of seen) await syncTeamChannels(db, conn, t.service_url, teamId, t.team_name);
        return json({ ok: true, teams: seen.size });
      }
      case "send_test": {
        if (!isChatEventType(body.event_type)) return json({ error: `event_type must be one of: ${CHAT_EVENT_TYPES.join(", ")}` }, 400);
        const { data: route } = await db.from("chat_routes").select("*").eq("connection_id", conn.id).eq("event_type", body.event_type).maybeSingle();
        if (!route) return json({ error: "Choose a channel for this event first." }, 400);
        const model = buildMessageModel(
          { id: crypto.randomUUID(), eventType: body.event_type, payload: SAMPLE_PAYLOADS[body.event_type] },
          { siteUrl: siteUrl(), includeContact: route.include_contact_details, actionsEnabled: false, technicians: await loadTechnicians(db, ownerId) },
        );
        model.title = `${model.title} (test)`;
        model.summary = `This is a test message from Vireek. ${model.summary}`;
        const r = await sendToRoute(db, route, conn, model);
        return r.ok ? json({ ok: true }) : json({ error: r.error ?? "Could not send the test message." }, 502);
      }
      case "disconnect": {
        if (body.provider === "slack") {
          try { await slackRevoke(await getSlackToken(db, conn.id)); } catch { /* token may already be gone */ }
        }
        await db.from("chat_connections").delete().eq("id", conn.id); // cascades: secrets, channels, routes, deliveries
        return json({ ok: true });
      }
      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "chat_admin_failed", action: body.action, error: e instanceof Error ? e.message : String(e) }));
    return json({ error: e instanceof Error ? e.message : "Request failed." }, 500);
  }
});
