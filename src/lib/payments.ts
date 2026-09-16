import { supabase } from '@/lib/supabase';

export type PaymentStatus = 'pending' | 'sent' | 'paid' | 'failed' | 'overdue' | 'canceled';

export interface PaymentRequest {
  id: string;
  job_id: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  amount: number;
  status: PaymentStatus;
  payment_link_url: string | null;
  reminder_count: number;
  paid_at: string | null;
  created_at: string;
}

export interface StripeConnectStatus {
  stripe_account_id: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
}

export const PAYMENT_STATUS_META: Record<PaymentStatus, { label: string; tone: 'neutral' | 'accent' | 'success' | 'danger' }> = {
  pending: { label: 'Pending', tone: 'neutral' },
  sent: { label: 'Awaiting Payment', tone: 'accent' },
  paid: { label: 'Paid', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  overdue: { label: 'Overdue', tone: 'danger' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

export async function fetchPaymentRequests(): Promise<PaymentRequest[]> {
  const { data, error } = await supabase.from('payment_requests').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as PaymentRequest[];
}

export async function fetchConnectStatus(): Promise<StripeConnectStatus | null> {
  const { data, error } = await supabase.from('stripe_connect_accounts').select('*').maybeSingle();
  if (error) throw error;
  return data as StripeConnectStatus | null;
}

export async function startStripeConnectOnboarding(): Promise<string> {
  const { data, error } = await supabase.functions.invoke('stripe-connect-onboarding');
  if (error) throw error;
  if (!data?.url) throw new Error('Could not start Stripe onboarding.');
  return data.url as string;
}

export async function createPaymentRequest(input: {
  job_id: string;
  customer_email?: string;
  customer_phone?: string;
}): Promise<{ payment_request_id: string; payment_link_url: string }> {
  const { data, error } = await supabase.functions.invoke('create-payment-request', { body: input });
  if (error) throw error;
  return data as { payment_request_id: string; payment_link_url: string };
}
