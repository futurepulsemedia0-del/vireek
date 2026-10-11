// Stripe Terminal / Tap to Pay backend for the technician app.
// Actions: connection_token | create_intent | finalize | cancel
// The amount is ALWAYS computed/validated server-side against the job balance.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripeRequest } from "../_shared/stripe/client.ts";
import {
  applyPaymentIntentResult,
  ensureTerminalLocation,
  retrievePaymentIntent,
  TerminalSetupError,
} from "../_shared/stripe/terminalPayments.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

const MIN_CARD_CENTS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveCaller(admin: any, userId: string) {
  const { data: members } = await admin.from("team_members").select("id, account_owner_id, role").eq("user_id", userId).limit(1);
  const member = members?.[0] ?? null;
  let role: string | null = member?.role ?? null;
  if (!member) {
    const { data: profile } = await admin.from("profiles").select("role").eq("id", userId).maybeSingle();
    role = profile?.role ?? null;
  }
  return {
    ownerId: (member?.account_owner_id ?? userId) as string,
    memberId: (member?.id ?? null) as string | null,
    manager: role === "owner" || role === "admin",
  };
}

function canHandle(caller: Awaited<ReturnType<typeof resolveCaller>>, job: { user_id: string; assigned_technician_id: string | null }) {
  return job.user_id === caller.ownerId && (caller.manager || (!!caller.memberId && job.assigned_technician_id === caller.memberId));
}

async function getConnect(admin: any, ownerId: string) {
  const { data } = await admin.from("stripe_connect_accounts").select("stripe_account_id, charges_enabled").eq("user_id", ownerId).maybeSingle();
  if (!data?.stripe_account_id || !data.charges_enabled) {
    throw new HttpError(400, "Connect and finish verifying your Stripe account before taking card payments.", "stripe_not_ready");
  }
  return data.stripe_account_id as string;
}

async function loadPaymentForCaller(admin: any, caller: any, paymentId: string) {
  if (!UUID_RE.test(paymentId ?? "")) throw new HttpError(400, "Invalid payment id.");
  const { data: pay } = await admin.from("job_payments").select("*").eq("id", paymentId).maybeSingle();
  if (!pay || pay.method !== "card_present") throw new HttpError(404, "Payment not found.");
  const { data: job } = await admin.from("jobs").select("id, user_id, assigned_technician_id").eq("id", pay.job_id).maybeSingle();
  if (!job || !canHandle(caller, job)) throw new HttpError(403, "You can't access this payment.");
  return pay;
}

async function finalize(admin: any, pay: any, secretKey: string) {
  if (!pay.stripe_payment_intent_id) return { status: pay.status, balance_cents: null };
  const pi = await retrievePaymentIntent(pay.stripe_payment_intent_id, secretKey);
  const result = await applyPaymentIntentResult(admin, pi, secretKey);
  const { data: bal } = await admin.rpc("_job_balance", { p_job_id: pay.job_id });
  return {
    status: result.status ?? pay.status,
    balance_cents: bal?.balance_cents ?? null,
    invoice_gate_blocked: !!result.gateBlocked,
    invoice_gate_message: result.gateMessage ?? null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Missing Authorization header." }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return json({ error: "Invalid or expired session." }, 401);

    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secretKey) return json({ error: "Payments aren't configured on this server yet (missing STRIPE_SECRET_KEY)." }, 500);

    const body = await req.json().catch(() => ({}));
    const caller = await resolveCaller(admin, userData.user.id);
    if (!caller.manager && !caller.memberId) return json({ error: "Only technicians and managers can take payments." }, 403);

    switch (body.action) {
      case "connection_token": {
        const accountId = await getConnect(admin, caller.ownerId);
        const locationId = await ensureTerminalLocation(admin, caller.ownerId, accountId, secretKey);
        const token = await stripeRequest("terminal/connection_tokens", {}, secretKey);
        return json({ secret: token.secret, location_id: locationId, is_test: secretKey.startsWith("sk_test") });
      }

      case "create_intent": {
        const jobId = body.job_id as string;
        const requestId = body.client_request_id as string;
        if (!UUID_RE.test(jobId ?? "") || !UUID_RE.test(requestId ?? "")) throw new HttpError(400, "job_id and client_request_id are required.");

        const { data: job } = await admin.from("jobs").select("id, user_id, assigned_technician_id, customer_name, service_type").eq("id", jobId).maybeSingle();
        if (!job) throw new HttpError(404, "Job not found.");
        if (!canHandle(caller, job)) throw new HttpError(403, "You can't take payments for this job.");
        const accountId = await getConnect(admin, caller.ownerId);
        const locationId = await ensureTerminalLocation(admin, caller.ownerId, accountId, secretKey);

        // Idempotent retry
        const { data: existing } = await admin.from("job_payments").select("*").eq("user_id", caller.ownerId).eq("client_request_id", requestId).maybeSingle();
        if (existing) {
          if (existing.status === "pending" && existing.stripe_payment_intent_id) {
            const pi = await retrievePaymentIntent(existing.stripe_payment_intent_id, secretKey);
            return json({ job_payment_id: existing.id, client_secret: pi.client_secret, payment_intent_id: pi.id, amount_cents: existing.amount_cents, location_id: locationId });
          }
          throw new HttpError(409, "This payment attempt was already processed.", "already_processed");
        }

        const { data: bal } = await admin.rpc("_job_balance", { p_job_id: jobId });
        if (!bal || bal.invoice_cents <= 0) throw new HttpError(400, "Set an invoice amount on this job first.", "no_invoice_amount");
        const amount = body.amount_cents == null ? bal.balance_cents : Number(body.amount_cents);
        if (!Number.isInteger(amount) || amount < MIN_CARD_CENTS) throw new HttpError(400, "Card payments must be at least $0.50.", "invalid_amount");
        if (amount > bal.balance_cents) throw new HttpError(400, "Amount is more than the balance due.", "exceeds_balance");

        // Never leave two live card attempts for one job (double-charge protection).
        const { data: stale } = await admin.from("job_payments").select("id, stripe_payment_intent_id").eq("job_id", jobId).eq("method", "card_present").eq("status", "pending");
        for (const s of stale ?? []) {
          if (s.stripe_payment_intent_id) {
            try {
              await stripeRequest(`payment_intents/${s.stripe_payment_intent_id}/cancel`, {}, secretKey);
            } catch {
              throw new HttpError(409, "A card payment is still in progress for this job. Finish or cancel it first.", "payment_in_progress");
            }
          }
          await admin.from("job_payments").update({ status: "failed", failure_message: "Superseded by a new attempt" }).eq("id", s.id).eq("status", "pending");
        }

        const { data: pay, error: insErr } = await admin.from("job_payments").insert({
          user_id: caller.ownerId, job_id: jobId, method: "card_present", status: "pending", amount_cents: amount,
          recorded_by_member_id: caller.memberId, recorded_by_user_id: userData.user.id, client_request_id: requestId,
          deposit_status: "not_applicable",
        }).select().single();
        if (insErr || !pay) throw new HttpError(409, "Could not start this payment. Please try again.", "insert_failed");

        try {
          const pi = await stripeRequest("payment_intents", {
            amount, currency: "usd", payment_method_types: ["card_present"], capture_method: "automatic",
            description: job.service_type ? `${job.service_type} — ${job.customer_name}` : `Invoice for ${job.customer_name}`,
            transfer_data: { destination: accountId },
            metadata: { job_payment_id: pay.id, job_id: jobId, user_id: caller.ownerId, source: "terminal" },
          }, secretKey);
          await admin.from("job_payments").update({ stripe_payment_intent_id: pi.id }).eq("id", pay.id);
          return json({ job_payment_id: pay.id, client_secret: pi.client_secret, payment_intent_id: pi.id, amount_cents: amount, location_id: locationId });
        } catch (e) {
          await admin.from("job_payments").update({ status: "failed", failure_message: "Could not create Stripe payment" }).eq("id", pay.id);
          throw e;
        }
      }

      case "finalize": {
        const pay = await loadPaymentForCaller(admin, caller, body.job_payment_id);
        return json(await finalize(admin, pay, secretKey));
      }

      case "cancel": {
        const pay = await loadPaymentForCaller(admin, caller, body.job_payment_id);
        if (pay.status !== "pending") return json({ status: pay.status });
        if (pay.stripe_payment_intent_id) {
          try {
            await stripeRequest(`payment_intents/${pay.stripe_payment_intent_id}/cancel`, {}, secretKey);
          } catch {
            // Could not cancel (e.g. it actually succeeded): trust Stripe's state.
            return json(await finalize(admin, pay, secretKey));
          }
        }
        await admin.from("job_payments").update({ status: "failed", failure_message: "Canceled by technician" }).eq("id", pay.id).eq("status", "pending");
        return json({ status: "failed" });
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof TerminalSetupError) return json({ error: error.message, code: "terminal_setup" }, 400);
    console.error(JSON.stringify({ event: "terminal_payments_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong with the card payment." }, 500);
  }
});
