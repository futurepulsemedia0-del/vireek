// supabase/functions/notify-status-subscribers/index.ts
//
// Emails everyone in `status_subscribers` about an incident on
// /status. This is what makes "Subscribe to Updates" a real feature
// instead of a form that quietly goes nowhere — see the migration
// 20260913080000_status_subscribers.sql for why the table exists.
//
// This is intentionally a manually-invoked tool, not an automated
// trigger — StatusPage.tsx documents /status itself as a
// hand-maintained page (no automated monitor wired up), so call this
// as the last step when you post an incident there:
//   1-4. (existing steps in StatusPage.tsx: update SYSTEMS/INCIDENTS)
//   5. Call this function with the same incident details so subscribers
//      actually hear about it.
//
// Required secrets (Resend is already used by send-team-invite, so
// these may already be set):
//   supabase secrets set RESEND_API_KEY=re_xxxxxxxxxxxx
//   supabase secrets set RESEND_FROM_EMAIL="Vireek Status <status@yourdomain.com>"
//   supabase secrets set SITE_URL=https://vireek.com
//
// Optional secret (recommended — without it, anyone who finds this
// endpoint could email your whole subscriber list):
//   supabase secrets set STATUS_NOTIFY_WEBHOOK_SECRET=some-long-random-string
// If set, callers must send it back as: X-Webhook-Secret: some-long-random-string
//
// Deploy:
//   supabase functions deploy notify-status-subscribers

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Webhook-Secret",
};

interface NotifyPayload {
  title?: string;
  impact?: "minor" | "major";
  status?: "investigating" | "monitoring" | "resolved";
  summary?: string;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  const expectedSecret = Deno.env.get("STATUS_NOTIFY_WEBHOOK_SECRET");
  if (expectedSecret) {
    const providedSecret = req.headers.get("X-Webhook-Secret");
    if (providedSecret !== expectedSecret) {
      return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }
  }

  let payload: NotifyPayload;
  try {
    payload = (await req.json()) as NotifyPayload;
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
  }

  const title = (payload.title ?? "").trim();
  const summary = (payload.summary ?? "").trim();
  if (!title || !summary) {
    return jsonResponse({ success: false, error: "title and summary are required" }, 400);
  }
  const impact = payload.impact === "major" ? "major" : "minor";
  const status = payload.status ?? "investigating";

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!resendApiKey) {
    return jsonResponse({ success: false, error: "Email is not configured yet (missing RESEND_API_KEY)." }, 500);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ success: false, error: "Server configuration error" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: subscribers, error: fetchError } = await admin
    .from("status_subscribers")
    .select("email, unsubscribe_token");

  if (fetchError) {
    console.error("Failed to load status_subscribers:", fetchError);
    return jsonResponse({ success: false, error: "Failed to load subscribers" }, 500);
  }

  if (!subscribers || subscribers.length === 0) {
    return jsonResponse({ success: true, sent: 0, failed: 0, total: 0, message: "No subscribers yet." });
  }

  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "Vireek Status <status@resend.dev>";
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const impactLabel = impact === "major" ? "Major impact" : "Minor impact";

  let sent = 0;
  let failed = 0;

  // Sequential, not batched — fine for a status-page subscriber list.
  // If this list grows into the thousands, switch to Resend's batch
  // send endpoint instead of looping one request per subscriber.
  for (const subscriber of subscribers) {
    const unsubscribeUrl = `${siteUrl}/status/unsubscribe?token=${subscriber.unsubscribe_token}`;
    const html = `
      <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
        <p style="font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin: 0 0 16px;">Vireek Status &middot; ${escapeHtml(impactLabel)}</p>
        <h1 style="font-size: 22px; margin: 0 0 16px;">${escapeHtml(title)}</h1>
        <p style="font-size: 15px; line-height: 1.6; color: #374151;">${escapeHtml(summary)}</p>
        <a href="${siteUrl}/status"
           style="display: inline-block; margin-top: 24px; padding: 12px 24px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px;">
          View live status
        </a>
        <p style="margin-top: 28px; font-size: 12px; color: #9ca3af;">
          Status: ${escapeHtml(status)}. You're getting this because you subscribed to Vireek status updates.
          <a href="${unsubscribeUrl}" style="color: #9ca3af;">Unsubscribe</a>
        </p>
      </div>
    `;
    const text = `${title}\n\n${summary}\n\nView live status: ${siteUrl}/status\n\nStatus: ${status}. Unsubscribe: ${unsubscribeUrl}`;

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [subscriber.email],
          subject: `[Vireek Status] ${title}`,
          html,
          text,
        }),
      });
      if (res.ok) {
        sent += 1;
      } else {
        failed += 1;
        console.error("Resend error for", subscriber.email, await res.text());
      }
    } catch (err) {
      failed += 1;
      console.error("Send failed for", subscriber.email, err);
    }
  }

  return jsonResponse({ success: true, sent, failed, total: subscribers.length });
});
