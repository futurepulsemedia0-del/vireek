import { supabase } from '@/lib/supabase';

export interface QuoteLineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
  tax_class?: string;
}

export interface PublicQuoteInfo {
  quote_id: string;
  customer_name: string;
  line_items: QuoteLineItem[];
  options: unknown[];
  photos: unknown[];
  recommended_option_id: string | null;
  selected_option_id: string | null;
  presentation_note: string | null;
  deposit_percent: number;
  tax_percent: number;
  status: string;
  valid_until: string | null;
  business_name: string | null;
  financing_partner_name: string | null;
  financing_note: string | null;
  promo_discount_cents: number;
  promo_codes: string[];
  tax_breakdown?: import('@/lib/salesTax').TaxBreakdownLine[];
  tax_cents?: number | null;
  tax_exempt?: boolean;
}

export function calculateQuoteTotals(lineItems: QuoteLineItem[], taxPercent: number, promoDiscountCents = 0) {
  const subtotalCents = lineItems.reduce((sum, li) => sum + li.quantity * li.unit_price_cents, 0);
  // Promo discount is pre-tax and can never exceed the subtotal.
  const discountCents = Math.min(Math.max(0, Math.round(promoDiscountCents)), Math.max(0, subtotalCents));
  const taxableCents = subtotalCents - discountCents;
  const taxCents = Math.round((taxableCents * taxPercent) / 100);
  return { subtotalCents, discountCents, taxCents, totalCents: taxableCents + taxCents };
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

export async function respondToQuote(
  token: string,
  response: 'accepted' | 'declined',
  optionId: string | null = null
): Promise<boolean> {
  const { data, error } = await supabase.rpc('respond_to_quote_by_token', {
    p_token: token,
    p_response: response,
    p_option_id: optionId,
  });
  if (error) return false;
  return Boolean(data);
}

export async function recordQuoteView(token: string): Promise<void> {
  await supabase.rpc('record_quote_view', { p_token: token });
}
