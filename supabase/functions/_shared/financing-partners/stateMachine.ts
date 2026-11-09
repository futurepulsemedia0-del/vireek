export const FINANCING_STATUSES = [
  'offered', 'link_opened', 'submitted', 'approved', 'funded', 'declined', 'expired', 'canceled',
] as const;
export type FinancingStatus = (typeof FINANCING_STATUSES)[number];

export const INSURANCE_STATUSES = [
  'referred', 'contacted', 'quoted', 'bound', 'declined', 'expired', 'canceled',
] as const;
export type InsuranceStatus = (typeof INSURANCE_STATUSES)[number];

const FINANCING_RANK: Partial<Record<FinancingStatus, number>> = {
  offered: 0, link_opened: 1, submitted: 2, approved: 3, funded: 4,
};
const INSURANCE_RANK: Partial<Record<InsuranceStatus, number>> = {
  referred: 0, contacted: 1, quoted: 2, bound: 3,
};

export const FINANCING_TERMINAL: readonly FinancingStatus[] = ['funded', 'declined', 'expired', 'canceled'];
export const INSURANCE_TERMINAL: readonly InsuranceStatus[] = ['bound', 'declined', 'expired', 'canceled'];

export const isFinancingTerminal = (s: FinancingStatus): boolean => FINANCING_TERMINAL.includes(s);
export const isInsuranceTerminal = (s: InsuranceStatus): boolean => INSURANCE_TERMINAL.includes(s);

const FINANCING_DECLINABLE_FROM: readonly FinancingStatus[] = ['offered', 'link_opened', 'submitted'];
const INSURANCE_DECLINABLE_FROM: readonly InsuranceStatus[] = ['referred', 'contacted', 'quoted'];

export type TransitionResult = 'apply' | 'noop' | 'reject';

export function financingTransition(from: FinancingStatus, to: FinancingStatus): TransitionResult {
  if (from === to) return 'noop';
  if (isFinancingTerminal(from)) return 'reject';
  if (to === 'declined') return FINANCING_DECLINABLE_FROM.includes(from) ? 'apply' : 'reject';
  if (to === 'expired' || to === 'canceled') return 'apply';
  const f = FINANCING_RANK[from];
  const t = FINANCING_RANK[to];
  if (f === undefined || t === undefined) return 'reject';
  return t > f ? 'apply' : 'reject';
}

export function insuranceTransition(from: InsuranceStatus, to: InsuranceStatus): TransitionResult {
  if (from === to) return 'noop';
  if (isInsuranceTerminal(from)) return 'reject';
  if (to === 'declined') return INSURANCE_DECLINABLE_FROM.includes(from) ? 'apply' : 'reject';
  if (to === 'expired' || to === 'canceled') return 'apply';
  const f = INSURANCE_RANK[from];
  const t = INSURANCE_RANK[to];
  if (f === undefined || t === undefined) return 'reject';
  return t > f ? 'apply' : 'reject';
}

export const canFinancingTransition = (from: FinancingStatus, to: FinancingStatus): boolean =>
  financingTransition(from, to) === 'apply';

export function isFinancingStatus(v: unknown): v is FinancingStatus {
  return typeof v === 'string' && (FINANCING_STATUSES as readonly string[]).includes(v);
}
export function isInsuranceStatus(v: unknown): v is InsuranceStatus {
  return typeof v === 'string' && (INSURANCE_STATUSES as readonly string[]).includes(v);
}

export const PARTNER_REPORTABLE_FINANCING: readonly FinancingStatus[] = ['submitted', 'approved', 'funded', 'declined', 'expired', 'canceled'];
export const PARTNER_REPORTABLE_INSURANCE: readonly InsuranceStatus[] = ['contacted', 'quoted', 'bound', 'declined', 'expired', 'canceled'];
