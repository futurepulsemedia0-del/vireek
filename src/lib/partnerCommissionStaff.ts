// Pure helpers for the staff partner-commission console (/staff/partner-commissions): types, defensive
// parsing of the staff_* RPC payloads, money formatting and error clean-up. No I/O.

export interface PartnerCommissionRow {
  id: string;
  company_name: string;
  contact_email: string;
  tier: string;
  status: string;
  commission_rate: number;
  commission_months: number;
  commission_override_active: boolean;
  commission_override_approved: boolean;
  referrals: number;
  payable_cents: number;
  held_cents: number;
  paid_cents: number;
  clawed_back_cents: number;
}

export interface LedgerEntry {
  id: string;
  referral_id: string;
  entry_type: 'earn' | 'clawback' | 'reinstatement' | 'legacy';
  amount_cents: number;
  base_cents: number | null;
  rate_pct: number | null;
  period_index: number | null;
  stripe_invoice_id: string | null;
  source_kind: string | null;
  status: 'pending' | 'approved' | 'paid' | 'void';
  reason: string | null;
  earned_at: string;
  paid_at: string | null;
  void_reason: string | null;
  created_at: string;
  payable: boolean;
}

export interface TermsAuditRow {
  op: string;
  old_rate: number | null;
  new_rate: number;
  old_months: number | null;
  new_months: number;
  override_active: boolean;
  reason: string | null;
  created_at: string;
}

export interface PartnerLedger {
  entries: LedgerEntry[];
  audit: TermsAuditRow[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : d;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v, Number.NaN)) as number | null;

export function parseOverview(raw: unknown): PartnerCommissionRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: PartnerCommissionRow[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.id !== 'string') continue;
    rows.push({
      id: r.id,
      company_name: str(r.company_name, '—'),
      contact_email: str(r.contact_email),
      tier: str(r.tier),
      status: str(r.status),
      commission_rate: num(r.commission_rate),
      commission_months: num(r.commission_months),
      commission_override_active: r.commission_override_active === true,
      commission_override_approved: r.commission_override_approved === true,
      referrals: num(r.referrals),
      payable_cents: num(r.payable_cents),
      held_cents: num(r.held_cents),
      paid_cents: num(r.paid_cents),
      clawed_back_cents: num(r.clawed_back_cents),
    });
  }
  return rows;
}

const ENTRY_TYPES = new Set(['earn', 'clawback', 'reinstatement', 'legacy']);
const STATUSES = new Set(['pending', 'approved', 'paid', 'void']);

export function parseLedger(raw: unknown): PartnerLedger {
  if (!isObj(raw)) return { entries: [], audit: [] };
  const entries: LedgerEntry[] = [];
  for (const e of Array.isArray(raw.entries) ? raw.entries : []) {
    if (!isObj(e) || typeof e.id !== 'string' || !ENTRY_TYPES.has(String(e.entry_type)) || !STATUSES.has(String(e.status))) continue;
    entries.push({
      id: e.id,
      referral_id: str(e.referral_id),
      entry_type: e.entry_type as LedgerEntry['entry_type'],
      amount_cents: num(e.amount_cents),
      base_cents: numOrNull(e.base_cents),
      rate_pct: numOrNull(e.rate_pct),
      period_index: numOrNull(e.period_index),
      stripe_invoice_id: typeof e.stripe_invoice_id === 'string' ? e.stripe_invoice_id : null,
      source_kind: typeof e.source_kind === 'string' ? e.source_kind : null,
      status: e.status as LedgerEntry['status'],
      reason: typeof e.reason === 'string' ? e.reason : null,
      earned_at: str(e.earned_at),
      paid_at: typeof e.paid_at === 'string' ? e.paid_at : null,
      void_reason: typeof e.void_reason === 'string' ? e.void_reason : null,
      created_at: str(e.created_at),
      payable: e.payable === true,
    });
  }
  const audit: TermsAuditRow[] = [];
  for (const a of Array.isArray(raw.audit) ? raw.audit : []) {
    if (!isObj(a)) continue;
    audit.push({
      op: str(a.op),
      old_rate: numOrNull(a.old_rate),
      new_rate: num(a.new_rate),
      old_months: numOrNull(a.old_months),
      new_months: num(a.new_months),
      override_active: a.override_active === true,
      reason: typeof a.reason === 'string' ? a.reason : null,
      created_at: str(a.created_at),
    });
  }
  return { entries, audit };
}

/** Signed USD with cents, e.g. -1580 -> "-$15.80". */
export function formatUsdCents(cents: number): string {
  const v = Number.isFinite(cents) ? cents : 0;
  const s = (Math.abs(v) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  return v < 0 ? `-${s}` : s;
}

/** Turns a Postgres/PostgREST error message into something a staff member can read. */
export function cleanGuardrailMessage(message: string): string {
  const m = /commission_guardrail:\s*(.+)$/s.exec(message);
  if (m) return m[1].trim();
  if (/Staff only/i.test(message)) return 'Staff only.';
  return message;
}
