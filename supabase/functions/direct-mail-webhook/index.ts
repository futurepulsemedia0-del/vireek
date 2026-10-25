// supabase/functions/direct-mail-webhook/index.ts
//
// Public endpoint for print-provider (Lob) tracking events:
//   POST /functions/v1/direct-mail-webhook/<64-hex webhook token>
// Deploy:  supabase functions deploy direct-mail-webhook --no-verify-jwt
//
// Security
//  - The token in the path only selects the account; the request is ACCEPTED only when the HMAC signature
//    (signing secret pasted from the Lob dashboard) verifies. No stored secret => everything is rejected.
//  - Unknown / malformed tokens return the same 404.
//  - Duplicate or out-of-order deliveries are harmless (unique provider event id + forward-only status).
//  - Unknown pieces return 200 so the provider does not retry forever.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { decryptSecret } from "../_shared/direct-mail/crypto.ts";
import { mapProviderEvent, verifyLobSignature } from "../_shared/direct-mail/engine.ts";

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });

const MAX_BODY = 256 * 1024;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return text(405, "Method not allowed");

  const token = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) return text(404, "Not found");

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) return text(413, "Payload too large");

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  try {
    const { data: settings, error } = await admin
      .from("direct_mail_settings")
      .select("user_id, encrypted_webhook_secret")
      .eq("webhook_token", token)
      .maybeSingle();
    if (error) throw error;
    if (!settings) return text(404, "Not found");

    const secret = settings.encrypted_webhook_secret ? await decryptSecret(settings.encrypted_webhook_secret) : null;
    const valid = await verifyLobSignature({
      secret,
      timestamp: req.headers.get("lob-signature-timestamp"),
      signature: req.headers.get("lob-signature"),
      rawBody,
      nowMs: Date.now(),
    });
    if (!valid) return text(401, "Invalid signature");

    let event: { id?: string; body?: { id?: string }; event_type?: { id?: string }; date_created?: string };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return text(400, "Invalid JSON");
    }
    const providerId = event.body?.id;
    const eventType = event.event_type?.id;
    const eventId = event.id;
    if (!providerId || !eventType || !eventId) return text(200, "Ignored");

    const occurred = event.date_created && !Number.isNaN(Date.parse(event.date_created)) ? new Date(event.date_created).toISOString() : null;
    const { error: applyError } = await admin.rpc("direct_mail_apply_provider_event", {
      p_user_id: settings.user_id,
      p_provider_id: providerId,
      p_event_id: eventId,
      p_event_type: eventType,
      p_next_status: mapProviderEvent(eventType),
      p_occurred: occurred,
    });
    if (applyError) throw applyError;
    return text(200, "OK");
  } catch (e) {
    console.error(JSON.stringify({ event: "direct_mail_webhook_failed", message: e instanceof Error ? e.message : String(e) }));
    return text(500, "Server error"); // provider retries
  }
});
