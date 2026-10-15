// Lazy, memoised Stripe.js loader. The "pure" entry point does NOT inject the Stripe script on import,
// so the script only loads on pages that actually take a payment (/pay/:token).
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe } from '@stripe/stripe-js';

const cache = new Map<string, Promise<Stripe | null>>();

export function getStripe(publishableKey: string): Promise<Stripe | null> {
  let promise = cache.get(publishableKey);
  if (!promise) {
    promise = loadStripe(publishableKey);
    cache.set(publishableKey, promise);
  }
  return promise;
}
