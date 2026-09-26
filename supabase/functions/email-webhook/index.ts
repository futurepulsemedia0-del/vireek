// Inbound email webhook for the Unified Communications Inbox's Email
// channel. Point your inbound-email provider (Resend Inbound, Postmark
// Inbound Webhook, or SendGrid Inbound Parse) at this function's URL.
//
// NOT LIVE-VERIFIED: the three providers above do NOT share one payload
// shape. This function expects the already-normalized shape below —
// { to, from, from_name?, subject?, text?, html? } — so add a ~5-line
// adapter at the top of the try block that reads your chosen provider's
// actual webhook body and maps it to this shape. Verify field names
// against that provider's current docs before going live.
//
// Routing: "to" must be the tenant's inbound alias,
// "<profiles.inbound_email_token>@<INBOUND_EMAIL_DOMAIN>" — that's how a
// reply gets matched back to the right business.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    // ---- provider adapter goes here; see file header ----
    const payload = await req.json();
    const to = String(payload.to ?? "").toLowerCase().trim();
    const from = String(payload.from ?? "").toLowerCase().trim();
    const fromName = payload.from_name ? String(payload.from_name) : null;
    const subject = payload.subject ? String(payload.subject) : null;
    const text = String(payload.text ?? "");
    const html = payload.html ? String(payload.html) : null;
    // ---- end provider adapter ----

    const token = to.split("@")[0];
    if (!token || !from) return json({ received: true });

    const { data: profile } = await admin
      .from("profiles")
      .select("id")
      .eq("inbound_email_token", token)
      .maybeSingle();

    if (!profile) {
      console.error(JSON.stringify({ event: "email_webhook_unknown_alias", to }));
      return json({ received: true });
    }

    const { data: conversation } = await admin
      .from("email_conversations")
      .upsert(
        { user_id: profile.id, customer_email: from, customer_name: fromName, subject, unread: true, last_message_at: new Date().toISOString() },
        { onConflict: "user_id,customer_email" },
      )
      .select("id")
      .single();

    if (!conversation) throw new Error("Failed to upsert email_conversations");

    await admin.from("email_messages").insert({
      conversation_id: conversation.id,
      direction: "inbound",
      subject,
      body_text: text || "(no text content)",
      body_html: html,
    });

    return json({ received: true });
  } catch (error) {
    console.error(JSON.stringify({ event: "email_webhook_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ received: true });
  }
});
