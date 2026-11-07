// supabase/functions/otp-request/index.ts
//
// Public entry point for phone verification codes (homeowner sign-in). It is the ONLY place per-IP limits can
// be enforced, because Supabase's Send-SMS hook never sees the client IP. Flow:
//   browser -> otp-request (CAPTCHA token, per-IP / per-phone / per-prefix / global limits, country policy)
//           -> issues a single-use TICKET for the phone -> calls Supabase Auth /auth/v1/otp
//           -> auth-send-sms-hook only SENDS when it can consume that ticket.
// Anyone calling /auth/v1/otp directly has no ticket, so nothing is sent and nothing is billed.
//
// The response is ALWAYS { ok: true } for well-formed requests (blocked, throttled, unknown country, existing or
// new number): no signal about accounts, limits or enabled countries leaks. Malformed requests get 400.
//
// verify_jwt = false (public). Secrets: FRAUD_HASH_PEPPER. CAPTCHA is verified by Supabase Auth itself.
// NOT LIVE-VERIFIED against Supabase Auth's /otp endpoint (body shape follows the GoTrue API).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import type { FraudDb } from "../_shared/fraud/guard.ts";
import { processOtpRequest } from "../_shared/fraud/otpFlow.ts";
import { clientIp } from "../_shared/fraud/hooks.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey" };
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);

  const pepper = Deno.env.get("FRAUD_HASH_PEPPER");
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!pepper || !url || !anon) return respond({ error: "Not configured" }, 500);

  const body = (await req.json().catch(() => null)) as { phone?: unknown; captchaToken?: unknown } | null;
  if (!body || typeof body.phone !== "string" || body.phone.length > 32) return respond({ error: "Bad request" }, 400);
  const captchaToken = typeof body.captchaToken === "string" && body.captchaToken.length <= 4096 ? body.captchaToken : undefined;

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const { data: s } = await admin.from("fraud_settings").select("kill_otp_sms, otp_allowed_countries").eq("id", true).maybeSingle();

  await processOtpRequest({
    db: admin as unknown as FraudDb, pepper, ip: clientIp(req.headers), phone: body.phone,
    settings: { kill: s?.kill_otp_sms === true, allowedCountries: s?.otp_allowed_countries ?? ["US", "CA"] },
    callAuth: async (e164) => {
      const res = await fetch(`${url}/auth/v1/otp`, {
        method: "POST", headers: { "Content-Type": "application/json", apikey: anon },
        body: JSON.stringify({ phone: e164, create_user: true, ...(captchaToken ? { gotrue_meta_security: { captcha_token: captchaToken } } : {}) }),
      });
      return { ok: res.ok, status: res.status };
    },
  });
  return respond({ ok: true }); // uniform: never reveals whether anything was sent
});
