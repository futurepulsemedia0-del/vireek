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

// ---------- customer (token-gated) — public /financing/:token page ----------

export interface PublicFinancingOffer {
  business_name: string | null;
  service_type: string | null;
  customer_first_name: string | null;
  status: FinancingOfferStatus;
  requested_amount_cents: number;
  approved_amount_cents: number | null;
  apr_bps: number | null;
  term_months: number | null;
  application_url: string | null;
  created_at: string;
  updated_at: string;
}

export type PublicFinancingResult =
  | { state: 'ok'; offer: PublicFinancingOffer }
  | { state: 'not_found' }
  | { state: 'error' };

export type PublicFinancingPhase = 'preparing' | 'ready' | 'in_review' | 'approved' | 'confirmed' | 'declined' | 'closed';
export type PublicFinancingStepState = 'done' | 'current' | 'todo' | 'failed';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PUBLIC_FINANCING_STEPS = ['Offer sent', 'Application', 'Decision', 'Loan confirmed'] as const;

/** Customer-facing grouping of the provider statuses. */
export function getPublicFinancingPhase(status: FinancingOfferStatus): PublicFinancingPhase {
  switch (status) {
    case 'created':
      return 'preparing';
    case 'sent':
    case 'clicked':
      return 'ready';
    case 'applied':
      return 'in_review';
    case 'approved':
      return 'approved';
    case 'loan_confirmed':
    case 'funded':
      return 'confirmed';
    case 'declined':
      return 'declined';
    default:
      return 'closed'; // expired, canceled
  }
}

/** Final phases never change again, so the page stops polling. */
export function isPublicFinancingPhaseFinal(phase: PublicFinancingPhase): boolean {
  return phase === 'confirmed' || phase === 'declined' || phase === 'closed';
}

/** Progress for the 4-step tracker. Returns [] when a tracker makes no sense (closed offers). */
export function getPublicFinancingSteps(phase: PublicFinancingPhase): PublicFinancingStepState[] {
  switch (phase) {
    case 'preparing':
      return ['current', 'todo', 'todo', 'todo'];
    case 'ready':
      return ['done', 'current', 'todo', 'todo'];
    case 'in_review':
      return ['done', 'done', 'current', 'todo'];
    case 'approved':
      return ['done', 'done', 'done', 'current'];
    case 'confirmed':
      return ['done', 'done', 'done', 'done'];
    case 'declined':
      return ['done', 'done', 'failed', 'todo'];
    default:
      return [];
  }
}

/** Only ever send the customer to an https URL (the value comes from the provider). */
export function isSafeApplicationUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Standard amortised payment, in cents. An estimate only — the lender's agreement is authoritative. */
export function estimateMonthlyPaymentCents(principalCents: number, aprBps: number | null, termMonths: number | null): number | null {
  if (aprBps === null || termMonths === null) return null;
  if (!Number.isFinite(principalCents) || principalCents <= 0) return null;
  if (!Number.isFinite(aprBps) || aprBps < 0) return null;
  if (!Number.isInteger(termMonths) || termMonths <= 0) return null;
  const monthlyRate = aprBps / 10000 / 12;
  const payment = monthlyRate === 0 ? principalCents / termMonths : (principalCents * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -termMonths));
  return Math.round(payment);
}

export function formatFinancingAmount(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export async function fetchPublicFinancingOffer(token: string): Promise<PublicFinancingResult> {
  if (!UUID_RE.test(token)) return { state: 'not_found' };
  const { data, error } = await supabase.rpc('get_public_financing_offer', { p_token: token });
  if (error) return { state: 'error' };
  if (!data) return { state: 'not_found' };
  return { state: 'ok', offer: data as PublicFinancingOffer };
}
