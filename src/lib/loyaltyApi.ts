/**
 * Loyalty program — data access.
 * Config reads/writes are scoped by user_id = accountOwnerId AND protected by RLS (managers write). Points,
 * redemptions and the ledger change ONLY through SECURITY DEFINER RPCs, so the database enforces every rule.
 */

import { supabase } from '@/lib/supabase';
import {
  EMPTY_OVERVIEW,
  type EarnRule,
  type LedgerEntry,
  type LoyaltyOverview,
  type LoyaltyReward,
  type LoyaltySettings,
  type LoyaltyTier,
  type MemberSummary,
  type PortalLoyalty,
  type RedemptionDetail,
  type RedemptionStatus,
  type earnRuleToPayload,
  type rewardToPayload,
  type tierToPayload,
} from '@/lib/loyalty';

interface PgError {
  code?: string;
  message: string;
}

function toError(error: PgError, fallback: string): Error {
  if (error.code === '42501' && /row-level security/i.test(error.message)) {
    return new Error("You don't have permission to do that.");
  }
  if (error.code === '23505') return new Error('That name or number is already in use.');
  // Our RPCs and guard triggers raise user-safe messages with these codes.
  if (['42501', '22023', '54000', 'P0002'].includes(error.code ?? '')) return new Error(error.message);
  return new Error(fallback);
}

const num = (v: unknown): number => Number(v ?? 0);

const SETTINGS_COLUMNS = 'user_id, is_enabled, program_name, points_label, portal_redemption_enabled';
const TIER_COLUMNS = 'id, name, min_lifetime_points, earn_multiplier, perks';
const RULE_COLUMNS = 'id, name, kind, points_value, service_type, min_invoice_amount, is_active';
const REWARD_COLUMNS = 'id, name, description, points_cost, reward_type, reward_value, is_active';
const MEMBER_COLUMNS =
  'customer_id, name, phone, email, points_balance, lifetime_points, tier_id, tier_name, earn_multiplier, last_activity_at';
const REDEMPTION_COLUMNS =
  'id, customer_id, customer_name, customer_phone, reward_name, reward_type, reward_value, points_cost, code, status, requested_via, note, created_at, fulfilled_at, cancelled_at';

const mapTier = (r: Record<string, unknown>): LoyaltyTier => ({
  ...(r as unknown as LoyaltyTier),
  min_lifetime_points: num(r.min_lifetime_points),
  earn_multiplier: num(r.earn_multiplier),
});
const mapRule = (r: Record<string, unknown>): EarnRule => ({
  ...(r as unknown as EarnRule),
  points_value: num(r.points_value),
  min_invoice_amount: num(r.min_invoice_amount),
});
const mapReward = (r: Record<string, unknown>): LoyaltyReward => ({
  ...(r as unknown as LoyaltyReward),
  points_cost: num(r.points_cost),
  reward_value: r.reward_value == null ? null : num(r.reward_value),
});
const mapMember = (r: Record<string, unknown>): MemberSummary => ({
  ...(r as unknown as MemberSummary),
  points_balance: num(r.points_balance),
  lifetime_points: num(r.lifetime_points),
  earn_multiplier: r.earn_multiplier == null ? null : num(r.earn_multiplier),
});
const mapRedemption = (r: Record<string, unknown>): RedemptionDetail => ({
  ...(r as unknown as RedemptionDetail),
  points_cost: num(r.points_cost),
  reward_value: r.reward_value == null ? null : num(r.reward_value),
});

// ---------- settings ----------

export async function fetchSettings(ownerId: string): Promise<LoyaltySettings | null> {
  const { data, error } = await supabase.from('loyalty_settings').select(SETTINGS_COLUMNS).eq('user_id', ownerId).maybeSingle();
  if (error) throw toError(error, 'Could not load the program settings.');
  return (data as LoyaltySettings | null) ?? null;
}

export async function saveSettings(
  ownerId: string,
  values: { is_enabled: boolean; program_name: string; points_label: string; portal_redemption_enabled: boolean },
): Promise<LoyaltySettings> {
  const { data, error } = await supabase
    .from('loyalty_settings')
    .upsert(
      {
        user_id: ownerId,
        is_enabled: values.is_enabled,
        program_name: values.program_name.trim(),
        points_label: values.points_label.trim(),
        portal_redemption_enabled: values.portal_redemption_enabled,
      },
      { onConflict: 'user_id' },
    )
    .select(SETTINGS_COLUMNS)
    .single();
  if (error) throw toError(error, 'Could not save the program settings.');
  return data as LoyaltySettings;
}

// ---------- tiers ----------

export async function fetchTiers(ownerId: string): Promise<LoyaltyTier[]> {
  const { data, error } = await supabase
    .from('loyalty_tiers')
    .select(TIER_COLUMNS)
    .eq('user_id', ownerId)
    .order('min_lifetime_points', { ascending: true });
  if (error) throw toError(error, 'Could not load tiers.');
  return ((data as Record<string, unknown>[]) ?? []).map(mapTier);
}

export async function createTier(ownerId: string, payload: ReturnType<typeof tierToPayload>): Promise<void> {
  const { error } = await supabase.from('loyalty_tiers').insert({ ...payload, user_id: ownerId });
  if (error) throw toError(error, 'Could not create the tier.');
}

export async function updateTier(ownerId: string, id: string, payload: ReturnType<typeof tierToPayload>): Promise<void> {
  const { error } = await supabase.from('loyalty_tiers').update(payload).eq('id', id).eq('user_id', ownerId);
  if (error) throw toError(error, 'Could not update the tier.');
}

export async function deleteTier(ownerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('loyalty_tiers').delete().eq('id', id).eq('user_id', ownerId);
  if (error) throw toError(error, 'Could not delete the tier.');
}

// ---------- earn rules ----------

export async function fetchEarnRules(ownerId: string): Promise<EarnRule[]> {
  const { data, error } = await supabase
    .from('loyalty_earn_rules')
    .select(RULE_COLUMNS)
    .eq('user_id', ownerId)
    .order('created_at', { ascending: true });
  if (error) throw toError(error, 'Could not load earn rules.');
  return ((data as Record<string, unknown>[]) ?? []).map(mapRule);
}

export async function createEarnRule(ownerId: string, payload: ReturnType<typeof earnRuleToPayload>): Promise<void> {
  const { error } = await supabase.from('loyalty_earn_rules').insert({ ...payload, user_id: ownerId });
  if (error) throw toError(error, 'Could not create the earn rule.');
}

export async function updateEarnRule(ownerId: string, id: string, payload: ReturnType<typeof earnRuleToPayload>): Promise<void> {
  const { error } = await supabase.from('loyalty_earn_rules').update(payload).eq('id', id).eq('user_id', ownerId);
  if (error) throw toError(error, 'Could not update the earn rule.');
}

export async function deleteEarnRule(ownerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('loyalty_earn_rules').delete().eq('id', id).eq('user_id', ownerId);
  if (error) throw toError(error, 'Could not delete the earn rule.');
}

// ---------- rewards ----------

export async function fetchRewards(ownerId: string): Promise<LoyaltyReward[]> {
  const { data, error } = await supabase
    .from('loyalty_rewards')
    .select(REWARD_COLUMNS)
    .eq('user_id', ownerId)
    .order('points_cost', { ascending: true });
  if (error) throw toError(error, 'Could not load rewards.');
  return ((data as Record<string, unknown>[]) ?? []).map(mapReward);
}

export async function createReward(ownerId: string, payload: ReturnType<typeof rewardToPayload>): Promise<void> {
  const { error } = await supabase.from('loyalty_rewards').insert({ ...payload, user_id: ownerId });
  if (error) throw toError(error, 'Could not create the reward.');
}

export async function updateReward(ownerId: string, id: string, payload: ReturnType<typeof rewardToPayload>): Promise<void> {
  const { error } = await supabase.from('loyalty_rewards').update(payload).eq('id', id).eq('user_id', ownerId);
  if (error) throw toError(error, 'Could not update the reward.');
}

export async function deleteReward(ownerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('loyalty_rewards').delete().eq('id', id).eq('user_id', ownerId);
  if (error) throw toError(error, 'Could not delete the reward.');
}

// ---------- members, ledger, redemptions ----------

export async function fetchOverview(): Promise<LoyaltyOverview> {
  const { data, error } = await supabase.rpc('loyalty_overview');
  if (error) throw toError(error, 'Could not load program totals.');
  const o = (data ?? {}) as Record<string, unknown>;
  return {
    ...EMPTY_OVERVIEW,
    members: num(o.members),
    outstanding_points: num(o.outstanding_points),
    issued_30d: num(o.issued_30d),
    redeemed_30d: num(o.redeemed_30d),
    pending_redemptions: num(o.pending_redemptions),
  };
}

export async function fetchMembers(ownerId: string): Promise<MemberSummary[]> {
  const { data, error } = await supabase
    .from('loyalty_member_summary')
    .select(MEMBER_COLUMNS)
    .eq('user_id', ownerId)
    .order('points_balance', { ascending: false })
    .limit(1000);
  if (error) throw toError(error, 'Could not load members.');
  return ((data as Record<string, unknown>[]) ?? []).map(mapMember);
}

export async function fetchLedger(ownerId: string, customerId: string): Promise<LedgerEntry[]> {
  const { data, error } = await supabase
    .from('loyalty_ledger')
    .select('id, entry_type, points, note, job_id, created_at')
    .eq('user_id', ownerId)
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw toError(error, 'Could not load the points history.');
  return ((data as Record<string, unknown>[]) ?? []).map((r) => ({ ...(r as unknown as LedgerEntry), points: num(r.points) }));
}

export async function fetchRedemptions(ownerId: string): Promise<RedemptionDetail[]> {
  const { data, error } = await supabase
    .from('loyalty_redemption_details')
    .select(REDEMPTION_COLUMNS)
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw toError(error, 'Could not load redemptions.');
  return ((data as Record<string, unknown>[]) ?? []).map(mapRedemption);
}

export async function adjustPoints(customerId: string, points: number, note: string): Promise<number> {
  const { data, error } = await supabase.rpc('loyalty_adjust_points', { p_customer_id: customerId, p_points: points, p_note: note.trim() });
  if (error) throw toError(error, 'Could not adjust the points.');
  return num(data);
}

export async function redeemForCustomer(customerId: string, rewardId: string): Promise<{ code: string; reward_name: string; balance: number }> {
  const { data, error } = await supabase.rpc('loyalty_redeem_for_customer', { p_customer_id: customerId, p_reward_id: rewardId });
  if (error) throw toError(error, 'Could not redeem the reward.');
  const d = (data ?? {}) as Record<string, unknown>;
  return { code: String(d.code ?? ''), reward_name: String(d.reward_name ?? ''), balance: num(d.balance) };
}

export async function setRedemptionStatus(id: string, status: Exclude<RedemptionStatus, 'pending'>, note?: string): Promise<void> {
  const { error } = await supabase.rpc('loyalty_set_redemption_status', { p_redemption_id: id, p_status: status, p_note: note?.trim() || null });
  if (error) throw toError(error, 'Could not update the redemption.');
}

export async function backfillPaidJobs(): Promise<number> {
  const { error, data } = await supabase.rpc('loyalty_backfill_paid_jobs');
  if (error) throw toError(error, 'Could not award points for past jobs.');
  return num(data);
}

// ---------- customer portal (token-validated) ----------

export async function fetchPortalLoyalty(portalToken: string): Promise<PortalLoyalty | null> {
  const { data, error } = await supabase.rpc('get_portal_loyalty', { p_portal_token: portalToken });
  if (error) throw toError(error, 'Could not load your rewards.');
  return (data as PortalLoyalty | null) ?? null;
}

export async function redeemPortalReward(portalToken: string, rewardId: string): Promise<{ code: string; reward_name: string; balance: number }> {
  const { data, error } = await supabase.rpc('portal_redeem_loyalty', { p_portal_token: portalToken, p_reward_id: rewardId });
  if (error) throw toError(error, 'Could not redeem this reward. Please try again.');
  const d = (data ?? {}) as Record<string, unknown>;
  return { code: String(d.code ?? ''), reward_name: String(d.reward_name ?? ''), balance: num(d.balance) };
}
