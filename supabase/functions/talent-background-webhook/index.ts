// supabase/functions/talent-background-webhook/index.ts
//
// Receives screening-provider webhooks (Checkr). Deployed with verify_jwt = false (see supabase/config.toml);
// authenticity is proven by the HMAC signature over the RAW body, and events are applied idempotently.
// Only STATUS/RESULT are stored. Report contents never enter Vireek.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { mapCheckrEvent, verifyWebhookSignature } from "../_shared/talent-network/engine.ts";

const MAX_BODY = 256 * 1024;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("CHECKR_API_KEY");
  const url = Deno.env.get("SUPABASE_URL");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret || !url || !service) return json({ error: "Not configured" }, 503);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "Payload too large" }, 413);

  const ok = await verifyWebhookSignature(raw, req.headers.get("X-Checkr-Signature"), secret);
  if (!ok) return json({ error: "Invalid signature" }, 401);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const ev = mapCheckrEvent(payload);
  if (!ev) return json({ ok: true, ignored: true }); // acknowledge events we don't use so the provider stops retrying

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc("talent_background_apply_event", {
    p_event_id: ev.eventId,
    p_candidate_id: ev.candidateId,
    p_invitation_id: ev.invitationId,
    p_report_id: ev.reportId,
    p_status: ev.status,
    p_result: ev.result,
  });
  if (error) {
    console.error("talent_background_apply_event failed", error.code);
    return json({ error: "Could not apply event" }, 500); // non-2xx so the provider retries
  }
  return json({ ok: true, ...(data as Record<string, unknown>) });
});
