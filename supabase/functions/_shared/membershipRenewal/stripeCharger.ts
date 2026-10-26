// Off-session card charge for a membership renewal (Stripe Connect destination charge, same shape as
// payment-plan-runner's installment charge). Kept apart from pipeline.ts so the pipeline stays Deno/Stripe-free.

import { stripe, StripeError } from "../paymentPlans/stripe.ts";
import type { ChargeInput, ChargeResult } from "./pipeline.ts";

export function makeStripeCharger(secretKey: string): (input: ChargeInput) => Promise<ChargeResult> {
  return async (i) => {
    try {
      const pm = await stripe("GET", `payment_methods/${i.paymentMethodId}`, secretKey);
      if (pm?.type !== "card") return { outcome: "declined", message: "Automatic renewal supports cards only." };
      const pi = await stripe(
        "POST",
        "payment_intents",
        secretKey,
        {
          amount: i.amountCents,
          currency: "usd",
          customer: i.customerId,
          payment_method: i.paymentMethodId,
          off_session: true,
          confirm: true,
          transfer_data: { destination: i.destinationAccountId },
          description: i.description.slice(0, 500),
          receipt_email: i.receiptEmail || undefined,
          metadata: i.metadata,
        },
        i.idempotencyKey,
      );
      if (pi.status === "succeeded") return { outcome: "succeeded", intent: pi };
      if (pi.status === "requires_action" || pi.status === "requires_confirmation") return { outcome: "requires_action" };
      if (pi.status === "processing") return { outcome: "retry" };
      return { outcome: "declined", message: "The payment could not be completed." };
    } catch (e) {
      if (!(e instanceof StripeError)) throw e;
      if (e.code === "authentication_required") return { outcome: "requires_action" };
      if (e.type === "card_error" || e.type === "invalid_request_error" || e.type === "idempotency_error") {
        return { outcome: "declined", message: e.message };
      }
      return { outcome: "retry" }; // api_error / rate limit: safe to replay with the same idempotency key
    }
  };
}
