import { supabase } from '@/lib/supabase';
import { calculateQuoteTotals, fetchInvoices, type Invoice } from '@/lib/invoices';

export type GiftCardKind = 'gift_card' | 'store_credit';
export type GiftCardStoredStatus = 'active' | 'depleted' | 'voided';
export type GiftCardStatus = GiftCardStoredStatus | 'expired';
export type LedgerKind = 'issue' | 'redeem' | 'adjust' | 'void';

export interface GiftCard {
  id: string;
  code: string;
  kind: GiftCardKind;
  initial_cents: number;
  balance_cents: number;
  currency: string;
  status: GiftCardStoredStatus;
  recipient_name: string | null;
  recipient_email: string | null;
  note: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GiftCardTransaction {
  id: string;
  gift_card_id: string;
  kind: LedgerKind;
  amount_cents: number;
  balance_after_cents: number;
  invoice_id: string | null;
  note: string | null;
  created_at: string;
}

export interface RedeemResult {
  applied_cents: number;
  balance_cents: number;
  invoice_paid: boolean;
  remaining_due_cents: number | null;
}

export const MAX_AMOUNT_CENTS = 10_000_000;
const CODE_LENGTH = 12;
const DAY_MS = 86_400_000;

export const KIND_LABELS: Record<GiftCardKind, string> = {
  gift_card: 'Gift card',
  store_credit: 'Store credit',
};

export const STATUS_LABELS: Record<GiftCardStatus, string> = {
  active: 'Active',
  depleted: 'Used up',
  expired: 'Expired',
  voided: 'Voided',
};

export const STATUS_STYLES: Record<GiftCardStatus, string> = {
  active: 'bg-success-500/10 text-success-500',
  depleted: 'bg-bg-tertiary text-text-secondary',
  expired: 'bg-warning-500/10 text-warning-500',
  voided: 'bg-danger/10 text-danger',
};

// ============================================================
// PURE HELPERS (unit-tested)
// ============================================================

/** Strips everything but letters/digits and upper-cases — what a person might type or paste. */
export function normalizeCode(input: string): string {
  return input.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/** XXXX-XXXX-XXXX, or null when the input isn't a complete code. */
export function formatCode(input: string): string | null {
  const n = normalizeCode(input);
  if (n.length !== CODE_LENGTH) return null;
  return `${n.slice(0, 4)}-${n.slice(4, 8)}-${n.slice(8)}`;
}

/** Shows only the last block, e.g. XXXX-XXXX-AB12 → ••••-••••-AB12. */
export function maskCode(code: string): string {
  const parts = code.split('-');
  return parts.map((p, i) => (i === parts.length - 1 ? p : '••••')).join('-');
}

export function deriveStatus(card: Pick<GiftCard, 'status' | 'expires_at'>, now: Date = new Date()): GiftCardStatus {
  if (card.status === 'voided' || card.status === 'depleted') return card.status;
  if (card.expires_at && new Date(card.expires_at).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** "25", "25.5", "$1,250.00" → cents. Returns null for anything invalid, non-positive or over the cap. */
export function parseAmountToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_AMOUNT_CENTS) return null;
  return cents;
}

export function remainingDueCents(totalCents: number, alreadyRedeemedCents: number): number {
  return Math.max(totalCents - alreadyRedeemedCents, 0);
}

/** The most a card can contribute to an invoice: never above its balance or what is still owed. */
export function maxRedeemable(balanceCents: number, remainingDue: number | null): number {
  return remainingDue === null ? balanceCents : Math.max(Math.min(balanceCents, remainingDue), 0);
}

export function invoiceTotalCents(inv: Pick<Invoice, 'line_items' | 'tax_percent'>): number {
  return calculateQuoteTotals(inv.line_items ?? [], Number(inv.tax_percent) || 0).totalCents;
}

export interface GiftCardSummary {
  outstandingCents: number;
  issuedCents: number;
  activeCount: number;
  expiringSoonCount: number;
  expiredCents: number;
}

export function summarize(cards: GiftCard[], now: Date = new Date()): GiftCardSummary {
  const soon = now.getTime() + 30 * DAY_MS;
  const out: GiftCardSummary = { outstandingCents: 0, issuedCents: 0, activeCount: 0, expiringSoonCount: 0, expiredCents: 0 };
  for (const c of cards) {
    if (c.status !== 'voided') out.issuedCents += c.initial_cents;
    const s = deriveStatus(c, now);
    if (s === 'active') {
      out.activeCount += 1;
      out.outstandingCents += c.balance_cents;
      if (c.expires_at && new Date(c.expires_at).getTime() <= soon) out.expiringSoonCount += 1;
    } else if (s === 'expired') {
      out.expiredCents += c.balance_cents;
    }
  }
  return out;
}

// ============================================================
// DATA ACCESS — reads go through RLS; every write is a server-side RPC
// (balance and ledger can't be tampered with from the browser)
// ============================================================

export async function fetchGiftCards(): Promise<GiftCard[]> {
  const { data, error } = await supabase
    .from('gift_cards')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data as GiftCard[]) ?? [];
}

export async function fetchTransactions(cardId: string): Promise<GiftCardTransaction[]> {
  const { data, error } = await supabase
    .from('gift_card_transactions')
    .select('*')
    .eq('gift_card_id', cardId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data as GiftCardTransaction[]) ?? [];
}

export interface OpenInvoice {
  id: string;
  invoice_number: string;
  customer_name: string;
  totalCents: number;
  remainingCents: number;
}

/** Unpaid invoices with how much is still owed after earlier gift-card redemptions. */
export async function fetchOpenInvoices(): Promise<OpenInvoice[]> {
  const open = (await fetchInvoices()).filter((i) => i.status !== 'paid' && i.status !== 'void');
  if (open.length === 0) return [];
  const { data, error } = await supabase
    .from('gift_card_transactions')
    .select('invoice_id, amount_cents')
    .eq('kind', 'redeem')
    .in('invoice_id', open.map((i) => i.id));
  if (error) throw error;
  const redeemed = new Map<string, number>();
  for (const r of (data as { invoice_id: string; amount_cents: number }[]) ?? []) {
    redeemed.set(r.invoice_id, (redeemed.get(r.invoice_id) ?? 0) - r.amount_cents);
  }
  return open
    .map((i) => {
      const total = invoiceTotalCents(i);
      return {
        id: i.id,
        invoice_number: i.invoice_number,
        customer_name: i.customer_name,
        totalCents: total,
        remainingCents: remainingDueCents(total, redeemed.get(i.id) ?? 0),
      };
    })
    .filter((i) => i.remainingCents > 0);
}

export async function issueGiftCard(input: {
  kind: GiftCardKind;
  amountCents: number;
  recipientName?: string;
  recipientEmail?: string;
  note?: string;
  expiresAt?: string;
}): Promise<GiftCard> {
  const { data, error } = await supabase.rpc('issue_gift_card', {
    p_kind: input.kind,
    p_amount_cents: input.amountCents,
    p_recipient_name: input.recipientName || null,
    p_recipient_email: input.recipientEmail || null,
    p_note: input.note || null,
    p_expires_at: input.expiresAt || null,
  });
  if (error) throw new Error(error.message);
  return data as GiftCard;
}

export async function redeemGiftCard(input: { code: string; invoiceId?: string; amountCents?: number }): Promise<RedeemResult> {
  const { data, error } = await supabase.rpc('redeem_gift_card', {
    p_code: input.code,
    p_invoice_id: input.invoiceId ?? null,
    p_amount_cents: input.amountCents ?? null,
  });
  if (error) throw new Error(error.message);
  return data as RedeemResult;
}

export async function adjustGiftCard(cardId: string, deltaCents: number, note: string): Promise<void> {
  const { error } = await supabase.rpc('adjust_gift_card', { p_card_id: cardId, p_delta_cents: deltaCents, p_note: note });
  if (error) throw new Error(error.message);
}

export async function voidGiftCard(cardId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_gift_card', { p_card_id: cardId, p_reason: reason });
  if (error) throw new Error(error.message);
}
