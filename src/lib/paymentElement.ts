import type { Appearance, StripeElementsOptionsMode, StripePaymentElementOptions } from '@stripe/stripe-js';

export const PAYMENT_CURRENCY = 'usd';

const PUBLISHABLE_KEY_RE = /^pk_(test|live)_[A-Za-z0-9]{10,}$/;

/** Publishable keys are public, but a malformed/secret key must never reach Stripe.js. */
export function isValidPublishableKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && PUBLISHABLE_KEY_RE.test(key);
}

/**
 * Payment Element configuration. Wallets are "auto": Apple Pay / Google Pay appear only when the
 * device supports them AND the domain is registered with Stripe — otherwise they silently stay hidden.
 */
export const PAYMENT_ELEMENT_OPTIONS: StripePaymentElementOptions = {
  layout: 'accordion',
  wallets: { applePay: 'auto', googlePay: 'auto' },
};

/** "12 34 56" / "12, 34, 56" (Tailwind CSS-variable triplet) -> "#0c2238". Null if it isn't a triplet. */
export function rgbTripletToHex(triplet: string): string | null {
  const parts = triplet.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

const FALLBACK_ACCENT = '#2563eb';

export function buildAppearance(opts: { dark: boolean; accentTriplet?: string }): Appearance {
  return {
    theme: opts.dark ? 'night' : 'stripe',
    labels: 'floating',
    variables: {
      colorPrimary: (opts.accentTriplet && rgbTripletToHex(opts.accentTriplet)) || FALLBACK_ACCENT,
      borderRadius: '12px',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    },
  };
}

/** Reads the live theme (class-based dark mode + the --accent-primary CSS variable). Browser only. */
export function readAppearanceFromDom(): Appearance {
  if (typeof document === 'undefined') return buildAppearance({ dark: false });
  const root = document.documentElement;
  return buildAppearance({
    dark: root.classList.contains('dark'),
    accentTriplet: getComputedStyle(root).getPropertyValue('--accent-primary'),
  });
}

/**
 * Deferred-intent options: the Payment Element renders before any PaymentIntent exists, so the tip
 * can change freely and wallets always show the final total. The amount here MUST equal the amount
 * the server puts on the PaymentIntent (both come from the same computeTip).
 */
export function buildElementsOptions(amountCents: number, appearance: Appearance): StripeElementsOptionsMode {
  return { mode: 'payment', amount: amountCents, currency: PAYMENT_CURRENCY, appearance };
}

export function buildReturnUrl(origin: string): string {
  return `${origin.replace(/\/$/, '')}/pay-result?status=success`;
}

export const GENERIC_PAYMENT_ERROR = 'We couldn’t complete the payment. You have not been charged. Please try again.';

/**
 * Card / validation errors carry a customer-safe message written by Stripe. Everything else
 * (api, network, config) gets a generic message so internals never leak to customers.
 */
export function describePaymentError(error: { type?: string; message?: string } | null | undefined): string {
  if (!error) return GENERIC_PAYMENT_ERROR;
  if ((error.type === 'card_error' || error.type === 'validation_error') && error.message) return error.message;
  return GENERIC_PAYMENT_ERROR;
}
