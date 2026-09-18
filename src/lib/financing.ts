import { supabase } from './supabase';

export type FinancingProviderId = 'wisetack';

export type FinancingOfferStatus =
  | 'created' | 'sent' | 'clicked' | 'applied' | 'approved'
  | 'declined' | 'expired' | 'loan_confirmed' | 'funded' | 'canceled';

export interface FinancingConnection {
  id: string;
  provider: FinancingProviderId;
  external_merchant_id: string | null;
  status: 'pending' | 'connected' | 'error' | 'disconnected';
  last_error: string | null;
}

export interface FinancingOffer {
  id: string;
  job_id: string | null;
  provider: FinancingProviderId;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  requested_amount_cents: number;
  approved_amount_cents: number | null;
  apr_bps: number | null;
  term_months: number | null;
  status: FinancingOfferStatus;
  application_url: string | null;
  decline_reason: string | null;
  created_at: string;
  funded_at: string | null;
}

export const FINANCING_STATUS_META: Record<FinancingOfferStatus, { label: string; tone: 'neutral' | 'accent' | 'success' | 'danger' }> = {
  created: { label: 'Preparing offer', tone: 'neutral' },
  sent: { label: 'Sent to customer', tone: 'accent' },
  clicked: { label: 'Customer viewing', tone: 'accent' },
  applied: { label: 'Application submitted', tone: 'accent' },
  approved: { label: 'Approved', tone: 'success' },
  declined: { label: 'Declined', tone: 'danger' },
  expired: { label: 'Offer expired', tone: 'neutral' },
  loan_confirmed: { label: 'Loan confirmed', tone: 'success' },
  funded: { label: 'Funded — you got paid', tone: 'success' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

// Keep this in sync with MIN_FINANCING_AMOUNT_CENTS in
// financing-create-offer/index.ts — shown here only so the dashboard
// can gray out the "Offer financing" button before making a request.
export const MIN_FINANCING_AMOUNT_CENTS = 20000;

export function isEligibleForFinancing(invoiceAmount: number | null | undefined): boolean {
  if (!invoiceAmount) return false;
  return Math.round(invoiceAmount * 100) >= MIN_FINANCING_AMOUNT_CENTS;
}

export function formatApr(aprBps: number | null): string {
  if (aprBps === null) return '—';
  return `${(aprBps / 100).toFixed(2)}% APR`;
}

export async function fetchFinancingConnection(): Promise<FinancingConnection | null> {
  const { data, error } = await supabase.from('financing_connections').select('*').eq('provider', 'wisetack').maybeSingle();
  if (error) throw error;
  return data;
}

export async function fetchFinancingOffers(jobId?: string): Promise<FinancingOffer[]> {
  let query = supabase.from('financing_offers').select('*').order('created_at', { ascending: false });
  if (jobId) query = query.eq('job_id', jobId);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function createFinancingOffer(input: {
  job_id: string;
  customer_email?: string;
  customer_phone?: string;
}): Promise<{ offer_id: string; application_url: string }> {
  const { data, error } = await supabase.functions.invoke('financing-create-offer', { body: input });
  if (error) throw error;
  return data as { offer_id: string; application_url: string };
}
