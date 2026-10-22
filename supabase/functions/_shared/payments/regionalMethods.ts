// Pure helpers for multi-currency charges and local debit methods (SEPA, Bacs, PAD, BECS).
// No imports and no runtime APIs: shared by the Deno edge functions and vitest. Keep it that way.
// Mirrors src/lib/regionalPacks/packData.ts (a parity test keeps the two in sync).

/** Lower-case ISO currencies Vireek can charge in (the five packs). */
export const CHARGE_CURRENCIES = ["usd", "cad", "gbp", "eur", "aud", "dkk", "sek", "pln", "czk", "huf", "ron"] as const;
export type ChargeCurrency = (typeof CHARGE_CURRENCIES)[number];

/** Stripe's minimum charge per currency, in minor units. Re-check against Stripe's docs when adding currencies. */
export const MIN_CHARGE_MINOR: Readonly<Record<ChargeCurrency, number>> = {
  usd: 50, cad: 50, gbp: 30, eur: 50, aud: 50, dkk: 250, sek: 300, pln: 200, czk: 1500, huf: 17500, ron: 200,
};

/** Direct-debit style methods: funds confirm days later, so `processing` must NOT be treated as paid. */
export const DELAYED_METHODS: readonly string[] = ["us_bank_account", "acss_debit", "bacs_debit", "sepa_debit", "au_becs_debit"];

export function isDelayedMethod(type: unknown): boolean {
  return typeof type === "string" && DELAYED_METHODS.includes(type);
}

/** Validates and lower-cases a currency. Falls back only when input is empty; throws on unsupported codes. */
export function normalizeChargeCurrency(input: unknown, fallback: ChargeCurrency = "usd"): ChargeCurrency {
  if (input === null || input === undefined || (typeof input === "string" && input.trim() === "")) return fallback;
  const c = String(input).trim().toLowerCase();
  if (!(CHARGE_CURRENCIES as readonly string[]).includes(c)) throw new Error(`Unsupported currency "${c}".`);
  return c as ChargeCurrency;
}

export function minChargeMinor(currency: ChargeCurrency): number {
  return MIN_CHARGE_MINOR[currency];
}

/**
 * Extra PaymentIntent options some methods need. Pre-authorized Debit (acss_debit) requires mandate options,
 * but Stripe only accepts them once the method is enabled for your account — so it is opt-in.
 */
export function buildRegionalPaymentMethodOptions(
  currency: ChargeCurrency,
  opts: { acssEnabled?: boolean; businessCustomer?: boolean } = {},
): Record<string, unknown> | undefined {
  if (opts.acssEnabled && (currency === "cad" || currency === "usd")) {
    return {
      acss_debit: {
        mandate_options: { payment_schedule: "sporadic", transaction_type: opts.businessCustomer ? "business" : "personal" },
        verification_method: "automatic",
      },
    };
  }
  return undefined;
}
