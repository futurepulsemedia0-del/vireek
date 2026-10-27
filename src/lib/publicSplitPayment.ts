import { supabase } from '@/lib/supabase';

export type PublicSplitReason = 'void' | 'not_ready' | 'changed';

export interface PublicSplitSummary {
  status: 'open' | 'paid' | 'blocked' | 'not_found';
  reason?: PublicSplitReason | null;
  payer_name?: string;
  role?: string;
  invoice_number?: string;
  business_name?: string | null;
  due_date?: string | null;
  share_cents?: number;
  paid_cents?: number;
  payable_cents?: number;
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

export async function fetchPublicSplit(token: string): Promise<PublicSplitSummary> {
  const { data, error } = await supabase.functions.invoke('split-payment', { body: { action: 'get', token } });
  if (error) throw new Error(await readError(error));
  return data as PublicSplitSummary;
}

/** Creates (or re-uses) the PaymentIntent for this payer's remaining share and returns its client secret. */
export async function createSplitPaymentIntent(token: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('split-payment', { body: { action: 'intent', token } });
  if (error) throw new Error(await readError(error));
  if (!data?.client_secret) throw new Error('Could not start the payment.');
  return data.client_secret as string;
}
