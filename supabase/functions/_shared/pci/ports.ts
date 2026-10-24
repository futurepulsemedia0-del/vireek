// supabase/functions/_shared/pci/ports.ts
// Wires the orchestrator's ports to the real Supabase / Twilio / Stripe / Vapi clients (Deno only).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripeRequest, StripeApiError } from "../stripe/client.ts";
import { finalizePaymentRequestFromIntent } from "../payments/finalizeIntent.ts";
import { ChargeError, type PciPorts, type PhonePaymentRow } from "./orchestrator.ts";
import { deepRedact } from "./cardData.ts";
import { signSessionToken, TWILIO_CALL_SID_RE } from "./session.ts";
import { pauseCallRecordings, redirectCallToTwiml, resumeCallRecordings } from "./twilio.ts";

export function functionsBaseUrl(): string {
  return (Deno.env.get("PHONE_PAYMENT_WEBHOOK_URL") ?? `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/phone-payment-webhook`).replace(/\/$/, "");
}

export function safeLog(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...deepRedact(data) }));
}

export async function lookupTwilioCallSid(vapiCallId: string): Promise<string | null> {
  const key = Deno.env.get("VAPI_PRIVATE_KEY");
  if (!key) return null;
  try {
    const res = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(vapiCallId)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const call = (await res.json()) as { phoneCallProviderId?: string; phoneCallProvider?: string };
    const sid = call.phoneCallProviderId ?? "";
    return call.phoneCallProvider === "twilio" && TWILIO_CALL_SID_RE.test(sid) ? sid : null;
  } catch {
    return null;
  }
}

export async function buildPorts(admin: SupabaseClient): Promise<PciPorts> {
  const secret = Deno.env.get("PCI_SESSION_HMAC_SECRET") ?? "";
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  const twilioCfg = { accountSid: Deno.env.get("TWILIO_ACCOUNT_SID") ?? "", authToken: Deno.env.get("TWILIO_AUTH_TOKEN") ?? "" };
  const rawTokenType = Deno.env.get("TWILIO_PAY_TOKEN_TYPE");
  const tokenType = rawTokenType === "payment-method" || rawTokenType === "reusable" ? rawTokenType : "one-time";
  const url = (sid: string, step: "action" | "status") => async () => `${functionsBaseUrl()}?sid=${sid}&step=${step}&t=${await signSessionToken(secret, sid)}`;

  return {
    db: {
      async getJob(userId, jobId) {
        const { data } = await admin.from("jobs").select("id, customer_name, customer_phone").eq("id", jobId).eq("user_id", userId).maybeSingle();
        return data ?? null;
      },
      async getBalanceCents(jobId) {
        const { data, error } = await admin.rpc("_job_balance", { p_job_id: jobId });
        if (error) throw error;
        return Number(data?.balance_cents ?? 0);
      },
      async getConnectDestination(userId) {
        const { data } = await admin.from("stripe_connect_accounts").select("stripe_account_id, charges_enabled").eq("user_id", userId).maybeSingle();
        return data?.stripe_account_id && data.charges_enabled ? data.stripe_account_id : null;
      },
      async expireStale(userId) {
        await admin.rpc("expire_stale_phone_payment_sessions", { p_user_id: userId });
      },
      async findActiveSession(userId, vapiCallId) {
        const { data } = await admin.from("phone_payment_sessions").select("*").eq("user_id", userId).eq("vapi_call_id", vapiCallId)
          .in("status", ["requested", "recording_paused", "capturing", "tokenized", "charging"]).maybeSingle();
        return (data as PhonePaymentRow | null) ?? null;
      },
      async createPaymentRequest(row) {
        const { data, error } = await admin.from("payment_requests").insert({ ...row, status: "pending", collected_via: "office" }).select("id").single();
        if (error || !data) throw error ?? new Error("payment request insert failed");
        return { id: data.id as string };
      },
      async setPaymentRequestStatus(id, status) {
        await admin.from("payment_requests").update({ status }).eq("id", id).eq("status", "pending");
      },
      async insertSession(row) {
        const { data, error } = await admin.from("phone_payment_sessions").insert(row).select("*").single();
        if (error || !data) throw error ?? new Error("session insert failed");
        return data as PhonePaymentRow;
      },
      async getSession(id) {
        const { data } = await admin.from("phone_payment_sessions").select("*").eq("id", id).maybeSingle();
        return (data as PhonePaymentRow | null) ?? null;
      },
      async transition(id, from, patch) {
        const { data, error } = await admin.from("phone_payment_sessions").update(patch).eq("id", id).in("status", from).select("*").maybeSingle();
        if (error) throw error;
        return (data as PhonePaymentRow | null) ?? null;
      },
      async appendAudit(sessionId, userId, e) {
        const { error } = await admin.from("phone_payment_audit_events").insert({
          session_id: sessionId, user_id: userId, event_type: e.type, actor_type: e.actorType, actor_id: e.actorId ?? null, metadata: e.metadata,
        });
        if (error) throw error;
      },
      async markRecordingResumed(sessionId, atIso) {
        await admin.from("phone_payment_sessions").update({ recording_resumed_at: atIso }).eq("id", sessionId);
      },
    },
    twilio: {
      pauseRecordings: (sid) => pauseCallRecordings(twilioCfg, sid),
      resumeRecordings: (sid) => resumeCallRecordings(twilioCfg, sid),
      redirect: (sid, twiml) => redirectCallToTwiml(twilioCfg, sid, twiml),
    },
    stripe: {
      async charge(a) {
        const isPm = a.token.startsWith("pm_");
        const params: Record<string, unknown> = {
          amount: a.amountCents,
          currency: "usd",
          confirm: true,
          description: a.description,
          metadata: a.metadata,
          transfer_data: { destination: a.destination },
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          expand: ["latest_charge"],
          ...(isPm ? { payment_method: a.token } : { payment_method_data: { type: "card", card: { token: a.token } } }),
          ...(a.moto ? { payment_method_options: { card: { moto: true } } } : {}),
        };
        try {
          const pi = await stripeRequest("payment_intents", params, stripeKey, { idempotencyKey: a.idempotencyKey });
          const card = pi.latest_charge?.payment_method_details?.card;
          return { id: pi.id, status: pi.status, amount: pi.amount, currency: pi.currency, brand: card?.brand ?? null, last4: card?.last4 ?? null, paymentIntent: pi };
        } catch (e) {
          if (e instanceof StripeApiError) {
            if (e.code === "card_declined" || e.status === 402) throw new ChargeError("payment_declined");
            if (e.code === "authentication_required") throw new ChargeError("needs_authentication");
          }
          throw new ChargeError("provider_error");
        }
      },
    },
    finalizeRequestFromIntent: (pi) => finalizePaymentRequestFromIntent(admin, pi),
    resolveCallLeg: lookupTwilioCallSid,
    urls: { action: (sid) => url(sid, "action")(), status: (sid) => url(sid, "status")() },
    config: { payConnector: Deno.env.get("TWILIO_PAY_CONNECTOR") ?? "", tokenType, motoEnabled: Deno.env.get("STRIPE_PHONE_MOTO_ENABLED") === "true" },
    log: safeLog,
    now: () => new Date(),
  };
}
