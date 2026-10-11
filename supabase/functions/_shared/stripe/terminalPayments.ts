// Shared Stripe Terminal helpers for edge functions (no Stripe SDK, same style as client.ts).
import { stripeRequest } from "./client.ts";

export class TerminalSetupError extends Error {}

export async function stripeGet(path: string, secretKey: string, query: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`https://api.stripe.com/v1/${path}${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Stripe API error (${res.status})`);
  return data;
}

/** Returns the Terminal Location for this business, creating it once from the Stripe account's address. */
export async function ensureTerminalLocation(admin: any, ownerId: string, accountId: string, secretKey: string): Promise<string> {
  const { data: row } = await admin.from("stripe_connect_accounts").select("terminal_location_id").eq("user_id", ownerId).maybeSingle();
  if (row?.terminal_location_id) return row.terminal_location_id as string;

  const acct = await stripeGet(`accounts/${accountId}`, secretKey);
  const addr = acct.company?.address ?? acct.individual?.address ?? null;
  const name = acct.business_profile?.name || acct.company?.name || "Vireek Field";
  if (!addr?.line1 || !addr?.city || !addr?.postal_code || !addr?.country) {
    throw new TerminalSetupError("Add your business address in your Stripe account before using Tap to Pay.");
  }
  const loc = await stripeRequest(
    "terminal/locations",
    {
      display_name: name,
      address: { line1: addr.line1, line2: addr.line2 || undefined, city: addr.city, state: addr.state || undefined, postal_code: addr.postal_code, country: addr.country },
    },
    secretKey,
  );
  await admin.from("stripe_connect_accounts").update({ terminal_location_id: loc.id }).eq("user_id", ownerId);
  return loc.id as string;
}

export async function retrievePaymentIntent(id: string, secretKey: string): Promise<any> {
  return stripeGet(`payment_intents/${id}`, secretKey, { "expand[]": "latest_charge" });
}

/**
 * Applies a PaymentIntent's state to our job_payments row. Idempotent; safe to call from
 * both the webhook and the finalize action. Ignores PaymentIntents that aren't ours.
 */
export async function applyPaymentIntentResult(
  admin: any,
  pi: any,
  secretKey?: string,
): Promise<{ handled: boolean; status?: string; jobId?: string; gateBlocked?: boolean; gateMessage?: string }> {
  const paymentId = pi?.metadata?.job_payment_id as string | undefined;
  if (!paymentId) return { handled: false };

  const { data: row } = await admin
    .from("job_payments")
    .select("id, job_id, amount_cents, status")
    .eq("id", paymentId)
    .maybeSingle();
  if (!row) return { handled: false };

  if (pi.status === "succeeded") {
    if (pi.amount !== row.amount_cents || String(pi.currency).toLowerCase() !== "usd") {
      console.error(JSON.stringify({ event: "terminal_amount_mismatch", paymentId, piAmount: pi.amount, rowAmount: row.amount_cents }));
      return { handled: true, status: "mismatch", jobId: row.job_id };
    }
    let charge = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
    if (!charge && typeof pi.latest_charge === "string" && secretKey) {
      try { charge = await stripeGet(`charges/${pi.latest_charge}`, secretKey); } catch { /* brand/last4 are optional */ }
    }
    const card = charge?.payment_method_details?.card_present ?? charge?.payment_method_details?.interac_present ?? null;
    if (row.status !== "succeeded") {
      await admin
        .from("job_payments")
        .update({
          status: "succeeded",
          card_brand: card?.brand ?? null,
          card_last4: card?.last4 ?? null,
          failure_message: null,
          received_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .in("status", ["pending", "failed"]);
    }
    const { data: sync } = await admin.rpc("_sync_job_invoice_status", { p_job_id: row.job_id });
    return { handled: true, status: "succeeded", jobId: row.job_id, gateBlocked: !!sync?.gate_blocked, gateMessage: sync?.gate_message };
  }

  if (pi.status === "canceled") {
    await admin.from("job_payments").update({ status: "failed", failure_message: "Canceled" }).eq("id", row.id).eq("status", "pending");
    return { handled: true, status: "failed", jobId: row.job_id };
  }

  const msg = pi.last_payment_error?.message as string | undefined;
  if (msg) await admin.from("job_payments").update({ failure_message: msg.slice(0, 300) }).eq("id", row.id).eq("status", "pending");
  return { handled: true, status: row.status, jobId: row.job_id };
}
