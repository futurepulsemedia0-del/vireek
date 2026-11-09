import { getPartner } from "../_shared/financing-partners/registry.ts";
import { sha256Hex } from "../_shared/financing-partners/signature.ts";
import { adminClient, logEvent } from "../_shared/financing-partners/http.ts";

const MAX_BODY = 32_768;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const partnerKey = new URL(req.url).searchParams.get("partner") ?? "";
  const partner = getPartner(partnerKey);
  if (!partner) return new Response("Not found", { status: 404 });

  const raw = await req.text();
  if (raw.length > MAX_BODY) return new Response("Payload too large", { status: 413 });

  if (!(await partner.verifyWebhook(raw, req.headers))) {
    logEvent("fin_webhook_bad_signature", { partner: partner.key });
    return new Response("Invalid signature", { status: 401 });
  }

  const event = partner.parseWebhook(raw);
  if (!event) return new Response("Unrecognized payload", { status: 400 });

  try {
    const admin = adminClient();
    const { data, error } = await admin.rpc("fin_apply_partner_event", {
      p_partner_key: partner.key,
      p_event_id: event.eventId,
      p_kind: event.kind,
      p_partner_reference: event.partnerReference,
      p_status: event.status,
      p_payload_sha256: await sha256Hex(raw),
    });
    if (error) throw error;
    logEvent("fin_webhook_processed", { partner: partner.key, kind: event.kind, outcome: data?.outcome });
    return new Response(JSON.stringify({ outcome: data?.outcome ?? "unknown" }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    logEvent("fin_webhook_failed", { partner: partner.key, message: error instanceof Error ? error.message.slice(0, 160) : "error" });
    return new Response("error", { status: 500 });
  }
});
