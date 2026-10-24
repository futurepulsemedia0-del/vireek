// supabase/functions/phone-payment-webhook/index.ts
//
// Twilio <Pay> callbacks (step=status for progress, step=action for the result).
// Authenticated TWICE: Twilio's X-Twilio-Signature AND our per-session HMAC token in the URL.
// The raw form body is never logged or stored — only parsePayCallback()'s allowlist is read.
//
// Deploy (Twilio cannot send a Supabase JWT):
//   supabase functions deploy phone-payment-webhook --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildPorts, functionsBaseUrl, safeLog } from "../_shared/pci/ports.ts";
import { handlePayAction, handlePayStatus } from "../_shared/pci/orchestrator.ts";
import { UUID_RE, verifySessionToken } from "../_shared/pci/session.ts";
import { buildResultTwiml, validateTwilioSignature } from "../_shared/pci/twilio.ts";

const xml = (body: string) => new Response(body, { status: 200, headers: { "Content-Type": "text/xml" } });
const empty = (status: number) => new Response(null, { status });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return empty(405);
  try {
    const u = new URL(req.url);
    const sid = u.searchParams.get("sid") ?? "";
    const step = u.searchParams.get("step") ?? "";
    const token = u.searchParams.get("t");
    if (!UUID_RE.test(sid) || (step !== "action" && step !== "status")) return empty(400);

    const secret = Deno.env.get("PCI_SESSION_HMAC_SECRET") ?? "";
    if (!(await verifySessionToken(secret, sid, token))) {
      safeLog("phone_payment_webhook_bad_token", { step });
      return empty(403);
    }

    const params: Record<string, string> = {};
    for (const [k, v] of (await req.formData()).entries()) if (typeof v === "string") params[k] = v;

    // Verify against the exact URL we gave Twilio (not the request's Host header).
    const signedUrl = `${functionsBaseUrl()}?sid=${sid}&step=${step}&t=${token}`;
    const ok = await validateTwilioSignature(Deno.env.get("TWILIO_AUTH_TOKEN") ?? "", signedUrl, params, req.headers.get("x-twilio-signature"));
    if (!ok) {
      safeLog("phone_payment_webhook_bad_signature", { step });
      return empty(403);
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const ports = await buildPorts(admin);

    if (step === "status") {
      await handlePayStatus(ports, sid, params);
      return empty(204);
    }
    const { twiml } = await handlePayAction(ports, sid, params);
    return xml(twiml);
  } catch (e) {
    safeLog("phone_payment_webhook_failed", { error: e instanceof Error ? e.message : String(e) });
    // Never leave the caller in silence: say something honest and hang up.
    return xml(buildResultTwiml("failed"));
  }
});
