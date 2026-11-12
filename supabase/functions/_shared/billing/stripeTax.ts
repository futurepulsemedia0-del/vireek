// supabase/functions/_shared/billing/stripeTax.ts
//
// Pure helpers that make Vireek's own subscription checkout Stripe-Tax-ready.
// No Deno / Stripe SDK imports on purpose, so vitest covers every branch.
//
// Policy: NO tax rate, threshold or registration rule lives in this repo.
// Stripe Tax decides all of that. These helpers only decide whether to ASK
// Stripe to calculate tax, and which Checkout fields Stripe needs to do it.
//
// Gate: STRIPE_AUTOMATIC_TAX === "true" (exact match, same as before).
// With the variable unset (or anything else) nothing changes.

export function isAutomaticTaxEnabled(rawEnvValue: string | null | undefined): boolean {
  return rawEnvValue === "true";
}

export interface CheckoutTaxOptions {
  /** True when the Checkout Session is created with `customer: cus_...`. */
  hasCustomer: boolean;
  /**
   * Some call sites historically always sent `automatic_tax: { enabled: false }`
   * when tax is off. Keep that byte-for-byte; everyone else sends nothing.
   */
  explicitDisabled?: boolean;
}

export type CheckoutTaxParams = {
  automatic_tax?: { enabled: boolean };
  tax_id_collection?: { enabled: true };
  billing_address_collection?: "required";
  customer_update?: { address: "auto"; name: "auto" };
};

/**
 * Fields to spread into `stripe.checkout.sessions.create({...})`.
 *
 * When enabled:
 *  - automatic_tax            : Stripe calculates tax.
 *  - billing_address_collection 'required': a full address is needed for tax.
 *  - tax_id_collection        : business customers can enter a VAT/GST/etc. ID
 *                               (this is what makes reverse charge possible).
 *  - customer_update          : ONLY valid together with `customer`. Stripe
 *                               requires address=auto to save the address used
 *                               for tax and name=auto when tax IDs are collected.
 */
export function checkoutTaxParams(enabled: boolean, opts: CheckoutTaxOptions): CheckoutTaxParams {
  if (!enabled) return opts.explicitDisabled ? { automatic_tax: { enabled: false } } : {};
  return {
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    billing_address_collection: "required",
    ...(opts.hasCustomer ? { customer_update: { address: "auto" as const, name: "auto" as const } } : {}),
  };
}

/**
 * Subscription schedules do NOT reliably inherit tax from the subscription they
 * are built from: Stripe asks integrations to set it explicitly per phase.
 * Mirror what the subscription actually has (not the env var), so a
 * subscription bought through a tax-enabled Payment Link keeps its tax after a
 * scheduled downgrade, and untaxed subscriptions stay untouched.
 */
export function subscriptionHasAutomaticTax(sub: { automatic_tax?: { enabled?: boolean | null } | null } | null | undefined): boolean {
  return sub?.automatic_tax?.enabled === true;
}

export function schedulePhaseTax(taxed: boolean): { automatic_tax?: { enabled: true } } {
  return taxed ? { automatic_tax: { enabled: true } } : {};
}

export type PriceTaxVerdict = "exclusive" | "inclusive" | "unspecified";

/** Vireek prices are tax-exclusive. `unspecified` falls back to the Dashboard default. */
export function priceTaxVerdict(taxBehavior: string | null | undefined): PriceTaxVerdict {
  if (taxBehavior === "exclusive") return "exclusive";
  if (taxBehavior === "inclusive") return "inclusive";
  return "unspecified";
}
