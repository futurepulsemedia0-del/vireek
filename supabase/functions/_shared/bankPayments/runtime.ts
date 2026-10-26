// Pay by Bank — Deno runtime wiring (Stripe GET, notifications, env). Webhooks call ONE line:
//   await processBankStripeEvent(admin, event);
import { stripeGet } from "../stripe/terminalPayments.ts";
import { activateSignupMembership } from "../payments/finalizeIntent.ts";
import { notifyCustomer, payLinkFor } from "../paymentPlans/charge.ts";
import { processBankDisputeEvent, processBankIntentEvent, processBankMethodEvent, type BankEventDeps, type BankEventResult } from "./handler.ts";

export function makeBankDeps(secretKey: string): BankEventDeps {
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  return {
    fetchPaymentMethod: (id) => stripeGet(`payment_methods/${id}`, secretKey),
    activateMembership: activateSignupMembership,
    notifyCustomer: (contact, subject, text) => notifyCustomer(contact, subject, text),
    buildLink: (kind, id) => (kind === "pay" ? `${siteUrl}/pay/${id}` : payLinkFor("i", id)),
    log: (event, data) => console.log(JSON.stringify({ event, ...data })),
  };
}

/** Routes any Stripe event to the bank handlers. Safe to call for EVERY event: non-bank events return { handled: false }. */
export async function processBankStripeEvent(admin: any, event: any): Promise<BankEventResult> {
  const secretKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (!secretKey || typeof event?.type !== "string") return { handled: false };
  const deps = makeBankDeps(secretKey);
  if (event.type.startsWith("payment_intent.")) return processBankIntentEvent(admin, event, deps);
  if (event.type.startsWith("charge.dispute.")) return processBankDisputeEvent(admin, event, deps);
  if (event.type === "payment_method.automatically_updated") return processBankMethodEvent(admin, event, deps);
  return { handled: false };
}
