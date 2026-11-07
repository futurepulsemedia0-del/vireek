// supabase/functions/auth-send-sms-hook/index.ts
//
// Supabase Auth "Send SMS" hook. Auth calls this for EVERY verification SMS instead of sending it itself,
// so SMS pumping cannot bypass the gate by calling /auth/v1/otp directly.
//
// Behaviour: blocked / disabled-country / ticket-less requests are DROPPED SILENTLY with a 200, so the
// response never reveals whether a number is registered, blocked or throttled. Rate limits live in otp-request
// (it sees the client IP); this hook only sends when it can consume the single-use ticket otp-request issued.
//
// Setup (Dashboard): Authentication > Hooks > Send SMS hook > HTTPS > this function URL; copy the generated
// secret into the SEND_SMS_HOOK_SECRET function secret. Also set FRAUD_HASH_PEPPER (any long random string).
// verify_jwt MUST be false for this function (Auth signs the request with the hook secret instead).
//
// NOT LIVE-VERIFIED against a real Supabase project: the payload shape ({ user: { phone }, sms: { otp } })
// and the Standard Webhooks headers follow Supabase's documented Send SMS hook contract.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { Webhook } from "npm:standardwebhooks@1.0.0";
import { sendSms } from "../_shared/notify/deliver.ts";
import type { FraudDb } from "../_shared/fraud/guard.ts";
import { processSmsHook } from "../_shared/fraud/otpFlow.ts";
import { hookError, hookSecretBase64 } from "../_shared/fraud/hooks.ts";

interface HookPayload {
  user?: { phone?: string };
  sms?: { otp?: string };
}

const OK = () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = Deno.env.get("SEND_SMS_HOOK_SECRET");
  const pepper = Deno.env.get("FRAUD_HASH_PEPPER");
  if (!secret || !pepper) return hookError(500, "Hook is not configured.");

  const raw = await req.text();
  let payload: HookPayload;
  try {
    payload = new Webhook(hookSecretBase64(secret)).verify(raw, Object.fromEntries(req.headers)) as HookPayload;
  } catch {
    return hookError(401, "Invalid signature.");
  }
  const phone = payload.user?.phone ?? "";
  const otp = payload.sms?.otp ?? "";
  if (!phone || !/^[0-9]{4,10}$/.test(otp)) return hookError(400, "Malformed hook payload.");

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const { data: s } = await admin.from("fraud_settings").select("kill_otp_sms, otp_allowed_countries").eq("id", true).maybeSingle();

  const outcome = await processSmsHook({
    db: admin as unknown as FraudDb, pepper, phone,
    settings: { kill: s?.kill_otp_sms === true, allowedCountries: s?.otp_allowed_countries ?? ["US", "CA"] },
    send: async (e164) => (await sendSms(e164, `Your Vireek verification code is ${otp}. It expires soon. Never share it.`)).ok,
  });

  if (outcome === "send_failed") return hookError(500, "Could not send the verification code. Please try another sign-in method.");
  if (outcome === "error") return hookError(503, "Verification by text is temporarily unavailable. Use email or a passkey instead.");
  return OK();
});
