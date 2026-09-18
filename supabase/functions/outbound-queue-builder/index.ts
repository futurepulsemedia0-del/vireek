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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(JSON.stringify({ event: "escalation_tick_failed", error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }));
    return new Response(JSON.stringify({ error: "Server misconfiguration." }), { status: 500 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");

  const { data: events, error } = await admin
    .from("escalation_events")
    .select("id, user_id, schedule_id, current_tier, last_notified_at, ack_token, call_id")
    .eq("status", "active")
    .limit(100);

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  let escalated = 0, exhausted = 0, failed = 0;

  for (const ev of events ?? []) {
    try {
      const { data: tiers, error: tiersError } = await admin
        .from("escalation_tiers")
        .select("tier_order, team_member_id, delay_minutes, notify_via")
        .eq("schedule_id", ev.schedule_id)
        .order("tier_order", { ascending: true });

      if (tiersError) throw tiersError;
      if (!tiers || tiers.length === 0) continue;

      const activeTier = tiers.find((t) => t.tier_order === ev.current_tier);
      const nextTier = tiers.find((t) => t.tier_order === ev.current_tier + 1);
      const elapsedMs = ev.last_notified_at ? Date.now() - new Date(ev.last_notified_at).getTime() : Infinity;
      if (!activeTier || elapsedMs < activeTier.delay_minutes * 60_000) continue;

      if (!nextTier) {
        const { data: profile, error: profileError } = await admin
          .from("profiles")
          .select("phone")
          .eq("id", ev.user_id)
          .maybeSingle();
        if (profileError) throw profileError;

        if (profile?.phone) {
          await sendSms(profile.phone, `Vireek: on-call escalation exhausted with no acknowledgement (call ${ev.call_id ?? ev.id}). Please respond directly.`);
        }

        const { data: updatedExhausted, error: exhaustError } = await admin
          .from("escalation_events")
          .update({ status: "exhausted" })
          .eq("id", ev.id)
          .eq("status", "active")
          .select("id");
        if (exhaustError) throw exhaustError;
        if (updatedExhausted && updatedExhausted.length > 0) exhausted++;
        continue;
      }

      let memberId = nextTier.team_member_id;
      if (!memberId) {
        const { data: onCallId, error: onCallError } = await admin.rpc("get_current_on_call", { p_schedule_id: ev.schedule_id });
        if (onCallError) throw onCallError;
        memberId = onCallId;
      }
      if (!memberId) continue;

      const { data: member, error: memberError } = await admin
        .from("team_members")
        .select("member_phone")
        .eq("id", memberId)
        .maybeSingle();
      if (memberError) throw memberError;
      if (!member?.member_phone) continue;

      const ackUrl = `${siteUrl}/ack/${ev.ack_token}`;
      const body = `Vireek escalation (tier ${nextTier.tier_order}): unacknowledged emergency call. Tap to accept: ${ackUrl}`;

      if (nextTier.notify_via === "sms" || nextTier.notify_via === "both") {
        await sendSms(member.member_phone, body);
      }
      if (nextTier.notify_via === "call" || nextTier.notify_via === "both") {
        await sendVoiceCall(member.member_phone, "You have an unacknowledged emergency escalation from Vireek. Please check your text messages immediately.");
      }

      const { data: updatedEvent, error: updateError } = await admin
        .from("escalation_events")
        .update({ current_tier: nextTier.tier_order, last_notified_at: new Date().toISOString() })
        .eq("id", ev.id)
        .eq("current_tier", ev.current_tier)
        .select("id");
      if (updateError) throw updateError;
      if (updatedEvent && updatedEvent.length > 0) escalated++;
    } catch (evError) {
      failed++;
      console.error(JSON.stringify({
        event: "escalation_tick_event_failed",
        escalation_event_id: ev.id,
        error: evError instanceof Error ? evError.message : String(evError),
      }));
    }
  }

  return new Response(JSON.stringify({ escalated, exhausted, failed }), { headers: { "Content-Type": "application/json" } });
});
