import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripeRequest } from "../_shared/stripe/client.ts";
import { sendSms, sendEmail } from "../_shared/notify/deliver.ts";
import {
  parseIssueInput,
  stripeReasonFor,
  isAmbiguousStripeFailure,
  formatMoney,
} from "../_shared/refunds/logic.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
interface Actor { userId: string; email: string; ownerId: string; canIssue: boolean }

/**
 * Same owner resolution as public.get_account_owner_id(): a team_members row (by user_id)
 * wins, otherwise the caller is the account owner. Owners may always refund; team members
 * need can_issue_refunds on their member record or custom role — same rule the UI uses.
 */
async function authorize(admin: SupabaseClient, req: Request): Promise<Actor | Response> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing Authorization header." }, 401);
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) return json({ error: "Invalid or expired session." }, 401);
  const user = data.user;

  const { data: rows } = await admin
    .from("team_members")
    .select("account_owner_id, permissions, custom_role:custom_roles(permissions)")
    .eq("user_id", user.id)
    .limit(1);
  const member = (rows as Row[] | null)?.[0];

  if (!member) return { userId: user.id, email: user.email ?? "", ownerId: user.id, canIssue: true };

  const customRole = Array.isArray(member.custom_role) ? member.custom_role[0] : member.custom_role;
  const perms = { ...(member.permissions ?? {}), ...(customRole?.permissions ?? {}) } as Record<string, unknown>;
  return { userId: user.id, email: user.email ?? "", ownerId: member.account_owner_id, canIssue: perms.can_issue_refunds === true };
}

async function audit(admin: SupabaseClient, actor: Actor, action: string, refundId: string) {
  const { error } = await admin.from("audit_log").insert({
    user_id: actor.ownerId,
    actor_id: actor.userId,
    actor_email: actor.email,
    action,
    target_table: "refunds",
    target_id: refundId,
  });
  if (error) console.error(JSON.stringify({ event: "refund_audit_failed", action, error: error.message }));
}

async function markFailed(admin: SupabaseClient, refundId: string, reason: string) {
  await admin
    .from("refunds")
    .update({ status: "failed", failure_reason: reason.slice(0, 300), completed_at: new Date().toISOString() })
    .eq("id", refundId)
    .eq("status", "pending")
    .is("stripe_refund_id", null);
}

async function sendNotice(admin: SupabaseClient, ownerId: string, refund: Row): Promise<"sent" | "failed" | "skipped"> {
  const email = (refund.customer_email as string | null)?.trim();
  const phone = (refund.customer_phone as string | null)?.trim();
  if (!email && !phone) return "skipped";

  const { data: profile } = await admin.from("profiles").select("company_name").eq("id", ownerId).maybeSingle();
  const business = (profile?.company_name as string | null)?.trim() || "your service provider";
  const amount = formatMoney(refund.amount_cents, refund.currency);
  const memo = refund.credit_memo_number ? ` Credit memo ${refund.credit_memo_number}.` : "";
  const timing = "It usually appears on your statement within 5–10 business days.";
  const text = `${business} refunded ${amount} to your original payment method.${memo} ${timing}`;

  let delivered = false;
  if (phone) {
    try {
      const r = await sendSms(phone, `${business}: we've refunded ${amount} to your original payment method.${memo} ${timing}`);
      delivered = r.ok || delivered;
    } catch (e) {
      console.error(JSON.stringify({ event: "refund_sms_failed", error: e instanceof Error ? e.message : String(e) }));
    }
  }
  if (email) {
    try {
      const html = `<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
        <p style="font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin: 0 0 16px;">Refund issued</p>
        <h1 style="font-size: 22px; margin: 0 0 16px;">${escapeHtml(amount)} refunded</h1>
        <p style="font-size: 15px; line-height: 1.5; margin: 0 0 12px;">Hi ${escapeHtml(String(refund.customer_name))}, ${escapeHtml(business)} has refunded ${escapeHtml(amount)} to your original payment method.${memo ? ` ${escapeHtml(memo.trim())}` : ""}</p>
        <p style="font-size: 14px; color: #6b7280; margin: 0;">${escapeHtml(timing)}</p>
      </div>`;
      const r = await sendEmail(email, `Your ${amount} refund from ${business}`, html, text);
      delivered = r.ok || delivered;
    } catch (e) {
      console.error(JSON.stringify({ event: "refund_email_failed", error: e instanceof Error ? e.message : String(e) }));
    }
  }
  return delivered ? "sent" : "failed";
}

/** Runs everything after the reservation. Safe to call repeatedly for the same refund (replay / Resume). */
async function processRefund(admin: SupabaseClient, actor: Actor, refundId: string, secretKey: string, resumed: boolean): Promise<Response> {
  const { data: loaded } = await admin.from("refunds").select("*").eq("id", refundId).eq("user_id", actor.ownerId).maybeSingle();
  let refund = loaded as Row | null;
  if (!refund) return json({ error: "Refund not found." }, 404);
  if (refund.status === "failed" || refund.status === "canceled") {
    return json({ error: refund.failure_reason || "This refund did not go through. Start a new one." }, 409);
  }

  let warning: "status_unknown" | "accounting_pending" | null = null;
  let stripeId: string | null = refund.stripe_refund_id;
  let stripeStatus: string = refund.status;

  // 1) Stripe — idempotent on the refund row id, so a retry can never refund twice.
  if (!stripeId) {
    const { data: pr } = await admin
      .from("payment_requests")
      .select("stripe_payment_intent_id")
      .eq("id", refund.payment_request_id)
      .eq("user_id", actor.ownerId)
      .maybeSingle();
    if (!pr?.stripe_payment_intent_id) {
      await markFailed(admin, refund.id, "No Stripe payment is linked to this payment.");
      return json({ error: "No Stripe payment is linked to this payment." }, 400);
    }
    try {
      const sr = await stripeRequest(
        "refunds",
        {
          payment_intent: pr.stripe_payment_intent_id,
          amount: refund.amount_cents,
          reason: stripeReasonFor(refund.reason_code),
          reverse_transfer: true, // destination charge: pull the money back from the connected account
          metadata: {
            refund_id: refund.id,
            payment_request_id: refund.payment_request_id,
            user_id: actor.ownerId,
            reason_code: refund.reason_code,
          },
        },
        secretKey,
        { idempotencyKey: `refund_${refund.id}` },
      );
      stripeId = sr.id as string;
      stripeStatus = sr.status as string;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Stripe could not process the refund.";
      if (isAmbiguousStripeFailure(err)) {
        console.error(JSON.stringify({ event: "refund_stripe_ambiguous", refund_id: refund.id, error: message }));
        return json(
          { refund, warning: "status_unknown", message: "Stripe has not confirmed this refund yet. Check History in a minute and press Resume if it stays on Processing." },
          202,
        );
      }
      await markFailed(admin, refund.id, message);
      await audit(admin, actor, "refund_failed", refund.id);
      return json({ error: message }, 422);
    }
  }

  // 2) Credit memo + ledger entry
  const freshlyFinalized = !refund.journal_entry_id;
  if (freshlyFinalized) {
    const { data: fin, error: finError } = await admin.rpc("refund_finalize", {
      p_refund_id: refund.id,
      p_stripe_refund_id: stripeId,
      p_stripe_status: stripeStatus,
    });
    if (finError) {
      console.error(JSON.stringify({ event: "refund_finalize_failed", refund_id: refund.id, error: finError.message }));
      return json(
        { refund, warning: "status_unknown", message: "The refund reached Stripe but we could not record it yet. Press Resume in History to finish." },
        202,
      );
    }
    refund = fin as Row;
    if (refund.accounting_status === "failed") warning = "accounting_pending";
  }

  if (refund.status === "failed" || refund.status === "canceled") {
    await audit(admin, actor, "refund_failed", refund.id);
    return json({ error: refund.failure_reason || "Stripe could not complete this refund." }, 422);
  }

  // 3) Customer notice (never blocks the refund)
  if (refund.notify_customer && (refund.notice_status === "not_sent" || refund.notice_status === "failed")) {
    const status = await sendNotice(admin, actor.ownerId, refund);
    const patch = { notice_status: status, notice_sent_at: status === "sent" ? new Date().toISOString() : null };
    await admin.from("refunds").update(patch).eq("id", refund.id);
    refund = { ...refund, ...patch };
  }

  // 4) Audit trail + activity ledger
  if (freshlyFinalized || resumed) {
    await audit(admin, actor, resumed ? "refund_resumed" : "refund_issued", refund.id);
  }
  if (freshlyFinalized) {
    const { error: evError } = await admin.rpc("append_activity_event", {
      p_aggregate_type: "payment",
      p_aggregate_id: refund.payment_request_id,
      p_event_type: "refund.issued",
      p_event_data: { refund_id: refund.id, amount_cents: refund.amount_cents, reason_code: refund.reason_code },
      p_actor_type: "user",
      p_user_id: actor.ownerId,
    });
    if (evError) console.error(JSON.stringify({ event: "refund_activity_event_failed", error: evError.message }));
  }

  return json({ refund, warning });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

    const actor = await authorize(admin, req);
    if (actor instanceof Response) return actor;
    if (!actor.canIssue) return json({ error: "You don't have permission to issue refunds." }, 403);

    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secretKey) return json({ error: "Payments aren't configured on this server yet (missing STRIPE_SECRET_KEY)." }, 500);

    const body = await req.json().catch(() => null);

    if (body && typeof body === "object" && (body as Row).action === "resume") {
      const refundId = (body as Row).refund_id;
      if (typeof refundId !== "string" || !UUID_RE.test(refundId)) return json({ error: "A valid refund_id is required." }, 400);
      return await processRefund(admin, actor, refundId, secretKey, true);
    }

    const parsed = parseIssueInput(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const input = parsed.value;

    const { data: reserved, error: reserveError } = await admin.rpc("refund_reserve", {
      p_user_id: actor.ownerId,
      p_payment_request_id: input.paymentRequestId,
      p_amount_cents: input.amountCents,
      p_reason_code: input.reasonCode,
      p_reason_note: input.reasonNote,
      p_notify: input.notifyCustomer,
      p_idempotency_key: input.idempotencyKey,
      p_actor_id: actor.userId,
      p_actor_email: actor.email,
    });
    if (reserveError) {
      // P0001 = our own RAISE EXCEPTION messages (safe, user-fixable). Anything else stays generic.
      if (reserveError.code === "P0001") return json({ error: reserveError.message }, 400);
      console.error(JSON.stringify({ event: "refund_reserve_failed", error: reserveError.message }));
      return json({ error: "Could not start the refund. Please try again." }, 500);
    }

    return await processRefund(admin, actor, (reserved as Row).id, secretKey, false);
  } catch (error) {
    console.error(JSON.stringify({ event: "issue_refund_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong issuing the refund." }, 500);
  }
});
