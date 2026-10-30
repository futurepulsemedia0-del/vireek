import { supabase } from '@/lib/supabase';

export type InstantPayoutStatus = 'pending' | 'in_transit' | 'paid' | 'failed' | 'canceled';

export type IneligibleReason =
  | 'forbidden'
  | 'not_connected'
  | 'onboarding_incomplete'
  | 'payouts_disabled'
  | 'open_dispute'
  | 'account_too_new'
  | 'no_instant_destination'
  | 'no_instant_balance';

export interface InstantPayout {
  id: string;
  amount_cents: number;
  fee_cents: number;
  currency: string;
  destination_label: string | null;
  status: InstantPayoutStatus;
  stripe_payout_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  arrival_date: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface InstantPayoutPricing {
  feeBps: number;
  feeMinCents: number;
  feeMaxCents: number | null;
  minPayoutCents: number;
  maxPayoutCents: number;
}

export interface InstantPayoutEligibility {
  eligible: boolean;
  reason: IneligibleReason | null;
  message: string | null;
  destination: { id: string; label: string } | null;
  /** Total instant balance (before fee). */
  availableCents: number;
  /** Largest payout possible right now (after fee). */
  maxPayoutCents: number;
  pricing: InstantPayoutPricing;
  recent: InstantPayout[];
}

export interface InstantPayoutOutcome {
  payout: InstantPayout;
  warning: 'status_unknown' | null;
  message: string | null;
}

export class InstantPayoutError extends Error {
  status?: number;
  code?: string;
  /** Fresh fee from the server when the quote changed under the user. */
  feeCents?: number;
  maxPayoutCents?: number;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'InstantPayoutError';
    this.status = status;
    this.code = code;
  }
}

/** Mirrors quoteFee() in supabase/functions/_shared/instantPayouts/logic.ts (a parity test keeps them identical). */
export function quoteInstantPayoutFee(
  amountCents: number,
  pricing: Pick<InstantPayoutPricing, 'feeBps' | 'feeMinCents' | 'feeMaxCents'>,
): number {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0;
  if (pricing.feeBps <= 0 && pricing.feeMinCents <= 0) return 0;
  let fee = Math.round((amountCents * pricing.feeBps) / 10_000);
  fee = Math.max(fee, pricing.feeMinCents);
  if (pricing.feeMaxCents !== null) fee = Math.min(fee, pricing.feeMaxCents);
  return fee;
}

/** "1% (min $0.50)" style label for the fee schedule. */
export function describeFeeSchedule(pricing: Pick<InstantPayoutPricing, 'feeBps' | 'feeMinCents' | 'feeMaxCents'>): string {
  if (pricing.feeBps <= 0 && pricing.feeMinCents <= 0) return 'No fee';
  const pct = `${(pricing.feeBps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
  const parts = [pct];
  if (pricing.feeMinCents > 0) parts.push(`min ${formatMoney(pricing.feeMinCents)}`);
  if (pricing.feeMaxCents !== null) parts.push(`max ${formatMoney(pricing.feeMaxCents)}`);
  return `${parts[0]}${parts.length > 1 ? ` (${parts.slice(1).join(', ')})` : ''}`;
}

export function formatMoney(cents: number, currency = 'usd'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

/** "1,250.5" / "$1250.50" -> 125050. Returns null for anything that is not a plain amount with at most 2 decimals. */
export function dollarsToCents(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function validateInstantPayoutAmount(cents: number | null, pricing: InstantPayoutPricing, maxPayoutCents: number): string | null {
  if (cents === null) return 'Enter an amount like 250.00';
  if (cents < pricing.minPayoutCents) return `The minimum instant payout is ${formatMoney(pricing.minPayoutCents)}.`;
  if (cents > maxPayoutCents) return `You can pay out up to ${formatMoney(maxPayoutCents)} right now.`;
  return null;
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** supabase.functions.invoke hides the JSON body of non-2xx replies in error.context. */
async function readFunctionError(error: unknown): Promise<InstantPayoutError> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: string; code?: string; fee_cents?: number; max_payout_cents?: number };
      const err = new InstantPayoutError(body?.error || 'The payout could not be processed. Please try again.', ctx.status, body?.code);
      if (typeof body?.fee_cents === 'number') err.feeCents = body.fee_cents;
      if (typeof body?.max_payout_cents === 'number') err.maxPayoutCents = body.max_payout_cents;
      return err;
    } catch {
      return new InstantPayoutError('The payout could not be processed. Please try again.', ctx.status);
    }
  }
  return new InstantPayoutError('Could not reach the server. Check your connection and retry — retrying is safe.');
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('instant-payouts', { body });
  if (error) throw await readFunctionError(error);
  return data as T;
}

export function fetchInstantPayoutEligibility(): Promise<InstantPayoutEligibility> {
  return invoke<InstantPayoutEligibility>({ action: 'eligibility' });
}

export async function requestInstantPayout(input: {
  amountCents: number;
  expectedFeeCents: number;
  idempotencyKey: string;
}): Promise<InstantPayoutOutcome> {
  const d = await invoke<Partial<InstantPayoutOutcome> | null>({
    action: 'request',
    amount_cents: input.amountCents,
    expected_fee_cents: input.expectedFeeCents,
    idempotency_key: input.idempotencyKey,
  });
  if (!d?.payout) throw new InstantPayoutError('Unexpected response from the server.');
  return { payout: d.payout, warning: d.warning ?? null, message: d.message ?? null };
}

export async function resumeInstantPayout(payoutId: string): Promise<InstantPayoutOutcome> {
  const d = await invoke<Partial<InstantPayoutOutcome> | null>({ action: 'resume', payout_id: payoutId });
  if (!d?.payout) throw new InstantPayoutError('Unexpected response from the server.');
  return { payout: d.payout, warning: d.warning ?? null, message: d.message ?? null };
}

/** One-time link into the Stripe Express dashboard (add a debit card, fix verification). */
export async function fetchPayoutMethodsLink(): Promise<string> {
  const d = await invoke<{ url?: string } | null>({ action: 'dashboard_link' });
  if (!d?.url) throw new InstantPayoutError('Could not open your Stripe dashboard.');
  return d.url;
}

export const INSTANT_PAYOUT_STATUS_META: Record<InstantPayoutStatus, { label: string; tone: 'neutral' | 'accent' | 'success' | 'danger' }> = {
  pending: { label: 'Processing', tone: 'neutral' },
  in_transit: { label: 'On its way', tone: 'accent' },
  paid: { label: 'Paid', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};
