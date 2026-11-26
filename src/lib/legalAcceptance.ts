// Pure logic for terms re-acceptance: parsing legal_acceptance_status(), localized diff summaries, and the gate
// decision. No I/O. The database is authoritative (20290306000200_legal_terms_versioning.sql); the gate here only
// routes the user to the acceptance screen.

export type ChangeKind = 'added' | 'changed' | 'removed';

export interface LegalChange {
  section: string;
  kind: ChangeKind;
  summary: string;
  i18n: Record<string, string>;
}

export interface RequiredVersionInfo {
  version: number;
  effective_at: string;
  changes: LegalChange[];
}

export interface RequiredDocument {
  doc_key: string;
  version_id: string;
  version: number;
  title: string;
  effective_at: string;
  content_path: string | null;
  accepted_version: number;
  /** false inside the grace window; defaults to true for older payloads */
  blocking: boolean;
  /** oldest pending effective_at + grace; null when not sent */
  deadline: string | null;
  versions: RequiredVersionInfo[];
}

export interface LegalAcceptanceState {
  decision: 'ok' | 'must_accept';
  required: RequiredDocument[];
}

export type LegalGateDecision = 'allow' | 'must_accept';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const KINDS: ReadonlySet<string> = new Set(['added', 'changed', 'removed']);

/** Only same-site paths are ever linked: a stored path can never turn into an external or script URL. */
export function safeContentPath(p: unknown): string | null {
  return typeof p === 'string' && /^\/[A-Za-z0-9/_-]{1,120}$/.test(p) && !p.startsWith('//') ? p : null;
}

function parseChange(c: unknown): LegalChange | null {
  if (!isObj(c) || !KINDS.has(String(c.kind))) return null;
  const summary = str(c.summary).trim();
  const section = str(c.section).trim();
  if (!summary || !section) return null;
  const i18n: Record<string, string> = {};
  if (isObj(c.i18n)) {
    for (const [k, v] of Object.entries(c.i18n)) {
      if (/^[a-z]{2}$/.test(k) && typeof v === 'string' && v.trim()) i18n[k] = v.trim();
    }
  }
  return { section, kind: c.kind as ChangeKind, summary, i18n };
}

/** Returns null for anything that is not a valid state, so callers can fail open explicitly rather than by accident. */
export function parseLegalAcceptanceState(raw: unknown): LegalAcceptanceState | null {
  if (!isObj(raw) || (raw.decision !== 'ok' && raw.decision !== 'must_accept') || !Array.isArray(raw.required)) return null;
  const required: RequiredDocument[] = [];
  for (const d of raw.required) {
    if (!isObj(d) || typeof d.doc_key !== 'string' || typeof d.version_id !== 'string') continue;
    const versions: RequiredVersionInfo[] = [];
    for (const v of Array.isArray(d.versions) ? d.versions : []) {
      if (!isObj(v)) continue;
      const changes = (Array.isArray(v.changes) ? v.changes : []).map(parseChange).filter((c): c is LegalChange => c !== null);
      versions.push({ version: Number(v.version) || 0, effective_at: str(v.effective_at), changes });
    }
    required.push({
      doc_key: d.doc_key,
      version_id: d.version_id,
      version: Number(d.version) || 0,
      title: str(d.title, d.doc_key),
      effective_at: str(d.effective_at),
      content_path: safeContentPath(d.content_path),
      accepted_version: Number(d.accepted_version) || 0,
      blocking: d.blocking !== false,
      deadline: typeof d.deadline === 'string' && d.deadline !== '' ? d.deadline : null,
      versions,
    });
  }
  // a payload that says must_accept but lists nothing cannot be acted on
  return { decision: raw.decision === 'must_accept' && required.length > 0 ? 'must_accept' : 'ok', required };
}

/** Pages a user must still be able to open while gated: the acceptance screen, the documents themselves, sign-out. */
export const LEGAL_GATE_EXEMPT_PREFIXES: readonly string[] = ['/legal/accept', '/terms', '/privacy'];

export function decideLegalGate(state: LegalAcceptanceState | null, pathname: string): LegalGateDecision {
  if (!state || state.decision !== 'must_accept') return 'allow';
  if (LEGAL_GATE_EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return 'allow';
  return 'must_accept';
}

/** Summary in the viewer's language, falling back to the English text the staff member wrote. */
export function localizedSummary(change: LegalChange, language: string | undefined): string {
  const base = (language ?? '').slice(0, 2).toLowerCase();
  return (base && change.i18n[base]) || change.summary;
}

/** Merges the material changes of every version the user has not accepted, newest section text last-wins per section+kind. */
export function flattenChanges(doc: RequiredDocument): LegalChange[] {
  return doc.versions.flatMap((v) => v.changes);
}

export function acceptanceVersionIds(state: LegalAcceptanceState): string[] {
  return state.required.map((d) => d.version_id);
}

/** Same-origin return path after accepting; never an absolute or protocol-relative URL. */
export function safeReturnPath(from: unknown): string {
  if (typeof from !== 'string') return '/dashboard';
  if (!from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) return '/dashboard';
  if (from.startsWith('/legal/accept')) return '/dashboard';
  return from;
}
/** Earliest deadline among documents still inside their grace window (null when none). */
export function graceDeadline(state: LegalAcceptanceState | null): string | null {
  if (!state) return null;
  const times = state.required.filter((d) => !d.blocking && d.deadline !== null).map((d) => d.deadline as string);
  if (times.length === 0) return null;
  return times.reduce((a, b) => (new Date(a).getTime() <= new Date(b).getTime() ? a : b));
}
