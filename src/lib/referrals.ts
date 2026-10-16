// ============================================================
// Types
// ============================================================

export type RewardType = 'credit' | 'discount' | 'cash';
export type ConversionStatus = 'pending' | 'converted' | 'rewarded';
export type PayoutMethod =
  | 'account_credit'
  | 'cash'
  | 'check'
  | 'bank_transfer'
  | 'gift_card'
  | 'invoice_discount'
  | 'other';

export interface RewardRule {
  id: string;
  user_id: string;
  name: string;
  reward_type: RewardType;
  reward_value: number;
  min_invoice_amount: number;
  min_conversions: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface LeaderboardRow {
  referral_code_id: string;
  code: string;
  referrer_customer_id: string | null;
  referrer_name: string | null;
  clicks: number;
  conversions: number;
  rewarded: number;
  earned: number;
  unpaid: number;
  last_converted_at: string | null;
}

export interface ConversionDetail {
  id: string;
  referral_code_id: string;
  code: string;
  referrer_customer_id: string | null;
  referrer_name: string | null;
  referred_customer_id: string | null;
  referred_name: string | null;
  status: ConversionStatus;
  created_at: string;
  converted_at: string | null;
  rewarded_at: string | null;
  reward_type: RewardType | null;
  reward_value: number | null;
  reward_amount: number | null;
  qualifying_amount: number | null;
  payout_id: string | null;
  payout_method: PayoutMethod | null;
  payout_paid_at: string | null;
}

// ============================================================
// Labels / options
// ============================================================

export const REWARD_TYPE_LABELS: Record<RewardType, string> = {
  credit: 'Account credit',
  discount: 'Percent discount',
  cash: 'Cash',
};

export const PAYOUT_METHOD_LABELS: Record<PayoutMethod, string> = {
  account_credit: 'Account credit',
  cash: 'Cash',
  check: 'Check',
  bank_transfer: 'Bank transfer',
  gift_card: 'Gift card',
  invoice_discount: 'Discount on next invoice',
  other: 'Other',
};

function toOptions<T extends string>(labels: Record<T, string>): [T, string][] {
  return (Object.keys(labels) as T[]).map((k) => [k, labels[k]]);
}
export const REWARD_TYPE_OPTIONS = toOptions(REWARD_TYPE_LABELS);
export const PAYOUT_METHOD_OPTIONS = toOptions(PAYOUT_METHOD_LABELS);

export type LeaderboardPeriod = 'all' | '7' | '30' | '90';
export const PERIOD_OPTIONS: { key: LeaderboardPeriod; label: string; days: number | null }[] = [
  { key: 'all', label: 'All time', days: null },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '7', label: 'Last 7 days', days: 7 },
];

export const MAX_PAYOUT_BATCH = 100;
export const MAX_RULES = 20;

// ============================================================
// Formatting
// ============================================================

export function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatReward(type: RewardType, value: number): string {
  if (type === 'discount') return `${Number(value.toFixed(2))}% off`;
  return `${formatMoney(value)} ${type === 'credit' ? 'account credit' : 'cash'}`;
}

export function referrerLabel(row: { referrer_name: string | null; code: string }): string {
  return row.referrer_name?.trim() || `Code ${row.code}`;
}

// ============================================================
// Links + sharing
// ============================================================

export function buildReferralLink(origin: string, code: string): string {
  return `${origin.replace(/\/$/, '')}/r/${encodeURIComponent(code)}`;
}

export function shareMessage(link: string, rewardLabel?: string): string {
  const reward = rewardLabel ? ` - you'll get ${rewardLabel} for every friend who becomes a customer` : '';
  return `Here's your personal referral link: ${link}\n\nShare it with friends and family${reward}.`;
}

export const smsHref = (message: string): string => `sms:?&body=${encodeURIComponent(message)}`;
export const mailtoHref = (subject: string, body: string): string =>
  `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
export const whatsappHref = (message: string): string => `https://wa.me/?text=${encodeURIComponent(message)}`;

// ============================================================
// Reward rules
// ============================================================

export interface RuleFormValues {
  name: string;
  rewardType: RewardType;
  rewardValue: string;
  minInvoice: string;
  minConversions: string;
  isActive: boolean;
}
export type RuleErrors = Partial<Record<'name' | 'rewardValue' | 'minInvoice' | 'minConversions', string>>;

export interface RulePayload {
  name: string;
  reward_type: RewardType;
  reward_value: number;
  min_invoice_amount: number;
  min_conversions: number;
  is_active: boolean;
}

export function emptyRuleForm(): RuleFormValues {
  return { name: '', rewardType: 'credit', rewardValue: '', minInvoice: '', minConversions: '', isActive: true };
}

export function ruleToForm(rule: RewardRule): RuleFormValues {
  return {
    name: rule.name,
    rewardType: rule.reward_type,
    rewardValue: String(rule.reward_value),
    minInvoice: rule.min_invoice_amount > 0 ? String(rule.min_invoice_amount) : '',
    minConversions: rule.min_conversions > 0 ? String(rule.min_conversions) : '',
    isActive: rule.is_active,
  };
}

export function parseDecimal(value: string): number | null {
  const cleaned = value.trim().replace(/,/g, '');
  return /^\d{1,8}(\.\d{1,2})?$/.test(cleaned) ? Number(cleaned) : null;
}

export function validateRule(v: RuleFormValues): RuleErrors {
  const e: RuleErrors = {};
  const name = v.name.trim();
  if (name.length < 2 || name.length > 60) e.name = 'Name needs 2 to 60 characters.';
  const value = parseDecimal(v.rewardValue);
  if (value === null || value <= 0) e.rewardValue = 'Enter an amount greater than zero.';
  else if (v.rewardType === 'discount' && value > 100) e.rewardValue = 'A discount cannot exceed 100%.';
  if (v.minInvoice.trim() !== '' && parseDecimal(v.minInvoice) === null) {
    e.minInvoice = 'Enter a dollar amount, or leave it empty.';
  }
  if (v.minConversions.trim() !== '') {
    const n = /^\d{1,4}$/.test(v.minConversions.trim()) ? Number(v.minConversions.trim()) : null;
    if (n === null || n > 1000) e.minConversions = 'Enter a whole number up to 1000, or leave it empty.';
  }
  return e;
}

export function ruleToPayload(v: RuleFormValues): RulePayload {
  return {
    name: v.name.trim(),
    reward_type: v.rewardType,
    reward_value: parseDecimal(v.rewardValue) ?? 0,
    min_invoice_amount: v.minInvoice.trim() === '' ? 0 : (parseDecimal(v.minInvoice) ?? 0),
    min_conversions: v.minConversions.trim() === '' ? 0 : Number(v.minConversions.trim()),
    is_active: v.isActive,
  };
}

/** Mirrors the SQL trigger: the most specific active rule wins. */
export function pickRule<R extends Pick<RewardRule, 'is_active' | 'min_invoice_amount' | 'min_conversions' | 'created_at'>>(
  rules: R[],
  ctx: { amount: number; priorConversions: number },
): R | null {
  const matching = rules
    .filter((r) => r.is_active && r.min_invoice_amount <= ctx.amount && r.min_conversions <= ctx.priorConversions)
    .sort(
      (a, b) =>
        b.min_conversions - a.min_conversions ||
        b.min_invoice_amount - a.min_invoice_amount ||
        (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0),
    );
  return matching[0] ?? null;
}

export function describeRule(
  r: Pick<RewardRule, 'reward_type' | 'reward_value' | 'min_invoice_amount' | 'min_conversions'>,
): string {
  const conditions: string[] = [];
  if (r.min_conversions > 0) conditions.push(`once the referrer has ${r.min_conversions}+ earlier conversions`);
  if (r.min_invoice_amount > 0) conditions.push(`when the referred customer pays ${formatMoney(r.min_invoice_amount)}+`);
  const base = `Converted referrals earn ${formatReward(r.reward_type, r.reward_value)}`;
  return conditions.length ? `${base} ${conditions.join(' and ')}.` : `${base}.`;
}

export function sortRules<R extends Pick<RewardRule, 'min_conversions' | 'min_invoice_amount' | 'created_at'>>(rules: R[]): R[] {
  return [...rules].sort(
    (a, b) =>
      a.min_conversions - b.min_conversions ||
      a.min_invoice_amount - b.min_invoice_amount ||
      (a.created_at < b.created_at ? -1 : 1),
  );
}

// ============================================================
// Leaderboard
// ============================================================

export function conversionRate(clicks: number, conversions: number): number | null {
  if (clicks <= 0) return null;
  return Math.min(100, Math.round((conversions / clicks) * 1000) / 10);
}

export interface RankedRow extends LeaderboardRow {
  rank: number;
}

const totalReward = (r: Pick<LeaderboardRow, 'earned' | 'unpaid'>) => r.earned + r.unpaid;

/** Competition ranking: rows with the same conversions and the same rewards share a rank. */
export function rankLeaderboard(rows: LeaderboardRow[]): RankedRow[] {
  const sorted = [...rows].sort(
    (a, b) =>
      b.conversions - a.conversions ||
      totalReward(b) - totalReward(a) ||
      b.clicks - a.clicks ||
      referrerLabel(a).localeCompare(referrerLabel(b)),
  );
  const ranked: RankedRow[] = [];
  sorted.forEach((row, i) => {
    const prev = ranked[i - 1];
    const tied = prev && prev.conversions === row.conversions && totalReward(prev) === totalReward(row);
    ranked.push({ ...row, rank: tied ? prev.rank : i + 1 });
  });
  return ranked;
}

export function summarizeBoard(rows: LeaderboardRow[]) {
  const sum = (pick: (r: LeaderboardRow) => number) => rows.reduce((acc, r) => acc + pick(r), 0);
  const clicks = sum((r) => r.clicks);
  const conversions = sum((r) => r.conversions);
  return {
    links: rows.length,
    clicks,
    conversions,
    rewarded: sum((r) => r.rewarded),
    earned: sum((r) => r.earned),
    unpaid: sum((r) => r.unpaid),
    rate: conversionRate(clicks, conversions),
  };
}

// ============================================================
// Payouts
// ============================================================

export type PayoutFilter = 'to_pay' | 'pending' | 'paid' | 'all';

export const isPayable = (c: Pick<ConversionDetail, 'status' | 'reward_type'>): boolean =>
  c.status === 'converted' && c.reward_type !== null;

export function filterConversions(
  list: ConversionDetail[],
  { tab, query }: { tab: PayoutFilter; query: string },
): ConversionDetail[] {
  const q = query.trim().toLowerCase();
  return list.filter((c) => {
    if (tab === 'to_pay' && !isPayable(c)) return false;
    if (tab === 'pending' && c.status !== 'pending') return false;
    if (tab === 'paid' && c.status !== 'rewarded') return false;
    if (!q) return true;
    return [c.referrer_name, c.referred_name, c.code].some((v) => v?.toLowerCase().includes(q));
  });
}

export function countConversionTabs(list: ConversionDetail[]): Record<PayoutFilter, number> {
  return {
    to_pay: list.filter(isPayable).length,
    pending: list.filter((c) => c.status === 'pending').length,
    paid: list.filter((c) => c.status === 'rewarded').length,
    all: list.length,
  };
}

/** Dollar total of credit/cash rewards plus the count of percent discounts (which have no dollar value). */
export function sumPayable(list: Pick<ConversionDetail, 'reward_type' | 'reward_amount'>[]): {
  cash: number;
  discounts: number;
} {
  let cash = 0;
  let discounts = 0;
  for (const c of list) {
    if (c.reward_type === 'discount') discounts += 1;
    else if (c.reward_amount !== null) cash += c.reward_amount;
  }
  return { cash, discounts };
}

export function defaultMethodFor(types: RewardType[]): PayoutMethod {
  if (types.length === 0 || new Set(types).size > 1) return 'other';
  return { credit: 'account_credit', cash: 'cash', discount: 'invoice_discount' }[types[0]] as PayoutMethod;
}
