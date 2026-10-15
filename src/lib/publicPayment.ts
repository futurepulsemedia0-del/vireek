import { supabase } from '@/lib/supabase';
import type { TipSelection } from '@/lib/tipping';

export interface PublicPaymentSummary {
  status: 'open' | 'paid' | 'canceled' | 'not_found';
  amount_cents?: number;
  description?: string;
  customer_first_name?: string;
  technician_first_name?: string | null;
  tip_enabled?: boolean;
  presets?: number[];
  publishable_key?: string | null;
}

async function readError(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response }).context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = await ctx.json();
      if (body?.error) return String(body.error);
    } catch {
      /* fall through */
    }
  }
  return 'Something went wrong. Please try again.';
}

export async function fetchPublicPayment(token: string): Promise<PublicPaymentSummary> {
  const { data, error } = await supabase.functions.invoke('public-payment', { body: { action: 'get', token } });
  if (error) throw new Error(await readError(error));
  return data as PublicPaymentSummary;
}

export async function startPublicCheckout(token: string, tip: TipSelection): Promise<string> {
  const { data, error } = await supabase.functions.invoke('public-payment', { body: { action: 'checkout', token, tip } });
  if (error) throw new Error(await readError(error));
  if (!data?.url) throw new Error('Could not start checkout.');
  return data.url as string;
}

/** Creates (or re-uses) the PaymentIntent for this link and returns its client secret for Stripe.js. */
export async function createPublicPaymentIntent(token: string, tip: TipSelection): Promise<string> {
  const { data, error } = await supabase.functions.invoke('public-payment', { body: { action: 'intent', token, tip } });
  if (error) throw new Error(await readError(error));
  if (!data?.client_secret) throw new Error('Could not start the payment.');
  return data.client_secret as string;
}
