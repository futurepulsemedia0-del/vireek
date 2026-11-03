// supabase/functions/live-surface-dispatch/index.ts
// Sends Live Activity (iOS, via APNs) and ongoing-notification (Android, via FCM data message) updates
// for a live_calls row. Called only by the dispatch_live_surface trigger (pg_net).
//
// Secrets: PUSH_DISPATCH_SECRET (shared with send-push-notification), FCM_SERVICE_ACCOUNT_JSON,
//          APNS_KEY_P8 / APNS_KEY_ID / APNS_TEAM_ID / APNS_BUNDLE_ID (optional: without them iOS is skipped).
// Deploy: supabase functions deploy live-surface-dispatch --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isFcmConfigured, sendFcmData } from "../_shared/notify/fcm.ts";
import { isApnsConfigured, sendLiveActivity, type ApnsLiveKind } from "../_shared/notify/apns.ts";
import { buildLiveState, dismissalDateSec, type LiveCallRow, type LiveEvent } from "../_shared/notify/liveSurface.ts";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);
  const expected = Deno.env.get("PUSH_DISPATCH_SECRET");
  if (!expected) return json({ success: false, error: "Server not configured" }, 500);
  if (req.headers.get("x-push-dispatch-secret") !== expected) return json({ success: false, error: "Unauthorized" }, 401);

  let body: { live_call_id?: string; event?: LiveEvent };
  try { body = await req.json(); } catch { return json({ success: false, error: "Invalid JSON body" }, 400); }
  if (!body.live_call_id || !["started", "updated", "ended"].includes(body.event ?? "")) {
    return json({ success: false, error: "live_call_id and a valid event are required" }, 400);
  }
  const event = body.event as LiveEvent;

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: row, error } = await admin.from("live_calls")
    .select("id, user_id, vapi_call_id, status, is_emergency, handoff_status, started_at, ended_at, caller_name, intent")
    .eq("id", body.live_call_id).maybeSingle();
  if (error) return json({ success: false, error: "Lookup failed" }, 500);
  if (!row) return json({ success: false, error: "Not found" }, 404);

  const accountId = row.user_id as string;
  const call = row as unknown as LiveCallRow;

  const [{ data: devices }, { data: tokens }] = await Promise.all([
    admin.from("device_push_tokens").select("id, token, platform, subscriber_user_id").eq("user_id", accountId),
    admin.from("live_activity_tokens").select("id, token, kind, target, subscriber_user_id").eq("user_id", accountId),
  ]);

  const subIds = [...new Set([...(devices ?? []), ...(tokens ?? [])].map((d) => d.subscriber_user_id).filter(Boolean))] as string[];
  const prefs = new Map<string, { hide: boolean; live: boolean }>();
  if (subIds.length) {
    const { data } = await admin.from("user_mobile_surface_prefs")
      .select("user_id, hide_customer_names, live_activities_enabled").in("user_id", subIds);
    for (const p of data ?? []) prefs.set(p.user_id as string, { hide: p.hide_customer_names as boolean, live: p.live_activities_enabled as boolean });
  }
  const prefOf = (id: string | null) => (id ? prefs.get(id) : undefined) ?? { hide: true, live: true };

  let sent = 0, pruned = 0;
  const nowMs = Date.now();

  // Android: data-only FCM; the app's service posts / updates / cancels the ongoing notification.
  if (isFcmConfigured()) {
    for (const d of (devices ?? []).filter((x) => x.platform === "android")) {
      const p = prefOf(d.subscriber_user_id);
      if (!p.live) continue;
      const s = buildLiveState(call, p.hide);
      const r = await sendFcmData(d.token as string, {
        kind: event === "ended" ? "live_end" : "live", tag: s.callId, stage: s.stage, emergency: String(s.emergency),
        title: s.headline, body: s.detail, startedAt: String(s.startedAtMs),
        url: "/dashboard/live-calls", severity: s.emergency ? "critical" : "normal",
      }, { androidChannel: s.emergency ? "vireek_critical" : "vireek_normal" });
      if (r.ok) sent++;
      else if (r.unregistered) { await admin.from("device_push_tokens").delete().eq("id", d.id); pruned++; }
    }
  }

  // iOS: ActivityKit pushes. 'start' uses push-to-start tokens, 'update'/'end' use the per-activity token.
  if (isApnsConfigured()) {
    const pick = (kind: "start" | "update") => (tokens ?? []).filter((t) =>
      t.kind === kind && (kind === "start" || t.target === call.vapi_call_id));
    const plan: Array<{ list: typeof tokens; apns: ApnsLiveKind }> =
      event === "started" ? [{ list: pick("start"), apns: "start" }]
      : event === "ended" ? [{ list: pick("update"), apns: "end" }]
      : [{ list: pick("update"), apns: "update" }];
    for (const { list, apns } of plan) {
      for (const t of list ?? []) {
        const p = prefOf(t.subscriber_user_id);
        if (!p.live) continue;
        const s = buildLiveState(call, p.hide);
        const r = await sendLiveActivity(t.token as string, apns, s, apns === "end" ? dismissalDateSec(s.endedAtMs, nowMs) : undefined);
        if (r.ok) sent++;
        else if (r.gone) { await admin.from("live_activity_tokens").delete().eq("id", t.id); pruned++; }
      }
    }
  }

  return json({ success: true, sent, pruned });
});
