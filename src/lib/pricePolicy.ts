// src/lib/pricePolicy.ts
//
// Client-side model for Price-First Playbook policies: form state, validation, payload mapping and
// the live preview. The decision logic itself lives in the shared engine
// (supabase/functions/_shared/price-playbook/engine.ts) so the dashboard preview, the voice tool and
// the SMS/web auto-reply can never disagree about what Sarah may say.
// Validation errors are CODES (translated by the page), never English sentences.

import {
  applyPriceBookAmounts,
  auditReply,
  composeFirstReply,
  type FirstReply,
  type PriceBookLite,
  type PriceMode,
  type PricePolicy,
  type Trade,
  type ValueProps,
  type Violation,
} from '../../supabase/functions/_shared/price-playbook/engine';

export type { PriceMode, Trade, ValueProps, Violation };

export const PRICE_MODES: readonly PriceMode[] = ['exact_flat', 'range', 'starting_at', 'diagnostic_fee_only', 'needs_visit'];
export const TRADES: readonly Trade[] = ['hvac', 'plumbing', 'electrical', 'appliance', 'roofing', 'general'];
export const US_STATE_CODES: readonly string[] = (
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND ' +
  'OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'
).split(' ');

export interface PricePolicyRecord {
  id: string;
  user_id: string;
  service_key: string;
  display_name: string;
  trade: Trade;
  mode: PriceMode;
  source_kind: 'price_book' | 'owner_entered';
  price_book_item_id: string | null;
  keywords: string[];
  amount_low_cents: number | null;
  amount_high_cents: number | null;
  diagnostic_fee_cents: number | null;
  fee_credited_on_repair: boolean;
  written_price_before_work: boolean;
  includes: string[];
  changes_price: string[];
  verified_at: string;
  approved_states: string[];
  legal_review_status: 'pending' | 'approved';
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PricePolicyForm {
  display_name: string;
  trade: Trade;
  mode: PriceMode;
  source_kind: 'price_book' | 'owner_entered';
  price_book_item_id: string;
  keywords: string;
  low: string;
  high: string;
  fee: string;
  fee_credited_on_repair: boolean;
  written_price_before_work: boolean;
  includes: string;
  changes_price: string;
  approved_states: string;
  legal_review_status: 'pending' | 'approved';
  active: boolean;
}

export const EMPTY_POLICY_FORM: PricePolicyForm = {
  display_name: '',
  trade: 'general',
  mode: 'needs_visit',
  source_kind: 'owner_entered',
  price_book_item_id: '',
  keywords: '',
  low: '',
  high: '',
  fee: '',
  fee_credited_on_repair: false,
  written_price_before_work: false,
  includes: '',
  changes_price: '',
  approved_states: '',
  legal_review_status: 'pending',
  active: true,
};

export type PolicyFormErrorCode =
  | 'name_required'
  | 'amount_invalid'
  | 'range_order'
  | 'fee_invalid'
  | 'book_item_required'
  | 'states_invalid'
  | 'approval_needs_states';

export class PricePolicyFormError extends Error {
  readonly code: PolicyFormErrorCode;
  constructor(code: PolicyFormErrorCode) {
    super(code);
    this.name = 'PricePolicyFormError';
    this.code = code;
  }
}

const centsFrom = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
};
const toDollars = (c: number | null): string => (c == null ? '' : String(c / 100));
const lines = (s: string): string[] => s.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 12);
const commaList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);

export function slugifyServiceKey(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return slug || 'service';
}

/** "tx, CA" -> ["TX","CA"]; throws when any token is not a US state code. */
export function parseStates(input: string): string[] {
  const tokens = input.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
  const unique = [...new Set(tokens)];
  if (unique.some((t) => !US_STATE_CODES.includes(t))) throw new PricePolicyFormError('states_invalid');
  return unique;
}

export function recordToForm(r: PricePolicyRecord): PricePolicyForm {
  return {
    display_name: r.display_name,
    trade: r.trade,
    mode: r.mode,
    source_kind: r.source_kind,
    price_book_item_id: r.price_book_item_id ?? '',
    keywords: r.keywords.join(', '),
    low: toDollars(r.amount_low_cents),
    high: toDollars(r.amount_high_cents),
    fee: toDollars(r.diagnostic_fee_cents),
    fee_credited_on_repair: r.fee_credited_on_repair,
    written_price_before_work: r.written_price_before_work,
    includes: r.includes.join('\n'),
    changes_price: r.changes_price.join('\n'),
    approved_states: r.approved_states.join(', '),
    legal_review_status: r.legal_review_status,
    active: r.active,
  };
}

export type PricePolicyPayload = Omit<PricePolicyRecord, 'id' | 'created_at' | 'updated_at'>;

/** Throws PricePolicyFormError. `verified_at` is stamped by the caller on every save (owner re-verified the figures). */
export function formToPayload(form: PricePolicyForm, userId: string, verifiedAtIso: string): PricePolicyPayload {
  const name = form.display_name.trim();
  if (!name) throw new PricePolicyFormError('name_required');

  const states = parseStates(form.approved_states);
  if (form.legal_review_status === 'approved' && states.length === 0) throw new PricePolicyFormError('approval_needs_states');

  const fromBook = form.source_kind === 'price_book';
  if (fromBook && !form.price_book_item_id) throw new PricePolicyFormError('book_item_required');

  let low: number | null = null;
  let high: number | null = null;
  let fee: number | null = null;

  if (!fromBook && (form.mode === 'exact_flat' || form.mode === 'starting_at' || form.mode === 'range')) {
    low = centsFrom(form.low);
    if (low == null || Number.isNaN(low) || low <= 0) throw new PricePolicyFormError('amount_invalid');
    if (form.mode === 'range') {
      high = centsFrom(form.high);
      if (high == null || Number.isNaN(high) || high <= 0) throw new PricePolicyFormError('amount_invalid');
      if (high < low) throw new PricePolicyFormError('range_order');
    }
  }
  if (form.mode === 'diagnostic_fee_only' || form.fee.trim()) {
    fee = centsFrom(form.fee);
    if (fee == null || Number.isNaN(fee) || fee <= 0) throw new PricePolicyFormError('fee_invalid');
  }
  if (form.mode === 'needs_visit') fee = fee && fee > 0 ? fee : null;

  return {
    user_id: userId,
    service_key: slugifyServiceKey(name),
    display_name: name.slice(0, 120),
    trade: form.trade,
    mode: form.mode,
    source_kind: form.source_kind,
    price_book_item_id: fromBook ? form.price_book_item_id : null,
    keywords: commaList(form.keywords),
    amount_low_cents: low,
    amount_high_cents: high,
    diagnostic_fee_cents: fee,
    fee_credited_on_repair: form.fee_credited_on_repair,
    written_price_before_work: form.written_price_before_work,
    includes: lines(form.includes),
    changes_price: lines(form.changes_price),
    verified_at: verifiedAtIso,
    approved_states: states,
    legal_review_status: form.legal_review_status,
    active: form.active,
  };
}

// ---------------------------------------------------------------------------
// Live preview: exactly what the engine would let Sarah say, for a chosen state.
// ---------------------------------------------------------------------------

export interface PolicyPreview {
  reply: FirstReply;
  violations: Violation[];
  sourceLabels: string[];
}

export function previewPolicy(
  payload: PricePolicyPayload,
  bookItem: PriceBookLite | null,
  state: string | null,
  now: Date,
  value: ValueProps,
): PolicyPreview {
  const policy = applyPriceBookAmounts(
    {
      service_key: payload.service_key,
      display_name: payload.display_name,
      trade: payload.trade,
      mode: payload.mode,
      amount_low_cents: payload.amount_low_cents,
      amount_high_cents: payload.amount_high_cents,
      diagnostic_fee_cents: payload.diagnostic_fee_cents,
      fee_credited_on_repair: payload.fee_credited_on_repair,
      written_price_before_work: payload.written_price_before_work,
      includes: payload.includes,
      changes_price: payload.changes_price,
      source: { kind: payload.source_kind, price_book_item_id: payload.price_book_item_id, verified_at: payload.verified_at },
      approved_states: payload.approved_states,
      legal_review_status: payload.legal_review_status,
      active: payload.active,
    } satisfies PricePolicy,
    bookItem,
  );
  const reply = composeFirstReply(policy, { state, now }, 'sms');
  return { reply, violations: auditReply(reply.text, reply.answer, value), sourceLabels: reply.answer.source_labels };
}

export type LegalWarning = 'pending_review' | 'no_states' | 'stale';

export function legalWarnings(r: Pick<PricePolicyRecord, 'legal_review_status' | 'approved_states' | 'verified_at' | 'mode'>, now: Date, maxAgeDays = 180): LegalWarning[] {
  if (r.mode === 'needs_visit') return [];
  const out: LegalWarning[] = [];
  if (r.legal_review_status !== 'approved') out.push('pending_review');
  if (r.approved_states.length === 0) out.push('no_states');
  const t = Date.parse(r.verified_at);
  if (!Number.isFinite(t) || now.getTime() - t > maxAgeDays * 86_400_000) out.push('stale');
  return out;
}
