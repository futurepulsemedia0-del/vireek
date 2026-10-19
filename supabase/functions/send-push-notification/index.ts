// supabase/functions/send-push-notification/index.ts
//
// Delivers a real push notification for a `notifications` row to every device the
// account has registered: browsers (Web Push protocol) and the native iOS / Android app
// (Firebase Cloud Messaging).
//
// Called internally by the trigger_dispatch_push_notification Postgres
// trigger via pg_net. Not meant to be called directly by the client.
//
// Required secrets (set with `supabase secrets set`):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — already provided
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY     — from `npx web-push generate-vapid-keys`
//   VAPID_SUBJECT                             — e.g. "mailto:ali@vireek.com"
//   PUSH_DISPATCH_SECRET                      — same string as app.settings.push_dispatch_secret
// Optional (native app push):
//   FCM_SERVICE_ACCOUNT_JSON                  — Firebase service-account JSON; without it the
//                                               native devices are skipped, web push is unaffected
//
// Deploy:
//   supabase functions deploy send-push-notification --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import webpush from "npm:web-push@3.6.7";
import { isFcmConfigured, sendFcm } from "../_shared/notify/fcm.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-push-dispatch-secret",
};

interface DispatchPayload {
  notification_id?: string;
  subscriber_user_ids?: string[];
  include_unattributed?: boolean;
}

interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
  subscriber_user_id: string | null;
}

interface DeviceTokenRow {
  id: string;
  token: string;
  subscriber_user_id: string | null;
}

interface Delivery {
  id: string;
  ok: boolean;
  pruned?: boolean;
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
      .select("id, user_id, type, title, message, action_url, recipient_id")
      .eq("id", payload.notification_id)
      .maybeSingle();

    if (notifError) {
      console.error(JSON.stringify({ event: "notification_lookup_failed", requestId, error: notifError }));
      return jsonResponse({ success: false, error: "Failed to load notification", requestId }, 500);
    }
    if (!notification) {
      return jsonResponse({ success: false, error: "Notification not found", requestId }, 404);
    }

    // Per-person notifications (comment @mentions / thread replies): honour the
    // recipient's own switch, then limit delivery to that person's devices.
    if (notification.recipient_id && String(notification.type).startsWith("comment_")) {
      const { data: pref } = await admin
        .from("profiles")
        .select("notify_comment_mention")
        .eq("id", notification.recipient_id)
        .maybeSingle();
      if (pref?.notify_comment_mention === false) {
        return jsonResponse({ success: true, sent: 0, skipped: "recipient_muted", requestId });
      }
    }

    const { data: allSubscriptions, error: subsError } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth_key, subscriber_user_id")
      .eq("user_id", notification.user_id);

    if (subsError) {
      console.error(JSON.stringify({ event: "subscriptions_lookup_failed", requestId, error: subsError }));
      return jsonResponse({ success: false, error: "Failed to load subscriptions", requestId }, 500);
    }

    // Targeting: a notification may be limited to specific people (e.g. @mentions).
    // Explicit ids from the dispatcher win; otherwise a notification addressed to one
    // person (recipient_id) goes only to that person's devices. Devices with no known
    // owner are never used for a person-addressed notification (privacy).
    // The same rule applies to browsers and to native devices.
    const subscriberIds: string[] | null = Array.isArray(payload.subscriber_user_ids)
      ? payload.subscriber_user_ids
      : notification.recipient_id
        ? [notification.recipient_id as string]
        : null;
    const isTargeted = (subscriberUserId: string | null): boolean =>
      !subscriberIds ||
      (subscriberUserId !== null && subscriberIds.includes(subscriberUserId)) ||
      (payload.include_unattributed === true && subscriberUserId === null);

    const webSubs = ((allSubscriptions ?? []) as PushSubscriptionRow[]).filter((s) => isTargeted(s.subscriber_user_id));

    // Native app devices (FCM). Skipped entirely while FCM_SERVICE_ACCOUNT_JSON is not set.
    let devices: DeviceTokenRow[] = [];
    if (isFcmConfigured()) {
      const { data: deviceRows, error: devicesError } = await admin
        .from("device_push_tokens")
        .select("id, token, subscriber_user_id")
        .eq("user_id", notification.user_id);
      if (devicesError) {
        console.error(JSON.stringify({ event: "device_tokens_lookup_failed", requestId, error: devicesError }));
      } else {
        devices = ((deviceRows ?? []) as DeviceTokenRow[]).filter((d) => isTargeted(d.subscriber_user_id));
      }
    }

    if (webSubs.length === 0 && devices.length === 0) {
      console.log(JSON.stringify({ event: "no_subscriptions", requestId, user_id: notification.user_id }));
      return jsonResponse({ success: true, sent: 0, requestId });
    }

    const url = notification.action_url || "/dashboard";
    // Person-addressed notifications keep their own tag so two mentions never replace each other.
    const tag = notification.recipient_id ? notification.id : notification.type;
    const notificationPayload = JSON.stringify({
      title: notification.title,
      body: notification.message,
      url,
      tag,
    });

    const webResults: Delivery[] = await Promise.all(
      webSubs.map(async (sub): Promise<Delivery> => {
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

    const deviceResults: Delivery[] = await Promise.all(
      devices.map(async (device): Promise<Delivery> => {
        try {
          const result = await sendFcm(device.token, {
            title: notification.title,
            body: notification.message,
            url,
            tag,
          });
          if (result.ok) return { id: device.id, ok: true };
          if (result.unregistered) {
            await admin.from("device_push_tokens").delete().eq("id", device.id);
            return { id: device.id, ok: false, pruned: true };
          }
          console.error(JSON.stringify({ event: "fcm_send_failed", requestId, device_id: device.id }));
          return { id: device.id, ok: false };
        } catch (error) {
          console.error(JSON.stringify({
            event: "fcm_send_error",
            requestId,
            device_id: device.id,
            error: error instanceof Error ? error.message : String(error),
          }));
          return { id: device.id, ok: false };
        }
      }),
    );

    const results = [...webResults, ...deviceResults];
    const sent = results.filter((r) => r.ok).length;
    const pruned = results.filter((r) => r.pruned).length;

    console.log(JSON.stringify({ event: "push_dispatch_complete", requestId, notification_id: notification.id, sent, pruned }));
    return jsonResponse({ success: true, sent, pruned, total: results.length, requestId });
  } catch (error) {
    console.error(JSON.stringify({ event: "push_function_error", requestId, error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ success: false, error: "Internal server error", requestId }, 500);
  }
});
