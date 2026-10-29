import { supabase } from '@/lib/supabase';

export type EarnRuleKind = 'invoice_paid' | 'job_completed' | 'promo_bonus';
export type LedgerKind = 'earn' | 'redeem' | 'expire' | 'adjust' | 'reverse';

export interface LoyaltyProgram {
  account_owner_id: string;
  enabled: boolean;
  redeem_points_per_dollar: number;
  min_redeem_points: number;
  max_redeem_pct: number;
  expiry_months: number | null;
  member_multiplier: number;
  earn_on_promo_invoices: boolean;
}

export interface EarnRule {
  id: string;
  kind: EarnRuleKind;
  label: string;
  points_per_dollar: number;
  flat_points: number;
  promo_code: string | null;
  min_invoice_cents: number;
  active: boolean;
  created_at: string;
}

export interface LoyaltyAccount {
  id: string;
  customer_id: string;
  balance_points: number;
  lifetime_earned: number;
  lifetime_redeemed: number;
  updated_at: string;
  customers?: { name: string; email: string | null; phone: string | null } | null;
}

export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  points: number;
  balance_after: number;
  invoice_id: string | null;
  note: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface CustomerOverview {
  customer_id: string;
  balance_points: number;
  lifetime_earned: number;
  lifetime_redeemed: number;
  expiring_30d: number;
  next_expiry: string | null;
}

export interface InvoiceContext {
  enabled: boolean;
  customer_id?: string | null;
  customer_name?: string;
  balance_points?: number;
  remaining_due_cents?: number;
  max_redeem_cents?: number;
  max_redeem_points?: number;
  redeem_points_per_dollar?: number;
  min_redeem_points?: number;
  max_redeem_pct?: number;
}

export interface RedeemResult {
  applied_points: number;
  applied_cents: number;
  balance_points: number;
  remaining_due_cents: number;
  invoice_paid: boolean;
  duplicate: boolean;
}

export const DEFAULT_PROGRAM: Omit<LoyaltyProgram, 'account_owner_id'> = {
  enabled: false,
  redeem_points_per_dollar: 100,
  min_redeem_points: 100,
  max_redeem_pct: 100,
  expiry_months: 12,
  member_multiplier: 1,
  earn_on_promo_invoices: true,
};

export const RULE_LABELS: Record<EarnRuleKind, string> = {
  invoice_paid: 'Paid invoice',
  job_completed: 'Completed job',
  promo_bonus: 'Promo code bonus',
};

export const LEDGER_LABELS: Record<LedgerKind, string> = {
  earn: 'Earned',
  redeem: 'Redeemed',
  expire: 'Expired',
  adjust: 'Adjustment',
  reverse: 'Reversed',
};

export const MAX_POINTS = 1_000_000;

// ============================================================
// PURE HELPERS (mirror the SQL rules; unit-tested)
// ============================================================

/** Value of points in cents (floored) at a redeem rate of `pointsPerDollar` points = $1. */
export function pointsToCents(points: number, pointsPerDollar: number): number {
  if (!Number.isFinite(points) || points <= 0 || pointsPerDollar <= 0) return 0;
  return Math.floor((Math.floor(points) * 100) / pointsPerDollar);
}

/** Fewest points that cover `cents` (rounded up). */
export function centsToPoints(cents: number, pointsPerDollar: number): number {
  if (!Number.isFinite(cents) || cents <= 0 || pointsPerDollar <= 0) return 0;
  return Math.ceil((Math.floor(cents) * pointsPerDollar) / 100);
}

export interface RedeemLimits {
  balancePoints: number;
  remainingDueCents: number;
  invoiceTotalCents: number;
  alreadyRedeemedCents: number;
  maxPct: number;
  pointsPerDollar: number;
}

/** The most cents / points that can be applied to an invoice right now. Never exceeds balance, amount due or the % cap. */
export function maxRedeemable(l: RedeemLimits): { cents: number; points: number } {
  const cap = Math.floor((l.invoiceTotalCents * l.maxPct) / 100) - l.alreadyRedeemedCents;
  const byBalance = pointsToCents(l.balancePoints, l.pointsPerDollar);
  const cents = Math.max(Math.min(l.remainingDueCents, cap, byBalance), 0);
  return { cents, points: Math.min(centsToPoints(cents, l.pointsPerDollar), Math.max(l.balancePoints, 0)) };
}

/** Points a payment would earn: floor(dollars x rate x multiplier) + floor(flat x multiplier), capped. */
export function estimateEarn(input: { baseCents: number; pointsPerDollar: number; flatPoints?: number; multiplier?: number }): number {
  const mult = input.multiplier && input.multiplier > 1 ? input.multiplier : 1;
  const base = Math.max(input.baseCents, 0);
  const pts = Math.floor((base / 100) * input.pointsPerDollar * mult) + Math.floor((input.flatPoints ?? 0) * mult);
  return Math.min(pts, MAX_POINTS);
}

/** Parses "250" / "1,250" into a positive whole number of points, or null. */
export function parsePoints(input: string): number | null {
  const cleaned = input.replace(/[,\s]/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_POINTS ? n : null;
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function summarizeAccounts(accounts: Pick<LoyaltyAccount, 'balance_points' | 'lifetime_earned' | 'lifetime_redeemed'>[]) {
  return accounts.reduce(
    (s, a) => ({
      outstandingPoints: s.outstandingPoints + a.balance_points,
      earnedPoints: s.earnedPoints + a.lifetime_earned,
      redeemedPoints: s.redeemedPoints + a.lifetime_redeemed,
      members: s.members + (a.balance_points > 0 ? 1 : 0),
    }),
    { outstandingPoints: 0, earnedPoints: 0, redeemedPoints: 0, members: 0 },
  );
}

// ============================================================
// DATA ACCESS - reads go through RLS; every write is a server-side RPC
// ============================================================

export async function fetchProgram(): Promise<Omit<LoyaltyProgram, 'account_owner_id'>> {
  const { data, error } = await supabase.from('lpts_programs').select('*').maybeSingle();
  if (error) throw error;
  return (data as LoyaltyProgram | null) ?? DEFAULT_PROGRAM;
}

export async function saveProgram(p: Omit<LoyaltyProgram, 'account_owner_id'>): Promise<void> {
  const { error } = await supabase.rpc('save_lpts_program', {
    p_enabled: p.enabled,
    p_redeem_points_per_dollar: p.redeem_points_per_dollar,
    p_min_redeem_points: p.min_redeem_points,
    p_max_redeem_pct: p.max_redeem_pct,
    p_expiry_months: p.expiry_months,
    p_member_multiplier: p.member_multiplier,
    p_earn_on_promo_invoices: p.earn_on_promo_invoices,
  });
  if (error) throw new Error(error.message);
}

export async function fetchRules(): Promise<EarnRule[]> {
  const { data, error } = await supabase.from('lpts_earn_rules').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return (data as EarnRule[]) ?? [];
}

export async function saveRule(r: {
  id?: string | null;
  kind: EarnRuleKind;
  label: string;
  pointsPerDollar: number;
  flatPoints: number;
  promoCode?: string | null;
  minInvoiceCents: number;
  active: boolean;
}): Promise<void> {
  const { error } = await supabase.rpc('save_lpts_rule', {
    p_id: r.id ?? null,
    p_kind: r.kind,
    p_label: r.label,
    p_points_per_dollar: r.pointsPerDollar,
    p_flat_points: r.flatPoints,
    p_promo_code: r.promoCode ?? null,
    p_min_invoice_cents: r.minInvoiceCents,
    p_active: r.active,
  });
  if (error) throw new Error(error.message);
}

export async function fetchAccounts(): Promise<LoyaltyAccount[]> {
  const { data, error } = await supabase
    .from('lpts_accounts')
    .select('id, customer_id, balance_points, lifetime_earned, lifetime_redeemed, updated_at, customers(name, email, phone)')
    .order('balance_points', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data as unknown as LoyaltyAccount[]) ?? [];
}

export async function fetchLedger(accountId: string): Promise<LedgerEntry[]> {
  const { data, error } = await supabase
    .from('lpts_ledger')
    .select('id, kind, points, balance_after, invoice_id, note, expires_at, created_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data as LedgerEntry[]) ?? [];
}

export async function fetchCustomerOverview(customerId: string): Promise<CustomerOverview> {
  const { data, error } = await supabase.rpc('lpts_customer_overview', { p_customer_id: customerId });
  if (error) throw new Error(error.message);
  return data as CustomerOverview;
}

export async function fetchInvoiceContext(invoiceId: string): Promise<InvoiceContext> {
  const { data, error } = await supabase.rpc('lpts_invoice_context', { p_invoice_id: invoiceId });
  if (error) throw new Error(error.message);
  return data as InvoiceContext;
}

export async function redeemPoints(input: { customerId: string; invoiceId: string; points: number; idempotencyKey: string }): Promise<RedeemResult> {
  const { data, error } = await supabase.rpc('redeem_lpts_points', {
    p_customer_id: input.customerId,
    p_invoice_id: input.invoiceId,
    p_points: input.points,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw new Error(error.message);
  return data as RedeemResult;
}

export async function adjustPoints(input: { customerId: string; points: number; note: string; idempotencyKey?: string }): Promise<void> {
  const { error } = await supabase.rpc('adjust_lpts_points', {
    p_customer_id: input.customerId,
    p_points: input.points,
    p_note: input.note,
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (error) throw new Error(error.message);
}

export async function searchCustomers(q: string): Promise<{ id: string; name: string; email: string | null }[]> {
  const term = q.trim().replace(/[%,()]/g, ' ');
  if (term.length < 2) return [];
  const { data, error } = await supabase
    .from('customers')
    .select('id, name, email')
    .or(`name.ilike.%${term}%,email.ilike.%${term}%`)
    .limit(8);
  if (error) throw error;
  return (data as { id: string; name: string; email: string | null }[]) ?? [];
}
