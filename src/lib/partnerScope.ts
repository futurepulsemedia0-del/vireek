// Pure helpers for the partner portal "referred accounts" scope (supabase/migrations/20290307000100_partner_portal_scope.sql).
// Defensive parsing of the RPC payloads. No I/O. The database is the security boundary; this only shapes what it returns.

export interface PartnerScopeContext {
  hasScope: boolean;
  partnerId: string | null;
  companyName: string;
  tier: string;
  isOwner: boolean;
  canViewCommissions: boolean;
}

export interface ReferredAccount {
  accountId: string;
  companyName: string;
  plan: string;
  accountStatus: string;
  referralStatus: string;
  referredAt: string | null;
  convertedAt: string | null;
  /** null when the caller may not see commission figures (not "0"). */
  mrrCents: number | null;
  commissionCents: number | null;
  commissionStatus: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const numOrNull = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

export const NO_PARTNER_SCOPE: PartnerScopeContext = {
  hasScope: false, partnerId: null, companyName: '', tier: '', isOwner: false, canViewCommissions: false,
};

export function parseScopeContext(raw: unknown): PartnerScopeContext {
  if (!isObj(raw) || raw.has_scope !== true || typeof raw.partner_id !== 'string') return NO_PARTNER_SCOPE;
  return {
    hasScope: true, partnerId: raw.partner_id, companyName: str(raw.company_name), tier: str(raw.tier),
    isOwner: raw.is_owner === true, canViewCommissions: raw.can_view_commissions === true,
  };
}

export function parseReferredAccounts(raw: unknown): ReferredAccount[] {
  if (!Array.isArray(raw)) return [];
  const out: ReferredAccount[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.account_id !== 'string') continue;
    out.push({
      accountId: r.account_id, companyName: str(r.company_name, '—'), plan: str(r.plan), accountStatus: str(r.account_status),
      referralStatus: str(r.referral_status), referredAt: strOrNull(r.referred_at), convertedAt: strOrNull(r.converted_at),
      mrrCents: numOrNull(r.mrr_cents), commissionCents: numOrNull(r.commission_cents), commissionStatus: strOrNull(r.commission_status),
    });
  }
  return out;
}

/** Maps database errors to stable, non-leaking UI keys (the database already uses one message for "not found / not yours"). */
export function scopeErrorKey(message: string | undefined | null): 'not_found' | 'no_access' | 'sign_in' | 'member_limit' | 'cannot_add' | 'owner_only' | 'unknown' {
  const m = (message ?? '').toLowerCase();
  if (m.includes('account not found')) return 'not_found';
  if (m.includes('no partner access')) return 'no_access';
  if (m.includes('authentication required')) return 'sign_in';
  if (m.includes('member limit reached')) return 'member_limit';
  if (m.includes('could not add that member')) return 'cannot_add';
  if (m.includes('only an approved partner owner')) return 'owner_only';
  return 'unknown';
}
