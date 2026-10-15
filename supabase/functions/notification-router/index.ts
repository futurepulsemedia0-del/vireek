// supabase/functions/notification-router/index.ts
//
// Applies the owner's notification_routing_rules to a `notifications` row:
// who gets it, over which channel (push / SMS / email / Slack), by role,
// on-call rotation, schedule window and severity — and, when a rule asks
// for it, opens an escalation_events row so the EXISTING escalation-tick
// keeps escalating through escalation_tiers until someone acknowledges
// (tap the /ack/:token link, or acknowledge_notification() in the app).
//
// Two ways in:
//   1. Database trigger (pg_net)  -> header  x-push-dispatch-secret  + { notification_id }
//   2. Signed-in owner (dashboard) -> Authorization: Bearer <jwt>    + { dry_run: true, type, severity, at? }
//      Dry run sends NOTHING; it returns who WOULD be notified (rule preview).
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided), PUSH_DISPATCH_SECRET
// (same value as app.settings.push_dispatch_secret), optional SITE_URL,
// TWILIO_* (SMS), RESEND_API_KEY / RESEND_FROM_EMAIL (email).
//
// Deploy: supabase functions deploy notification-router --no-verify-jwt

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail, sendSms } from "../_shared/notify/deliver.ts";
import {
  buildEmail,
  buildSlackPayload,
  buildSms,
  inferSeverity,
  isCoolingDown,
  isSeverity,
  planRouting,
  ruleMatches,
  type Channel,
  type Directory,
  type MemberRecipient,
  type PlannedDelivery,
  type RoutingRule,
  type Severity,
} from "../_shared/notify/routing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, x-push-dispatch-secret",
};

const MAX_DELIVERIES_PER_RUN = 60;
const HTTP_TIMEOUT_MS = 8000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const RULE_COLUMNS =
  "id, name, is_active, priority, notification_types, min_severity, target_type, target_role, target_member_id, schedule_id, channels, active_days, window_start, window_end, timezone, escalate_if_unacked, cooldown_minutes";

async function loadDirectory(admin: SupabaseClient, ownerId: string, rules: RoutingRule[]): Promise<Directory> {
  const [{ data: profile }, { data: team }] = await Promise.all([
    admin.from("profiles").select("email, full_name, phone").eq("id", ownerId).maybeSingle(),
    admin
      .from("team_members")
      .select("id, member_email, member_name, member_phone, role")
      .eq("account_owner_id", ownerId)
      .eq("invite_status", "active"),
  ]);

  const members: MemberRecipient[] = (team ?? []).map((t) => ({
    key: `member:${t.id}`,
    memberId: t.id,
    role: t.role,
    label: t.member_name || t.member_email,
    phone: t.member_phone ?? null,
    email: t.member_email ?? null,
  }));

  const onCallByScheduleId: Record<string, string | null> = {};
  const scheduleIds = [...new Set(rules.filter((r) => r.target_type === "on_call" && r.schedule_id).map((r) => r.schedule_id as string))];
  await Promise.all(
    scheduleIds.map(async (id) => {
      const { data } = await admin.rpc("get_current_on_call", { p_schedule_id: id });
      onCallByScheduleId[id] = (data as string | null) ?? null;
    }),
  );

  return {
    owner: { key: "owner", label: profile?.full_name || profile?.email || "Account owner", phone: profile?.phone ?? null, email: profile?.email ?? null },
    members,
    onCallByScheduleId,
  };
}

async function loadRules(admin: SupabaseClient, ownerId: string): Promise<RoutingRule[]> {
  const { data, error } = await admin
    .from("notification_routing_rules")
    .select(RULE_COLUMNS)
    .eq("user_id", ownerId)
    .eq("is_active", true)
    .order("priority", { ascending: true });
  if (error) throw error;
  return (data ?? []) as RoutingRule[];
}

// ---------------------------------------------------------------------------
// Dry run (signed-in owner)
// ---------------------------------------------------------------------------
async function handleDryRun(admin: SupabaseClient, req: Request, body: Record<string, unknown>) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Missing Authorization header" }, 401);
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);
  const ownerId = userData.user.id; // only an owner has rules under their own id

  const type = typeof body.type === "string" && body.type.trim() ? body.type.trim().slice(0, 64) : "system";
  const severity: Severity = isSeverity(body.severity) ? body.severity : inferSeverity(type);
  const at = typeof body.at === "string" ? new Date(body.at) : new Date();
  if (Number.isNaN(at.getTime())) return json({ error: "Invalid 'at' timestamp" }, 400);

  const rules = await loadRules(admin, ownerId);
  const [dir, { data: settings }] = await Promise.all([
    loadDirectory(admin, ownerId, rules),
    admin.from("notification_routing_settings").select("slack_webhook_url, fallback_to_push").eq("user_id", ownerId).maybeSingle(),
  ]);

  const plan = planRouting(rules, { type, severity }, dir, at, { slackConfigured: Boolean(settings?.slack_webhook_url) });
  const ruleName = new Map(rules.map((r) => [r.id, r.name]));

  return json({
    dry_run: true,
    type,
    severity,
    at: at.toISOString(),
    matched_rules: plan.matchedRuleIds.map((id) => ({ id, name: ruleName.get(id) ?? id })),
    fallback_to_push: plan.unmatched ? (settings?.fallback_to_push ?? true) : false,
    escalations: plan.escalations.map((e) => ({ rule: ruleName.get(e.ruleId) ?? e.ruleId, schedule_id: e.scheduleId })),
    deliveries: plan.deliveries.map((d) => ({
      rule: ruleName.get(d.ruleId) ?? d.ruleId,
      channel: d.channel,
      recipient: d.recipient?.label ?? (d.channel === "slack" ? "Slack channel" : "— nobody —"),
      skip_reason: d.skipReason,
    })),
  });
}

// ---------------------------------------------------------------------------
// Real delivery (database trigger)
// ---------------------------------------------------------------------------
async function pushVia(
  functionsBase: string,
  secret: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; sent: number; error?: string }> {
  try {
    const res = await fetch(`${functionsBase}/send-push-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-push-dispatch-secret": secret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, sent: 0, error: `push HTTP ${res.status}` };
    return { ok: true, sent: Number(data?.sent ?? 0) };
  } catch (e) {
    return { ok: false, sent: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

async function handleRoute(admin: SupabaseClient, notificationId: string, secret: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
  const functionsBase = `${supabaseUrl.replace(/\/$/, "")}/functions/v1`;

  const { data: n, error: nErr } = await admin
    .from("notifications")
    .select("id, user_id, type, title, message, action_url, severity")
    .eq("id", notificationId)
    .maybeSingle();
  if (nErr) throw nErr;
  if (!n) return json({ error: "Notification not found" }, 404);

  const ownerId: string = n.user_id;
  const severity = inferSeverity(n.type, n.severity);
  const now = new Date();

  const rules = await loadRules(admin, ownerId);
  if (rules.length === 0) return json({ routed: false, reason: "no_active_rules" });

  const [dir, { data: settings }] = await Promise.all([
    loadDirectory(admin, ownerId, rules),
    admin.from("notification_routing_settings").select("slack_webhook_url, fallback_to_push").eq("user_id", ownerId).maybeSingle(),
  ]);

  // Cooldown: a matching rule that already fired recently for this type stays quiet.
  const matchedBefore = rules.filter((r) => ruleMatches(r, { type: n.type, severity }, now));
  const cooling = new Set<string>();
  await Promise.all(
    matchedBefore
      .filter((r) => r.cooldown_minutes > 0)
      .map(async (r) => {
        const { data } = await admin
          .from("notification_deliveries")
          .select("created_at")
          .eq("rule_id", r.id)
          .eq("notification_type", n.type)
          .eq("status", "sent")
          .neq("notification_id", n.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (isCoolingDown(r.cooldown_minutes, data?.created_at ?? null, now)) cooling.add(r.id);
      }),
  );

  // Nothing matched at all -> keep today's behaviour (push to everyone) unless the owner turned that off.
  if (matchedBefore.length === 0) {
    if (settings?.fallback_to_push === false) return json({ routed: true, matched: 0, fallback: false });
    const res = await pushVia(functionsBase, secret, { notification_id: n.id });
    await admin.from("notification_deliveries").upsert(
      {
        user_id: ownerId, notification_id: n.id, rule_id: null, notification_type: n.type, severity,
        channel: "push", recipient_key: "fallback", recipient_label: "All devices (no rule matched)",
        status: res.ok ? "sent" : "failed", error: res.error ?? null,
      },
      { onConflict: "notification_id,channel,recipient_key", ignoreDuplicates: true },
    );
    return json({ routed: true, matched: 0, fallback: true, push_sent: res.sent });
  }

  const plan = planRouting(rules.filter((r) => !cooling.has(r.id)), { type: n.type, severity }, dir, now, {
    slackConfigured: Boolean(settings?.slack_webhook_url),
  });

  // Escalations first, so every message can carry the acknowledge link.
  let ackUrl: string | null = null;
  const escalationByRule = new Map<string, string>();
  for (const esc of plan.escalations) {
    const { count } = await admin.from("escalation_tiers").select("id", { count: "exact", head: true }).eq("schedule_id", esc.scheduleId);
    if (!count) continue; // no tiers configured -> nothing for escalation-tick to walk

    const { data: existing } = await admin
      .from("escalation_events")
      .select("id, ack_token")
      .eq("notification_id", n.id)
      .eq("schedule_id", esc.scheduleId)
      .maybeSingle();

    let event = existing;
    if (!event) {
      const { data: created, error: createErr } = await admin
        .from("escalation_events")
        .insert({
          user_id: ownerId,
          schedule_id: esc.scheduleId,
          notification_id: n.id,
          current_tier: 1,
          status: "active",
          last_notified_at: now.toISOString(),
          reason: `notification:${n.type}`,
        })
        .select("id, ack_token")
        .single();
      if (createErr) throw createErr;
      event = created;
    }
    escalationByRule.set(esc.ruleId, event.id);
    ackUrl ??= `${siteUrl}/ack/${event.ack_token}`;
  }

  const message = {
    title: n.title,
    message: n.message,
    severity,
    openUrl: `${siteUrl}${n.action_url || "/dashboard"}`,
    ackUrl,
  };

  const deliveries = plan.deliveries.slice(0, MAX_DELIVERIES_PER_RUN);
  if (plan.deliveries.length > deliveries.length) {
    console.error(JSON.stringify({ event: "notification_router_truncated", notification_id: n.id, planned: plan.deliveries.length }));
  }

  const slackUrl: string | null = settings?.slack_webhook_url ?? null;
  const memberAuthIds = new Map<string, string | null>();

  const finish = (id: string, status: "sent" | "failed" | "skipped", error: string | null = null) =>
    admin.from("notification_deliveries").update({ status, error }).eq("id", id);

  const deliverOne = async (d: PlannedDelivery): Promise<"sent" | "failed" | "skipped"> => {
    const base = {
      user_id: ownerId,
      notification_id: n.id,
      rule_id: d.ruleId,
      notification_type: n.type,
      severity,
      channel: d.channel as Channel,
      recipient_key: d.recipientKey,
      recipient_label: d.recipient?.label ?? (d.channel === "slack" ? "Slack channel" : null),
      escalation_event_id: escalationByRule.get(d.ruleId) ?? null,
    };

    // Claim the (notification, channel, recipient) slot; a retry gets nothing back and stops here.
    const { data: claimed, error: claimErr } = await admin
      .from("notification_deliveries")
      .upsert({ ...base, status: d.skipReason ? "skipped" : "pending", error: d.skipReason }, { onConflict: "notification_id,channel,recipient_key", ignoreDuplicates: true })
      .select("id");
    if (claimErr) {
      console.error(JSON.stringify({ event: "notification_router_claim_failed", notification_id: n.id, error: claimErr.message }));
      return "failed";
    }
    if (!claimed || claimed.length === 0) return "skipped"; // already handled
    if (d.skipReason) return "skipped";
    const rowId = claimed[0].id as string;

    try {
      if (d.channel === "sms" && d.recipient?.phone) {
        const r = await sendSms(d.recipient.phone, buildSms(message));
        await finish(rowId, r.ok ? "sent" : "failed", r.error?.slice(0, 300) ?? null);
        return r.ok ? "sent" : "failed";
      }

      if (d.channel === "email" && d.recipient?.email) {
        const mail = buildEmail(message);
        const r = await sendEmail(d.recipient.email, mail.subject, mail.html, mail.text);
        await finish(rowId, r.ok ? "sent" : "failed", r.error?.slice(0, 300) ?? null);
        return r.ok ? "sent" : "failed";
      }

      if (d.channel === "slack" && slackUrl) {
        const res = await fetch(slackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildSlackPayload(message)),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        await finish(rowId, res.ok ? "sent" : "failed", res.ok ? null : `Slack HTTP ${res.status}`);
        return res.ok ? "sent" : "failed";
      }

      if (d.channel === "push" && d.recipient) {
        let subscriberIds: string[] = [];
        if (d.recipient.key === "owner") {
          subscriberIds = [ownerId];
        } else {
          if (!memberAuthIds.has(d.recipient.key)) {
            const { data } = await admin.rpc("get_auth_user_id_by_email", { p_email: d.recipient.email ?? "" });
            memberAuthIds.set(d.recipient.key, (data as string | null) ?? null);
          }
          const id = memberAuthIds.get(d.recipient.key);
          if (id) subscriberIds = [id];
        }
        if (subscriberIds.length === 0) {
          await finish(rowId, "skipped", "no_push_device");
          return "skipped";
        }
        const r = await pushVia(functionsBase, secret, {
          notification_id: n.id,
          subscriber_user_ids: subscriberIds,
          include_unattributed: d.recipient.key === "owner",
        });
        if (r.ok && r.sent === 0) {
          await finish(rowId, "skipped", "no_push_device");
          return "skipped";
        }
        await finish(rowId, r.ok ? "sent" : "failed", r.error ?? null);
        return r.ok ? "sent" : "failed";
      }

      await finish(rowId, "skipped", "no_recipient");
      return "skipped";
    } catch (e) {
      await finish(rowId, "failed", (e instanceof Error ? e.message : String(e)).slice(0, 300));
      return "failed";
    }
  };

  const results = await Promise.all(deliveries.map(deliverOne));
  const count = (s: string) => results.filter((r) => r === s).length;

  console.log(JSON.stringify({
    event: "notification_routed",
    notification_id: n.id,
    matched: plan.matchedRuleIds.length,
    cooled_down: cooling.size,
    sent: count("sent"),
    failed: count("failed"),
    skipped: count("skipped"),
    escalations: escalationByRule.size,
  }));

  return json({
    routed: true,
    matched: plan.matchedRuleIds.length,
    cooled_down: cooling.size,
    sent: count("sent"),
    failed: count("failed"),
    skipped: count("skipped"),
    escalations: escalationByRule.size,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error(JSON.stringify({ event: "notification_router_misconfigured" }));
    return json({ error: "Server not configured" }, 500);
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  try {
    if (body.dry_run === true) return await handleDryRun(admin, req, body);

    const expected = Deno.env.get("PUSH_DISPATCH_SECRET");
    const provided = req.headers.get("x-push-dispatch-secret") ?? "";
    if (!expected) {
      console.error(JSON.stringify({ event: "notification_router_missing_secret" }));
      return json({ error: "Server not configured" }, 500);
    }
    if (!timingSafeEqual(provided, expected)) return json({ error: "Unauthorized" }, 401);

    const notificationId = typeof body.notification_id === "string" ? body.notification_id : "";
    if (!/^[0-9a-f-]{36}$/i.test(notificationId)) return json({ error: "Missing or invalid notification_id" }, 400);

    return await handleRoute(admin, notificationId, expected);
  } catch (e) {
    console.error(JSON.stringify({ event: "notification_router_error", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Internal server error" }, 500);
  }
});
