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
