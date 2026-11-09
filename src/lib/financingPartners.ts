import {
  FINANCING_STATUSES,
  INSURANCE_STATUSES,
  isFinancingTerminal,
  isInsuranceTerminal,
  type FinancingStatus,
  type InsuranceStatus,
} from '../../supabase/functions/_shared/financing-partners/stateMachine';

export { FINANCING_STATUSES, INSURANCE_STATUSES, isFinancingTerminal, isInsuranceTerminal };
export type { FinancingStatus, InsuranceStatus };

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
export type FinancingProduct = 'consumer_financing' | 'working_capital' | 'insurance_referral';

export const FINANCING_STATUS_VIEW: Record<FinancingStatus, { label: string; tone: Tone; hint: string }> = {
  offered: { label: 'Offered', tone: 'neutral', hint: 'Waiting for the customer to open the partner’s application.' },
  link_opened: { label: 'Customer opened application', tone: 'accent', hint: 'The customer went to the partner’s site.' },
  submitted: { label: 'Application submitted', tone: 'accent', hint: 'The partner is reviewing. Vireek does not see or influence the decision.' },
  approved: { label: 'Approved by partner', tone: 'success', hint: 'The partner approved the customer. Funding comes from the partner.' },
  funded: { label: 'Funded by partner', tone: 'success', hint: 'The partner reports the loan as funded.' },
  declined: { label: 'Declined by partner', tone: 'danger', hint: 'The partner did not approve. Offer another way to pay.' },
  expired: { label: 'Expired', tone: 'neutral', hint: 'The offer window ended.' },
  canceled: { label: 'Canceled', tone: 'neutral', hint: 'This offer was canceled.' },
};

export const INSURANCE_STATUS_VIEW: Record<InsuranceStatus, { label: string; tone: Tone }> = {
  referred: { label: 'Referred', tone: 'neutral' },
  contacted: { label: 'Partner contacted you', tone: 'accent' },
  quoted: { label: 'Quote provided', tone: 'accent' },
  bound: { label: 'Policy bound', tone: 'success' },
  declined: { label: 'Declined', tone: 'danger' },
  expired: { label: 'Expired', tone: 'neutral' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

export const INSURANCE_LINE_LABEL: Record<string, string> = {
  general_liability: 'General liability',
  workers_comp: 'Workers’ compensation',
  commercial_auto: 'Commercial auto',
  equipment: 'Equipment',
  home_warranty: 'Home warranty',
};

export const WC_SIGNAL_LABEL: Record<string, string> = {
  tenure_months: 'Months in business on Vireek',
  active_months_12m: 'Active months (last 12)',
  jobs_12m_band: 'Jobs in last 12 months (range)',
  paid_revenue_12m_band: 'Paid revenue in last 12 months (range)',
  invoice_paid_rate_pct: 'Invoices paid (rounded %)',
  median_days_to_pay_band: 'Typical days to get paid (range)',
};
export const WC_SIGNAL_KEYS = Object.keys(WC_SIGNAL_LABEL);

export const GATE_REASON_COPY: Record<string, string> = {
  flag_off: 'Partner financing isn’t available yet.',
  not_entitled: 'Partner financing isn’t enabled for your account. Contact Vireek to request access.',
  region_unknown: 'Set your business country in Settings to check availability.',
  region_blocked: 'Partner financing isn’t available in your region.',
  forbidden: 'You don’t have permission to manage financing.',
  invalid: 'Partner financing isn’t available.',
};
export const gateMessage = (reason: string | null | undefined): string =>
  GATE_REASON_COPY[reason ?? ''] ?? 'Partner financing isn’t available.';

export const PARTNER_IS_LENDER_NOTICE = (partnerName: string): string =>
  `${partnerName} — not Vireek — is the lender. Vireek does not make credit decisions or hold funds.`;

export interface FunnelTotals {
  offered_quotes: number; offers: number; link_opened: number; submitted: number; approved: number;
  funded: number; declined: number; expired: number; canceled: number; needs_review: number; funded_amount_cents: number;
}
export interface FunnelReport {
  quotes_sent: number;
  totals: FunnelTotals;
  by_partner: { partner_key: string; partner_name: string; offers: number; submitted: number; funded: number }[];
}
export interface FunnelRates {
  offerRate: number | null;
  openRate: number | null;
  applicationRate: number | null;
  approvalRate: number | null;
  fundedRate: number | null;
  fundedOfApplied: number | null;
}

const ratio = (n: number, d: number): number | null => (d > 0 ? Math.min(1, Math.max(0, n / d)) : null);

export function computeFunnelRates(r: Pick<FunnelReport, 'quotes_sent' | 'totals'>): FunnelRates {
  const t = r.totals;
  return {
    offerRate: ratio(t.offered_quotes, r.quotes_sent),
    openRate: ratio(t.link_opened, t.offers),
    applicationRate: ratio(t.submitted, t.offers),
    approvalRate: ratio(t.approved, t.submitted),
    fundedRate: ratio(t.funded, t.offers),
    fundedOfApplied: ratio(t.funded, t.submitted),
  };
}
export const formatRate = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);

export function effectiveOfferStatus(status: FinancingStatus, expiresAt: string, now: Date = new Date()): FinancingStatus {
  if ((status === 'offered' || status === 'link_opened') && new Date(expiresAt).getTime() <= now.getTime()) return 'expired';
  return status;
}

export type CustomerPanelState =
  | { kind: 'hidden' }
  | { kind: 'open'; canApply: boolean }
  | { kind: 'in_progress'; status: FinancingStatus }
  | { kind: 'closed'; status: FinancingStatus };

export function customerPanelState(
  pub: { available: boolean; status?: FinancingStatus } | null,
): CustomerPanelState {
  if (!pub || !pub.available || !pub.status) return { kind: 'hidden' };
  if (pub.status === 'offered' || pub.status === 'link_opened') return { kind: 'open', canApply: true };
  if (pub.status === 'submitted' || pub.status === 'approved') return { kind: 'in_progress', status: pub.status };
  return { kind: 'closed', status: pub.status };
}

export function canGrantWorkingCapitalConsent(input: { acknowledged: boolean; scopes: string[]; disclosureLoaded: boolean }): { ok: boolean; reason?: string } {
  if (!input.disclosureLoaded) return { ok: false, reason: 'Disclosure not loaded yet.' };
  if (!input.acknowledged) return { ok: false, reason: 'Confirm you have read the disclosure.' };
  if (input.scopes.length === 0) return { ok: false, reason: 'Choose at least one item to share.' };
  if (!input.scopes.every((s) => WC_SIGNAL_KEYS.includes(s))) return { ok: false, reason: 'Unknown item selected.' };
  return { ok: true };
}

export function canSubmitInsuranceReferral(input: { acknowledged: boolean; line: string; disclosureLoaded: boolean }): { ok: boolean; reason?: string } {
  if (!input.disclosureLoaded) return { ok: false, reason: 'Disclosure not loaded yet.' };
  if (!(input.line in INSURANCE_LINE_LABEL)) return { ok: false, reason: 'Choose a coverage type.' };
  if (!input.acknowledged) return { ok: false, reason: 'Confirm you have read the disclosure.' };
  return { ok: true };
}

export function formatMoney(cents: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(0)} ${currency}`;
  }
}
