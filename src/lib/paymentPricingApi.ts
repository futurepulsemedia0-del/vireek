import { supabase } from '@/lib/supabase';
import { describePaymentError, type ManualMethod } from '@/lib/inPersonPayments';
import { DEFAULT_PRICING_SETTINGS, settingsFromRow, type PricingSettings } from '@/lib/paymentPricing';

// Every query is scoped by RLS to the ACCOUNT OWNER (get_account_owner_id()), so team members read the
// owner's row. Writes are restricted to account managers in Postgres as well as in the UI.

const COLUMNS =
  'mode, surcharge_bps, flat_fee_cents, cash_discount_bps, exclude_debit, business_state, label, disclosure, compliance_acknowledged_at, updated_at';

export interface LoadedPricing {
  settings: PricingSettings;
  acknowledgedAt: string | null;
  updatedAt: string | null;
}

export async function loadPricingSettings(ownerId: string): Promise<LoadedPricing> {
  const { data, error } = await supabase.from('payment_pricing_settings').select(COLUMNS).eq('user_id', ownerId).maybeSingle();
  if (error) throw error;
  const row = data as unknown as (Record<string, unknown> & { compliance_acknowledged_at?: string | null; updated_at?: string | null }) | null;
  return {
    settings: row ? settingsFromRow(row) : { ...DEFAULT_PRICING_SETTINGS },
    acknowledgedAt: row?.compliance_acknowledged_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export type SavePricingResult = { ok: true } | { ok: false; reason: 'forbidden' | 'invalid' | 'unknown' };

export async function savePricingSettings(ownerId: string, s: PricingSettings, acknowledged: boolean): Promise<SavePricingResult> {
  const { error } = await supabase.from('payment_pricing_settings').upsert(
    {
      user_id: ownerId,
      mode: s.mode,
      surcharge_bps: s.surchargeBps,
      flat_fee_cents: s.flatFeeCents,
      cash_discount_bps: s.cashDiscountBps,
      exclude_debit: s.excludeDebit,
      business_state: s.businessState,
      label: s.label.trim(),
      disclosure: s.disclosure.trim(),
      // The server stamps the real time; this only says "acknowledged or not".
      compliance_acknowledged_at: acknowledged ? new Date().toISOString() : null,
    },
    { onConflict: 'user_id' },
  );
  if (!error) return { ok: true };
  if (error.code === '42501') return { ok: false, reason: 'forbidden' };
  if (error.code === '23514') return { ok: false, reason: 'invalid' };
  return { ok: false, reason: 'unknown' };
}

/** What a technician needs to offer the cash price: null when dual pricing is off. RLS limits the read to the caller's own account. */
export async function fetchCashDiscountOffer(): Promise<{ bps: number } | null> {
  const { data, error } = await supabase.from('payment_pricing_settings').select('mode, cash_discount_bps').maybeSingle();
  if (error || !data) return null;
  const row = data as { mode: string; cash_discount_bps: number };
  return row.mode === 'cash_discount' && row.cash_discount_bps > 0 ? { bps: row.cash_discount_bps } : null;
}

const DISCOUNT_ERRORS: Record<string, string> = {
  discount_not_enabled: 'The cash discount was turned off. Close this and record the payment again.',
  discount_changed: 'The cash discount changed while you were working. Close this and open it again.',
  discount_too_small: 'This amount is too small for a cash discount.',
  invalid_request: 'Something went wrong. Please try again.',
};

export function describeDiscountError(code: string | undefined): string {
  return (code && DISCOUNT_ERRORS[code]) || describePaymentError(code);
}

export interface DiscountedPaymentInput {
  jobId: string;
  method: ManualMethod;
  settledCents: number;
  expectedDiscountCents: number;
  clientRequestId: string;
  tenderedCents?: number;
  checkNumber?: string;
  checkBank?: string;
  checkPayer?: string;
  checkDate?: string;
  note?: string;
}

export interface DiscountedPaymentResult {
  success: boolean;
  error?: string;
  payment_id?: string;
  balance_cents?: number;
  duplicate?: boolean;
  discount_cents?: number;
  cash_cents?: number;
  invoice_gate_blocked?: boolean;
  invoice_gate_message?: string | null;
  warning?: string | null;
}

export async function recordDiscountedPayment(input: DiscountedPaymentInput): Promise<DiscountedPaymentResult> {
  const { data, error } = await supabase.rpc('record_discounted_manual_payment', {
    p_job_id: input.jobId,
    p_method: input.method,
    p_settled_cents: input.settledCents,
    p_expected_discount_cents: input.expectedDiscountCents,
    p_client_request_id: input.clientRequestId,
    p_tendered_cents: input.tenderedCents ?? null,
    p_check_number: input.checkNumber ?? null,
    p_check_bank: input.checkBank ?? null,
    p_check_payer: input.checkPayer ?? null,
    p_note: input.note ?? null,
    p_check_date: input.checkDate ?? null,
  });
  if (error) throw error;
  return data as DiscountedPaymentResult;
}

export interface PricingLedger {
  fees: Array<{
    payment_request_id: string;
    paid_at: string | null;
    fee_cents: number;
    refunded_cents: number;
    label: string | null;
    mode: string | null;
    method_type: string | null;
    funding: string | null;
    refund_reason: string | null;
  }>;
  discounts: Array<{ id: string; created_at: string; amount_cents: number; discount_bps: number; settled_cents: number; reversed: boolean }>;
}

export async function fetchJobPricingLedger(jobId: string): Promise<PricingLedger> {
  const { data, error } = await supabase.rpc('get_job_pricing_ledger', { p_job_id: jobId });
  if (error) throw error;
  const res = data as (PricingLedger & { error?: string }) | null;
  if (!res || res.error) return { fees: [], discounts: [] };
  return { fees: res.fees ?? [], discounts: res.discounts ?? [] };
}
