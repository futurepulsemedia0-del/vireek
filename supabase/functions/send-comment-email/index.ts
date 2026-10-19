// supabase/functions/send-comment-email/index.ts
//
// Emails the person a comment notification (@mention or thread reply) is for.
// Called by the trigger_dispatch_comment_email Postgres trigger via pg_net,
// exactly like send-push-notification. Not meant to be called by the client.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided),
//   PUSH_DISPATCH_SECRET (same value as app.settings.push_dispatch_secret),
//   RESEND_API_KEY, RESEND_FROM_EMAIL (optional), SITE_URL (optional,
//   defaults to https://app.vireek.com).
//
// Deploy:
//   supabase functions deploy send-comment-email --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-push-dispatch-secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

Deno.serve(async (req: Request) => {
  const requestId = crypto.randomUUID();
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed", requestId }, 405);

  const expected = Deno.env.get("PUSH_DISPATCH_SECRET");
  if (!expected) return json({ success: false, error: "Server not configured", requestId }, 500);
  if (req.headers.get("x-push-dispatch-secret") !== expected) {
    return json({ success: false, error: "Unauthorized", requestId }, 401);
  }

  let notificationId: string | undefined;
  try {
    notificationId = ((await req.json()) as { notification_id?: string }).notification_id;
  } catch {
    return json({ success: false, error: "Invalid JSON body", requestId }, 400);
  }
  if (!notificationId) return json({ success: false, error: "Missing notification_id", requestId }, 400);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ success: false, error: "Server not configured", requestId }, 500);
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const { data: n, error } = await admin
      .from("notifications")
      .select("id, type, title, message, action_url, recipient_id")
      .eq("id", notificationId)
      .maybeSingle();
    if (error) return json({ success: false, error: "Failed to load notification", requestId }, 500);
    if (!n || !n.recipient_id || !["comment_mention", "comment_reply"].includes(n.type)) {
      return json({ success: true, sent: 0, skipped: "not_applicable", requestId });
    }

    const { data: prefs } = await admin
      .from("profiles")
      .select("notify_comment_mention, notify_comment_email")
      .eq("id", n.recipient_id)
      .maybeSingle();
    if (prefs && (prefs.notify_comment_mention === false || prefs.notify_comment_email === false)) {
      return json({ success: true, sent: 0, skipped: "opted_out", requestId });
    }

    const { data: userData, error: userError } = await admin.auth.admin.getUserById(n.recipient_id);
    const to = userData?.user?.email;
    if (userError || !to) return json({ success: true, sent: 0, skipped: "no_email", requestId });

    const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
    const path = typeof n.action_url === "string" && n.action_url.startsWith("/") ? n.action_url : "/dashboard";
    const link = `${siteUrl}${path}`;

    const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:16px;padding:28px">
<tr><td>
<p style="margin:0 0 6px;font-size:13px;color:#6b7280">Vireek · Comments</p>
<h1 style="margin:0 0 16px;font-size:18px;line-height:1.35">${esc(n.title)}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#374151;white-space:pre-wrap">${esc(n.message)}</p>
<a href="${esc(link)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:12px">Open the conversation</a>
<p style="margin:24px 0 0;font-size:12px;color:#9ca3af">You get this because you were mentioned or are part of the thread. Turn it off in Vireek under Settings → Notifications.</p>
</td></tr></table></td></tr></table></body></html>`;
    const text = `${n.title}\n\n${n.message}\n\nOpen the conversation: ${link}\n\nTurn these emails off in Vireek under Settings → Notifications.`;

    const result = await sendEmail(to, n.title, html, text);
    if (!result.ok) {
      console.error(JSON.stringify({ event: "comment_email_failed", requestId, notification_id: n.id, error: result.error }));
      return json({ success: false, error: "Email provider error", requestId }, 502);
    }
    return json({ success: true, sent: 1, requestId });
  } catch (e) {
    console.error(JSON.stringify({ event: "comment_email_error", requestId, error: e instanceof Error ? e.message : String(e) }));
    return json({ success: false, error: "Internal server error", requestId }, 500);
  }
});
