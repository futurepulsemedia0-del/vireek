import { supabase } from '@/lib/supabase';
import { calculateQuoteTotals, formatCents, type QuoteLineItem } from '@/lib/quotes';

export { calculateQuoteTotals, formatCents };
export type { QuoteLineItem };

export type InvoiceStatus = 'draft' | 'sent' | 'viewed' | 'paid' | 'void';

export interface Invoice {
  id: string;
  job_id: string | null;
  quote_id: string | null;
  invoice_number: string;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  line_items: QuoteLineItem[];
  tax_percent: number;
  notes: string | null;
  status: InvoiceStatus;
  due_date: string | null;
  invoice_token: string;
  sent_at: string | null;
  viewed_at: string | null;
  paid_at: string | null;
  payment_method: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicInvoiceInfo {
  invoice_id: string;
  invoice_number: string;
  customer_name: string;
  line_items: QuoteLineItem[];
  tax_percent: number;
  status: string;
  due_date: string | null;
  notes: string | null;
  business_name: string | null;
}

export function isOverdue(invoice: Pick<Invoice, 'due_date' | 'status'>): boolean {
  if (!invoice.due_date || invoice.status === 'paid' || invoice.status === 'void') return false;
  return new Date(invoice.due_date) < new Date(new Date().toDateString());
}

export function getInvoiceLink(token: string): string {
  return `${window.location.origin}/invoice/${token}`;
}

export async function fetchInvoices(): Promise<Invoice[]> {
  const { data, error } = await supabase.from('invoices').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return (data as Invoice[]) ?? [];
}

export async function createInvoice(input: {
  job_id?: string;
  customer_name: string;
  customer_email?: string;
  customer_phone?: string;
  line_items: QuoteLineItem[];
  tax_percent?: number;
  due_date?: string;
  notes?: string;
}): Promise<Invoice> {
  const { data, error } = await supabase.from('invoices').insert(input).select().single();
  if (error) throw error;
  return data as Invoice;
}

export async function createInvoiceFromQuote(quoteId: string, dueDate?: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_invoice_from_quote', { p_quote_id: quoteId, p_due_date: dueDate ?? null });
  if (error) throw error;
  return data as string;
}

async function updateInvoice(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('invoices').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteInvoice(id: string): Promise<void> {
  const { error } = await supabase.from('invoices').delete().eq('id', id);
  if (error) throw error;
}

export async function markInvoiceSent(id: string): Promise<void> {
  await updateInvoice(id, { status: 'sent', sent_at: new Date().toISOString() });
}

export async function markInvoicePaid(id: string, paymentMethod: string): Promise<void> {
  await updateInvoice(id, { status: 'paid', paid_at: new Date().toISOString(), payment_method: paymentMethod });
}

export async function fetchInvoiceForToken(token: string): Promise<PublicInvoiceInfo | null> {
  const { data, error } = await supabase.rpc('get_invoice_for_token', { p_token: token });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row ? (row as PublicInvoiceInfo) : null;
}

export async function recordInvoiceView(token: string): Promise<void> {
  const { error } = await supabase.rpc('record_invoice_view', { p_token: token });
  if (error) throw error;
}
