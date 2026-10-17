// supabase/functions/send-chat-push/index.ts
//
// Web Push for ONE chat message, to the specific people who should hear about it
// (never the whole account — push_subscriptions.user_id is account-wide, so we target
// push_subscriptions.subscriber_id instead).
//
// Called by trigger_chat_messages_after_insert via pg_net. Not for browsers.
// Same secrets / settings as send-push-notification:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
//   VAPID_SUBJECT, PUSH_DISPATCH_SECRET
// Deploy:  supabase functions deploy send-chat-push --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-push-dispatch-secret",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  const requestId = crypto.randomUUID();
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed", requestId }, 405);

  const expected = Deno.env.get("PUSH_DISPATCH_SECRET");
  if (!expected) return json({ success: false, error: "Server not configured", requestId }, 500);
  if (!timingSafeEqual(req.headers.get("x-push-dispatch-secret") ?? "", expected)) {
    return json({ success: false, error: "Unauthorized", requestId }, 401);
  }

  const pub = Deno.env.get("VAPID_PUBLIC_KEY");
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT");
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!pub || !priv || !subject || !url || !key) return json({ success: false, error: "Server not configured", requestId }, 500);
  webpush.setVapidDetails(subject, pub, priv);

  let messageId: string | undefined;
  try {
    messageId = ((await req.json()) as { message_id?: string }).message_id;
  } catch {
    return json({ success: false, error: "Invalid JSON body", requestId }, 400);
  }
  if (!messageId) return json({ success: false, error: "Missing message_id", requestId }, 400);

  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const { data: msg } = await admin
      .from("chat_messages")
      .select("id, channel_id, sender_id, kind, body, deleted_at")
      .eq("id", messageId)
      .maybeSingle();
    if (!msg || msg.deleted_at) return json({ success: true, sent: 0, requestId });

    const { data: recipients, error: rErr } = await admin.rpc("chat_push_recipients", { p_message_id: messageId });
    if (rErr) {
      console.error(JSON.stringify({ event: "recipients_failed", requestId, code: rErr.code }));
      return json({ success: false, error: "Failed to resolve recipients", requestId }, 500);
    }
    const userIds = [...new Set(((recipients ?? []) as { user_id: string }[]).map((r) => r.user_id))];
    if (userIds.length === 0) return json({ success: true, sent: 0, requestId });

    const channel = (recipients as { channel_kind: string; job_id: string | null }[])[0];

    // Sender display name (team member name, else owner profile).
    let sender = "Someone";
    const { data: tm } = await admin.from("team_members").select("member_name, member_email").eq("user_id", msg.sender_id).maybeSingle();
    if (tm) sender = tm.member_name || String(tm.member_email).split("@")[0];
    else {
      const { data: p } = await admin.from("profiles").select("full_name, company_name, email").eq("id", msg.sender_id).maybeSingle();
      if (p) sender = p.full_name || p.company_name || String(p.email).split("@")[0];
    }

    let title = sender;
    if (channel.channel_kind === "job" && channel.job_id) {
      const { data: job } = await admin.from("jobs").select("customer_name").eq("id", channel.job_id).maybeSingle();
      if (job?.customer_name) title = `${job.customer_name} · ${sender}`;
    }
    const body = msg.kind === "image" ? "Sent a photo" : msg.kind === "voice" ? "Sent a voice note" : clip(String(msg.body ?? ""), 140);

    const payload = JSON.stringify({
      title: clip(title, 80),
      body,
      url: `/dashboard/team-chat?c=${msg.channel_id}`,
      tag: `chat-${msg.channel_id}`,
      chatChannelId: msg.channel_id,
    });

    const { data: subs, error: sErr } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth_key")
      .in("subscriber_id", userIds);
    if (sErr) return json({ success: false, error: "Failed to load subscriptions", requestId }, 500);

    const results = await Promise.all(
      (subs ?? []).map(async (s: { id: string; endpoint: string; p256dh: string; auth_key: string }) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload, { TTL: 3600, urgency: "high" });
          return { ok: true, pruned: false };
        } catch (e) {
          const code = (e as { statusCode?: number })?.statusCode;
          if (code === 404 || code === 410) {
            await admin.from("push_subscriptions").delete().eq("id", s.id);
            return { ok: false, pruned: true };
          }
          console.error(JSON.stringify({ event: "push_send_failed", requestId, code }));
          return { ok: false, pruned: false };
        }
      }),
    );

    return json({
      success: true,
      recipients: userIds.length,
      sent: results.filter((r) => r.ok).length,
      pruned: results.filter((r) => r.pruned).length,
      requestId,
    });
  } catch (e) {
    console.error(JSON.stringify({ event: "send_chat_push_error", requestId, error: e instanceof Error ? e.message : String(e) }));
    return json({ success: false, error: "Internal server error", requestId }, 500);
  }
});
