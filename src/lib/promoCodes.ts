// Recreated: verify against original intent
// src/lib/promoCodes.ts
//
// Promo codes for quotes, invoices and online booking.
// TODO(vireek): backend missing. This repository has no promo-code tables, RPCs or edge function (only references
// to `promo_codes` / `promo_discount_cents` columns on quotes and invoices in unrelated migrations), so nothing here
// may claim a code is valid or compute a discount. The pure helpers are real; every data function fails closed:
//  - validateBookingPromo reports "unavailable" (a booking is never blocked, no discount is promised),
//  - the document functions throw PromoBackendMissingError so callers show their normal error path
//    and never silently drop or invent a discount.

export type PromoReason = 'unavailable' | 'invalid_code' | 'not_found' | 'expired' | 'not_started' | 'used_up' | 'not_eligible' | 'minimum_not_met';

export interface BookingPromoResult {
  valid: boolean;
  code?: string;
  label?: string;
  estimated_discount_cents?: number;
  reason?: PromoReason;
}

export type PromoDocKind = 'quote' | 'invoice';

export interface AppliedPromo {
  id: string;
  code: string;
  label: string;
  discount_cents: number;
}

export class PromoBackendMissingError extends Error {
  constructor() {
    super('Promo codes are not available in this deployment.');
    this.name = 'PromoBackendMissingError';
  }
}

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

/** Uppercases and trims; returns null when the text cannot be a code (2 to 32 letters, digits, - or _). */
export function normalizePromoCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

export function promoReasonMessage(reason: PromoReason | string | undefined | null): string {
  switch (reason) {
    case 'unavailable': return 'Promo codes are not available right now. You can still book; ask about discounts when we confirm.';
    case 'invalid_code': return 'That does not look like a promo code. Check it and try again.';
    case 'not_found': return 'We could not find that promo code.';
    case 'expired': return 'That promo code has expired.';
    case 'not_started': return 'That promo code is not active yet.';
    case 'used_up': return 'That promo code has already been used the maximum number of times.';
    case 'not_eligible': return 'That promo code does not apply to this booking.';
    case 'minimum_not_met': return 'This booking does not reach the minimum for that promo code.';
    default: return 'That promo code could not be applied.';
  }
}

export async function validateBookingPromo(input: { slug: string; code: string; service?: string; phone?: string; email?: string }): Promise<BookingPromoResult> {
  // A malformed code is rejected locally; anything well-formed cannot be verified without the backend.
  if (!normalizePromoCode(input.code)) return { valid: false, reason: 'invalid_code' };
  return { valid: false, reason: 'unavailable' };
}

export async function fetchAppliedPromos(_kind: PromoDocKind, _docId: string): Promise<AppliedPromo[]> {
  throw new PromoBackendMissingError();
}

export async function applyPromoToDocument(_kind: PromoDocKind, _docId: string, _code: string, _customer: { phone?: string | null; email?: string | null }): Promise<AppliedPromo> {
  throw new PromoBackendMissingError();
}

export async function removePromoFromDocument(_kind: PromoDocKind, _docId: string, _promoId: string): Promise<void> {
  throw new PromoBackendMissingError();
}

/** Re-checks every promo on a saved document against its current total; resolves to the pre-tax discount in cents. */
export async function repriceDocumentPromos(_kind: PromoDocKind, _docId: string): Promise<number> {
  throw new PromoBackendMissingError();
}
