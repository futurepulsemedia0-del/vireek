// supabase/functions/escalation-tick/index.ts
//
// Scans active escalation_events. When a tier's delay_minutes has
// elapsed with no acknowledgement, notifies the next tier (SMS and/or
// voice call) and advances current_tier. When tiers are exhausted,
// marks the event 'exhausted' and does one final SMS to the account
// owner directly. Tier 1's own first notification is sent immediately
// by escalate-emergency at creation time — this function only handles
// tier 2+ (see the edit to escalate-emergency/index.ts below).
//
// Run every 1-2 min — see the cron.schedule() comment at the bottom of
// 20261002000000_on_call_rotation_escalation.sql.
//
// Deploy: supabase functions deploy escalation-tick

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendSms, sendVoiceCall } from "../_shared/notify/deliver.ts";

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");

  const { data: events, error } = await admin
    .from("escalation_events")
    .select("id, user_id, schedule_id, current_tier, last_notified_at, ack_token, call_id")
    .eq("status", "active")
    .limit(100);

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  let escalated = 0, exhausted = 0;

  for (const ev of events ?? []) {
    const { data: tiers } = await admin
      .from("escalation_tiers")
      .select("tier_order, team_member_id, delay_minutes, notify_via")
      .eq("schedule_id", ev.schedule_id)
      .order("tier_order", { ascending: true });

    if (!tiers || tiers.length === 0) continue;

    const activeTier = tiers.find((t) => t.tier_order === ev.current_tier);
    const nextTier = tiers.find((t) => t.tier_order === ev.current_tier + 1);
    const elapsedMs = ev.last_notified_at ? Date.now() - new Date(ev.last_notified_at).getTime() : Infinity;
    if (!activeTier || elapsedMs < activeTier.delay_minutes * 60_000) continue;

    if (!nextTier) {
      const { data: profile } = await admin.from("profiles").select("phone").eq("id", ev.user_id).maybeSingle();
      if (profile?.phone) {
        await sendSms(profile.phone, `Vireek: on-call escalation exhausted with no acknowledgement (call ${ev.call_id ?? ev.id}). Please respond directly.`);
      }
      await admin.from("escalation_events").update({ status: "exhausted" }).eq("id", ev.id);
      exhausted++;
      continue;
    }

    const memberId = nextTier.team_member_id
      ?? (await admin.rpc("get_current_on_call", { p_schedule_id: ev.schedule_id })).data;
    if (!memberId) continue;

    const { data: member } = await admin.from("team_members").select("member_phone").eq("id", memberId).maybeSingle();
    if (!member?.member_phone) continue;

    const ackUrl = `${siteUrl}/ack/${ev.ack_token}`;
    const body = `Vireek escalation (tier ${nextTier.tier_order}): unacknowledged emergency call. Tap to accept: ${ackUrl}`;

    if (nextTier.notify_via === "sms" || nextTier.notify_via === "both") {
      await sendSms(member.member_phone, body);
    }
    if (nextTier.notify_via === "call" || nextTier.notify_via === "both") {
      await sendVoiceCall(member.member_phone, "You have an unacknowledged emergency escalation from Vireek. Please check your text messages immediately.");
    }

    await admin.from("escalation_events")
      .update({ current_tier: nextTier.tier_order, last_notified_at: new Date().toISOString() })
      .eq("id", ev.id);
    escalated++;
  }

  return new Response(JSON.stringify({ escalated, exhausted }), { headers: { "Content-Type": "application/json" } });
});
