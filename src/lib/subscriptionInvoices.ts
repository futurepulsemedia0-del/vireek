// Types + pure helpers for /dashboard/billing/invoices. The shapes mirror the
// DTOs produced by supabase/functions/billing-invoices. Stripe amounts are in
// the currency's minor unit (cents), so everything here converts before display.

export type SubscriptionInvoiceStatus = 'open' | 'paid' | 'void' | 'uncollectible';

export interface SubscriptionInvoice {
  id: string;
  number: string | null;
  status: SubscriptionInvoiceStatus;
  createdAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  description: string | null;
  currency: string;
  total: number;
  amountDue: number;
  amountPaid: number;
  pdfUrl: string | null;
  hostedUrl: string | null;
  attemptCount: number;
  nextPaymentAttemptAt: string | null;
}

export interface SavedCard {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  funding: string | null;
  isDefault: boolean;
}

export interface SubscriptionInvoicesResponse {
  hasBillingAccount: boolean;
  invoices: SubscriptionInvoice[];
  cards: SavedCard[];
  hasMore: boolean;
  nextCursor: string | null;
  canManagePaymentMethods: boolean;
  error?: string;
}

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';

export const INVOICE_STATUS_META: Record<SubscriptionInvoiceStatus, { label: string; tone: StatusTone }> = {
  paid: { label: 'Paid', tone: 'success' },
  open: { label: 'Payment due', tone: 'warning' },
  uncollectible: { label: 'Uncollectible', tone: 'danger' },
  void: { label: 'Void', tone: 'neutral' },
};

export const TONE_CLASSES: Record<StatusTone, string> = {
  success: 'bg-success-500/10 text-success-500',
  warning: 'bg-warning-500/10 text-warning-500',
  danger: 'bg-danger/10 text-danger',
  neutral: 'bg-bg-tertiary text-text-secondary',
};

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

export function minorToMajor(amountMinor: number, currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? amountMinor : amountMinor / 100;
}

export function formatInvoiceAmount(amountMinor: number, currency: string): string {
  const code = currency.toUpperCase();
  const major = minorToMajor(amountMinor, code);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(major);
  } catch {
    return `${code} ${major.toFixed(2)}`;
  }
}

/** UTC on purpose: the same invoice shows the same date for everyone. */
export function formatInvoiceDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function invoicePeriodLabel(invoice: Pick<SubscriptionInvoice, 'periodStart' | 'periodEnd'>): string | null {
  if (!invoice.periodStart || !invoice.periodEnd) return null;
  return `${formatInvoiceDate(invoice.periodStart)} – ${formatInvoiceDate(invoice.periodEnd)}`;
}

/** Appends a freshly loaded page without ever duplicating an invoice. */
export function mergeInvoices(existing: SubscriptionInvoice[], incoming: SubscriptionInvoice[]): SubscriptionInvoice[] {
  const seen = new Set(existing.map((inv) => inv.id));
  return [...existing, ...incoming.filter((inv) => !seen.has(inv.id))];
}

export interface InvoiceSummary {
  currency: string;
  outstandingMinor: number;
  outstandingCount: number;
  lastPaid: SubscriptionInvoice | null;
}

export function summarizeInvoices(invoices: SubscriptionInvoice[]): InvoiceSummary {
  const currency = invoices[0]?.currency ?? 'USD';
  const open = invoices.filter((inv) => inv.status === 'open');
  const lastPaid = invoices
    .filter((inv) => inv.status === 'paid' && inv.amountPaid > 0)
    .reduce<SubscriptionInvoice | null>(
      (latest, inv) => (!latest || new Date(inv.createdAt) > new Date(latest.createdAt) ? inv : latest),
      null,
    );
  return {
    currency,
    outstandingMinor: open.filter((inv) => inv.currency === currency).reduce((sum, inv) => sum + inv.amountDue, 0),
    outstandingCount: open.length,
    lastPaid,
  };
}

const BRAND_LABELS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  cartes_bancaires: 'Cartes Bancaires',
};

export function brandLabel(brand: string): string {
  return BRAND_LABELS[brand.toLowerCase()] ?? 'Card';
}

export function formatExpiry(card: Pick<SavedCard, 'expMonth' | 'expYear'>): string {
  return `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear % 100).padStart(2, '0')}`;
}

export type CardExpiryState = 'expired' | 'expiring' | 'valid';

/** Cards stay valid through the last day of their expiry month. */
export function cardExpiryState(card: Pick<SavedCard, 'expMonth' | 'expYear'>, now: Date = new Date()): CardExpiryState {
  const monthsLeft = card.expYear * 12 + (card.expMonth - 1) - (now.getUTCFullYear() * 12 + now.getUTCMonth());
  if (monthsLeft < 0) return 'expired';
  return monthsLeft <= 1 ? 'expiring' : 'valid';
}
