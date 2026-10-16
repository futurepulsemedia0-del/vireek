/**
 * Referral program - data access.
 * Reads/writes are scoped by user_id = accountOwnerId AND protected by RLS. Payout state changes happen only
 * through the record_referral_payouts / void_referral_payout RPCs (manager-only, enforced in the database).
 */

import { supabase } from '@/lib/supabase';
import { generateReferralCode } from '@/lib/marketing';
import type { ConversionDetail, LeaderboardRow, PayoutMethod, RewardRule, RulePayload } from '@/lib/referrals';

const RULE_COLUMNS =
  'id, user_id, name, reward_type, reward_value, min_invoice_amount, min_conversions, is_active, created_at, updated_at';
const CONVERSION_COLUMNS =
  'id, referral_code_id, code, referrer_customer_id, referrer_name, referred_customer_id, referred_name, status, created_at, converted_at, rewarded_at, reward_type, reward_value, reward_amount, qualifying_amount, payout_id, payout_method, payout_paid_at';

interface PgError {
  code?: string;
  message: string;
}

function toError(error: PgError, fallback: string): Error {
  if (error.code === '42501' && /row-level security/i.test(error.message)) {
    return new Error("You don't have permission to do that.");
  }
  // Our RPCs raise user-safe messages with these codes.
  if (['42501', '22023', '54000', 'P0002'].includes(error.code ?? '')) return new Error(error.message);
  return new Error(fallback);
}

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function mapRule(r: Record<string, unknown>): RewardRule {
  return {
    ...(r as unknown as RewardRule),
    reward_value: num(r.reward_value),
    min_invoice_amount: num(r.min_invoice_amount),
    min_conversions: num(r.min_conversions),
  };
}

// ---------- Leaderboard ----------

export async function fetchLeaderboard(days: number | null): Promise<LeaderboardRow[]> {
  const { data, error } = await supabase.rpc('get_referral_leaderboard', { p_days: days });
  if (error) throw toError(error, 'Could not load the leaderboard.');
  return ((data as Record<string, unknown>[]) ?? []).map((r) => ({
    referral_code_id: String(r.referral_code_id),
    code: String(r.code),
    referrer_customer_id: (r.referrer_customer_id as string | null) ?? null,
    referrer_name: (r.referrer_name as string | null) ?? null,
    clicks: num(r.clicks),
    conversions: num(r.conversions),
    rewarded: num(r.rewarded),
    earned: num(r.earned),
    unpaid: num(r.unpaid),
    last_converted_at: (r.last_converted_at as string | null) ?? null,
  }));
}

// ---------- Rules ----------

export async function fetchRules(ownerId: string): Promise<RewardRule[]> {
  const { data, error } = await supabase
    .from('referral_reward_rules')
    .select(RULE_COLUMNS)
    .eq('user_id', ownerId)
    .order('min_conversions', { ascending: true })
    .order('min_invoice_amount', { ascending: true });
  if (error) throw toError(error, 'Could not load reward rules.');
  return ((data as unknown as Record<string, unknown>[]) ?? []).map(mapRule);
}

export async function createRule(ownerId: string, payload: RulePayload): Promise<RewardRule> {
  const { data, error } = await supabase
    .from('referral_reward_rules')
    .insert({ ...payload, user_id: ownerId })
    .select(RULE_COLUMNS)
    .single();
  if (error) throw toError(error, 'Could not create this rule.');
  return mapRule(data as unknown as Record<string, unknown>);
}

export async function updateRule(ownerId: string, id: string, payload: Partial<RulePayload>): Promise<RewardRule> {
  const { data, error } = await supabase
    .from('referral_reward_rules')
    .update(payload)
    .eq('id', id)
    .eq('user_id', ownerId)
    .select(RULE_COLUMNS)
    .single();
  if (error) throw toError(error, 'Could not update this rule.');
  return mapRule(data as unknown as Record<string, unknown>);
}

export async function deleteRule(ownerId: string, id: string): Promise<void> {
  const { data, error } = await supabase
    .from('referral_reward_rules')
    .delete()
    .eq('id', id)
    .eq('user_id', ownerId)
    .select('id');
  if (error) throw toError(error, 'Could not delete this rule.');
  if (!data || data.length === 0) throw new Error("You don't have permission to delete this rule.");
}

// ---------- Conversions + payouts ----------

export async function fetchConversions(ownerId: string): Promise<ConversionDetail[]> {
  const { data, error } = await supabase
    .from('referral_conversion_details')
    .select(CONVERSION_COLUMNS)
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw toError(error, 'Could not load referral activity.');
  return ((data as unknown as Record<string, unknown>[]) ?? []).map((r) => ({
    ...(r as unknown as ConversionDetail),
    reward_value: numOrNull(r.reward_value),
    reward_amount: numOrNull(r.reward_amount),
    qualifying_amount: numOrNull(r.qualifying_amount),
  }));
}

export async function recordPayouts(conversionIds: string[], method: PayoutMethod, note: string): Promise<number> {
  const { data, error } = await supabase.rpc('record_referral_payouts', {
    p_conversion_ids: conversionIds,
    p_method: method,
    p_note: note.trim() || null,
  });
  if (error) throw toError(error, 'Could not record the payout.');
  return Number(data ?? 0);
}

export async function voidPayout(payoutId: string): Promise<void> {
  const { error } = await supabase.rpc('void_referral_payout', { p_payout_id: payoutId });
  if (error) throw toError(error, 'Could not void this payout.');
}

// ---------- Links ----------

export interface CustomerOption {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

export async function searchCustomers(ownerId: string, term: string): Promise<CustomerOption[]> {
  const escaped = term.trim().replace(/[\\%_]/g, '\\$&');
  const { data, error } = await supabase
    .from('customers')
    .select('id, name, email, phone')
    .eq('user_id', ownerId)
    .ilike('name', `%${escaped}%`)
    .order('name', { ascending: true })
    .limit(8);
  if (error) throw new Error('Could not search customers.');
  return (data as unknown as CustomerOption[]) ?? [];
}

export async function createReferralCode(ownerId: string, customer: { id: string; name: string }): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateReferralCode(customer.name);
    const { error } = await supabase
      .from('referral_codes')
      .insert({ user_id: ownerId, customer_id: customer.id, code });
    if (!error) return code;
    if (error.code !== '23505') throw new Error('Could not create this referral link.');
  }
  throw new Error('Could not generate a unique code. Please try again.');
}
