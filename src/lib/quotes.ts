import { supabase } from '@/lib/supabase';

export interface QuoteLineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

export interface PublicQuoteInfo {
  quote_id: string;
  customer_name: string;
  line_items: QuoteLineItem[];
  tax_percent: number;
  status: string;
  valid_until: string | null;
  business_name: string | null;
}

export function calculateQuoteTotals(lineItems: QuoteLineItem[], taxPercent: number) {
  const subtotalCents = lineItems.reduce((sum, li) => sum + li.quantity * li.unit_price_cents, 0);
  const taxCents = Math.round((subtotalCents * taxPercent) / 100);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function getQuoteLink(token: string): string {
  return `${window.location.origin}/quote/${token}`;
}

export const QUOTE_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
};

export const QUOTE_STATUS_COLORS: Record<string, string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  sent: 'bg-accent/10 text-accent',
  accepted: 'bg-success-500/10 text-success-500',
  declined: 'bg-danger/10 text-danger',
  expired: 'bg-bg-tertiary text-text-secondary',
};

export async function fetchQuoteForToken(token: string): Promise<PublicQuoteInfo | null> {
  const { data, error } = await supabase.rpc('get_quote_for_token', { p_token: token });
  if (error || !data || data.length === 0) return null;
  return data[0] as PublicQuoteInfo;
}

export async function respondToQuote(token: string, response: 'accepted' | 'declined'): Promise<boolean> {
  const { data, error } = await supabase.rpc('respond_to_quote_by_token', {
    p_token: token,
    p_response: response,
  });
  if (error) return false;
  return Boolean(data);
}
