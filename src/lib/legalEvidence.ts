// Pure helpers for terms-acceptance evidence (20290312000000_terms_acceptance_evidence.sql). No I/O.
// The database is authoritative; this file only validates what the staff RPCs return and shapes click-through input.

export type AcceptanceSource = 'signup' | 'gate' | 'settings' | 'plan_change' | 'msa_click_through';
export type ClickThroughSource = Extract<AcceptanceSource, 'plan_change' | 'msa_click_through'>;

/** Documents a plan-change click-through covers. [COUNSEL] decide whether billing terms need their own document key. */
export const PLAN_CHANGE_DOC_KEYS: readonly string[] = ['terms'];
export const MSA_DOC_KEY = 'msa';

const SOURCES: ReadonlySet<string> = new Set(['signup', 'gate', 'settings', 'plan_change', 'msa_click_through']);

export const SOURCE_LABELS: Record<AcceptanceSource, string> = {
  signup: 'Sign-up',
  gate: 'Re-acceptance screen',
  settings: 'Settings',
  plan_change: 'Plan change',
  msa_click_through: 'MSA click-through',
};

export interface AcceptanceEvidence {
  id: string;
  acceptedAt: string;
  docKey: string;
  version: number;
  title: string;
  source: AcceptanceSource;
  contentSha256: string | null;
  ipAddress: string | null;
  ipSource: string | null;
  userAgent: string | null;
  userId: string | null;
  email: string | null;
  accountOwnerId: string | null;
  context: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optStr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Rows that are not valid evidence are dropped rather than rendered half-empty. */
export function parseEvidenceRows(raw: unknown): AcceptanceEvidence[] {
  if (!Array.isArray(raw)) return [];
  const out: AcceptanceEvidence[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.id !== 'string' || typeof r.accepted_at !== 'string' || typeof r.doc_key !== 'string') continue;
    if (!SOURCES.has(String(r.source))) continue;
    const ctx: Record<string, string> = {};
    if (isObj(r.context)) for (const [k, v] of Object.entries(r.context)) if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') ctx[k] = String(v);
    const sha = optStr(r.content_sha256);
    out.push({
      id: r.id,
      acceptedAt: r.accepted_at,
      docKey: r.doc_key,
      version: Number(r.version) || 0,
      title: typeof r.title === 'string' ? r.title : r.doc_key,
      source: r.source as AcceptanceSource,
      contentSha256: sha && /^[0-9a-f]{64}$/.test(sha) ? sha : null,
      ipAddress: optStr(r.ip_address),
      ipSource: optStr(r.ip_source),
      userAgent: optStr(r.user_agent),
      userId: optStr(r.user_id),
      email: optStr(r.email),
      accountOwnerId: optStr(r.account_owner_id),
      context: ctx,
    });
  }
  return out;
}

export function shortHash(h: string | null): string {
  return h ? `${h.slice(0, 8)}…${h.slice(-6)}` : 'no hash recorded';
}

/** Keys the server keeps; anything else is dropped client-side too so the request stays small and predictable. */
const CONTEXT_KEYS = ['plan_id', 'from_plan_id', 'billing_interval', 'authority_confirmed', 'signer_title'] as const;
export function cleanClickContext(ctx: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CONTEXT_KEYS) {
    const v = ctx[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 120);
    else if (typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

export interface LegalDocumentOverview {
  id: string;
  docKey: string;
  version: number;
  title: string;
  effectiveAt: string;
  isMaterial: boolean;
  status: string;
  changeCount: number;
  hasHash: boolean;
  gating: boolean;
  acceptedCount: number;
  pendingCount: number | null;
  counselConfirmed: boolean;
  noticeWaived: boolean;
}

export function parseDocumentOverview(raw: unknown): LegalDocumentOverview[] {
  if (!Array.isArray(raw)) return [];
  const out: LegalDocumentOverview[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.id !== 'string' || typeof r.doc_key !== 'string') continue;
    out.push({
      id: r.id,
      docKey: r.doc_key,
      version: Number(r.version) || 0,
      title: typeof r.title === 'string' ? r.title : r.doc_key,
      effectiveAt: typeof r.effective_at === 'string' ? r.effective_at : '',
      isMaterial: r.is_material === true,
      status: typeof r.status === 'string' ? r.status : 'published',
      changeCount: Number(r.change_count) || 0,
      hasHash: r.has_hash === true,
      gating: r.gating !== false,
      acceptedCount: Number(r.accepted_count) || 0,
      pendingCount: r.pending_count === null || r.pending_count === undefined ? null : Number(r.pending_count) || 0,
      counselConfirmed: typeof r.counsel_confirmed_at === 'string',
      noticeWaived: typeof r.notice_waiver_reason === 'string' && r.notice_waiver_reason !== '',
    });
  }
  return out;
}

/** Grace is whole days, 0..90 (same bounds as the database CHECK). Returns null when the input is not valid. */
export function parseGraceDays(input: string): number | null {
  if (!/^\d{1,2}$/.test(input.trim())) return null;
  const n = Number(input.trim());
  return n >= 0 && n <= 90 ? n : null;
}
