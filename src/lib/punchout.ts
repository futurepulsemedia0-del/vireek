/**
 * Supplier PunchOut — pure domain logic (no network, no React).
 * Mirrors supabase/migrations/20280101000000_supplier_punchout.sql; the database stays the authority.
 */

export const SESSION_STATUSES = ['pending', 'started', 'returned', 'ordered', 'cancelled', 'expired', 'failed'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface PunchoutConnection {
  id: string;
  vendor_id: string;
  environment: 'test' | 'production';
  setup_url: string;
  buyer_domain: string;
  buyer_identity: string;
  sender_domain: string;
  sender_identity: string;
  supplier_domain: string;
  supplier_identity: string;
  currency: string;
  enabled: boolean;
  secret_set: boolean;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
}

export interface PunchoutSession {
  id: string;
  connection_id: string;
  vendor_id: string;
  job_id: string | null;
  destination_location_id: string | null;
  status: SessionStatus;
  currency: string;
  supplier_total_cents: number | null;
  line_count: number;
  purchase_order_id: string | null;
  error_message: string | null;
  expires_at: string;
  returned_at: string | null;
  created_at: string;
}

export interface PunchoutLine {
  id: string;
  session_id: string;
  line_no: number;
  sku: string;
  name: string;
  mpn: string | null;
  manufacturer: string | null;
  uom: string;
  quantity: number;
  unit_price_cents: number;
  lead_time_days: number | null;
  catalog_item_id: string | null;
  catalog_cost_cents: number | null;
}

export interface ConnectionForm {
  vendor_id: string;
  setup_url: string;
  buyer_identity: string;
  sender_identity: string;
  supplier_identity: string;
  buyer_domain: string;
  sender_domain: string;
  supplier_domain: string;
  environment: 'test' | 'production';
  currency: string;
  enabled: boolean;
  shared_secret: string;
}

export const EMPTY_FORM: ConnectionForm = {
  vendor_id: '',
  setup_url: '',
  buyer_identity: '',
  sender_identity: '',
  supplier_identity: '',
  buyer_domain: 'NetworkID',
  sender_domain: 'NetworkID',
  supplier_domain: 'NetworkID',
  environment: 'test',
  currency: 'USD',
  enabled: true,
  shared_secret: '',
};

export function formatMoney(cents: number, currency = 'USD'): string {
  const safe = Number.isFinite(cents) ? cents : 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(safe / 100);
  } catch {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(safe / 100);
  }
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  pending: 'Opening…',
  started: 'Shopping',
  returned: 'Ready to review',
  ordered: 'Ordered',
  cancelled: 'Cancelled',
  expired: 'Expired',
  failed: 'Failed',
};

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export function statusTone(s: SessionStatus): Tone {
  switch (s) {
    case 'returned':
      return 'info';
    case 'ordered':
      return 'success';
    case 'failed':
      return 'danger';
    case 'expired':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** Sessions that are still open on the supplier's side (the page polls while any exist). */
export const isOpen = (s: Pick<PunchoutSession, 'status'>) => s.status === 'pending' || s.status === 'started';

/** Validates the connection form on the client for instant feedback (the edge function re-validates). */
export function validateConnection(f: ConnectionForm, isEdit: boolean): Partial<Record<keyof ConnectionForm, string>> {
  const e: Partial<Record<keyof ConnectionForm, string>> = {};
  if (!f.vendor_id) e.vendor_id = 'Choose a supplier.';
  const url = f.setup_url.trim();
  if (!url) e.setup_url = 'Enter the PunchOut URL your supplier gave you.';
  else if (!/^https:\/\/[^/\s]+\.[^/\s]+/i.test(url)) e.setup_url = 'The URL must start with https:// and use a host name.';
  const ident = /^[\x20-\x7E]{1,120}$/;
  if (!ident.test(f.buyer_identity.trim())) e.buyer_identity = 'Enter your buyer identity (1–120 characters).';
  if (!ident.test(f.sender_identity.trim())) e.sender_identity = 'Enter your sender identity (1–120 characters).';
  if (!ident.test(f.supplier_identity.trim())) e.supplier_identity = 'Enter the supplier identity (1–120 characters).';
  const secret = f.shared_secret.trim();
  if (!isEdit && !secret) e.shared_secret = 'Enter the shared secret from your supplier.';
  else if (secret && (secret.length < 4 || secret.length > 200)) e.shared_secret = 'The shared secret must be 4–200 characters.';
  if (!/^[A-Za-z]{3}$/.test(f.currency)) e.currency = 'Use a 3-letter currency code.';
  return e;
}

export interface ReviewSummary {
  lineCount: number;
  unitCount: number;
  totalCents: number;
  changed: number;
  increased: number;
  newParts: number;
  /** Extra cost vs the catalog price across all lines (positive = more expensive than before). */
  deltaCents: number;
}

export function lineDelta(l: Pick<PunchoutLine, 'unit_price_cents' | 'catalog_cost_cents'>): number | null {
  return l.catalog_cost_cents == null ? null : l.unit_price_cents - l.catalog_cost_cents;
}

export function summarizeReview(lines: PunchoutLine[]): ReviewSummary {
  const s: ReviewSummary = { lineCount: lines.length, unitCount: 0, totalCents: 0, changed: 0, increased: 0, newParts: 0, deltaCents: 0 };
  for (const l of lines) {
    s.unitCount += l.quantity;
    s.totalCents += l.quantity * l.unit_price_cents;
    const d = lineDelta(l);
    if (d === null) s.newParts += 1;
    else if (d !== 0) {
      s.changed += 1;
      if (d > 0) s.increased += 1;
      s.deltaCents += d * l.quantity;
    }
  }
  return s;
}

/** The warning shown when the supplier's own total disagrees with the sum of its lines (tax/shipping/rounding). */
export function totalMismatch(supplierTotalCents: number | null, lineTotalCents: number): number | null {
  if (supplierTotalCents == null || supplierTotalCents === 0) return null;
  return Math.abs(supplierTotalCents - lineTotalCents) > 1 ? supplierTotalCents - lineTotalCents : null;
}

export const RETURN_ERRORS: Record<string, string> = {
  invalid_cart: 'The supplier sent a cart Vireek could not read. Open the store and send the cart again.',
  currency_mismatch: 'The cart currency does not match this connection. Check the currency in the connection settings.',
  session_expired: 'That shopping session has expired or was already used. Open the store again.',
  too_large: 'The cart was too large to receive. Send fewer lines.',
  failed: 'Something went wrong receiving the cart. Open the store and try again.',
};
