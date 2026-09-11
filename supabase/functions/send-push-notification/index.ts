// supabase/functions/send-push-notification/index.ts
//
// Delivers a real browser push notification (Web Push protocol) for a
// `notifications` row to every device the account has subscribed from.
//
// Called internally by the trigger_dispatch_push_notification Postgres
// trigger via pg_net. Not meant to be called directly by the client.
//
// Required secrets (set with `supabase secrets set`):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — already provided
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY     — from `npx web-push generate-vapid-keys`
//   VAPID_SUBJECT                             — e.g. "mailto:ali@vireek.com"
//   PUSH_DISPATCH_SECRET                      — same string as app.settings.push_dispatch_secret
//
// Deploy:
//   supabase functions deploy send-push-notification --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-push-dispatch-secret",
};

interface DispatchPayload {
  notification_id?: string;
}

interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const requestId = crypto.randomUUID();

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed", requestId }, 405);
  }

  const expectedSecret = Deno.env.get("PUSH_DISPATCH_SECRET");
  if (!expectedSecret) {
    console.error(JSON.stringify({ event: "config_error_missing_secret", requestId }));
    return jsonResponse({ success: false, error: "Server not configured", requestId }, 500);
  }
  const providedSecret = req.headers.get("x-push-dispatch-secret");
  if (providedSecret !== expectedSecret) {
    console.error(JSON.stringify({ event: "unauthorized_request", requestId }));
    return jsonResponse({ success: false, error: "Unauthorized", requestId }, 401);
  }

  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT");
  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    console.error(JSON.stringify({ event: "config_error_missing_vapid", requestId }));
    return jsonResponse({ success: false, error: "Server not configured", requestId }, 500);
  }
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  let payload: DispatchPayload;
  try {
    payload = (await req.json()) as DispatchPayload;
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON body", requestId }, 400);
  }
  if (!payload.notification_id) {
    return jsonResponse({ success: false, error: "Missing notification_id", requestId }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error(JSON.stringify({ event: "config_error_missing_supabase_env", requestId }));
    return jsonResponse({ success: false, error: "Server not configured", requestId }, 500);
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { data: notification, error: notifError } = await admin
      .from("notifications")
      .select("id, user_id, type, title, message, action_url")
      .eq("id", payload.notification_id)
      .maybeSingle();

    if (notifError) {
      console.error(JSON.stringify({ event: "notification_lookup_failed", requestId, error: notifError }));
      return jsonResponse({ success: false, error: "Failed to load notification", requestId }, 500);
    }
    if (!notification) {
      return jsonResponse({ success: false, error: "Notification not found", requestId }, 404);
    }

    const { data: subscriptions, error: subsError } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth_key")
      .eq("user_id", notification.user_id);

    if (subsError) {
      console.error(JSON.stringify({ event: "subscriptions_lookup_failed", requestId, error: subsError }));
      return jsonResponse({ success: false, error: "Failed to load subscriptions", requestId }, 500);
    }
    if (!subscriptions || subscriptions.length === 0) {
      console.log(JSON.stringify({ event: "no_subscriptions", requestId, user_id: notification.user_id }));
      return jsonResponse({ success: true, sent: 0, requestId });
    }

    const notificationPayload = JSON.stringify({
      title: notification.title,
      body: notification.message,
      url: notification.action_url || "/dashboard",
      tag: notification.type,
    });

    const results = await Promise.all(
      (subscriptions as PushSubscriptionRow[]).map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
            notificationPayload,
          );
          return { id: sub.id, ok: true };
        } catch (error) {
          const statusCode = (error as { statusCode?: number })?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            await admin.from("push_subscriptions").delete().eq("id", sub.id);
            return { id: sub.id, ok: false, pruned: true };
          }
          console.error(JSON.stringify({ event: "push_send_failed", requestId, subscription_id: sub.id, statusCode }));
          return { id: sub.id, ok: false };
        }
      }),
    );

    const sent = results.filter((r) => r.ok).length;
    const pruned = results.filter((r) => r.pruned).length;

    console.log(JSON.stringify({ event: "push_dispatch_complete", requestId, notification_id: notification.id, sent, pruned }));
    return jsonResponse({ success: true, sent, pruned, total: results.length, requestId });
  } catch (error) {
    console.error(JSON.stringify({ event: "push_function_error", requestId, error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ success: false, error: "Internal server error", requestId }, 500);
  }
});
