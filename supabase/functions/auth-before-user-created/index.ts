// supabase/functions/auth-before-user-created/index.ts
//
// Supabase Auth "Before User Created" hook: risk-scores every signup server-side, so signup farming cannot
// bypass the browser. Blocked signups get ONE generic error (no signal about which rule fired).
//
// Setup (Dashboard): Authentication > Hooks > Before User Created > HTTPS > this function URL; copy the
// secret into BEFORE_USER_CREATED_HOOK_SECRET; set FRAUD_HASH_PEPPER. verify_jwt = false for this function.
// Also enable Authentication > Attack Protection > CAPTCHA (Cloudflare Turnstile) so Auth itself verifies the
// token the browser sends (captchaToken) — that is the bot challenge; this hook is the risk score.
//
// Decision: FAIL OPEN on infrastructure errors. Rationale: a brand-new account cannot place outbound calls or
// texts (outbound_unlocked = false) and is bounded by maxLossPerSignupCents(), so an outage here must not stop
// legitimate signups. The failure is logged as a fraud_event for review.
//
// NOT LIVE-VERIFIED against a real Supabase project (payload shape follows Supabase's documented contract:
// { metadata: { ip_address }, user: { email, user_metadata } }).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { Webhook } from "npm:standardwebhooks@1.0.0";
import { canonicalizeEmail, scoreSignup, splitEmail } from "../_shared/fraud/signupRisk.ts";
import { hashKey, hookError, hookSecretBase64 } from "../_shared/fraud/hooks.ts";

interface HookPayload {
  metadata?: { ip_address?: string };
  user?: { email?: string; user_metadata?: { device_id?: unknown } };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = Deno.env.get("BEFORE_USER_CREATED_HOOK_SECRET");
  const pepper = Deno.env.get("FRAUD_HASH_PEPPER");
  if (!secret || !pepper) return hookError(500, "Hook is not configured.");

  const raw = await req.text();
  let payload: HookPayload;
  try {
    payload = new Webhook(hookSecretBase64(secret)).verify(raw, Object.fromEntries(req.headers)) as HookPayload;
  } catch {
    return hookError(401, "Invalid signature.");
  }

  const email = payload.user?.email ?? "";
  const parts = splitEmail(email);
  const canonical = canonicalizeEmail(email);
  if (!parts || !canonical) return hookError(403, "We couldn't create your account. Please contact support.");

  const ip = (payload.metadata?.ip_address ?? "unknown").slice(0, 64);
  const deviceRaw = payload.user?.user_metadata?.device_id;
  const device = typeof deviceRaw === "string" && /^[A-Za-z0-9-]{8,64}$/.test(deviceRaw) ? deviceRaw : null;

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const consume = async (scope: "ip" | "device" | "domain" | "mailbox", key: string, seconds: number): Promise<number> => {
    const { data, error } = await admin.rpc("fraud_signup_consume", { p_scope: scope, p_key_hash: await hashKey(pepper, `${scope}:${seconds}`, key), p_window_seconds: seconds });
    if (error) throw new Error(error.message);
    return Number(data);
  };

  try {
    const [ip1h, ip24h, dev24h, dom24h, box24h, blocked] = await Promise.all([
      consume("ip", ip, 3600),
      consume("ip", ip, 86400),
      device ? consume("device", device, 86400) : Promise.resolve(0),
      consume("domain", parts.domain, 86400),
      consume("mailbox", canonical, 86400),
      admin.from("fraud_blocked_email_domains").select("domain"),
    ]);
    const risk = scoreSignup({
      email, ipSignups1h: ip1h, ipSignups24h: ip24h, deviceSignups24h: dev24h, domainSignups24h: dom24h, mailboxSignups24h: box24h,
      challengePassed: null, // Auth verified the CAPTCHA before calling this hook (when enabled); we cannot see the result
      ipReputation: "unknown", // no reputation provider is integrated; do not pretend otherwise
      extraBlockedDomains: (blocked.data ?? []).map((r: { domain: string }) => r.domain),
    });

    if (risk.level !== "allow") {
      await admin.from("fraud_events").insert({
        kind: risk.level === "block" ? "signup_blocked" : "signup_flagged", code: risk.reasons[0] ?? "RISK", source: "auth-before-user-created",
        detail: { score: risk.score, reasons: risk.reasons, email_hash: await hashKey(pepper, "email", canonical), ip_hash: await hashKey(pepper, "ip", ip) },
      });
    }
    if (risk.level === "block") return hookError(403, "We couldn't create your account. Please contact support.");
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(JSON.stringify({ event: "signup_hook_error", error: e instanceof Error ? e.message : String(e) }));
    try { await admin.from("fraud_events").insert({ kind: "signup_flagged", code: "HOOK_ERROR_FAIL_OPEN", source: "auth-before-user-created", detail: {} }); } catch { /* ignore */ }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }
});
