// supabase/functions/_shared/audit/deps.ts
// Builds production AuditDeps from environment variables. Throws a clear error for missing required config so the
// Edge Function fails closed (503) instead of half-working. Mock providers are NEVER selected in production.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { MockBot, MockCalls, MockMailer, MockOtp } from "./mock.ts";
import type { AuditDeps } from "./ports.ts";
import { resendMailer, turnstileBot, twilioLookup, twilioVerifyOtp, vapiCalls } from "./providers.ts";
import { supabaseAuditStore } from "./supabaseStore.ts";

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
const need = (k: string) => { const v = env(k); if (!v) throw new Error(`missing_env_${k}`); return v; };

export const isProduction = () => env("AUDIT_ENV") === "production" || (env("AUDIT_ENV") !== "mock" && env("AUDIT_ENV") !== "staging");

export function buildAuditDeps(): AuditDeps {
  const mock = env("AUDIT_ENV") === "mock";
  if (mock && env("SUPABASE_URL").includes("supabase.co") && env("AUDIT_ALLOW_MOCK_ON_HOSTED") !== "1") {
    throw new Error("mock_providers_refused_on_hosted_project");
  }
  const sb = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const base = {
    store: supabaseAuditStore(sb),
    now: () => new Date(),
    log: (event: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ scope: "audit", event, ...data })),
    env: {
      pepper: need("AUDIT_PEPPER"), tokenSecret: need("AUDIT_TOKEN_SECRET"), linkSecret: need("AUDIT_LINK_SECRET"),
      baseUrl: need("AUDIT_BASE_URL").replace(/\/$/, ""), functionsUrl: `${need("SUPABASE_URL").replace(/\/$/, "")}/functions/v1`,
      postalAddress: env("AUDIT_POSTAL_ADDRESS") || null, killSwitch: env("AUDIT_KILL_SWITCH") === "1",
      turnstileSiteKey: env("TURNSTILE_SITE_KEY") || null, lookupEnabled: env("AUDIT_LOOKUP") === "1",
    },
  };
  if (mock) return { ...base, otp: new MockOtp(), calls: new MockCalls(), mailer: new MockMailer(), lookup: null, bot: new MockBot() };
  const sid = need("TWILIO_ACCOUNT_SID"), tok = need("TWILIO_AUTH_TOKEN");
  const voice = env("AUDIT_VAPI_VOICE_JSON") ? JSON.parse(env("AUDIT_VAPI_VOICE_JSON")) : undefined;
  return {
    ...base,
    otp: twilioVerifyOtp({ accountSid: sid, authToken: tok, verifyServiceSid: need("TWILIO_VERIFY_SERVICE_SID") }),
    lookup: env("AUDIT_LOOKUP") === "1" ? twilioLookup({ accountSid: sid, authToken: tok }) : null,
    calls: vapiCalls({ apiKey: need("VAPI_API_KEY"), phoneNumberId: need("AUDIT_VAPI_PHONE_NUMBER_ID"), serverUrl: `${need("SUPABASE_URL").replace(/\/$/, "")}/functions/v1/vapi-webhook`, serverSecret: need("VAPI_WEBHOOK_SECRET"), voice }),
    mailer: resendMailer({ apiKey: need("RESEND_API_KEY"), from: need("AUDIT_EMAIL_FROM"), replyTo: env("AUDIT_EMAIL_REPLY_TO") || undefined }),
    bot: turnstileBot(need("TURNSTILE_SECRET_KEY")),
  };
}
