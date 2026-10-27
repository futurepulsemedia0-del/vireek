// supabase/functions/arrival-window-notify/index.ts
//
// Arrival-window customer notifications — cron worker.
//
//   Drains the arrival_window_notifications outbox (filled by the jobs trigger / booking RPC / dispatcher RPC)
//   through sendCompliantSms() (A2P + STOP/DNC + quiet-hours gates). Falls back to email when SMS cannot be used
//   (no phone, opted out, A2P not approved) so the customer still hears about the change.
//
// DEPLOY:   supabase functions deploy arrival-window-notify --no-verify-jwt
// SCHEDULE: every minute with header  X-Cron-Secret: <CRON_SECRET>   (same external cron as service-guarantee-tick)
// SECRETS:  CRON_SECRET (required), SITE_URL (optional, default https://vireek.com)
//
// Fails CLOSED: without CRON_SECRET the function refuses to run, because it texts customers.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { resolveContactRecipients } from "../_shared/customers/contactRecipients.ts";
import { sendGatedEmail } from "../_shared/messaging/gatedSend.ts";
import { normalizeSettings } from "../_shared/messaging/quietHoursCore.ts";
import { buildEmail, buildSmsText, type WindowMessageInput, type WindowNotifyKind } from "../_shared/arrival-window/message.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface OutboxRow {
  id: string;
  user_id: string;
  job_id: string;
  kind: WindowNotifyKind;
  window_start: string;
  window_end: string;
  previous_start: string | null;
  previous_end: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  service_type: string | null;
  token: string | null;
  technician_name: string | null;
  business_name: string | null;
  timezone: string | null;
}

type Outcome = "sent" | "skipped" | "failed" | "retry";
/** SMS failures that will never succeed on retry: fall back to email instead. */
const SMS_NOT_RETRYABLE = new Set(["OPTED_OUT", "A2P_NOT_APPROVED", "NOT_CONFIGURED"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret) return json({ error: "CRON_SECRET is not configured" }, 500);
  if (!safeEqual(req.headers.get("X-Cron-Secret") ?? "", cronSecret)) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

  const claimed = await admin.rpc("claim_arrival_window_notifications", { p_limit: 25 });
  if (claimed.error) return json({ error: `claim failed: ${claimed.error.message}` }, 500);

  const rows = (claimed.data ?? []) as OutboxRow[];
  const counts: Record<Outcome, number> = { sent: 0, skipped: 0, failed: 0, retry: 0 };

  for (const r of rows) {
    const finish = async (status: Outcome, error?: string) => {
      counts[status]++;
      await admin.rpc("complete_arrival_window_notification", { p_id: r.id, p_status: status, p_error: error ?? null });
    };

    try {
      const input: WindowMessageInput = {
        kind: r.kind,
        businessName: r.business_name,
        technicianName: r.technician_name,
        serviceType: r.service_type,
        windowStart: r.window_start,
        windowEnd: r.window_end,
        previousStart: r.previous_start,
        previousEnd: r.previous_end,
        timeZone: normalizeSettings(null, r.timezone).timezone,
        link: r.token ? `${siteUrl}/reschedule/${r.token}` : null,
      };

      // Site / tenant contacts get the same notice. Best effort: the row outcome below still reflects the customer.
      const customerDigits = (r.customer_phone ?? "").replace(/\D/g, "").slice(-10);
      for (const c of await resolveContactRecipients(admin, r.user_id, r.customer_id, "service")) {
        if (c.isFallback) continue;
        if (c.phone && c.phone.replace(/\D/g, "").slice(-10) !== customerDigits) {
          await sendCompliantSms(admin, r.user_id, c.phone, buildSmsText(input), {
            purpose: "service",
            customerId: r.customer_id,
            source: "arrival-window",
            dedupeKey: `arrival-window:${r.id}:${c.contactId}`,
          }).catch(() => undefined);
        } else if (!c.phone && c.email && c.email.toLowerCase() !== (r.customer_email ?? "").toLowerCase()) {
          const m = buildEmail(input);
          await sendGatedEmail(admin, r.user_id, c.email, m.subject, m.html, m.text, {
            purpose: "service",
            customerId: r.customer_id,
            source: "arrival-window",
            dedupeKey: `arrival-window-email:${r.id}:${c.contactId}`,
          }).catch(() => undefined);
        }
      }
      
      let smsNote = "";
      if (r.customer_phone) {
        const sms = await sendCompliantSms(admin, r.user_id, r.customer_phone, buildSmsText(input), {
          purpose: "service",
          customerId: r.customer_id,
          source: "arrival-window",
          dedupeKey: `arrival-window:${r.id}`,
        });
        if (sms.ok) {
          await finish("sent");
          continue;
        }
        if (!SMS_NOT_RETRYABLE.has(sms.reason)) {
          await finish("retry", sms.detail ?? sms.reason);
          continue;
        }
        smsNote = `SMS ${sms.reason}`;
      }

      if (r.customer_email) {
        const mail = buildEmail(input);
        const res = await sendGatedEmail(admin, r.user_id, r.customer_email, mail.subject, mail.html, mail.text, {
          purpose: "service",
          customerId: r.customer_id,
          source: "arrival-window",
          dedupeKey: `arrival-window-email:${r.id}`,
        });
        if (res.ok) await finish("sent");
        else if (/isn't configured/i.test(res.error ?? "")) await finish("skipped", [smsNote, res.error].filter(Boolean).join("; "));
        else await finish("retry", res.error);
        continue;
      }

      await finish("skipped", smsNote || "No phone number or email on file");
    } catch (e) {
      await finish("retry", e instanceof Error ? e.message : "Unexpected error");
    }
  }

  return json({ ok: true, claimed: rows.length, ...counts });
});
