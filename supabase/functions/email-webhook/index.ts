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
import { runAutoReplyInBackground } from "../_shared/autoReply/runtime.ts";
import { handleMarketplaceEmail } from "../_shared/lead-marketplace/emailEntry.ts";
import { createDeps } from "../_shared/lead-marketplace/runtime.ts";
import { recordLanguageFromMessage } from "../_shared/i18n/customerLanguage.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const expectedSecret = Deno.env.get("EMAIL_WEBHOOK_SECRET");
  if (expectedSecret && new URL(req.url).searchParams.get("secret") !== expectedSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

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

    const localPart = to.split("@")[0] ?? "";
    const token = localPart.split("+")[0];
    if (!token || !from) return json({ received: true });

    const { data: profile } = await admin
      .from("profiles")
      .select("id")
      .eq("inbound_email_token", token)
      .maybeSingle();

    if (!profile) {
    const { data: es } = await admin.from("email_settings").select("inbound_enabled").eq("user_id", profile.id).maybeSingle();
    if (es && es.inbound_enabled === false) {
      console.error(JSON.stringify({ event: "email_webhook_inbound_disabled", to }));
      return json({ received: true });
    }
      console.error(JSON.stringify({ event: "email_webhook_unknown_alias", to }));
      return json({ received: true });
    }

    const marketplace = await handleMarketplaceEmail(createDeps(admin), {
      userId: profile.id,
      toLocalPart: localPart,
      from,
      subject,
      text: text || null,
      html,
      receivedAtMs: Date.now(),
    });
    if (marketplace.handled) return json({ received: true });
    const { data: conversation } = await admin
      .from("email_conversations")
      .upsert(
        { user_id: profile.id, customer_email: from, customer_name: fromName, subject, unread: true, last_message_at: new Date().toISOString() },
        { onConflict: "user_id,customer_email" },
      )
      .select("id")
      .single();

    if (!conversation) throw new Error("Failed to upsert email_conversations");

    const { data: inboundMsg } = await admin.from("email_messages").insert({
      conversation_id: conversation.id,
      direction: "inbound",
      subject,
      body_text: text || "(no text content)",
      body_html: html,
    }).select("id").single();

    await recordLanguageFromMessage(admin, profile.id, { email: from }, text);
    const ownDomain = Deno.env.get("INBOUND_EMAIL_DOMAIN");
    if (inboundMsg && !(ownDomain && from.endsWith(`@${ownDomain.toLowerCase()}`))) {
      await runAutoReplyInBackground(admin, {
        userId: profile.id, channel: "email", conversationId: conversation.id,
        inboundMessageId: inboundMsg.id, text, subject, senderAddress: from,
        headers: payload.headers && typeof payload.headers === "object" ? payload.headers : null,
        customerLabel: fromName || from,
      });
    }

    return json({ received: true });
  } catch (error) {
    console.error(JSON.stringify({ event: "email_webhook_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ received: true });
  }
});
