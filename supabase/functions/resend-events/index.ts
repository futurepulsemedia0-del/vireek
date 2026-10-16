// supabase/functions/resend-events/index.ts
//
// Resend webhook receiver (Svix-signed). Records delivery, and suppresses the
// address on a hard bounce or spam complaint so it is never mailed again.
// Point Resend at:  https://<project-ref>.supabase.co/functions/v1/resend-events
// Events: email.delivered, email.bounced, email.complained
// Requires secret RESEND_WEBHOOK_SECRET (whsec_...). Unsigned requests are rejected.
//
// Deploy:  supabase functions deploy resend-events --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { verifySvix } from "../_shared/email-campaigns/svix.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET");
  if (!secret) return json({ error: "RESEND_WEBHOOK_SECRET is not set" }, 500);

  const raw = await req.text();
  const ok = await verifySvix(
    secret,
    {
      id: req.headers.get("svix-id"),
      timestamp: req.headers.get("svix-timestamp"),
      signature: req.headers.get("svix-signature"),
    },
    raw,
  );
  if (!ok) return json({ error: "Invalid signature" }, 401);

  let event: { type?: string; data?: { email_id?: string; bounce?: { type?: string } } };
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const emailId = event.data?.email_id;
  if (!emailId || !event.type) return json({ received: true });

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  try {
    const { data: r } = await admin
      .from("email_campaign_recipients")
      .select("id, user_id, campaign_id, email")
      .eq("provider_ref", emailId)
      .maybeSingle();
    if (!r) return json({ received: true }); // not one of ours (e.g. transactional mail)

    const now = new Date().toISOString();
    if (event.type === "email.delivered") {
      await admin.from("email_campaign_recipients").update({ delivered_at: now }).eq("id", r.id);
    } else if (event.type === "email.bounced") {
      // Transient/soft bounces must not permanently suppress a good address.
      const kind = String(event.data?.bounce?.type ?? "").toLowerCase();
      await admin.from("email_campaign_recipients").update({ bounced_at: now }).eq("id", r.id);
      if (kind !== "transient" && kind !== "soft") {
        await admin.rpc("email_suppress", { p_user: r.user_id, p_email: r.email, p_reason: "bounce", p_campaign: r.campaign_id });
      }
    } else if (event.type === "email.complained") {
      await admin.from("email_campaign_recipients").update({ bounced_at: now }).eq("id", r.id);
      await admin.rpc("email_suppress", { p_user: r.user_id, p_email: r.email, p_reason: "complaint", p_campaign: r.campaign_id });
    } else {
      return json({ received: true });
    }
    await admin.rpc("email_refresh_campaign_counts", { p_campaign: r.campaign_id });
    return json({ received: true });
  } catch (e) {
    console.error("resend-events error", e);
    return json({ error: "Processing failed" }, 500); // Resend retries on non-2xx
  }
});
