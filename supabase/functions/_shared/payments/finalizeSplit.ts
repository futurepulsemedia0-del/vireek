// Books a succeeded split-payer PaymentIntent into the invoice ledger.
// Idempotent (the RPC de-duplicates on the PaymentIntent id) and safe to call from webhook retries.
// Takes the Supabase admin client as a parameter so it can be unit-tested with a fake.
import { isSplitIntent } from "./splitPayment.ts";

export interface SplitFinalizeOutcome {
  handled: boolean;
  status?: string;
}

export async function finalizeSplitPaymentFromIntent(admin: any, pi: any): Promise<SplitFinalizeOutcome> {
  if (!isSplitIntent(pi)) return { handled: false };
  if (pi.status !== "succeeded") return { handled: true, status: pi.status };

  const payerId = pi.metadata.split_payer_id as string;
  if (String(pi.currency).toLowerCase() !== "usd") {
    console.error(JSON.stringify({ event: "split_payment_currency_mismatch", payerId, paymentIntent: pi.id, currency: pi.currency }));
    return { handled: true, status: "currency_mismatch" };
  }

  const received = typeof pi.amount_received === "number" && pi.amount_received > 0 ? pi.amount_received : pi.amount;
  const { data, error } = await admin.rpc("finalize_split_payment", {
    p_payer_id: payerId,
    p_user_id: pi.metadata.user_id,
    p_payment_intent_id: pi.id,
    p_amount_cents: received,
  });
  if (error) throw error;

  const status = (data?.status as string | undefined) ?? "unknown";
  if (status === "recorded" || status === "already_recorded") {
    console.log(JSON.stringify({ event: "split_payment_recorded", payerId, paymentIntent: pi.id, status }));
  } else {
    // Money moved but could not be booked: surface it for a human, never fix it silently.
    console.error(JSON.stringify({ event: "split_payment_needs_attention", payerId, paymentIntent: pi.id, status }));
  }
  return { handled: true, status };
}
