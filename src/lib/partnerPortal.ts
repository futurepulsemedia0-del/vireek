// Shared types + small helpers for the Partner Portal (src/pages/PartnerPortal*
// and src/pages/PartnerApplyPage.tsx). Table/RPC names come from
// supabase/migrations/20261203000000_partner_portal.sql.

export type PartnerTier = 'affiliate' | 'agency';
export type PartnerStatus = 'pending' | 'approved' | 'rejected' | 'suspended';
export type ReferralStatus = 'signed_up' | 'converted' | 'churned' | 'rejected';
export type CommissionStatus = 'pending' | 'approved' | 'paid' | 'void';

export interface Partner {
  id: string;
  user_id: string;
  company_name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string | null;
  channel: string | null;
  tier: PartnerTier;
  status: PartnerStatus;
  referral_code: string;
  commission_rate: number;
  payout_method: string | null;
  payout_details: string | null;
  applied_at: string;
  approved_at: string | null;
  created_at: string;
}

export interface PartnerReferral {
  id: string;
  partner_id: string;
  referred_user_id: string | null;
  referred_email: string | null;
  status: ReferralStatus;
  mrr_cents: number;
  commission_cents: number;
  commission_status: CommissionStatus;
  created_at: string;
  converted_at: string | null;
}

export interface PartnerDashboardStats {
  has_application: boolean;
  partner?: Partner;
  total_clicks?: number;
  total_referrals?: number;
  converted_referrals?: number;
  churned_referrals?: number;
  pending_commission_cents?: number;
  paid_commission_cents?: number;
  is_certified?: boolean;
}

/** localStorage key used to remember a clicked referral code until signup. */
export const PARTNER_REF_STORAGE_KEY = 'vireek_partner_ref';
const PARTNER_REF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, matches the "real tracking window" copy on /affiliate

export function storePartnerReferralCode(code: string) {
  try {
    localStorage.setItem(PARTNER_REF_STORAGE_KEY, JSON.stringify({ code, savedAt: Date.now() }));
  } catch {
    /* Storage can be unavailable (private mode, quota) — attribution is best-effort. */
  }
}

/** Reads the stored code if it's still within the tracking window, without clearing it. */
export function readPartnerReferralCode(): string | null {
  try {
    const raw = localStorage.getItem(PARTNER_REF_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { code: string; savedAt: number };
    if (!parsed?.code || Date.now() - parsed.savedAt > PARTNER_REF_MAX_AGE_MS) return null;
    return parsed.code;
  } catch {
    return null;
  }
}

export function clearPartnerReferralCode() {
  try {
    localStorage.removeItem(PARTNER_REF_STORAGE_KEY);
  } catch {
    /* no-op */
  }
}

export function buildReferralLink(code: string): string {
  return `${window.location.origin}/r/${code}`;
}

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export const REFERRAL_STATUS_LABELS: Record<ReferralStatus, string> = {
  signed_up: 'Signed up',
  converted: 'Converted',
  churned: 'Churned',
  rejected: 'Rejected',
};

export const REFERRAL_STATUS_CLASSES: Record<ReferralStatus, string> = {
  signed_up: 'border-border bg-bg-tertiary text-text-secondary',
  converted: 'border-success/30 bg-success/10 text-success',
  churned: 'border-danger/30 bg-danger/10 text-danger',
  rejected: 'border-danger/30 bg-danger/10 text-danger',
};

export const COMMISSION_STATUS_LABELS: Record<CommissionStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  paid: 'Paid',
  void: 'Void',
};

export const PARTNER_STATUS_LABELS: Record<PartnerStatus, string> = {
  pending: 'Under review',
  approved: 'Approved',
  rejected: 'Not approved',
  suspended: 'Suspended',
};
