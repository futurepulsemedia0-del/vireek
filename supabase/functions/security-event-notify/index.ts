// security-event-notify — emails + notifies the user about an account-security change.
// Called by public.record_security_event() via pg_net (never by browsers).
//
// For each security_events row: claims it (idempotent), sends the branded email, writes the in-app
// notification (which the existing notifications trigger turns into a push), then stamps notified_at.
// Security alerts are NOT user-opt-out-able: they exist for the moment the user didn't make the change.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided), PUSH_DISPATCH_SECRET (same value as
//   app.settings.push_dispatch_secret), RESEND_API_KEY, RESEND_FROM_EMAIL (optional), SITE_URL (optional).
// Deploy: supabase functions deploy security-event-notify --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { scrubForLog, toEmail } from "../_shared/email-kit/notification.ts";
import { pickRecipient, planSecurityNotification, timingSafeEqual, isSecurityEvent, type SecurityEventRow } from "../_shared/email-kit/securityDispatch.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const requestId = crypto.randomUUID();
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed", requestId }, 405);

  const expected = Deno.env.get("PUSH_DISPATCH_SECRET");
  if (!expected) return json({ success: false, error: "Server not configured", requestId }, 500);
  if (!timingSafeEqual(req.headers.get("x-push-dispatch-secret") ?? "", expected)) {
    return json({ success: false, error: "Unauthorized", requestId }, 401);
  }

  let body: { event_id?: unknown; notify_email?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "Invalid JSON body", requestId }, 400);
  }
  const eventId = typeof body.event_id === "string" && /^[0-9a-f-]{36}$/i.test(body.event_id) ? body.event_id : null;
  if (!eventId) return json({ success: false, error: "Missing or invalid event_id", requestId }, 400);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ success: false, error: "Server not configured", requestId }, 500);
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    // Claim the row: only one invocation can win, so retries / double dispatch never send twice.
    const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
    const { data: claimed, error: claimError } = await admin
      .from("security_events")
      .update({ notify_claimed_at: new Date().toISOString() })
      .eq("id", eventId)
      .is("notified_at", null)
      .or(`notify_claimed_at.is.null,notify_claimed_at.lt.${staleBefore}`)
      .select("id, user_id, event, occurred_at, meta")
      .maybeSingle();
    if (claimError) return json({ success: false, error: "Failed to claim event", requestId }, 500);
    if (!claimed) return json({ success: true, sent: 0, skipped: "already_handled", requestId });
    const row = claimed as SecurityEventRow;
    if (!isSecurityEvent(row.event)) return json({ success: true, sent: 0, skipped: "unknown_event", requestId });

    const [{ data: userData }, { data: profile }] = await Promise.all([
      admin.auth.admin.getUserById(row.user_id),
      admin.from("profiles").select("preferred_language").eq("id", row.user_id).maybeSingle(),
    ]);
    const to = pickRecipient(row.event, userData?.user?.email, body.notify_email);
    const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
    const note = planSecurityNotification(row, (profile?.preferred_language as string | null | undefined) ?? null);
    if (!note) return json({ success: true, sent: 0, skipped: "no_template", requestId });

    // Email first: if it fails we release the claim and retry later, and nothing user-visible was duplicated.
    let emailOk = false;
    if (to) {
      const mail = toEmail(note, { siteUrl, locale: (profile?.preferred_language as string | null | undefined) ?? null });
      const res = await sendEmail(to, `${note.title} · Vireek`, mail.html, mail.text);
      emailOk = res.ok;
      if (!res.ok) {
        console.error(JSON.stringify({ event: "security_email_failed", requestId, event_id: eventId, error: scrubForLog(res.error ?? "") }));
        await admin.from("security_events").update({ notify_claimed_at: null }).eq("id", eventId);
        return json({ success: false, error: "Delivery failed", requestId }, 502);
      }
    }

    // In-app (+ push via the notifications trigger). Per-person row so a team member's alert never reaches the owner's bell.
    const { error: inAppError } = await admin.from("notifications").insert({
      user_id: row.user_id,
      recipient_id: row.user_id,
      type: "security_alert",
      title: note.title,
      message: note.body,
      action_url: note.action?.url ?? "/dashboard/settings/security",
    });
    if (inAppError) console.error(JSON.stringify({ event: "security_inapp_failed", requestId, event_id: eventId, error: scrubForLog(inAppError.message) }));

    await admin.from("security_events").update({ notified_at: new Date().toISOString() }).eq("id", eventId);
    return json({ success: true, sent: emailOk ? 1 : 0, inApp: !inAppError, requestId });
  } catch (e) {
    console.error(JSON.stringify({ event: "security_notify_error", requestId, error: scrubForLog(e instanceof Error ? e.message : String(e)) }));
    return json({ success: false, error: "Internal server error", requestId }, 500);
  }
});
