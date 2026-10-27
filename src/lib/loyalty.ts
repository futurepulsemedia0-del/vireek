/**
 * Loyalty program — pure helpers (types, earn math, validation, formatting). No I/O: unit-tested in loyalty.test.ts.
 * The earn math mirrors the database (loyalty_base_points / loyalty_award_job) so the dashboard preview matches
 * what a paid invoice really earns.
 */

export const MAX_TIERS = 8;
export const MAX_EARN_RULES = 20;
export const MAX_REWARDS = 30;
export const MAX_ADJUST = 100_000;

export type EarnKind = 'per_dollar' | 'flat_per_job';
export type RewardType = 'credit' | 'discount_percent' | 'free_service' | 'custom';
export type LedgerType = 'earn' | 'reinstate' | 'reversal' | 'redeem' | 'refund' | 'adjust';
export type RedemptionStatus = 'pending' | 'fulfilled' | 'cancelled';

export interface LoyaltySettings {
  user_id: string;
  is_enabled: boolean;
  program_name: string;
  points_label: string;
  portal_redemption_enabled: boolean;
}

export interface LoyaltyTier {
  id: string;
  name: string;
  min_lifetime_points: number;
  earn_multiplier: number;
  perks: string | null;
}

export interface EarnRule {
  id: string;
  name: string;
  kind: EarnKind;
  points_value: number;
  service_type: string | null;
  min_invoice_amount: number;
  is_active: boolean;
}

export interface LoyaltyReward {
  id: string;
  name: string;
  description: string | null;
  points_cost: number;
  reward_type: RewardType;
  reward_value: number | null;
  is_active: boolean;
}

export interface MemberSummary {
  customer_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  points_balance: number;
  lifetime_points: number;
  tier_id: string | null;
  tier_name: string | null;
  earn_multiplier: number | null;
  last_activity_at: string | null;
}

export interface LedgerEntry {
  id: string;
  entry_type: LedgerType;
  points: number;
  note: string | null;
  job_id: string | null;
  created_at: string;
}

export interface RedemptionDetail {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  reward_name: string;
  reward_type: RewardType;
  reward_value: number | null;
  points_cost: number;
  code: string;
  status: RedemptionStatus;
  requested_via: 'portal' | 'dashboard';
  note: string | null;
  created_at: string;
  fulfilled_at: string | null;
  cancelled_at: string | null;
}

export interface LoyaltyOverview {
  members: number;
  outstanding_points: number;
  issued_30d: number;
  redeemed_30d: number;
  pending_redemptions: number;
}

export const EMPTY_OVERVIEW: LoyaltyOverview = { members: 0, outstanding_points: 0, issued_30d: 0, redeemed_30d: 0, pending_redemptions: 0 };

export interface PortalLoyalty {
  program: { name: string; points_label: string; redemption_enabled: boolean };
  balance: number;
  lifetime: number;
  tier: { name: string; earn_multiplier: number; perks: string | null; min_lifetime_points: number } | null;
  next_tier: { name: string; min_lifetime_points: number; points_needed: number } | null;
  tiers: { name: string; min_lifetime_points: number; earn_multiplier: number; perks: string | null }[];
  rewards: { id: string; name: string; description: string | null; points_cost: number; reward_type: RewardType; reward_value: number | null }[];
  history: { id: string; entry_type: LedgerType; points: number; created_at: string; label: string }[];
  redemptions: { id: string; reward_name: string; points_cost: number; status: RedemptionStatus; code: string; created_at: string }[];
}

export const EARN_KIND_OPTIONS: { value: EarnKind; label: string }[] = [
  { value: 'per_dollar', label: 'Points per $1 of invoice' },
  { value: 'flat_per_job', label: 'Flat points per paid job' },
];

export const REWARD_TYPE_OPTIONS: { value: RewardType; label: string; needsValue: boolean }[] = [
  { value: 'credit', label: 'Account credit ($)', needsValue: true },
  { value: 'discount_percent', label: 'Discount (%)', needsValue: true },
  { value: 'free_service', label: 'Free service', needsValue: false },
  { value: 'custom', label: 'Custom perk', needsValue: false },
];

// ---------- formatting ----------

export const formatPoints = (n: number): string => Math.round(n).toLocaleString('en-US');

export const formatSigned = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatPoints(Math.abs(n))}`;

export function formatMoney(n: number): string {
  const digits = Number.isInteger(n) ? 0 : 2;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatMultiplier(m: number): string {
  return `${Number(m.toFixed(2))}×`;
}

export function formatRewardValue(r: Pick<LoyaltyReward, 'reward_type' | 'reward_value'>): string {
  if (r.reward_type === 'credit' && r.reward_value != null) return `${formatMoney(r.reward_value)} credit`;
  if (r.reward_type === 'discount_percent' && r.reward_value != null) return `${Number(r.reward_value)}% off`;
  if (r.reward_type === 'free_service') return 'Free service';
  return 'Special perk';
}

export function describeEarnRule(r: Pick<EarnRule, 'kind' | 'points_value' | 'service_type' | 'min_invoice_amount'>): string {
  const v = Number(r.points_value);
  const base = r.kind === 'per_dollar' ? `${v} pt per $1` : `${formatPoints(v)} pts per paid job`;
  const scope = r.service_type ? ` on ${r.service_type}` : '';
  const min = r.min_invoice_amount > 0 ? ` (invoices ${formatMoney(r.min_invoice_amount)}+)` : '';
  return `${base}${scope}${min}`;
}

export const ENTRY_LABELS: Record<LedgerType, string> = {
  earn: 'Earned',
  reinstate: 'Restored',
  reversal: 'Reversed',
  redeem: 'Redeemed',
  refund: 'Refunded',
  adjust: 'Adjustment',
};

export type Tone = 'success' | 'warning' | 'neutral' | 'danger';

export const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-success/10 text-success',
  warning: 'bg-warning-500/10 text-warning-500',
  neutral: 'bg-bg-tertiary text-text-secondary',
  danger: 'bg-danger/10 text-danger',
};

export function redemptionTone(status: RedemptionStatus): Tone {
  return status === 'fulfilled' ? 'success' : status === 'pending' ? 'warning' : 'neutral';
}

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

// ---------- tiers ----------

export const sortTiers = (tiers: LoyaltyTier[]): LoyaltyTier[] =>
  [...tiers].sort((a, b) => a.min_lifetime_points - b.min_lifetime_points);

export function tierForLifetime(tiers: LoyaltyTier[], lifetime: number): LoyaltyTier | null {
  let found: LoyaltyTier | null = null;
  for (const t of sortTiers(tiers)) if (t.min_lifetime_points <= lifetime) found = t;
  return found;
}

export function nextTier(tiers: LoyaltyTier[], lifetime: number): LoyaltyTier | null {
  return sortTiers(tiers).find((t) => t.min_lifetime_points > lifetime) ?? null;
}

export interface TierProgress {
  current: LoyaltyTier | null;
  next: LoyaltyTier | null;
  pointsToNext: number;
  percent: number;
}

export function tierProgress(tiers: LoyaltyTier[], lifetime: number): TierProgress {
  const current = tierForLifetime(tiers, lifetime);
  const next = nextTier(tiers, lifetime);
  if (!next) return { current, next: null, pointsToNext: 0, percent: 100 };
  const floor = current?.min_lifetime_points ?? 0;
  const span = Math.max(1, next.min_lifetime_points - floor);
  return {
    current,
    next,
    pointsToNext: next.min_lifetime_points - lifetime,
    percent: Math.min(100, Math.max(0, Math.round(((lifetime - floor) / span) * 100))),
  };
}

// ---------- earn math (mirrors loyalty_base_points + loyalty_award_job) ----------

/** Floors after rounding to 6 decimals so 4.35 × 100 is 435, not 434.99999999999994. */
export const floorSafe = (x: number): number => Math.floor(Math.round(x * 1e6) / 1e6);

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

export function ruleMatches(rule: EarnRule, amount: number, service: string | null | undefined): boolean {
  if (!rule.is_active || rule.min_invoice_amount > amount) return false;
  return rule.service_type === null || norm(rule.service_type) === norm(service);
}

export function basePoints(rules: EarnRule[], amount: number, service: string | null | undefined): number {
  return rules
    .filter((r) => ruleMatches(r, amount, service))
    .reduce((sum, r) => sum + (r.kind === 'per_dollar' ? amount * r.points_value : r.points_value), 0);
}

export interface EarnPreview {
  base: number;
  multiplier: number;
  points: number;
  matched: string[];
  tierName: string | null;
}

export function previewEarn(
  rules: EarnRule[],
  tiers: LoyaltyTier[],
  input: { amount: number; service?: string | null; lifetime?: number },
): EarnPreview {
  const amount = Number.isFinite(input.amount) ? Math.max(0, input.amount) : 0;
  const tier = tierForLifetime(tiers, input.lifetime ?? 0);
  const multiplier = tier?.earn_multiplier ?? 1;
  const matched = rules.filter((r) => ruleMatches(r, amount, input.service)).map((r) => r.name);
  const base = amount > 0 ? basePoints(rules, amount, input.service) : 0;
  const points = amount > 0 ? Math.min(1_000_000, floorSafe(base * multiplier)) : 0;
  return { base, multiplier, points, matched, tierName: tier?.name ?? null };
}

// ---------- forms + validation ----------

export type FieldErrors<T> = Partial<Record<keyof T, string>>;

const isInt = (n: number) => Number.isInteger(n);

export interface SettingsForm { program_name: string; points_label: string; portal_redemption_enabled: boolean }

export function validateSettings(f: SettingsForm): FieldErrors<SettingsForm> {
  const e: FieldErrors<SettingsForm> = {};
  const n = f.program_name.trim().length;
  if (n < 2 || n > 40) e.program_name = 'Use 2–40 characters.';
  const l = f.points_label.trim().length;
  if (l < 2 || l > 20) e.points_label = 'Use 2–20 characters (for example "points" or "stars").';
  return e;
}

export interface EarnRuleForm { name: string; kind: EarnKind; points_value: string; service_type: string; min_invoice_amount: string; is_active: boolean }

export const emptyEarnRuleForm = (): EarnRuleForm => ({ name: '', kind: 'per_dollar', points_value: '1', service_type: '', min_invoice_amount: '0', is_active: true });

export const earnRuleToForm = (r: EarnRule): EarnRuleForm => ({
  name: r.name, kind: r.kind, points_value: String(r.points_value), service_type: r.service_type ?? '',
  min_invoice_amount: String(r.min_invoice_amount), is_active: r.is_active,
});

export function validateEarnRule(f: EarnRuleForm): FieldErrors<EarnRuleForm> {
  const e: FieldErrors<EarnRuleForm> = {};
  const n = f.name.trim().length;
  if (n < 2 || n > 60) e.name = 'Use 2–60 characters.';
  const v = Number(f.points_value);
  if (!Number.isFinite(v) || v <= 0 || v > 100_000) e.points_value = 'Enter a number above 0 (max 100,000).';
  else if (f.kind === 'flat_per_job' && !isInt(v)) e.points_value = 'Flat points must be a whole number.';
  if (f.service_type.trim().length > 80) e.service_type = 'Keep it under 80 characters.';
  const m = Number(f.min_invoice_amount === '' ? 0 : f.min_invoice_amount);
  if (!Number.isFinite(m) || m < 0) e.min_invoice_amount = 'Enter 0 or more.';
  return e;
}

export function earnRuleToPayload(f: EarnRuleForm) {
  return {
    name: f.name.trim(),
    kind: f.kind,
    points_value: Number(f.points_value),
    service_type: f.service_type.trim() || null,
    min_invoice_amount: Number(f.min_invoice_amount === '' ? 0 : f.min_invoice_amount),
    is_active: f.is_active,
  };
}

export interface TierForm { name: string; min_lifetime_points: string; earn_multiplier: string; perks: string }

export const emptyTierForm = (): TierForm => ({ name: '', min_lifetime_points: '0', earn_multiplier: '1', perks: '' });

export const tierToForm = (t: LoyaltyTier): TierForm => ({
  name: t.name, min_lifetime_points: String(t.min_lifetime_points), earn_multiplier: String(t.earn_multiplier), perks: t.perks ?? '',
});

export function validateTier(f: TierForm, existing: LoyaltyTier[], editingId: string | null): FieldErrors<TierForm> {
  const e: FieldErrors<TierForm> = {};
  const others = existing.filter((t) => t.id !== editingId);
  const n = f.name.trim();
  if (n.length < 2 || n.length > 40) e.name = 'Use 2–40 characters.';
  else if (others.some((t) => t.name.trim().toLowerCase() === n.toLowerCase())) e.name = 'Another tier already uses this name.';
  const min = Number(f.min_lifetime_points);
  if (!Number.isFinite(min) || !isInt(min) || min < 0 || min > 10_000_000) e.min_lifetime_points = 'Enter a whole number from 0 to 10,000,000.';
  else if (others.some((t) => t.min_lifetime_points === min)) e.min_lifetime_points = 'Another tier already starts at this number.';
  const m = Number(f.earn_multiplier);
  if (!Number.isFinite(m) || m < 1 || m > 10) e.earn_multiplier = 'Enter a multiplier between 1 and 10.';
  if (f.perks.trim().length > 300) e.perks = 'Keep perks under 300 characters.';
  return e;
}

export const tierToPayload = (f: TierForm) => ({
  name: f.name.trim(),
  min_lifetime_points: Number(f.min_lifetime_points),
  earn_multiplier: Number(f.earn_multiplier),
  perks: f.perks.trim() || null,
});

export interface RewardForm { name: string; description: string; points_cost: string; reward_type: RewardType; reward_value: string; is_active: boolean }

export const emptyRewardForm = (): RewardForm => ({ name: '', description: '', points_cost: '500', reward_type: 'credit', reward_value: '25', is_active: true });

export const rewardToForm = (r: LoyaltyReward): RewardForm => ({
  name: r.name, description: r.description ?? '', points_cost: String(r.points_cost), reward_type: r.reward_type,
  reward_value: r.reward_value == null ? '' : String(r.reward_value), is_active: r.is_active,
});

export const rewardNeedsValue = (t: RewardType): boolean => REWARD_TYPE_OPTIONS.find((o) => o.value === t)?.needsValue ?? false;

export function validateReward(f: RewardForm): FieldErrors<RewardForm> {
  const e: FieldErrors<RewardForm> = {};
  const n = f.name.trim().length;
  if (n < 2 || n > 60) e.name = 'Use 2–60 characters.';
  if (f.description.trim().length > 300) e.description = 'Keep it under 300 characters.';
  const c = Number(f.points_cost);
  if (!Number.isFinite(c) || !isInt(c) || c < 1 || c > 10_000_000) e.points_cost = 'Enter a whole number of points (1 or more).';
  if (rewardNeedsValue(f.reward_type)) {
    const v = Number(f.reward_value);
    if (f.reward_value.trim() === '' || !Number.isFinite(v) || v <= 0) e.reward_value = 'Enter a value above 0.';
    else if (f.reward_type === 'discount_percent' && (v < 1 || v > 100)) e.reward_value = 'Enter a percentage from 1 to 100.';
  }
  return e;
}

export const rewardToPayload = (f: RewardForm) => ({
  name: f.name.trim(),
  description: f.description.trim() || null,
  points_cost: Number(f.points_cost),
  reward_type: f.reward_type,
  reward_value: rewardNeedsValue(f.reward_type) ? Number(f.reward_value) : null,
  is_active: f.is_active,
});

export function validateAdjust(pointsRaw: string, note: string, balance: number): { points?: string; note?: string } {
  const e: { points?: string; note?: string } = {};
  const p = Number(pointsRaw);
  if (pointsRaw.trim() === '' || !Number.isFinite(p) || !isInt(p) || p === 0) e.points = 'Enter a whole number (use a minus sign to remove points).';
  else if (Math.abs(p) > MAX_ADJUST) e.points = `Adjust by at most ${formatPoints(MAX_ADJUST)} at a time.`;
  else if (balance + p < 0) e.points = 'This would take the balance below zero.';
  const n = note.trim().length;
  if (n < 2 || n > 300) e.note = 'Add a short reason (2–300 characters).';
  return e;
}

// ---------- lists ----------

export type MemberSort = 'balance' | 'lifetime' | 'recent' | 'name';

export function filterMembers(rows: MemberSummary[], query: string): MemberSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((m) => `${m.name} ${m.email ?? ''} ${m.phone ?? ''} ${m.tier_name ?? ''}`.toLowerCase().includes(q));
}

export function sortMembers(rows: MemberSummary[], by: MemberSort): MemberSummary[] {
  const out = [...rows];
  out.sort((a, b) => {
    if (by === 'name') return a.name.localeCompare(b.name);
    if (by === 'lifetime') return b.lifetime_points - a.lifetime_points;
    if (by === 'recent') return Date.parse(b.last_activity_at ?? '1970-01-01') - Date.parse(a.last_activity_at ?? '1970-01-01');
    return b.points_balance - a.points_balance;
  });
  return out;
}

export function filterRedemptions(rows: RedemptionDetail[], status: RedemptionStatus | 'all'): RedemptionDetail[] {
  return status === 'all' ? rows : rows.filter((r) => r.status === status);
}

export const countPending = (rows: { status: RedemptionStatus }[]): number => rows.filter((r) => r.status === 'pending').length;

export const canAfford = (balance: number, cost: number): boolean => balance >= cost;

export const pointsShort = (balance: number, cost: number): number => Math.max(0, cost - balance);

// ---------- recommended starting setup (used by the one-click "Start with a recommended setup") ----------

export const DEFAULT_SETUP: {
  settings: SettingsForm;
  rules: EarnRuleForm[];
  tiers: TierForm[];
  rewards: RewardForm[];
} = {
  settings: { program_name: 'Rewards', points_label: 'points', portal_redemption_enabled: true },
  rules: [{ name: 'Points on every paid invoice', kind: 'per_dollar', points_value: '1', service_type: '', min_invoice_amount: '0', is_active: true }],
  tiers: [
    { name: 'Member', min_lifetime_points: '0', earn_multiplier: '1', perks: 'Earn points on every paid invoice.' },
    { name: 'Silver', min_lifetime_points: '500', earn_multiplier: '1.25', perks: '25% more points on every job.' },
    { name: 'Gold', min_lifetime_points: '2500', earn_multiplier: '1.5', perks: '50% more points and priority scheduling.' },
    { name: 'Platinum', min_lifetime_points: '7500', earn_multiplier: '2', perks: 'Double points and priority scheduling.' },
  ],
  rewards: [
    { name: '$10 service credit', description: 'Applied to your next invoice.', points_cost: '500', reward_type: 'credit', reward_value: '10', is_active: true },
    { name: '$25 service credit', description: 'Applied to your next invoice.', points_cost: '1200', reward_type: 'credit', reward_value: '25', is_active: true },
    { name: 'Priority scheduling', description: 'Jump the queue on your next booking.', points_cost: '800', reward_type: 'custom', reward_value: '', is_active: true },
  ],
};
